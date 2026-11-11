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
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
RUN apt-get update && apt-get install -y --no-install-recommends python3 python3-venv fonts-noto-cjk \
    && npx playwright install --with-deps chromium \
    && chmod -R a+rX /opt/playwright \
    && rm -rf /var/lib/apt/lists/*
COPY server/tools/requirements.txt /tmp/analysis-requirements.txt
RUN python3 -m venv /opt/analysis \
    && /opt/analysis/bin/pip install --no-cache-dir -r /tmp/analysis-requirements.txt
COPY --chown=node:node server ./server
COPY --from=frontend --chown=node:node /app/dist ./dist
RUN mkdir -p /app/data && chown node:node /app/data
USER node
EXPOSE 3002
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 CMD node -e "const r=require('node:http').get('http://127.0.0.1:3002/api/health',{headers:{host:new URL(process.env.PUBLIC_URL).host}},s=>{s.resume();if(s.statusCode!==200)process.exit(1)});r.on('error',()=>process.exit(1));r.setTimeout(4000,()=>r.destroy())"
CMD ["node", "server/cloud-index.js"]
