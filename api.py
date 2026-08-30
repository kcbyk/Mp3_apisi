# -*- coding: utf-8 -*-
"""
🎵 ŞARKI API — kendi kişisel müzik indirme servisimiz
Her projeden çağırılabilir REST API.

Uç noktalar:
  GET  /                          → bu dokümantasyon sayfası
  GET  /api/v1/health             → servis sağlığı
  GET  /api/v1/search?q=...       → 3 kaynakta paralel arama
  POST /api/v1/convert            → {url, baslik?, kaynak?} indirme işi başlat
  GET  /api/v1/status/<job_id>    → iş durumu (+dosya adı)
  GET  /api/v1/file/<dosya>       → mp3 dosyasını indir
  GET  /api/v1/instant?q=...      → arar + en iyi sonucu otomatik indirir

Kimlik doğrulama: api_key.txt dosyası varsa ?key=XXX veya X-API-Key başlığı gerekir.
"""
import os
from functools import wraps
from pathlib import Path

from flask import Flask, abort, jsonify, request, send_file

import api_core

BASE = Path(__file__).resolve().parent
KEYF = BASE / "api_key.txt"
API_KEY = KEYF.read_text().strip() if KEYF.exists() else ""

app = Flask(__name__)


def korumali(f):
    @wraps(f)
    def sarmal(*a, **kw):
        if API_KEY:
            k = request.args.get("key") or request.headers.get("X-API-Key") or ""
            if k != API_KEY:
                return jsonify(ok=False, hata="Geçersiz API key"), 401
        return f(*a, **kw)
    return sarmal


KAYNAK_ADI = {"yt": "youtube", "sc": "soundcloud", "ia": "archive.org"}


# --------------------------- UC NOKTALAR ---------------------------

@app.get("/api/v1/health")
def health():
    return jsonify(ok=True, servis="sarki-api", surum="1.0", zaman=__import__("time").strftime("%Y-%m-%d %H:%M:%S"))


@app.get("/api/v1/search")
@korumali
def search():
    q = (request.args.get("q") or "").strip()
    limit = int(request.args.get("limit") or 8)
    if not q:
        return jsonify(ok=False, hata="q parametresi gerekli"), 400
    try:
        sonuc = api_core.ara(q, max(1, min(limit, 12)))
    except Exception as ex:
        return jsonify(ok=False, hata=str(ex)[:200]), 500
    return jsonify(ok=True, q=q, adet=len(sonuc), sonuclar=[{
        "id": i,
        "kaynak": KAYNAK_ADI.get(s.get("kaynak"), s.get("kaynak")),
        "baslik": s.get("baslik"),
        "kanal": s.get("kanal", ""),
        "sure": s.get("sure", 0),
        "url": s.get("url") or f"https://archive.org/details/{s.get('ia_id')}",
    } for i, s in enumerate(sonuc)])


@app.post("/api/v1/convert")
@korumali
def convert():
    d = request.get_json(silent=True) or {}
    q = request.args.get("q") or ""
    url = d.get("url") or request.args.get("url")
    if not url:
        return jsonify(ok=False, hata="url gerekli"), 400
    item = {"kaynak": d.get("kaynak") or ("yt" if "youtube" in url else ("ia" if "archive.org" in url else "sc")),
            "url": url, "baslik": d.get("baslik") or "sarki",
            "ia_id": d.get("ia_id") or (url.rstrip("/").split("/")[-1] if "archive.org" in url else None),
            "sure": d.get("sure", 0), "sc_prog_url": d.get("sc_prog_url")}
    jid = api_core.job_baslat(item, q)
    return jsonify(ok=True, job_id=jid, durum_url=f"/api/v1/status/{jid}")


@app.get("/api/v1/status/<jid>")
@korumali
def status(jid):
    j = api_core.durum(jid)
    if not j:
        return jsonify(ok=False, hata="iş bulunamadı"), 404
    out = dict(ok=True, **j)
    if j.get("dosya"):
        out["dosya_url"] = f"/api/v1/file/{j['dosya']}"
    return jsonify(out)


@app.get("/api/v1/file/<path:fname>")
@korumali
def file(fname):
    yol = api_core.dosya_yolu(fname)
    if not yol:
        abort(404)
    return send_file(yol, mimetype="audio/mpeg", as_attachment=True,
                     download_name=fname, conditional=True)


@app.get("/api/v1/instant")
@korumali
def instant():
    """Ara + en iyi sonucu otomatik indir. Dönen job_id ile status'u poll et."""
    q = (request.args.get("q") or "").strip()
    if not q:
        return jsonify(ok=False, hata="q parametresi gerekli"), 400
    sonuc = api_core.ara(q, 8)
    if not sonuc:
        return jsonify(ok=False, hata="sonuç bulunamadı"), 404
    en_iyi = sonuc[0]
    jid = api_core.job_baslat(en_iyi, q)
    return jsonify(ok=True, job_id=jid, secilen={
        "baslik": en_iyi.get("baslik"), "kaynak": KAYNAK_ADI.get(en_iyi.get("kaynak"), "?"),
        "sure": en_iyi.get("sure", 0)},
        durum_url=f"/api/v1/status/{jid}",
        not_="Ön-ısıtma: bu sorgunun ilk YouTube sonucu arama anında dönüştürülüyordu, iş hızlı biter")


# --------------------------- DOKUMENTASYON ---------------------------

@app.get("/")
def docs():
    return """<!DOCTYPE html>
<html lang="tr"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>🎵 Şarkı API</title>
<style>
*{box-sizing:border-box;margin:0;padding:0}
body{font-family:-apple-system,'Segoe UI',Roboto,sans-serif;background:#0b0f1a;color:#eef1f8;padding:32px 18px;line-height:1.6}
.sar{max-width:880px;margin:0 auto}
h1{background:linear-gradient(90deg,#7c5cff,#00d4ff);-webkit-background-clip:text;background-clip:text;color:transparent;font-size:32px;margin-bottom:6px}
p.ac{color:#8b94ad;margin-bottom:24px}
.kart{background:#131a2b;border:1px solid #26304d;border-radius:14px;padding:18px;margin-bottom:14px}
.yol{font-family:monospace;font-weight:700;color:#00d4ff;font-size:15px}
.etiket{display:inline-block;font-size:11px;font-weight:700;border-radius:6px;padding:2px 8px;margin-left:8px;vertical-align:middle}
.get{background:#0d3b2e;color:#4ade80}.post{background:#3b2f0d;color:#facc15}
.acik{color:#a9b4cc;font-size:14px;margin:8px 0}
pre{background:#0d1322;border-radius:10px;padding:12px;overflow-x:auto;font-size:13px;color:#c8d3f0;margin-top:8px}
.tablo{width:100%;border-collapse:collapse;font-size:14px;margin-top:8px}
.tablo td,.tablo th{padding:8px 10px;border-bottom:1px solid #26304d;text-align:left}
.tablo th{color:#8b94ad;font-weight:600}
code{background:#0d1322;padding:2px 6px;border-radius:6px;font-size:13px}
footer{color:#4d5570;font-size:12px;text-align:center;margin-top:30px}
</style></head><body><div class="sar">
<h1>🎵 Şarkı API</h1>
<p class="ac">Kişisel müzik indirme servisi — YouTube + SoundCloud + Archive.org, tek API'de. Her projeden çağırılabilir.</p>

<div class="kart">
<span class="yol">GET /api/v1/search?q={sorgu}</span><span class="etiket get">GET</span>
<p class="acik">3 kaynağı <b>paralel</b> tarar (~1 sn). JSON sonuç listesi döner.</p>
<pre>curl "https://SUNUCU/api/v1/search?q=müslüm gürses affet"

→ {"ok":true,"sonuclar":[
   {"id":0,"kaynak":"youtube","baslik":"Müslüm Gürses - Affet","kanal":"Yusuf Aydin","sure":276,"url":"https://..."},
   {"id":1,"kaynak":"soundcloud","baslik":"Affet","kanal":"...","sure":279,"url":"https://..."}]}</pre>
</div>

<div class="kart">
<span class="yol">GET /api/v1/instant?q={sorgu}</span><span class="etiket get">GET</span>
<p class="acik">Ara + <b>en iyi sonucu otomatik indir</b>. Tek çağrıda iş başlar.</p>
<pre>curl "https://SUNUCU/api/v1/instant?q=tarkan kuzu kuzu"
→ {"ok":true,"job_id":"a1b2c3d4e5","secilen":{...},"durum_url":"/api/v1/status/a1b2c3d4e5"}</pre>
</div>

<div class="kart">
<span class="yol">POST /api/v1/convert</span><span class="etiket post">POST</span>
<p class="acik">Seçtiğin URL'yi indirir (YouTube/SoundCloud/Archive linki ver).</p>
<pre>curl -X POST https://SUNUCU/api/v1/convert \\
     -H "Content-Type: application/json" \\
     -d '{"url":"https://www.youtube.com/watch?v=...","baslik":"Şarkı Adı"}'</pre>
</div>

<div class="kart">
<span class="yol">GET /api/v1/status/{job_id}</span><span class="etiket get">GET</span>
<p class="acik">İşin durumu: yüzde, mesaj, bitince <code>dosya_url</code>.</p>
<pre>→ {"ok":true,"durum":"bitti","yuzde":100,"dosya":"Tarkan - Kuzu Kuzu.mp3","dosya_url":"/api/v1/file/..."}</pre>
</div>

<div class="kart">
<span class="yol">GET /api/v1/file/{dosya}</span><span class="etiket get">GET</span>
<p class="acik">Mp3 dosyasını indir (stream, Range destekli).</p>
</div>

<div class="kart">
<span class="yol">JS / Python örnekleri</span>
<pre>// JavaScript
const r = await fetch("https://SUNUCU/api/v1/instant?q=wegh affettim").then(r=>r.json());
let s; do { s = await fetch("https://SUNUCU"+r.durum_url).then(r=>r.json()); await sleep(1000); } while(s.durum==="indiriliyor");
window.location = "https://SUNUCU"+s.dosya_url;

# Python
import requests, time
r = requests.get("https://SUNUCU/api/v1/instant", params={"q":"muslum affet"}).json()
while True:
    s = requests.get("https://SUNUCU"+r["durum_url"]).json()
    if s["durum"] in ("bitti","hata"): break
    time.sleep(1)
print(s.get("dosya_url"))</pre>
</div>

<div class="kart">
<p class="acik"><b>Kaynaklar:</b></p>
<table class="tablo">
<tr><th>Kaynak</th><th>Hız</th><th>Kalite</th></tr>
<tr><td>▶️ YouTube</td><td>3-15 sn (ön-ısıtmalı)</td><td>320 kbps</td></tr>
<tr><td>☁️ SoundCloud</td><td>1-3 sn</td><td>128 kbps</td></tr>
<tr><td>📼 Archive.org</td><td>1-2 sn</td><td>değişken</td></tr>
</table>
<p class="acik" style="margin-top:10px"><b>Güvenlik:</b> <code>api_key.txt</code> dosyası oluşturup içine anahtar yazarsan tüm uçlar <code>?key=</code> veya <code>X-API-Key</code> ister.</p>
</div>

<footer>🎵 Şarkı API v1.0 — yt-dlp + ffmpeg + scraping motorları • Kişisel kullanım</footer>
</div></body></html>"""


if __name__ == "__main__":
    app.run(host="0.0.0.0", port=int(os.environ.get("PORT", 7900)), debug=False, threaded=True)
