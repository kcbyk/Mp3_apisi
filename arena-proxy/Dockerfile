# =============================================================================
# arena-proxy — üretim imajı (Render / Docker uyumlu)
#
# ⚠️ Base image sürümü, package-lock.json'daki `playwright` sürümüyle AYNI olmalı.
#    Farklı olursa Chromium "Executable doesn't exist" hatası verir.
#    Kontrol: node -e "console.log(require('./package-lock.json').packages['node_modules/playwright'].version)"
# =============================================================================
FROM mcr.microsoft.com/playwright:v1.63.0-jammy

ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PLAYWRIGHT_BROWSERS_PATH=/ms-playwright \
    NPM_CONFIG_UPDATE_NOTIFIER=false \
    NPM_CONFIG_FUND=false

WORKDIR /app

# --- Bağımlılık katmanı (cache dostu) ---
COPY package*.json ./
RUN npm ci --omit=dev --no-audit --no-fund

# --- Uygulama kodu ---
COPY src ./src
COPY scripts ./scripts
COPY docs ./docs
COPY openapi.json server.js ./
COPY tests ./tests

# --- Yazılabilir dizinler ---
# Render gibi platformlarda dosya sistemi geçicidir; bu yüzden çalışma anında
# /tmp kullanılır (RENDER=1 iken config otomatik /tmp'e yönlenir).
RUN mkdir -p /app/data/sessions /app/data/artifacts /app/data/screenshots /app/data/fixtures /app/data/profiles \
 && mkdir -p /tmp/arena-proxy/artifacts /tmp/arena-proxy/screenshots /tmp/arena-proxy/profiles \
 && chown -R pwuser:pwuser /app /tmp/arena-proxy

# Playwright imajında root olmayan kullanıcı hazır gelir → daha güvenli
USER pwuser

# Render $PORT ortam değişkenini kendisi verir; server.js onu okur.
EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=5s --start-period=40s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8080)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

# Not: SIGTERM doğrudan node'a gitmeli → server.js graceful shutdown yapar
STOPSIGNAL SIGTERM
CMD ["node", "server.js"]
