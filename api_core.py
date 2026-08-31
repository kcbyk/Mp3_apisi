# -*- coding: utf-8 -*-
"""
API çekirdegi — framework'ten bagimsiz (Flask/FastAPI ikisinde de kullanilir).
telegram_bot.py'nin motorlarini (YT/SC/IA) REST API icin paketler.

v3:
  - ARAMA ONBELLEGI: ayni sorgu TTL boyunca anidan doner (0.05 sn)
  - KALITE DESTEGI: yt_indir'e kalite (128/192/320) aktarilir
  - AKILLI TEMIZLIK: dosyalar teslim edildikten sonra silinir; disk/asiri dosya
    sinirlari asilirsa en eskiden silinir -> sunucu hic dolmaz
  - Ayni URL'a gelen ikinci istek ayni ise baglanir (dedup)
"""
import math
import os
import threading
import time
import uuid
from concurrent.futures import ThreadPoolExecutor

import telegram_bot as core

jobs = {}  # job_id -> durum bilgisi

# ------------------- AYARLAR (env ile oynanabilir) -------------------
CACHE_TTL       = int(os.environ.get("SARKI_CACHE_TTL", "900"))       # arama önbelleki: 15 dk
CACHE_MAX       = int(os.environ.get("SARKI_CACHE_MAX", "200"))       # en fazla önbellek girdisi
DOSYA_OMUR      = int(os.environ.get("SARKI_DOSYA_OMUR", "1800"))     # dosya ömrü: 30 dk
TESLIM_GECIKME  = int(os.environ.get("SARKI_TESLIM_GECIKME", "90"))   # tam indirme sonrası silme: 90 sn
DISK_MB         = int(os.environ.get("SARKI_DISK_MB", "150"))         # muzik/ üst limiti
MAX_DOSYA       = int(os.environ.get("SARKI_MAX_DOSYA", "80"))        # dosya adet üst limiti
TEMIZLIK_DONGU  = int(os.environ.get("SARKI_TEMIZLIK_DONGU", "30"))   # temizlik turu: 30 sn
JOB_OMUR        = int(os.environ.get("SARKI_JOB_OMUR", "3600"))       # iş kaydı ömrü: 1 sa

# ------------------- ARAMA ONBELLEGI -------------------
_ARAMA_CACHE = {}          # anahtar -> (zaman, sonuc)
_cache_kilit = threading.Lock()
cache_vurdu = False        # son ara() cagrisinda önbellekten mi geldi (bilgi amaçli)


def _cache_anahtar(q, limit, kaynaklar):
    return (q.strip().lower(), int(limit), tuple(sorted(kaynaklar or ("yt", "sc", "ia"))))


def ara(q, limit=8, kaynaklar=None):
    """Uc kaynagi paralel tarar; round-robin karisik liste dondurur.
    Ayni sorgu CACHE_TTL boyunca onbellekten aninda doner."""
    global cache_vurdu
    anahtar = _cache_anahtar(q, limit, kaynaklar)
    simdi = time.time()
    with _cache_kilit:
        kayit = _ARAMA_CACHE.get(anahtar)
        if kayit and simdi - kayit[0] < CACHE_TTL:
            cache_vurdu = True
            return kayit[1]
        cache_vurdu = False

    KAP = {"yt": 20, "sc": 15, "ia": 10}
    ORAN = {"yt": 0.7, "sc": 0.5, "ia": 0.35}
    if kaynaklar is None:
        kaynaklar = set(KAP)
    istenen = {}
    for k in kaynaklar:
        istenen[k] = min(KAP[k], max(4, math.ceil(limit * ORAN[k])))
    if len(kaynaklar) == 1:  # tek kaynak -> tam limit dene
        k = next(iter(kaynaklar))
        istenen[k] = min(KAP[k], limit)
    with ThreadPoolExecutor(max_workers=3) as ex:
        futures = {}
        if "sc" in istenen:
            futures["sc"] = ex.submit(core.sc_fast_ara, q, istenen["sc"])
        if "yt" in istenen:
            futures["yt"] = ex.submit(core.yt_ara_katman, q, istenen["yt"])
        if "ia" in istenen:
            futures["ia"] = ex.submit(core.archive_ara, q, istenen["ia"])
        toplam = {}
        for k, f in futures.items():
            try:
                toplam[k] = f.result(timeout=15)
            except Exception:
                toplam[k] = []
    yt, sc, ia = toplam.get("yt", []), toplam.get("sc", []), toplam.get("ia", [])
    birlesik = []
    for i in range(max(len(yt), len(sc), len(ia))):
        for src in (yt, sc, ia):
            if i < len(src):
                birlesik.append(src[i])
    sonuc = birlesik[:limit]

    if sonuc:  # bos sonuclar onbelleklenmez
        with _cache_kilit:
            if len(_ARAMA_CACHE) >= CACHE_MAX:  # en eskiyi at
                eski = min(_ARAMA_CACHE, key=lambda a: _ARAMA_CACHE[a][0])
                _ARAMA_CACHE.pop(eski, None)
            _ARAMA_CACHE[anahtar] = (time.time(), sonuc)
    return sonuc


# ------------------- SOZ ONBELLEGI (24 saat) -------------------
_SOZ_CACHE = {}


def sozler(q, sanatci="", sure=0):
    """Sözleri getirir: lrclib (senkron) -> YouTube altyazısı. 24 sa önbellekli.
    sure: çalınan kaydın süresi (sn) — aynı şarkının versiyonlarından en yakını seçilir."""
    anahtar = (q.strip().lower(), (sanatci or "").strip().lower(), int(sure or 0))
    k = _SOZ_CACHE.get(anahtar)
    if k and time.time() - k[0] < 86400:
        return k[1]
    d = core.sozler_bul(q, sanatci, int(sure or 0))
    if d and (d.get("plain") or d.get("satirlar")):
        _SOZ_CACHE[anahtar] = (time.time(), d)
    return d


# ------------------- INDIRMEDEN OYNATMA (direct link) -------------------

def link_coz(item, fmt="mp3", kalite="320"):
    """Sonucu, INDIRMEDEN oynatilabilecek direkt CDN linkine cevirir. (url, hata)
    Sunucu diske hic yazmaz; oynatici linkten dogrudan akitar."""
    k = item.get("kaynak")
    if k == "yt":
        u = core._yt_dl_url_bul(item["url"], None, str(kalite),
                                "mp4" if fmt == "mp4" else "mp3")
        return (u, None) if u else (None, "Dönüşüm linki alınamadı (motorlar meşgul olabilir)")
    if k == "sc":
        prog = item.get("sc_prog_url") or core.sc_prog_url_bul(item.get("url"))
        u = core.sc_direct_url(prog)
        return (u, None) if u else (None, "SoundCloud linki alınamadı (bu parça HLS olabilir — convert ile indir)")
    if k == "ia":
        u = core.archive_direct_url(item.get("ia_id"), item.get("baslik", ""))
        return (u, None) if u else (None, "Arşiv linki alınamadı")
    return None, "bilinmeyen kaynak"


# ------------------- LINK ONBELLEGI + ONIZLEME (pre-warm) -------------------
LINK_CACHE = {}                       # (url, fmt, kalite) -> (zaman, direct_url)
LINK_TTL = int(os.environ.get("SARKI_LINK_TTL", "480"))   # link ~8 dk gecerli
_link_kilidi = threading.Lock()
LINK_BEKLE = {}                       # anahtar -> {"event", "sonuc"} — devam eden çözümler


def link_coz_cached(item, fmt="mp3", kalite="320", bekleme_sn=35):
    """Önbellekli + KETLENMELİ link çözümleme:
    - çözülmüşse anında döner,
    - aynı link şu an çözülüyorsa ONA KATILIR (yeni dönüşüm başlatmaz, kalanı bekler),
    - yoksa çözer ve önbelleğe koyar."""
    a = (item.get("url"), fmt, str(kalite))
    with _link_kilidi:
        k = LINK_CACHE.get(a)
        if k and time.time() - k[0] < LINK_TTL:
            return k[1], None
        if a in LINK_BEKLE:
            kayit = LINK_BEKLE[a]
            ben_cozuceem = False
        else:
            kayit = {"event": threading.Event(), "sonuc": None}
            LINK_BEKLE[a] = kayit
            ben_cozuceem = True
    if not ben_cozuceem:
        kayit["event"].wait(bekleme_sn)          # pre-warm'ın bitmesini bekle (kalan süre)
        return kayit["sonuc"] or (None, "link çözülmesi zaman aşımına uğradı — tekrar dene")
    u, h = None, "çözüm hatası"
    try:
        u, h = link_coz(item, fmt, kalite)
        if u:
            with _link_kilidi:
                if len(LINK_CACHE) > 60:         # kapasite korumasi
                    eski = min(LINK_CACHE, key=lambda x: LINK_CACHE[x][0])
                    LINK_CACHE.pop(eski, None)
                LINK_CACHE[a] = (time.time(), u)
        return u, h
    finally:
        kayit["sonuc"] = (u, h)
        kayit["event"].set()
        with _link_kilidi:
            LINK_BEKLE.pop(a, None)


def onizleme_baslat(sonuclar):
    """Arama sonrasi ilk YouTube sonucunun (mp3 + mp4) linklerini ARKA PLANDA cozer.
    Kullanici listeye bakarken donusum biter -> bastigi an link hazir (aninda acilir)."""
    yt = next((s for s in sonuclar if s.get("kaynak") == "yt"), None)
    if not yt:
        return
    for fmt, kal in (("mp3", "320"), ("mp4", "360")):
        threading.Thread(target=link_coz_cached, args=(dict(yt), fmt, kal),
                         daemon=True).start()


# ------------------- IS (JOB) YONETIMI + DEDUP -------------------
_url_kilit = threading.Lock()
URL_IS = {}   # url -> job_id (ayni sarkiya baglanan istekler)


def job_baslat(item, sorgu=""):
    """Bir sonucu arka planda indirir; job_id dondurur.
    Ayni URL zaten iniyor/hazirsa ayni job_id doner (ketlenme yok)."""
    url = item.get("url") or ""
    with _url_kilit:
        eski = URL_IS.get(url)
        if eski:
            j = jobs.get(eski)
            dosya_var = bool(j and j.get("dosya") and (core.MUZIK / j["dosya"]).exists())
            if j and (j.get("durum") in ("kuyrukta", "indiriliyor") or dosya_var):
                return eski
        jid = uuid.uuid4().hex[:10]
        URL_IS[url] = jid
    jobs[jid] = {"durum": "kuyrukta", "yuzde": 0, "mesaj": "Sırada...",
                 "hata": None, "dosya": None, "baslik": item.get("baslik", ""),
                 "t0": time.time(), "teslim": False}

    def iler(p, m):
        j = jobs[jid]
        if p is None:
            j.update(mesaj=m)
        else:
            j.update(yuzde=max(2, min(99, int(p))), mesaj=m)

    def gorev():
        j = jobs[jid]
        j["durum"] = "indiriliyor"
        t0 = time.time()
        try:
            kaynak = item.get("kaynak")
            if kaynak == "yt" and item.get("format") == "mp4":
                dosya, hata = core.yt_video_indir(item["url"], item["baslik"], iler,
                                                  sure=item.get("sure", 0),
                                                  kalite=str(item.get("kalite", "720")))
            elif kaynak == "yt":
                dosya, hata = core.yt_indir(item["url"], item["baslik"], iler,
                                            sure=item.get("sure", 0),
                                            kalite=str(item.get("kalite", "320")))
            elif kaynak == "ia":
                dosya, hata = core.archive_indir(item["ia_id"], item["baslik"],
                                                 sorgu or item["baslik"], iler)
            else:
                dosya, hata = core.sc_fast_indir(item, iler)
                if not dosya:
                    dosya, hata = core.sarki_indir(item["url"], item["baslik"], iler,
                                                   kanal=item.get("kanal", ""))
            if dosya and (core.MUZIK / dosya).exists():
                j.update(durum="bitti", yuzde=100, dosya=dosya, mesaj="Hazır",
                         sure=time.time() - t0, hazir_t=time.time())
            else:
                j.update(durum="hata", hata=str(hata)[:250])
        except Exception as ex:
            j.update(durum="hata", hata=f"{type(ex).__name__}: {ex}"[:250])

    threading.Thread(target=gorev, daemon=True).start()
    return jid


def durum(jid):
    j = jobs.get(jid)
    if not j:
        return None
    out = dict(j)
    if j.get("dosya") and not (core.MUZIK / j["dosya"]).exists():
        out["dosya"] = None
        out["dosya_silindi"] = True
        if j.get("durum") == "bitti":
            out["mesaj"] = "Dosya teslim sonrası otomatik temizlendi — tekrar başlatmak için yeniden istek at"
    return out


def ffmpeg_var():
    """Ses birleştirme (mux) için ffmpeg hazır mı (sistem veya imageio-ffmpeg)."""
    return core.ffmpeg_yol() is not None


# ------------------- AKILLI TEMIZLIK (disk hic dolmaz) -------------------
_ERISIM = {}   # dosya adi -> son erisim zamanı (yayin/listeleme korumasi)
_temizlik_kilit = threading.Lock()


def dosya_yolu(fname):
    """Guvenli dosya yolu (path traversal engeli) veya None. Erisimi isaretler."""
    try:
        p = (core.MUZIK / fname).resolve()
    except Exception:
        return None
    if str(p).startswith(str(core.MUZIK.resolve())) and p.is_file():
        with _temizlik_kilit:
            _ERISIM[fname] = time.time()
        return p
    return None


def teslim_edildi(fname):
    """Tam indirme bitti -> bu dosya kisa sure icinde silinebilir."""
    with _temizlik_kilit:
        _ERISIM[fname] = time.time()
    for j in jobs.values():
        if j.get("dosya") == fname:
            j["teslim"] = True


def _mb(yol):
    try:
        return yol.stat().st_size / 1048576
    except Exception:
        return 0


def _temizlik_turu():
    simdi = time.time()
    with _temizlik_kilit:
        erisim = dict(_ERISIM)
    # 1) is kayitlarini at (cok eski)
    for jid in [k for k, v in jobs.items()
                if simdi - v.get("t0", simdi) > JOB_OMUR and not (v.get("dosya") and (core.MUZIK / v["dosya"]).exists())]:
        jobs.pop(jid, None)
        with _url_kilit:
            for u, j in list(URL_IS.items()):
                if j == jid:
                    URL_IS.pop(u, None)
    # 2) dosya omurleri / teslim sonrasi silme
    silinen = []
    for f in core.MUZIK.iterdir():
        if not f.is_file():
            continue
        try:
            yas = simdi - f.stat().st_mtime
        except Exception:
            continue
        son = max(erisim.get(f.name, 0), simdi - yas)
        j = next((v for v in jobs.values() if v.get("dosya") == f.name), None)
        sil = False
        if j and j.get("teslim") and simdi - son > TESLIM_GECIKME:
            sil = True  # karsiya yollandi -> kendiliginden sil (disk korumasi)
        elif simdi - son > DOSYA_OMUR:
            sil = True  # omur doldu
        if sil:
            try:
                f.unlink()
                silinen.append(f.name)
                _ERISIM.pop(f.name, None)
            except Exception:
                pass
    # 3) disk / adet sinirlari (asarsak en eskiden sil)
    kalan = sorted([f for f in core.MUZIK.iterdir() if f.is_file()],
                   key=lambda f: max(erisim.get(f.name, 0), f.stat().st_mtime))
    toplam_mb = sum(_mb(f) for f in kalan)
    for f in kalan:
        if toplam_mb <= DISK_MB and len(kalan) <= MAX_DOSYA:
            break
        boyut = _mb(f)
        try:
            f.unlink()
            silinen.append(f.name)
            toplam_mb -= boyut
            kalan = kalan[1:]
        except Exception:
            pass
    if silinen:
        print(f"[temizlik] {len(silinen)} dosya silindi: {', '.join(silinen[:4])}"
              + ("..." if len(silinen) > 4 else ""), flush=True)


def _temizlik_dongusu():
    while True:
        time.sleep(TEMIZLIK_DONGU)
        try:
            _temizlik_turu()
        except Exception as ex:
            print("[temizlik] hata:", str(ex)[:80], flush=True)


threading.Thread(target=_temizlik_dongusu, daemon=True).start()
