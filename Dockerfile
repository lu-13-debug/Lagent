FROM node:24-bookworm-slim AS frontend
WORKDIR /app
ENV ELECTRON_SKIP_BINARY_DOWNLOAD=1
COPY package.json package-lock.json ./
RUN npm ci
COPY index.html tsconfig.json vite.config.ts ./
COPY src ./src
COPY public ./public
RUN npm run build

FROM node:24-bookworm-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production HOST=0.0.0.0 PORT=3002 LAGENT_DATA_DIR=/app/data
ENV PLAYWRIGHT_BROWSERS_PATH=/opt/playwright LAGENT_PYTHON=/opt/analysis/bin/python
# 国内部署：Debian 源与 Playwright 浏览器改用国内镜像，避免构建时长时间超时。
RUN sed -i 's|deb.debian.org|mirrors.cloud.tencent.com|g' /etc/apt/sources.list.d/debian.sources 2>/dev/null || true
ENV PLAYWRIGHT_DOWNLOAD_HOST=https://cdn.npmmirror.com/binaries/playwright
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
# DeepSeek Harness 的 ACP 适配器，供云端指挥台直接驱动。
RUN npm i -g dsh-acp --registry=https://registry.npmmirror.com && npm cache clean --force
RUN apt-get -o Acquire::ForceIPv4=true update && apt-get -o Acquire::ForceIPv4=true install -y --no-install-recommends python3 python3-venv fonts-noto-cjk git \
    && npx playwright install --with-deps chromium \
    && chmod -R a+rX /opt/playwright \
    && rm -rf /var/lib/apt/lists/*
COPY server/tools/requirements.txt /tmp/analysis-requirements.txt
RUN python3 -m venv /opt/analysis \
    && /opt/analysis/bin/pip install --no-cache-dir -i https://pypi.tuna.tsinghua.edu.cn/simple -r /tmp/analysis-requirements.txt
COPY --chown=node:node server ./server
# 服务端通过 ESM 导入这两个 src 下的 JSON 契约文件，runtime 镜像必须一并复制。
COPY --chown=node:node src/completeness-copy.json src/input-contract.json ./src/
COPY --from=frontend --chown=node:node /app/dist ./dist
RUN mkdir -p /app/data && chown node:node /app/data
USER node
EXPOSE 3002
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 CMD node -e "const r=require('node:http').get('http://127.0.0.1:3002/api/health',{headers:{host:new URL(process.env.PUBLIC_URL).host}},s=>{s.resume();if(s.statusCode!==200)process.exit(1)});r.on('error',()=>process.exit(1));r.setTimeout(4000,()=>r.destroy())"
CMD ["node", "server/cloud-index.js"]
