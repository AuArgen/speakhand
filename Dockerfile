# Сүйлө — продакшн сүрөтү.
#   docker compose up -d --build        (же: docker build -t suylo . && docker run -p 8787:8787 -v suylo-data:/data suylo)

# ---------- 1) Фронтендди куруу ----------
FROM node:24-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY . .
RUN npx vite build

# ---------- 2) Иштөө убагы: сервер + курулган dist ----------
FROM node:24-bookworm-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production \
    PORT=8787 \
    DATA_DIR=/data

# Серверге керектүүлөр гана: ws, selfsigned, tsx (фронтенд китепканалары dist'ке курулган).
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund && npm cache clean --force

COPY tsconfig.json ./
COPY server ./server
# Сервер демо жесттердин тизмесин (src/avatar/seeds.ts) окуйт.
COPY src ./src
COPY --from=build /app/dist ./dist

# Бөлмөлөр, AI котормо кэши жана (HTTPS=1 болсо) сертификат — туруктуу томдо.
RUN mkdir -p /data && chown -R node:node /data /app/server/data
VOLUME ["/data"]
USER node

EXPOSE 8787
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "const s=process.env.HTTPS==='1'?'https':'http';process.env.NODE_TLS_REJECT_UNAUTHORIZED='0';fetch(s+'://127.0.0.1:'+(process.env.PORT||8787)+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

# node PID 1 болот — SIGTERM'ди өзү кармап, бөлмөлөрдү дискке сактап анан чыгат.
CMD ["node", "--import", "tsx", "server/index.ts"]
