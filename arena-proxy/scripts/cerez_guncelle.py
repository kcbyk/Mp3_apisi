#!/usr/bin/env python3
"""
Arena.ai çerezlerini oturum dosyasına + Render ortam değişkenine işler.

Kullanım (gerekli ortam değişkenleriyle):
  RENDER_API_KEY=rnd_xxx RENDER_SERVICE_ID=srv-xxx \
  python3 scripts/cerez_guncelle.py --dosya cerezler.json

Girdi biçimleri (otomatik algılanır):
  - Cookie-Editor "Export as JSON"  → [ {name, value, domain, path, ...}, ... ]
  - Playwright storageState         → { "cookies": [...], "origins": [...] }
  - Ham başlık dizesi               → "a=b; c=d"

Yaptıkları:
  1) Markdown bozulmalarını temizler ([arena.ai](http://arena.ai) → arena.ai, [2F..], &amp;, ~~)
  2) Chunk'lı arena-auth-prod-v1.0 / v1.1 değerlerini teşhis eder (uzunluk + parça sayısı)
  3) data/sessions/arena.json (0600) yazar
  4) RENDER_API_KEY + RENDER_SERVICE_ID verilmişse SESSION_STATE_B64'ü günceller
     ve (--deploy ile) dağıtım tetikler
"""
from __future__ import annotations

import argparse
import base64
import json
import os
import re
import sys
import urllib.error
import urllib.request
from pathlib import Path

KOK = Path(__file__).resolve().parents[1]
HEDEF = KOK / "data" / "sessions" / "arena.json"
ARENA = "arena.ai"


# ---------------------------------------------------------------- normalizasyon
def markdown_temizle(metin: str) -> str:
    metin = metin.replace("&amp;", "&")
    metin = re.sub(r"\[arena\.ai\]\(https?://[^)]*\)", ARENA, metin)
    metin = re.sub(r"\[2F([A-Za-z0-9.\-]+)\]\(https?://[^)]*\)", r"%2F\1", metin)
    metin = metin.replace("~~", "")
    return metin


def cerezleri_ayikla(ham: str) -> list[dict]:
    ham = markdown_temizle(ham.strip())
    if not ham:
        raise SystemExit("Boş girdi")

    # 1) JSON (Cookie-Editor ya da storageState)
    try:
        veri = json.loads(ham)
        if isinstance(veri, dict) and "cookies" in veri:
            return veri["cookies"]
        if isinstance(veri, list):
            return veri
    except json.JSONDecodeError:
        pass

    # 2) "ad=değer; ad2=değer2"
    cerezler = []
    for parca in ham.split(";"):
        if "=" not in parca:
            continue
        ad, _, deger = parca.strip().partition("=")
        if not ad:
            continue
        cerezler.append({"name": ad.strip(), "value": deger.strip(), "domain": f".{ARENA}", "path": "/"})
    return cerezler


def storage_state(cerezler: list[dict]) -> dict:
    temiz = []
    for c in cerezler:
        ad = str(c.get("name", "")).strip()
        if not ad:
            continue
        domain = str(c.get("domain") or f".{ARENA}").strip()
        domain = domain if domain.startswith(".") or domain == ARENA else f".{domain.lstrip('.')}"
        temiz.append(
            {
                "name": ad,
                "value": str(c.get("value", "")),
                "domain": domain,
                "path": str(c.get("path") or "/"),
                "expires": float(c.get("expirationDate") or c.get("expires") or -1),
                "httpOnly": bool(c.get("httpOnly", False)),
                "secure": bool(c.get("secure", True)),
                "sameSite": c.get("sameSite") or "Lax",
            }
        )
    return {"cookies": temiz, "origins": []}


# ------------------------------------------------------------------- Render yaz
def render_env_yaz(b64: str) -> dict:
    anahtar = os.environ.get("RENDER_API_KEY", "").strip()
    servis = os.environ.get("RENDER_SERVICE_ID", "").strip()
    if not anahtar or not servis:
        return {"atlandi": "RENDER_API_KEY/RENDER_SERVICE_ID yok"}
    istek = urllib.request.Request(
        f"https://api.render.com/v1/services/{servis}/env-vars/SESSION_STATE_B64",
        data=json.dumps({"value": b64}).encode(),
        method="PUT",
        headers={"Authorization": f"Bearer {anahtar}", "Content-Type": "application/json", "Accept": "application/json"},
    )
    try:
        with urllib.request.urlopen(istek, timeout=40) as y:
            return {"ok": True, "uzunluk": len(b64), "yanit": y.status}
    except urllib.error.HTTPError as e:
        return {"ok": False, "hata": f"HTTP {e.code} {e.read()[:150].decode(errors='replace')}"}


def deploy_tetikle() -> str:
    anahtar = os.environ.get("RENDER_API_KEY", "").strip()
    servis = os.environ.get("RENDER_SERVICE_ID", "").strip()
    istek = urllib.request.Request(
        f"https://api.render.com/v1/services/{servis}/deploys",
        data=json.dumps({"clearCache": "do_not_clear"}).encode(),
        method="POST",
        headers={"Authorization": f"Bearer {anahtar}", "Content-Type": "application/json", "Accept": "application/json"},
    )
    with urllib.request.urlopen(istek, timeout=40) as y:
        d = json.load(y)
    return (d.get("deploy") or d).get("id", "")


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--dosya", help="çerez JSON dosyası")
    ap.add_argument("--metin", help="çerez JSON metni (dosya yerine)")
    ap.add_argument("--deploy", action="store_true", help="Render dağıtımını tetikle")
    ap.add_argument("--kuru", action="store_true", help="Render'a yazma, yalnızca yerel dosya")
    a = ap.parse_args()

    ham = Path(a.dosya).read_text(encoding="utf-8") if a.dosya else (a.metin or sys.stdin.read())
    cerezler = cerezleri_ayikla(ham)
    state = storage_state(cerezler)

    uzunlar = [(c["name"], len(c["value"])) for c in state["cookies"] if len(c["value"]) > 4096]
    boss = [c["name"] for c in state["cookies"] if not c["value"]]
    print(f"çerez sayısı      : {len(state['cookies'])}")
    print(f"boş değerli       : {boss or '—'}")
    print(f"4096 üzeri parça  : {uzunlar or '—'}")
    for ad in ("arena-auth-prod-v1.0", "arena-auth-prod-v1.1"):
        parca = [c["value"] for c in state["cookies"] if c["name"] == ad]
        if parca:
            print(f"{ad:22}: {len(parca[0])} karakter")

    HEDEF.parent.mkdir(parents=True, exist_ok=True)
    HEDEF.write_text(json.dumps(state, ensure_ascii=False, indent=1), encoding="utf-8")
    os.chmod(HEDEF, 0o600)
    print(f"yazıldı           : {HEDEF}")

    if a.kuru:
        print("Render adımı atlandı (--kuru)")
        return 0

    b64 = base64.b64encode(json.dumps(state, ensure_ascii=False).encode()).decode()
    print("render env        :", json.dumps(render_env_yaz(b64), ensure_ascii=False))
    if a.deploy:
        print("deploy            :", deploy_tetikle())
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
