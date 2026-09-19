'use strict';

/**
 * 对话接入层：构造上游请求 + 把流式返回归一化成统一事件。
 * 当前对接的是 ADP 私有化应用 API（Dify 风格）：
 *   POST {base}/chat-messages
 *   Body: { inputs, query, response_mode, conversation_id, user, files }
 *   SSE : event = message / agent_message / agent_thought / message_end / error / ping
 */

const crypto = require('crypto');

function get(obj, name) {
  if (!obj || typeof obj !== 'object') return undefined;
  if (Object.prototype.hasOwnProperty.call(obj, name)) return obj[name];
  const lower = name.toLowerCase();
  for (const k of Object.keys(obj)) {
    if (k.toLowerCase() === lower) return obj[k];
  }
  return undefined;
}

function asText(value) {
  if (value == null) return '';
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (Array.isArray(value)) return value.map(asText).join('');
  if (typeof value === 'object') {
    const t = get(value, 'text') ?? get(value, 'content') ?? get(value, 'value');
    if (t != null) return asText(t);
  }
  return '';
}

/** 构造上游请求（密钥只在这里出现，不下发浏览器） */
function buildRequest({ server, message, perspective, conversationId, userId }) {
  const url = server.baseUrl + server.chatPath;
  const headers = {
    'Content-Type': 'application/json',
    Accept: 'text/event-stream, application/json',
  };
  if (server.authStyle.includes('bearer') && server.apiKey) {
    headers.Authorization = `Bearer ${server.apiKey}`;
  }

  let body;
  if (server.apiStyle === 'dify') {
    const inputs = {};
    if (server.perspectiveKey && perspective?.value) inputs[server.perspectiveKey] = perspective.value;
    body = {
      inputs,
      query: message,
      response_mode: server.upstreamStream ? 'streaming' : 'blocking',
      conversation_id: conversationId || '',
      user: userId,
      files: [],
    };
  } else if (server.apiStyle === 'openai') {
    const messages = [];
    if (perspective?.systemRole) messages.push({ role: 'system', content: perspective.systemRole });
    messages.push({ role: 'user', content: message });
    body = { model: server.model || undefined, messages, stream: server.upstreamStream };
  } else {
    body = {
      RequestId: crypto.randomUUID().replace(/-/g, ''),
      ConversationId: conversationId || crypto.randomUUID().replace(/-/g, ''),
      AppKey: server.appKey,
      VisitorId: userId,
      UserId: userId,
      Contents: [{ Type: 'text', Text: message }],
      Stream: server.streamMode || undefined,
      StreamingThrottle: 4,
      SystemRole: perspective?.systemRole || undefined,
    };
  }

  return { url, init: { method: 'POST', headers, body: JSON.stringify(body) } };
}

/* ---------------- Dify 风格事件 ---------------- */

function collectRetrieverResources(metadata) {
  const list = metadata ? get(metadata, 'retriever_resources') : null;
  const out = [];
  if (!Array.isArray(list)) return out;
  for (const item of list) {
    if (!item || typeof item !== 'object') continue;
    const url = get(item, 'url') ?? get(item, 'document_url');
    const title = asText(get(item, 'document_name') ?? get(item, 'title') ?? get(item, 'dataset_name'));
    if (typeof url === 'string' && /^https?:\/\//i.test(url)) out.push({ title: title || url, url });
  }
  return out;
}

function normalizeDify(obj) {
  const ev = String(get(obj, 'event') || '').toLowerCase();
  const conversationId = get(obj, 'conversation_id') || undefined;
  const answer = asText(get(obj, 'answer'));

  if (ev === 'error') return { type: 'error', text: asText(get(obj, 'message')) || '上游返回错误' };

  // 工作流节点：转成「调阅进度」，让前端在等待期显示正在做什么
  if (ev === 'node_started' || ev === 'node_finished') {
    const data = get(obj, 'data') || {};
    return {
      type: 'stage',
      conversationId,
      stage: {
        runId: asText(get(data, 'id')),
        title: asText(get(data, 'title')) || asText(get(data, 'node_type')) || '调阅档案',
        nodeType: asText(get(data, 'node_type')),
        status: ev === 'node_started' ? 'running' : 'done',
      },
    };
  }

  if (ev === 'ping' || ev === 'workflow_started' || ev === 'workflow_finished' || ev.startsWith('tts_')) {
    return { type: 'ignore', conversationId };
  }
  if (ev === 'message_end') {
    const refs = collectRetrieverResources(get(obj, 'metadata'));
    return { type: 'done', conversationId, references: refs.length ? refs : undefined };
  }
  if (ev === 'agent_thought') {
    return { type: 'thought', conversationId, text: asText(get(obj, 'thought') ?? get(obj, 'observation')) };
  }
  if (answer) return { type: 'text', conversationId, text: answer };
  if (ev === 'message_file' || ev === 'message_replace') return { type: 'ignore', conversationId };
  return { type: 'ignore', conversationId };
}

/* ---------------- 通用事件（兼容其他返回形态）---------------- */

function referencesOf(obj, depth = 0) {
  if (!obj || typeof obj !== 'object' || depth > 4) return [];
  const out = [];
  for (const value of Object.values(obj)) {
    if (Array.isArray(value)) {
      const items = [];
      for (const item of value) {
        if (!item || typeof item !== 'object') continue;
        const href = get(item, 'url') ?? get(item, 'link') ?? get(item, 'docurl');
        if (typeof href === 'string' && /^https?:\/\//i.test(href)) {
          items.push({ title: asText(get(item, 'title') ?? get(item, 'name') ?? get(item, 'docname')) || href, url: href });
        }
      }
      if (items.length) out.push(...items);
      else if (depth < 4) out.push(...referencesOf(value, depth + 1));
    } else if (value && typeof value === 'object' && depth < 4) {
      out.push(...referencesOf(value, depth + 1));
    }
  }
  return out;
}

function normalizeGeneric(obj) {
  if (typeof obj === 'string') return { type: 'text', text: obj };

  const rawType = String(get(obj, 'type') ?? get(obj, 'event') ?? '').toLowerCase();
  const candidates = [
    get(get(obj, 'payload'), 'content'),
    get(get(obj, 'payload'), 'text'),
    get(obj, 'content'),
    get(obj, 'text'),
    get(get(obj, 'delta'), 'content'),
    get(obj, 'delta'),
    get(get(obj, 'choices'), 0) && get(get(get(obj, 'choices'), 0), 'delta') && get(get(get(get(obj, 'choices'), 0), 'delta'), 'content'),
    get(get(obj, 'message'), 'content'),
    get(get(obj, 'response'), 'content'),
  ];
  let text = '';
  for (const c of candidates) {
    const s = asText(c);
    if (s) { text = s; break; }
  }

  const references = referencesOf(obj);
  if (/error|fail/.test(rawType)) return { type: 'error', text: text || '上游返回错误' };
  if (/(^|[._-])(end|finish|done|close|stop)/.test(rawType)) return { type: 'done', references: references.length ? references : undefined };
  if (/thought|reasoning/.test(rawType)) return { type: 'thought', text };
  if (references.length && !text) return { type: 'references', references };
  return { type: text ? 'text' : 'ignore', text };
}

function normalizeFrame(obj, apiStyle) {
  return apiStyle === 'dify' ? normalizeDify(obj) : normalizeGeneric(obj);
}

/* ---------------- 帧切分 ---------------- */

function createFrameParser() {
  let buffer = '';
  const SEP = /\r?\n\r?\n/;
  return function push(chunk) {
    buffer += chunk;
    const frames = [];
    let m;
    while ((m = SEP.exec(buffer)) !== null) {
      frames.push(buffer.slice(0, m.index));
      buffer = buffer.slice(m.index + m[0].length);
    }
    return frames;
  };
}

function parseFrame(rawFrame) {
  const lines = rawFrame.split(/\r?\n/);
  let eventName = '';
  const dataLines = [];
  for (const line of lines) {
    if (line.startsWith('event:')) eventName = line.slice(6).trim();
    else if (line.startsWith('data:')) dataLines.push(line.slice(5).trim());
    else if (line.trim() && !line.startsWith(':')) dataLines.push(line.trim());
  }
  return { eventName, data: dataLines.join('\n') };
}

/** 统一事件流：yield { type, text, references, conversationId } */
async function* streamUpstream({ server, message, perspective, conversationId, userId, signal }) {
  const { url, init } = buildRequest({ server, message, perspective, conversationId, userId });
  const res = await fetch(url, { ...init, signal });

  if (!res.ok) {
    let detail = '';
    try { detail = (await res.text()).slice(0, 500); } catch { /* ignore */ }
    detail = detail.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
    yield { type: 'error', text: `上游返回 ${res.status} ${res.statusText}${detail ? ` · ${detail}` : ''}` };
    return;
  }

  const contentType = res.headers.get('content-type') || '';

  // 非流式（blocking）：整段返回
  if (!contentType.includes('event-stream')) {
    const raw = await res.text();
    if (server.debug) console.log('[upstream] raw:', raw.slice(0, 2000));
    let obj;
    try { obj = JSON.parse(raw); } catch { obj = raw; }
    const frame = normalizeFrame(obj, server.apiStyle);
    if (frame.type === 'error') yield frame;
    else {
      yield { type: 'text', text: frame.text || asText(get(obj, 'answer')) || raw };
    }
    yield { type: 'done', references: frame.references, conversationId: get(obj, 'conversation_id') };
    return;
  }

  const push = createFrameParser();
  const decoder = new TextDecoder('utf-8');
  let done = false;

  for await (const chunk of res.body) {
    const text = decoder.decode(chunk, { stream: true });
    if (server.debug) console.log('[upstream]', text.slice(0, 300));

    for (const rawFrame of push(text)) {
      const { data } = parseFrame(rawFrame);
      if (!data) continue;
      if (data === '[DONE]') { done = true; yield { type: 'done' }; return; }

      let obj;
      try { obj = JSON.parse(data); } catch { yield { type: 'text', text: data }; continue; }

      const frame = normalizeFrame(obj, server.apiStyle);
      if (frame.type === 'ignore') {
        if (frame.conversationId) yield { type: 'meta', conversationId: frame.conversationId };
        continue;
      }
      if (frame.type === 'done') {
        yield frame;
        done = true;
        return;
      }
      if (frame.type === 'error') { yield frame; return; }
      yield frame;
    }
  }
  if (!done) yield { type: 'done' };
}

async function healthCheck(server) {
  const { url, init } = buildRequest({
    server,
    message: '你好',
    perspective: null,
    conversationId: '',
    userId: 'healthcheck',
  });
  const started = Date.now();
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 10000);
    const res = await fetch(url, { ...init, signal: ctrl.signal });
    clearTimeout(timer);
    return { reachable: true, status: res.status, ms: Date.now() - started, url };
  } catch (err) {
    return { reachable: false, error: String(err?.message || err), url };
  }
}

module.exports = { streamUpstream, healthCheck, buildRequest, normalizeFrame };