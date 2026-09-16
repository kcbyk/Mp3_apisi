# arena-proxy

Hedef web platformlarındaki (Arena AI vb.) **görsel üretim araçlarını standart bir REST API
olarak dışarıya açan headless otomasyon servisi**. Playwright/Chromium ile gerçek tarayıcı
oturumu üzerinden üretim yapar, ağ trafiğini dinleyerek üretilen görselin CDN/S3 URL'ini
yakalar ve istemciye JSON olarak döner.

```
POST /api/v1/generate-asset
{ "prompt": "...", "negative_prompt": "...", "aspect_ratio": "16:9", "style": "photographic" }
        ↓
{ "success": true, "image_url": "https://cdn.../abc.png", "execution_time_ms": 4820 }
```

---

## İçindekiler

1. [Mimari](#1-mimari)
2. [Hızlı Başlangıç](#2-hızlı-başlangıç)
3. [API Referansı](#3-api-referansı)
4. [Oturum (Cookie/Session) Yönetimi](#4-oturum-cookiesession-yönetimi)
5. [Dayanıklılık ve Performans](#5-dayanıklılık-ve-performans)
6. [Cloudflare / Anti-bot Stratejisi](#6-cloudflare--anti-bot-stratejisi)
7. [Selector Mimarisi](#7-selector-mimarisi)
8. [Yapılandırma (ENV)](#8-yapılandırma-env)
9. [Test ve Doğrulama](#9-test-ve-doğrulama)
10. [Üretim Notları / Sorun Giderme](#10-üretim-notları--sorun-giderme)

---

## 1. Mimari

```
                    ┌─────────────────────────────────────────────────────┐
  HTTP istemci ───► │  Express (server.js → src/app.js)                   │
                    │  • rate limit  • API key auth  • request-id logging  │
                    └───────────────────────┬─────────────────────────────┘
                                            ▼
                    ┌─────────────────────────────────────────────────────┐
                    │  src/services/assetService.js   (orkestrasyon)      │
                    │  validate → queue → browser → scraper → delivery    │
                    └──────────────┬──────────────────────┬───────────────┘
                                   ▼                      ▼
             ┌──────────────────────────────┐  ┌───────────────────────────────┐
             │ src/automation/queue.js      │  │ src/services/jobStore.js      │
             │ p-queue + p-retry            │  │ async mod / webhook callback  │
             │ concurrency + rate window    │  └───────────────────────────────┘
             │ AbortSignal timeout          │
             └──────────────┬───────────────┘
                            ▼
             ┌──────────────────────────────────────────────────────────────┐
             │ src/automation/browserManager.js                             │
             │ Tek Chromium + context HAVUZU (pooling & recycling)          │
             │ stealth init script, proxy, resource blocking                 │
             └──────────────┬───────────────────────────────────────────────┘
                            ▼
   ┌────────────────────────────────────────────────────────────────────────┐
   │ src/scrapers/arenaScraper.js                                           │
   │  navigate → consent → loginWall kontrolü → aspect/style/negative       │
   │  → prompt yaz → Generate tıkla → ArtifactCapture ile URL yakala        │
   └──────────┬───────────────────────────────────┬─────────────────────────┘
              ▼                                   ▼
  ┌───────────────────────────┐     ┌──────────────────────────────────────┐
  │ artifactCapture.js        │     │ resilientSelector.js + humanize.js   │
  │ network / WebSocket /     │     │ XPath · text · testid · role …       │
  │ DOM / blob kanalları      │     │ insan benzeri tıklama & yazma        │
  └──────────┬────────────────┘     └──────────────────────────────────────┘
             ▼
  ┌────────────────────────────────────────────────────────────────────────┐
  │ artifactDelivery.js   url | base64 | file | both                       │
  │ SSRF allowlist · redirect doğrulama · sha256 · boyut sınırı            │
  └────────────────────────────────────────────────────────────────────────┘
```

### Dosya yapısı

```
arena-proxy/
├── server.js                     # giriş noktası (listen, prewarm, graceful shutdown)
├── src/
│   ├── app.js                    # Express uygulaması (middleware + route montajı)
│   ├── config/index.js           # zod ile doğrulanan env konfigürasyonu
│   ├── errors.js                 # AppError hiyerarşisi (code/httpStatus/retryable)
│   ├── middleware/{auth,errorHandler}.js
│   ├── routes/{generateRoutes,systemRoutes}.js
│   ├── services/
│   │   ├── assetService.js       # orkestrasyon + metrikler
│   │   └── jobStore.js           # asenkron iş deposu (TTL)
│   ├── automation/
│   │   ├── browserManager.js     # Chromium + context havuzu
│   │   ├── sessionStore.js       # cookie/localStorage yükleme & otomatik yenileme
│   │   └── queue.js              # eşzamanlılık, retry, timeout, backpressure
│   ├── scrapers/
│   │   ├── arenaScraper.js       # DOM otomasyon akışı
│   │   ├── artifactCapture.js    # CDN/S3/WS/DOM URL yakalayıcı
│   │   ├── artifactDelivery.js   # indirme / base64 / dosya teslimi
│   │   └── selectors/arena.json  # resilient selector kayıt defteri
│   └── utils/{logger,resilientSelector,humanize}.js
├── scripts/                      # saveSession · inspectDom · smoke
├── tests/                        # sahte hedef sunucu ile uçtan uca testler
├── docs/index.html               # interaktif API konsolu (GET /docs)
├── openapi.json                  # OpenAPI 3.1 şeması
├── Dockerfile · docker-compose.yml
└── .env.example
```

**Tasarım kararları (kısa):**

| Konu | Karar | Gerekçe |
|---|---|---|
| Tarayıcı | Tek Chromium process + **context havuzu** | Her istekte `launch()` 1-3 sn ve ~200 MB demek; havuz bunu sıfıra indirir |
| İzolasyon | Context seviyesinde | Cookie/session her istekte taze enjekte edilir, sızıntı olmaz |
| Kuyruk | p-queue + p-retry | Tek process'te FIFO, concurrency, üstel backoff; Redis'e geçiş için `jobStore` arayüzü ayrık |
| Hata modeli | `AppError` + `retryable` bayrağı | Retry politikası kodun her yerine dağılmaz |
| Selector | JSON strateji zinciri | DOM değişince kod değil JSON güncellenir |
| Teslim | url/base64/file/both | İstemci ihtiyacına göre; SSRF allowlist ile kısıtlanır |

---

## 2. Hızlı Başlangıç

```bash
# 1) Bağımlılıklar
npm install
npx playwright install --with-deps chromium

# 2) Konfigürasyon
cp .env.example .env
#   → API_KEYS, TARGET_BASE_URL, SESSION_STATE_PATH ...

# 3) Oturumu kaydet (hedef platforma giriş yapman gerekir)
npm run session:save

# 4) Servisi başlat
npm start                       # http://localhost:8080

# 5) Test et
curl -X POST http://localhost:8080/api/v1/generate-asset \
  -H 'content-type: application/json' \
  -H 'x-api-key: dev-key-change-me' \
  -d '{"prompt":"altın saatte Kapadokya","negative_prompt":"blurry, text","aspect_ratio":"16:9","style":"photographic"}'
```

> **Tarayıcı olmadan denemek için:** `.env` içinde `DRY_RUN=true` yapın. Servis fixture bir
> görsel döndürür; tüm HTTP/kuyruk/teslim hattı gerçek ama Chromium ve session gerekmez.
> Bu mod CI'da sözleşmeyi doğrulamak için tasarlandı.

Docker ile:

```bash
docker compose up --build
# İlk kez oturum kaydetmek için (X11 gerekir, sunucuda değil yerelde çalıştırın):
#   npm run session:save  →  data/sessions/*.json  →  volume ile container'a girer
```

---

## 3. API Referansı

Tüm üretim uçları `{API_PREFIX}` (varsayılan `/api/v1`) altındadır ve
`Authorization: Bearer <key>` veya `x-api-key: <key>` ile doğrulanır.
Tüm isteklerde yanıt gövdesinde `request_id` döner (log korelasyonu için).
İnteraktif konsol: **`GET /docs`**, şema: **`GET /openapi.json`**

### 3.1 `POST {API_PREFIX}/generate-asset`

| Alan | Tip | Zorunlu | Açıklama |
|---|---|---|---|
| `prompt` | string (1-4000) | ✅ | Üretim istemi |
| `negative_prompt` | string (≤2000) | – | İstenmeyen öğeler |
| `aspect_ratio` | `"16:9"` \| `"1:1"` \| `"1.0"` | – | Varsayılan `1:1`. Alias'lar: `square/kare`, `landscape/yatay`, `portrait/dikey` |
| `style` | string (≤120) | – | Platformdaki stil etiketi (ör. `photographic`) |
| `count` | int 1-4 | – | Kuyruklanacak istek sayısı (platform desteğine göre) |
| `async` | bool | – | `true` → 202 + `job_id` |
| `callback_url` | url | – | `async=true` ile: sonuç buraya POST edilir |
| `delivery` | `url`\|`base64`\|`file`\|`both` | – | Bu istek için teslim biçimi (global `ARTIFACT_DELIVERY`'yi geçersiz kılar) |

**Senkron yanıt (200):**

```json
{
  "success": true,
  "image_url": "https://cdn.example.com/gens/8f3c….png?X-Amz-Signature=…",
  "image_base64": null,
  "image_file": null,
  "mime_type": "image/png",
  "bytes": 1843200,
  "sha256": "9f2c…",
  "delivery": "url",
  "captured_from": "network:json(https://arena.ai/api/generate)",
  "execution_time_ms": 4820,
  "meta": {
    "task_id": "9f2c1b7e-3d55-4a1",
    "steps": { "navigate": 812, "consent": 120, "aspect_ratio": 60, "prompts": 940, "click_generate": 70, "capture_artifact": 1900 },
    "page_url": "https://arena.ai/",
    "normalized_params": { "aspectRatio": "16:9", "style": "photographic", "prompt": "altın saatte Kapadokya…" },
    "candidates": [{ "url": "https://cdn…", "score": 11, "source": "network:image" }],
    "ws_frames": 0,
    "json_hits": 3,
    "reused_context": true,
    "context_id": "ctx-1757971…"
  },
  "request_id": "9f2c1b7e-3d55-4a1f-8b22-9d2c7a5b1e10"
}
```

**Asenkron mod:**

```bash
curl -X POST .../generate-asset -H 'x-api-key: …' -d '{"prompt":"…","async":true}'
# 202 → { "success": true, "job_id": "…", "status": "queued",
#          "poll_url": "/api/v1/jobs/…", "queue_position": 1 }
curl .../jobs/<job_id> -H 'x-api-key: …'
#     → { "status": "succeeded" | "queued" | "failed", "result": { … } }
```

### 3.2 Yardımcı uçlar

| Uç | Açıklama |
|---|---|
| `GET {API_PREFIX}/jobs/:id` · `DELETE` | İş durumu / iptal |
| `GET {API_PREFIX}/debug/selectors` | Hangi selector stratejisi kaç kez tuttu (self-healing raporu) |
| `GET {API_PREFIX}/debug/session-preview` | Session dosyasındaki cookie adları/süreleri (**değerler maskeli**) |
| `POST {API_PREFIX}/session/import` | Çalışırken yeni cookie setini yükler → context'ler otomatik geri dönüşür |
| `POST {API_PREFIX}/browser/reset` | Chromium'u sıfırlar (bakım) |
| `GET {API_PREFIX}/selectors/file` | Aktif selector JSON'u |
| `GET /health` · `/ready` · `/metrics` · `/version` | Servis durumu (hem kökte hem prefix altında) |
| `GET /files/artifacts/<dosya>` · `GET /files/fixtures/<dosya>` | `delivery=file` çıktıları (başka dizin servis edilmez) |

**Hata modeli** (her uçta aynı şema):

```json
{ "success": false,
  "error": { "code": "SESSION_INVALID", "message": "…", "details": {} },
  "request_id": "…" }
```

| HTTP | `code` | Anlamı | Yeniden denenebilir |
|---|---|---|---|
| 400 | `VALIDATION_ERROR` | Parametre hatası | ❌ |
| 401/403 | `UNAUTHORIZED` / `FORBIDDEN` | API anahtarı | ❌ |
| 429 | `QUEUE_FULL` / `RATE_LIMITED` | Kuyruk/limit dolu, backoff yap | ✅ |
| 502 | `NAVIGATION_ERROR`, `ARTIFACT_NOT_FOUND` | Hedef tarafı sorun | ✅ |
| 503 | `SESSION_INVALID`, `BROWSER_CLOSED` | Oturum yenilenmeli / tarayıcı çöktü | kısmen |
| 504 | `STEP_TIMEOUT`, `JOB_TIMEOUT` | Zaman aşımı | ✅ |

Retryable hatalarda servis `RETRY_ATTEMPTS` kadar üstel backoff ile yeniden dener;
`Retry-After` başlığı 429'larda set edilir.

---

## 4. Oturum (Cookie/Session) Yönetimi

Detaylı rehber: **[SESSION_GUIDE.md](SESSION_GUIDE.md)**. Özet:

| Yöntem | Ne zaman | Nasıl |
|---|---|---|
| `npm run session:save` (önerilen) | Normal durum | Görünür Chromium açılır, elle giriş yapılır, Enter'a basılır → `data/sessions/arena.json` |
| `--profile` modu | Kalıcı oturum isteyen platformlar | `SESSION_MODE=profile` + `PERSISTENT_PROFILE=true` |
| Tarayıcı eklentisi ile cookie export | Zaten tarayıcıda login'liysen | Cookie-Editor JSON'unu `data/sessions/arena.json` olarak kaydet (format otomatik normalize edilir) |
| `POST /session/import` | Servis çalışırken tazeleme | Yeni cookie setini POST et; `version` artar, havuzdaki context'ler geri dönüşür |

Kabul edilen formatlar: Playwright `storageState`, Cookie-Editor/EditThisCookie dizisi,
`{ "cookies": [...] }`, Netscape `cookies.txt`.

> ⚠️ `cf_clearance` benzeri cookie'ler **IP + User-Agent**'a bağlıdır. Kaydettiğin makine ile
> üretim sunucusunun UA'sı aynı olmalı (`USER_AGENT`), IP mümkünse aynı/a yakın olmalı.

---

## 5. Dayanıklılık ve Performans

- **Context havuzu** (`browserManager.js`): her istekte tarayıcı açılmaz; context yeniden
  kullanılır ve şu durumlarda geri dönüşüme gider: `MAX_PAGES_PER_CONTEXT`, `CONTEXT_MAX_AGE_MS`,
  session `version` değişikliği, çökme.
- **Kuyruk** (`queue.js`): `QUEUE_CONCURRENCY` eşzamanlı iş, `MAX_QUEUE_SIZE` aşılırsa `429`,
  iş bazlı `AbortSignal` timeout (`JOB_TIMEOUT_MS`), retryable hatalarda üstel backoff,
  dakikalık başlatma sınırı (`QUEUE_RATE_PER_MIN`).
- **Resilient selector**: her UI elemanı için sırayla denenene `testid → css → xpath → text →
  role → label → placeholder` zinciri; hangi stratejinin tuttuğu raporlanır.
- **Yakalama**: network yanıtları (görsel + JSON gövdesi derin tarama), WebSocket frame'leri,
  DOM taraması (`img`, `background-image`, `a[download]`, `data-*`), `blob:` → sayfa içi dataURL.
- **İnsan benzeri etkileşim**: fare eğrisi, karakter bazlı yazma, düşünme duraklamaları
  (`STEALTH_ENABLED` / `HUMANIZE` ile kapatılabilir).
- **Gözlemlenebilirlik**: `pino` JSON log + `request_id`, `GET /metrics`
  (requests_total/success/failed, retry, queue_rejection, latency p50/p90/p99, errors_by_code).
- **Graceful shutdown**: SIGTERM'de kuyruk boşaltılır, context'ler ve Chromium kapatılır.

---

## 6. Cloudflare / Anti-bot Stratejisi

Sırayla uygulanır:

1. **`playwright-extra` + `puppeteer-extra-plugin-stealth`** (`STEALTH_ENABLED=true`):
   `navigator.webdriver`, `chrome.runtime`, WebGL/Plugins parmak izleri düzeltilir.
2. **Init script + Chromium argümanları**: `AutomationControlled` özelliği kapatılır,
   `Sec-CH-UA*`/`Accept-Language` gerçek tarayıcıyla uyumlu gönderilir.
3. **Gerçek oturum**: en etkili adım. Login + `cf_clearance` cookie'si varsa challenge çoğu
   zaman hiç görünmez.
4. **Proxy desteği** (`PROXY_ENABLED`, `PROXY_SERVER`): datacenter IP'ler skorlanır; konut
   (residential) proxy oturum başarısını ciddi artırır. IP değişince **cookie'ler geçersiz olur** —
   proxy'yi session kaydıyla birlikte sabitleyin.
5. **Challenge fallback**: `challengeIndicators` seçicileriyle interstisyel ekran algılanır,
   kısa süre beklenir; çözülmezse `NAVIGATION_ERROR` döner (retry edilebilir).
6. **Rate limiting**: kuyruk hız sınırı + `QUEUE_CONCURRENCY` ile insanüstü trafik deseni engellenir.

> Headless tespiti sert platformlarda `BROWSER_HEADLESS=false` + `xvfb-run` kombinasyonu daha
> iyi çalışır: `xvfb-run -a npm start`.

---

## 7. Selector Mimarisi

`src/scrapers/selectors/arena.json` içindeki her anahtar bir **strateji zinciridir**:

```json
"generateButton": [
  { "by": "testid", "value": "generate-button", "tag": "button" },
  { "by": "role", "role": "button", "name": "Generate" },
  { "by": "role", "role": "button", "name": "Oluştur" },
  { "by": "css", "value": "button[type='submit']" }
]
```

Desteklenen stratejiler: `testid` (data-testid/data-test-id/data-test/data-cy/data-qa),
`css`, `xpath`, `id`, `text`, `role`, `label`, `placeholder`, `alttext`, `title`,
`attr`, `hasText`. Alanlar: `optional` (bulunamazsa hata atma), `nth`, `tag`
(ör. span'a tıklamak yerine üstteki `button`'a tıkla), `{option}` gibi değişkenler.

**DOM değiştiğinde ne yapılır?**

```bash
npm run session:inspect                 # her anahtar için strateji raporu + önerilen index
node scripts/inspectDom.js --dump       # data/dom-dump.html + ekran görüntüsü
# → rapordaki "← ÖNERİLEN" satırını JSON'da ilk sıraya taşı, gerekirse yeni strateji ekle.
```

Çalışırken hangi stratejilerin tuttuğunu görmek için: `GET /api/v1/debug/selectors`.

---

## 8. Yapılandırma (ENV)

Tam liste ve açıklamalar: **`.env.example`**. En kritik olanlar:

| Değişken | Varsayılan | Not |
|---|---|---|
| `PORT` / `HOST` | 8080 / 0.0.0.0 | |
| `API_KEYS` / `AUTH_ENABLED` | – / true | Üretimde zorunlu; virgülle birden fazla anahtar |
| `TARGET_BASE_URL` / `TARGET_GENERATE_PATH` | https://arena.ai / `/` | Hedef platform | 
| `DRY_RUN` | false | true → tarayıcısız fixture yanıtı (CI) |
| `SESSION_MODE` / `SESSION_STATE_PATH` | storage / ./data/sessions/arena.json | |
| `MAX_CONTEXTS` / `QUEUE_CONCURRENCY` | 3 / 2 | `concurrency ≤ contexts` olmalı |
| `JOB_TIMEOUT_MS` / `GENERATION_TIMEOUT_MS` | 120000 / 90000 | |
| `MAX_QUEUE_SIZE` / `QUEUE_RATE_PER_MIN` | 50 / 0 (oto) | Backpressure |
| `RETRY_ATTEMPTS` | 2 | `RETRY_ON` ile hangi hata sınıfları |
| `STEALTH_ENABLED` / `HUMANIZE` | true / true | Test/CI'da kapatılabilir |
| `PROXY_ENABLED`, `PROXY_SERVER` | false | Oturumla birlikte sabitleyin |
| `ARTIFACT_DELIVERY` | url | `url` \| `base64` \| `file` \| `both` |
| `ALLOWED_ASSET_HOSTS` | – | Boşsa hedef host + yaygın CDN suffix'leri; doluysa katı allowlist |
| `MAX_DOWNLOAD_BYTES` | 26214400 | İndirme boyut sınırı (SSRF/DoS koruması) |
| `BLOCK_URL_PATTERNS` | – | Analytics/tracker engelleme (görselleri engellemeyin!) |

---

## 9. Test ve Doğrulama

```bash
npm run smoke        # servis ayakta mı? auth/validasyon/DRY_RUN akışı (6 kontrol)
npm test             # tests/ : sahte hedef sunucusu ile gerçek Chromium uçtan uca testler
```

`tests/integration.test.js`, `tests/fakeTargetServer.js` içindeki yerel taklit platformu kullanır:

- prompt yazma → aspect/style/negative seçimi → tıklama → **CDN URL yakalama** → indirme → `sha256`
- parametrelerin forma gerçekten yazıldığının doğrulanması (regresyon testi)
- context havuzunun yeniden kullanımı (`meta.reused_context = true`, yeni context açılmaması)
- 3 eşzamanlı isteğin kuyruk üzerinden hatasız işlenmesi
- validasyon hatalarının doğru kodla dönmesi

---

## 10. Üretim Notları / Sorun Giderme

**Genel**
- `MAX_CONTEXTS` ve `QUEUE_CONCURRENCY` değerlerini RAM'e göre seçin (~150-250 MB/context).
  2 vCPU / 2 GB için `3` ve `2` iyi bir başlangıçtır.
- Tek process tasarımı bilinçlidir. Yatay ölçekleme için: `jobStore`'u Redis'e taşıyın,
  `SESSION_MODE=storage` + paylaşılan session dosyası/secret kullanın, her replikaya ayrı proxy IP verin.
- API'yi internete açmayın; hesap kullanım koşullarını ve hız limitlerini uygulamanızın
  sorumluluğundadır.

| Belirti | Olası neden | Çözüm |
|---|---|---|
| `SESSION_INVALID` (503) | Session dosyası yok / expire | `npm run session:save`, sonra `POST /session/import` |
| `NAVIGATION_ERROR: challenge` | Cloudflare interstisyel ekranı çözülmedi | `USER_AGENT` + proxy tutarlılığı, `BROWSER_HEADLESS=false` + `xvfb-run` |
| `ARTIFACT_NOT_FOUND` (502) | DOM/selector kayması veya API yanıtı bulunamadı | `npm run session:inspect`, `meta.candidates` listesine bakın, selector JSON güncelleyin |
| `STEP_TIMEOUT: selector:…` | Selector zinciri hiçbir stratejiyle eşleşmedi | Aynı adım; `STEP_TIMEOUT_MS` artırılabilir |
| Ağır bellek artışı | Context sızıntısı | `MAX_PAGES_PER_CONTEXT` / `CONTEXT_MAX_AGE_MS` düşürün; `POST /browser/reset` |
| Tüm istekler 500 | `AUTH_ENABLED=true` ama `API_KEYS` boş | `.env` düzeltin (startup uyarısı loglanır) |
| 429 `QUEUE_FULL` | Eşzamanlı yük fazla | İstemci backoff, `MAX_QUEUE_SIZE`/`QUEUE_CONCURRENCY` ayarı |
| `blob:` URL indirilemiyor | Platform görseli blob olarak tutuyor | Varsayılan olarak desteklenir (sayfa içinde dataURL'e çevrilir) |

### Güvenlik kontrol listesi

- [ ] `API_KEYS` güçlü ve rotasyona açık; `AUTH_ENABLED=true`
- [ ] `.env` ve `data/sessions/*` git'e **girmiyor** (bkz. `.gitignore`)
- [ ] `ALLOWED_ASSET_HOSTS` üretimde açık allowlist olarak tanımlı
- [ ] `/metrics`, `/jobs`, `/debug/*` uçları iç ağa kısıtlandı (ters proxy)
- [ ] `CORS_ORIGINS` gerekli origin listesiyle sınırlı (`*` değil)
- [ ] Container `--read-only` + `--cap-drop=ALL` ile çalıştırılıyor (Playwright için tmpfs)

---

## Lisans / Sorumluluk

Bu araç, hedef platformun kullanım şartlarına tabidir. Yalnızca yetkili olduğunuz hesaplarda
ve izin verilen kapsamda kullanın. Otomasyon kaynaklı hesap kısıtlamalarından kullanıcı sorumludur.
