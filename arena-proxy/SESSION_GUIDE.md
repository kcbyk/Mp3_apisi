# Cookie / Session Aktarım Rehberi

Bu servis, hedef platformdaki **senin oturumunla** çalışır. Bu yüzden servis çalışmaya
başlamadan önce oturumun bir kez kaydedilmesi gerekir. Bu rehber üç yöntemi, oturumun neden
bozulduğunu ve nasıl tazeleneceğini anlatır.

```
Kaydetme (bir kez)  →  data/sessions/arena.json  →  Servis her context'e enjekte eder
        ↑                                                          ↓
   cookie expire                   oturum düşerse: 503 SESSION_INVALID
        └─────────────  POST /api/v1/session/import  ←──┘
```

---

## 0. Özet (en kısa yol)

```bash
# 1) Görünür tarayıcı açılır, ELLE giriş yap (şifre/OAuth/2FA sorun değil)
npm run session:save

# 2) Doğrula
curl -s localhost:8080/api/v1/debug/session-preview -H 'x-api-key: dev-key-change-me' | head -30

# 3) Servis çalışırken tazelemek için (opsiyonel)
#    data/sessions/arena.json içeriğini POST et:
#    POST /api/v1/session/import   (gövde: storageState JSON)
```

> Oturum kaydı sırasında **hangi makinede giriş yaptıysan**, servis de o ortamda
> (aynı UA, mümkünse aynı IP) çalışmalı. Aksi halde platform oturumu düşürür.

---

## 1. Yöntem A — `npm run session:save` (önerilen)

```bash
npm run session:save                       # .env'deki TARGET_BASE_URL ile
npm run session:save -- --url https://arena.ai/image --out data/sessions/arena.json --check
```

Akış:

1. Görünür Chromium açılır (headless değil — bot kontrolü için gerekli).
2. Platforma **normal şekilde** giriş yaparsın: kullanıcı adı/şifre, Google OAuth, e-posta
   linki, 2FA — hepsi olur. Gerekirse sayfayı gezinip üretim aracını bir kez aç (bazı
   platformlar `localStorage` durumunu o anda yazar).
3. Terminale dönüp **ENTER**'a basarsın.
4. Cookie'ler + `localStorage` (per-origin) `data/sessions/arena.json` dosyasına
   `Playwright storageState` formatında, **0600 izniyle** yazılır.
5. Script özet verir: cookie sayısı, oturum benzeri cookie adları, `cf_clearance` var mı.

Faydalı bayraklar:

| Bayrak | Etki |
|---|---|
| `--out <path>` | Çıktı dosyası (varsayılan `.env` → `SESSION_STATE_PATH`) |
| `--url <url>` | Giriş yapılacak adres |
| `--check` | Kaydetmeden önce "hâlâ giriş ekranı mı?" kontrolü |
| `--wait <sn>` | ENTER beklemeden N saniye sonra otomatik kaydet |
| `--profile` | `storageState` yerine kalıcı Chrome profili kullan (`PERSISTENT_PROFILE`) |
| `--headless` | Görünmez mod (yalnızca cookie'yi başka yolla aldıysan anlamlı) |

**Ne kaydedilir?** Örnek şema:

```json
{
  "cookies": [
    { "name": "session", "value": "…", "domain": "arena.ai", "path": "/",
      "expires": 1790000000, "httpOnly": true, "secure": true, "sameSite": "Lax" },
    { "name": "cf_clearance", "value": "…", "domain": ".arena.ai", "path": "/",
      "expires": 1790003600, "httpOnly": true, "secure": true, "sameSite": "None" }
  ],
  "origins": [
    { "origin": "https://arena.ai", "localStorage": [ { "name": "auth_token", "value": "…" } ] }
  ]
}
```

---

## 2. Yöntem B — Tarayıcı eklentisiyle cookie export (zaten login'liysen)

1. Kullandığın tarayıcıda hedef platforma giriş yap.
2. **Cookie-Editor** (Chrome/Firefox) eklentisiyle `Export → JSON` yap (EditThisCookie de olur).
3. Çıkan diziyi dosyaya yaz:

```bash
# Dosya formatı önemli değil — servis otomatik normalize eder:
#   • Cookie-Editor dizisi:  [ {name, value, domain, ...}, ... ]
#   • { "cookies": [ ... ] }
#   • Netscape cookies.txt (sekme ile ayrılmış satırlar)
cat > data/sessions/arena.json
#   ... yapıştır, Ctrl-D
```

4. `GET /api/v1/debug/session-preview` ile kontrol et: cookie adları görünmeli,
   `expires_in_s` negatif olmamalı.

> ⚠️ Eklenti export'ları `localStorage` içermez. Platform oturumu tamamen `localStorage`
> üzerinde tutuyorsa Yöntem A'yı kullan (o yöntem `origins[].localStorage`'ı da kaydeder).
> Alternatif: DevTools → Application → Local Storage içeriğini elle ekle:
> `{ "origins": [ { "origin": "https://arena.ai", "localStorage": [ { "name": "…", "value": "…" } ] } ] }`

---

## 3. Yöntem C — Kalıcı profil (`SESSION_MODE=profile`)

Bazı platformlar cookie'yi her istekte döndürür ve/veya `IndexedDB` gibi storageState'in
kapsamadığı alanları kullanır. Bu durumda:

```bash
cp .env.example .env
# .env:
#   PERSISTENT_PROFILE=true
#   SESSION_MODE=profile
#   PROFILE_BASE_DIR=./data/profiles

npm start                     # profil dizinleri data/profiles/ctx-* altında oluşur
```

İlk oturum için ya `npm run session:save -- --profile` (girişi yaptıktan sonra profili bırakır)
ya da headless'ı geçici olarak kapatıp (`BROWSER_HEADLESS=false xvfb-run -a npm start`) ilk
isteği elle login penceresiyle geçersin. Profil diske yazıldığı için oturum servis yeniden
başlasa da kalır.

---

## 4. Oturumun bozulma nedenleri (ve çözümleri)

| Neden | Belirti | Çözüm |
|---|---|---|
| **IP değişimi** | Ani logout, challenge döngüsü | Session'ı kaydettiğin IP ile servis IP'sini eşleştir; proxy kullanıyorsan sabitle |
| **User-Agent uyuşmazlığı** | Cloudflare loop, cookie reddi | `.env → USER_AGENT` kayıt anındaki UA ile aynı olmalı |
| Cookie süresi doldu | `SESSION_INVALID` | `npm run session:save` → `POST /session/import` |
| Platform "cihaz" parmak izini değiştirdi | Rastgele logout | `LOCALE`, `TIMEZONE`, `VIEWPORT_*` değerlerini kayıt anıyla aynı tut |
| Şifre/oturum değişikliği | Sürekli 401/redirect | Yeniden giriş + yeni session |
| Aynı hesapla eşzamanlı çok oturum | Bir oturum düşer | `MAX_CONTEXTS=1` deneyin veya hesapları ayırın |

---

## 5. Servis çalışırken oturum tazeleme (sıfır kesinti)

Servis, session dosyasını periyodik olarak (`SESSION_RELOAD_INTERVAL_MS`) izler. Dosya
değiştiğinde `version` artar ve havuzdaki context'ler sıradaki istekte geri dönüştürülür.
İki yol var:

```bash
# A) Dosyayı yerinde güncelle (script ile aynı makinede çalışıyorsan)
npm run session:save -- --out data/sessions/arena.json
#    → izleyici dosyayı algılar, sonraki istekler yeni cookie ile döner

# B) Uzak makineden/yeni cookie'yi HTTP ile gönder
curl -X POST http://localhost:8080/api/v1/session/import \
  -H 'content-type: application/json' -H 'x-api-key: dev-key-change-me' \
  --data-binary @data/sessions/arena.json
# → { "success": true, "imported_cookies": 12, "session_version": 4 }
```

Doğrulama:

```bash
curl -s localhost:8080/api/v1/debug/session-preview -H 'x-api-key: dev-key-change-me'
curl -s localhost:8080/health | python3 -m json.tool | grep -A6 '"session"'
```

---

## 6. Güvenlik

- `data/sessions/*.json` **parola kadar değerlidir**: içindeki cookie ile hesaba girilebilir.
  - `.gitignore` bu dizini dışlar — yine de commit öncesi `git status` kontrol et.
  - Dosya izni 0600; paylaşılan makinede `chmod 600 data/sessions/*.json`.
  - Üretimde dosyayı secret manager'dan (Vault/AWS SM/Docker secret) container'a mount et:
    `.env → SESSION_STATE_PATH=/run/secrets/arena_session.json`
- `SESSION_STATE_PATH` dosyasını asla bir web sunucusuyla servis etme; bu servis yalnızca
  `/files/artifacts` ve `/files/fixtures` dizinlerini açar, `data/sessions` dışarı kapalıdır.
- Loglar cookie değerlerini **maskeler** (pino `redact`), `/debug/session-preview` yalnızca
  ad + süre + maskeli önizleme döner.
- Oturum çalındığından şüphelenirsen: platformda "tüm cihazlardan çıkış" yap ve yeni session kaydet.

---

## 7. Hızlı sorun giderme kontrol listesi

```bash
# 1) Dosya var mı ve geçerli mi?
ls -l data/sessions/arena.json
python3 -m json.tool < data/sessions/arena.json > /dev/null && echo "JSON geçerli"

# 2) Servis ne görüyor?
curl -s localhost:8080/health -H 'x-api-key: dev-key-change-me' | python3 -m json.tool | head -25

# 3) Login wall var mı, selector'lar tutuyor mu? (gerçek sayfayı açar)
npm run session:inspect

# 4) Hâlâ 503 mü?
grep -n "SESSION_INVALID" /var/log/arena-proxy.log   # ya da docker logs
```

`SESSION_INVALID` ısrar ediyorsa sırayla: **yeni session kaydet → `session/import` →
`USER_AGENT` ve proxy'yi eşleştir → `BROWSER_HEADLESS=false` + `xvfb-run` ile dene.**
