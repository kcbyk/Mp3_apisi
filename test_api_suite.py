# -*- coding: utf-8 -*-
"""
Kapsamlı Test ve Performans Benchmark Paketi
"""
import os
import time
import unittest

os.environ["API_KEY"] = "test-suite-key"
os.environ["SARKI_DISK_MB"] = "200"

import api
import api_core
import telegram_bot as core


class TestMp3Apisi(unittest.TestCase):

    @classmethod
    def setUpClass(cls):
        cls.client = api.app.test_client()
        cls.key = "test-suite-key"

    def test_01_health(self):
        r = self.client.get("/api/v1/health")
        self.assertEqual(r.status_code, 200)
        data = r.get_json()
        self.assertTrue(data.get("ok"))
        self.assertEqual(data.get("servis"), "sarki-api")

    def test_02_search(self):
        t0 = time.time()
        r = self.client.get(f"/api/v1/search?q=queen+bohemian+rhapsody&key={self.key}")
        dur = time.time() - t0
        self.assertEqual(r.status_code, 200)
        data = r.get_json()
        self.assertTrue(data.get("ok"))
        self.assertGreater(data.get("adet", 0), 0)
        print(f"\n[TEST] Arama süresi: {dur:.2f} sn ({data.get('adet')} sonuç)")

    def test_03_direct_stream_download(self):
        t0 = time.time()
        r = self.client.get(f"/api/v1/download?q=Alan+Walker+The+Spectre&key={self.key}")
        self.assertEqual(r.status_code, 200)
        chunk = next(r.response)
        dur = time.time() - t0
        self.assertGreater(len(chunk), 0)
        self.assertIn("audio/mpeg", r.headers.get("Content-Type", ""))
        print(f"[TEST] Zero-Wait Stream İndirme: {dur:.2f} sn (ilk chunk iletildi)")

    def test_04_direct_link_and_stream(self):
        t0 = time.time()
        r_link = self.client.get(f"/api/v1/link?q=Alan+Walker+The+Spectre&key={self.key}")
        dur = time.time() - t0
        self.assertEqual(r_link.status_code, 200)
        self.assertTrue(r_link.get_json().get("ok"))
        print(f"[TEST] CDN Link Çözümleme: {dur:.2f} sn")

        r_stream = self.client.get(f"/api/v1/stream?q=Alan+Walker+The+Spectre&key={self.key}")
        self.assertEqual(r_stream.status_code, 302)
        self.assertTrue(bool(r_stream.headers.get("Location")))

    def test_05_soundcloud_convert_job(self):
        r_search = self.client.get(f"/api/v1/search?q=Alan+Walker+The+Spectre&key={self.key}").get_json()
        sc_items = [s for s in r_search.get("sonuclar", []) if s.get("kaynak") == "soundcloud" and s.get("sc_prog_url")]
        if sc_items:
            t0 = time.time()
            r = self.client.post(f"/api/v1/convert?key={self.key}", json=sc_items[0])
            self.assertEqual(r.status_code, 200)
            jid = r.get_json()["job_id"]
            while time.time() - t0 < 15:
                time.sleep(0.1)
                s = self.client.get(f"/api/v1/status/{jid}?key={self.key}").get_json()
                if s.get("durum") in ("bitti", "hata"):
                    break
            dur = time.time() - t0
            self.assertEqual(s.get("durum"), "bitti")
            self.assertTrue(bool(s.get("dosya")))
            print(f"[TEST] SoundCloud Diske İndirme: {dur:.2f} sn (Dosya: {s.get('dosya')})")

    def test_06_lyrics(self):
        t0 = time.time()
        r = self.client.get(f"/api/v1/sozler?q=Bohemian+Rhapsody&sanatci=Queen&key={self.key}")
        dur = time.time() - t0
        self.assertEqual(r.status_code, 200)
        data = r.get_json()
        self.assertTrue(data.get("ok"))
        print(f"[TEST] Şarkı Sözü Getirme: {dur:.2f} sn (Kaynak: {data.get('kaynak')})")

    def test_07_album_cover(self):
        t0 = time.time()
        r = self.client.get(f"/api/v1/kapak?q=Queen+Bohemian+Rhapsody&key={self.key}")
        dur = time.time() - t0
        self.assertEqual(r.status_code, 200)
        data = r.get_json()
        self.assertTrue(data.get("ok"))
        print(f"[TEST] Albüm Kapağı Getirme: {dur:.2f} sn (Kaynak: {data.get('kaynak')})")


if __name__ == "__main__":
    unittest.main()
