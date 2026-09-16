# 🤖 Arena — AI Görsel Üretimi Kurulumu

Şarkı API'ye **eklemeli** olarak eklenen AI görsel üretimi. Mevcut müzik uçlarına hiç dokunulmadı.

```
Projen / tarayıcı
      │  ?key=sk-...            (Şarkı API'nin kendi key sistemi)
      ▼
mp3-apisi.onrender.com  ──►  /api/v1/arena/gorsel   (yeni uçlar)
      │  x-api-key: <arena anahtarı>   (ARENA_API_KEY env)
      ▼
arena-proxy (ayrı servis, Playwright/Chromium)
      │
      ▼   hedef platformun üretim arayüzü → görselin CDN linki
```

Neden ayrı servis? Chromium başlatmak ve oturum saklamak ağır iştir; Flask sürecinin içinde
çalıştırmak müzik API'sini yavaşlatır/çökertir. Bu yüzden arena-proxy ayrı bir süreç olarak
çalışır, köprü (`arena_api.py`) yalnızca HTTP ile bağlanır.

---

## 1. Yerel deneme (5 dakika, hedef platform gerekmez)

Sahte bir "hedef platform" ile tüm akışı gerçek Chromium üzerinden deneyebilirsin:

```bash
# --- terminal 1: sahte hedef platform (prompt + Generate + CDN görsel taklidi)
cd arena-proxy
npm install && npx playwright install --with-deps chromium
node scripts/fakeTarget.js --port 9099 --asset data/fixtures/sample.png --latency 1200

# --- terminal 2: arena-proxy'yi sahte platforma yönlendir
cd arena-proxy
DRY_RUN=false SESSION_MODE=profile PROFILE_BASE_DIR=/tmp/ap-profiles \
TARGET_BASE_URL=http://127.0.0.1:9099 TARGET_GENERATE_PATH=/ \
ARTIFACT_DELIVERY=url API_KEYS=sk-arena-demo-key PREWARM_BROWSER=true \
node server.js                      # → :8080

# --- terminal 3: Şarkı API'yi arena'ya bağla
ARENA_API_URL=http://127.0.0.1:8080 ARENA_API_KEY=sk-arena-demo-key \
ARENA_DELIVERY=url ADMIN_PAROLA=test-parola PORT=7900 \
python3 api.py                      # → :7900

# --- terminal 4: test
KEY=$(curl -s -X POST localhost:7900/api/v1/keys/olustur -H 'content-type: application/json' \
      -d '{"isim":"test","saglayicilar":["arena"],"parola":"test-parola"}' | python3 -c "import json,sys;print(json.load(sys.stdin)['key'])")

curl "localhost:7900/api/v1/arena/durum?key=$KEY"
curl "localhost:7900/api/v1/arena/gorsel?prompt=okyanusta köpek balığı&mod=json&key=$KEY"
```

---

## 2. Render'da iki servis

### 2a. arena-proxy servisi (Docker)

Render → **New → Web Service** → repo `kcbyk/Mp3_apisi`:

| Ayar | Değer |
|---|---|
| Name | `arena-proxy` |
| Region | Frankfurt (mp3-apisi ile aynı) |
| Branch | `main` |
| Runtime | **Docker** |
| Root Directory | `arena-proxy` |
| Dockerfile Path | `Dockerfile` (root directory'e göre) |
| Instance Type | Free (512 MB) — ayarlar buna göre optimize |
| Health Check Path | `/health` |
| Auto-Deploy | **No** (tarayıcı servisi; kontrollü deploy) |

> ⚠️ **Root Directory = `arena-proxy`** olmalı; aksi halde Docker, mp3-apisi'nin
> `requirements.txt`'ini arar ve build başarısız olur.

**Environment değişkenleri:**

| Değişken | Değer | Not |
|---|---|---|
| `RENDER` | `1` | Bulut modu: dizinler `/tmp`, tek context, tek eşzamanlı iş |
| `API_KEYS` | `sk-arena-<rastgele>` | **Gizli.** Bu değeri mp3-apisi tarafındaki `ARENA_API_KEY`'e yazacaksın |
| `AUTH_ENABLED` | `true` | |
| `TARGET_BASE_URL` | `https://arena.ai` | Hedef platform |
| `TARGET_GENERATE_PATH` | `/` | Üretim aracının yolu |
| `SESSION_STATE_B64` | `<base64>` | **Gizli.** Aşağıdaki 2c adımında üretilecek |
| `DRY_RUN` | `false` | `true` yaparsan tarayıcı açılmaz, örnek görsel döner (test için pratik) |
| `ARTIFACT_DELIVERY` | `url` | CDN linkini doğrudan döndür (bayt taşımadan en hızlı) |
| `STEALTH_ENABLED` / `HUMANIZE` | `true` | Bot koruması / insan benzeri etkileşim |
| `MAX_CONTEXTS` / `QUEUE_CONCURRENCY` | `1` | Free plan 512 MB RAM sınırı |
| `PREWARM_BROWSER` | `true` | Soğuk başlangıcı azaltır |
| `LOG_LEVEL` | `info` | |

### 2b. mp3-apisi servisi (mevcut servis — sadece 3 env eklenecek)

Render → **mp3-apisi** → Environment → **Add Environment Variable**:

| Değişken | Değer |
|---|---|
| `ARENA_API_URL` | `https://arena-proxy-xxxx.onrender.com` (2a'daki servisin adresi) |
| `ARENA_API_KEY` | `sk-arena-<2a'da belirlediğin anahtar>` |
| `ARENA_DELIVERY` | `url` (veya görseli kendi sunucundan geçirmek istersen `file`) |

Opsiyonel: `ARENA_TIMEOUT` (varsayılan **150** sn — Render free'de soğuk başlangıç payı),
`ARENA_DENEME` (varsayılan 2).

Kaydettikten sonra servis otomatik yeniden başlar. Loglarda şunu görmelisin:

```
[arena] entegrasyon aktif — uçlar: /api/v1/arena/durum, /api/v1/arena/gorsel, /api/v1/arena/sonuc/<is_id>
```

### 2c. Oturum (cookie) hazırlığı

Hedef platform oturum ister. Cookie'ler Render'ın geçici dosya sisteminde tutulamaz,
bu yüzden **base64 olarak env değişkenine** konur:

```bash
# Yerel makinede, bir kez:
cd arena-proxy
npm run session:save                    # açılan tarayıcıda platforma giriş yap, ENTER'a bas
npm run session:env -- --out session.env
# → session.env içindeki SESSION_STATE_B64 değerini kopyala
# → Render → arena-proxy → Environment → SESSION_STATE_B64 olarak yapıştır
```

> ⚠️ `cf_clearance` gibi cookie'ler **IP + User-Agent**'a bağlıdır. Oturumu kaydettiğin
> makinenin UA'sı ile sunucudaki `USER_AGENT` aynı olmalı; IP farklıysa platform oturumu
> düşürebilir (bu durumda o IP'den yeniden login gerekir).
>
> ⚠️ `SESSION_STATE_B64` değeri oturumun kadar değerlidir — kimseyle paylaşma, sohbete yapıştırma.

Oturum düşerse: `POST /api/v1/session/import` (arena-proxy) veya yeni base64 üretip env'i
güncelle → Render → Manual Deploy.

---

## 3. Kullanım

Key'ini ana sayfadan **🤖 Arena** çipini seçerek oluştur (veya "✨ Tümü"). Arena izni olmayan
key'ler bu uçlarda **403** alır — mevcut müzik key'lerin etkilenmez.

```bash
K="sk-..."   # ana sayfadan aldığın key

# 1) Bağlantı durumu
curl "https://mp3-apisi.onrender.com/api/v1/arena/durum?key=$K"

# 2) Görsel üret (JSON)
curl "https://mp3-apisi.onrender.com/api/v1/arena/gorsel?prompt=okyanusta köpek balığı&mod=json&key=$K"

# 3) Doğrudan <img src> olarak kullan (görsel senin sunucundan akar)
#    <img src="https://mp3-apisi.onrender.com/api/v1/arena/gorsel?prompt=koala&mod=indir&key=sk-...">

# 4) 302 → CDN linki (en hızlı; büyük dosya sunucudan geçmez)
curl -I "https://mp3-apisi.onrender.com/api/v1/arena/gorsel?prompt=koala&mod=url&key=$K"

# 5) base64 (LLM'e görsel göndermek için)
curl "https://mp3-apisi.onrender.com/api/v1/arena/gorsel?prompt=koala&mod=base64&ham=1&key=$K"

# 6) Asenkron (uzun süren üretimlerde; hemen iş kimliği döner)
curl "https://mp3-apisi.onrender.com/api/v1/arena/gorsel?prompt=koala&bekleme=0&key=$K"
curl "https://mp3-apisi.onrender.com/api/v1/arena/sonuc/<is_id>?key=$K"
```

**POST ile (JSON):**

```bash
curl -X POST "https://mp3-apisi.onrender.com/api/v1/arena/gorsel?key=$K" \
  -H 'content-type: application/json' \
  -d '{"prompt":"altın saatte Kapadokya","negative_prompt":"blurry, text","aspect_ratio":"16:9","style":"photographic"}'
```

**JavaScript:**

```js
const K = "sk-...";
const r = await fetch(`https://mp3-apisi.onrender.com/api/v1/arena/gorsel?prompt=koala&mod=json&key=${K}`);
const { gorsel_url, gorunum_url, sure_ms } = await r.json();
document.querySelector("img").src = gorunum_url;   // sunucu üzerinden akan görsel
```

**Python:**

```python
import requests
r = requests.get("https://mp3-apisi.onrender.com/api/v1/arena/gorsel",
                 params={"prompt": "koala", "mod": "json", "key": "sk-..."}, timeout=180)
print(r.json()["gorsel_url"])
```

### Yanıt alanları

| Alan | Anlam |
|---|---|
| `ok` | İşlem başarılı mı |
| `gorsel_url` | Üretilen görselin CDN linki (senkron modda) |
| `gorunum_url` | `<img src>` için hazır, kendi sunucundan geçen URL |
| `is_id` / `sonuc_url` | Asenkron iş kimliği ve sorgu adresi |
| `boyut`, `mime`, `sha256` | Görsel boyutu / türü / sağlaması (tekilleştirme için) |
| `sure_ms` | Üretim süresi (ms) |
| `kaynak` | Görselin yakalandığı kanal (`network:json`, `network:image`, `dom:img` …) |
| `arena_meta.adimlar` | Adım adım süre dökümü (navigate, prompts, click, capture) |

### Modlar

| `mod` | Davranış | Ne zaman |
|---|---|---|
| `url` (varsayılan) | 302 → CDN linki | En hızlı; bayt sunucudan geçmez |
| `json` | Tam JSON yanıt | Programatik kullanım |
| `indir` | Görseli bu sunucudan geçirir (`&dosya=1` → indirme) | `<img src>`, CDN linkini gizlemek istediğinde |
| `base64` | Yanıtta base64 (`&ham=1` → sade metin) | LLM'e görsel gönderme |

### Parametreler

| Param | Eş anlamlı | Örnek |
|---|---|---|
| `prompt` | `q` | `okyanusta köpek balığı` |
| `negatif` | `negative_prompt` | `blurry, text, watermark` |
| `oran` | `aspect_ratio` | `1:1`, `16:9`, `9:16`, `4:3`, `21:9` |
| `stil` | `style` | `photographic`, `cinematic`, `anime` |
| `bekleme` | — | `0` → asenkron |
| `delivery` | — | `url` / `file` / `base64` / `both` (arena-proxy teslim biçimi) |

---

## 4. Sorun giderme

| Belirti | Neden / Çözüm |
|---|---|
| `503 Arena entegrasyonu kurulu değil` | mp3-apisi'nde `ARENA_API_URL` yok → ekle, servisi yeniden başlat |
| `Bu key'in 'arena' izni yok (403)` | Key'i 🤖 Arena seçili (veya ✨ Tümü) yeniden oluştur |
| İlk çağrı 30-60 sn sürüyor | Render free soğuk başlangıç. `PREWARM_BROWSER=true` + mp3 tarafında `ARENA_TIMEOUT=150` |
| `SESSION_INVALID` / login wall | Oturum düşmüş → 2c adımını tekrarla (yeni base64 + deploy) |
| `ARTIFACT_NOT_FOUND` (502) | Hedef DOM değişmiş → arena-proxy'de `npm run session:inspect` ile selector kayıt defterini güncelle (`arena-proxy/src/scrapers/selectors/arena.json`) |
| Bot koruması (challenge) | `USER_AGENT` + IP tutarlılığı; gerekirse konut proxy (`PROXY_ENABLED=true`) |
| Görsel üretiliyor ama 502 | arena-proxy loglarına bak: Render → arena-proxy → Logs |
| Müzik uçları yavaşladı | Arena çağrıları ayrı serviste; şarkı API'si etkilenmez. Şüphen varsa `ARENA_TIMEOUT` düşür |

Render free plan notu: arena-proxy 15 dk hareketsizlikte uyur, ilk istek uyandırır (30-60 sn).
Sık kullanıyorsan ücretsiz bir uptime izleyicisi ile `/health` uçunu 10 dk'da bir yoklayabilirsin
(mp3-apisi'nin `nobetci.yml` iş akışına arena-proxy health check'i eklemek de mümkün).

---

## 5. Geri alma (rollback)

Entegrasyon **tamamen eklemeli** olduğu için geri almak tek commit:

```bash
git revert <integrason-commit-sha>     # arena uçları, çip ve doküman bölümü geri alınır
# veya: sadece Render'da ARENA_API_URL'i sil → uçlar 503 döner, sistem çalışmaya devam eder
```
