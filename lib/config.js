'use strict';

const fs = require('fs');
const path = require('path');

/** 极简 .env 读取（不引入任何依赖） */
function loadEnvFile(file) {
  const out = {};
  if (!fs.existsSync(file)) return out;
  for (const raw of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const i = line.indexOf('=');
    if (i < 0) continue;
    let v = line.slice(i + 1).trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
      v = v.slice(1, -1);
    }
    out[line.slice(0, i).trim()] = v;
  }
  return out;
}

const fileEnv = loadEnvFile(path.join(__dirname, '..', '.env'));
const env = (key, fallback = '') => process.env[key] ?? fileEnv[key] ?? fallback;

/** 服务端配置（含密钥，禁止下发到前端） */
const server = {
  port: Number(env('PORT', 8787)),
  baseUrl: env('ADP_BASE_URL', 'http://101.33.81.237:8088/v1').replace(/\/+$/, ''),
  chatPath: env('ADP_CHAT_PATH', '/chat-messages'),
  authStyle: env('ADP_AUTH_STYLE', 'bearer'),
  apiKey: env('ADP_API_KEY', ''),
  apiStyle: env('ADP_API_STYLE', 'dify'),
  model: env('ADP_MODEL', ''),
  streamMode: env('ADP_STREAM_MODE', 'enable'),
  upstreamStream: env('ADP_UPSTREAM_STREAM', 'true') === 'true',
  debug: env('ADP_DEBUG', 'false') === 'true',
  // 视角对应的 App 变量名（经 /v1/parameters 核实为 user_perspective）
  perspectiveKey: env('ADP_PERSPECTIVE_KEY', 'user_perspective'),
  appKey: env('ADP_APP_KEY', '') || env('ADP_API_KEY', ''),
};

/** 页面品牌文案 */
const brand = {
  name: env('APP_NAME', '中山文旅 · 数字档案'),
  subtitle: env('APP_SUBTITLE', '三重门径，遍览香山风物与人情'),
};

/**
 * 三个视角：通过 inputs[perspectiveKey] 传给工作流，取值须与应用内选项一致。
 * name / seal / tagline / examples 仅用于页面展示，可随时改。
 */
const perspectives = [
  {
    id: 'child',
    value: '儿童',
    name: '儿童',
    seal: '童',
    tagline: '用讲故事的口吻，带孩子认识这条老街',
    examples: ['骑楼是什么？为什么楼下要留一条走廊？', '思豪大酒店以前是什么样子的？'],
  },
  {
    id: 'history',
    value: '历史',
    name: '历史',
    seal: '史',
    tagline: '沿史料与方志，追溯孙文西路的岁月脉络',
    examples: ['孙文西路骑楼街是什么时候形成的？', '思豪大酒店经历了哪几个阶段的变迁？'],
  },
  {
    id: 'expert',
    value: '专家',
    name: '专家',
    seal: '专',
    tagline: '细究建筑肌理、修缮做法与当下业态',
    examples: ['思豪大酒店的修缮保留了哪些原有做法？', '骑楼建筑在结构上有哪些值得注意的细节？'],
  },
];

module.exports = { server, brand, perspectives, env };