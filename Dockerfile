FROM node:22-alpine

WORKDIR /app

# 项目零第三方依赖（仅用 Node 内置模块），无需 npm install，直接复制源码
COPY --chown=node:node server.js ./
COPY --chown=node:node lib ./lib
COPY --chown=node:node public ./public

ENV NODE_ENV=production \
    PORT=8787

EXPOSE 8787

USER node

CMD ["node", "server.js"]
