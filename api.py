# -*- coding: utf-8 -*-
"""
🎵 ŞARKI API v2 — key yönetimli kişisel müzik indirme servisi

Arayüz:
  GET  /            → sade key arayüzü (Key Oluştur + Keylerim)
  GET  /dokuman     → detaylı dokümantasyon

API (api/v1):
  GET  /health                → servis sağlığı (açık)
  GET  /search?q=&limit=      → 3 kaynakta paralel arama
  GET  /instant?q=            → ara + en iyi sonucu indir
  POST /convert {url,...}     → seçili URL'yi indir
  GET  /status/{job_id}       → iş durumu
  GET  /file/{dosya}          → mp3 dosyası

Key sistemi (/api/v1/keys):
  GET  /durum     → arayüz konfigürasyonu (açık, sır yok)
  POST /olustur   → {isim, saglayicilar, parola} → yeni key
  GET  /liste     → keyler (parola korumalı)
  POST /sil       → {key, parola}

Kalıcılık: keyler GitHub'da ayrı bir dalda (depolama) keys.json olarak tutulur.
  GITHUB_TOKEN  → GitHub PAT (Render Environment'dan)
  ADMIN_PAROLA  → key oluşturma/listeleme şifresi (Render Environment'dan)
  GITHUB_REPO   → varsayılan kcbyk/Mp3_apisi
  GITHUB_BRANCH → varsayılan depolama
Token yoksa yerel keys.json'a düşer (kalıcılık zayıflar, arayüzde uyarı görünür).
"""
import base64
import json
import os
import secrets
import threading
import time
from datetime import datetime
from functools import wraps
from pathlib import Path

import requests as _rq
from flask import Flask, abort, g, jsonify, redirect, request, send_file

import api_core

BASE = Path(__file__).resolve().parent
KEYF = BASE / "api_key.txt"
API_KEY = (os.environ.get("API_KEY") or (KEYF.read_text().strip() if KEYF.exists() else "")).strip()

SAGLAYICILAR = ["youtube", "soundcloud", "archive"]
IC_KOD = {"youtube": "yt", "soundcloud": "sc", "archive": "ia"}
DI_KOD = {"yt": "youtube", "sc": "soundcloud", "ia": "archive"}
DI_AD = {"yt": "youtube", "sc": "soundcloud", "ia": "archive.org"}


# ============================ KEY DEPOSU ============================

class KeyDeposu:
    """Kalıcı key deposu: GitHub (ayrı dal) birincil, yerel dosya yedek."""

    def __init__(self):
        self.repo = os.environ.get("GITHUB_REPO", "kcbyk/Mp3_apisi")
        self.dal = os.environ.get("GITHUB_BRANCH", "depolama")
        self.token = os.environ.get("GITHUB_TOKEN", "").strip()
        self.parola = os.environ.get("ADMIN_PAROLA", "").strip()
        self.acik_olusturma = os.environ.get("ALLOW_OPEN_KEYS", "") == "1"
        self.yerel = BASE / "keys.json"
        self.anahtarlar = {}          # key -> kayıt
        self._sha = None
        self._kilit = threading.Lock()
        self.yukle()

    # ---------- yükleme / kaydetme ----------
    def _gh_baslik(self):
        return {"Authorization": f"Bearer {self.token}",
                "Accept": "application/vnd.github+json"}

    def yukle(self):
        if self.token:
            try:
                r = _rq.get(f"https://api.github.com/repos/{self.repo}/contents/keys.json",
                            headers=self._gh_baslik(), params={"ref": self.dal}, timeout=15)
                if r.status_code == 200:
                    d = r.json()
                    self.anahtarlar = json.loads(base64.b64decode(d["content"]).decode())
                    self._sha = d.get("sha")
                    print(f"[keys] GitHub'dan {len(self.anahtarlar)} key yüklendi", flush=True)
                    return
                print(f"[keys] GitHub'da keys.json yok (kod {r.status_code}) — ilk kayıtta oluşacak", flush=True)
            except Exception as ex:
                print("[keys] GitHub yükleme hatası:", str(ex)[:120], flush=True)
        if self.yerel.exists():
            try:
                self.anahtarlar = json.loads(self.yerel.read_text())
            except Exception:
                self.anahtarlar = {}

    def _yerel_yaz(self):
        try:
            self.yerel.write_text(json.dumps(self.anahtarlar, ensure_ascii=False, indent=1))
        except Exception:
            pass

    def kaydet(self, mesaj="keyler guncellendi (otomatik)"):
        with self._kilit:
            self._yerel_yaz()
            if not self.token:
                return True
            try:
                ok = self._git_yaz(mesaj)
                if not ok:  # bir kez daha dene (yarış durumu)
                    ok = self._git_yaz(mesaj)
                return ok
            except Exception as ex:
                print("[keys] GitHub kaydetme istisnası:", str(ex)[:120], flush=True)
                return False

    def _git(self, metod, yol, js=None):
        return _rq.request(metod, f"https://api.github.com/repos/{self.repo}/git/{yol}",
                           headers=self._gh_baslik(), json=js, timeout=15)

    def _git_yaz(self, mesaj):
        """keys.json'u ayrı 'depolama' dalına işler (main'a dokunmaz → deploy tetiklenmez)."""
        data = base64.b64encode(json.dumps(self.anahtarlar, ensure_ascii=False, indent=1).encode()).decode()
        # 1) dalı bul / yoksa main'den oluştur
        r = self._git("GET", f"ref/heads/{self.dal}")
        if r.status_code != 200:
            m = self._git("GET", "ref/heads/main").json()
            self._git("POST", "refs", {"ref": f"refs/heads/{self.dal}", "sha": m["object"]["sha"]})
            r = self._git("GET", f"ref/heads/{self.dal}")
        usta = r.json()["object"]["sha"]
        # 2) blob → ağaç → commit → dalı ilerlet
        agac = self._git("GET", f"commits/{usta}").json()["tree"]["sha"]
        blob = self._git("POST", "blobs", {"content": data, "encoding": "base64"}).json()["sha"]
        yeni_agac = self._git("POST", "trees", {"base_tree": agac, "tree": [
            {"path": "keys.json", "mode": "100644", "type": "blob", "sha": blob}]}).json()["sha"]
        kmt = self._git("POST", "commits", {"message": mesaj, "tree": yeni_agac, "parents": [usta]}).json()["sha"]
        # DİKKAT: PATCH/DELETE yolu "refs" (çoğul), GET yolu "ref" (tekil) — GitHub tuhaflığı
        p = self._git("PATCH", f"refs/heads/{self.dal}", {"sha": kmt, "force": False})
        if p.status_code == 200:
            print(f"[keys] GitHub '{self.dal}' dalına kaydedildi ({len(self.anahtarlar)} key)", flush=True)
            return True
        print("[keys] dal güncellenemedi:", p.status_code, p.text[:120], flush=True)
        return False

    # ---------- işlemler ----------
    @property
    def kilitli(self):
        return bool(self.parola)

    @property
    def olusturma_acik(self):
        return self.kilitli or self.acik_olusturma

    def parola_dogrula(self, gelen):
        if not self.kilitli:
            return True  # parola ayarlanmamışsa ALLOW_OPEN_KEYS kapıyı kontrol eder
        return secrets.compare_digest((gelen or "").strip(), self.parola)

    def olustur(self, isim, saglayicilar):
        secim = [s for s in (saglayicilar or []) if s in SAGLAYICILAR]
        if len(secim) == len(SAGLAYICILAR) or not secim:
            secim = ["tumu"]
        key = "sk-" + secrets.token_hex(12)
        self.anahtarlar[key] = {
            "isim": isim[:48],
            "saglayicilar": secim,
            "olusturma": datetime.now().strftime("%Y-%m-%d %H:%M"),
            "kullanim": 0,
            "son_kullanim": None,
        }
        self.kaydet(f"key eklendi: {isim[:48]}")
        return key, self.anahtarlar[key]

    def sil(self, key):
        if key in self.anahtarlar:
            isim = self.anahtarlar[key].get("isim", "?")
            del self.anahtarlar[key]
            self.kaydet(f"key silindi: {isim}")
            return True
        return False

    def dogrula(self, key):
        """Key varsa kaydını döner + kullanım sayar. Yoksa None."""
        k = self.anahtarlar.get(key)
        if k:
            k["kullanim"] = int(k.get("kullanim", 0)) + 1
            k["son_kullanim"] = datetime.now().strftime("%Y-%m-%d %H:%M")
        return k

    def izinler(self, kayit):
        sek = kayit.get("saglayicilar") or ["tumu"]
        if "tumu" in sek:
            return set(SAGLAYICILAR)
        return {s for s in sek if s in SAGLAYICILAR}


depo = KeyDeposu()
app = Flask(__name__)


@app.after_request
def _cors(cev):
    """Tarayıcıdan (başka origin/dosya) da çalışsın — koruma key ile."""
    cev.headers["Access-Control-Allow-Origin"] = "*"
    cev.headers["Access-Control-Allow-Headers"] = "Content-Type, X-API-Key"
    cev.headers["Access-Control-Allow-Methods"] = "GET, POST, OPTIONS"
    return cev


def _yt_id(url):
    import re
    m = __import__("re").search(r"(?:v=|youtu\.be/|shorts/)([\w-]{11})", url or "")
    return m.group(1) if m else None


def _kapak(s):
    """Sonuç kartı için kapak görseli (YouTube küçük resim / SC artwork / IA item görseli)."""
    k = s.get("kaynak")
    if k == "yt":
        vid = _yt_id(s.get("url"))
        return f"https://i.ytimg.com/vi/{vid}/hqdefault.jpg" if vid else None
    if k == "sc":
        return s.get("kapak")
    if k == "ia" and s.get("ia_id"):
        return f"https://archive.org/services/img/{s['ia_id']}"
    return None


# ============================ YETKİLENDİRME ============================

def _hata(mesaj, kod=401):
    return jsonify(ok=False, hata=mesaj), kod


def yetki():
    """Key doğrula → flask.g.izın'e sağlayıcı seti koyar. Hata cevabı dönerse istek reddedilir."""
    k = request.args.get("key") or request.headers.get("X-API-Key") or ""
    if API_KEY and k == API_KEY:
        g.izin = set(SAGLAYICILAR)
        return None
    if not depo.anahtarlar:          # sistemde hiç key yok → geçici açık erişim
        g.izin = set(SAGLAYICILAR)
        return None
    kayit = depo.dogrula(k.strip())
    if not kayit:
        return _hata("Geçersiz API key — ana sayfadan kendi key'ini oluştur (?key=...)")
    g.izin = depo.izinler(kayit)
    return None


def korumali(f):
    @wraps(f)
    def sarmal(*a, **kw):
        h = yetki()
        if h:
            return h
        return f(*a, **kw)
    return sarmal


def _admin_kontrol():
    if not depo.olusturma_acik:
        return _hata("Key oluşturma kapalı: sunucuda ADMIN_PAROLA ayarlanmamış "
                     "(Render → Environment → ADMIN_PAROLA ekle)", 503)
    if not depo.parola_dogrula(request.args.get("parola") or request.headers.get("X-Admin-Key")
                               or (request.get_json(silent=True) or {}).get("parola")):
        return _hata("Yönetici şifresi yanlış", 403)
    return None


# ============================ API UÇLARI ============================

@app.get("/api/v1/health")
def health():
    return jsonify(ok=True, servis="sarki-api", surum="4.1",
                   ffmpeg=api_core.ffmpeg_var(),
                   zaman=time.strftime("%Y-%m-%d %H:%M:%S"))


@app.get("/api/v1/search")
@korumali
def search():
    q = (request.args.get("q") or "").strip()
    limit = int(request.args.get("limit") or 20)
    if not q:
        return _hata("q parametresi gerekli", 400)
    izin = {ic for ic, dis in DI_KOD.items() if dis in g.izin}
    try:
        sonuc = api_core.ara(q, max(1, min(limit, 30)), kaynaklar=izin)
    except Exception as ex:
        return _hata(str(ex)[:200], 500)
    api_core.onizleme_baslat([s for s in sonuc if DI_KOD.get(s.get("kaynak")) in g.izin])
    sonuc = [s for s in sonuc if DI_KOD.get(s.get("kaynak")) in g.izin]
    return jsonify(ok=True, q=q, adet=len(sonuc), sonuclar=[{
        "id": i,
        "kaynak": DI_AD.get(s.get("kaynak"), s.get("kaynak")),
        "baslik": s.get("baslik"),
        "kanal": s.get("kanal", ""),
        "sure": s.get("sure", 0),
        "url": s.get("url") or f"https://archive.org/details/{s.get('ia_id')}",
        "kapak": _kapak(s),
        "sc_prog_url": s.get("sc_prog_url"),
        "ia_id": s.get("ia_id"),
    } for i, s in enumerate(sonuc)],
        onbellek=getattr(api_core, "cache_vurdu", False))


def _kalite_al(args, govde, fmt="mp3"):
    """kalite parametresini dogrula: mp3 -> 128/192/320, mp4 -> 360/480/720/1080."""
    k = str(args.get("kalite") or (govde or {}).get("kalite") or ("720" if fmt == "mp4" else "320"))
    gecerli = ("360", "480", "720", "1080") if fmt == "mp4" else ("128", "192", "320")
    return k if k in gecerli else None


def _format_al(args, govde):
    f = str(args.get("format") or (govde or {}).get("format") or "mp3").lower()
    return f if f in ("mp3", "mp4") else None


@app.get("/api/v1/instant")
@korumali
def instant():
    """Ara + en iyi sonucu otomatik indir. Dönen job_id ile status'u poll et."""
    q = (request.args.get("q") or "").strip()
    fmt = _format_al(request.args, None)
    kalite = _kalite_al(request.args, None, fmt)
    if not q:
        return _hata("q parametresi gerekli", 400)
    if fmt is None:
        return _hata("format mp3 veya mp4 olabilir", 400)
    if kalite is None:
        return _hata("kalite, mp3'te 128/192/320; mp4'te 360/480/720/1080 olabilir", 400)
    izin = {ic for ic, dis in DI_KOD.items() if dis in g.izin}
    sonuc = api_core.ara(q, 10, kaynaklar=izin)
    if fmt == "mp4":  # video yalniz YouTube'dan olur
        sonuc = [s for s in sonuc if s.get("kaynak") == "yt"]
    sonuc = [s for s in sonuc if DI_KOD.get(s.get("kaynak")) in g.izin]
    if not sonuc:
        return _hata("Bu key'in sağlayıcılarında sonuç bulunamadı" +
                     (" (video için YouTube gerekir)" if fmt == "mp4" else ""), 404)
    en_iyi = dict(sonuc[0])
    en_iyi["kalite"] = kalite
    en_iyi["format"] = fmt
    jid = api_core.job_baslat(en_iyi, q)
    return jsonify(ok=True, job_id=jid, format=fmt, kalite=kalite, secilen={
        "baslik": en_iyi.get("baslik"), "kaynak": DI_AD.get(en_iyi.get("kaynak"), "?"),
        "sure": en_iyi.get("sure", 0)},
        durum_url=f"/api/v1/status/{jid}",
        not_="Ön-ısıtma: bu sorgunun ilk YouTube sonucu arama anında dönüştürülüyordu, iş hızlı biter")


@app.post("/api/v1/convert")
@korumali
def convert():
    d = request.get_json(silent=True) or {}
    q = request.args.get("q") or ""
    fmt = _format_al(request.args, d)
    kalite = _kalite_al(request.args, d, fmt)
    if fmt is None:
        return _hata("format mp3 veya mp4 olabilir", 400)
    if kalite is None:
        return _hata("kalite, mp3'te 128/192/320; mp4'te 360/480/720/1080 olabilir", 400)
    url = d.get("url") or request.args.get("url")
    if not url:
        return _hata("url gerekli", 400)
    gelen = (d.get("kaynak") or "").lower()
    ic = {"youtube": "yt", "soundcloud": "sc", "archive": "ia",
          "archive.org": "ia", "yt": "yt", "sc": "sc", "ia": "ia"}.get(gelen)
    if not ic:
        ic = "yt" if "youtube" in url else ("ia" if "archive.org" in url else "sc")
    if DI_KOD.get(ic) not in g.izin:
        return _hata(f"Bu key '{DI_KOD[ic]}' sağlayıcısına izinli değil", 403)
    if fmt == "mp4" and ic != "yt":
        return _hata("Video (mp4) indirme yalnız YouTube linklerinde çalışır", 400)
    item = {"kaynak": ic, "url": url, "baslik": d.get("baslik") or "sarki",
            "ia_id": d.get("ia_id") or (url.rstrip("/").split("/")[-1] if "archive.org" in url else None),
            "sure": d.get("sure", 0), "sc_prog_url": d.get("sc_prog_url"),
            "kalite": kalite, "format": fmt}
    jid = api_core.job_baslat(item, q)
    return jsonify(ok=True, job_id=jid, format=fmt, kalite=kalite, durum_url=f"/api/v1/status/{jid}")


def _oynatma_sec(args, fmt):
    """link/stream için sonuç seç: ?url= doğrudan veya ?q= aramasından (mp4 → sadece yt)."""
    url = args.get("url")
    izin = {ic for ic, dis in DI_KOD.items() if dis in g.izin}
    if url:
        ic = "yt" if "youtube" in url else ("ia" if "archive.org" in url else "sc")
        if DI_KOD.get(ic) not in g.izin:
            return None, _hata(f"Bu key '{DI_KOD[ic]}' sağlayıcısına izinli değil", 403)
        if fmt == "mp4" and ic != "yt":
            return None, _hata("Video oynatma yalnız YouTube linklerinde çalışır", 400)
        return {"kaynak": ic, "url": url, "baslik": args.get("baslik") or "sarki",
                "ia_id": url.rstrip("/").split("/")[-1] if ic == "ia" else None,
                "sc_prog_url": args.get("sc_prog_url")}, None
    q = (args.get("q") or "").strip()
    if not q:
        return None, _hata("q veya url gerekli", 400)
    sonuc = api_core.ara(q, 10, kaynaklar=izin)
    if fmt == "mp4":
        sonuc = [s for s in sonuc if s.get("kaynak") == "yt"]
    sonuc = [s for s in sonuc if DI_KOD.get(s.get("kaynak")) in g.izin]
    if not sonuc:
        return None, _hata("Sonuç bulunamadı" + (" (video için YouTube gerekir)" if fmt == "mp4" else ""), 404)
    return dict(sonuc[0]), None


@app.get("/api/v1/link")
@korumali
def link_ep():
    """İndirmeden oynatma: çözülmüş DİREKT CDN linkini JSON döndürür (sunucu diske yazmaz)."""
    fmt = _format_al(request.args, None)
    kalite = _kalite_al(request.args, None, fmt)
    if fmt is None:
        return _hata("format mp3 veya mp4 olabilir", 400)
    if kalite is None:
        return _hata("kalite, mp3'te 128/192/320; mp4'te 360/480/720/1080 olabilir", 400)
    item, h = _oynatma_sec(request.args, fmt)
    if h:
        return h
    t0 = time.time()
    direct, hata = api_core.link_coz_cached(item, fmt, kalite)
    if not direct:
        return _hata(hata or "link çözülemedi", 502)
    return jsonify(ok=True, link=direct, format=fmt, kalite=kalite,
                   kaynak=DI_AD.get(item.get("kaynak"), "?"), baslik=item.get("baslik", ""),
                   cozulme_suresi=round(time.time() - t0, 1),
                   not_="Link motor CDN'indendir, kısa ömürlü olabilir — oynatma hatasında ucu yeniden çağırıp linki tazele. Sunucu dosyaya yazmaz, disk kullanılmaz.")


@app.get("/api/v1/stream")
@korumali
def stream_ep():
    """İndirmeden oynatma: 302 yönlendirme → direkt CDN linki.
    <audio src="/api/v1/stream?q=..."> veya <video src=...> ile doğrudan çalar."""
    fmt = _format_al(request.args, None)
    kalite = _kalite_al(request.args, None, fmt)
    if fmt is None:
        return _hata("format mp3 veya mp4 olabilir", 400)
    if kalite is None:
        return _hata("kalite, mp3'te 128/192/320; mp4'te 360/480/720/1080 olabilir", 400)
    item, h = _oynatma_sec(request.args, fmt)
    if h:
        return h
    direct, hata = api_core.link_coz_cached(item, fmt, kalite)
    if not direct:
        return _hata(hata or "link çözülemedi", 502)
    return redirect(direct, code=302)


@app.get("/api/v1/sozler")
@korumali
def sozler_ep():
    """Şarkı sözleri — düz metin + Spotify tarzı SENKRON (her satırın saniyesi var).
    Kaynak zinciri: lrclib.net -> YouTube otomatik altyazı."""
    q = (request.args.get("q") or "").strip()
    sanatci = (request.args.get("sanatci") or "").strip()
    try:
        sure = int(request.args.get("sure") or 0)
    except ValueError:
        return _hata("sure saniye cinsinden sayı olmalı", 400)
    if not q:
        return _hata("q parametresi gerekli", 400)
    d = api_core.sozler(q, sanatci, sure)
    if not d or not (d.get("plain") or d.get("satirlar")):
        return _hata("Sözler bulunamadı — başka isimle dene (örn: ?sanatci=tarkan&q=kuzu kuzu)", 404)
    satirlar = d.get("satirlar") or []
    return jsonify(ok=True, kaynak=d.get("kaynak"), sanatci=d.get("sanatci", ""),
                   sarki=d.get("sarki", ""), sure=d.get("sure", 0),
                   duz=d.get("plain") or "", senkron=d.get("synced") or "",
                   satirlar=satirlar, satir_sayisi=len(satirlar))


@app.get("/api/v1/status/<jid>")
@korumali
def status(jid):
    j = api_core.durum(jid)
    if not j:
        return _hata("iş bulunamadı", 404)
    out = dict(ok=True, **j)
    if j.get("dosya"):
        out["dosya_url"] = f"/api/v1/file/{j['dosya']}"
    return out


@app.get("/api/v1/file/<path:fname>")
@korumali
def file(fname):
    yol = api_core.dosya_yolu(fname)
    if not yol:
        abort(404)
    if "Range" not in request.headers:      # tam indirme (stream degil) -> teslim say
        api_core.teslim_edildi(fname)       # kisa sure icinde otomatik silinir (disk korumasi)
    mime = "video/mp4" if fname.lower().endswith(".mp4") else "audio/mpeg"
    return send_file(yol, mimetype=mime, as_attachment=True,
                     download_name=fname, conditional=True)


# ============================ KEY UÇLARI ============================

@app.get("/api/v1/keys/durum")
def keys_durum():
    return jsonify(ok=True,
                   admin_kilitli=depo.kilitli,
                   olusturma_acik=depo.olusturma_acik,
                   depolama=("github" if depo.token else "yerel"),
                   key_sayisi=len(depo.anahtarlar))


@app.post("/api/v1/keys/olustur")
def keys_olustur():
    h = _admin_kontrol()
    if h:
        return h
    d = request.get_json(silent=True) or {}
    isim = (d.get("isim") or "").strip()
    if not isim:
        return _hata("Key'e bir isim ver (örn. 'Discord botum')", 400)
    key, kayit = depo.olustur(isim, d.get("saglayicilar"))
    return jsonify(ok=True, key=key, isim=kayit["isim"],
                   saglayicilar=kayit["saglayicilar"],
                   mesaj="Key oluşturuldu ve kalıcı olarak saklandı")


@app.get("/api/v1/keys/liste")
def keys_liste():
    h = _admin_kontrol()
    if h:
        return h
    return jsonify(ok=True, keyler=[
        {"key": k, **v} for k, v in sorted(depo.anahtarlar.items(),
                                           key=lambda kv: kv[1].get("olusturma", ""), reverse=True)])


@app.post("/api/v1/keys/sil")
def keys_sil():
    h = _admin_kontrol()
    if h:
        return h
    d = request.get_json(silent=True) or {}
    if not d.get("key"):
        return _hata("key gerekli", 400)
    return jsonify(ok=depo.sil(d["key"]))


# ============================ ARAYÜZ ============================

@app.get("/")
def arayuz():
    return """<!DOCTYPE html>
<html lang="tr"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>🎵 Şarkı API — Key</title>
<style>
*{box-sizing:border-box;margin:0;padding:0}
body{font-family:-apple-system,'Segoe UI',Roboto,sans-serif;background:#0b0f1a;color:#eef1f8;min-height:100vh;padding:40px 16px;line-height:1.6}
.sar{max-width:640px;margin:0 auto}
h1{background:linear-gradient(90deg,#7c5cff,#00d4ff);-webkit-background-clip:text;background-clip:text;color:transparent;font-size:30px;text-align:center}
p.ac{color:#8b94ad;text-align:center;margin-bottom:8px;font-size:15px}
.pill{display:flex;justify-content:center;gap:8px;margin-bottom:28px;font-size:13px}
.nokta{display:inline-block;width:8px;height:8px;border-radius:50%;background:#facc15;box-shadow:0 0 8px #facc15}
.nokta.yesil{background:#4ade80;box-shadow:0 0 8px #4ade80}
.kart{background:#131a2b;border:1px solid #26304d;border-radius:16px;padding:26px;margin-bottom:16px}
.buyuk{display:block;width:100%;padding:16px;font-size:19px;font-weight:800;border:none;border-radius:14px;cursor:pointer;background:linear-gradient(90deg,#7c5cff,#00d4ff);color:#0b0f1a;transition:transform .1s}
.buyuk:hover{transform:translateY(-2px)}
.buyuk:disabled{opacity:.5;cursor:wait}
.baslik2{font-size:18px;font-weight:800;margin-bottom:14px}
.uyari{background:#2b1d0d;border:1px solid #6b4f12;color:#fbbf24;border-radius:10px;padding:10px 14px;font-size:13px;margin-bottom:14px;display:none}
input[type=text],input[type=password]{width:100%;background:#0d1322;border:1px solid #26304d;border-radius:10px;color:#eef1f8;padding:12px 14px;font-size:15px;outline:none}
input:focus{border-color:#7c5cff}
.etiket{font-size:13px;color:#8b94ad;margin:14px 0 6px;font-weight:600}
.cipler{display:flex;flex-wrap:wrap;gap:8px}
.cip{padding:9px 14px;border-radius:999px;border:1px solid #26304d;background:#0d1322;color:#a9b4cc;font-size:14px;cursor:pointer;user-select:none;transition:.12s}
.cip.secili{background:linear-gradient(90deg,#3b2f7a,#0e4f5a);border-color:#7c5cff;color:#fff;font-weight:700}
.btn2{padding:12px 18px;border:none;border-radius:10px;font-size:15px;font-weight:700;cursor:pointer}
.btn2.ana{background:linear-gradient(90deg,#7c5cff,#00d4ff);color:#0b0f1a}
.btn2.ikincil{background:#1c2438;color:#a9b4cc}
.satir{display:flex;gap:10px;justify-content:flex-end;margin-top:20px}
.keykutu{background:#0d1322;border:1px dashed #7c5cff;border-radius:10px;padding:14px;font-family:monospace;font-size:15px;color:#00d4ff;word-break:break-all;text-align:center;margin:14px 0}
.kopya{background:#1c2438;border:1px solid #26304d;color:#eef1f8;border-radius:8px;padding:6px 12px;font-size:13px;cursor:pointer;margin:4px 4px 0 0}
.kopya:hover{border-color:#00d4ff;color:#00d4ff}
.keyKart{background:#0d1322;border:1px solid #26304d;border-radius:12px;padding:14px;margin-bottom:10px}
.keyAd{font-weight:800;font-size:15px}
.keyTarih{color:#5d6784;font-size:12px;margin-left:8px}
.keyKey{font-family:monospace;font-size:13px;color:#00d4ff;margin:8px 0;word-break:break-all;cursor:pointer}
.rozet{display:inline-block;font-size:11px;font-weight:700;border-radius:6px;padding:2px 8px;margin-right:4px;background:#1c2438;color:#a9b4cc}
.rozet.yt{background:#3b1212;color:#f87171}.rozet.sc{background:#3b2a12;color:#fb923c}.rozet.ia{background:#122d3b;color:#38bdf8}.rozet.tm{background:#231b3b;color:#a78bfa}
.sil{float:right;background:none;border:none;color:#5d6784;font-size:16px;cursor:pointer}
.sil:hover{color:#f87171}
details{background:#131a2b;border:1px solid #26304d;border-radius:12px;padding:14px 18px;margin-bottom:16px}
summary{cursor:pointer;color:#a9b4cc;font-weight:600;font-size:14px}
pre{background:#0d1322;border-radius:10px;padding:12px;overflow-x:auto;font-size:12.5px;color:#c8d3f0;margin-top:10px}
footer{text-align:center;color:#4d5570;font-size:12px;margin-top:26px}
footer a{color:#5d6784}
.bos{color:#5d6784;text-align:center;padding:18px;font-size:14px}
/* modal */
.perde{position:fixed;inset:0;background:rgba(4,7,14,.8);display:none;align-items:center;justify-content:center;padding:16px;z-index:50}
.perde.acik{display:flex}
.modal{background:#131a2b;border:1px solid #33406b;border-radius:18px;padding:26px;width:100%;max-width:440px}
.x{float:right;background:none;border:none;color:#5d6784;font-size:20px;cursor:pointer}
.tamam{color:#4ade80;font-weight:800;font-size:17px;margin-bottom:4px}
</style></head><body><div class="sar">

<h1>🎵 Şarkı API</h1>
<p class="ac">Kişisel müzik indirme servisin — YouTube + SoundCloud + Archive.org</p>
<div class="pill"><span class="nokta" id="nk"></span><span id="nkYazi" style="color:#8b94ad">kontrol ediliyor…</span></div>

<div class="uyari" id="uyariKutu"></div>

<div class="kart" id="hero">
  <div class="baslik2">API Key'inle her projeden kullan 🔑</div>
  <p style="color:#8b94ad;font-size:14px;margin-bottom:16px">Bir key oluştur, sağlayıcılarını seç, kopyala — bitti. Key'in <b>kalıcıdır</b>, silinmez; eski keylerine her zaman aşağıdaki listeden ulaşırsın.</p>
  <button class="buyuk" onclick="modalAc()">🔑 Key Oluştur</button>
</div>

<div class="kart">
  <div class="baslik2">📁 Keylerim <span id="ks" style="color:#5d6784;font-size:13px;font-weight:400"></span></div>
  <div id="parolaSatir" style="display:none;margin-bottom:12px">
    <input type="password" id="parolaListe" placeholder="Yönetici şifresi" onkeydown="if(event.key==='Enter')listeYukle()">
    <button class="kopya" style="margin-top:8px" onclick="listeYukle()">📂 Listele</button>
  </div>
  <div id="keyListe"><div class="bos">—</div></div>
</div>

<details>
  <summary>📖 Hızlı kullanım (key'ini nasıl kullanırsın?)</summary>
  <pre id="ornek"></pre>
  <pre id="ornek2"></pre>
</details>

<footer>🎵 Şarkı API v2.0 • <a href="/dokuman">detaylı dokümantasyon</a> • Render + GitHub backed</footer>
</div>

<!-- MODAL -->
<div class="perde" id="perde" onclick="if(event.target===this)modalKapat()">
<div class="modal">
  <button class="x" onclick="modalKapat()">✕</button>
  <div id="mForm">
    <div class="baslik2">Yeni Key 🔑</div>
    <div class="etiket">Key'in adı ne olsun?</div>
    <input type="text" id="yIsim" placeholder="örn. Discord botum" maxlength="48">
    <div class="etiket">Hangi indirme sağlayıcıları?</div>
    <div class="cipler" id="cipler">
      <div class="cip secili" data-s="tumu" onclick="cip('tumu')">✨ Tümü</div>
      <div class="cip" data-s="youtube" onclick="cip('youtube')">▶️ YouTube</div>
      <div class="cip" data-s="soundcloud" onclick="cip('soundcloud')">☁️ SoundCloud</div>
      <div class="cip" data-s="archive" onclick="cip('archive')">📼 Archive.org</div>
    </div>
    <div class="etiket" id="parolaEtiket" style="display:none">Yönetici şifresi</div>
    <input type="password" id="yParola" style="display:none" placeholder="••••••••">
    <div class="satir">
      <button class="btn2 ikincil" onclick="modalKapat()">Vazgeç</button>
      <button class="btn2 ana" id="btnOlustur" onclick="olustur()">✨ Oluştur</button>
    </div>
  </div>
  <div id="mTamam" style="display:none">
    <div class="tamam">Key hazır! 🎉</div>
    <div style="color:#8b94ad;font-size:14px" id="tBilgi"></div>
    <div class="keykutu" id="tKey"></div>
    <div style="text-align:center">
      <button class="kopya" onclick="kopyala(document.getElementById('tKey').innerText,this)">📋 Kopyala</button>
    </div>
    <p style="color:#5d6784;font-size:12.5px;margin-top:12px">Bu key kalıcı olarak saklandı — "Keylerim" listesinden her zaman geri bulabilirsin.</p>
    <div class="satir">
      <button class="btn2 ikincil" onclick="tekrarOlustur()">+ Yeni key</button>
      <button class="btn2 ana" onclick="modalKapat()">Tamam</button>
    </div>
  </div>
</div>
</div>

<script>
let DURUM=null, SECIM=new Set(["tumu"]), SONKEY=null;
const $=id=>document.getElementById(id);
const ls={get:k=>{try{return localStorage.getItem(k)}catch(e){return null}},set:(k,v)=>{try{localStorage.setItem(k,v)}catch(e){}}};

async function jget(u){const r=await fetch(u);return r.json()}
async function jpost(u,d){const r=await fetch(u,{method:"POST",headers:{'Content-Type':'application/json'},body:JSON.stringify(d)});return r.json()}

async function yukle(){
  try{
    DURUM=await jget('/api/v1/keys/durum');
    await jget('/api/v1/health');
    $('nk').className='nokta yesil';$('nkYazi').textContent='çevrimiçi';
  }catch(e){$('nkYazi').textContent='çevrimdışı';}
  if(DURUM){
    const u=[];
    if(!DURUM.olusturma_acik)u.push('⚠️ Key oluşturma kapalı — sunucuda <b>ADMIN_PAROLA</b> ayarlanmamış (Render → Environment).');
    if(DURUM.depolama!=='github')u.push('⚠️ Kalıcı depolama kapalı — <b>GITHUB_TOKEN</b> ayarlanmamış, keyler restart\\'ta silinebilir!');
    if(u.length){$('uyariKutu').innerHTML=u.join('<br>');$('uyariKutu').style.display='block'}
    if(DURUM.admin_kilitli){$('parolaEtiket').style.display='block';$('yParola').style.display='block';
      $('parolaSatir').style.display='block';
      $('yParola').value=ls.get('sk_parola')||'';
      $('parolaListe').value=ls.get('sk_parola')||'';
      if($('parolaListe').value)listeYukle();
    }else if(DURUM.key_sayisi>0||true){listeYukle()}
  }
  ornekYaz();
}
function ornekYaz(){
  const k=SONKEY||'SENİN_KEY';
  $('ornek').textContent='curl "'+location.origin+'/api/v1/instant?q=tarkan kuzu kuzu&key='+k+'"';
  $('ornek2').textContent='→ status → dosya_url ile mp3\\'yi al. Tüm uçlar: /dokuman';
}
function cip(s){
  if(s==='tumu')SECIM=new Set(['tumu']);
  else{SECIM.delete('tumu');SECIM.has(s)?SECIM.delete(s):SECIM.add(s);if(!SECIM.size)SECIM.add('tumu')}
  document.querySelectorAll('.cip').forEach(e=>e.classList.toggle('secili',SECIM.has(e.dataset.s)));
}
function modalAc(){$('mForm').style.display='block';$('mTamam').style.display='none';$('perde').classList.add('acik');setTimeout(()=>$('yIsim').focus(),50)}
function modalKapat(){$('perde').classList.remove('acik')}
function tekrarOlustur(){$('mTamam').style.display='none';$('mForm').style.display='block';$('yIsim').value='';$('yIsim').focus()}

async function olustur(){
  const isim=$('yIsim').value.trim();
  if(!isim){$('yIsim').focus();return}
  $('btnOlustur').disabled=true;$('btnOlustur').textContent='oluşturuluyor…';
  const d=await jpost('/api/v1/keys/olustur',{isim:isim,saglayicilar:[...SECIM],parola:$('yParola').value});
  $('btnOlustur').disabled=false;$('btnOlustur').textContent='✨ Oluştur';
  if(!d.ok){alert(d.hata||'hata');return}
  if($('yParola').value)ls.set('sk_parola',$('yParola').value);
  SONKEY=d.key;ls.set('sk_sonkey',d.key);
  const rz=d.saglayicilar.map(rozet).join(' ');
  $('tBilgi').innerHTML='<b>'+isim+'</b> — '+rz;
  $('tKey').textContent=d.key;
  $('mForm').style.display='none';$('mTamam').style.display='block';
  ornekYaz();listeYukle();
}
function rozet(s){
  const m={tumu:['tm','✨ Tümü'],youtube:['yt','▶️ YouTube'],soundcloud:['sc','☁️ SoundCloud'],archive:['ia','📼 Archive']};
  const[c,a]=m[s]||['','?'];return '<span class="rozet '+c+'">'+a+'</span>';
}
async function listeYukle(){
  const p=DURUM&&DURUM.admin_kilitli?('?parola='+encodeURIComponent($('parolaListe').value||'')):'';
  const d=await jget('/api/v1/keys/liste'+p).catch(()=>null);
  if(!d||!d.ok){$('keyListe').innerHTML='<div class="bos">'+(d&&d.hata?d.hata:'liste alınamadı')+'</div>';return}
  if(DURUM&&DURUM.admin_kilitli&&$('parolaListe').value)ls.set('sk_parola',$('parolaListe').value);
  $('ks').textContent='('+d.keyler.length+')';
  if(!d.keyler.length){$('keyListe').innerHTML='<div class="bos">henüz key yok — yukarıdan oluştur 🔑</div>';return}
  $('keyListe').innerHTML=d.keyler.map(k=>
    '<div class="keyKart"><button class="sil" title="sil" data-k="'+k.key+'" data-n="'+esc(k.isim)+'">🗑</button>'+
    '<span class="keyAd">'+esc(k.isim)+'</span><span class="keyTarih">'+k.olusturma+' • '+k.kullanim+' kullanım</span>'+
    '<div class="keyKey" data-k="'+k.key+'" title="tıkla: kopyala">'+k.key+'</div>'+
    (k.saglayicilar||[]).map(rozet).join(' ')+'</div>').join('');
}
document.addEventListener('click',e=>{
  const t=e.target.closest&&e.target.closest('.sil');
  if(t){sil(t.dataset.k,t.dataset.n);return}
  const kk=e.target.closest&&e.target.closest('.keyKey');
  if(kk)kopyala(kk.dataset.k,kk);
});
async function sil(key,isim){
  if(!confirm('"'+isim+'" keyi silinsin mi? Kullanan projeler artık erişemez!'))return;
  const p=DURUM&&DURUM.admin_kilitli?$('parolaListe').value:'';
  const d=await jpost('/api/v1/keys/sil',{key:key,parola:p});
  if(d.ok)listeYukle();else alert(d.hata||'silinemedi');
}
function esc(s){return (s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')}
function kopyala(t,btn){
  (navigator.clipboard?navigator.clipboard.writeText(t):Promise.reject()).then(
    ()=>gosterge(),()=>{const ta=document.createElement('textarea');ta.value=t;document.body.appendChild(ta);ta.select();try{document.execCommand('copy');gosterge()}catch(e){}ta.remove()});
  function gosterge(){SONKEY=t;ls.set('sk_sonkey',t);ornekYaz();
    const b=btn;if(b){const e=b.textContent;b.textContent='✓ kopyalandı';setTimeout(()=>b.textContent=e,1200)}}
}
SONKEY=ls.get('sk_sonkey')||null;
yukle();
</script>
</body></html>"""


@app.get("/dokuman")
def dokuman():
    return """<!DOCTYPE html>
<html lang="tr"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>🎵 Şarkı API — Doküman</title>
<style>
*{box-sizing:border-box;margin:0;padding:0}
body{font-family:-apple-system,'Segoe UI',Roboto,sans-serif;background:#0b0f1a;color:#eef1f8;padding:32px 18px;line-height:1.6}
.sar{max-width:880px;margin:0 auto}
h1{background:linear-gradient(90deg,#7c5cff,#00d4ff);-webkit-background-clip:text;background-clip:text;color:transparent;font-size:30px;margin-bottom:6px}
p.ac{color:#8b94ad;margin-bottom:24px}
.kart{background:#131a2b;border:1px solid #26304d;border-radius:14px;padding:18px;margin-bottom:14px}
.yol{font-family:monospace;font-weight:700;color:#00d4ff;font-size:15px}
.etiket{display:inline-block;font-size:11px;font-weight:700;border-radius:6px;padding:2px 8px;margin-left:8px;vertical-align:middle}
.get{background:#0d3b2e;color:#4ade80}.post{background:#3b2f0d;color:#facc15}
.acik{color:#a9b4cc;font-size:14px;margin:8px 0}
pre{background:#0d1322;border-radius:10px;padding:12px;overflow-x:auto;font-size:13px;color:#c8d3f0;margin-top:8px}
code{background:#0d1322;padding:2px 6px;border-radius:6px;font-size:13px}
footer{color:#4d5570;font-size:12px;text-align:center;margin-top:30px}
a{color:#5d6784}
.sun{color:#7c5cff;font-weight:700}
</style></head><body><div class="sar">
<h1>🎵 Şarkı API — Doküman</h1>
<p class="ac">Kişisel müzik indirme servisi — YouTube + SoundCloud + Archive.org. <a href="/">← Key arayüzüne dön</a></p>

<div class="kart">
<span class="yol">🔑 Key Sistemi</span>
<p class="acik">Ana sayfadan key oluştur. Sonra tüm çağrılara <code>?key=SENİN_KEY</code> ekle (veya <code>X-API-Key</code> başlığı).
Key'in sadece seçtiğin sağlayıcılara erişir. Keyler GitHub'da kalıcı saklanır, sunucu restartlarında silinmez.</p>
<pre>curl "<span class="sun">SUNUCU</span>/api/v1/search?q=müslüm gürses affet&key=sk-..."</pre>
</div>

<div class="kart">
<span class="yol">GET /api/v1/health</span><span class="etiket get">GET</span>
<p class="acik">Servis sağlığı (key gerekmez).</p>
</div>

<div class="kart">
<span class="yol">GET /api/v1/search?q={sorgu}&limit=20</span><span class="etiket get">GET</span>
<p class="acik">3 kaynağı <b>paralel</b> tarar (~1 sn). Varsayılan <b>20</b>, en fazla <b>30</b> sonuç; kaynaklar karışık sıralanır. Aynı sorgu 15 dk <b>önbellekten anında</b> döner ( yanıtta <code>onbellek: true</code>).</p>
<pre>→ {"ok":true,"sonuclar":[{"id":0,"kaynak":"youtube","baslik":"...","kanal":"...","sure":276,"url":"https://..."}]}</pre>
</div>

<div class="kart">
<span class="yol">GET /api/v1/instant?q={sorgu}&format=mp4&kalite=720</span><span class="etiket get">GET</span>
<p class="acik">Ara + <b>en iyi sonucu otomatik indir</b>. Tek çağrıda iş başlar. <code>format</code>: <b>mp3</b> (varsayılan) veya <b>mp4 video</b>. <code>kalite</code>: mp3'te 128/192/320, mp4'te 360/480/720/1080. Video yalnız YouTube kaynaklarında.</p>
<pre>→ {"ok":true,"job_id":"a1b2c3d4e5","secilen":{...},"durum_url":"/api/v1/status/a1b2c3d4e5"}</pre>
</div>

<div class="kart">
<span class="yol">POST /api/v1/convert</span><span class="etiket post">POST</span>
<p class="acik">Seçtiğin URL'yi indirir (YouTube/SoundCloud/Archive linki).</p>
<pre>curl -X POST <span class="sun">SUNUCU</span>/api/v1/convert?key=sk-... \\
     -H "Content-Type: application/json" \\
     -d '{"url":"https://www.youtube.com/watch?v=...","baslik":"Şarkı Adı","kaynak":"youtube"}'</pre>
</div>

<div class="kart">
<span class="yol">GET /api/v1/status/{job_id}</span><span class="etiket get">GET</span>
<p class="acik">İşin durumu: yüzde, mesaj, bitince <code>dosya_url</code>.</p>
<pre>→ {"ok":true,"durum":"bitti","yuzde":100,"dosya":"Tarkan - Kuzu Kuzu.mp3","dosya_url":"/api/v1/file/..."}</pre>
</div>

<div class="kart">
<span class="yol">GET /api/v1/file/{dosya}</span><span class="etiket get">GET</span>
<p class="acik">Mp3 dosyası (stream + Range). URL'e <code>&key=</code> eklemeyi unutma.</p>
</div>

<div class="kart">
<span class="yol">JS / Python örneği</span>
<pre>const r = await fetch("/api/v1/instant?q=wegh affettim&key=sk-...").then(r=>r.json());
let s; do { s = await fetch(r.durum_url+"&key=sk-...").then(r=>r.json()); await new Promise(t=>setTimeout(t,1000)); } while(s.durum==="indiriliyor");
location.href = s.dosya_url + "&key=sk-...";

import requests, time
K = "sk-..."
r = requests.get("https://mp3-apisi.onrender.com/api/v1/instant", params={"q":"muslum affet","key":K}).json()
while True:
    s = requests.get("https://mp3-apisi.onrender.com"+r["durum_url"], params={"key":K}).json()
    if s["durum"] in ("bitti","hata"): break
    time.sleep(1)
print(s.get("dosya_url"))</pre>
</div>

<div class="kart">
<span class="yol">GET /api/v1/sozler?q={sarkı}&sanatci={sanatçı}&sure={saniye}</span><span class="etiket get">GET</span>
<p class="acik">Şarkı sözleri — <b>düz metin</b> + <b>Spotify tarzı senkron</b> (<code>satirlar</code>: her satırın saniyesi <code>t</code>). Kaynak: lrclib → YouTube altyazı. <b>İpucu:</b> <code>sure</code> parametresine çalan kaydın süresini ver — aynı şarkının versiyonları (cover/demo/extended) arasından doğru damgalı olan otomatik seçilir.</p>
<pre>→ {"ok":true,"kaynak":"lrclib","satirlar":[{"t":12.4,"metin":"Kuzu kuzu..."},...],"duz":"..."}

// uygulama örneği: aktif satırı bul
const aktif = satirlar.filter(s => s.t <= player.currentTime).length - 1;</pre>
</div>

<div class="kart">
<span class="yol">GET /api/v1/link?q={sorgu}&format=mp3</span> <span class="yol">GET /api/v1/stream?q={sorgu}</span><span class="etiket get">GET</span>
<p class="acik"><b>İndirmeden oynatma!</b> Şarkıyı/videoyu sunucuya indirmez — <b>direkt CDN linkini</b> verir: <code>link</code> JSON döner, <code>stream</code> 302 yönlendirir (oynatıcıya koy, çalsın). SoundCloud ~1 sn, YouTube 3-10 sn (dönüşüm), Archive anında. Disk kullanılmaz.</p>
<pre>&lt;audio src="https://SUNUCU/api/v1/stream?q=tarkan kuzu kuzu&key=sk-..."&gt;&lt;/audio&gt;
&lt;video src="https://SUNUCU/api/v1/stream?q=klip adı&format=mp4&kalite=720&key=sk-..."&gt;&lt;/video&gt;

// veya linki kendin al:
const d = await fetch(".../api/v1/link?q=şarkı&key=...").then(r=>r.json());
player.src = d.link;   // direkt CDN — hızlı akar</pre>
</div>

<div class="kart">
<span class="yol">⚡ Performans & Disk Politikası</span>
<p class="acik">
• <b>Arama önbelleği:</b> aynı sorgu 15 dk boyunca ~0.01 sn'de döner.<br>
• <b>Kalite seçimi:</b> <code>&kalite=128|192|320</code> (YouTube motoru; SoundCloud 128 sabit).<br>
• <b>Otomatik temizlik:</b> dosya karşıya yollandıktan ~90 sn sonra kendiliğinden silinir; hiçbir dosya 30 dk'dan uzun kalmaz; disk 150 MB / 80 dosyayı geçemez → <b>sunucu asla dolmaz</b>.<br>
• <b>Nöbetçi:</b> GitHub Actions 10 dk'da bir health check eder; ölürse repoya sorun açar.
</p>
</div>

<div class="kart">
<span class="yol">Yönetim (parola korumalı)</span>
<p class="acik"><code>POST /api/v1/keys/olustur</code> {isim, saglayicilar, parola} · <code>GET /api/v1/keys/liste?parola=</code> · <code>POST /api/v1/keys/sil</code> {key, parola}</p>
</div>

<div class="kart">
<p class="acik"><b>Kaynaklar:</b> ▶️ YouTube 3-15 sn / 320 kbps · ☁️ SoundCloud 1-3 sn / 128 kbps · 📼 Archive.org 1-2 sn</p>
</div>

<footer>🎵 Şarkı API v2.0 — key yönetimi + kalıcı depolama • Kişisel kullanım</footer>
</div></body></html>"""


if __name__ == "__main__":
    app.run(host="0.0.0.0", port=int(os.environ.get("PORT", 7900)), debug=False, threaded=True)
