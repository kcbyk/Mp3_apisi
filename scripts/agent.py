#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
agent.py — Uzak kontrol ajanı (Linux VM + Windows PC + Termux uyumlu)
=====================================================================
AI-KONTROL-REHBERI.md'deki protokolün birebir uygulaması:

  Broker : broker.emqx.io:1883  (yedek: broker.hivemq.com, test.mosquitto.org)
  Topics : termux-kopru/<TOKEN>/cmd    (AI → cihaz)
           termux-kopru/<TOKEN>/out    (cihaz → AI)
           termux-kopru/<TOKEN>/status (retained + 15 sn heartbeat)

  Mesajlar:
    {"type":"ping","id":X}                     → {"type":"pong","id":X,"t":...}
    {"type":"exec","id":X,"cmd":"..","timeout":S}
        → {"type":"out","id":X,"tag":"o","d":"..."}  (stdout/stderr, parça parça)
        → {"type":"done","id":X,"code":N,"dur":S}
    {"type":"update","url":"..","sha":"<sha256>"}     → kendini günceller + yeniden başlar

Kullanım:
    pip install paho-mqtt
    python3 agent.py <ODA_TOKEN>

Güvenlik: oda token'ı bu makinenin anahtarıdır — paylaşma.
Her komut yerelde de loglanır (şeffaflık).
"""
import hashlib
import json
import os
import platform
import queue
import shutil
import signal
import socket
import subprocess
import sys
import tempfile
import threading
import time
import urllib.request
import uuid

try:
    import paho.mqtt.client as mqtt
except ImportError:
    sys.stderr.write("paho-mqtt eksik →  pip install paho-mqtt\n")
    raise

VER = "2.6-vm"
BROKERS = ["broker.emqx.io", "broker.hivemq.com", "test.mosquitto.org"]
PORT = 1883
HEARTBEAT_S = 15
MAX_CHUNK = 8000          # tek MQTT mesajında taşınan çıktı parçası
MAX_TOTAL_OUT = 200_000   # bir komutun toplam çıktı tavanı (flood koruması)

TOKEN = sys.argv[1] if len(sys.argv) > 1 else os.environ.get("AGENT_TOKEN", "").strip()
if not TOKEN:
    sys.stderr.write("Kullanım: python3 agent.py <ODA_TOKEN>\n")
    sys.exit(2)
PFX = f"termux-kopru/{TOKEN}/"

IS_WIN = os.name == "nt"
UNAME = platform.uname()
AGENT_INFO = {
    "state": "online",
    "agent": True,
    "ver": VER,
    "name": os.environ.get("AGENT_NAME") or socket.gethostname(),
    "user": os.environ.get("USER") or os.environ.get("USERNAME") or "?",
    "platform": platform.platform(),
    "machine": UNAME.machine,
    "since": time.time(),
}

client = None
bagli = threading.Event()
_giden = queue.Queue()  # (topic, payload_str, retain) — tek publisher thread yayınlar


def _gonderici_dongusu():
    """Tek noktadan MQTT yayını: paho publish'i HER ZAMAN aynı thread çağırır.

    Canlı bulgular:
      • Worker thread'lerden publish çağırmak paho 2.x'te takılmaya yol açıyordu.
      • Halka açık broker (emqx) aynı milisaniyede art arda giden 2. mesajı
        SESSİZCE DÜŞÜRÜYOR (out geliyor, done kayboluyordu).
      Çözüm: qos=1 (en-az-bir-kez teslim) + mesajlar arası min. tempo (pacing).
    """
    while True:
        islem = _giden.get()
        if islem is None:
            return
        topic, payload, retain = islem
        print(f"[yayin-kuyruk] pop → {topic} ({len(payload)}B)", flush=True)
        for deneme in range(3):
            try:
                info = client.publish(topic, payload, qos=1, retain=retain)
                if info.rc == mqtt.MQTT_ERR_SUCCESS:
                    print(f"[yayin-kuyruk] OK → {topic}", flush=True)
                    break
                print(f"[mqtt] yayın rc={info.rc} topic={topic} deneme={deneme+1}", flush=True)
            except Exception as e:
                print(f"[mqtt] yayın hatası: {e}", flush=True)
            time.sleep(1)
        time.sleep(0.3)  # tempo: broker'ın seri-mesaj düşürmesini engeller


def yayin(topic, obj, retain=False):
    try:
        _giden.put_nowait((PFX + topic, json.dumps(obj), retain))
        print(f"[yayin-kuyruk] push → {PFX}{topic}", flush=True)
    except queue.Full:
        print(f"[mqtt] yayın kuyruğu dolu, atlandı: {topic}", flush=True)
    except Exception as e:
        print(f"[mqtt] yayın hazırlama hatası: {e}", flush=True)


# -------------------------------------------------------------------------- #
#  Yardımcılar
# -------------------------------------------------------------------------- #
def heartbeat():
    while True:
        if bagli.is_set():
            d = dict(AGENT_INFO)
            d["t"] = time.time()
            yayin("status", d, retain=True)
        time.sleep(HEARTBEAT_S)


def halka_acik_cikti(dizi, cid):
    """Uzun çıktıyı parçalara bölerek out topic'ine akıt (tavan + kesme notu)."""
    metin = "".join(dizi)
    if len(metin) > MAX_TOTAL_OUT:
        metin = metin[:MAX_TOTAL_OUT] + f"\n...[çıktı {MAX_TOTAL_OUT} baytta kesildi]\n"
    for i in range(0, len(metin), MAX_CHUNK):
        yayin("out", {"type": "out", "id": cid, "tag": "o", "d": metin[i:i + MAX_CHUNK]})


# -------------------------------------------------------------------------- #
#  exec — komut çalıştırma (Windows: cmd /c | Unix: bash -c)
# -------------------------------------------------------------------------- #
def komut_calistir(cid, cmd, timeout):
    t0 = time.time()
    print(f"[exec] {cmd}", flush=True)
    parcalar, toplam, olum, oldurduk = [], 0, None, False
    try:
        popen_args = ["cmd", "/c", cmd] if IS_WIN else ["bash", "-c", cmd]
        flags = {"creationflags": subprocess.CREATE_NEW_PROCESS_GROUP} if IS_WIN else {"start_new_session": True}
        proc = subprocess.Popen(
            popen_args,
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            text=True,
            errors="replace",
            bufsize=1,
            **flags,
        )
    except Exception as e:
        yayin("out", {"type": "out", "id": cid, "tag": "o", "d": f"başlatılamadı: {e}\n"})
        yayin("done", {"type": "done", "id": cid, "code": 127, "dur": round(time.time() - t0, 2)})
        return

    q = queue.Queue()

    def okuyucu():
        try:
            for satir in proc.stdout:
                q.put(satir)
        except Exception:
            pass
        finally:
            q.put(None)  # akış bitti işareti

    threading.Thread(target=okuyucu, daemon=True).start()

    bitti = False
    while not bitti:
        if time.time() - t0 > timeout:
            olum = f"süre aşımı ({timeout}s)"
            break
        try:
            satir = q.get(timeout=0.4)
        except queue.Empty:
            satir = ""  # canlılık tik'i
        if satir is None:
            bitti = True  # stdout kapandı → süreç sonlandı
        elif satir:
            parcalar.append(satir)
            toplam += len(satir)
            if toplam > MAX_TOTAL_OUT:
                olum = "çıktı sınırı"
                break
        elif proc.poll() is not None and q.empty():
            bitti = True

    if olum and proc.poll() is None:
        # süre aşıldı/çıktı doldu → süreci ailesiyle birlikte öldür
        try:
            if IS_WIN:
                subprocess.run(["taskkill", "/F", "/T", "/PID", str(proc.pid)], capture_output=True)
            else:
                os.killpg(proc.pid, signal.SIGKILL)
        except Exception:
            pass
        oldurduk = True
        parcalar.append(f"\n[{olum} → süreç öldürüldü]\n")
        # öldürürken kuyruğa düşen son çıktıları da yakala
        while not q.empty():
            s = q.get_nowait()
            if isinstance(s, str) and s:
                parcalar.append(s)

    try:
        code = proc.wait(timeout=10)
    except Exception:
        code = -1
    if oldurduk:
        code = -9

    halka_acik_cikti(parcalar, cid)
    print(f"[exec:{cid}] out gönderildi, done yayınlanıyor (code={code})", flush=True)
    yayin("done", {"type": "done", "id": cid, "code": code, "dur": round(time.time() - t0, 2)})
    # KESİN TESLİM: halka açık broker'lar canlı mesajları aralıklı düşürüyor (out gelip
    # done kayboluyordu). Sonucu retained alt-topic'e de koy → alıcı istediği an abone
    # olup okur, yarış/düşme ihtimali kalmaz. Alıcı okuduktan sonra boş payload ile siler.
    metin = "".join(parcalar)
    if len(metin) > MAX_TOTAL_OUT:
        metin = metin[:MAX_TOTAL_OUT] + "\n...[kesildi]\n"
    yayin(
        f"out/{cid}",
        {"type": "done", "id": cid, "code": code, "dur": round(time.time() - t0, 2), "cikti": metin},
        retain=True,
    )


# -------------------------------------------------------------------------- #
#  update — kendi dosyasını indirip yeniden başlat (OTA)
# -------------------------------------------------------------------------- #
def ota_guncelle(cid, url, sha):
    try:
        with urllib.request.urlopen(url, timeout=60) as r:
            veri = r.read()
        if sha:
            gercek = hashlib.sha256(veri).hexdigest()
            if gercek.lower() != sha.lower():
                yayin("out", {"type": "out", "id": cid, "tag": "o", "d": f"sha uyumsuz: {gercek} != {sha}\n"})
                yayin("updated", {"type": "updated", "ok": False, "sebep": "sha"})
                return
        hedef = os.path.abspath(__file__)
        fd, gecici = tempfile.mkstemp(suffix=".py")
        with os.fdopen(fd, "wb") as f:
            f.write(veri)
        shutil.move(gecici, hedef)
        yayin("updated", {"type": "updated", "ok": True})
        time.sleep(1)
        os.execv(sys.executable, [sys.executable, hedef] + sys.argv[1:])
    except Exception as e:
        yayin("updated", {"type": "updated", "ok": False, "sebep": str(e)})


# -------------------------------------------------------------------------- #
#  MQTT
# -------------------------------------------------------------------------- #
def on_connect(cli, ud, flags, rc, props=None):
    if rc == 0:
        bagli.set()
        cli.subscribe(PFX + "cmd", qos=1)
        d = dict(AGENT_INFO)
        d["t"] = time.time()
        yayin("status", d, retain=True)
        print(f"[mqtt] bağlı → {PFX}cmd dinleniyor", flush=True)
    else:
        bagli.clear()


def on_disconnect(cli, ud, flags, rc, props=None):
    bagli.clear()
    print(f"[mqtt] koptu (rc={rc}), yeniden bağlanılacak…", flush=True)


def on_message(cli, ud, msg):
    try:
        d = json.loads(msg.payload.decode("utf-8", "replace"))
    except Exception:
        return
    tip = d.get("type")
    if tip == "ping":
        yayin("out", {"type": "pong", "id": d.get("id"), "t": time.time()})
    elif tip == "exec":
        cid = str(d.get("id") or uuid.uuid4().hex[:8])
        cmd = str(d.get("cmd") or "")
        timeout = max(1, min(int(d.get("timeout") or 120), 300))
        threading.Thread(target=komut_calistir, args=(cid, cmd, timeout), daemon=True).start()
    elif tip == "update":
        cid = str(d.get("id") or uuid.uuid4().hex[:8])
        threading.Thread(target=ota_guncelle, args=(cid, d.get("url", ""), d.get("sha", "")), daemon=True).start()


def main():
    global client
    print(f"agent.py {VER} | oda: {PFX}<topics> | {platform.platform()}", flush=True)
    client = mqtt.Client(
        mqtt.CallbackAPIVersion.VERSION2,
        client_id=f"agent-{TOKEN[:6]}-{uuid.uuid4().hex[:6]}",
        clean_session=True,
    )
    client.on_connect = on_connect
    client.on_disconnect = on_disconnect
    client.on_message = on_message
    # Broker sırayla dene; ilk başarılıda kal
    for b in BROKERS:
        try:
            client.connect(b, PORT, keepalive=45)
            host_sec = b
            break
        except Exception as e:
            print(f"[mqtt] {b} → {e}", flush=True)
    else:
        sys.stderr.write("Hiçbir broker'a bağlanılamadı.\n")
        sys.exit(1)
    print(f"[mqtt] broker: {host_sec}", flush=True)
    threading.Thread(target=heartbeat, daemon=True).start()
    threading.Thread(target=_gonderici_dongusu, daemon=True).start()
    try:
        client.loop_forever(retry_first_connection=True)
    except KeyboardInterrupt:
        pass
    finally:
        yayin("status", {"state": "offline", "ver": VER, "t": time.time()}, retain=True)
        client.disconnect()


if __name__ == "__main__":
    main()
