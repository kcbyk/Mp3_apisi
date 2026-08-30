# -*- coding: utf-8 -*-
"""
API çekirdegi — framework'ten bagimsiz (Flask/FastAPI ikisinde de kullanilir).
telegram_bot.py'nin motorlarini (YT/SC/IA) REST API icin paketler.
"""
import threading
import time
import uuid
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

import telegram_bot as core

jobs = {}  # job_id -> durum bilgisi


def ara(q, limit=8):
    """Uc kaynagi paralel tarar; birlesik sonuc listesi dondurur."""
    with ThreadPoolExecutor(max_workers=3) as ex:
        f_sc = ex.submit(core.sc_fast_ara, q, 6)
        f_yt = ex.submit(core.yt_ara, q, 4)
        f_ia = ex.submit(core.archive_ara, q, 6)
        try:
            sc = f_sc.result(timeout=15)
        except Exception:
            sc = []
        try:
            yt = f_yt.result(timeout=15)
        except Exception:
            yt = []
        try:
            ia = f_ia.result(timeout=15)
        except Exception:
            ia = []
    return (yt[:4] + ia[:2] + sc + ia[2:])[:limit]


def job_baslat(item, sorgu=""):
    """Bir sonucu arka planda indirir; job_id dondurur."""
    jid = uuid.uuid4().hex[:10]
    jobs[jid] = {"durum": "kuyrukta", "yuzde": 0, "mesaj": "Sırada...",
                 "hata": None, "dosya": None, "baslik": item.get("baslik", "")}

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
            if kaynak == "yt":
                dosya, hata = core.yt_indir(item["url"], item["baslik"], iler,
                                            sure=item.get("sure", 0))
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
                         sure=time.time() - t0)
            else:
                j.update(durum="hata", hata=str(hata)[:250])
        except Exception as ex:
            j.update(durum="hata", hata=f"{type(ex).__name__}: {ex}"[:250])

    threading.Thread(target=gorev, daemon=True).start()
    return jid


def durum(jid):
    return jobs.get(jid)


def dosya_yolu(fname):
    """Guvenli dosya yolu (path traversal engeli) veya None."""
    try:
        p = (core.MUZIK / fname).resolve()
    except Exception:
        return None
    if str(p).startswith(str(core.MUZIK.resolve())) and p.is_file():
        return p
    return None
