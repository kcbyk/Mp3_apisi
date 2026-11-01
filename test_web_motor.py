# -*- coding: utf-8 -*-
"""Hızlı doğrulama: web motoru hız/kalite testi.
Kullanım:  python test_web_motor.py [BASE_URL] [KEY]
BASE_URL verilirse canlı API, verilmezse yerel web_motor.py test edilir."""
import sys
import time

SORGULAR = [
    "yapay zeka görüntü tanıma",
    "galata kulesi nerede",
    "muslum gurses affet sarkı sözleri",
    "python requests timeout",
    "bugün hava nasıl balıkesir",
]


def yerel():
    import web_motor as w
    print("=== YEREL web_motor testi ===")
    tot = 0
    for q in SORGULAR:
        sonuc, motor, sn = w.web_ara(q, 8)
        tot += sn
        print(f"[{sn:5.2f}s] {motor:<20} {len(sonuc):>2} sonuç | {q}")
        if sonuc:
            print(f"          → {sonuc[0]['baslik'][:60]}")
    print(f"\nortalama {tot / len(SORGULAR):.2f}s")
    print("=== GÖRSEL ARAMA ===")
    for q in ("galata kulesi", "kızıl tilki"):
        g, motor, sn = w.gorsel_ara(q, 5)
        print(f"[{sn:5.2f}s] {motor:<14} {len(g)} görsel | {q}")
        if g:
            print(f"          → {g[0]['genislik']}x{g[0]['yukseklik']} {g[0]['gorsel'][:70]}")


def canli(base, key):
    import requests
    print(f"=== CANLI API: {base} ===")
    for q in SORGULAR:
        t0 = time.time()
        r = requests.get(f"{base}/api/v1/web", params={"q": q, "limit": 5, "key": key}, timeout=90)
        d = r.json()
        print(f"[{time.time() - t0:5.2f}s] {d.get('motor', '?'):<20} {d.get('adet', 0):>2} sonuç | {q}")
    t0 = time.time()
    d = requests.get(f"{base}/api/v1/web",
                     params={"q": "galata kulesi", "limit": 5, "gorsel": 1, "key": key}, timeout=90).json()
    print(f"[{time.time() - t0:5.2f}s] metin={d.get('adet')} görsel={d.get('gorsel_adet')} "
          f"({d.get('gorsel_motor')})")
    print("web durum:", requests.get(f"{base}/api/v1/web/durum", params={"key": key},
                                     timeout=30).json().get("anahtarli"))


if __name__ == "__main__":
    if len(sys.argv) >= 3:
        canli(sys.argv[1].rstrip("/"), sys.argv[2])
    else:
        yerel()
