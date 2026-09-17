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
| `TARGET_GENERATE_PATH` | `/image/direct` | arena.ai görsel üretim arayüzü (keşfedildi) |
| `TARGET_SEND_MODE` | `auto` | `auto` → arena.ai'de **Enter** ile gönderir (butona tıklamak reCAPTCHA/ToS kapısını tetikleyip üretimi başlatmıyor) |
| `GENERATION_TIMEOUT_MS` | `600000` | Arena'nın "Max" modeli yoğun saatlerde uzun sürüyor |
| `JOB_TIMEOUT_MS` | `660000` | Üretim zaman aşımı + pay |
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
| `ARENA_TIMEOUT` | `900` (Arena'nın yavaş modeli için) |

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

#### Tek komutla çerez yenileme (önerilen)

Çerezi aldıktan sonra (Cookie-Editor → **Export as JSON** → dosyaya kaydet):

```bash
cd arena-proxy
# yerel oturumu yazar + Render env'i günceller + yeniden dağıtır + oturumu doğrular:
RENDER_API_KEY=rnd_xxx RENDER_SERVICE_ID=srv-xxx RENDER_PROXY_API_KEY=sk-arena-xxx \
  node scripts/cerez-guncelle.mjs --dosya ~/arena-cerez.json
```

Desteklenen girdiler: Cookie-Editor JSON dizisi (önerilen), Playwright storageState,
tek cookie nesnesi, `document.cookie` metni (⚠️ httpOnly çerez görünmez),
Netscape `cookies.txt`. Betik çerez değerlerini **ekrana yazmaz**; yerel dosyayı `600`
izniyle yazar ve `arena-auth-prod-v1.0` çerezinin varlığını/uzunluğunu kontrol edip uyarır.

Sadece yerel dosyayı güncellemek için: `--kuru`. Base64'ü ekrana yazmak için: `--env`.

#### ♾️ Ölümsüz oturum: çerezi bir kez al, servis kendisi yenilesin

**Sorun:** arena.ai oturumu Supabase tabanlıdır; `access_token` 1 saat yaşar ve
`refresh_token` **her kullanımda değişir**. Aynı çerezi iki yer kullanırsa (tarayıcın +
sunucu, ya da iki sunucu kopyası) Supabase *yeniden kullanım* algılar ve **tüm jeton
ailesini iptal eder** → oturum aniden ölür. (Canlıda tam olarak bu yaşandı.)

**Çözüm — servis jetonun tek sahibi olsun:**

| Adım | Ne yapar | Ayar |
|---|---|---|
| 1 | Jeton dolmadan **kendisi yeniler** (varsayılan 25 dk'da bir, HTTP ile ~20 ms) | `SESSION_KEEPALIVE_MINUTES=25`, `SESSION_REFRESH_THRESHOLD_MINUTES=20` |
| 2 | Yeni çerezi **kalıcı yazar** (Render'da dosya sistemi kalıcı değil!) | `SESSION_PERSIST=file+render` |
| 3 | Yeniden başlatmada en yeni jetonu kullanır | `SESSION_ENV_VAR_NAME=SESSION_STATE_B64` |
| 4 | Üretimden önce ömrü 10 dk'nın altındaysa yine tazeler | otomatik |

**Canlı kanıt:** bekçi 60 sn'de `kalanDk: 3 → 60` yenilemesini 16 ms'de yaptı ve dosyaya
600 izniyle yazdı (yerel test, dönen jetonlu sahte hedef).

**Tek kural (kritik):** Bu çerez **tek sahipli** olmalı.
- Çerezi aldığın tarayıcıda o hesapla arena.ai'yi **kullanma** (her kullanım jetonu döndürür).
- Servisi **tek kopya** çalıştır (iki örnek aynı jetonu yerse aile iptal olur). Yerel testte
  aynı `SESSION_STATE_B64`'yi kullanma.
- En temizi: otomasyon için **ayrı bir Arena hesabı** aç (bir kez giriş yap, çerezini al, o
  hesabı tarayıcıda bir daha kullanma) → zincir sonsuza kadar servisde kalır.

**Kalıcılık seçenekleri**
1. `file+render` — servis kendi `SESSION_STATE_B64`'ünü Render API ile günceller.
   ⚠️ `RENDER_API_KEY` **uzun ömürlü** olmalı (1 günlük anahtar ertesi gün oturumu dondurur).
2. `file+github` — yeni çerez **özel** bir repoya yazılır (`GITHUB_SESSION_REPO`).
   Kod, repo private değilse yazmayı **reddeder** (güvenlik).
3. `file` — yalnız yerel/kalıcı diskli ortamlar (VPS, Docker volume).

Yeni uçlar:
```bash
curl -X POST "https://arena-proxy.onrender.com/api/v1/session-yenile" -H "x-api-key: $ARENA_KEY"
# → {"success":true,"once":{...},"sonra":{"kalanDk":59,...},"yol":"http","sure_ms":21}
curl "https://arena-proxy.onrender.com/health"   # session.oturum.kalanDk / refreshVar / kullanici
```

#### Oturumu saniyeler içinde doğrula (canlı test)

```bash
curl "https://arena-proxy.onrender.com/api/v1/session-dogrula" -H "x-api-key: $ARENA_KEY"
# → {"oturum_gecerli":true,"sebep":"oturum geçerli görünüyor","url":"...","sure_ms":3500}
# → {"oturum_gecerli":false,"sebep":"sayfa \"Log In\" gösteriyor (oturum düşmüş)"}
```

`oturum_gecerli:false` ise üretim isteği 10 dakika beklemez; **2-3 saniyede**
`SESSION_INVALID` hatası döner.

#### ⚠️ Çok önemli: Arena yenileme jetonunu DÖNDÜRÜR (rotation)

Canlıda doğrulandı: `arena-auth-prod-v1.0` çerezindeki oturum ~2 saat çalıştıktan sonra
geçersizleşti. Nedeni: Arena/Supabase **yenileme jetonu (refresh token) rotasyonu** yapar —
dışa aktardığın çerezi kullanan *başka* bir tarayıcı/sekme jetonu yenilerse, senin kopyan
geçersiz olur. Sonuç:

- Çerezi, **üretim yapacağın anda** dışa aktar (eski kopyayı saklayıp sonra kullanmayı planlama).
- Dışa aktardıktan sonra o tarayıcıda arena.ai'yi **kullanma** (her kullanım jetonu döndürür).
- İkinci bir cihaz/sekme de jetonu döndürebilir; kritik üretimden önce `/session-dogrula` ile teyit et.
- Arena oturumu düşürdüyse hiçbir ayar kurtarmaz; tek çözüm taze çerezdir (üretim 2-3 sn'de
  `SESSION_INVALID` döner, uzun beklemeye girmez).

---

## 2d. arena.ai hakkında doğrulanmış teknik notlar

Bu entegrasyon sırasında **canlı arena.ai DOM'u ve ağ trafiği** incelendi:

| Konu | Bulgu |
|---|---|
| Görsel üretim rotası | `https://arena.ai/image/direct` (tekli), `/image/side-by-side` (karşılaştırma) |
| Prompt alanı | `textarea[placeholder^="Describe the image you want to generate"]` |
| Görsel modu butonu | `button[aria-label="Image"]` |
| Gönder butonu | `button[aria-label="Send message"]` (sayfada 2 adet, biri pasif) |
| **Kritik** | Gönder **butonuna tıklamak** "…This helps us keep the platform safe… Protected by reCAPTCHA" ara kapısını tetikliyor ve üretim başlamıyor. **Enter ile göndermek** doğrudan çalışıyor. `TARGET_SEND_MODE=auto` bunu arena.ai için otomatik seçer. |
| Onay kapısı | İlk gönderimde "…hit Enter on your keyboard to agree" ToS kapısı çıkar; Enter hem kapıyı kapatır hem mesajı gönderir |
| Görsel kaynağı | `messages-prod.<hash>.r2.cloudflarestorage.com` (Cloudflare R2) — izin listesine eklenmiştir |
| Yanlış eşleşme koruması | Kullanıcı avatarı (`googleusercontent.com`), logo ve üretim öncesi sayfada duran görseller aday sayılmaz (DOM temel çizgisi) |
| Oturum | Google ile giriş yapılmış oturum gerekir; çerez tabanlıdır (localStorage gerekmez) |
| **Giriş duvarı (canlı gözlem)** | Oturum düşünce: onay kapısı → sonra **"Continue with Google / Continue with email"** diyaloğu → `/v3/signin/*` sayfası. Bu işaretler algılanır ve istek anında `SESSION_INVALID` ile biter |
| Radix modal tıklaması | ToS/giriş modalları pointer olaylarını emer (Playwright: *subtree intercepts pointer events*). Bu yüzden "Agree" için DOM `click()` yedeği eklendi |

**Doğrulama kaydı:** Gerçek arena.ai üzerinden görsel üretimi iki kez başarıyla tamamlandı
(28 sn ve 40 sn; 1536×1024 PNG, Cloudflare R2 URL'i). Yoğun saatlerde Arena'nın "Max"
modeli dakikalarca sürebiliyor — bu yüzden zaman aşımları yüksek tutulmuştur.

Ayrıca: `DEBUG_CAPTURE=1` ile yakalama döngüsü her 10 turda sayfa durumunu loglar
(sorun gidermede en hızlı yol). Hata anında `data/screenshots/` altına ekran görüntüsü
kaydedilir; Render'da kalıcı olmadığı için loglardaki `metinSon` alanına bakın.

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

## 3b. ⚠️ Uzun üretimlerde ASENKRON mod kullanın (canlıda doğrulandı)

Arena'nın "Max" modeli yoğun saatlerde **dakikalarca** sürebiliyor. Render'ın HTTP proxy'si
tek bir isteği uzun süre boşta bekletirse bağlantıyı düşürebiliyor (canlı testte
`fetch failed` olarak görüldü). Bu yüzden gerçek Arena üretimlerinde **asenkron akış** önerilir:

```bash
# 1) İşi başlat → hemen iş kimliği döner (202)
curl "https://mp3-apisi.onrender.com/api/v1/arena/gorsel?prompt=altın saatte köpek balığı&bekleme=0&key=$K"
# → {"ok":true,"durum":"kuyrukta","is_id":"e459d79c-...","sonuc_url":"/api/v1/arena/sonuc/e459d79c-..."}

# 2) İşi yokla (20-30 sn'de bir) → "kuyrukta" → "bitti"
curl "https://mp3-apisi.onrender.com/api/v1/arena/sonuc/e459d79c-...?key=$K"
# → {"ok":true,"durum":"bitti","gorsel_url":"https://messages-prod...r2.cloudflarestorage.com/..."}
```

- Tek context (ücretsiz plan) olduğu için istekler **sıraya** girer: `/api/v1/arena/durum`
  ve arena-proxy `/api/v1/jobs` ile kuyruk durumunu görebilirsin.
- `durum` alanı: `kuyrukta` (sırada) → `bitti` | `hata`.
- Senkron mod (`bekleme` yok) kısa işlerde veya hızlı modellerde kullanışlı; uzun
  üretimlerde bağlantı kopabilir.

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
| `SESSION_INVALID` hatası | arena.ai oturumu düşmüş. Taze Cookie-Editor JSON'u al → `SESSION_STATE_B64` güncelle → Manual Deploy. Kaynak tarayıcıda arena.ai'yi kullanmak jetonu döndürüp kopyayı geçersizleştirir (bkz. 2c) |
| İş `kuyrukta` kalıyor | Tek context dolu → önceki iş bitmeli. `/api/v1/jobs` ile bak; takılan işi `DELETE /api/v1/jobs/<id>` ile iptal edebilirsin |
| Uzun istek `fetch failed` ile kopuyor | Senkron yerine **asenkron** akışı kullan (bkz. 3b) |
| İlk istek 60-90 sn | Render ücretsiz plan soğuk başlangıcı + Chromium açılışı. `PREWARM_BROWSER=true` + `/health`'i 10 dk'da bir yoklamak çözer |
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


---

## 12) Canlı doğrulama notları (2026-09-16) — kök nedenler ve kalıcı çözümler

### 12.1 arena.ai onay katmanları besteyi kilitliyor (asıl "mesaj gönderilemedi" nedeni)
Canlıda üç ayrı katman gözlendi; hepsi gönderimi (ve tıklamayı) engelliyor:

| Katman | Metin | Eylem |
|---|---|---|
| A | "This website uses cookies" | **Accept Cookies** (kapatır) |
| B | "Manage Cookie Preferences" | **Save Preferences** (yalnızca şartlar onaylıysa etkin) |
| C | "Terms of Use & Privacy Policy" | **Agree** (Enter ile de) — önce bu, sonra B |

Kod: `cerezOnayiniKur()` (arenaScraper) sırayı kendisi uygular; onay sonrası sayfayı
yeniler. Onay durumu **hem çerezde (`cookie-preferences`) hem localStorage'da** tutulduğu
için ikisi de oturum dosyasına yakalanır (`tarayiciCerezleriniYakala`).

### 12.2 Tek tüketici kuralı (refresh token rotasyonu) — oturumun "ölümü"nü önler
Supabase yenileme jetonunu **her kullanımda döndürür**. İki tüketici (ör. HTTP yenileme +
sayfa kendi yenilemesi) aynı jetonu kullanırsa "refresh token reuse" tespiti **tüm aileyi
iptal eder** ve hesap düşer (canlıda yaşandı → 07:10 bekçi denemesi reddedildi).

Alınan önlemler:
- `SESSION_HTTP_REFRESH=false` → yalnızca tarayıcı yolu (uygulamanın kendi yenilemesi).
- Her tarayıcı context'i kapandıktan sonra çerezler **ve** localStorage yakalanıp kalıcı yazılır
  (`tarayiciCerezleriniYakala`, `oturumuKaliciYaz`, `sessionStore.guncelle`).
- Bellekteki oturum anında değişir; süreç yeniden başlamadan yeni jetonla çalışır.

### 12.3 Süreler (Arena "Max" üretimi 10+ dakika sürebiliyor)
- `JOB_TIMEOUT_MS=1500000` (25 dk) — iş zaman aşımı
- `GENERATION_TIMEOUT_MS=1200000` (20 dk) — görsel URL'i yakalama
- `SESSION_BROWSER_WAIT_MS=1500000` — bekçi tarayıcı beklemesi (jetonun bitişine göre dinamik)
- `SESSION_KEEPALIVE_MINUTES=15`, `SESSION_REFRESH_THRESHOLD_MINUTES=15`

### 12.4 Doğrulama uçları (API anahtarıyla)
- `POST /api/v1/session-dogrula` → `{oturum_gecerli, giris_yapildi, url, sure_ms}` (hızlı; onayları da kapatır)
- `POST /api/v1/debug/probe` `{gonder:true,prompt}` → seçici eşleşmeleri, katmanlar, gönderim yöntemi matrisi, ekran görüntüsü
- `GET /api/v1/debug/screenshot?n=1` → son hata ekran görüntüsü (base64)
- Hata kodları: `SESSION_INVALID` (hızlı başarısız — 2-3 sn), `ARTIFACT_NOT_FOUND`, `JOB_TIMEOUT`

### 12.5 Çerez ölümsüzlüğü — durum
Sunucu tarafı yenileme yok; zincir yalnızca "tek tüketici + yakala + sakla" ile yaşar.
Bir kez yakalanan zincir, sayfa her açıldığında kendini döndürür ve daima tazelenir.
Zincir bir kez koptuysa (reuse iptali) **yeni dışa aktarım zorunludur** — iptal edilmiş
yenileme jetonu hiçbir yolla geri gelmez.

### 12.6 Azure VM (docker run) — süre env'leri ve senkron çağrı tuzağı (canlı vaka, 2026-09-16)

Belirti: `POST /api/v1/generate-asset` senkron çağrıda istemci (`curl -m 180`) 180.sn'de
koptu → log'da `statusCode: null, responseTime: 180002`. Sunucuda: 1. deneme 240sn sonra
`ARTIFACT_NOT_FOUND`; 2. deneme ancak 29sn yaşayabildi, `JOB_TIMEOUT` (300sn) ile abort edildi.

Kök neden zinciri:
1. Konteyner env'siz başlatılmış → kısa süreler: `GENERATION_TIMEOUT_MS=240000`,
   `JOB_TIMEOUT_MS=300000`, `RETRY_ATTEMPTS=3`.
2. İş süresi (300sn) tek tam denemeden (~270sn) az uzun → retry'lar kağıt üstünde kaldı:
   2. ve 3. deneme başlar başlamaz iş zaman aşımına kurban gitti.
3. İstemci erken öldüğü için 504 yanıtını hiç görmedi.

Kalıcı düzeltmeler (kodda):
- Kod **varsayılanları** `.env.example` ile hizalandı: 25dk iş / 20dk üretim beklemesi.
- Açılışta **süre tutarlılığı uyarısı** (`★ arena-proxy başlatılıyor` logundaki `warnings`).
- **Doomed-retry skip:** kalan süre tam denemeyi karşılamıyorsa yeni deneme hiç
  başlatılmaz; son hata dürüstçe döner (tarayıcı boşa yakılmaz).
- 502/504 yanıtlarına `error.hint` alanı: istemciyi `{"async":true}` akışına yönlendirir.

Kural: `JOB_TIMEOUT_MS ≥ GENERATION_TIMEOUT_MS + 30sn + (deneme_sayısı-1) × 120sn`.

Azure'da önerilen başlatma:
```bash
docker run -d --name arena-proxy --restart unless-stopped \
  -p 8080:8080 \
  -e GENERATION_TIMEOUT_MS=1200000 \
  -e JOB_TIMEOUT_MS=1500000 \
  -e RETRY_ATTEMPTS=2 \
  -v $(pwd)/data:/app/data \
  arena-proxy
```

Senkron testte istemci süresi iş süresinden büyük olmalı: `curl -m 1500 ...`.
İdeal kullanım yine asenkron: `{"prompt":"...","async":true}` → `GET /api/v1/jobs/<job_id>`.
İstemci kopsa bile iş arka planda yaşar; sonuç `/jobs/<job_id>`'den okunur.

## 13) Tarayıcısız sağlayıcı: Pollinations (kurtuluş toķeninı, 2026-09-16)

arena.ai zinciri (oturum rotasyonu + Cloudflare + bekçi) kırılınca yeni strateji:
`IMAGE_PROVIDER=pollinations` ile servis **Chromium'a hiç çıkmadan** görsel üretir.

- API: `GET image.pollinations.ai/prompt/<prompt>?width=..&height=..&model=flux&nologo=true`
- Oturum YOK, anahtar YOK, Cloudflare YOK. Anon katmanda tek sorun paylaşımlı
  havuzun "300 RPM" geçici 5xx'leri → kod 3 denemeye kadar backoff ile kendisi dener
  (`src/scrapers/directPollinations.js`).
- Canlı ölçüm (aynı gün): cache'li prompt ~0.5sn, taze 1024px ~3-45sn.
- Sağlayıcı seçimi (öncelik sırası): istek gövdesi `{"provider":"arena|pollinations"}` >
  `IMAGE_PROVIDER` env > varsayılan `arena` (eski davranış bozulmaz).
- Not: URL API'sinde negatif prompt yoktur (`negative_prompt_ignored: true` olarak
  meta'da işaretlenir); stil bilgisi prompt'a birleştirilir.
- Kozmetik: meta'da `provider`, `width/height`, `seed`, `final_url` döner; teslim
  biçimleri (`url|base64|file|both`) arena akışıyla birebir aynıdır.
- Sağlık: `/api/v1/health` içinde `image_provider` alanı; pollinations modunda
  readiness oturum dosyası kontrolü yapmaz (gereksiz kırmızılığı önler).

### 13.1) Seed-tier yükseltmesi (2026-09-16 akşamı) — filigransız + gerçek modeller

Pollinations anon katmanının canlı keşfi: **hangi modeli istediğiniz önemsiz** — flux/z-image-turbo
hepsi bayt-bayt AYNI "sana" 768px dosyasını döndürüyor ve sağ altta filigran var (`nologo` yok sayılıyor).
Çözüm: ücretsiz **seed anahtarı** (enter.pollinations.ai → GitHub ile giriş, kart yok):

- `POLLINATIONS_TOKEN=sk_...` verildiğinde servis yeni `gen.pollinations.ai/image` endpoint'ine
  `Authorization: Bearer` ile çıkar; anahtar asla URL'e yazılmaz (log/jobs cevaplarında sızmaz).
- `POLLINATIONS_MODEL=flux` (alias → `black-forest-labs/flux.1-schnell`) veya `z-image-turbo`.
  Test edildi: 1024×1024 gerçek çıktı, filigransız, ~8-15sn.
- **402 = bakiyesiz ücretli model** (Seedream 4.5, FLUX.2 Pro): tekrar DENENMEZ, hata mesajında
  ucuz modele dönme önerisiyle döner. **429/5xx = geçici** → 3 denemeye kadar backoff.
- Anahtarlı modda URL'ler dışarıya kapalıdır → `delivery:'url'` isteği otomatik `file`'a
  düşürülür (görsel zaten indirildiği için kayıp yok; `meta.delivery_note` açıklar).
- Anon kalmak isterseniz `POLLINATIONS_TOKEN` boş bırakın: eski davranış aynen korunur.

## 14) "auto" zincir + OVH yedeği (2026-09-16 gecesi)

Kotaya takılmamak için sağlayıcı sayısı ikiye çıktı ve hepsi tek çatı altında:

- **Yeni sağlayıcı `ovh`**: OVHcloud AI Endpoints, anon (anahtarsız) ücretsiz SDXL —
  canlı doğrulandı: 1024×1024 PNG, ~12-60sn, filigransız, kayıt/kart YOK (2 istek/dk anon).
- **Yeni mod `auto`** (`IMAGE_PROVIDER=auto` ya da istekte `{"provider":"auto"}`):
  `pollinations(seed) → ovh → pollinations-anon`. Bir halka 402/429/5xx/zaman aşımıyla
  düşünce sıradakine geçilir; sonuç `meta.fallback_attempts` dizisinde izlenir.
  Anahtar YOKSA sıra `ovh → pollinations-anon` olur (anon flux yerine SDXL tercih edilir).
- Boyut gerçeği: OVH API şeması 7 kova listeliyor ama servis **yalnız 1024x1024** kabul
  ediyor (400: "Only 1024x1024 size is currently supported"). 1:1 dışı oranlarda
  `meta.size_note` açıklaması eklenir.
- 401-in-canlı-test notu: bogus seed anahtarı → zincir `pollinations:401 → ovh:basarili`
  ile OVH'den döndü; gerçek çıktı /tmp'de 1.2MB PNG olarak görüldü.

## 16) Cloudflare Workers AI halkası (2026-09-17)

Ücretsiz katmanın kral taze keşfi: **her hesaba günlük 10.000 Neuron** (kalıcı, kart yok).

- `@cf/black-forest-labs/flux-1-schnell` 1024×1024 = 57.6 neuron → **~173 görsel/gün, ~1.4sn**
  (kod yolundan canlı kanıt: sandbox'tan 2026-09-17, 2.1sn, 687KB JPEG).
- API: `POST /client/v4/accounts/{ACCOUNT_ID}/ai/run/{MODEL}` Bearer; gövde yalnız `{prompt, steps}`
  (width/height/num_steps 400 verir); çıktı base64 JSON `{result:{image}}`; `success:false` taşınır.
- Gerekli env: `CF_API_TOKEN` + `CF_ACCOUNT_ID` (boşsa halka yok sayılır; doğrudan 'cloudflare'
  seçiminde net hata).
- Zincir: `pollinations(seed) → cloudflare → ovh → anon`. gpt-image-1-mini yine birinci
  önceliğin kalır; kotası biterse ~1.4sn'/173gün CF ağı devralır. Ayrıca `saglayici=cloudflare`
  doğrudan zorlanabilir.
- Testler: +6 (base64 parse, size_note, env-yok, success:false, zincir sırası, config) = 36/36.

## 15) model passthrough + yeni varsayılan: gpt-image-1-mini (2026-09-16 gecesi)

Bedava seed diliminde çalışan stüdyo kalitesi keşfedildi (canlı doğrulandı):

- **Yeni varsayılan `POLLINATIONS_MODEL=openai/gpt-image-1-mini`** — 1024×1024 ~25sn,
  fotoğraf kalitesi flux.1-schnell'den belirgin üstün; ücret minik (image-token başına
  kuruşun binde bini civarı — haftalık bedava damladan ~200+ görsel).
- Çalışan alternatifler (bedavada): `microsoft/mai-image-2.5-flash` (~18sn, kompozisyon iyi),
  `black-forest-labs/flux.1-schnell` (~8sn, en bol kota), `z-image-turbo` (~7sn).
- Ücretli bakiye isteyenler (402 döner): `openai/gpt-image-2.5-flare/sunburst`,
  `google/gemini-2.5-flash-image` (nano banana), gemini-3.x, topluluk `:paid` sürümleri —
  enter.pollinations.ai'den 5$ takviye ile açılır.
- **Request parametresi `model`** (ops., maks 160 karakter): `POST /api/v1/generate-asset`
  `{"model":"z-image-turbo", ...}` → sadece `pollinations` düğümünde geçerli; ovh/arena'da yok.
  Kural: istek modeli > `POLLINATIONS_MODEL` env'si > alias varsayılanı.
- Site köprüsünde de `&model=...` / POST `"model"` desteklenir (`/dokuman` güncel).
