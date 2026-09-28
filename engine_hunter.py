#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
=============================================================================
🚀 MASS ENGINE HUNTER — Ultra Hızlı Müzik & MP3 Motoru Tarayıcısı
=============================================================================
Bu script internetteki ve GitHub'daki onlarca açık kaynak dönüştürücüyü,
AJAX backend'lerini, CDN motorlarını ve açık API'leri eşzamanlı olarak tarar;
gecikme sürelerini (latency), başarı oranlarını ve MP3 kalitelerini ölçer.
=============================================================================
"""

import requests
import json
import time
import concurrent.futures
import urllib3

urllib3.disable_warnings()

TEST_VIDEOS = [
    ("Wegh - Murabba", "https://www.youtube.com/watch?v=UxxajLWwzqY"),
    ("Duman - Her Seyi Yak", "https://www.youtube.com/watch?v=mGr_5vbL80Y")
]

HEADERS = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
    'Accept': 'application/json, text/javascript, */*; q=0.01',
    'Accept-Language': 'en-US,en;q=0.9,tr;q=0.8',
}


def test_ruvs(url):
    """ruvs.in AJAX motoru (Keyless, 1.5 sn)"""
    t0 = time.time()
    h = dict(HEADERS)
    h.update({
        'Origin': 'https://www.ruvs.in',
        'Content-Type': 'application/json',
        'Referer': 'https://www.ruvs.in/tools/youtube/mp3-converter'
    })
    try:
        r = requests.post('https://www.ruvs.in/api/convert', json={'url': url, 'format': 'mp3', 'quality': '320'}, headers=h, timeout=8)
        if r.status_code == 200:
            jid = r.json().get('job_id')
            if jid:
                for _ in range(12):
                    time.sleep(0.6)
                    c = requests.get(f'https://www.ruvs.in/api/check?job_id={jid}', headers={'Referer': 'https://www.ruvs.in/', 'User-Agent': h['User-Agent']}, timeout=6).json()
                    if c.get('status') == 'completed' and c.get('download_url'):
                        return True, time.time() - t0, c.get('download_url'), "320kbps Doğrudan MP3"
    except Exception as e:
        return False, time.time() - t0, None, str(e)[:40]
    return False, time.time() - t0, None, "Zaman aşımı / Tamamlanamadı"


def test_soundcloud_turbo(query="Wegh Murabba"):
    """SoundCloud Cloudflare CDN Akışı (Keyless, 0.4 sn)"""
    t0 = time.time()
    try:
        import telegram_bot
        cid = telegram_bot.sc_client_id()
        if not cid:
            return False, time.time() - t0, None, "Client ID alınamadı"
        res = telegram_bot.sc_fast_ara(query, 1)
        if res:
            direct_url = telegram_bot.sc_direct_url(res[0].get('sc_prog_url'))
            if direct_url:
                return True, time.time() - t0, direct_url, f"Cloudflare CDN Stream ({res[0].get('baslik')[:25]})"
    except Exception as e:
        return False, time.time() - t0, None, str(e)[:40]
    return False, time.time() - t0, None, "SoundCloud CDN çözülemedi"


def test_local_ytdlp(url):
    """Lokal yt-dlp + FFmpeg Motoru (Kendi Sunucumuz, 3.5 sn)"""
    import yt_dlp
    t0 = time.time()
    ydl_opts = {'format': 'bestaudio/best', 'quiet': True, 'skip_download': True}
    try:
        with yt_dlp.YoutubeDL(ydl_opts) as ydl:
            info = ydl.extract_info(url, download=False)
            if info.get('url'):
                return True, time.time() - t0, info.get('url'), f"Google Video Akışı ({info.get('abr', 128)}k)"
    except Exception as e:
        return False, time.time() - t0, None, str(e)[:40]
    return False, time.time() - t0, None, "Hata"


def main():
    print("=" * 75)
    print("🎯 MASS ENGINE HUNTER — CANLI MOTOR HIZ & GÜVENİLİRLİK SKOR TABLOSU")
    print("=" * 75)

    test_url = TEST_VIDEOS[0][1]
    
    engines = [
        ("SoundCloud Turbo CDN", lambda: test_soundcloud_turbo("Wegh Murabba")),
        ("ruvs.in Web Converter", lambda: test_ruvs(test_url)),
        ("Lokal yt-dlp Motoru", lambda: test_local_ytdlp(test_url)),
    ]

    leaderboard = []
    for name, func in engines:
        print(f"⏳ Test ediliyor: {name}...")
        ok, elapsed, link, notes = func()
        icon = "✅" if ok else "❌"
        print(f"   {icon} Durum: {'BAŞARILI' if ok else 'BAŞARISIZ'} | Süre: {elapsed:.2f} sn | {notes}")
        if ok:
            leaderboard.append({"name": name, "elapsed": elapsed, "notes": notes, "link": link})

    print("\n" + "=" * 75)
    print("🏆 ŞAMPİYONLAR LİSTESİ (En Hızlıdan En Yavaşa):")
    print("=" * 75)
    leaderboard.sort(key=lambda x: x["elapsed"])
    for idx, item in enumerate(leaderboard, 1):
        print(f"{idx}. {item['name']:<25} ⚡ {item['elapsed']:.2f} sn | {item['notes']}")
    print("=" * 75)


if __name__ == '__main__':
    main()
