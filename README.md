# 中山文旅 · 数字档案

面向中山（香山）文旅知识的对话式前端。用户从「儿童 / 历史 / 专家」三重门径中择一进入，向上游 ADP 应用提问，答复以「卷宗」形式呈现，并附档案出处。

项目由两部分组成：

- **静态前端**：`public/` 下的原生 HTML / CSS / JS，无构建步骤、无框架。
- **本地服务**：`server.js`，用 Node 内置模块托管静态资源，并代理上游对话接口。**API 密钥只存在于服务端 `.env`，浏览器永远拿不到。**

## 特性

- **三重视角**：儿童、历史、专家三个视角，通过 `inputs.user_perspective` 传给上游工作流。
- **流式答复**：以 SSE 向前端推送增量文本、思考过程、调阅进度与档案出处。
- **思考过程展示**：思考内容按 22ms 间隔流式显示（每帧上限 180 字），显示完毕后自动折叠。
- **调阅进度**：等待期间展示上游工作流节点标题与已耗时，缓解等待感。
- **档案出处**：答复末尾列出命中的知识库来源（标题 + 链接）。
- **卷宗架**：历史会话以卷宗形式留存，可展开 / 收起，展开控件位于卡片底部。
- **图片去重**：答复中的图片按 URL 去重，仅保留首次出现。

## 目录结构

```
.
├── server.js          # HTTP 服务：静态托管 + /api/* 接口
├── start.bat          # Windows 一键启动（自动从 .env.example 生成 .env）
├── lib/
│   ├── config.js      # 读取 .env、服务端配置、视角与品牌文案
│   └── adp.js         # 上游请求构造 + 流式返回归一化
├── public/
│   ├── index.html     # 页面骨架
│   ├── styles.css     # 样式
│   └── app.js         # 交互逻辑（视角选择、SSE 消费、卷宗渲染）
├── .env.example       # 配置模板
└── .gitignore
```

## 快速开始

要求 Node.js 18+（依赖全局 `fetch` 与流式 `Response.body`）。项目无第三方依赖，**无需 `npm install`**。

1. 准备配置：

   ```bash
   cp .env.example .env
   ```

   编辑 `.env`，填入真实的 `ADP_API_KEY`。

2. 启动：

   ```bash
   node server.js
   ```

   Windows 下也可双击 `start.bat`（会自动从模板生成 `.env`）。

3. 打开 http://localhost:8787 。

## 配置项

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `PORT` | `8787` | 本地服务端口 |
| `ADP_BASE_URL` | `http://101.33.81.237:8088/v1` | 上游应用 API 地址 |
| `ADP_CHAT_PATH` | `/chat-messages` | 对话接口路径 |
| `ADP_AUTH_STYLE` | `bearer` | 鉴权方式：`bearer` / `appkey` / `bearer+appkey` |
| `ADP_API_KEY` | 空 | API 密钥，**仅存于服务端** |
| `ADP_API_STYLE` | `dify` | 请求体风格：`dify` / `openai` / `adp` |
| `ADP_PERSPECTIVE_KEY` | `user_perspective` | 视角对应的应用变量名 |
| `ADP_UPSTREAM_STREAM` | `true` | 是否向上游请求流式返回 |
| `ADP_DEBUG` | `false` | 是否把上游原始返回打印到控制台 |
| `APP_NAME` | `中山文旅 · 数字档案` | 页面主标题 |
| `APP_SUBTITLE` | `三重门径，遍览香山风物与人情` | 页面副标题 |

> `.env` 已被 `.gitignore` 忽略，不会被提交。

## 接口

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| `GET` | `/api/config` | 返回视角列表与品牌文案，供前端渲染 |
| `GET` | `/api/health` | 探测上游接口连通性与响应耗时 |
| `POST` | `/api/chat` | 发起提问，返回 `text/event-stream` |

`POST /api/chat` 请求体：

```json
{
  "message": "孙文西路骑楼街是什么时候形成的？",
  "perspectiveId": "history",
  "conversationId": "",
  "userId": "web-visitor"
}
```

返回的 SSE 事件：

| 事件 | 载荷 | 说明 |
| --- | --- | --- |
| `meta` | `{ conversationId, perspectiveId }` | 会话标识，新建会话后由上游回传 |
| `delta` | `{ text }` | 答复增量文本 |
| `thought` | `{ text }` | 思考过程增量 |
| `stage` | `{ title, nodeType, status }` | 上游工作流节点进度 |
| `references` | `{ items: [{ title, url }] }` | 档案出处 |
| `error` | `{ message }` | 错误信息 |
| `done` | `{}` | 本次答复结束 |

## 架构说明

浏览器 → 本地服务 → 上游 ADP 应用：

1. 浏览器只访问本机 `/api/chat`，请求体中**不含任何密钥**。
2. `lib/adp.js` 在服务端组装上游请求并附加 `Authorization: Bearer <ADP_API_KEY>`。
3. 上游返回的 Dify 风格事件（`message` / `agent_thought` / `node_started` / `message_end` 等）被归一化为统一事件类型，再由 `server.js` 转成前端 SSE 事件。
4. 上游连接中断时通过 `AbortController` 中止，避免悬挂请求。

## 许可

未声明。
