'use strict';

/**
 * 本地服务：静态托管前端 + 代理 ADP 对话接口。
 * API 密钥只存在于服务端 .env，浏览器永远拿不到。
 */

const http = require('http');
const fs = require('fs');
const path = require('path');

const { server, brand, perspectives } = require('./lib/config');
const { streamUpstream, healthCheck } = require('./lib/adp');

const PUBLIC_DIR = path.join(__dirname, 'public');
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
};

function sendJson(res, status, data) {
  const body = JSON.stringify(data);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(body) });
  res.end(body);
}

function readBody(req, limit = 64 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) { reject(new Error('请求体过大')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function serveStatic(req, res) {
  const urlPath = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
  const rel = urlPath === '/' ? 'index.html' : urlPath.replace(/^\/+/, '');
  const filePath = path.join(PUBLIC_DIR, rel);
  if (!filePath.startsWith(PUBLIC_DIR)) { res.writeHead(403).end('Forbidden'); return; }
  fs.readFile(filePath, (err, data) => {
    if (err) { res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }).end('404 Not Found'); return; }
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(filePath).toLowerCase()] || 'application/octet-stream',
      'Cache-Control': 'no-cache',
    });
    res.end(data);
  });
}

function safeId(value, fallback) {
  if (typeof value === 'string' && /^[a-zA-Z0-9_-]{1,64}$/.test(value)) return value;
  return fallback;
}

/** 会话 ID：新建会话时为空字符串，由上游生成后回传 */
function normalizeConversationId(value) {
  return typeof value === 'string' && /^[a-zA-Z0-9_-]{0,64}$/.test(value) ? value : '';
}

async function handleChat(req, res) {
  let payload;
  try {
    payload = JSON.parse(await readBody(req));
  } catch {
    sendJson(res, 400, { error: '请求体不是合法 JSON' });
    return;
  }

  const message = String(payload.message || '').trim();
  if (!message) { sendJson(res, 400, { error: '问题内容为空' }); return; }
  if (message.length > 2000) { sendJson(res, 400, { error: '问题过长（上限 2000 字）' }); return; }

  const perspective = perspectives.find((p) => p.id === payload.perspectiveId) || perspectives[0];
  const conversationId = normalizeConversationId(payload.conversationId);
  const userId = safeId(payload.userId, 'web-visitor');

  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.write(': connected\n\n');

  const sse = (event, data) => {
    if (!res.writableEnded) res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  };

  sse('meta', { conversationId, perspectiveId: perspective.id });

  const keepAlive = setInterval(() => { if (!res.writableEnded) res.write(': ping\n\n'); }, 15000);

  const controller = new AbortController();
  let closed = false;
  req.on('close', () => {
    closed = true;
    controller.abort();
    clearInterval(keepAlive);
  });

  try {
    let lastConv = conversationId;
    for await (const frame of streamUpstream({
      server, message, perspective, conversationId, userId, signal: controller.signal,
    })) {
      if (closed) break;
      if (frame.conversationId && frame.conversationId !== lastConv) {
        lastConv = frame.conversationId;
        sse('meta', { conversationId: lastConv, perspectiveId: perspective.id });
      }
      if (frame.type === 'text') sse('delta', { text: frame.text });
      else if (frame.type === 'stage' && frame.stage) sse('stage', frame.stage);
      else if (frame.type === 'thought') sse('thought', { text: frame.text });
      else if (frame.type === 'references') sse('references', { items: frame.references });
      else if (frame.type === 'error') { sse('error', { message: frame.text }); break; }
      else if (frame.type === 'done') {
        if (frame.references?.length) sse('references', { items: frame.references });
        sse('done', {});
        break;
      }
    }
    sse('done', {});
  } catch (err) {
    if (!closed && err?.name !== 'AbortError') {
      sse('error', { message: `连接上游失败：${String(err?.message || err)}` });
    }
  } finally {
    clearInterval(keepAlive);
    if (!res.writableEnded) res.end();
  }
}

const app = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');

  if (url.pathname === '/api/config') {
    if (!server.apiKey) { sendJson(res, 500, { error: '未配置 ADP_API_KEY，请检查 .env' }); return; }
    sendJson(res, 200, {
      perspectives: perspectives.map(({ id, name, seal, tagline, examples }) => ({ id, name, seal, tagline, examples })),
      appName: brand.name,
      appSubtitle: brand.subtitle,
    });
    return;
  }

  if (url.pathname === '/api/health') {
    const result = await healthCheck(server);
    sendJson(res, 200, { ok: result.reachable && result.status < 500, endpoint: server.baseUrl + server.chatPath, style: server.apiStyle, ...result });
    return;
  }

  if (url.pathname === '/api/chat') {
    if (req.method !== 'POST') { sendJson(res, 405, { error: '仅支持 POST' }); return; }
    await handleChat(req, res);
    return;
  }

  if (req.method !== 'GET' && req.method !== 'HEAD') { sendJson(res, 405, { error: 'Method Not Allowed' }); return; }
  serveStatic(req, res);
});

app.listen(server.port, () => {
  console.log(`\n  中山文旅 · 数字档案`);
  console.log(`  本地地址   http://localhost:${server.port}`);
  console.log(`  上游接口   ${server.baseUrl}${server.chatPath}  (${server.apiStyle}/${server.authStyle})`);
  console.log(`  密钥状态   ${server.apiKey ? '已从 .env 读取（不会下发到浏览器）' : '缺失！请检查 .env'}\n`);
});