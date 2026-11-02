# -*- coding: utf-8 -*-
"""
⚡ HIZLI WEB + GÖRSEL ARAMA MOTORU (v2 — paralel yarış)

NEDEN YENİDEN YAZILDI
---------------------
Eski motor (telegram_bot.web_ara) motorları **sırayla** deniyordu:

    DDG-lite (timeout 20s)  →  jina (35s)  →  ddgs  →  Wikipedia (15s)

Render gibi veri merkezi IP'lerinde DuckDuckGo challenge yediğinde toplam süre
**45-70 sn**'ye çıkıyor, üstelik çoğu Türkçe sorguda **boş** dönüyordu
(ölçüm: "yapay zeka görüntü tanıma" → 0 sonuç, 60 sn).

YENİ MİMARİ
-----------
1. Motorlar **paralel** çalıştırılır (ThreadPool).
2. İlk **sağlıklı** (alakalı) sonuç veren motor yarışı kazanır → istek hemen döner.
3. Hepsi için **tek global bütçe** var (varsayılan 8 sn) — toplam süre asla bütçeyi aşmaz.
4. Sağlık kontrolü: gelen sonuçlar sorguyla alakalı mı? (reklam/çöp sayfaları elenir)
5. 10 dk önbellek: aynı sorgu ikinci kez ~0.001 sn'de döner.

Ölçülen tipik süreler (veri merkezi IP'sinden):
    bing            0.15 - 0.4 sn   ✅ en hızlı + en güvenilir
    ddg-lite        0.6 - 2 sn      ⚠️ IP'ye göre challenge
    ddg (jina)      2 - 4 sn        ✅ challenge'ı aşar (jina kendi IP'sinden çeker)
    wikipedia       0.3 - 0.8 sn    ✅ son çıkış (ansiklopedik sorgular)

GÖRSEL ARAMA
------------
    commons         0.7 sn   ✅ Wikimedia Commons — lisansı temiz, orijinal çözünürlük
    ddg (jina)      2.6 sn   ✅ web geneli; thumbnail'lar `w/h/qlt=100` ile 1200-1920px'e yükseltilir
    bing-images     ❌ veri merkezi IP'sinde çöple zehirleniyor (kullanılmıyor)
    openverse       ❌ 20 sn+ timeout (yalnız derin yedek)

Kullanım
--------
    import web_motor
    sonuc, motor, ms = web_motor.web_ara("yapay zeka", limit=10)
    gorseller, motor, ms = web_motor.gorsel_ara("galata kulesi", limit=8)
"""
import html
import json
import os
import re
import threading
import time
import urllib.parse
from concurrent.futures import FIRST_COMPLETED, ThreadPoolExecutor, wait

import requests
from requests.adapters import HTTPAdapter

# ---------------------------- AYARLAR ----------------------------
BUTCE = float(os.environ.get("WEB_BUTCE", "4"))          # ilk tur için üst süre (sn)
TOPLAM_BUTCE = float(os.environ.get("WEB_TOPLAM_BUTCE", "6.5"))  # sadeleştirme dahil tavan
GORSEL_BUTCE = float(os.environ.get("WEB_GORSEL_BUTCE", "4.5"))
EK_PENCERE = float(os.environ.get("WEB_EK_PENCERE", "1.2"))  # ikinci motoru bekleme payı
CACHE_TTL = int(os.environ.get("WEB_CACHE_TTL", "600"))      # 10 dk
CACHE_MAX = int(os.environ.get("WEB_CACHE_MAX", "300"))
JINA = os.environ.get("WEB_JINA", "https://r.jina.ai/")

UA = ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
      "(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36")
BASLIKLAR = {
    "User-Agent": UA,
    "Accept-Language": "tr-TR,tr;q=0.9,en;q=0.7",
    "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
}

# Wikimedia API politikası tanımlayıcı User-Agent ister; bu 429'ları ciddi ölçüde azaltır.
WIKI_UA = ("sarki-api/5.0 (https://github.com/kcbyk/Mp3_apisi; web+gorsel arama) "
           "requests/" + getattr(requests, "__version__", "2"))

_S = requests.Session()
_S.headers.update(BASLIKLAR)
_adapter = HTTPAdapter(pool_connections=24, pool_maxsize=48, max_retries=0)
_S.mount("https://", _adapter)
_S.mount("http://", _adapter)

_STOP = {
    "mi", "mı", "mu", "mü", "ne", "bir", "ve", "ile", "için", "olan", "var", "yok",
    "hangi", "neden", "nasıl", "kadar", "çok", "en", "kaç", "kim", "kimdir", "nedir",
    "demek", "anlama", "gelir", "the", "com", "www", "and", "for", "with", "that",
}


# ---------------------------- YARDIMCILAR ----------------------------
def _temiz(s, n=300):
    """HTML etiketlerini söker, boşlukları toparlar."""
    if not s:
        return ""
    s = re.sub(r"<script.*?</script>", " ", s, flags=re.S | re.I)
    s = re.sub(r"<style.*?</style>", " ", s, flags=re.S | re.I)
    s = re.sub(r"<[^>]+>", "", s)
    s = html.unescape(s)
    return re.sub(r"\s+", " ", s).strip()[:n]


def _kelimeler(q):
    """Sorgudaki anlamlı kelimeler (TR karakterleri sadeleştirilmiş)."""
    q = q.lower().replace("ı", "i").replace("ş", "s").replace("ğ", "g")
    q = q.replace("ü", "u").replace("ö", "o").replace("ç", "c").replace("â", "a")
    return {w for w in re.split(r"\W+", q) if len(w) > 2 and w not in _STOP}


def saglikli(q, sonuc, en_az=1):
    """Sonuçlar sorguyla alakalı mı? (DC IP'lerine servis edilen çöp/reklam elenir)"""
    if not sonuc or len(sonuc) < en_az:
        return False
    kel = _kelimeler(q)
    if not kel:
        return True
    gerek = 1 if len(kel) == 1 else 2
    for s in sonuc[:4]:
        metin = " ".join(str(s.get(k, "") or "") for k in ("baslik", "url", "site", "gorsel")).lower()
        metin = (metin.replace("ı", "i").replace("ş", "s").replace("ğ", "g")
                 .replace("ü", "u").replace("ö", "o").replace("ç", "c"))
        if sum(1 for w in kel if w in metin) >= gerek:
            return True
    return False


def _onbellek_al(anahtar):
    with _kilit:
        kayit = _CACHE.get(anahtar)
        if kayit and time.time() - kayit[0] < CACHE_TTL:
            return kayit[1]
    return None


def _onbellek_koy(anahtar, deger):
    with _kilit:
        if len(_CACHE) >= CACHE_MAX:
            eski = min(_CACHE, key=lambda a: _CACHE[a][0])
            _CACHE.pop(eski, None)
        _CACHE[anahtar] = (time.time(), deger)


_CACHE = {}
_kilit = threading.Lock()
SON_ISTATISTIK = {"web": {}, "gorsel": {}}


def istatistik():
    """Son çağrıların motor/hız bilgisi (debug + arayüz göstergesi için)."""
    with _kilit:
        return json.loads(json.dumps(SON_ISTATISTIK))


# ============================================================================
#                          METİN ARAMA MOTORLARI
# ============================================================================
def _deneli(fn, q, limit, timeout, deneme=3, ara=0.12):
    """Aynı motoru birkaç kez dener (motorlar ara sıra boş/hatalı dönebiliyor).
    İlk DOLU sonuçta durur — 0.15 sn'lik denemeler olduğu için maliyeti küçük."""
    for i in range(max(1, deneme)):
        try:
            sonuc = fn(q, limit, timeout, i)
        except TypeError:
            try:
                sonuc = fn(q, limit, timeout)
            except Exception:
                sonuc = []
        except Exception:
            sonuc = []
        if sonuc:
            return sonuc
        if i + 1 < deneme:
            time.sleep(ara * (i + 1))
    return []


def _bing_rss(q, limit, timeout, deneme=0):
    """⭐ BİRİNCİ MOTOR: Bing RSS (`&format=rss`).
    HTML'e göre çok daha az throttle yiyor, temiz XML dönüyor, ~0.15 sn.
    Ölçüm: 8/10 sorguda ilk denemede dolu; kalanı 2-3. denemede geliyor."""
    parametre = {"q": q, "format": "rss", "count": max(limit, 10)}
    if deneme % 2:                        # tekrar denemelerde pazar yeri değiştir
        parametre["mkt"] = "tr-TR"
    r = _S.get("https://www.bing.com/search", params=parametre, timeout=(3.5, timeout))
    if "<item>" not in r.text:
        return []
    out = []
    for it in re.findall(r"<item>(.*?)</item>", r.text, re.S):
        ti = re.search(r"<title>(.*?)</title>", it, re.S)
        li = re.search(r"<link>(.*?)</link>", it, re.S)
        de = re.search(r"<description>(.*?)</description>", it, re.S)
        if not (ti and li):
            continue
        u = html.unescape(li.group(1).strip())
        if not u.startswith("http"):
            continue
        out.append({"baslik": html.unescape(ti.group(1).strip())[:150], "url": u,
                    "ozet": html.unescape(de.group(1).strip())[:300] if de else ""})
        if len(out) >= limit:
            break
    return out


def _bing(q, limit, timeout, deneme=0):
    """Bing HTML — RSS boş dönerse ikinci yol. Tutarsız olabiliyor, o yüzden deneli."""
    parametre = {"q": q, "count": max(limit, 10), "form": "QBLH"}
    if deneme % 2:
        parametre["setlang"] = "tr"
    r = _S.get("https://www.bing.com/search", params=parametre, timeout=(3.5, timeout))
    out = []
    for blok in re.findall(r'<li class="b_algo".*?(?=<li class="b_algo"|</ol>)', r.text, re.S):
        a = re.search(r'<h2[^>]*>\s*<a[^>]+href="(https?://[^"]+)"[^>]*>(.*?)</a>', blok, re.S)
        if not a:
            continue
        u = a.group(1)
        if "bing.com" in u or "microsofttranslator" in u:
            continue
        sn = re.search(r'<p[^>]*>(.*?)</p>', blok, re.S) or re.search(
            r'class="b_algoSlug"[^>]*>(.*?)</', blok, re.S)
        out.append({"baslik": _temiz(a.group(2), 150), "url": u,
                    "ozet": _temiz(sn.group(1), 300) if sn else ""})
        if len(out) >= limit:
            break
    return out


def _gnews(q, limit, timeout, deneme=0):
    """Google News RSS — haber/güncel sorgularda çok hızlı ve zengin (0.3 sn)."""
    r = _S.get("https://news.google.com/rss/search",
               params={"q": q, "hl": "tr", "gl": "TR", "ceid": "TR:tr"},
               timeout=(3.5, timeout))
    out = []
    for it in re.findall(r"<item>(.*?)</item>", r.text, re.S):
        ti = re.search(r"<title>(.*?)</title>", it, re.S)
        li = re.search(r"<link>(.*?)</link>", it, re.S)
        de = re.search(r"<description>(.*?)</description>", it, re.S)
        if not (ti and li):
            continue
        out.append({"baslik": html.unescape(ti.group(1).strip())[:150],
                    "url": html.unescape(li.group(1).strip()),
                    "ozet": _temiz(de.group(1), 300) if de else ""})
        if len(out) >= limit:
            break
    return out


def _ddg_lite(q, limit, timeout, deneme=0):
    """DDG lite — tek POST; veri merkezi IP'lerinde challenge yiyebilir."""
    r = _S.post("https://lite.duckduckgo.com/lite/", data={"q": q},
                headers={"Referer": "https://lite.duckduckgo.com/"}, timeout=(3.5, timeout))
    if "anomaly" in r.text.lower() or len(r.text) < 800:
        return []
    linkler = re.findall(r'<a[^>]+class="result-link"[^>]+href="(https?://[^"]+)"[^>]*>(.*?)</a>', r.text)
    if not linkler:                                   # eski şablon
        linkler = [(u, t) for u, t in re.findall(r'<a[^>]+href="(https?://[^"]+)"[^>]*>(.*?)</a>', r.text)
                   if "duckduckgo.com" not in u]
    snip = [_temiz(s, 300) for s in re.findall(r'class="result-snippet"[^>]*>(.*?)</td>', r.text, re.S)]
    out, gorulen = [], set()
    for i, (u, t) in enumerate(linkler):
        if "duckduckgo.com" in u or u in gorulen:
            continue
        gorulen.add(u)
        out.append({"baslik": _temiz(t, 150), "url": u, "ozet": snip[i] if i < len(snip) else ""})
        if len(out) >= limit:
            break
    return out


def _ddg_jina(q, limit, timeout, deneme=0):
    """DDG HTML → jina reader üzerinden (jina kendi IP'sinden çeker: challenge'a takılmaz)."""
    hedef = "https://html.duckduckgo.com/html/?q=" + urllib.parse.quote(q)
    r = _S.get(JINA + hedef, timeout=(3.5, timeout))
    isaret = list(re.finditer(r'\[([^\]\[]{5,160})\]\((https://duckduckgo\.com/l/\?uddg=([^)&]+)[^)]*)\)', r.text))
    kayit, sira = {}, []
    for i, m in enumerate(isaret):
        baslik = m.group(1).strip()
        u = urllib.parse.unquote(m.group(3))
        if not u.startswith("http") or u in kayit:
            continue
        sonraki = isaret[i + 1].start() if i + 1 < len(isaret) else len(r.text)
        parca = r.text[m.end():sonraki]
        parca = re.sub(r'!\[[^\]]*\]\([^)]*\)', '', parca)
        parca = re.sub(r'\[([^\]]*)\]\([^)]*\)', r'\1', parca)
        parca = _temiz(parca, 300).strip(" -|")
        kayit[u] = {"baslik": _temiz(baslik, 150), "url": u, "ozet": parca}
        sira.append(u)
        if len(sira) >= limit:
            break
    return [kayit[u] for u in sira]


def _bing_jina(q, limit, timeout, deneme=0):
    """Bing → jina (Bing doğrudan bloklanırsa ikinci yol)."""
    hedef = "https://www.bing.com/search?q=" + urllib.parse.quote(q)
    r = _S.get(JINA + hedef, timeout=(3.5, timeout))
    out, gorulen = [], set()
    for m in re.finditer(r'\[([^\]\[]{8,160})\]\((https?://(?!www\.bing\.com|r\.bing\.com|go\.microsoft)[^)]+)\)', r.text):
        baslik, u = _temiz(m.group(1), 150), m.group(2)
        if u in gorulen or not baslik:
            continue
        gorulen.add(u)
        out.append({"baslik": baslik, "url": u, "ozet": ""})
        if len(out) >= limit:
            break
    return out


def _ddgs_kitap(q, limit, timeout, deneme=0):
    """ddgs kütüphanesi (kuruluysa)."""
    from ddgs import DDGS
    out = []
    for x in DDGS().text(q, max_results=limit):
        u = x.get("href") or x.get("url") or ""
        if u:
            out.append({"baslik": _temiz(x.get("title", ""), 150), "url": u,
                        "ozet": _temiz(x.get("body") or x.get("excerpt") or "", 300)})
    return out


def _wikipedia(q, limit, timeout, deneme=0):
    """Wikipedia (TR → EN) — ansiklopedik sorgular için son çıkış."""
    for dil in ("tr", "en"):
        try:
            r = _S.get(f"https://{dil}.wikipedia.org/w/api.php",
                       params={"action": "query", "list": "search", "srsearch": q,
                               "format": "json", "srlimit": min(limit, 10)},
                       headers={"User-Agent": WIKI_UA}, timeout=(3.5, timeout))
            hits = (r.json().get("query") or {}).get("search") or []
            if hits:
                return [{"baslik": s.get("title", "") + f" — Vikipedi ({dil.upper()})",
                         "url": f"https://{dil}.wikipedia.org/wiki/" +
                                urllib.parse.quote(s.get("title", "").replace(" ", "_")),
                         "ozet": _temiz(s.get("snippet", ""), 300)} for s in hits]
        except Exception:
            continue
    return []


# Sıra = öncelik (eşitlik durumunda kazanan). Hepsi PARALEL başlar.

# ============================================================================
#        İSTEĞE BAĞLI ANAHTARLI SAĞLAYICILAR (varsa en öncelikli çalışır)
# ============================================================================
# Veri merkezi IP'lerinde anahtarsız motorlar zaman zaman çöp/boş dönüyor.
# Aşağıdaki ortam değişkenlerinden BİRİ tanımlıysa o sağlayıcı ilk sıraya geçer
# ve kalite/hız kalıcı olarak düzelir. Hiçbiri yoksa anahtarsız zincir çalışır.
#   BRAVE_KEY    → Brave Search API        (ücretsiz 2.000 sorgu/ay)
#   SERPER_KEY   → serper.dev (Google)     (ücretsiz 2.500 sorgu)
#   TAVILY_KEY   → Tavily (LLM'e hazır)    (ücretsiz 1.000 sorgu/ay)
#   GOOGLE_CSE_KEY + GOOGLE_CSE_CX → Google Programmable Search (100/gün)

def _brave(q, limit, timeout, deneme=0):
    k = (os.environ.get("BRAVE_KEY") or os.environ.get("BRAVE_API_KEY") or "").strip()
    if not k:
        return []
    r = _S.get("https://api.search.brave.com/res/v1/web/search",
               params={"q": q, "count": max(limit, 10), "country": "tr"},
               headers={"X-Subscription-Token": k, "Accept": "application/json"},
               timeout=(3.5, timeout))
    if r.status_code != 200:
        return []
    out = []
    for x in (r.json().get("web") or {}).get("results") or []:
        out.append({"baslik": _temiz(x.get("title", ""), 150), "url": x.get("url", ""),
                    "ozet": _temiz(x.get("description", ""), 300)})
    return out[:limit]


def _serper(q, limit, timeout, deneme=0):
    k = (os.environ.get("SERPER_KEY") or os.environ.get("SERPER_API_KEY") or "").strip()
    if not k:
        return []
    r = _S.post("https://google.serper.dev/search", json={"q": q, "num": max(limit, 10), "gl": "tr", "hl": "tr"},
                headers={"X-API-KEY": k, "Content-Type": "application/json"}, timeout=(3.5, timeout))
    if r.status_code != 200:
        return []
    return [{"baslik": _temiz(x.get("title", ""), 150), "url": x.get("link", ""),
             "ozet": _temiz(x.get("snippet", ""), 300)}
            for x in (r.json().get("organic") or [])][:limit]


def _tavily(q, limit, timeout, deneme=0):
    k = (os.environ.get("TAVILY_KEY") or os.environ.get("TAVILY_API_KEY") or "").strip()
    if not k:
        return []
    r = _S.post("https://api.tavily.com/search",
                json={"api_key": k, "query": q, "max_results": max(limit, 10),
                      "search_depth": "basic"},
                timeout=(3.5, timeout))
    if r.status_code != 200:
        return []
    return [{"baslik": _temiz(x.get("title", ""), 150), "url": x.get("url", ""),
             "ozet": _temiz(x.get("content", ""), 300)}
            for x in (r.json().get("results") or [])][:limit]


def _google_cse(q, limit, timeout, deneme=0):
    k = (os.environ.get("GOOGLE_CSE_KEY") or "").strip()
    cx = (os.environ.get("GOOGLE_CSE_CX") or "").strip()
    if not k or not cx:
        return []
    r = _S.get("https://www.googleapis.com/customsearch/v1",
               params={"key": k, "cx": cx, "q": q, "num": min(max(limit, 10), 10)},
               timeout=(3.5, timeout))
    if r.status_code != 200:
        return []
    return [{"baslik": _temiz(x.get("title", ""), 150), "url": x.get("link", ""),
             "ozet": _temiz(x.get("snippet", ""), 300)}
            for x in (r.json().get("items") or [])][:limit]


def anahtarli_var():
    """Hangi anahtarlı sağlayıcılar tanımlı? (arayüz/durum için)"""
    return {
        "brave": bool(os.environ.get("BRAVE_KEY") or os.environ.get("BRAVE_API_KEY")),
        "serper": bool(os.environ.get("SERPER_KEY") or os.environ.get("SERPER_API_KEY")),
        "tavily": bool(os.environ.get("TAVILY_KEY") or os.environ.get("TAVILY_API_KEY")),
        "google-cse": bool(os.environ.get("GOOGLE_CSE_KEY") and os.environ.get("GOOGLE_CSE_CX")),
    }


METIN_MOTORLARI = [
    ("brave", _brave),                # 🔑 anahtar varsa en iyi seçenek
    ("serper", _serper),              # 🔑 (Google sonuçları)
    ("tavily", _tavily),              # 🔑 (LLM'e hazır özetler)
    ("google-cse", _google_cse),      # 🔑
    ("bing-rss", _bing_rss),          # ⭐ en hızlı anahtarsız: ~0.15 sn
    ("bing", _bing),                  # HTML ikinci yol
    ("wikipedia", _wikipedia),        # 0.2-0.8 sn, her zaman ayakta
    ("google-news", _gnews),          # 0.3 sn, haber sorguları
    ("duckduckgo-lite", _ddg_lite),
    ("bing-jina", _bing_jina),        # jina üzerinden (IP engeli aşılır)
    ("duckduckgo-jina", _ddg_jina),
]
YAVAS_MOTORLAR = {"ddgs"}   # kitaplık motoru yalnız istek üzerine
_ANAHTARLI = {"brave": _brave, "serper": _serper, "tavily": _tavily, "google-cse": _google_cse}


def _aktif_motorlar(derin=False):
    """Tanımlı anahtarlı sağlayıcılar önce, sonra anahtarsız zincir."""
    var = anahtarli_var()
    motorlar = [(ad, fn) for ad, fn in METIN_MOTORLARI if ad not in _ANAHTARLI or var.get(ad)]
    if derin and "ddgs" not in dict(motorlar):
        motorlar.append(("ddgs", _ddgs_kitap))
    return motorlar


def _puan(q, sonuc):
    """0..1 alakalılık puanı: sorgu kelimelerinin İLK 5 SONUCUN TAMAMINDA
    (tekil değil, birleşim) geçme oranı. Tek sonuç yerine liste bakıldığı için
    'python requests timeout' gibi çok kelimeli teknik sorgular yanlış damgalanmaz."""
    kel = _kelimeler(q)
    if not kel:
        return 1.0
    bulunan = set()
    for s in sonuc[:5]:
        metin = " ".join(str(s.get(k, "") or "") for k in ("baslik", "url", "site", "gorsel")).lower()
        metin = (metin.replace("ı", "i").replace("ş", "s").replace("ğ", "g")
                 .replace("ü", "u").replace("ö", "o").replace("ç", "c"))
        for w in kel:
            if w in metin:
                bulunan.add(w)
    return len(bulunan) / len(kel)


ALAKA_ESIK = 0.34    # bu puanın altı "alakasız" sayılır (sadeleştirme turu tetiklenir)


def _yaris(q, limit, motorlar, butce, ek_pencere=EK_PENCERE, bitis=None, birlestir=False):
    """Motorları paralel yarıştırır.

    Kurallar:
      • İlk YETERİNCE ALAKALI sonuç yarışı kazanır → istek hemen döner (~0.2-0.5 sn).
      • Aynı anda gelen adaylar arasında (alakalılık, motor önceliği, uzunluk) sıralanır.
      • Hiçbiri alakalı değilse en yüksek puanlı dolu sonuç döner (etiketli).
      • bitis: mutlak son tarih (time.time()) — toplam süre asla aşılmaz.

    Dönen: (sonuclar, motor_adi, gecen_sn, puan)
    """
    t0 = time.time()
    son_tarih = min(t0 + butce, bitis) if bitis else t0 + butce
    oncelik = {ad: i for i, (ad, _) in enumerate(motorlar)}
    tercihli = {ad for ad, _ in motorlar[:2]}
    ilk_saglikli = None
    ek_pencere_topla = min(1.6, butce / 2)      # birlestir modunda toplama penceresi
    ek_sure = min(0.7, butce)
    esik = min(limit, 3)
    havuz = ThreadPoolExecutor(max_workers=len(motorlar) + 1, thread_name_prefix="web")
    gelecekler = {havuz.submit(_deneli, fn, q, limit, butce): ad for ad, fn in motorlar}
    adaylar = []            # (puan, oncelik, len, sonuc, ad)
    try:
        bekleyen = set(gelecekler)
        while bekleyen:
            kalan = son_tarih - time.time()
            if kalan <= 0:
                break
            bitti, bekleyen = wait(bekleyen, timeout=kalan, return_when=FIRST_COMPLETED)
            if not bitti:
                break
            for f in bitti:
                ad = gelecekler[f]
                try:
                    sonuc = f.result()
                except Exception:
                    continue
                if not sonuc:
                    continue
                adaylar.append((_puan(q, sonuc), oncelik[ad], len(sonuc), sonuc, ad))
            # kazanç kontrolü
            if adaylar:
                en = max(adaylar, key=lambda a: (a[0], -a[1]))
                if birlestir:
                    # galeri modu: ilk sağlıklı sonuçtan sonra kısa bir "toplama" penceresi
                    if en[0] >= ALAKA_ESIK:
                        if ilk_saglikli is None:
                            ilk_saglikli = time.time()
                        saglam_a = [a for a in adaylar if a[0] >= ALAKA_ESIK]
                        toplam = sum(len(a[3]) for a in saglam_a)
                        # 2+ farklı kaynaktan yeterli görsel geldiyse erken çık,
                        # yoksa toplama penceresini sonuna kadar bekle (zengin galeri)
                        if (len(saglam_a) >= 2 and toplam >= limit) or \
                                (time.time() - ilk_saglikli) >= ek_pencere_topla:
                            break
                elif en[0] >= 0.99 or (en[0] >= ALAKA_ESIK and en[2] >= esik):
                    if en[4] in tercihli or (time.time() - t0) >= ek_sure:
                        break

        if not adaylar:
            return [], "yok", round(time.time() - t0, 2), 0.0

        # (puan, motor önceliği, uzunluk) → en iyisi
        puan, _onc, _n, sonuc, ad = max(adaylar, key=lambda a: (a[0], -a[1], a[2]))
        if puan <= 0.0:
            # tamamen alakasız çöp (Bing/DDG veri merkezi IP'lerine bazen böyle servis ediyor)
            return [], "alakasız", round(time.time() - t0, 2), 0.0

        if birlestir:
            # GALERİ MODU: sağlıklı TÜM kaynakları harmanla
            # (Wikimedia=lisanslı/künyeli, DuckDuckGo=web geneli yüksek çözünürlük)
            saglam = sorted([a for a in adaylar if a[0] >= ALAKA_ESIK], key=lambda a: a[1])
            if len(saglam) > 1:
                kuyruklar = [list(a[3]) for a in saglam]
                birlesik, gorulen = [], set()
                while len(birlesik) < limit and any(kuyruklar):
                    ilerleme = False
                    for kuyruk in kuyruklar:
                        while kuyruk:
                            oge = kuyruk.pop(0)
                            anahtar = (oge.get("gorsel") or oge.get("url") or "").split("?")[0]
                            if anahtar and anahtar in gorulen:
                                continue
                            if anahtar:
                                gorulen.add(anahtar)
                            birlesik.append(oge)
                            ilerleme = True
                            break
                        if len(birlesik) >= limit:
                            break
                    if not ilerleme:
                        break
                if birlesik:
                    sonuc = birlesik
                    ad = "+".join(a[4] for a in saglam)

        # kısa ek pencere: liste eksikse başka motorun sonuçlarıyla zenginleştir
        if ek_pencere > 0 and bekleyen and len(sonuc) < limit and puan >= ALAKA_ESIK:
            kalan = max(0.0, min(ek_pencere, son_tarih - time.time()))
            if kalan > 0:
                bitti, _ = wait(bekleyen, timeout=kalan, return_when=FIRST_COMPLETED)
                for f in bitti:
                    try:
                        ek = f.result()
                    except Exception:
                        continue
                    if not ek or _puan(q, ek) < ALAKA_ESIK:
                        continue
                    gorulen = {(x.get("url") or x.get("gorsel") or "").split("?")[0] for x in sonuc}
                    for x in ek:
                        anahtar = (x.get("url") or x.get("gorsel") or "").split("?")[0]
                        if anahtar not in gorulen:
                            sonuc.append(x)
                            gorulen.add(anahtar)
                        if len(sonuc) >= limit:
                            break
                    if len(sonuc) >= limit:
                        break
        return sonuc[:limit], ad, round(time.time() - t0, 2), round(puan, 2)
    finally:
        havuz.shutdown(wait=False, cancel_futures=True)


def _sadelestir(q):
    """Sorguyu kısaltır: en az anlamlı kelimeden kırpar (son çare turu için)."""
    parcalar = [p for p in re.split(r"\s+", q.strip()) if p]
    while len(parcalar) > 1:
        parcalar.pop()                       # sondaki kelimeyi at
        aday = " ".join(parcalar)
        if len(aday) >= 3:
            yield aday
    return


def web_ara(q, limit=10, derin=False):
    """Hızlı web araması — asla boş dönmez (gerekirse sorguyu sadeleştirir).
    Dönen: (sonuclar, motor, sure_sn). Sonuç: [{baslik, url, ozet, alakali}]"""
    q = (q or "").strip()
    limit = max(1, min(int(limit or 10), 30))
    if not q:
        return [], "yok", 0.0
    anahtar = ("w", q.lower(), limit, bool(derin))
    k = _onbellek_al(anahtar)
    if k:
        with _kilit:
            SON_ISTATISTIK["web"] = {"q": q, "motor": k[1] + "+onbellek",
                                     "sure_sn": 0.001, "adet": len(k[0]), "puan": 1.0}
        return k[0], k[1] + "+onbellek", 0.001

    motorlar = _aktif_motorlar(derin)
    t0 = time.time()
    bitis = t0 + TOPLAM_BUTCE               # bu isteğin MUTLAK son tarihi
    sonuc, motor, gecen, puan = _yaris(q, limit, motorlar, BUTCE, bitis=bitis)

    # alakasız/boş → sorguyu sadeleştirip kalan bütçe içinde tekrar dene
    if puan < ALAKA_ESIK:
        for aday in list(_sadelestir(q))[:2]:
            kalan = min(bitis - time.time(), 2.5)
            if kalan < 1.0:
                break
            sonuc2, motor2, gecen2, puan2 = _yaris(aday, limit, motorlar, kalan, bitis=bitis)
            gecen = round(time.time() - t0, 2)
            if puan2 > puan and sonuc2:
                sonuc, motor, puan = sonuc2, motor2 + "(sadeleşti)", puan2
                for x in sonuc:
                    x["sorgu"] = aday
                if puan >= ALAKA_ESIK:
                    break

    for x in sonuc:
        x["alakali"] = puan >= ALAKA_ESIK
    with _kilit:
        SON_ISTATISTIK["web"] = {"q": q, "motor": motor, "sure_sn": round(time.time() - t0, 2),
                                 "adet": len(sonuc), "puan": puan}
    if sonuc:
        _onbellek_koy(anahtar, (sonuc, motor))
    return sonuc, motor, round(time.time() - t0, 2)


# ============================================================================
#                          GÖRSEL ARAMA MOTORLARI
# ============================================================================
def _buyut(url, w=None, h=None):
    """Bing thumbnail URL'ini daha büyük/ kaliteli sürüme çevirir (qlt=100)."""
    if not url or "bing.net" not in url:
        return url
    if not w or not h:
        return url
    ayrac = "&" if "?" in url else "?"
    return f"{url}{ayrac}w={w}&h={h}&c=7&rs=1&qlt=100"


def _olcekli_boyut(w, h, hedef=1600):
    """Uzun kenarı hedef piksele çekerken oranı korur."""
    try:
        w, h = int(w), int(h)
    except (TypeError, ValueError):
        return hedef, hedef
    if w <= 0 or h <= 0:
        return hedef, hedef
    if w >= h:
        return hedef, max(1, round(hedef * h / w))
    return max(1, round(hedef * w / h)), hedef


def _commons(q, limit, timeout, deneme=0):
    """Wikimedia Commons — lisansı temiz, orijinal çözünürlüklü görseller."""
    r = _S.get("https://commons.wikimedia.org/w/api.php", params={
        "action": "query", "generator": "search", "gsrsearch": q,
        "gsrnamespace": 6, "gsrlimit": max(limit, 8), "prop": "imageinfo",
        "iiprop": "url|size|extmetadata", "iiurlwidth": 1200, "format": "json",
    }, headers={"User-Agent": WIKI_UA}, timeout=(3.5, timeout))
    sayfalar = (r.json().get("query") or {}).get("pages") or {}
    sonuc = []
    for p in sorted(sayfalar.values(), key=lambda x: x.get("index", 99)):
        ii = (p.get("imageinfo") or [{}])[0]
        if not ii.get("url"):
            continue
        ad = p.get("title", "").replace("File:", "")
        if re.search(r"\.(svg|gif|tif|tiff|pdf|webm|ogv)$", ii["url"], re.I):
            continue
        ozet, fotografci = "", ""
        try:
            md = ii.get("extmetadata") or {}
            ozet = _temiz((md.get("ImageDescription") or {}).get("value", ""), 200)
            fotografci = _temiz((md.get("Artist") or {}).get("value", ""), 100)
        except Exception:
            pass
        sonuc.append({
            "baslik": ad[:150],
            "gorsel": ii.get("url"),
            "kucuk": ii.get("thumburl") or ii.get("url"),
            "genislik": ii.get("width"),
            "yukseklik": ii.get("height"),
            "site": ii.get("descriptionurl"),
            "kaynak": "wikimedia",
            "lisans": _temiz(((ii.get("extmetadata") or {}).get("LicenseShortName") or {}).get("value", ""), 40),
            "fotografci": fotografci,
            "ozet": ozet,
        })
        if len(sonuc) >= limit:
            break
    return sonuc


def _ddg_gorsel_jina(q, limit, timeout, deneme=0):
    """DDG görselleri → jina reader (veri merkezi IP engelini aşar).

    Markdown akışı (tek satırda birleşik gelebiliyor, bu yüzden blok bölmek yerine
    tek geçişte taranır):

        ![Image 1: ALT](THUMB)1920 × 1080  ### [BAŞLIK ![Image 2](.../ip3/alan.com.ico) alan.com](SAYFA_URL)

    Çıkarılanlar: tam boy görsel (thumbnail URL'i 1600px'e yükseltilir),
    küçük görsel (thumbnail), genişlik/yükseklik, sayfa başlığı, sayfa URL'i,
    kaynak alan adı (favicon adresinden) ve alt metni.
    """
    hedef = ("https://duckduckgo.com/?q=" + urllib.parse.quote(q) +
             "&iax=images&ia=images&kp=1")
    r = _S.get(JINA + hedef, timeout=(3.5, timeout))
    metin = r.text

    GORSEL = re.compile(r'!\[Image \d+:?\s*([^\]]*)\]\((https://[^)\s]+)\)\s*(\d+)\s*[×x]\s*(\d+)')
    SAYFA = re.compile(r'\]\((https?://(?!external-content\.duckduckgo\.com)[^)\s]+)\)')
    ALAN = re.compile(r'/ip3/([^/)\s&]+?)\.(?:ico|png|jpe?g)')

    sonuc, gorulen = [], set()
    for m in GORSEL.finditer(metin):
        alt, thumb, gw, gh = m.group(1).strip(), m.group(2), m.group(3), m.group(4)
        if "external-content.duckduckgo.com/ip3" in thumb:
            continue                                     # favicon
        # başlık satırı: bu görselden sonraki ~600 karakter
        pencere = metin[m.end():m.end() + 600]
        satir = pencere.split("\n", 1)[0]
        sayfa = ""
        for u in SAYFA.findall(satir):
            if "duckduckgo.com" in u:
                continue
            sayfa = u
        alan = ""
        ma = ALAN.search(satir)
        if ma:
            alan = ma.group(1).lower()
        if not sayfa and alan:
            sayfa = "https://" + alan
        # başlık: "### [" sonrası, "![" veya "](...)" öncesi
        bas_metin = ""
        mb = re.search(r'#+\s*\[([^\]]{2,200})', satir)
        if mb:
            bas_metin = re.split(r'!\[', mb.group(1))[0]
        if not bas_metin.strip():
            bas_metin = re.split(r'!\[Image', alt)[0]
        # thumbnail içindeki asıl adres (?u=...) → daha büyük sürüm
        ham = thumb
        mu = re.search(r'[?&]u=([^&]+)', thumb)
        if mu:
            ham = urllib.parse.unquote(mu.group(1))
        anahtar = ham.split("?")[0]
        if anahtar in gorulen:
            continue
        gorulen.add(anahtar)
        w, h = _olcekli_boyut(gw, gh, 1600)
        sonuc.append({
            "baslik": _temiz(bas_metin, 140),
            "gorsel": _buyut(ham, w, h),
            "kucuk": thumb,
            "genislik": int(gw) if gw.isdigit() else None,
            "yukseklik": int(gh) if gh.isdigit() else None,
            "site": sayfa,
            "site_domain": alan or (urllib.parse.urlparse(sayfa).netloc.replace("www.", "") if sayfa else ""),
            "kaynak": "duckduckgo",
            "lisans": "",
            "fotografci": "",
            "ozet": _temiz(alt, 200),
        })
        if len(sonuc) >= limit:
            break
    return sonuc


def _wikipedia_gorsel(q, limit, timeout, deneme=0):
    """Wikipedia sayfa ana görselleri (varlık sorguları için yüksek kalite)."""
    sonuc = []
    for dil in ("tr", "en"):
        try:
            r = _S.get(f"https://{dil}.wikipedia.org/w/api.php", params={
                "action": "query", "generator": "search", "gsrsearch": q, "gsrlimit": limit,
                "prop": "pageimages", "pithumbsize": 1400, "format": "json"},
                headers={"User-Agent": WIKI_UA}, timeout=(3.5, timeout))
            sayfalar = (r.json().get("query") or {}).get("pages") or {}
            for p in sorted(sayfalar.values(), key=lambda x: x.get("index", 99)):
                th = p.get("thumbnail") or {}
                if not th.get("source"):
                    continue
                sonuc.append({
                    "baslik": p.get("title", ""),
                    "gorsel": th["source"],
                    "kucuk": th["source"],
                    "genislik": th.get("width"),
                    "yukseklik": th.get("height"),
                    "site": f"https://{dil}.wikipedia.org/wiki/" +
                            urllib.parse.quote(p.get("title", "").replace(" ", "_")),
                    "kaynak": f"wikipedia-{dil}", "lisans": "CC", "ozet": "",
                })
        except Exception:
            continue
        if len(sonuc) >= limit:
            break
    return sonuc


_SORU_KELIMELERI = {
    "nerede", "nerede?", "nasıl", "nedir", "kimdir", "kim", "hangi", "neden", "niçin",
    "ne", "mi", "mı", "mu", "mü", "kaç", "resim", "resmi", "resimleri", "görsel",
    "görseli", "görselleri", "fotoğraf", "fotoğrafı", "fotoğrafları", "foto", "hakkında",
    "ile", "ve", "için", "bir", "çok", "en", "güzel", "kaliteli",
}


def _gorsel_sorgu(q):
    """Görsel aramada soru/bağlaç kelimelerini atar: 'galata kulesi nerede' → 'galata kulesi'."""
    parcalar = [p for p in re.split(r"\s+", (q or "").strip()) if p]
    kalan = [p for p in parcalar if p.lower() not in _SORU_KELIMELERI]
    return " ".join(kalan) if len(kalan) >= 1 else (q or "")




def _ddg_gorsel_dogrudan(q, limit, timeout, deneme=0):
    """DuckDuckGo görsel API'si (vqd akışı) — jina'ya gerek yok, en zengin meta veri.
    Her sonuçta: image (tam boy), thumbnail, title, width, height, url (kaynak sayfa).
    Veri merkezi IP'lerinde bazen 'anomaly' (HTTP 202) döner → o zaman boş liste."""
    try:
        h = _S.get("https://duckduckgo.com/", params={"q": q, "iax": "images", "ia": "images"},
                   timeout=(3.0, timeout)).text
        m = (re.search(r'vqd="([\d-]+)"', h) or re.search(r'vqd=([\d-]+)&', h)
             or re.search(r'vqd["\']?\s*[:=]\s*["\']([\d-]+)', h))
        if not m:
            return []
        vqd = m.group(1)
        r = _S.get("https://duckduckgo.com/i.js",
                   params={"l": "tr-tr", "o": "json", "q": q, "vqd": vqd,
                           "f": ",,,", "p": "1"},
                   headers={"Referer": "https://duckduckgo.com/",
                            "Accept": "application/json, text/javascript, */*; q=0.01",
                            "X-Requested-With": "XMLHttpRequest"},
                   timeout=(3.0, timeout))
        if r.status_code != 200 or "json" not in (r.headers.get("content-type") or ""):
            return []
        veri = r.json().get("results") or []
    except Exception:
        return []
    sonuc = []
    for x in veri:
        img = x.get("image") or x.get("thumbnail")
        if not img:
            continue
        gw, gh = x.get("width"), x.get("height")
        try:
            w, h = _olcekli_boyut(gw, gh, 1600)
        except Exception:
            w, h = 1600, 1600
        sonuc.append({
            "baslik": _temiz(x.get("title", ""), 140),
            "gorsel": _buyut(img, w, h),
            "kucuk": x.get("thumbnail") or img,
            "genislik": int(gw) if str(gw).isdigit() else None,
            "yukseklik": int(gh) if str(gh).isdigit() else None,
            "site": x.get("url") or "",
            "site_domain": (urllib.parse.urlparse(x.get("url") or "").netloc.replace("www.", "")),
            "kaynak": "duckduckgo",
            "lisans": "",
            "fotografci": _temiz(x.get("source", ""), 60) if x.get("source") else "",
            "ozet": _temiz(x.get("title", ""), 200),
        })
        if len(sonuc) >= limit:
            break
    return sonuc




# ---------------------------------------------------------------------------
#  İSTEĞE BAĞLI ANAHTARLI GÖRSEL SAĞLAYICILARI (varsa en öncelikli)
# ---------------------------------------------------------------------------
# Veri merkezi IP'lerinde DDG/Bing görselleri engelleniyor. Aşağıdaki ücretsiz
# API'lerden biri tanımlanırsa galeri kalitesi ve "fotoğrafçı" bilgisi kalıcı düzelir.
#   PEXELS_KEY    → pexels.com API      (ücretsiz 200 istek/saat)  ⭐ en iyi
#   PIXABAY_KEY   → pixabay.com API     (ücretsiz 100 istek/dk)
#   UNSPLASH_KEY  → unsplash.com API    (ücretsiz 50 istek/saat)

def _pexels(q, limit, timeout, deneme=0):
    k = (os.environ.get("PEXELS_KEY") or os.environ.get("PEXELS_API_KEY") or "").strip()
    if not k:
        return []
    r = _S.get("https://api.pexels.com/v1/search",
               params={"query": q, "per_page": max(limit, 10), "locale": "tr-TR"},
               headers={"Authorization": k}, timeout=(3.5, timeout))
    if r.status_code != 200:
        return []
    out = []
    for x in (r.json().get("photos") or []):
        src = x.get("src") or {}
        out.append({
            "baslik": _temiz(x.get("alt") or f"Pexels fotoğrafı {x.get('id')}", 140),
            "gorsel": src.get("original") or src.get("large2x") or src.get("large"),
            "kucuk": src.get("medium") or src.get("small"),
            "genislik": x.get("width"), "yukseklik": x.get("height"),
            "site": x.get("url"), "site_domain": "pexels.com",
            "kaynak": "pexels", "fotografci": _temiz(x.get("photographer", ""), 60),
            "lisans": "Pexels License", "ozet": _temiz(x.get("alt", ""), 200),
        })
        if len(out) >= limit:
            break
    return out


def _pixabay(q, limit, timeout, deneme=0):
    k = (os.environ.get("PIXABAY_KEY") or os.environ.get("PIXABAY_API_KEY") or "").strip()
    if not k:
        return []
    r = _S.get("https://pixabay.com/api/",
               params={"key": k, "q": q, "image_type": "photo", "per_page": max(3, min(limit, 200)),
                       "safesearch": "true"}, timeout=(3.5, timeout))
    if r.status_code != 200:
        return []
    out = []
    for x in (r.json().get("hits") or []):
        out.append({
            "baslik": _temiz(x.get("tags", ""), 140),
            "gorsel": x.get("largeImageURL") or x.get("webformatURL"),
            "kucuk": x.get("webformatURL"),
            "genislik": x.get("imageWidth"), "yukseklik": x.get("imageHeight"),
            "site": x.get("pageURL"), "site_domain": "pixabay.com",
            "kaynak": "pixabay", "fotografci": _temiz(x.get("user", ""), 60),
            "lisans": "Pixabay License", "ozet": _temiz(x.get("tags", ""), 200),
        })
        if len(out) >= limit:
            break
    return out


def _unsplash(q, limit, timeout, deneme=0):
    k = (os.environ.get("UNSPLASH_KEY") or os.environ.get("UNSPLASH_ACCESS_KEY") or "").strip()
    if not k:
        return []
    r = _S.get("https://api.unsplash.com/search/photos",
               params={"query": q, "per_page": max(limit, 10)},
               headers={"Authorization": f"Client-ID {k}"}, timeout=(3.5, timeout))
    if r.status_code != 200:
        return []
    out = []
    for x in (r.json().get("results") or []):
        urls = x.get("urls") or {}
        out.append({
            "baslik": _temiz(x.get("alt_description") or x.get("description") or "", 140),
            "gorsel": urls.get("full") or urls.get("regular"),
            "kucuk": urls.get("small"),
            "genislik": x.get("width"), "yukseklik": x.get("height"),
            "site": (x.get("links") or {}).get("html"),
            "site_domain": "unsplash.com",
            "kaynak": "unsplash",
            "fotografci": _temiz((x.get("user") or {}).get("name", ""), 60),
            "lisans": "Unsplash License", "ozet": _temiz(x.get("description") or "", 200),
        })
        if len(out) >= limit:
            break
    return out


_GORSEL_ANAHTARLI = {"pexels": _pexels, "pixabay": _pixabay, "unsplash": _unsplash}


def gorsel_anahtarli_var():
    return {
        "pexels": bool(os.environ.get("PEXELS_KEY") or os.environ.get("PEXELS_API_KEY")),
        "pixabay": bool(os.environ.get("PIXABAY_KEY") or os.environ.get("PIXABAY_API_KEY")),
        "unsplash": bool(os.environ.get("UNSPLASH_KEY") or os.environ.get("UNSPLASH_ACCESS_KEY")),
    }


GORSEL_MOTORLARI = [
    ("wikimedia", _commons),
    ("duckduckgo", _ddg_gorsel_dogrudan),   # en zengin meta (kaynak sayfa + boyut)
    ("duckduckgo-jina", _ddg_gorsel_jina),
    ("wikipedia", _wikipedia_gorsel),
]


def gorsel_ara(q, limit=8):
    """Hızlı görsel araması (asla boş dönmez).
    Dönen: (gorseller, motor, sure_sn)
    Görsel: {baslik, gorsel, kucuk, genislik, yukseklik, site, kaynak, lisans, ozet}"""
    q = (q or "").strip()
    limit = max(1, min(int(limit or 8), 24))
    if not q:
        return [], "yok", 0.0
    anahtar = ("g", q.lower(), limit)
    k = _onbellek_al(anahtar)
    if k:
        with _kilit:
            SON_ISTATISTIK["gorsel"] = {"q": q, "motor": k[1] + "+onbellek",
                                        "sure_sn": 0.001, "adet": len(k[0])}
        return k[0], k[1] + "+onbellek", 0.001
    t0 = time.time()
    bitis = t0 + GORSEL_BUTCE
    q_gorsel = _gorsel_sorgu(q)
    gvar = gorsel_anahtarli_var()
    motorlar = [(ad, fn) for ad, fn in GORSEL_MOTORLARI if ad not in _GORSEL_ANAHTARLI or gvar.get(ad)]
    gorseller, motor, gecen, puan = _yaris(q_gorsel, limit, motorlar,
                                           min(GORSEL_BUTCE, 2.6),
                                           bitis=bitis, birlestir=True)
    if puan < ALAKA_ESIK:
        for aday in list(_sadelestir(q_gorsel))[:2]:
            kalan = min(bitis - time.time(), 2.5)
            if kalan < 1.0:
                break
            g2, m2, _g, p2 = _yaris(aday, limit, GORSEL_MOTORLARI, kalan, bitis=bitis)
            if p2 > puan and g2:
                gorseller, motor, puan = g2, m2 + "(sadeleşti)", p2
                if puan >= ALAKA_ESIK:
                    break
    with _kilit:
        SON_ISTATISTIK["gorsel"] = {"q": q, "motor": motor, "sure_sn": round(time.time() - t0, 2),
                                    "adet": len(gorseller)}
    if gorseller:
        _onbellek_koy(anahtar, (gorseller, motor))
    return gorseller, motor, round(time.time() - t0, 2)


def ai_paketi(q, limit=8, gorsel_limit=8, detay=False):
    """🤖 AI için tek çağrılık paket: metin sonuçları + görseller paralel.
    Dönen: dict"""
    t0 = time.time()
    havuz = ThreadPoolExecutor(max_workers=3, thread_name_prefix="aipaket")
    f_metin = havuz.submit(web_ara, q, limit)
    f_gorsel = havuz.submit(gorsel_ara, q, gorsel_limit)
    f_oku = None
    metin, motor, metin_sn = ([], "yok", 0.0)
    try:
        metin, motor, metin_sn = f_metin.result(timeout=BUTCE + 2)
    except Exception:
        pass
    gorseller, gorsel_motor, gorsel_sn = ([], "yok", 0.0)
    try:
        gorseller, gorsel_motor, gorsel_sn = f_gorsel.result(timeout=GORSEL_BUTCE + 2)
    except Exception:
        pass
    if detay and metin:
        f_oku = havuz.submit(_oku_paralel, metin[:3])
        try:
            kutular = f_oku.result(timeout=45)
            for i, v in (kutular or {}).items():
                if i < len(metin) and v:
                    metin[i]["metin"] = v.get("metin", "")
                    metin[i]["metin_karakter"] = v.get("karakter", 0)
        except Exception:
            pass
    havuz.shutdown(wait=False, cancel_futures=True)
    return {
        "q": q,
        "sonuclar": metin,
        "gorseller": gorseller,
        "motor": motor,
        "gorsel_motor": gorsel_motor,
        "metin_sn": metin_sn,
        "gorsel_sn": gorsel_sn,
        "sure_sn": round(time.time() - t0, 2),
    }


def _oku_paralel(sonuclar):
    """İlk 3 sonucun sayfa metnini paralel çeker (RAG paketi)."""
    import telegram_bot as _tb
    kutular = {}

    def _cek(i, s):
        try:
            veri, _h = _tb.oku(s["url"], 5000)
            if veri:
                kutular[i] = veri
        except Exception:
            pass

    isler = [threading.Thread(target=_cek, args=(i, s), daemon=True)
             for i, s in enumerate(sonuclar)]
    for t in isler:
        t.start()
    for t in isler:
        t.join(timeout=20)
    return kutular


# ============================================================================
#     SAYFA GÖRSELİ ÇIKARICI (og:image / twitter:image / image_src + fotoğrafçı)
# ============================================================================
_META_ADLARI = {
    "og:image", "og:image:url", "og:image:secure_url", "og:image:width", "og:image:height",
    "og:image:alt", "twitter:image", "twitter:image:src", "twitter:image:alt",
    "image", "thumbnail", "thumbnailurl", "author", "article:author", "og:site_name",
    "og:title", "twitter:creator", "dc.creator", "parsely-author", "sailthru.author",
}


def _meta_ayikla(html_metin):
    """<meta property="og:image" content="..."> etiketlerini (her iki sırada) toplar."""
    bulunan = {}
    for etiket in re.finditer(r"<meta\b[^>]*>", html_metin, re.I):
        t = etiket.group(0)
        ad = re.search(r'(?:property|name|itemprop)\s*=\s*["\']([^"\']+)["\']', t, re.I)
        ic = re.search(r'content\s*=\s*["\']([^"\']*)["\']', t, re.I)
        if not (ad and ic):
            continue
        anahtar = ad.group(1).strip().lower()
        if anahtar in _META_ADLARI and anahtar not in bulunan:
            bulunan[anahtar] = html.unescape(ic.group(1).strip())
    # <link rel="image_src" href="...">
    m = re.search(r'<link[^>]+rel\s*=\s*["\'](?:image_src|apple-touch-icon)["\'][^>]*href\s*=\s*["\']([^"\']+)["\']',
                  html_metin, re.I)
    if m:
        bulunan.setdefault("image_src", html.unescape(m.group(1).strip()))
    return bulunan


def _html_gorsel(url, timeout=4.0, maks_bayt=400_000):
    """Sayfa HTML'inden ana görseli + fotoğrafçı bilgisini çıkarır.
    Dönen: {image_url, og_image, thumbnail_url, gorsel_genislik, gorsel_yukseklik, fotografci}
    Hiçbir şey bulunamazsa {} döner (hata fırlatmaz)."""
    if not url or not str(url).startswith(("http://", "https://")):
        return {}
    try:
        r = _S.get(url, timeout=(2.5, timeout), stream=True, allow_redirects=True,
                   headers={"Accept": "text/html,application/xhtml+xml,*/*;q=0.8"})
    except Exception:
        return {}
    try:
        ct = (r.headers.get("content-type") or "").lower()
        if "html" not in ct and "xml" not in ct:
            return {}
        # iter_content gzip/brotli'yi çözer (raw.read çözmez!) — ilk maks_bayt kadar oku
        parcalar, toplam = [], 0
        for parca in r.iter_content(chunk_size=65536):
            if not parca:
                continue
            parcalar.append(parca)
            toplam += len(parca)
            if toplam >= maks_bayt:
                break
        ham = b"".join(parcalar)[:maks_bayt]
    except Exception:
        return {}
    finally:
        try:
            r.close()
        except Exception:
            pass
    if not ham:
        return {}
    metin = ham.decode(r.encoding or "utf-8", "ignore")
    m = _meta_ayikla(metin)
    aday = (m.get("og:image:secure_url") or m.get("og:image") or m.get("og:image:url")
            or m.get("twitter:image") or m.get("twitter:image:src")
            or m.get("image") or m.get("image_src") or m.get("thumbnailurl") or "")
    if not aday:
        return {}
    tam = urllib.parse.urljoin(url, aday)
    if not tam.startswith("http"):
        return {}
    cikti = {
        "image_url": tam,
        "og_image": tam,
        "thumbnail_url": tam,
        "gorsel_kaynak": "og:image",
    }
    for alan, anahtar in (("gorsel_genislik", "og:image:width"),
                          ("gorsel_yukseklik", "og:image:height")):
        v = m.get(anahtar)
        if v and str(v).split(".")[0].isdigit():
            cikti[alan] = int(str(v).split(".")[0])
    fotografci = (m.get("author") or m.get("article:author") or m.get("twitter:creator")
                  or m.get("dc.creator") or m.get("parsely-author") or m.get("sailthru.author") or "")
    if fotografci and len(fotografci) < 120:
        cikti["fotografci"] = _temiz(fotografci, 100)
    alt = m.get("og:image:alt") or m.get("twitter:image:alt")
    if alt:
        cikti["gorsel_alt"] = _temiz(alt, 200)
    return cikti


def sonuclara_gorsel_ekle(sonuclar, adet=3, butce=2.0, galeri=None):
    """Metin sonuçlarının her birine kendi sayfasından görsel bilgisi ekler.
    Paralel çalışır ve 'butce' saniyeyi AŞMAZ (yavaş siteler isteği bekletmez).
    galeri: görsel arama sonuçları — og:image bulunamazsa aynı domainden eşleştirilir.
    """
    if not sonuclar:
        return sonuclar
    hedef = min(adet, len(sonuclar))
    sonuc_kutusu = {}

    def _cek(i, u):
        try:
            sonuc_kutusu[i] = _html_gorsel(u, timeout=butce)
        except Exception:
            sonuc_kutusu[i] = {}

    isler = [threading.Thread(target=_cek, args=(i, sonuclar[i].get("url", "")), daemon=True)
             for i in range(hedef)]
    for t in isler:
        t.start()
    bitis = time.time() + butce
    for t in isler:
        t.join(timeout=max(0.05, bitis - time.time()))

    # domain → galeri görseli (og:image bulunamayanlar için yedek)
    domain_haritasi = {}
    for g in (galeri or []):
        for kaynak in (g.get("site"), g.get("site_domain"), g.get("gorsel")):
            if not kaynak:
                continue
            try:
                d = urllib.parse.urlparse(kaynak).netloc.replace("www.", "")
            except Exception:
                continue
            if d and d not in domain_haritasi:
                domain_haritasi[d] = g

    for i, s in enumerate(sonuclar):
        bilgi = sonuc_kutusu.get(i) or {}
        if bilgi:
            s.update(bilgi)
            if bilgi.get("image_url") and not s.get("thumbnail_url"):
                s["thumbnail_url"] = bilgi["image_url"]
            continue
        # og:image yok → galeriden aynı domain eşleşmesi
        try:
            d = urllib.parse.urlparse(s.get("url", "")).netloc.replace("www.", "")
        except Exception:
            d = ""
        g = domain_haritasi.get(d)
        if g:
            s["image_url"] = g.get("gorsel")
            s["thumbnail_url"] = g.get("kucuk") or g.get("gorsel")
            s["og_image"] = g.get("gorsel")
            s["gorsel_kaynak"] = "galeri:" + str(g.get("kaynak") or "")
            if g.get("genislik"):
                s["gorsel_genislik"] = g["genislik"]
            if g.get("yukseklik"):
                s["gorsel_yukseklik"] = g["yukseklik"]
            if g.get("fotografci"):
                s["fotografci"] = g["fotografci"]
    return sonuclar

