# -*- coding: utf-8 -*-
"""
🤖 ARENA GÖRSEL ÜRETİMİ — arena-proxy köprüsü (eklemeli modül)

Bu modül, ayrı çalışan **arena-proxy** (Playwright/Chromium tabanlı AI görsel
üretim servisi) ile Şarkı API arasında köprü kurar. Mevcut müzik uçlarına
HİÇ dokunulmaz; yalnızca yeni uçlar eklenir.

Neden ayrı servis?
  Chromium başlatmak, oturum (cookie) saklamak ve tarayıcı havuzu yönetmek
  ağır iştir; Flask sürecinin içinde çalıştırmak servisi çökertir. Bu yüzden
  arena-proxy ayrı bir süreç/servis olarak çalışır, burası yalnızca ona
  HTTP üzerinden bağlanır (tek sorumluluk ilkesi).

Render → Environment değişkenleri:
  ARENA_API_URL   arena-proxy adresi  (örn. https://arena-proxy-xxxx.onrender.com veya http://VM_IP:8080)
  ARENA_API_KEY   arena-proxy API anahtarı  (arena-proxy'deki API_KEYS değeri; AUTH kapalıysa boş kalabilir)
  ARENA_TIMEOUT   üretim için üst süre, saniye (varsayılan 150 — soğuk başlangıç payı)
  ARENA_DENEME    ağ hatasında deneme sayısı (varsayılan 2)
  ARENA_DELIVERY  varsayılan teslim biçimi: url | file | base64 | both (varsayılan url)
  ARENA_PROVIDER  varsayılan görsel sağlayıcı: pollinations | ovh | auto | arena (varsayılan auto)
                  auto = pollinations seed biterse OVH SDXL'e, o da düşerse anon'a
                  otomatik geçer (kota patlamalarına karşı zincir — arena-proxy v2026-09-16+)

Kurulum adımları: ARENA_KURULUM.md
"""
import base64
import os
import time

import requests
from flask import Response, g, jsonify, redirect, request, stream_with_context

# ---------------------------- sabitler ----------------------------
ARENA_SAGLAYICI = "arena"          # key izinlerinde görünen sağlayıcı kodu
ARENA_ETIKET = "🤖 Arena (AI görsel)"
ARENA_KISA = "ar"
_SAGLIK_ONBELLEK = {"zaman": 0.0, "veri": None}
_RETRY_KODLARI = (500, 502, 503, 504)


def _cfg():
    """Env'den yapılandırma oku (modül import edilirken DEĞİL, istek anında)."""
    return {
        "url": (os.environ.get("ARENA_API_URL") or "").strip().rstrip("/"),
        "key": (os.environ.get("ARENA_API_KEY") or "").strip(),
        "timeout": max(20, int(os.environ.get("ARENA_TIMEOUT", "150") or 150)),
        "deneme": max(1, int(os.environ.get("ARENA_DENEME", "2") or 2)),
        "delivery": (os.environ.get("ARENA_DELIVERY") or "url").strip() or "url",
        "provider": (os.environ.get("ARENA_PROVIDER") or "auto").strip() or "auto",
    }


def _hata(mesaj, kod=400, ek=None):
    govde = {"ok": False, "hata": mesaj}
    if ek:
        govde.update(ek)
    return jsonify(govde), kod


def _kurulum_eksik():
    """ARENA_API_URL tanımlı değilse yol gösteren hata döner."""
    cfg = _cfg()
    if cfg["url"]:
        return None
    return _hata(
        "Arena entegrasyonu kurulu değil: ARENA_API_URL tanımlanmalı. "
        "Render → Environment → ARENA_API_URL (arena-proxy adresi) ve ARENA_API_KEY ekleyin. "
        "Kurulum: ARENA_KURULUM.md",
        503,
    )


def _arena_izinli():
    """
    Key izin kontrolü. api.py'deki `korumali` sarmalayıcısı zaten geçerli key
    doğrular ve g.izin'e izinli sağlayıcı setini koyar. Burada yalnızca
    'arena' sağlayıcısının bu key'de olup olmadığına bakılır.
      • master API_KEY kullanan istekler  → tüm sağlayıcılar (arena dahil)
      • sistemde hiç key yokken (geçici açık erişim) → tüm sağlayıcılar
      • "tumu" keyler                      → tüm sağlayıcılar (arena dahil)
      • sadece belirli sağlayıcı seçen keyler → arena YOK (403)
    """
    izin = getattr(g, "izin", None) or set()
    if ARENA_SAGLAYICI in izin:
        return None
    return _hata(
        "Bu key'in 'arena' (AI görsel üretimi) izni yok. Ana sayfadan 🤖 Arena "
        "seçili yeni bir key oluştur veya key'de '✨ Tümü' seçili olsun.",
        403,
    )


def _duzelt(s):
    """
    Query string UTF-8 olarak yüzde-kodlanmadan geldiğinde (curl/wget gibi
    araçlar) Werkzeug bunu latin-1 gibi çözer → "köpek" yerine "kÃ¶pek".
    Bozuk görünüyorsa geri dönüştürür; normal metne dokunmaz.
    """
    if not s or not isinstance(s, str):
        return s or ""
    # Bozulma latin-1 (ISO-8859-1) veya cp1252 yorumundan kaynaklanabilir
    # (Ÿ, €, ™ gibi harfler cp1252'de var, latin-1'de yok) → ikisini de dene.
    for kodlama in ("latin-1", "cp1252"):
        try:
            aday = s.encode(kodlama).decode("utf-8")
            if aday != s:
                return aday
        except (UnicodeEncodeError, UnicodeDecodeError):
            continue
    return s


def _istek(method, yol, cfg, **kw):
    """arena-proxy'ye tek istek (kısa backoff'lu deneme)."""
    son = None
    for deneme in range(1, cfg["deneme"] + 1):
        try:
            r = requests.request(
                method,
                cfg["url"] + yol,
                timeout=(10, cfg["timeout"]),
                headers={
                    "x-api-key": cfg["key"],
                    "content-type": "application/json",
                    "accept": "application/json",
                },
                **kw,
            )
            if r.status_code in _RETRY_KODLARI and deneme < cfg["deneme"]:
                time.sleep(2 * deneme)          # soğuk başlangıç / geçici hata payı
                continue
            return r
        except requests.exceptions.RequestException as e:
            son = e
            if deneme < cfg["deneme"]:
                time.sleep(2 * deneme)          # Render free uyanma payı
                continue
    raise RuntimeError(f"arena-proxy'ye ulaşılamadı ({cfg['url']}): {son}")


def _arena_cagri(veri, cfg, asenkron=False):
    """Üretim çağrısı → (arena json, http kodu)"""
    govde = {
        "prompt": veri.get("prompt", ""),
        "negative_prompt": veri.get("negative_prompt", ""),
        "aspect_ratio": veri.get("aspect_ratio", "1:1"),
        "style": veri.get("style", ""),
        "delivery": veri.get("delivery") or cfg["delivery"],
        "provider": veri.get("provider") or cfg["provider"],   # pollinations | ovh | auto | arena
    }
    if veri.get("model"):
        govde["model"] = str(veri["model"]).strip()[:160]          # istek bazlı model (pollinations)
    if asenkron:
        govde["async"] = True
    r = _istek("POST", "/api/v1/generate-asset", cfg, json=govde)
    try:
        d = r.json()
    except Exception:
        d = {"ok": False, "hata": f"arena-proxy geçersiz yanıt döndü (HTTP {r.status_code})"}
    return d, r.status_code


def _gorsel_baytlari(url, cfg, timeout=None):
    """CDN/görsel URL'ini indir (indir modu için)."""
    r = requests.get(
        url,
        timeout=(10, timeout or cfg["timeout"]),
        stream=True,
        headers={"user-agent": "Mozilla/5.0 (uyumlu; sarki-api arena koprusu)"},
    )
    r.raise_for_status()
    return r


# ============================ UÇLAR ============================

def arena_rotalari_ekle(app, korumali, depo, api_key, saglayicilar, di_ad=None):
    """
    Uçları Flask uygulamasına bağlar ve 'arena' sağlayıcısını key sistemine ekler.
    api.py tarafındaki değişiklik tek satırlık bir çağrıdır (bkz. dosya sonu).
    """
    # --- Key sistemine 'arena' sağlayıcısını ekle (eklemeli; mevcutları bozmaz) ---
    if ARENA_SAGLAYICI not in saglayicilar:
        saglayicilar.append(ARENA_SAGLAYICI)
    if di_ad is not None:
        di_ad[ARENA_SAGLAYICI] = "arena ai görsel"

    # ---------------------------- DURUM ----------------------------
    @app.get("/api/v1/arena/durum")
    @korumali
    def arena_durum():
        izin_h = _arena_izinli()
        if izin_h:
            return izin_h
        cfg = _cfg()
        if not cfg["url"]:
            return _kurulum_eksik()

        # 10 sn önbellek: arayüz her açılışta arena-proxy'yi yormasın
        if _SAGLIK_ONBELLEK["veri"] and (time.time() - _SAGLIK_ONBELLEK["zaman"] < 10):
            return jsonify(_SAGLIK_ONBELLEK["veri"])

        try:
            r = _istek("GET", "/health", cfg)
            saglik = r.json() if r.status_code == 200 else None
            veri = {
                "ok": r.status_code == 200,
                "arena_url": cfg["url"],
                "arena_anahtar_ayarli": bool(cfg["key"]),
                "varsayilan_teslim": cfg["delivery"],
                "varsayilan_saglayici": cfg["provider"],
                "proxy_saglayicisi": (saglik or {}).get("image_provider"),
                "timeout_sn": cfg["timeout"],
                "arena": saglik,
            }
        except Exception as e:
            veri = {
                "ok": False,
                "arena_url": cfg["url"],
                "arena_anahtar_ayarli": bool(cfg["key"]),
                "hata": str(e)[:300],
                "ipucu": "arena-proxy servisi kapalı veya adres yanlış. Render free ise ilk çağrı 30-60 sn sürebilir.",
            }

        _SAGLIK_ONBELLEK.update({"zaman": time.time(), "veri": veri})
        return jsonify(veri), (200 if veri.get("ok") else 502)

    # ---------------------- ÜRETİM (POST) ----------------------
    @app.post("/api/v1/arena/gorsel")
    @korumali
    def arena_gorsel_post():
        izin_h = _arena_izinli()
        if izin_h:
            return izin_h
        kurulum_h = _kurulum_eksik()
        if kurulum_h:
            return kurulum_h

        d = request.get_json(silent=True) or {}
        prompt = _duzelt((d.get("prompt") or d.get("q") or "").strip())
        if not prompt:
            return _hata("prompt gerekli (örn. {\"prompt\":\"okyanusta köpek balığı\"})", 400)

        veri = {
            "prompt": prompt,
            "negative_prompt": d.get("negative_prompt") or d.get("negatif") or "",
            "aspect_ratio": d.get("aspect_ratio") or d.get("oran") or "1:1",
            "style": d.get("style") or d.get("stil") or "",
            "delivery": d.get("delivery"),
            "provider": d.get("provider") or d.get("saglayici"),
            "model": d.get("model"),
        }
        asenkron = bool(d.get("async")) or d.get("bekleme") == 0
        cfg = _cfg()

        try:
            cevap, kod = _arena_cagri(veri, cfg, asenkron=asenkron)
        except Exception as e:
            return _hata(str(e), 502)

        if kod >= 400 or not cevap.get("success"):
            return jsonify({
                "ok": False,
                "hata": (cevap.get("error") or {}).get("message") or cevap.get("hata") or "üretim başarısız",
                "arena_kodu": (cevap.get("error") or {}).get("code") or kod,
            }), kod if kod >= 400 else 502

        return jsonify(_zenginlestir(cevap, veri))

    # --------------------- ÜRETİM (GET, pratik) ---------------------
    @app.get("/api/v1/arena/gorsel")
    @korumali
    def arena_gorsel_get():
        """
        Tek satırda görsel: <img src=".../api/v1/arena/gorsel?prompt=...&key=SK-...">

        Parametreler:
          prompt | q      : istem (zorunlu)
          negatif         : negatif istem
          oran            : 1:1 | 16:9 | 9:16 ...   (aspect_ratio)
          stil            : cinematic, photographic ...
          mod             : url (302 yönlendirme, varsayılan) | json | indir | base64
          saglayici       : pollinations | ovh | auto (env: ARENA_PROVIDER) | arena
          ham             : 1 → base64 modunda yalnız base64 gövde döner
          dosya           : 1 → indir modunda tarayıcıda indirme olarak sunulur
          bekleme         : 0 → asenkron başlat, iş kimliği döner
          delivery        : url | file | base64 | both (arena-proxy teslim biçimi)
        """
        izin_h = _arena_izinli()
        if izin_h:
            return izin_h
        kurulum_h = _kurulum_eksik()
        if kurulum_h:
            return kurulum_h

        a = request.args
        prompt = _duzelt((a.get("prompt") or a.get("q") or "").strip())
        if not prompt:
            return _hata("prompt parametresi gerekli (?prompt=...)", 400)

        mod = (a.get("mod") or "url").strip().lower()
        veri = {
            "prompt": prompt,
            "negative_prompt": _duzelt(a.get("negatif") or a.get("negative_prompt") or ""),
            "aspect_ratio": a.get("oran") or a.get("aspect_ratio") or "1:1",
            "style": _duzelt(a.get("stil") or a.get("style") or ""),
            "delivery": a.get("delivery"),
            "provider": a.get("saglayici") or a.get("provider"),
            "model": a.get("model"),
        }
        asenkron = a.get("bekleme") == "0" or a.get("async") in ("1", "true")
        cfg = _cfg()

        try:
            cevap, kod = _arena_cagri(veri, cfg, asenkron=asenkron)
        except Exception as e:
            return _hata(str(e), 502)

        if kod >= 400 or not cevap.get("success"):
            return jsonify({
                "ok": False,
                "hata": (cevap.get("error") or {}).get("message") or cevap.get("hata") or "üretim başarısız",
                "arena_kodu": (cevap.get("error") or {}).get("code") or kod,
            }), kod if kod >= 400 else 502

        zengin = _zenginlestir(cevap, veri)

        # ---- Asenkron: iş kimliği döner, sonuç /api/v1/arena/sonuc/<id> ile alınır
        if asenkron:
            return jsonify(zengin), 202

        # ---- mod=json: tam JSON
        if mod == "json":
            return jsonify(zengin)

        # ---- mod=base64: JSON içinde base64 (ham=1 → sade metin)
        if mod == "base64":
            b64 = cevap.get("image_base64")
            if not b64:
                b64 = _base64_yap(cevap.get("image_url"), cfg)
            if not b64:
                return _hata("base64 içerik alınamadı", 502)
            if a.get("ham") == "1":
                return Response(b64, mimetype="text/plain")
            return jsonify({**zengin, "base64": b64})

        gorsel_url = cevap.get("image_url")

        # ---- mod=url (varsayılan): 302 → CDN linki (en hızlı, bayt geçmez)
        if mod == "url" and gorsel_url:
            return redirect(gorsel_url, code=302)

        # ---- mod=indir: baytları kendi sunucumuzdan geçir (link gizli kalır,
        #      oturum/referer gerektiren CDN'lerde de çalışır)
        if mod == "indir" or (mod == "url" and not gorsel_url):
            if gorsel_url:
                try:
                    r = _gorsel_baytlari(gorsel_url, cfg)
                except Exception as e:
                    return _hata(f"görsel indirilemedi: {e}", 502)
                basliklar = {"Cache-Control": "public, max-age=3600"}
                if a.get("dosya") == "1":
                    basliklar["Content-Disposition"] = 'attachment; filename="arena-gorsel.png"'
                return Response(
                    stream_with_context(r.iter_content(chunk_size=65536)),
                    content_type=r.headers.get("content-type", "image/png"),
                    headers=basliklar,
                )
            # image_url yoksa base64 gövdesini çöz
            b64 = cevap.get("image_base64") or _base64_yap(None, cfg)
            if not b64:
                return _hata("görsel çıktısı yok", 502)
            ham = base64.b64decode(b64)
            return Response(ham, content_type=cevap.get("mime_type") or "image/png",
                            headers={"Cache-Control": "public, max-age=3600"})

        return jsonify(zengin)

    # ---------------------- İŞ DURUMU ----------------------
    @app.get("/api/v1/arena/sonuc/<is_id>")
    @korumali
    def arena_sonuc(is_id):
        izin_h = _arena_izinli()
        if izin_h:
            return izin_h
        kurulum_h = _kurulum_eksik()
        if kurulum_h:
            return kurulum_h

        cfg = _cfg()
        try:
            r = _istek("GET", f"/api/v1/jobs/{is_id}", cfg)
        except Exception as e:
            return _hata(str(e), 502)

        try:
            d = r.json()
        except Exception:
            return _hata(f"arena-proxy geçersiz yanıt (HTTP {r.status_code})", 502)

        if r.status_code >= 400:
            return jsonify({"ok": False, "hata": (d.get("error") or {}).get("message", "iş bulunamadı"),
                            "arena_kodu": (d.get("error") or {}).get("code", r.status_code)}), r.status_code

        durum = d.get("status")
        sonuc = d.get("result") or {}
        return jsonify({
            "ok": durum != "failed",
            "is_id": is_id,
            "durum": {"queued": "kuyrukta", "succeeded": "bitti", "failed": "hata"}.get(durum, durum),
            "gorsel_url": sonuc.get("image_url"),
            "mime": sonuc.get("mime_type"),
            "boyut": sonuc.get("bytes"),
            "sure_ms": sonuc.get("execution_time_ms"),
            "hata": (d.get("error") or {}).get("message"),
        })

    return {"saglayici": ARENA_SAGLAYICI, "uclar": ["/api/v1/arena/durum", "/api/v1/arena/gorsel", "/api/v1/arena/sonuc/<is_id>"]}


# ============================ yardımcılar ============================

def _base64_yap(url, cfg):
    """URL'deki görseli base64'e çevir (image_url yoksa veya base64 modunda)."""
    if not url:
        return None
    try:
        r = requests.get(url, timeout=(10, cfg["timeout"]))
        r.raise_for_status()
        return base64.b64encode(r.content).decode("ascii")
    except Exception:
        return None


def _gorunum_url(veri):
    """İstemcinin doğrudan <img src> yapabileceği, bu sunucu üzerinden geçen URL."""
    from urllib.parse import urlencode
    p = {
        "prompt": veri["prompt"],
        "mod": "indir",
        "oran": veri.get("aspect_ratio") or "1:1",
        "key": request.args.get("key") or "",
    }
    if veri.get("negative_prompt"):
        p["negatif"] = veri["negative_prompt"]
    if veri.get("style"):
        p["stil"] = veri["style"]
    return f"{request.host_url.rstrip('/')}/api/v1/arena/gorsel?{urlencode(p)}"


def _zenginlestir(cevap, veri):
    """
    arena-proxy yanıtını Şarkı API sözleşmesine uyarlar (ok/hata kalıbı + pratik alanlar).
    Arena alanları korunur; üzerine kullanışlı kısayollar eklenir.
    """
    # Asenkron yanıtta iş kimliği kök seviyededir (job_id), senkron yanıtta meta.task_id
    meta = cevap.get("meta") or {}
    is_id = meta.get("task_id") or cevap.get("job_id")
    kuyrukta = cevap.get("status") == "queued"

    z = {
        "ok": True,
        "durum": "kuyrukta" if kuyrukta else ("bitti" if cevap.get("success") else "hata"),
        "is_id": is_id,
        "sonuc_url": f"/api/v1/arena/sonuc/{is_id}" if kuyrukta and is_id else None,
        "gorsel_url": cevap.get("image_url"),
        "gorunum_url": _gorunum_url(veri),          # <img src> için hazır URL
        "mime": cevap.get("mime_type"),
        "boyut": cevap.get("bytes"),
        "sha256": cevap.get("sha256"),
        "sure_ms": cevap.get("execution_time_ms"),
        "kaynak": cevap.get("captured_from"),
        "teslim": cevap.get("delivery"),
        "prompt": veri["prompt"],
        "oran": veri.get("aspect_ratio"),
        "saglayici": meta.get("provider"),           # kazanan sağlayıcı (auto zincirinde gerçek)
        "fallback": meta.get("fallback_attempts"),   # zincir izleri (varsa)
        "not": meta.get("delivery_note") or meta.get("size_note"),
        "arena_meta": {
            "adimlar": meta.get("steps"),
            "context_yeniden": meta.get("reused_context"),
        },
    }
    if cevap.get("dry_run") or (cevap.get("meta") or {}).get("dry_run"):
        z["uyari"] = "arena-proxy DRY_RUN modunda: gerçek üretim yapılmadı, örnek görsel döndü."
    return {k: v for k, v in z.items() if v is not None}
