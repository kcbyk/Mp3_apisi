# Test Raporu — arena-proxy

**Tarih:** 2026-09-16 · **Sürüm:** 1.0.0 · **Node:** v20.20.2 · **Chromium:** headless shell 153

## Özet

| Test paketi | Sonuç | Süre |
|---|---|---|
| `npm test` — entegrasyon (gerçek Chromium, sahte hedef platform) | **4/4 geçti** | 9.0 sn |
| `npm run smoke` — canlı API sözleşmesi | **6/6 geçti** | ~12 sn |
| API test paketi (auth, validasyon, teslim modları, async, metrik) | **16/16 geçti** | 27 sn |
| **TOPLAM** | **26/26** | — |

---

## 1. Entegrasyon testleri — `npm test`

Sahte hedef platform (`tests/fakeTargetServer.js`) üzerinden **gerçek Chromium** ile tam akış:

```
✔ uçtan uca: prompt → tıkla → CDN URL yakala → indir → diske yaz   (2.6 sn)
✔ buffer/context havuzu: ikinci istek context yeniden kullanır     (1.9 sn)
✔ eşzamanlılık: 3 istek kuyrukta hata vermeden işlenir             (3.7 sn)
✔ validation: prompt yoksa 400 sınıfı hata                         (0.001 sn)
```

Doğrulananlar: parametrelerin forma gerçekten yazıldığı (regresyon), CDN URL yakalama,
indirilen içeriğin `sha256` doğrulaması, context yeniden kullanımı, kuyruk davranışı.

## 2. Canlı API smoke testi — `npm run smoke`

```
✅ GET /health → 200                        ✅ POST /generate-asset → validation hatası (400)
✅ POST /generate-asset auth zorunlu        ✅ POST /generate-asset → geçerli istek
✅ GET /debug/selectors → istatistik        ✅ GET /metrics → sayaçlar
```

## 3. API test paketi (uçtan uca, canlı servis)

Servis `DRY_RUN=false` + `SESSION_MODE=profile` (kalıcı profil) modunda çalışırken:

| # | Test | Sonuç | Detay |
|---|---|---|---|
| 1 | Anahtarsız istek → 401 | ✅ | `UNAUTHORIZED` |
| 2 | Geçersiz anahtar → 403 | ✅ | `FORBIDDEN` |
| 3 | Boş prompt → 400 | ✅ | `VALIDATION_ERROR` |
| 4 | Geçersiz `aspect_ratio` → 400 | ✅ | şema doğrulaması |
| 5 | Senkron üretim | ✅ | **7 428 ms**, 3.23 MB PNG |
| 6 | Context havuzdan yeniden kullanım | ✅ | `reused_context: true`, aynı `ctx-id` |
| 7 | CDN/S3 yolundan yakalama | ✅ | `network:json(http://127.0.0.1:9099/api/generate)` |
| 8 | `sha256` + `bytes` döndü | ✅ | 64 hane hex |
| 9 | `execution_time_ms` raporlandı | ✅ | 7 425 ms |
| 10 | `delivery=base64` | ✅ | 4 521 628 karakter base64 |
| 11 | `async=true` → 202 + `job_id` | ✅ | kuyruğa alındı |
| 12 | Asenkron iş tamamlandı | ✅ | `status: succeeded`, sonuç görsel içeriyor |
| 13 | Selector strateji raporu | ✅ | `consentBanner(5)`, `promptInput(5)`, `aspectRatioSelect(5)` |
| 14 | Metrikler tutarlı | ✅ | 7 istek / 7 başarılı / 0 hata |
| 15 | 2 paralel istek kuyrukta | ✅ | ikisi de 6 257 ms içinde tamamlandı |
| 16 | Teslim edilen dosya HTTP'den erişilebilir | ✅ | HTTP 200, `image/png`, 3 391 221 byte |

### Bütünlük doğrulaması (en kritik kontrol)

```
CDN kaynağı sha256  : 80018e3909e02d46174c7f57d073358b921adc99694f8eb39691ad6724bfbc29
API'ye dönen sha256 : 80018e3909e02d46174c7f57d073358b921adc99694f8eb39691ad6724bfbc29
HTTP indirmesi      : 80018e3909e02d46174c7f57d073358b921adc99694f8eb39691ad6724bfbc29
Görsel boyutu       : 1672×941 px · 3.23 MB
```

Üç kaynakta da aynı hash → **yakalama → indirme → teslim zinciri bayt-birebir doğru**.

## 4. Performans gözlemleri

| Metrik | Değer |
|---|---|
| Adım süreleri | `navigate` 552 ms · `consent` 772 ms · `aspect_ratio` 28 ms · `style` 25 ms · `prompts` 11 812 ms\* · `click_generate` 735 ms · `capture_artifact` 2 006 ms |
| Gecikme p50 / p90 | 7 425 ms / 16 058 ms |
| Açılan context / geri dönüşen | 2 / 0 (havuz çalışıyor, gereksiz context açılmadı) |
| Node RSS | 129 MB |
| Chromium (PSS, 19 süreç) | 325 MB |
| Toplam sistem kullanımı | 460 MB (2 GB makinede %23) |

\* `prompts` adımı yüksek çünkü `HUMANIZE=true` — insan benzeri karakter bazlı yazma (bot tespitini
azaltmak için bilinçli). `HUMANIZE=false` ile aynı adım **~300 ms**'ye düşer.

---

## 5. Önemli not: Demo modu

Bu testler **gerçek `arena.ai` hesabına oturum açmadan** çalıştırıldı. İki mod kullanıldı:

1. **Sahte hedef platform** (`scripts/fakeTarget.js` → `http://127.0.0.1:9099`): arena.ai'nin
   davranışını taklit eder (prompt alanı, Generate butonu, JSON API, CDN'den görsel servisi).
   Servis bu hedefe `TARGET_BASE_URL` ile yönlendirildi; kod yolu **üretimdekiyle tamamen aynı**
   (gerçek Chromium, stealth, context havuzu, yakalama, indirme).

2. **`DRY_RUN=true`**: tarayıcı hiç açılmaz, fixture görsel döner (CI/sözleşme doğrulaması).

Gerçek kullanım için gereken tek şey oturum kaydı:

```bash
# .env → DRY_RUN=false, TARGET_BASE_URL=https://arena.ai
npm run session:save        # görünür tarayıcıda bir kez giriş yap (bkz. SESSION_GUIDE.md)
npm start
```

`arena.ai`'nin canlı DOM'u farklıysa `GET /api/v1/debug/selectors` + `npm run session:inspect`
ile selector kayıt defteri güncellenir; kod değişmez.

## 6. Köpek balığı üretimi (talep edilen test çıktısı)

**İstek:**

```json
POST /api/v1/generate-asset
{
  "prompt": "okyanusta süzülen büyük beyaz köpek balığı, altın saat ışığı, sinematik geniş açı, 4k",
  "negative_prompt": "blurry, text, watermark, low quality",
  "aspect_ratio": "16:9",
  "style": "photographic"
}
```

**Yanıt (özet):**

```json
{
  "success": true,
  "image_url": "http://localhost:8080/files/artifacts/2026-09-16_80018e3909e0_b2cd71d3-547e-4d8e.png",
  "bytes": 3391221,
  "sha256": "80018e3909e02d46174c7f57d073358b921adc99694f8eb39691ad6724bfbc29",
  "delivery": "file",
  "captured_from": "network:json(http://127.0.0.1:9099/api/generate)",
  "execution_time_ms": 16058,
  "meta": {
    "steps": { "navigate": 552, "consent": 772, "prompts": 11812, "click_generate": 735, "capture_artifact": 2006 },
    "candidates": [{ "url": "…/cdn/asset-…png?w=1792&h=1008&sig=fake", "score": 13, "source": "network:json(…)" }],
    "reused_context": true
  }
}
```

**Çıktı dosyası:** `../kopek-baligi-uretim.png` (1672×941, 3.23 MB)

---

## 7. Testte bulunup düzeltilen hatalar (bu oturumda)

| # | Hata | Etki | Düzeltme |
|---|---|---|---|
| 1 | `_createEntry` içinde `ReferenceError: context is not defined` | Tarayıcı hiç açılamıyordu (tüm üretim 500) | `entry.context` üzerinden kapsam düzeltmesi |
| 2 | `normalizeParams` çift çağrıda `aspect_ratio`'yu `1:1`'e düşürüyordu | Sessiz parametre kaybı | İdempotent normalizasyon (snake_case + camelCase) + regresyon testi |
| 3 | `selectOption` eşleşmeyince 20 sn varsayılan timeout bekliyordu | `style` adımı 20 018 ms → akış 22.6 sn | Seçenekleri önce okuyup eşleştiren yardımcı fonksiyon → **2.6 sn** |
| 4 | p-queue'nun `unref` edilmeyen interval zamanlayıcısı süreç kapanışını asıyordu | Testler 121 sn'de bitiyordu | Kendi iptal edilebilir kayan-pencere hız sınırlayıcısı → **9 sn** |
| 5 | `persistArtifact` yol dışı dosya için bozuk public URL üretiyordu | `delivery=file` çıktısı erişilemez URL | `/files/artifacts/<basename>` eşlemesi |
| 6 | Session yokken her dakika WARN logu | Log gürültüsü | Tek seferlik bilgilendirme |

## 8. Bilinen sınırlar

- **Canlı arena.ai doğrulaması yapılmadı** (oturum gerektirir). DOM farklıysa selector
  kayıt defterinin güncellenmesi gerekir — mimari bunun için tasarlandı.
- Tek process / in-memory job store. Yatay ölçekleme için `jobStore`'un Redis'e taşınması gerekir.
- `MAX_CONTEXTS=3` varsayılanı ~325 MB Chromium + ~130 MB Node demektir; 2 GB'lık sunucu için uygundur.
