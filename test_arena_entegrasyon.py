#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
test_arena_entegrasyon.py — Şarkı API + arena-proxy köprüsü uçtan uca testi

Kullanım (yerel):
  ARENA_API_URL=http://127.0.0.1:8080 ARENA_API_KEY=sk-arena-demo-key \
  SARKI_URL=http://127.0.0.1:7900 KEY=sk-... python3 test_arena_entegrasyon.py
"""
import json
import os
import sys
import time
from urllib.parse import quote

import requests

SARKI = os.environ.get("SARKI_URL", "http://127.0.0.1:7900")
KEY = os.environ.get("KEY", "")
BASLIKLAR = {"content-type": "application/json"}
sonuclar = []


def test(ad, gecti, ek=""):
    sonuclar.append(gecti)
    print(f"{'✅' if gecti else '❌'} {ad}" + (f"  → {ek}" if ek else ""))


def g(uc, **params):
    params.setdefault("key", KEY)
    return requests.get(f"{SARKI}{uc}", params=params, timeout=180)


print("\n=== ŞARKI API 🤖 ARENA ENTEGRASYON TESTİ ===\n")

# 0) Ana sayfa ve doküman (arayüz entegrasyonu)
r = requests.get(SARKI + "/", timeout=30)
test("Ana sayfa açılıyor", r.status_code == 200)
test("Key modalında 🤖 Arena çipi var", 'data-s="arena"' in r.text and "Arena (AI görsel)" in r.text)
test("Rozet CSS'i (ar) eklendi", ".rozet.ar{" in r.text)
test("Rozet haritasında arena etiketi var", "'🤖 Arena'" in r.text or "🤖 Arena'" in r.text)

r = requests.get(SARKI + "/dokuman", timeout=30)
test("/dokuman sayfasında Arena bölümü var", "Arena — AI Görsel Üretimi" in r.text and "/api/v1/arena/gorsel" in r.text)

# 1) Mevcut uçlar bozulmadı mı? (regresyon)
r = requests.get(SARKI + "/api/v1/health", timeout=60)
test("Mevcut /health çalışıyor (regresyon)", r.status_code == 200 and r.json().get("ok"), f"surum={r.json().get('surum')}")
r = requests.get(SARKI + "/api/v1/keys/durum", timeout=30)
test("Mevcut /keys/durum çalışıyor", r.status_code == 200 and "key_sayisi" in r.json())

# 2) Arena durum ucu
r = g("/api/v1/arena/durum")
d = r.json()
test("Arena durum ucu → bağlantı OK", r.status_code == 200 and d.get("ok"),
     f"arena={d.get('arena_url')} dry_run={(d.get('arena') or {}).get('dry_run')}")

# 3) Yetki: arena izni olmayan key → 403
r = requests.post(f"{SARKI}/api/v1/keys/olustur", json={"isim": "sadece-youtube", "saglayicilar": ["youtube"], "parola": os.environ.get("ADMIN_PAROLA", "")}, timeout=30, headers=BASLIKLAR)
if r.json().get("ok"):
    k2 = r.json()["key"]
    r2 = requests.get(f"{SARKI}/api/v1/arena/gorsel", params={"prompt": "test", "key": k2}, timeout=60)
    test("Arena izni olmayan key → 403", r2.status_code == 403, r2.json().get("hata", "")[:60])
    requests.post(f"{SARKI}/api/v1/keys/sil", json={"key": k2, "parola": os.environ.get("ADMIN_PAROLA", "")}, timeout=30, headers=BASLIKLAR)
else:
    test("Yetki testi için key oluşturma", False, "ADMIN_PAROLA gerekli")

# 4) Geçersiz key → 401
r = requests.get(f"{SARKI}/api/v1/arena/gorsel", params={"prompt": "test", "key": "sk-yok-boyle-bir-key"}, timeout=30)
test("Geçersiz key → 401", r.status_code == 401)

# 5) Prompt eksik → 400
r = g("/api/v1/arena/gorsel")
test("Prompt yoksa → 400", r.status_code == 400 and "prompt" in r.json().get("hata", "").lower())

# 6) mod=json → gerçek üretim
t0 = time.time()
r = g("/api/v1/arena/gorsel", prompt="okyanusta büyük beyaz köpek balığı, sinematik", mod="json", oran="16:9", stil="photographic", negatif="blurry, text")
sure = time.time() - t0
d = r.json()
test("mod=json → üretim başarılı", r.status_code == 200 and d.get("ok"), f"{sure:.1f} sn")
test("Görsel URL'i döndü", bool(d.get("gorsel_url")), str(d.get("gorsel_url"))[:58])
test("Türkçe karakterler korundu (UTF-8)", "köpek balığı" in d.get("prompt", ""), d.get("prompt", "")[:40])
test("gorunum_url (img src) üretildi", "/api/v1/arena/gorsel?" in (d.get("gorunum_url") or "") and "mod=indir" in (d.get("gorunum_url") or ""))
test("Arena meta (adımlar) geldi", bool((d.get("arena_meta") or {}).get("adimlar")))

# 7) mod=indir → görsel baytları bu sunucudan geçer
r = g("/api/v1/arena/gorsel", prompt="köpek balığı yakın plan", mod="indir", oran="1:1")
ct = r.headers.get("content-type", "")
test("mod=indir → görsel baytları döndü", r.status_code == 200 and ct.startswith("image/") and len(r.content) > 1000,
     f"{ct}, {len(r.content)/1024:.0f} KB")
indirilen = r.content

# 8) mod=url → 302 yönlendirme
r = requests.get(f"{SARKI}/api/v1/arena/gorsel", params={"prompt": "köpek balığı", "mod": "url", "key": KEY}, timeout=180, allow_redirects=False)
test("mod=url → 302 yönlendirme", r.status_code == 302 and "http" in r.headers.get("location", ""),
     r.headers.get("location", "")[:58])

# 9) mod=base64
r = g("/api/v1/arena/gorsel", prompt="köpek balığı base64", mod="base64", oran="1:1")
d = r.json()
test("mod=base64 → base64 içerik", r.status_code == 200 and len(d.get("base64", "")) > 1000, f"{len(d.get('base64','')):,} karakter")

# 10) base64 ham=1 → sade metin
r = g("/api/v1/arena/gorsel", prompt="köpek balığı ham", mod="base64", ham="1")
test("ham=1 → sade base64 metni", r.status_code == 200 and r.headers.get("content-type", "").startswith("text/plain"))

# 11) POST ucu
r = requests.post(f"{SARKI}/api/v1/arena/gorsel", params={"key": KEY}, headers=BASLIKLAR,
                  json={"prompt": "köpek balığı sürüsü, havadan", "aspect_ratio": "16:9", "style": "cinematic"}, timeout=180)
d = r.json()
test("POST /api/v1/arena/gorsel çalışıyor", r.status_code == 200 and d.get("ok"), str(d.get("gorsel_url"))[:58])

# 12) Asenkron: bekleme=0 → iş kimliği, sonra sonuç
r = g("/api/v1/arena/gorsel", prompt="köpek balığı asenkron", bekleme="0", mod="json")
d = r.json()
is_id = d.get("is_id")
test("Asenkron → 202 + iş kimliği", r.status_code == 202 and bool(is_id), f"is_id={is_id}")
if is_id:
    final = None
    for _ in range(40):
        time.sleep(1)
        rr = g(f"/api/v1/arena/sonuc/{is_id}")
        final = rr.json()
        if final.get("durum") in ("bitti", "hata"):
            break
    test("Asenkron iş sonucu alındı", final.get("durum") == "bitti" and bool(final.get("gorsel_url")),
         f"durum={final.get('durum')} süre={final.get('sure_ms')}ms")

# 13) İndirilen görsel gerçekten görsel mi?
if len(indirilen) > 8:
    test("İndirilen içerik geçerli görsel (magic bytes)", indirilen[:4] in (b"\x89PNG", b"\xff\xd8\xff", b"RIFF", b"GIF8"),
         f"ilk baytlar: {indirilen[:4]!r}")

print(f"\nSONUÇ: {sum(sonuclar)}/{len(sonuclar)} test geçti")
sys.exit(0 if all(sonuclar) else 1)
