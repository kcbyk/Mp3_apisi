# 🎵 Mp3 Apisi

Kendi kişisel müzik indirme REST API'si — her projeden çağırılabilir.

**3 motor, paralel arama:** YouTube (320kbps) + SoundCloud (turbo direkt mp3) + Archive.org

## Uç Noktalar

| Metot | Yol | İş |
|---|---|---|
| GET | `/` | Türkçe dokümantasyon sayfası |
| GET | `/api/v1/health` | Servis sağlığı |
| GET | `/api/v1/search?q=...&limit=8` | 3 kaynakta paralel arama (~1 sn) |
| GET | `/api/v1/instant?q=...` | Ara + en iyi sonucu otomatik indir (tek çağrı) |
| POST | `/api/v1/convert` | Seçili sonucu indir: `{"url": "...", "baslik": "..."}` |
| GET | `/api/v1/status/{job_id}` | Yüzde, mesaj, `dosya_url` |
| GET | `/api/v1/file/{dosya}` | Mp3 dosyası (stream + Range) |

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
