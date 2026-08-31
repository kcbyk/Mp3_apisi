# -*- coding: utf-8 -*-
"""
Telegram Şarkı Botu — yt-dlp + ffmpeg + Telegram Bot API
Kullanici sarki adini yazar -> bot arar -> butonla secer -> mp3 olarak gonderir.
Web uygulamasiyla ayni muzik/ klasoru ve kutuphane.json dosyasini paylasir.
"""
import http.client
import json
import os
import re
import ssl
import socket
import struct
import subprocess
import sys
import threading
import time
import urllib.parse
import uuid
from pathlib import Path

# yt-dlp icin JS runtime yolu (YouTube icin)
deno = Path.home() / ".deno" / "bin"
if deno.exists():
    os.environ["PATH"] = str(deno) + os.pathsep + os.environ.get("PATH", "")

import requests
import yt_dlp

BASE = Path(__file__).resolve().parent
MUZIK = BASE / "muzik"
MUZIK.mkdir(exist_ok=True)
LIBF = BASE / "kutuphane.json"
TOKENF = BASE / "bot_token.txt"

TOKEN = (os.environ.get("BOT_TOKEN") or (TOKENF.read_text().strip() if TOKENF.exists() else "")).strip()
API = f"https://api.telegram.org/bot{TOKEN}"

# --------------------------- Yardimcilar ---------------------------

def lib_yukle():
    try:
        return json.loads(LIBF.read_text(encoding="utf-8"))
    except Exception:
        return []

def lib_kaydet(items):
    LIBF.write_text(json.dumps(items, ensure_ascii=False, indent=1), encoding="utf-8")

def temizle_ad(name):
    name = re.sub(r'[\\/:*?"<>|\r\n\t]+', " ", str(name))
    name = re.sub(r"\s+", " ", name).strip(" .")
    return name[:110] or "sarki"

def sureFmt(s):
    if not s or s <= 0:
        return "--:--"
    return f"{int(s)//60}:{int(s)%60:02d}"

SSL_CTX = ssl.create_default_context()

def tg_request(method, payload=None, files=None, timeout=30):
    """Telegram API — her istek TAMAMEN taze TCP baglantisiyla;
    kapanista RST gonderilir (SO_LINGER 0) ki NAT'ta olu baglanci kalmasin."""
    conn = http.client.HTTPSConnection("api.telegram.org", context=SSL_CTX, timeout=timeout)
    try:
        conn.connect()
        try:
            conn.sock.setsockopt(socket.SOL_SOCKET, socket.SO_LINGER, struct.pack("ii", 1, 0))
        except Exception:
            pass
        headers = {"Accept": "application/json"}
        if files is not None:
            boundary = "----tgbot" + uuid.uuid4().hex
            body = b""
            for k, v in (payload or {}).items():
                body += (f"--{boundary}\r\nContent-Disposition: form-data; name=\"{k}\"\r\n\r\n{v}\r\n").encode("utf-8")
            for field, (fname, fh, ctype) in files.items():
                data = fh.read()
                body += (f"--{boundary}\r\nContent-Disposition: form-data; name=\"{field}\"; "
                         f"filename=\"{fname}\"\r\nContent-Type: {ctype}\r\n\r\n").encode("utf-8") + data + b"\r\n"
            body += (f"--{boundary}--\r\n").encode()
            headers["Content-Type"] = f"multipart/form-data; boundary={boundary}"
            payload_bytes = body
        elif payload is not None:
            payload_bytes = json.dumps(payload).encode("utf-8")
            headers["Content-Type"] = "application/json"
        else:
            payload_bytes = b""
        conn.request("POST", f"/bot{TOKEN}/{method}", body=payload_bytes, headers=headers)
        resp = conn.getresponse()
        return json.loads(resp.read().decode("utf-8"))
    finally:
        try:
            conn.close()  # SO_LINGER(1,0) sayesinde RST ile kapanir
        except Exception:
            pass

def tg(p, **kw):
    """Telegram API cagrisi (2 deneme). Dosya varsa multipart."""
    files = kw.pop("files", None)
    son = None
    for deneme in range(2):
        try:
            t = 300 if files else 30
            d = tg_request(p, kw.get("data") if files else kw, files=files, timeout=t)
            son = d
            if not d.get("ok"):
                print(f"[tg] {p} HATA: {d.get('description')}", flush=True)
            return d
        except Exception as ex:
            son = {"ok": False, "description": str(ex)}
            print(f"[tg] {p} DENEME {deneme+1} HATA: {ex}", flush=True)
            time.sleep(1)
    return son

# --------------------------- Arama ---------------------------

ARA_OPTS = {"quiet": True, "no_warnings": True, "extract_flat": True,
            "skip_download": True, "socket_timeout": 20}

def sc_ara(q, adet=6):
    with yt_dlp.YoutubeDL(dict(ARA_OPTS)) as ydl:
        info = ydl.extract_info(f"scsearch{adet}:{q}", download=False)
    sonuclar = []
    for e in info.get("entries") or []:
        if e and e.get("webpage_url"):
            sonuclar.append({
                "url": e["webpage_url"],
                "baslik": e.get("title") or "Bilinmeyen",
                "kanal": e.get("uploader") or "",
                "sure": int(float(e.get("duration") or 0)),
            })
    return sonuclar

# --------------------------- Indirme ---------------------------

def sarki_indir(url, baslik, ilerleme=None, zaman_limiti=240, kanal=""):
    """Indirir + mp3'e cevirir (alt surec olarak; takilirma olursa oldurulur).
    (dosya_adi, hata) dondurur."""
    # Kutuphanede var mi?
    for it in lib_yukle():
        if it.get("url") == url and (MUZIK / it["dosya"]).exists():
            return it["dosya"], None

    base = temizle_ad(baslik)
    fname, i = f"{base}.mp3", 1
    while (MUZIK / fname).exists():
        i += 1
        fname = f"{base} ({i}).mp3"
    stem = fname[:-4]

    cmd = [
        "yt-dlp",
        "-f", "bestaudio/best",
        "-x", "--audio-format", "mp3", "--audio-quality", "0",
        "--no-playlist", "--retries", "3", "--socket-timeout", "20",
        "--newline",
        "--progress-template", "PROG %(progress.downloaded_bytes)s %(progress.total_bytes_estimate)s",
        "-o", str(MUZIK / (stem + ".%(ext)s")),
        url,
    ]
    baslangic = time.time()
    try:
        proc = subprocess.Popen(cmd, stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
                                text=True, bufsize=1, env=dict(os.environ))
    except Exception as ex:
        return None, f"Başlatılamadı: {ex}"

    hata_bilgi = []
    for satir in proc.stdout:
        satir = satir.strip()
        if satir.startswith("PROG "):
            parca = satir.split()
            try:
                done = int(parca[1]); tot = int(parca[2])
            except Exception:
                continue
            if ilerleme and done is not None:
                pct = int(done / tot * 88) if tot else None
                ilerleme(pct, f"⏬ {done/1048576:.1f}" + (f"/{tot/1048576:.1f} MB" if tot else " MB"))
        elif satir.startswith("[ExtractAudio]"):
            if ilerleme:
                ilerleme(92, "🎧 mp3'e dönüştürülüyor...")
        elif "ERROR" in satir or "error" in satir.lower():
            hata_bilgi.append(satir[:150])
        if time.time() - baslangic > zaman_limiti:
            proc.kill()
            return None, "İndirme çok uzun sürdü (ağ takıldı), iptal ettim. Tekrar dener misin?"
    kod = proc.wait(timeout=30)

    if kod != 0:
        return None, " / ".join(hata_bilgi[-3:])[:250] or f"yt-dlp hata kodu {kod}"

    # mp3 dosyasini bul
    yol = MUZIK / fname
    if not yol.exists():
        aday = sorted(MUZIK.glob(stem + ".*"), key=lambda p: p.stat().st_mtime, reverse=True)
        if not aday:
            return None, "İndirilen dosya bulunamadı."
        yol = aday[0]
    dosya = yol.name

    sure = 0
    try:
        cikti = subprocess.run(["ffprobe", "-v", "error", "-show_entries", "format=duration",
                                "-of", "default=nw=1:nk=1", str(yol)],
                               capture_output=True, text=True, timeout=15).stdout.strip()
        sure = int(float(cikti))
    except Exception:
        pass

    lib = lib_yukle()
    lib.insert(0, {"dosya": dosya, "baslik": baslik,
                   "kanal": kanal, "url": url,
                   "sure": sure,
                   "tarih": time.strftime("%Y-%m-%d %H:%M")})
    lib_kaydet(lib)
    return dosya, None

def kayit_ekle(dosya, baslik, kanal, url, sure=0):
    lib = lib_yukle()
    lib.insert(0, {"dosya": dosya, "baslik": baslik, "kanal": kanal, "url": url,
                   "sure": sure, "tarih": time.strftime("%Y-%m-%d %H:%M")})
    lib_kaydet(lib)

def mp3_sure(yol):
    try:
        cikti = subprocess.run(["ffprobe", "-v", "error", "-show_entries", "format=duration",
                                "-of", "default=nw=1:nk=1", str(yol)],
                               capture_output=True, text=True, timeout=15).stdout.strip()
        return int(float(cikti))
    except Exception:
        return 0

# --------------------------- Archive.org (scraping) ---------------------------

ARA_HTTP = {"User-Agent": "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36"}

def archive_ara(q, adet=6):
    """archive.org acik arama API'si — bot duvari yok, klasikler icin altin madeni."""
    try:
        r = requests.get("https://archive.org/advancedsearch.php",
                         params={"q": f"({q}) AND mediatype:audio",
                                 "fl[]": ["identifier", "title"], "rows": adet,
                                 "output": "json"},
                         timeout=15, headers=ARA_HTTP)
        docs = r.json().get("response", {}).get("docs", [])
    except Exception as ex:
        print("[archive_ara] hata:", str(ex)[:80], flush=True)
        return []
    return [{"kaynak": "ia", "ia_id": d["identifier"],
             "baslik": (d.get("title") or d["identifier"]).strip(),
             "kanal": "archive.org", "sure": 0} for d in docs if d.get("identifier")]

STEMLER = ("_drums", "_instrumental", "_vocals", "_other")

def archive_indir(ia_id, baslik, istenen, ilerleme=None):
    """archive.org kaydindan istenen sarkiya en uygun mp3'yi indirir."""
    try:
        md = requests.get(f"https://archive.org/metadata/{ia_id}", timeout=20,
                          headers=ARA_HTTP).json()
    except Exception as ex:
        return None, f"Arşiv okunamadı: {str(ex)[:80]}"

    def puan(f):
        ad = ((f.get("title") or "") + " " + f.get("name", "")).lower()
        s = sum(1 for w in istenen.lower().split() if len(w) > 2 and w in ad)
        if any(st in f.get("name", "").lower() for st in STEMLER):
            s -= 5
        return s

    def sayi(v):
        try:
            return int(v or 0)
        except Exception:
            return 0

    mp3ler = [f for f in md.get("files", [])
              if "MP3" in (f.get("format") or "").upper()
              and sayi(f.get("size")) > 200000
              and not any(st in f.get("name", "").lower() for st in STEMLER)]
    if not mp3ler:
        return None, "Bu arşiv kaydında uygun mp3 yok."
    mp3ler.sort(key=puan, reverse=True)
    sec = mp3ler[0]
    if sayi(sec.get("size")) > 48 * 1024 * 1024:
        return None, "Parça 48MB'tan büyük, Telegram'a sığmıyor."

    parca = temizle_ad(sec.get("title") or Path(sec["name"]).stem)
    fname = temizle_ad(f"{baslik[:70]} - {parca[:60]}") + ".mp3"
    i = 1
    while (MUZIK / fname).exists():
        i += 1
        fname = temizle_ad(f"{baslik[:70]} - {parca[:60]}") + f" ({i}).mp3"

    url = f"https://archive.org/download/{ia_id}/{urllib.parse.quote(sec['name'])}"
    try:
        with requests.get(url, stream=True, timeout=(15, 60), headers=ARA_HTTP) as r:
            r.raise_for_status()
            tot = int(r.headers.get("content-length") or sayi(sec.get("size")) or 0)
            done = 0
            with open(MUZIK / fname, "wb") as fh:
                for chunk in r.iter_content(65536):
                    fh.write(chunk)
                    done += len(chunk)
                    if ilerleme:
                        pct = int(done / tot * 88) if tot else None
                        ilerleme(pct, f"⏬ {done/1048576:.1f}" + (f"/{tot/1048576:.1f} MB" if tot else " MB"))
    except Exception as ex:
        try:
            (MUZIK / fname).unlink()
        except Exception:
            pass
        return None, f"İndirme hatası: {str(ex)[:100]}"

    kayit_ekle(fname, f"{baslik} - {parca}", "archive.org",
               f"https://archive.org/details/{ia_id}", mp3_sure(MUZIK / fname))
    return fname, None

# chat_id -> son arama sonuclari
son_arama = {}
# chat_id -> son arama sorgusu (archive.org parca eslestirmesi icin)
son_sorgu = {}
# download suruyor bayragi (ayni chat'te ayni anda 1 indirme guzel olur)
mesgul = set()

# --------------------------- SoundCloud TURBO (api-v2, direkt mp3) ---------------------------

SC_API = "https://api-v2.soundcloud.com"
SC_CIDF = BASE / "sc_client_id.txt"

def sc_client_id():
    """Web client_id'yi getir; yoksa soundcloud.com'dan kazimada bul."""
    if SC_CIDF.exists():
        cid = SC_CIDF.read_text().strip()
        if cid:
            return cid
    try:
        r = requests.get("https://soundcloud.com/", headers=ARA_HTTP, timeout=15)
        js = list(dict.fromkeys(re.findall(r'https://a-v2\.sndcdn\.com/assets/[^"\']+\.js', r.text)))
        for u in js:
            try:
                t = requests.get(u, headers=ARA_HTTP, timeout=10).text
                m = re.search(r'client_id["\']?\s*[:=]\s*["\']([0-9A-Za-z_\-]{16,64})["\']', t)
                if m:
                    SC_CIDF.write_text(m.group(1))
                    return m.group(1)
            except Exception:
                continue
    except Exception as ex:
        print("[sc_cid] kazima hatasi:", str(ex)[:60], flush=True)
    return None

def sc_fast_ara(q, adet=6):
    """SoundCloud arama ~0.3 sn (yt-dlp yerine api-v2) + direkt mp3 bilgisi."""
    cid = sc_client_id()
    if not cid:
        return []
    try:
        r = requests.get(f"{SC_API}/search/tracks",
                         params={"q": q, "client_id": cid, "limit": adet},
                         headers=ARA_HTTP, timeout=10)
        if r.status_code in (401, 403):
            SC_CIDF.unlink(missing_ok=True)  # client_id bayatlamis, bir dahaki sefere yeniden kazinir
            return []
        col = r.json().get("collection", [])
    except Exception as ex:
        print("[sc_fast_ara] hata:", str(ex)[:70], flush=True)
        return []
    out = []
    for it in col:
        if not it or not it.get("permalink_url"):
            continue
        prog = [t for t in (it.get("media") or {}).get("transcodings", [])
                if t.get("format", {}).get("protocol") == "progressive"]
        out.append({"kaynak": "sc", "url": it["permalink_url"],
                    "baslik": it.get("title") or "Bilinmeyen",
                    "kanal": ((it.get("user") or {}).get("username") or ""),
                    "sure": int(it.get("duration", 0) // 1000),
                    "kapak": ((it.get("artwork_url") or (it.get("user") or {}).get("avatar_url") or "").replace("-large", "-t500x500") or None),
                    "sc_prog_url": prog[0]["url"] if prog else None})
    return out

def sc_fast_indir(s, ilerleme=None):
    """Direkt progressive mp3 (1-3 sn). (dosya, hata) dondurur."""
    prog_url = s.get("sc_prog_url")
    if not prog_url:
        return None, "go+"  # sadece HLS var, yt-dlp yolu dene
    cid = sc_client_id()
    if not cid:
        return None, "client_id yok"
    try:
        dl = requests.get(prog_url, params={"client_id": cid}, headers=ARA_HTTP, timeout=12).json()["url"]
    except Exception as ex:
        return None, f"hizli url alinamadi: {str(ex)[:50]}"

    base = temizle_ad(s["baslik"])
    fname, i = f"{base}.mp3", 1
    while (MUZIK / fname).exists():
        i += 1
        fname = f"{base} ({i}).mp3"
    try:
        with requests.get(dl, headers=ARA_HTTP, timeout=(15, 40), stream=True) as rr:
            rr.raise_for_status()
            tot = int(rr.headers.get("content-length") or 0)
            done = 0
            t0 = time.time()
            with open(MUZIK / fname, "wb") as fh:
                for chunk in rr.iter_content(131072):
                    fh.write(chunk)
                    done += len(chunk)
                    if done > 48 * 1024 * 1024:
                        raise RuntimeError("48MB siniri")
                    if ilerleme and done % 524288 < 131072:
                        pct = 5 + int(done / tot * 90) if tot else None
                        ilerleme(pct, f"⚡ {done/1048576:.1f}" + (f"/{tot/1048576:.1f} MB" if tot else " MB")
                                 + f" • {int(time.time()-t0)} sn")
    except Exception as ex:
        try:
            (MUZIK / fname).unlink()
        except Exception:
            pass
        return None, f"hizli indirme hatasi: {str(ex)[:60]}"
    kayit_ekle(fname, s["baslik"], s.get("kanal", ""), s.get("url", ""), s.get("sure", 0) or mp3_sure(MUZIK / fname))
    return fname, None

# --------------------------- YouTube (loader.to scraping) ---------------------------

def yt_hizli_ara(q, adet=12):
    """youtube-search kutuphanesi ile YouTube aramasi (~0.5-1 sn, API anahtari gerekmez).
    Bizim sonuc formatimiza cevirir; hata/sonuc yoksa bos liste dondurur (yt-dlp'e duser)."""
    try:
        from youtube_search import YoutubeSearch
        sonuc = YoutubeSearch(q, max_results=adet).to_dict()
    except Exception as ex:
        print("[yt_hizli_ara] hata:", str(ex)[:80], flush=True)
        return []
    out = []
    for e in sonuc or []:
        vid = e.get("id") or ""
        if not vid:
            continue
        sure = 0
        try:
            parca = [int(x) for x in str(e.get("duration") or "0:0").split(":")]
            sure = sum(p * 60 ** i for i, p in enumerate(reversed(parca)))
        except Exception:
            pass
        out.append({"kaynak": "yt", "url": f"https://www.youtube.com/watch?v={vid}",
                    "baslik": e.get("title") or "Bilinmeyen",
                    "kanal": e.get("channel") or "", "sure": sure})
    return out


def yt_ara_katman(q, adet=12):
    """YouTube arama katmani: once youtube-search kutuphanesi (hizli),
    bos donerse yt-dlp flat arama (yedek)."""
    try:
        hizli = yt_hizli_ara(q, adet)
        if hizli:
            return hizli
    except Exception:
        pass
    return yt_ara(q, adet)


def yt_ara(q, adet=5):
    """YouTube aramasi (yt-dlp flat — sadece metadata, oynatma engellenmis ama arama acik)."""
    opts = {"quiet": True, "no_warnings": True, "extract_flat": True,
            "skip_download": True, "socket_timeout": 20}
    try:
        with yt_dlp.YoutubeDL(opts) as ydl:
            info = ydl.extract_info(f"ytsearch{adet}:{q}", download=False)
    except Exception as ex:
        print("[yt_ara] hata:", str(ex)[:90], flush=True)
        return []
    out = []
    for e in info.get("entries") or []:
        if not e:
            continue
        url = e.get("webpage_url") or (f"https://www.youtube.com/watch?v={e['id']}" if e.get("id") else None)
        if not url:
            continue
        try:
            sure = int(float(e.get("duration") or 0))
        except Exception:
            sure = 0
        out.append({"kaynak": "yt", "url": url, "baslik": e.get("title") or "Bilinmeyen",
                    "kanal": e.get("uploader") or e.get("channel") or "", "sure": sure})
    return out

PREWARM = {}        # yt url -> {"purl":..., "dl":..., "t":...}
PREWARM_TTL = 600   # 10 dk

def _loader_baslat(url, fmt="mp3"):
    """loader.to donusumu baslatir; (progress_url, hata) dondurur. fmt: mp3 veya sayisal video kalitesi (360/720/1080)."""
    h = {"User-Agent": ARA_HTTP["User-Agent"], "Referer": "https://loader.to/",
         "Origin": "https://loader.to", "Accept": "*/*"}
    try:
        r = requests.get("https://loader.to/ajax/download.php",
                         params={"format": fmt, "url": url}, headers=h, timeout=20).json()
    except Exception as ex:
        return None, str(ex)[:60]
    if r.get("success") and r.get("progress_url"):
        return r["progress_url"], None
    return None, "servis kabul etmedi"

def _loader_bekle(purl, ilerleme=None, onden=False):
    """progress_url'i poll eder; download_url dondurur."""
    h = {"User-Agent": ARA_HTTP["User-Agent"], "Referer": "https://loader.to/"}
    t0 = time.time()
    son_prog, prog_t = None, time.time()
    while time.time() - t0 < 120:
        time.sleep(2 if onden else 3)
        try:
            p = requests.get(purl, headers=h, timeout=15).json()
        except Exception:
            continue
        gecen = int(time.time() - t0)
        prog = int(p.get("progress") or 0)
        if ilerleme:
            ilk = "Dönüşüm önden başladı, sürüyor" if onden else "YouTube'da mp3'e çevriliyor"
            ilerleme(max(2, min(60, prog // 10)), f"🔄 {ilk}... {gecen} sn")
        if prog != son_prog:
            son_prog, prog_t = prog, time.time()
        elif time.time() - prog_t > 45 and prog < 1000:
            return None
        if p.get("success") and prog >= 1000 and p.get("download_url"):
            return p["download_url"]
    return None

def prewarm_baslat(url):
    """Arka planda donusumu baslatir: kullanici butona basmadan dosya hazirlanir."""
    kayitli = PREWARM.get(url)
    if kayitli and time.time() - kayitli["t"] < PREWARM_TTL:
        return
    PREWARM[url] = {"purl": None, "dl": None, "t": time.time()}

    def gorev():
        dl = _yt_dl_url_bul(url)
        if dl:
            PREWARM[url]["dl"] = dl
            print(f"[prewarm] HAZIR: {url[:60]}", flush=True)
        else:
            PREWARM[url]["t"] = 0
    threading.Thread(target=gorev, daemon=True).start()

RUVS_HATA = set()  # ruvs.in motorunun calismadigi url'ler (loader.to'ya dusulur)

def _ruvs_baslat(url, kalite="320", fmt="mp3"):
    """Taze ruvs.in motoru (2026-08) — donusum isini baslatir; job_id dondurur.
    kalite: mp3 icin 128/192/320, mp4 icin 360/480/720/1080."""
    h = dict(ARA_HTTP)
    h.update({"Origin": "https://www.ruvs.in", "Content-Type": "application/json",
              "Referer": "https://www.ruvs.in/tools/youtube/mp3-converter"})
    try:
        r = requests.post("https://www.ruvs.in/api/convert",
                          data=json.dumps({"url": url, "format": fmt, "quality": str(kalite)}),
                          headers=h, timeout=20).json()
        if r.get("job_id"):
            return r["job_id"]
    except Exception as ex:
        print("[ruvs] baslatma hatasi:", str(ex)[:60], flush=True)
    return None

def _ruvs_bekle(jid, ilerleme=None):
    """ruvs.in isini poll eder; download_url dondurur (genelde 3-8 sn)."""
    h = dict(ARA_HTTP)
    h.update({"Referer": "https://www.ruvs.in/"})
    t0 = time.time()
    while time.time() - t0 < 70:
        time.sleep(2)
        try:
            c = requests.get(f"https://www.ruvs.in/api/check?job_id={jid}", headers=h, timeout=15).json()
        except Exception:
            continue
        if c.get("status") == "completed" and c.get("download_url"):
            return c["download_url"]
        if str(c.get("status", "")).lower() in ("error", "failed"):
            return None
        if ilerleme:
            ilerleme(35, f"🚀 Motor çeviriyor... {int(time.time()-t0)} sn")
    return None

def _yt_dl_url_bul(url, ilerleme=None, kalite="320", fmt="mp3"):
    """Once TAZE ruvs.in motoru, olmazsa loader.to. download_url dondurur.
    fmt='mp4' icin loader.to format parametresi sayisal kalite olur (360/720/1080)."""
    if url not in RUVS_HATA:
        jid = _ruvs_baslat(url, kalite, fmt)
        if jid:
            dl = _ruvs_bekle(jid, ilerleme)
            if dl:
                return dl
        RUVS_HATA.add(url)
        print("[yt] ruvs olmadi — loader.to'ya geciliyor", flush=True)
    purl, hata = _loader_baslat(url, fmt=(kalite if fmt == "mp4" else "mp3"))
    if not purl:
        return None
    return _loader_bekle(purl, ilerleme)

def mp4_ses_var_mi(yol):
    """MP4 kutu yapisini gezerek ses akisi (hdlr='soun') arar — ffmpeg gerekmez.
    True: ses var, False: ses YOK, None: okunamadi (belirsiz)."""
    import struct
    import os

    def kutular(f, bas, bit):
        f.seek(bas)
        while f.tell() + 8 <= bit:
            b0 = f.tell()
            boyut = struct.unpack(">I", f.read(4))[0]
            tip = f.read(4)
            if boyut == 0:
                boyut = bit - b0
            elif boyut == 1:
                boyut = struct.unpack(">Q", f.read(8))[0]
            if boyut < 8 or b0 + boyut > bit:
                return
            yield tip, b0, boyut
            f.seek(b0 + boyut)
    try:
        with open(yol, "rb") as f:
            top = os.path.getsize(yol)
            for tip, b, k in kutular(f, 0, top):
                if tip == b"moov":
                    for t2, b2, k2 in kutular(f, b + 8, b + k):
                        if t2 == b"trak":
                            for t3, b3, k3 in kutular(f, b2 + 8, b2 + k2):
                                if t3 == b"mdia":
                                    for t4, b4, k4 in kutular(f, b3 + 8, b3 + k3):
                                        if t4 == b"hdlr":
                                            f.seek(b4 + 16)
                                            if f.read(4) == b"soun":
                                                return True
                    return False  # moov tamamen tarandi, ses yok
        return False
    except Exception:
        return None


def ffmpeg_yol():
    """Sistem ffmpeg'i ya da imageio-ffmpeg pip binary'si (Render uyumlu). Yoksa None."""
    import shutil
    try:
        import imageio_ffmpeg
        return shutil.which("ffmpeg") or imageio_ffmpeg.get_ffmpeg_exe()
    except Exception:
        return shutil.which("ffmpeg")


def _mp4_ses_onar(url, video_yol, ilerleme=None):
    """Sessiz mp4'e ses ekle: ayri mp3 indir + ffmpeg ile mux (video kopya, ses aac)."""
    import subprocess
    ff = ffmpeg_yol()
    if not ff:
        print("[video] ffmpeg yok — ses onarilamiyor", flush=True)
        return False
    if ilerleme:
        ilerleme(None, "🔊 Video sessiz çıktı — ses birleştiriliyor...")
    mp3_url = _yt_dl_url_bul(url, None, "128", "mp3")
    if not mp3_url:
        return False
    ses_dosya = video_yol.parent / (video_yol.stem + ".tmpses.mp3")
    cikti = video_yol.parent / (video_yol.stem + ".sesli.tmp.mp4")
    try:
        with requests.get(mp3_url, headers=ARA_HTTP, timeout=(15, 60), stream=True) as rr:
            rr.raise_for_status()
            with open(ses_dosya, "wb") as fh:
                for ch in rr.iter_content(65536):
                    fh.write(ch)
        komut = [ff, "-y", "-i", str(video_yol), "-i", str(ses_dosya),
                 "-c:v", "copy", "-c:a", "aac", "-b:a", "160k", "-shortest",
                 "-movflags", "+faststart", str(cikti)]
        b = subprocess.run(komut, capture_output=True, timeout=240)
        if b.returncode != 0 or not cikti.exists() or cikti.stat().st_size < 2048:
            print("[video] mux hatasi:", (b.stderr or b"")[-160:], flush=True)
            return False
        cikti.replace(video_yol)
        print("[video] ses basariyla eklendi ✓", flush=True)
        return True
    except Exception as ex:
        print("[video] ses onarim hatasi:", str(ex)[:80], flush=True)
        return False
    finally:
        try:
            ses_dosya.unlink(missing_ok=True)
            cikti.unlink(missing_ok=True)
        except Exception:
            pass


def _lrc_ayristir(lrc):
    """LRC formatini ([mm:ss.xx] satir) sozluk listesine cevirir: [{t: saniye, metin}]."""
    import re as _re
    satirlar = []
    for ham in (lrc or "").splitlines():
        damgalar = _re.findall(r"\[(\d{1,2}):(\d{1,2}(?:[.,]\d{1,3})?)\]", ham)
        metin = _re.sub(r"\[[^\]]*\]", "", ham).strip()
        if not metin:
            continue
        for d, s in damgalar:
            satirlar.append({"t": round(int(d) * 60 + float(s.replace(",", ".")), 2), "metin": metin})
    satirlar.sort(key=lambda x: x["t"])
    return satirlar


def sozler_lrclib(sarki, sanatci="", sure_hedef=0):
    """lrclib.net — ucretsiz soz API'si; duz + senkron (LRC) sozler dondurur.
    sure_hedef verilirse (saniye), o sureye EN YAKIN versiyon secilir (Spotify tarzi eslestirme)."""
    def paketle(d):
        return {"kaynak": "lrclib", "sanatci": d.get("artistName") or "", "sarki": d.get("trackName") or "",
                "sure": int(d.get("duration") or 0), "plain": d.get("plainLyrics") or "",
                "synced": d.get("syncedLyrics") or ""}
    try:
        if sanatci:
            r = requests.get("https://lrclib.net/api/get",
                             params={"artist_name": sanatci, "track_name": sarki},
                             headers=ARA_HTTP, timeout=12)
            if r.status_code == 200:
                p = paketle(r.json())
                if p["plain"] or p["synced"]:
                    if not sure_hedef or abs(p["sure"] - sure_hedef) <= 25:
                        return p
        r = requests.get("https://lrclib.net/api/search",
                         params={"q": f"{sanatci} {sarki}".strip()}, headers=ARA_HTTP, timeout=12)
        if r.status_code != 200:
            return None
        adaylar = r.json() or []
        if not adaylar:
            return None
        senkronlu = [a for a in adaylar if a.get("syncedLyrics")] or adaylar
        if sure_hedef:
            sec = min(senkronlu, key=lambda a: abs(int(a.get("duration") or 0) - sure_hedef))
        else:
            sec = senkronlu[0]
        return paketle(sec)
    except Exception as ex:
        print("[sozler] lrclib hatasi:", str(ex)[:60], flush=True)
        return None


def sozler_youtube(q):
    """YouTube otomatik altyazilarindan SENKRON sozler (json3) — 'YouTube'dan canli soz' yolu."""
    try:
        import yt_dlp
        son = yt_ara_katman(q, 1)
        if not son:
            return None
        url = son[0]["url"]
        opts = {"quiet": True, "no_warnings": True, "skip_download": True,
                "socket_timeout": 15}
        with yt_dlp.YoutubeDL(opts) as ydl:
            info = ydl.extract_info(url, download=False)
        for tur in ("subtitles", "automatic_captions"):
            depo = info.get(tur) or {}
            for dil in ("tr", "en"):
                fmts = depo.get(dil) or []
                f = next((x for x in fmts if x.get("ext") == "json3"), None) or (fmts[0] if fmts else None)
                if not f:
                    continue
                r = requests.get(f["url"], headers=ARA_HTTP, timeout=15)
                satirlar = []
                for e in r.json().get("events", []):
                    segs = e.get("segs")
                    if not segs:
                        continue
                    metin = "".join(s.get("utf8", "") for s in segs).strip()
                    if not metin:
                        continue
                    satirlar.append({"t": round(e.get("tStartMs", 0) / 1000, 2), "metin": metin})
                if satirlar:
                    return {"kaynak": f"youtube-{dil}", "sanatci": son[0].get("kanal", ""),
                            "sarki": son[0].get("baslik", ""), "sure": son[0].get("sure", 0),
                            "plain": "\n".join(s["metin"] for s in satirlar), "synced": "", "satirlar": satirlar}
    except Exception as ex:
        print("[sozler] youtube hatasi:", str(ex)[:60], flush=True)
    return None


def sozler_bul(sarki, sanatci="", sure_hedef=0):
    """Soz zinciri: lrclib (temiz senkron sozler) -> YouTube otomatik altyazi (senkron).
    sure_hedef: calinan kaydin süresi — ayni sarkinin versiyonlarindan en yakini secer."""
    d = sozler_lrclib(sarki, sanatci, sure_hedef)
    if d and (d.get("synced") or d.get("plain")):
        if d.get("synced"):
            d["satirlar"] = _lrc_ayristir(d["synced"])
        return d
    y = sozler_youtube(f"{sanatci} {sarki}".strip())
    return y or d


def sc_prog_url_bul(track_url):
    """SoundCloud parca URL'sinden progressive transcoding url'sini cozer (resolve API)."""
    cid = sc_client_id()
    if not cid or "soundcloud.com" not in (track_url or ""):
        return None
    try:
        d = requests.get("https://api-v2.soundcloud.com/resolve",
                         params={"url": track_url, "client_id": cid},
                         headers=ARA_HTTP, timeout=12).json()
        prog = [t for t in (d.get("media") or {}).get("transcodings", [])
                if t.get("format", {}).get("protocol") == "progressive"]
        return prog[0]["url"] if prog else None
    except Exception as ex:
        print("[sc_prog_url_bul] hata:", str(ex)[:60], flush=True)
        return None


def sc_direct_url(prog_url):
    """SoundCloud progressive -> DIREKT mp3 CDN linki (indirmeden oynatma)."""
    if not prog_url:
        return None
    cid = sc_client_id()
    if not cid:
        return None
    try:
        return requests.get(prog_url, params={"client_id": cid},
                            headers=ARA_HTTP, timeout=12).json()["url"]
    except Exception:
        return None


def archive_direct_url(ia_id, istenen=""):
    """archive.org kaydindan en uygun parcanin DIREKT indirme/oynatma linki."""
    def sayi(v):
        try:
            return int(v or 0)
        except Exception:
            return 0
    def puan(f):
        ad = ((f.get("title") or "") + " " + f.get("name", "")).lower()
        s = sum(1 for w in (istenen or "").lower().split() if len(w) > 2 and w in ad)
        if any(st in f.get("name", "").lower() for st in STEMLER):
            s -= 5
        return s
    try:
        md = requests.get(f"https://archive.org/metadata/{ia_id}", timeout=20,
                          headers=ARA_HTTP).json()
    except Exception:
        return None
    mp3ler = [f for f in md.get("files", [])
              if "MP3" in (f.get("format") or "").upper()
              and sayi(f.get("size")) > 200000
              and not any(st in f.get("name", "").lower() for st in STEMLER)]
    if not mp3ler:
        return None
    mp3ler.sort(key=puan, reverse=True)
    from urllib.parse import quote
    return f"https://archive.org/download/{ia_id}/{quote(mp3ler[0]['name'])}"


def _yt_indir_ortak(url, baslik, ilerleme=None, sure=0, kalite="320", fmt="mp3",
                    etiket="YouTube", max_mb=48):
    """YouTube indirme gövdesi — hem mp3 hem mp4 için ortak.
    fmt: 'mp3' (kalite 128/192/320) veya 'mp4' (kalite 360/480/720/1080)."""
    dl = _yt_dl_url_bul(url, ilerleme, kalite, fmt)
    if not dl:
        return None, "Dönüştürme çok uzun sürdü."

    base = temizle_ad(baslik)
    uzanti = "mp4" if fmt == "mp4" else "mp3"
    fname, i = f"{base}.{uzanti}", 1
    while (MUZIK / fname).exists():
        i += 1
        fname = f"{base} ({i}).{uzanti}"
    try:
        with requests.get(dl, headers=ARA_HTTP, timeout=(15, 60), stream=True) as rr:
            rr.raise_for_status()
            tot = int(rr.headers.get("content-length") or 0)
            done, ind_t = 0, time.time()
            with open(MUZIK / fname, "wb") as fh:
                for chunk in rr.iter_content(65536):
                    fh.write(chunk)
                    done += len(chunk)
                    if done > max_mb * 1024 * 1024:
                        raise RuntimeError(f"Dosya {max_mb}MB'ı aştı.")
                    if ilerleme:
                        pct = 60 + int(done / tot * 38) if tot else None
                        ilerleme(pct, f"⏬ {done/1048576:.1f}" + (f"/{tot/1048576:.1f} MB" if tot else " MB")
                                 + f" • {int(time.time()-ind_t)} sn")
    except Exception as ex:
        try:
            (MUZIK / fname).unlink()
        except Exception:
            pass
        return None, f"İndirme hatası: {str(ex)[:80]}"

    if fmt == "mp4" and mp4_ses_var_mi(MUZIK / fname) is False:
        # GUARANTI: sessiz (video-only) mp4 gelirse sesi biz ekleriz
        if not _mp4_ses_onar(url, MUZIK / fname, ilerleme):
            try:
                (MUZIK / fname).unlink()
            except Exception:
                pass
            return None, "Video sessiz geldi ve ses eklenemedi"

    if fmt == "mp4":
        kayit_ekle(fname, baslik, f"{etiket} (video)", url, sure)
    else:
        kayit_ekle(fname, baslik, etiket, url, sure or mp3_sure(MUZIK / fname))
    return fname, None


def yt_video_indir(url, baslik, ilerleme=None, sure=0, kalite="720"):
    """YouTube -> mp4 video (kalite 360/480/720/1080). Once ruvs.in, yedek loader.to."""
    return _yt_indir_ortak(url, baslik, ilerleme, sure, kalite=kalite, fmt="mp4",
                           etiket="YouTube Video", max_mb=150)


def yt_indir(url, baslik, ilerleme=None, sure=0, kalite="320"):
    """YouTube -> mp3 (varsayilan 320kbps; kalite 128/192/320). Once ruvs.in (hizli), yedek loader.to. Pre-warm destegi."""
    dl = None
    pw = PREWARM.get(url)
    if pw and time.time() - pw["t"] < PREWARM_TTL and str(kalite) == "320":
        if pw.get("dl"):
            dl = pw["dl"]
            if ilerleme:
                ilerleme(50, "⚡ Önceden hazırlandı — direkt iniyor!")
        elif pw.get("purl"):
            dl = _loader_bekle(pw["purl"], ilerleme, onden=True)
    if not dl:
        dl = _yt_dl_url_bul(url, ilerleme, kalite)
    if not dl:
        return None, "Dönüştürme çok uzun sürdü."
    if pw is not None:
        pw["dl"] = dl

    base = temizle_ad(baslik)
    fname, i = f"{base}.mp3", 1
    while (MUZIK / fname).exists():
        i += 1
        fname = f"{base} ({i}).mp3"
    try:
        with requests.get(dl, headers=ARA_HTTP, timeout=(15, 60), stream=True) as rr:
            rr.raise_for_status()
            tot = int(rr.headers.get("content-length") or 0)
            done, ind_t = 0, time.time()
            with open(MUZIK / fname, "wb") as fh:
                for chunk in rr.iter_content(65536):
                    fh.write(chunk)
                    done += len(chunk)
                    if done > 48 * 1024 * 1024:
                        raise RuntimeError("Dosya 48MB'ı aştı.")
                    if ilerleme:
                        pct = 60 + int(done / tot * 38) if tot else None
                        ilerleme(pct, f"⏬ {done/1048576:.1f}" + (f"/{tot/1048576:.1f} MB" if tot else " MB")
                                 + f" • {int(time.time()-ind_t)} sn")
    except Exception as ex:
        try:
            (MUZIK / fname).unlink()
        except Exception:
            pass
        return None, f"İndirme hatası: {str(ex)[:80]}"

    kayit_ekle(fname, baslik, "YouTube (loader.to)", url, sure or mp3_sure(MUZIK / fname))
    return fname, None

def welcome(chat_id):
    tg("sendMessage", chat_id=chat_id, parse_mode="HTML", text=(
        "🎵 <b>Şarkı Botu'na hoş geldin!</b>\n\n"
        "Bana şarkı adını yaz, hemen arayayım:\n"
        "örnek: <i>müslüm gürses affet</i>\n\n"
        "Sonra çıkan sonuçtan birine dokun, mp3 olarak buraya yollayayım 🎧\n"
        "▶️ = YouTube (320kbps!) | ☁️ = SoundCloud | 📼 = Archive.org (şimşek)\n"
        "Komutlar: /kutuphane — indirdiklerimi göster"))

def arama_yap(chat_id, q):
    # Aninda tepki: kullanici birsey gordugu anda rahatlar
    ack = tg("sendMessage", chat_id=chat_id, text=f"🔎 \"{q}\" aranıyor...")
    ack_id = (ack.get("result") or {}).get("message_id")
    tg("sendChatAction", chat_id=chat_id, action="typing")
    t0 = time.time()
    son_sorgu[chat_id] = q

    # TURBO: uc kaynak PARALEL taranir
    from concurrent.futures import ThreadPoolExecutor
    with ThreadPoolExecutor(max_workers=3) as ex:
        f_sc = ex.submit(sc_fast_ara, q, 6)
        f_yt = ex.submit(yt_ara, q, 4)
        f_ia = ex.submit(archive_ara, q, 6)
        try:
            sonuclar = f_sc.result(timeout=15)
        except Exception:
            sonuclar = []
        try:
            yt = f_yt.result(timeout=15)
        except Exception:
            yt = []
        try:
            ia = f_ia.result(timeout=15)
        except Exception:
            ia = []

    # Eslesme puanina gore sirala: sorguyla en cok ortak kelime iceren one gecer
    def eslesme(item):
        kelimeler = [w for w in q.lower().split() if len(w) > 2]
        b = item["baslik"].lower()
        return sum(1 for w in kelimeler if w in b)

    ia.sort(key=eslesme, reverse=True)
    hepsi = (yt[:4] + ia[:2] + sonuclar + ia[2:])[:8]
    print(f"[arama] '{q}' -> YT:{len(yt)} SC:{len(sonuclar)} IA:{len(ia)} gosterilen:{len(hepsi)} {time.time()-t0:.1f}sn", flush=True)

    # PRE-WARM: ilk YouTube sonucunu SIMDI arka planda donusturmeye basla;
    # kullanici butona bastiginda dosya coktan hazir olacak
    for s in hepsi:
        if s.get("kaynak") == "yt":
            prewarm_baslat(s["url"])
            break

    if not hepsi:
        metin = "😕 Sonuç bulunamadı. Biraz farklı yazmayı dene."
        klavye = {"inline_keyboard": []}
    else:
        metin = f"🔎 \"{q}\" için sonuçlar — hangisini indirelim? 👇"
        klavye = {"inline_keyboard": [
            [{"text": ({"yt": "▶️ ", "ia": "📼 "}.get(s.get("kaynak"), "☁️ ")) + f"{s['baslik'][:48]} ({sureFmt(s['sure'])})",
              "callback_data": f"i:{i}"}]
            for i, s in enumerate(hepsi)
        ]}
    son_arama[chat_id] = hepsi
    if ack_id:
        r = tg("editMessageText", chat_id=chat_id, message_id=ack_id, parse_mode="HTML",
               text=metin, reply_markup=klavye)
        if not r.get("ok"):
            tg("sendMessage", chat_id=chat_id, parse_mode="HTML", text=metin, reply_markup=klavye)
    else:
        tg("sendMessage", chat_id=chat_id, parse_mode="HTML", text=metin, reply_markup=klavye)

def indirme_baslat(cb):
    cq = cb["callback_query"]
    chat_id = cq["message"]["chat"]["id"]
    mesaj_id = cq["message"]["message_id"]
    kullanici = cq.get("from", {}).get("first_name", "Dost")
    try:
        idx = int(cq["data"].split(":")[1])
        s = son_arama.get(chat_id, [])[idx]
    except Exception:
        tg("answerCallbackQuery", callback_query_id=cq["id"], text="Sonuç bulunamadı, tekrar ara.")
        return
    tg("answerCallbackQuery", callback_query_id=cq["id"])

    if chat_id in mesgul:
        tg("sendMessage", chat_id=chat_id, text="⏳ Önceki indirme bitiyor, birkaç saniye bekle dostum.")
        return
    mesgul.add(chat_id)

    # Ayni andan itibaren tum kalan sonuclari dene (DRM'lu olanlar atlanir)
    adaylar = son_arama.get(chat_id, [])[idx:] or [{"url": url, "baslik": baslik, "kanal": ""}]
    threading.Thread(target=calistir, args=(chat_id, mesaj_id, adaylar, kullanici), daemon=True).start()

def calistir(chat_id, mesaj_id, adaylar, kullanici):
    try:
        duzenme_t = [0]
        def ilerleme(pct, msj):
            now = time.time()
            if now - duzenme_t[0] < 3:  # sik duzenleme yapma (rate limit)
                return
            duzenme_t[0] = now
            yuzde = f" ({pct}%)" if pct is not None else ""
            tg("editMessageText", chat_id=chat_id, message_id=mesaj_id,
               text=f"⏳ <b>{baslik}</b>\n{msj}{yuzde}", parse_mode="HTML")

        dosya, hata, baslik, kanal = None, None, adaylar[0]["baslik"], adaylar[0].get("kanal", "")
        for sira, s in enumerate(adaylar):
            baslik = s["baslik"]
            kanal = s.get("kanal", "")
            tg("editMessageText", chat_id=chat_id, message_id=mesaj_id, parse_mode="HTML",
               text=(f"⏳ <b>{baslik}</b>\n▶️ YouTube dönüşümü başlıyor (15-40 sn)..."
                     if s.get("kaynak") == "yt" else f"⏳ <b>{baslik}</b>\nHazırlanıyor..."))
            if s.get("kaynak") == "yt":
                dosya, hata = yt_indir(s["url"], s["baslik"], ilerleme, sure=s.get("sure", 0))
            elif s.get("kaynak") == "ia":
                dosya, hata = archive_indir(s["ia_id"], s["baslik"],
                                            son_sorgu.get(chat_id, baslik), ilerleme)
            else:
                dosya, hata = sc_fast_indir(s, ilerleme)  # once TURBO yolu (1-3 sn)
                if not dosya:
                    dosya, hata = sarki_indir(s["url"], s["baslik"], ilerleme, kanal=kanal)
            print(f"[indir] {baslik[:40]!r} -> {'INDI: ' + dosya if dosya else 'HATA: ' + str(hata)[:100]}", flush=True)
            if dosya:
                break
            if hata and sira < len(adaylar) - 1:
                tg("editMessageText", chat_id=chat_id, message_id=mesaj_id, parse_mode="HTML",
                   text=f"⚠️ <b>{baslik[:40]}</b> alınamadı — sıradaki sonuç deneniyor...")
                continue
            break

        if hata:
            tg("editMessageText", chat_id=chat_id, message_id=mesaj_id,
               text=f"⚠️ İndirilemedi: {str(hata)[:200]}")
            return
        yol = MUZIK / dosya
        if yol.stat().st_size > 48 * 1024 * 1024:
            tg("editMessageText", chat_id=chat_id, message_id=mesaj_id,
               text="⚠️ Dosya çok büyük (48MB+), Telegram yollayamıyor.")
            return

        tg("editMessageText", chat_id=chat_id, message_id=mesaj_id,
           text=f"📤 <b>{baslik}</b>\nYollanıyor...", parse_mode="HTML")
        tg("sendChatAction", chat_id=chat_id, action="upload_document")

        # "Sanatci - Sarki" bicimindeyse ayir
        performer, title = "", baslik
        if " - " in baslik:
            p, t = baslik.split(" - ", 1)
            performer, title = p.strip()[:60], t.strip()[:60]
        with open(yol, "rb") as f:
            r = tg("sendAudio", data={"chat_id": chat_id, "title": title, "performer": performer,
                                      "caption": f"🎵 {baslik}\nİyi dinlemeler {kullanici}! 🎧"},
                   files={"audio": (dosya, f, "audio/mpeg")})
        print(f"[gonder] {baslik[:40]!r} -> ok={r.get('ok')} {r.get('description','')}", flush=True)
        if not r.get("ok"):
            tg("editMessageText", chat_id=chat_id, message_id=mesaj_id,
               text=f"⚠️ Yollanamadı: {r.get('description','?')}")
            return
        tg("editMessageText", chat_id=chat_id, message_id=mesaj_id,
           text=f"✅ <b>{baslik}</b> — hazır! Keyfini bil 😎", parse_mode="HTML")
    except Exception as ex:
        tg("editMessageText", chat_id=chat_id, message_id=mesaj_id,
           text=f"⚠️ Hata: {str(ex)[:200]}")
    finally:
        mesgul.discard(chat_id)

def kutuphane_gonder(chat_id):
    lib = [it for it in lib_yukle() if (MUZIK / it["dosya"]).exists()]
    if not lib:
        tg("sendMessage", chat_id=chat_id, text="📚 Kütüphane boş. Önce bir şarkı indir!")
        return
    son_arama[chat_id] = [{"url": it["url"], "baslik": it["baslik"], "kanal": it["kanal"],
                           "sure": it.get("sure", 0), "dosya": it["dosya"]} for it in lib]
    klavye = {"inline_keyboard": [
        [{"text": f"▶️ {it['baslik'][:55]}", "callback_data": f"g:{i}"}]
        for i, it in enumerate(lib[:8])
    ]}
    tg("sendMessage", chat_id=chat_id, parse_mode="HTML",
       text="📚 <b>Kütüphanem</b> — dokun, yollayayım:", reply_markup=klavye)

def kutuphaneden_gonder(cb):
    cq = cb["callback_query"]
    chat_id = cq["message"]["chat"]["id"]
    try:
        idx = int(cq["data"].split(":")[1])
        s = son_arama.get(chat_id, [])[idx]
        dosya = s["dosya"]
    except Exception:
        tg("answerCallbackQuery", callback_query_id=cq["id"], text="Bulunamadı.")
        return
    if not (MUZIK / dosya).exists():
        tg("answerCallbackQuery", callback_query_id=cq["id"], text="Dosya yok olmuş 😕")
        return
    tg("answerCallbackQuery", callback_query_id=cq["id"], text="Yollanıyor...")
    performer, title = "", s["baslik"]
    if " - " in s["baslik"]:
        p, t = s["baslik"].split(" - ", 1)
        performer, title = p.strip()[:60], t.strip()[:60]
    with open(MUZIK / dosya, "rb") as f:
        tg("sendAudio", data={"chat_id": chat_id, "title": title, "performer": performer,
                              "caption": f"🎵 {s['baslik']}"},
           files={"audio": (dosya, f, "audio/mpeg")})

# --------------------------- Ana dongu (long polling) ---------------------------

def isle(update):
    msg = update.get("message") or update.get("edited_message")
    if msg and msg.get("text"):
        chat_id = msg["chat"]["id"]
        txt = msg["text"].strip()
        if txt.startswith("/start"):
            welcome(chat_id)
        elif txt.startswith("/kutuphane") or txt.lower() == "kütüphane" or txt.lower() == "kutuphane":
            kutuphane_gonder(chat_id)
        else:
            arama_yap(chat_id, txt[:100])
        return
    cb = update.get("callback_query")
    if cb:
        if cb["data"].startswith("i:"):
            indirme_baslat({"callback_query": cb})
        elif cb["data"].startswith("g:"):
            kutuphaneden_gonder({"callback_query": cb})

def main():
    if not TOKEN:
        print("TOKEN YOK! bot_token.txt dosyasına token yaz veya BOT_TOKEN ortam değişkeni ver.")
        sys.exit(1)
    import signal
    ana_thread = threading.current_thread() is threading.main_thread()

    while True:
        me = tg("getMe")
        if me.get("ok"):
            break
        print("getMe başarısız — 10 sn sonra tekrar:", str(me.get("description"))[:80], flush=True)
        time.sleep(10)
    print(f"Bot çalışıyor: @{me['result']['username']} — mesaj bekliyorum...", flush=True)

    # WATCHDOG: bu agda baglantilar takilabiliyor; alarm ile zorla kes
    class Watchdog(Exception):
        pass

    def _alarm(sig, frm):
        raise Watchdog()

    if ana_thread:
        signal.signal(signal.SIGALRM, _alarm)

    def alarm(saniye):
        if ana_thread:
            signal.setitimer(signal.ITIMER_REAL, saniye)

    offset = 0
    hata_sayisi = 0
    bos_sayisi = 0
    while True:
        try:
            alarm(45)  # 45 sn hard limit
            try:
                d = tg_request("getUpdates",
                               {"offset": offset, "timeout": 3,
                                "allowed_updates": ["message", "callback_query"]},
                               timeout=20)
            finally:
                alarm(0)

            if not d.get("ok"):
                print("getUpdates hatası:", d.get("description"), flush=True)
                time.sleep(3)
                continue
            upd = d.get("result", [])
            if not upd:
                bos_sayisi += 1
                if bos_sayisi % 20 == 1:
                    print("...bekliyorum (baglanti saglam)", flush=True)
                continue
            bos_sayisi = 0
            for u in upd:
                offset = u["update_id"] + 1
                try:
                    m = u.get("message") or {}
                    cb = u.get("callback_query") or {}
                    ozet = m.get("text") or ("buton:" + str(cb.get("data")))
                    print(f"<<< {ozet[:60]!r} (chat: {(m.get('chat') or {}).get('id') or (cb.get('message',{}).get('chat',{}).get('id'))})", flush=True)
                    alarm(60)
                    try:
                        isle(u)
                    finally:
                        alarm(0)
                except Exception as ex:
                    print("işleme hatası:", ex, flush=True)
            hata_sayisi = 0
        except Watchdog:
            print("[watchdog] istek takildi! baglanti yenileniyor...", flush=True)
            time.sleep(1)
            continue
        except KeyboardInterrupt:
            print("Kapatiliyor.")
            break
        except Exception as ex:
            hata_sayisi += 1
            bekle = min(30, 3 * hata_sayisi)
            print(f"bağlantı hatası: {ex} — {bekle}sn sonra tekrar", flush=True)
            time.sleep(bekle)

if __name__ == "__main__":
    main()
