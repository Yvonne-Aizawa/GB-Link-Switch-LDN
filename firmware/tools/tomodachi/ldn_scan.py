"""Scan for any game's LDN rooms through the bridge firmware and decrypt what they advertise.

Speaks the binary serial protocol (docs/SERIAL_PROTOCOL.md), stops the on-chip bridge,
hops channels with LDN_SCAN, decrypts each LDN_ADV with prod.keys (the same steps as
host/core/Ldn.cs) and prints the room: communication ID, version, members, app data.
Raw and decoded rooms are also written as JSON lines.

Usage: uv run --with pyserial python -I ldn_scan.py [seconds] [port] [out.jsonl]
"""
import glob, hashlib, json, os, struct, sys, threading, time, zlib
import serial
from cryptography.hazmat.primitives.ciphers import Cipher, algorithms, modes
from cryptography.hazmat.primitives.ciphers.aead import AESGCM

CHANNELS = [1, 6, 11, 2, 3, 4, 5, 7, 8, 9, 10]
KEY_NAMES = ["aes_kek_generation_source", "aes_key_generation_source", "master_key_00", "master_key_12"]


# ---- serial protocol --------------------------------------------------------------

def cobs_encode(data):
    out = bytearray(); idx = 0
    while True:
        end = data.find(b"\x00", idx)
        block = data[idx:] if end < 0 else data[idx:end]
        while len(block) >= 254:
            out.append(255); out += block[:254]; block = block[254:]
        out.append(len(block) + 1); out += block
        if end < 0: break
        idx = end + 1
    return bytes(out)


def cobs_decode(data):
    out = bytearray(); i = 0
    while i < len(data):
        code = data[i]; i += 1
        if code == 0 or i + code - 1 > len(data): return None
        out += data[i:i + code - 1]; i += code - 1
        if code != 255 and i < len(data): out.append(0)
    return bytes(out)


class Esp:
    def __init__(self, port):
        self.s = serial.Serial(); self.s.port = port; self.s.baudrate = 921600; self.s.timeout = 0.2
        self.s.dtr = True; self.s.rts = False; self.s.open(); self.s.dtr = False   # without resetting the chip
        self.session = 0; self.request = 0; self.alive = True
        self.lines = []; self.events = []; self.lock = threading.Lock()
        threading.Thread(target=self.reader, daemon=True).start()

    def send(self, kind, payload, request=0):
        raw = struct.pack("<BBIIH", 1, kind, request, self.session, len(payload)) + payload
        raw += struct.pack("<I", zlib.crc32(raw) & 0xffffffff)
        self.s.write(cobs_encode(raw) + b"\x00")

    def reader(self):
        buf = bytearray()
        while self.alive:
            try: data = self.s.read(1)
            except (serial.SerialException, OSError): break
            if not data: continue
            data += self.s.read(self.s.in_waiting or 0)
            buf += data
            while b"\x00" in buf:
                chunk, _, rest = bytes(buf).partition(b"\x00"); buf = bytearray(rest)
                raw = cobs_decode(chunk) if chunk else None
                if not raw or len(raw) < 16 or raw[0] != 1: continue
                if struct.unpack("<I", raw[-4:])[0] != (zlib.crc32(raw[:-4]) & 0xffffffff): continue
                kind, payload = raw[1], raw[12:-4]
                if kind not in (2, 3): continue
                text = payload.decode("utf-8", "replace").strip()
                with self.lock: (self.lines if kind == 2 else self.events).append(text)

    def command(self, text, wait=3.0):
        self.request += 1
        with self.lock: self.lines.clear()
        self.send(1, text.encode(), self.request)
        deadline = time.time() + wait
        while time.time() < deadline:
            with self.lock:
                if "LDN_DONE" in self.lines: return [l for l in self.lines if l != "LDN_DONE"]
            time.sleep(0.01)
        with self.lock: return list(self.lines)

    def drain(self):
        with self.lock: got, self.events = self.events, []
        return got

    def handshake(self):
        for _ in range(10):
            self.s.write(b"\nLDN_BINARY\n\x00")
            hello = [l for l in self.command("LDN_HELLO", 1.5) if l.startswith("LDN_HELLO 1 ")]
            if hello: break
        else:
            raise SystemExit("No LDN_HELLO from the board. Is the bridge firmware installed?")
        self.session = int.from_bytes(os.urandom(4), "little") | 1
        self.command(f"LDN_BEGIN {self.session:08x}", 8)
        info = next((l for l in self.command("LDN_INFO") if l.startswith("LDN_INFO ")), "")
        self.command("LDN_BRIDGE_STOP", 5)
        return hello[0], info


# ---- LDN advertisement decryption (host/core/Ldn.cs) ------------------------------

def load_keys(path):
    keys = {}
    for line in open(path):
        name, sep, value = line.partition("=")
        if sep and name.strip() in KEY_NAMES: keys[name.strip()] = bytes.fromhex(value.strip())
    return keys


def ecb_decrypt(key, data):
    d = Cipher(algorithms.AES(key), modes.ECB()).decryptor(); return d.update(data) + d.finalize()


def ecb_encrypt(key, data):
    e = Cipher(algorithms.AES(key), modes.ECB()).encryptor(); return e.update(data) + e.finalize()


def derive(keys, protocol, data, advertise=True):
    key = keys["master_key_00" if protocol == 1 else "master_key_12"]
    key = ecb_decrypt(key, keys["aes_kek_generation_source"])
    key = ecb_decrypt(key, bytes.fromhex("191884743e24c77d87c69e4207d0c438" if advertise else "f1e7018419a84f711da714c2cf919c9c"))
    key = ecb_decrypt(key, keys["aes_key_generation_source"])
    return ecb_decrypt(key, hashlib.sha256(data).digest()[:16])


def ctr(key, nonce4, data):
    counter = bytearray(nonce4 + bytes(12)); out = bytearray()
    for i in range(0, len(data), 16):
        mask = ecb_encrypt(key, bytes(counter))
        out += bytes(a ^ b for a, b in zip(data[i:i + 16], mask))
        for j in range(15, 3, -1):
            counter[j] = (counter[j] + 1) & 255
            if counter[j]: break
    return bytes(out)


def members_from(data, at, stride, count, by_slot):
    found = []
    for i in range(count):
        o = at + stride * i
        if by_slot and data[o + 10] == 0: continue
        found.append({"index": i if by_slot else data[o + 10], "ip": ".".join(map(str, data[o:o + 4])),
                      "mac": data[o + 4:o + 10].hex(":"),
                      "name": data[o + 12:o + 44].split(b"\0")[0].decode("utf-8", "replace")})
    return found


def decode(keys, raw, channel):
    if len(raw) < 68 or raw[:8] != bytes.fromhex("7f0022aa04000101"): return None
    ident, version = raw[12:44], raw[44]
    protocol = {2: 1, 3: 3}.get(raw[45])
    if protocol is None: return None
    room = {"channel": channel, "ldn_version": version, "protocol": protocol,
            "communication_id": f"{int.from_bytes(ident[:8], 'big'):016x}",
            "scene_id": int.from_bytes(ident[10:12], "big"), "ssid": ident[16:32].hex(), "id": ident.hex()}
    key = derive(keys, protocol, ident)
    size = int.from_bytes(raw[46:48], "big")
    if protocol == 3:
        data = AESGCM(key).decrypt(raw[48:52] + bytes(8), raw[68:] + raw[52:68], raw[12:52])
        count = data[39]
        room.update(random=data[:16].hex(), challenge=int.from_bytes(data[16:24], "big"))
        room.update(security=data[24], policy=data[25], app_version=int.from_bytes(data[26:28], "big"),
                    maximum=data[38], members=members_from(data, 40, 48, count, False))
        at = 40 + 48 * count; app = data[at + 2:at + 2 + int.from_bytes(data[at:at + 2], "big")]
    else:
        plain = ctr(key, raw[48:52], raw[52:]); data = plain[32:]
        if hashlib.sha256(raw[12:52] + bytes(32) + data).digest() != plain[:32]: return None
        room.update(random=data[:16].hex(), challenge=int.from_bytes(data[1272:1280], "big"))
        room.update(security=int.from_bytes(data[16:18], "big"), policy=data[18], maximum=data[22],
                    app_version=int.from_bytes(data[68:70], "big"), members=members_from(data, 24, 56, 8, True))
        app = data[476:476 + int.from_bytes(data[474:476], "big")]
    room["app_data"] = app.hex()
    return room


def hexdump(data):
    for i in range(0, len(data), 16):
        row = data[i:i + 16]
        print(f"    {i:04x}  {row.hex(' '):<47}  {''.join(chr(b) if 32 <= b < 127 else '.' for b in row)}")


# ---- main --------------------------------------------------------------------------

def main():
    seconds = float(sys.argv[1]) if len(sys.argv) > 1 else 60
    port = sys.argv[2] if len(sys.argv) > 2 else (glob.glob("/dev/serial/by-id/*Espressif*") +
                                                  glob.glob("/dev/ttyACM*") + glob.glob("/dev/ttyUSB*") + [None])[0]
    out_path = sys.argv[3] if len(sys.argv) > 3 else os.path.join(os.path.dirname(os.path.abspath(__file__)), "rooms.jsonl")
    if not port: raise SystemExit("No ESP32 serial port found.")
    keys = load_keys(os.path.expanduser("~/.switch/prod.keys"))
    if not all(k in keys for k in KEY_NAMES[:2]): raise SystemExit("~/.switch/prod.keys lacks the key sources")

    esp = Esp(port)
    hello, info = esp.handshake()
    print(f"Board on {port}: {hello} | {info or 'no LDN_INFO'}")
    print(f"Scanning for {seconds:.0f} s. Host a Local Play session on the Switch now.\n")

    seen = {}; out = open(out_path, "a")
    start = time.time()
    try:
        while time.time() - start < seconds:
            for channel in CHANNELS:
                esp.command(f"LDN_SCAN {channel}")
                dwell = time.time()
                while time.time() - dwell < 0.5:
                    for line in esp.drain():
                        fields = line.split(" ")
                        if len(fields) != 4 or fields[0] != "LDN_ADV": continue
                        raw = bytes.fromhex(fields[3])
                        try: room = decode(keys, raw, int(fields[2]))
                        except Exception as e: room = {"error": repr(e)}
                        if room is None: continue
                        room["bssid"] = fields[1]
                        signature = json.dumps({k: v for k, v in room.items() if k != "channel"}, sort_keys=True)
                        if signature in seen: continue
                        seen[signature] = True
                        out.write(json.dumps({"time": time.time(), "raw": raw.hex(), **room}) + "\n"); out.flush()
                        print(f"[{time.time() - start:6.1f}s] room from {room['bssid']} on channel {fields[2]}")
                        if "error" in room: print(f"    could not decrypt: {room['error']}"); continue
                        for k in ("communication_id", "scene_id", "ldn_version", "protocol", "app_version",
                                  "security", "policy", "maximum"):
                            print(f"    {k:17} {room[k]}")
                        for m in room["members"]:
                            print(f"    member {m['index']}: {m['name']!r} {m['ip']} {m['mac']}")
                        app = bytes.fromhex(room["app_data"])
                        print(f"    app data ({len(app)} bytes):"); hexdump(app); print()
                    time.sleep(0.01)
                if time.time() - start >= seconds: break
    except KeyboardInterrupt:
        pass
    finally:
        esp.command("LDN_BRIDGE_START", 5)
        esp.alive = False; esp.s.close()
    print(f"Done: {len(seen)} distinct room advertisement(s), saved to {out_path}")


if __name__ == "__main__":
    main()
