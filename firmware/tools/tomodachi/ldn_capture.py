"""Join a Switch's LDN room as a silent second player and record everything it sends.

Needs the bridge firmware with LDN_TAP (firmware/common/ldn_control.c). Scans for the
room, joins it the way host/core/LdnJoiner.cs does (LDN_CONFIG, LDN authentication,
membership, LDN_NET), then switches the tap on and logs every frame the Switch sends us:
a summary per packet on screen, the full frames in a pcap for Wireshark. The board
answers nothing above ARP, so the game sees a player that never speaks.

Usage: uv run --with pyserial --with cryptography python -I ldn_capture.py [seconds] [communication_id]
(the room's passphrase must be in PASSPHRASES)
"""
import glob, hashlib, hmac, os, struct, sys, time
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from ldn_scan import CHANNELS, Esp, decode, derive, hexdump, load_keys

CHALLENGE_KEY = bytes.fromhex("f84b487fb37251c263bf11609036589266af70ca79b44c93c7370c5769c0f602")
# LDN passphrases (SecurityConfig), by communication ID. Tomodachi Life's is set at
# main+0x1db536c (1.0.4) with length 0x1a; FireRed's is the constant in host/core/Ldn.cs.
PASSPHRASES = {
    "010051f0207b2000": b"ABCDEFGHIJKLMNOPQRSTUVWXYZ",
    "01006fa0233f8000": bytes.fromhex("fcb6f6adb9dfea66aca9c326149d2b3b08a781895cbf78f720d78b85a57584a9"
                                      "9665d237797b2a41ddef14063ec28d259143af7832fb3cbcf2759cbfbdc81d8c"),
}
TCP_FLAGS = "FSRPAUEC"


def log(start, text): print(f"[{time.time() - start:7.2f}s] {text}", flush=True)


def auth_request(room):
    """LdnAuthentication's request (host/core/Ldn.cs); protocol 1 sends it in the clear."""
    if room["protocol"] != 1: raise SystemExit("Only protocol 1 rooms are handled here")
    version = room["ldn_version"]
    payload = bytearray(868 if version >= 3 else 64)
    payload[:6] = b"GBLINK"; payload[32:34] = room["app_version"].to_bytes(2, "big")
    if version >= 3:
        body = bytearray(720)
        body[8:16] = room["challenge"].to_bytes(8, "little")
        body[16:32] = os.urandom(16)                        # nonce and device id
        payload[104:136] = hmac.new(CHALLENGE_KEY, bytes(body), hashlib.sha256).digest()
        payload[148:868] = body
    ident = bytearray(bytes.fromhex(room["id"]))
    ident[0:8] = ident[0:8][::-1]; ident[10:12] = ident[10:12][::-1]
    header = bytearray(72)
    header[0] = version; header[1] = len(payload) & 255; header[4] = len(payload) >> 8
    header[8:40] = ident; header[40:56] = bytes.fromhex(room["random"]); header[56:72] = os.urandom(16)
    return bytes.fromhex("0022aa010200") + bytes(header) + bytes(payload)


def find_room(esp, keys, start, wanted, seconds=30):
    deadline = time.time() + seconds
    time.sleep(0.3); esp.drain()   # advertisements queued before the scan may be stale
    while time.time() < deadline:
        for channel in CHANNELS:
            esp.command(f"LDN_SCAN {channel}")
            dwell = time.time()
            while time.time() - dwell < 0.5:
                for line in esp.drain():
                    f = line.split(" ")
                    if len(f) != 4 or f[0] != "LDN_ADV": continue
                    try: room = decode(keys, bytes.fromhex(f[3]), int(f[2]))
                    except Exception: continue
                    if room and (not wanted or room["communication_id"] == wanted):
                        room["bssid"] = f[1]; return room
                time.sleep(0.01)
    raise SystemExit("No room found. Is Local Play open on the Switch?")


class Pcap:
    def __init__(self, path):
        self.f = open(path, "wb"); self.f.write(struct.pack("<IHHiIII", 0xa1b2c3d4, 2, 4, 0, 0, 65535, 1))
    def write(self, frame):
        t = time.time(); self.f.write(struct.pack("<IIII", int(t), int(t % 1 * 1e6), len(frame), len(frame)) + frame)
        self.f.flush()


def checksum(data):
    if len(data) % 2: data += b"\0"
    total = sum(struct.unpack(f">{len(data) // 2}H", data))
    while total >> 16: total = (total & 0xffff) + (total >> 16)
    return ~total & 0xffff


def ip_bytes(text): return bytes(map(int, text.split(".")))


def ipv4_frame(dst_mac, src_ip, dst_ip, proto, segment, ident=[0]):
    """Ethernet + IPv4 around a ready transport segment; the board fills in its own source MAC."""
    ident[0] = (ident[0] + 1) & 0xffff
    header = struct.pack(">BBHHHBBH4s4s", 0x45, 0, 20 + len(segment), ident[0], 0x4000, 64, proto, 0,
                         ip_bytes(src_ip), ip_bytes(dst_ip))
    header = header[:10] + struct.pack(">H", checksum(header)) + header[12:]
    return bytes.fromhex(dst_mac.replace(":", "")) + bytes(6) + b"\x08\x00" + header + segment


def udp_frame(dst_mac, src_ip, dst_ip, sport, dport, payload):
    return ipv4_frame(dst_mac, src_ip, dst_ip, 17, struct.pack(">HHHH", sport, dport, 8 + len(payload), 0) + payload)


class Tcp:
    """Just enough TCP for one connection, accepted (listen) or opened by us (connect)."""
    SYN, ACK, FIN, RST, PSH = 2, 16, 1, 4, 8

    def __init__(self, esp, host_mac, our_ip, port, start, name):
        self.esp, self.mac, self.ip, self.port, self.start, self.name = esp, host_mac, our_ip, port, start, name
        self.state = "LISTEN"; self.peer = None; self.seq = int.from_bytes(os.urandom(4), "big"); self.ack = 0
        self.stream = bytearray(); self.cltp = None; self.next_syn = 0

    def log(self, text): log(self.start, f"TCP {self.name}: {text}")

    def segment(self, flags, payload=b"", options=b""):
        sip, sport = self.peer
        header = struct.pack(">HHIIBBHHH", self.port, sport, self.seq, self.ack, (5 + len(options) // 4) << 4, flags,
                             16384, 0, 0) + options
        pseudo = ip_bytes(self.ip) + ip_bytes(sip) + struct.pack(">BBH", 0, 6, len(header) + len(payload))
        header = header[:16] + struct.pack(">H", checksum(pseudo + header + payload)) + header[18:]
        frame = ipv4_frame(self.mac, self.ip, sip, 6, header + payload)
        result = self.esp.command("LDN_ETH " + frame.hex(), 1)
        if "LDN_ETH_RESULT 0" not in result: self.log(f"send failed: {result}")

    def connect(self, peer):
        """Open a connection to peer (ip, port); call poll() to retry the SYN."""
        self.peer = peer; self.state = "SYN_SENT"; self.next_syn = 0; self.poll()

    def poll(self):
        if self.state == "SYN_SENT" and time.time() >= self.next_syn:
            self.segment(self.SYN, options=b"\x02\x04\x04\xb0"); self.next_syn = time.time() + 1
            self.log(f"SYN to {self.peer[0]}:{self.peer[1]}")

    def send(self, data):
        for i in range(0, len(data), 1200):
            chunk = data[i:i + 1200]; self.segment(self.ACK | self.PSH, chunk); self.seq += len(chunk)

    def matches(self, src, sport, dport):
        if dport != self.port: return False
        return self.peer is None or self.state == "LISTEN" or self.peer == (src, sport)

    def receive(self, frame):
        ip = frame[14:]; ihl = (ip[0] & 15) * 4; seg = ip[ihl:int.from_bytes(ip[2:4], "big")]
        sport, dport, seq, ack, off, flags = struct.unpack(">HHIIBB", seg[:14])
        data = seg[(off >> 4) * 4:]; src = ".".join(map(str, ip[12:16]))
        if flags & self.RST: self.log("reset by the Switch"); self.state = "CLOSED"; return
        if self.state == "SYN_SENT":
            if flags & self.SYN and flags & self.ACK and ack == self.seq + 1:
                self.seq += 1; self.ack = seq + 1; self.state = "ESTABLISHED"; self.segment(self.ACK); self.log("connected")
            return
        if flags & self.SYN:
            if self.state == "LISTEN": self.peer = (src, sport); self.ack = seq + 1; self.state = "SYN_RCVD"
            self.segment(self.SYN | self.ACK, options=b"\x02\x04\x04\xb0")
            self.log("answered SYN"); return
        if self.state == "SYN_RCVD" and flags & self.ACK and ack == self.seq + 1:
            self.seq += 1; self.state = "ESTABLISHED"; self.log("connected")
        if self.state != "ESTABLISHED": return
        if data:
            if seq == self.ack:
                self.stream += data; self.ack += len(data)
                self.log(f"data {len(data)} bytes (stream {len(self.stream)})"); hexdump(data[:64])
                if self.cltp: self.cltp.feed(data)
            self.segment(self.ACK)
        if flags & self.FIN:
            self.ack += 1; self.segment(self.FIN | self.ACK); self.seq += 1
            self.log("the Switch closed the connection")
            # An accepted connection goes back to listening: the Switch reconnects after a transfer.
            if self.name == "in": self.state = "LISTEN"; self.peer = None; self.seq = int.from_bytes(os.urandom(4), "big")
            else: self.state = "CLOSED"


class Cltp:
    """The game's handshake over TCP 5002 (main+0x1e6b280 in 1.0.4): NUL-terminated text
    messages, CLTP SUPPLY 0x<len> followed by <len> bytes, CLTP ACCEPT/REJECT/CANCEL.
    Saves each supplied payload; answers with CLTP_REPLY (default ACCEPT)."""
    def __init__(self, tcp, start):
        self.tcp, self.start, self.buf, self.need, self.count = tcp, start, bytearray(), 0, 0

    def feed(self, data):
        self.buf += data
        while True:
            if self.need:
                if len(self.buf) < self.need: return
                payload, self.buf, self.need = bytes(self.buf[:self.need]), self.buf[self.need:], 0
                self.count += 1
                path = os.path.join(os.path.dirname(os.path.abspath(__file__)), f"supply-{time.strftime('%Y%m%d-%H%M%S')}-{self.count}.bin")
                open(path, "wb").write(payload)
                log(self.start, f"CLTP payload {len(payload)} bytes saved to {path}"); hexdump(payload[:256])
                reply = os.environ.get("CLTP_REPLY", "ACCEPT")
                if reply != "NONE":
                    self.tcp.send(f"CLTP {reply}".encode() + b"\0"); log(self.start, f"sent CLTP {reply}")
                continue
            end = self.buf.find(b"\0")
            if end < 0: return
            text, self.buf = self.buf[:end].decode("latin-1"), self.buf[end + 1:]
            log(self.start, f"CLTP message {text!r}")
            if text.startswith("CLTP SUPPLY "): self.need = int(text[12:], 16)


def describe(frame):
    kind = int.from_bytes(frame[12:14], "big")
    if kind == 0x0806: return "ARP", b""
    if kind != 0x0800: return f"ethertype {kind:04x}, {len(frame) - 14} bytes", frame[14:]
    ip = frame[14:]; ihl = (ip[0] & 15) * 4; proto = ip[9]
    src, dst = ".".join(map(str, ip[12:16])), ".".join(map(str, ip[16:20]))
    seg = ip[ihl:int.from_bytes(ip[2:4], "big")]
    if proto == 17:
        sp, dp = struct.unpack(">HH", seg[:4])
        return f"UDP {src}:{sp} -> {dst}:{dp}, {len(seg) - 8} bytes", seg[8:]
    if proto == 6:
        sp, dp = struct.unpack(">HH", seg[:4]); off = (seg[12] >> 4) * 4
        flags = "".join(c for i, c in enumerate(TCP_FLAGS) if seg[13] >> i & 1)
        return f"TCP {src}:{sp} -> {dst}:{dp} [{flags}], {len(seg) - off} bytes", seg[off:]
    if proto == 1: return f"ICMP {src} -> {dst} type {seg[0]}", b""
    return f"IP proto {proto} {src} -> {dst}", seg


def main():
    seconds = float(sys.argv[1]) if len(sys.argv) > 1 else 120
    wanted = sys.argv[2].lower() if len(sys.argv) > 2 else "010051f0207b2000"   # Tomodachi Life
    port = (glob.glob("/dev/serial/by-id/*Espressif*") + glob.glob("/dev/ttyACM*") + [None])[0]
    if not port: raise SystemExit("No ESP32 serial port found.")
    keys = load_keys(os.path.expanduser("~/.switch/prod.keys"))
    here = os.path.dirname(os.path.abspath(__file__))
    stamp = time.strftime("%Y%m%d-%H%M%S")
    pcap = Pcap(os.path.join(here, f"capture-{stamp}.pcap"))
    text = open(os.path.join(here, f"capture-{stamp}.log"), "w")

    esp = Esp(port); start = time.time()
    hello, info = esp.handshake(); log(start, f"{hello} | {info}")
    tap = esp.command("LDN_TAP 1")
    if not any(l.startswith("LDN_TAP 1") for l in tap):
        raise SystemExit(f"This firmware has no LDN_TAP ({tap}); flash the capture build.")

    try:
        room = find_room(esp, keys, start, wanted)
        host = next(m for m in room["members"] if m["index"] == 0)
        log(start, f"Room {room['communication_id']} on channel {room['channel']}, host {host['name']!r} {host['ip']}")
        data_key = derive(keys, room["protocol"], bytes.fromhex(room["random"]) + PASSPHRASES[room["communication_id"]], advertise=False)
        esp.command(f"LDN_CONFIG {room['channel']} {room['ssid']} {room['bssid']} {data_key.hex()}", 8)

        request = auth_request(room); ours = None; accepted = False; me = None
        attempts = 0; next_auth = float("inf"); next_status = 0; deadline = time.time() + 40
        while time.time() < deadline and not (accepted and me):
            now = time.time()
            if now >= next_status:
                for l in esp.command("LDN_STATUS"):
                    if l.startswith("LDN_LINK 1 ") and not ours:
                        ours = l.split(" ")[2]; next_auth = now; log(start, f"Associated as {ours}")
                next_status = now + 2
            if now >= next_auth and not accepted and attempts < 3:
                result = esp.command("LDN_TX " + request.hex()); attempts += 1; next_auth = now + 0.7
                log(start, f"Authentication request {attempts}: {result}")
            for line in esp.drain():
                f = line.split(" ")
                if f[0] == "LDN_ERROR": raise SystemExit(line)
                if f[0] == "LDN_RX" and len(f) == 3 and f[1] == room["bssid"]:
                    reply = bytes.fromhex(f[2])
                    result = reply[8] if len(reply) > 8 else -1
                    log(start, f"Authentication reply, result {result}")
                    if result != 0: raise SystemExit("The Switch refused the join.")
                    accepted = True
                if f[0] == "LDN_ADV" and ours:
                    try: current = decode(keys, bytes.fromhex(f[3]), int(f[2]))
                    except Exception: continue
                    me = next((m for m in (current or {}).get("members", []) if m["mac"] == ours), None) or me
                if f[0] == "LDN_TAP_FRAME": pcap.write(bytes.fromhex(f[1]))
                elif f[0] not in ("LDN_ADV", "LDN_ROOM"): log(start, line[:200])
            time.sleep(0.01)
        if not (accepted and me):
            for l in esp.command("LDN_STATUS"): log(start, l)
            raise SystemExit(f"Joining timed out (accepted={accepted}, member={me}).")
        log(start, f"In the room as member {me['index']} {me['ip']}")
        esp.command(f"LDN_NET {me['ip']} {host['ip']}")
        esp.command(f"LDN_NEIGH {host['ip']} {host['mac'].replace(':', '')}")

        beacon = os.environ.get("BEACON") == "1"
        log(start, f"Recording for {seconds:.0f} s{' and answering beacons' if beacon else ''}. Ctrl+C stops.")
        end = time.time() + seconds; next_ping = 0; count = 0; token = None; next_beacon = 0
        # The game wants two connections: each side connects to the other's port 5002, and
        # CLTP runs over the one each side accepted (main+0x1e6ae64 in 1.0.4). Ours to the
        # Switch is therefore the Switch's CLTP socket.
        send_file = os.environ.get("SEND"); sent = False; both_up = 0
        tcp = Tcp(esp, host["mac"], me["ip"], 5002, start, "in")
        out = Tcp(esp, host["mac"], me["ip"], 49200 + int.from_bytes(os.urandom(1), "big"), start, "out")
        out.cltp = Cltp(out, start); tcp.cltp = Cltp(tcp, start)
        while time.time() < end:
            if time.time() >= next_ping: esp.command("LDN_PING", 1); next_ping = time.time() + 1
            if beacon and token and out.state is not None and out.peer is None:
                out.connect((host["ip"], 5002))
            out.poll()
            # SEND=<file>: supply that payload once both connections are up, as the Switch does.
            if send_file and not sent and out.state == "ESTABLISHED" and tcp.state == "ESTABLISHED":
                if not both_up: both_up = time.time()
                elif time.time() - both_up > 2:
                    payload = open(send_file, "rb").read(); sent = True
                    out.send(f"CLTP SUPPLY 0x{len(payload):x}".encode() + b"\0" + payload)
                    log(start, f"supplied {len(payload)} bytes from {send_file}")
            if beacon and token and tcp.state == "LISTEN" and time.time() >= next_beacon:
                frame = udp_frame(host["mac"], me["ip"], host["ip"], 5001, 5001, token)
                result = esp.command("LDN_ETH " + frame.hex(), 1)
                if not any(l == "LDN_ETH_RESULT 0" for l in result): log(start, f"beacon send: {result}")
                next_beacon = time.time() + 0.1
            for line in esp.drain():
                f = line.split(" ", 1)
                if f[0] == "LDN_TAP_FRAME":
                    frame = bytes.fromhex(f[1]); pcap.write(frame); count += 1
                    summary, payload = describe(frame)
                    if summary.startswith("UDP") and summary.endswith(":5001, 4 bytes") and not token:
                        token = payload; log(start, f"Beacon token {token.hex()}")
                    log(start, summary); text.write(f"{time.time() - start:.3f} {summary} {payload.hex()}\n")
                    if summary.startswith("TCP"):
                        ip = frame[14:]; seg = ip[(ip[0] & 15) * 4:]
                        src = ".".join(map(str, ip[12:16])); sport, dport = struct.unpack(">HH", seg[:4])
                        for conn in (out, tcp):
                            if conn.matches(src, sport, dport): conn.receive(frame); break
                    elif payload: hexdump(payload[:128])
                elif f[0] in ("LDN_ERROR", "LDN_NET_LOST", "LDN_LINK", "LDN_UDP_ERROR"):
                    log(start, line)
            time.sleep(0.005)
        log(start, f"{count} frames recorded")
    except KeyboardInterrupt:
        pass
    finally:
        for c in ("LDN_TAP 0", "LDN_STOP", "LDN_BRIDGE_START"): esp.command(c, 5)
        esp.alive = False; esp.s.close()
        print(f"Saved {pcap.f.name} and {text.name}")


if __name__ == "__main__":
    main()
