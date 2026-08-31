# 🎵 Mp3 Apisi

Kendi kişisel müzik indirme REST API'si — her projeden çağırılabilir.

**3 motor, paralel arama:** YouTube (320kbps) + SoundCloud (turbo direkt mp3) + Archive.org

## 🔑 Key Sistemi

Ana sayfada (`/`) **🔑 Key Oluştur** butonu:
1. Key'e isim ver ("Discord botum", "Web sitem"…)
2. Sağlayıcı seç: ✨ Tümü / ▶️ YouTube / ☁️ SoundCloud / 📼 Archive.org
3. Key'i kopyala — bitir. **Keylerim** listesinde keylerin geçmişi her zaman durur, silinmez.

Her key sadece seçtiğin sağlayıcılara erişir. Sonra tüm çağrılara `?key=sk-...` ekle.

**Kalıcılık:** keyler GitHub'da `depolama` dalındaki `keys.json`'da saklanır — sunucu restart/redeploy etse bile keyler kaybolmaz (main dalına dokunulmaz, deploy tetiklenmez).

### Ortam değişkenleri (Render → Environment)
| Değişken | İş |
|---|---|
| `ADMIN_PAROLA` | Key oluşturma/silme yönetici şifresi (set edilmezse key oluşturma kapalı kalır) |
| `GITHUB_TOKEN` | Keyleri GitHub `depolama` dalına yazan PAT (set edilmezse keyler yalnız yerel dosyada — restart'ta silinebilir!) |
| `API_KEY` | (opsiyonel) her şeye erişen master key |

## ⚡ Performans Özellikleri

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
| GET | `/api/v1/search?q=...&key=` | 3 kaynakta paralel arama (~1 sn, varsayılan 20 / max 30 sonuç) |
| GET | `/api/v1/link?q=...&format=mp3\|mp4&key=` | **İndirmeden oynatma:** direkt CDN linki (JSON) — sunucu diske yazmaz |
| GET | `/api/v1/stream?q=...&key=` | **İndirmeden oynatma:** 302 → direkt link; `<audio>/<video src>` ile çalar |
| GET | `/api/v1/sozler?q=...&sanatci=...&key=` | Şarkı sözleri: düz + **senkron** (satır başına saniye — Spotify tarzı canlı söz) |
| GET | `/api/v1/instant?q=...&key=` | Ara + en iyi sonucu otomatik indir (tek çağrı) |
| POST | `/api/v1/convert` `{"url"}` | Seçili sonucu indir |
| GET | `/api/v1/status/{job_id}` | Yüzde, mesaj, `dosya_url` |
| GET | `/api/v1/file/{dosya}` | Mp3 dosyası (stream + Range) |
| POST | `/api/v1/keys/olustur` | `{isim, saglayicilar, parola}` |
| GET | `/api/v1/keys/liste?parola=` | Key geçmişi |
| POST | `/api/v1/keys/sil` | `{key, parola}` |

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
