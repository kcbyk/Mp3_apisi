# 🎵 Mp3 Apisi

Kendi kişisel müzik indirme REST API'si — her projeden çağırılabilir.

**3 motor, paralel arama:** YouTube (320kbps) + SoundCloud (turbo direkt mp3) + Archive.org

## 🔑 Key Sistemi

Ana sayfada (`/`) **🔑 Key Oluştur** butonu:
1. Key'e isim ver ("Discord botum", "Web sitem"…)
2. Sağlayıcı seç: ✨ Tümü / ▶️ YouTube / ☁️ SoundCloud / 📼 Archive.org
3. Key'i kopyala — bitir. **Keylerim** listesinde keylerin geçmişi her zaman durur, silinmez.

Her key sadece seçtiğin sağlayıcılara erişir. Sonra tüm çağrılara `?key=sk-...` ekle.

**🤖 Arena (AI görsel):** Key oluştururken "Arena" çipini seçersen key AI görsel üretim uçlarına da
erişir (`/api/v1/arena/*`). Arena çipi seçilmemiş key'ler bu uçlarda 403 alır; mevcut müzik key'lerin
etkilenmez. Kurulum (Render'da arena-proxy servisi + oturum): **[ARENA_KURULUM.md](ARENA_KURULUM.md)**

**Kalıcılık:** keyler GitHub'da `depolama` dalındaki `keys.json`'da saklanır — sunucu restart/redeploy etse bile keyler kaybolmaz (main dalına dokunulmaz, deploy tetiklenmez).

### Ortam değişkenleri (Render → Environment)
| Değişken | İş |
|---|---|
| `ADMIN_PAROLA` | Key oluşturma/silme yönetici şifresi (set edilmezse key oluşturma kapalı kalır) |
| `GITHUB_TOKEN` | Keyleri GitHub `depolama` dalına yazan PAT (set edilmezse keyler yalnız yerel dosyada — restart'ta silinebilir!) |
| `API_KEY` | (opsiyonel) her şeye erişen master key |

## ⚡ Performans Özellikleri

- **⚡ Global Persistent Session (Connection Pooling):** Tüm HTTP istekleri DNS/TLS el sıkışmalarını tekrar kullanır; polling ve API gecikmeleri minimuma iner.
- **⚡ Zero-Wait Streaming Pipe (`/download`):** Sunucu diske yazıp bitmesini beklemeden medya akışını 1. saniyeden itibaren doğrudan kullanıcıya pipe eder.
- **⚡ Fast-Start Adaptif Polling:** Dönüştürme işlemleri 2 sn beklemek yerine 0.25 sn aralıklarla kontrol edilir; 1-2 saniyede biten dönüşümler anında yakalanır.
- **⚡ 1 MB I/O Buffer:** Disk ve ağ aktarımları 64 KB yerine 1 MB chunk'larla yapılarak dosya indirme süresi %40-60 kısaltılır.
- **⚡ RAM Önbelleği:** `kutuphane.json` ve `client_id` gibi sık erişilen veriler bellekte tutulur, gereksiz disk I/O ve alt süreç (`ffprobe`) çağrıları önlenir.
- **Arama önbelleği:** aynı sorgu 15 dk boyunca anında döner (yanıtta `onbellek: true`)
- **Kalite seçimi:** `&kalite=128|192|320` (instant/convert; YouTube motoru, varsayılan 320)
- **Otomatik disk temizliği:** dosya karşıya yollandıktan ~90 sn sonra kendiliğinden silinir; dosya ömrü en fazla 30 dk; disk 150 MB / 80 dosya sınırını geçemez → **sunucu asla dolmaz**
- **Aynı şarkıya ketlenme:** indirme sırasında gelen ikinci istek aynı işe bağlanır
- **🔔 Nöbetçi:** GitHub Actions 10 dk'da bir health check eder; API 3 denemede de ölüyse repoya otomatik sorun açar (`.github/workflows/nobetci.yml`) — bu arada Render'ı sıcak da tutar

Ayar env'leri (opsiyel): `SARKI_CACHE_TTL`, `SARKI_DOSYA_OMUR`, `SARKI_TESLIM_GECIKME`, `SARKI_DISK_MB`, `SARKI_MAX_DOSYA`, `SARKI_TEMIZLIK_DONGU`

## Uç Noktalar

| Metot | Yol | İş |
|---|---|---|
| GET | `/` | Key oluşturma arayüzü |
| GET | `/dokuman` | Detaylı dokümantasyon |
| GET | `/api/v1/health` | Servis sağlığı |
| GET | `/api/v1/search?q=...&key=` | 3 kaynakta paralel arama (~0.7 sn, varsayılan 20 / max 30 sonuç) |
| GET | `/api/v1/download?q=...&key=` | **⚡ Ultra Hızlı İndirme:** Diske yazmayı beklemeden anında stream pipe indirme |
| GET | `/api/v1/link?url=...&format=mp3\|mp4&key=` | **İndirmeden oynatma:** direkt CDN linki (JSON) — YouTube/SC/IA/**TikTok (watermark'sız)** |
| GET | `/api/v1/stream?q=...&key=` | **İndirmeden oynatma:** 302 → direkt link; `<audio>/<video src>` ile çalar |
| GET | `/api/v1/web?q=...&limit=10&key=` | **Genel web arama** (Google-CSE tarzı, anahtarsız) — DuckDuckGo zinciri |
| GET | `/api/v1/web?q=...&detay=1&key=` | **RAG modu:** ilk 3 sonucun sayfa metni de döner (LLM'e hazır) |
| GET | `/api/v1/oku?url=...&karakter=6000&key=` | **Sayfa → temiz metin** (jina reader — özetleme/analiz için) |
| GET | `/api/v1/kapak?q=...&key=` | **Albüm kapağı** (Spotify kalitesi+) — iTunes→Deezer→CAA→YT zinciri, boyut doğrulamalı |
| GET | `/api/v1/sozler?q=...&sanatci=...&key=` | Şarkı sözleri: düz + **senkron** (satır başına saniye — Spotify tarzı canlı söz) |
| GET | `/api/v1/instant?q=...&key=` | Ara + en iyi sonucu otomatik indir (tek çağrı) |
| POST | `/api/v1/convert` `{"url"}` | Seçili sonucu indir |
| GET | `/api/v1/status/{job_id}` | Yüzde, mesaj, `dosya_url` |
| GET | `/api/v1/file/{dosya}` | Mp3 dosyası (stream + Range) |
| POST | `/api/v1/keys/olustur` | `{isim, saglayicilar, parola}` |
| GET | `/api/v1/keys/liste?parola=` | Key geçmişi |
| POST | `/api/v1/keys/sil` | `{key, parola}` |
| GET | `/api/v1/arena/gorsel?prompt=...&mod=url\|json\|indir\|base64&key=` | **🤖 AI görsel üretimi** (arena-proxy köprüsü) — `oran`, `stil`, `negatif`, `bekleme=0` (asenkron) |
| POST | `/api/v1/arena/gorsel` | Aynı uç, JSON gövdesiyle |
| GET | `/api/v1/arena/durum?key=` | Arena köprüsü bağlantı/sağlık durumu |
| GET | `/api/v1/arena/sonuc/{is_id}?key=` | Asenkron üretim işinin durumu |

> İlk key oluşturulana kadar API açıktır; ilk key'ten sonra tüm uçlar geçerli key ister.

## Hızlı Kullanım

```bash
# 1) Anında şarkı — arama + indirme tek çağrıda
curl "https://SUNUCU/api/v1/instant?q=tarkan kuzu kuzu"
# → {"ok":true,"job_id":"eb3dae5918","secilen":{...}}

# 2) Durum (yüzdeyi takip et)
curl "https://SUNUCU/api/v1/status/eb3dae5918"
# → {"ok":true,"durum":"bitti","yuzde":100,"dosya_url":"/api/v1/file/....mp3"}

# 3) Dosyayı al
curl -LO "https://SUNUCU/api/v1/file/TARKAN%20-%20Kuzu%20Kuzu.mp3"
```

Doğrudan URL olarak da çalabilir: `<audio src=".../api/v1/file/....mp3">`

## Kendi Sunucunda Çalıştır

```bash
pip install -r requirements.txt
python api.py            # varsayılan port 7900
PORT=8080 python api.py  # istersen PORT env ile değiştir
```

> ffmpeg gerekmez: YouTube dönüşümü bulut motorlarından (ruvs.in → loader.to yedekli), SoundCloud progressive mp3 direkt indirir.

## Bedava Barındırma (Render.com)

1. [render.com](https://render.com) → **New → Web Service** → bu repo'yu bağla
2. Build: `pip install -r requirements.txt` · Start: `python api.py` · Plan: **Free**
3. Bitince kalıcı URL'n hazır: `https://mp3-apisi.onrender.com`
4. Ücretsiz plan uyuyor → [cron-job.org](https://cron-job.org) ile `/api/v1/health`'i 10 dk'da bir pinglet

Bu repodaki `render.yaml` sayesinde Render "Blueprint" ile tek tıkla da kurulur.

## Güvenlik

API'yi dışarıya açmadan önce kök dizine `api_key.txt` oluştur, içine uzun bir anahtar yaz → tüm uçlar `?key=ANAHTAR` veya `X-API-Key` başlığı olmadan çalışmaz.

## Yapı

```
api.py            → Flask REST API + dokümantasyon sayfası
api_core.py       → framework bağımsız çekirdek (ara/indir/durum/dosya)
telegram_bot.py   → indirme motorları (YT/SC/IA) + Telegram botu (ayrı çalışır)
```

> `bot_token.txt` (Telegram) ve `api_key.txt` `.gitignore`'da — asla pushlanmaz.

---

## ⚡ v5 — Web arama hızı, görsel arama ve vizyon (2026-11)

### Ne değişti?

| Konu | Önce | Sonra |
|---|---|---|
| `/api/v1/web` süre | 45-70 sn (sıralı zincir, çoğu sorguda **boş**) | **0.2 - 2 sn** (paralel yarış) |
| Boş sonuç | Türkçe sorgularda sık | Boş dönmez: sorgu sadeleştirilir, sonuç bulunamazsa `uyari` döner |
| Görsel | Yok | `&gorsel=1` ile aynı yanıtta görseller + `/api/v1/gorsel-ara` |
| Görsel üretimi | arena-proxy 429 → tamamen ölü | arena-proxy + **doğrudan Pollinations yedeği** |
| LLM | Sadece metin | **`gorsel` parametresi ile fotoğraf görebiliyor** (`@cf/google/gemma-3-12b-it`) |
| POST'ta key | Yalnız `?key=` / `X-API-Key` | JSON gövdesinde `{"key": ...}` de kabul ediliyor |

### Yeni dosya: `web_motor.py`

Eski motor (`telegram_bot.web_ara`) motorları **sırayla** deniyordu:

```
DDG-lite (20s) → jina (35s) → ddgs → Wikipedia (15s)   = 45-70 sn, sık sık boş
```

Yeni motor (`web_motor.py`) hepsini **paralel** yarıştırır, ilk **alakalı** sonucu veren kazanır
ve tüm istek için **tek bir bütçe** vardır (`WEB_BUTCE`, varsayılan 4 sn; `WEB_TOPLAM_BUTCE` 6.5 sn).

```
bing-rss ⭐ 0.15s | bing | wikipedia | google-news | ddg-lite | bing-jina | ddg-jina
```

- **Alaka puanı**: gelen sonuç sorguyla gerçekten ilgili mi? (veri merkezi IP'lerine servis
  edilen reklam/çöp sayfaları elenir — bu yüzden bazen "0 sonuç + uyarı" döner, çöp dönmez.)
- **10 dk önbellek**: aynı sorgu ikinci kez ≈0.001 sn.
- **Sorgu sadeleştirme**: sonuç yoksa/alakasızsa "kelime kırpa kırpa" tekrar dener.

### 🔑 Kalıcı kalite: anahtarlı sağlayıcı (isteğe bağlı)

Anahtarsız motorlar veri merkezi IP'lerinde zaman zaman kısıtlanıyor. Render →
Environment'a **birini** eklersen o sağlayıcı ilk sıraya geçer ve kalite kalıcı düzelir:

| Değişken | Sağlayıcı | Ücretsiz kota |
|---|---|---|
| `BRAVE_KEY` | Brave Search API | 2.000 sorgu/ay |
| `SERPER_KEY` | serper.dev (Google) | 2.500 sorgu |
| `TAVILY_KEY` | Tavily (LLM'e hazır) | 1.000 sorgu/ay |
| `GOOGLE_CSE_KEY` + `GOOGLE_CSE_CX` | Google Programmable Search | 100/gün |

### Yeni uçlar

```bash
K=sk-...; B=https://mp3-apisi.onrender.com

# 1) metin + görsel TEK çağrıda (AI asistanları için)
curl -s "$B/api/v1/web?q=galata%20kulesi&limit=5&gorsel=1&key=$K"
# → {ok, sonuclar:[...], gorseller:[{baslik, gorsel, kucuk, genislik, yukseklik, site, kaynak}], gorsel_motor}

# 2) sadece görsel arama
curl -s "$B/api/v1/gorsel-ara?q=kızıl%20tilki&limit=8&key=$K"

# 3) web motoru sağlığı
curl -s "$B/api/v1/web/durum?key=$K"

# 4) 🖼️ FOTOĞRAF GÖRME (vizyon)
curl -s "$B/api/v1/sohbet?mesaj=bu%20görselde%20ne%20var&gorsel=https://site.com/foto.jpg&key=$K"
# → {ok, cevap:"...", gorsel_goruldu:true, model:"@cf/google/gemma-3-12b-it"}
```

### Yeni ortam değişkenleri (hepsi isteğe bağlı)

| Değişken | Varsayılan | Açıklama |
|---|---|---|
| `WEB_BUTCE` | 4 | ilk arama turu için üst süre (sn) |
| `WEB_TOPLAM_BUTCE` | 6.5 | sadeleştirme dahil toplam tavan (sn) |
| `WEB_CACHE_TTL` | 600 | arama önbelleği (sn) |
| `WEB_JINA` | https://r.jina.ai/ | jina reader adresi |
| `ARENA_YEDEK` | 1 | arena-proxy ölüyse Pollinations'a doğrudan geç |
| `POLLINATIONS_TOKEN` | — | görsel üretim kotasını artırır |

### Bilinen sınırlar

- **Görsel üretimi** anahtarsız katmanda IP başına 45 sn'de 1 görsel (Pollinations ücretsiz
  limiti). `POLLINATIONS_TOKEN` veya çalışan bir arena-proxy ile artar.
- **Vizyon**: sırayla `gemma-3-12b-it` → `llama-4-scout-17b-16e-instruct` → `llava-1.5-7b-hf`
  denenir; hesapta hangisi etkinse o kullanılır. Hiçbiri yoksa uç metin modeline düşer ve
  yanıtta `gorsel_goruldu:false` + `uyari` + `vizyon_hatalari` döner (fotoğraf GÖRÜLMEDİ).

---

## 🖼️ v5.1 — `/api/v1/web` artık VARSAYILAN olarak görsel döndürür

Önceki sürümde görseller yalnızca `&gorsel=1` verilince geliyordu ve metin
sonuçlarında `og:image` alanı **hiç yoktu**. İkisi de düzeltildi.

### Yanıt sözleşmesi (görsel alanları)

**Her metin sonucunda** (sayfanın kendi görseli):

| Alan | Açıklama |
|---|---|
| `image_url` | Sayfanın ana görseli (og:image / twitter:image / image_src) |
| `thumbnail_url` | Küçük görsel (galeri eşleşmesi varsa ondan) |
| `og_image` | Ham `og:image` değeri |
| `gorsel_genislik` / `gorsel_yukseklik` | Görsel boyutu (meta'dan) |
| `fotografci` | `author` / `article:author` / `dc.creator` meta'larından |
| `gorsel_kaynak` | `og:image` ya da `galeri:<motor>` |

**`gorseller` dizisinde** (fotoğraf galerisi — Wikimedia + DuckDuckGo **harmanı**):

| Alan | Açıklama |
|---|---|
| `gorsel` | Tam boy görsel (DDG thumbnail'ları 1600px'e yükseltilir) |
| `kucuk` | Thumbnail (grid/liste için) |
| `genislik` / `yukseklik` | Gerçek piksel boyutu |
| `baslik` | Başlık / alt metni |
| `site` + `site_domain` | Görselin bulunduğu sayfa ve alan adı |
| `lisans` | Wikimedia lisansı (CC BY-SA 4.0 gibi) — künye için |
| `fotografci` | Wikimedia sanatçı/atıf bilgisi |
| `kaynak` | `wikimedia` · `duckduckgo` · `wikipedia-tr` |

### Örnek

```bash
curl -s "$B/api/v1/web?q=BMW+M4+photos&detay=1&key=$K"
```

```json
{
  "ok": true, "q": "BMW M4 photos", "motor": "bing-rss",
  "adet": 10, "gorselli_sonuc": 1,
  "sonuclar": [{ "baslik": "...", "url": "...", "ozet": "...",
                 "image_url": "https://...jpg", "thumbnail_url": "https://...jpg",
                 "og_image": "https://...jpg", "gorsel_genislik": 1200,
                 "gorsel_yukseklik": 600, "fotografci": "Andrew Wendler",
                 "gorsel_kaynak": "og:image", "metin": "..." }],
  "gorseller": [
    {"baslik":"BMW M4 F82.jpg","gorsel":"https://upload.wikimedia.org/.../BMW_M4_F82.jpg",
     "kucuk":"https://thumb.wikimedia.org/.../1280px-BMW_M4_F82.jpg",
     "genislik":2151,"yukseklik":1092,"kaynak":"wikimedia",
     "lisans":"CC BY-SA 2.0","fotografci":"Alexandre Prévot from Nancy, France",
     "site":"https://commons.wikimedia.org/wiki/File:BMW_M4_F82.jpg"},
    {"baslik":"2025 BMW M4 CS Exterior Photos","gorsel":"https://tse4.mm.bing.net/...&w=1600&h=900&qlt=100",
     "genislik":1920,"yukseklik":1080,"kaynak":"duckduckgo",
     "site":"https://carbuzz.com/cars/bmw/m4-cs/2025/photos-exterior/",
     "site_domain":"carbuzz.com"}
  ],
  "gorsel_adet": 12, "gorsel_motor": "wikimedia+duckduckgo",
  "sure_sn": 2.86
}
```

### Neden bazı sonuçlarda `image_url` boş?

Fotoğraf siteleri (Unsplash 401, Pexels/Edmunds 403) veri merkezi IP'lerinden gelen
istekleri engelliyor; og:image okunamıyor. Bu durumda:

1. Galeri görsellerinden **aynı alan adına** ait olan varsa `image_url` ondan doldurulur
   (`gorsel_kaynak: "galeri:duckduckgo"`).
2. Hiçbiri yoksa alan boş bırakılır — **alakasız bir fotoğraf iliştirilmez.**
   Galeri (`gorseller`) ise her durumda dolu gelir.

### Performans

| İstek | Süre |
|---|---|
| `gorsel=0` (sadece metin) | 0.9-1.5 sn |
| varsayılan (metin + 12 görsel) | 1.5-3.5 sn |
| `detay=1` (+3 sayfa metni, jina) | +3-6 sn |
| önbellek | 0.2 sn |
