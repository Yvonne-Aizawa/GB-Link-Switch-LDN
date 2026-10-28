// Tomodachi Life's Local Play with the page as the other player. The board joins the
// Switch's room (LDN_JOIN, firmware 2.2.0) and passes its frames both ways (LDN_TAP,
// LDN_ETH); the page speaks the game's protocol with just enough IPv4, UDP and TCP of its
// own. A port of firmware/tools/tomodachi/ldn_capture.py, where the protocol is described.
//
// The game's handshake: each side sends the other a 4-byte version to UDP port 5001 until
// connected, then each connects to the other's TCP port 5002. Items travel over either
// connection as CLTP: NUL-terminated text messages, `CLTP SUPPLY 0x<len>` followed by the
// payload, answered by `CLTP ACCEPT`, `CLTP REJECT` or `CLTP CANCEL`.

import { fromHex, toHex } from '../trade/bytes.js';

export const COMMUNICATION_ID = '010051f0207b2000';
const PASSPHRASE = new TextEncoder().encode('ABCDEFGHIJKLMNOPQRSTUVWXYZ');
export const LINK_FIRMWARE = '2.2.0';
const CLTP_PORT = 5002, BEACON_PORT = 5001;
const SEGMENT = 1200;

// ---- frames

function checksum(data) {
    let total = 0;
    for (let i = 0; i < data.length; i += 2) total += (data[i] << 8) | (data[i + 1] ?? 0);
    while (total > 0xffff) total = (total & 0xffff) + (total >>> 16);
    return ~total & 0xffff;
}

const ipBytes = (text) => Uint8Array.from(text.split('.').map(Number));
const ipText = (bytes) => Array.from(bytes).join('.');
const be16 = (b, o) => (b[o] << 8) | b[o + 1];
const be32 = (b, o) => ((b[o] << 24) | (b[o + 1] << 16) | (b[o + 2] << 8) | b[o + 3]) >>> 0;
function put16(b, o, v) { b[o] = (v >>> 8) & 255; b[o + 1] = v & 255; }
function put32(b, o, v) { put16(b, o, v >>> 16); put16(b, o + 2, v & 0xffff); }

function concat(...parts) {
    const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
    let at = 0;
    for (const part of parts) { out.set(part, at); at += part.length; }
    return out;
}

let ipIdent = 0;
// Ethernet + IPv4 around a ready transport segment; the board fills in its own source MAC.
function ipv4Frame(dstMac, srcIp, dstIp, proto, segment) {
    ipIdent = (ipIdent + 1) & 0xffff;
    const header = new Uint8Array(20);
    header[0] = 0x45;
    put16(header, 2, 20 + segment.length);
    put16(header, 4, ipIdent);
    put16(header, 6, 0x4000);
    header[8] = 64;
    header[9] = proto;
    header.set(ipBytes(srcIp), 12);
    header.set(ipBytes(dstIp), 16);
    put16(header, 10, checksum(header));
    return concat(fromHex(dstMac), new Uint8Array(6), Uint8Array.of(0x08, 0x00), header, segment);
}

function udpFrame(dstMac, srcIp, dstIp, port, payload) {
    const header = new Uint8Array(8);
    put16(header, 0, port);
    put16(header, 2, port);
    put16(header, 4, 8 + payload.length);
    return ipv4Frame(dstMac, srcIp, dstIp, 17, concat(header, payload));
}

// The reply to an ARP request for ourIp, or null. lwIP normally answers these, but after
// some sessions it stops and the Switch never reaches us.
function arpReply(frame, ourMac, ourIp) {
    if (be16(frame, 12) !== 0x0806 || frame.length < 42) return null;
    const arp = frame.subarray(14, 42);
    if (be16(arp, 6) !== 1 || toHex(arp.subarray(24, 28)) !== toHex(ipBytes(ourIp))) return null;
    const mac = fromHex(ourMac);
    return concat(arp.subarray(8, 14), mac, Uint8Array.of(0x08, 0x06), arp.subarray(0, 6), Uint8Array.of(0x00, 0x02),
        mac, arp.subarray(24, 28), arp.subarray(8, 18));
}

// ---- TCP: just enough for one connection, accepted (listen) or opened by us (connect)

const SYN = 2, ACK = 16, FIN = 1, RST = 4, PSH = 8;
const MSS = Uint8Array.of(0x02, 0x04, 0x04, 0xb0);

class Tcp {
    constructor(link, port, name) {
        this.link = link;
        this.port = port;
        this.name = name;
        this.state = 'LISTEN';
        this.peer = null;          // [ip, port]
        this.seq = randomU32();
        this.ack = 0;
        this.nextSyn = 0;
        this.cltp = new Cltp(this);
    }

    segment(flags, payload = new Uint8Array(0), options = new Uint8Array(0)) {
        const { ourIp, hostMac } = this.link;
        const [peerIp, peerPort] = this.peer;
        const header = new Uint8Array(20 + options.length);
        put16(header, 0, this.port);
        put16(header, 2, peerPort);
        put32(header, 4, this.seq);
        put32(header, 8, this.ack);
        header[12] = (5 + options.length / 4) << 4;
        header[13] = flags;
        put16(header, 14, 16384);
        header.set(options, 20);
        const pseudo = concat(ipBytes(ourIp), ipBytes(peerIp), Uint8Array.of(0, 6), new Uint8Array(2));
        put16(pseudo, 10, header.length + payload.length);
        put16(header, 16, checksum(concat(pseudo, header, payload)));
        this.link.sendFrame(ipv4Frame(hostMac, ourIp, peerIp, 6, concat(header, payload)));
    }

    connect(peer) {
        this.peer = peer;
        this.state = 'SYN_SENT';
        this.nextSyn = 0;
        this.poll();
    }

    poll() {
        if (this.state !== 'SYN_SENT' || Date.now() < this.nextSyn) return;
        this.segment(SYN, undefined, MSS);
        this.nextSyn = Date.now() + 1000;
    }

    send(data) {
        for (let i = 0; i < data.length; i += SEGMENT) {
            const chunk = data.subarray(i, i + SEGMENT);
            this.segment(ACK | PSH, chunk);
            this.seq = (this.seq + chunk.length) >>> 0;
        }
    }

    matches(src, sport, dport) {
        if (dport !== this.port) return false;
        return this.state === 'LISTEN' || !this.peer || (this.peer[0] === src && this.peer[1] === sport);
    }

    // Back to listening (accepted) or ready to connect again (ours): the Switch reconnects
    // after a transfer.
    reset() {
        this.state = this.name === 'in' ? 'LISTEN' : 'CLOSED';
        this.peer = null;
        this.seq = randomU32();
        this.cltp = new Cltp(this);
    }

    receive(ip) {
        const seg = ip.subarray((ip[0] & 15) * 4, be16(ip, 2));
        const sport = be16(seg, 0), seq = be32(seg, 4), ack = be32(seg, 8), flags = seg[13];
        const data = seg.subarray((seg[12] >> 4) * 4);
        if (flags & RST) { this.link.log(`TCP ${this.name}: reset by the Switch`); this.reset(); return; }
        if (this.state === 'SYN_SENT') {
            if (flags & SYN && flags & ACK && ack === ((this.seq + 1) >>> 0)) {
                this.seq = (this.seq + 1) >>> 0;
                this.ack = (seq + 1) >>> 0;
                this.state = 'ESTABLISHED';
                this.segment(ACK);
                this.link.connected(this);
            }
            return;
        }
        if (flags & SYN) {
            if (this.state === 'LISTEN') { this.peer = [ipText(ip.subarray(12, 16)), sport]; this.ack = (seq + 1) >>> 0; this.state = 'SYN_RCVD'; }
            this.segment(SYN | ACK, undefined, MSS);
            return;
        }
        if (this.state === 'SYN_RCVD' && flags & ACK && ack === ((this.seq + 1) >>> 0)) {
            this.seq = (this.seq + 1) >>> 0;
            this.state = 'ESTABLISHED';
            this.link.connected(this);
        }
        if (this.state !== 'ESTABLISHED') return;
        if (data.length) {
            // Out of order: dropped, and the ACK asks for what is missing.
            if (seq === this.ack) {
                this.ack = (this.ack + data.length) >>> 0;
                this.cltp.feed(data);
            }
            this.segment(ACK);
        }
        if (flags & FIN) {
            this.ack = (this.ack + 1) >>> 0;
            this.segment(FIN | ACK);
            this.link.log(`TCP ${this.name}: the Switch closed the connection`);
            this.reset();
        }
    }
}

// ---- CLTP

class Cltp {
    constructor(tcp) {
        this.tcp = tcp;
        this.buf = new Uint8Array(0);
        this.need = 0;
    }

    message(text) { this.tcp.send(concat(new TextEncoder().encode(text), new Uint8Array(1))); }

    supply(payload) { this.tcp.send(concat(new TextEncoder().encode(`CLTP SUPPLY 0x${payload.length.toString(16)}`), new Uint8Array(1), payload)); }

    feed(data) {
        this.buf = concat(this.buf, data);
        const link = this.tcp.link;
        for (;;) {
            if (this.need) {
                link.status('receiving', { done: Math.min(this.buf.length, this.need), total: this.need });
                if (this.buf.length < this.need) return;
                const payload = this.buf.slice(0, this.need);
                this.buf = this.buf.slice(this.need);
                this.need = 0;
                this.message('CLTP ACCEPT');
                link.supplied(payload);
                continue;
            }
            const end = this.buf.indexOf(0);
            if (end < 0) return;
            const text = new TextDecoder('latin1').decode(this.buf.subarray(0, end));
            this.buf = this.buf.slice(end + 1);
            link.log(`CLTP ${this.tcp.name}: ${text}`);
            if (['CLTP ACCEPT', 'CLTP REJECT', 'CLTP CANCEL'].includes(text)) link.answered(text.slice(5));
            else if (text.startsWith('CLTP SUPPLY ')) {
                this.need = parseInt(text.slice(12), 16);
                link.status('receiving', { done: 0, total: this.need });
            }
        }
    }
}

function randomU32() {
    return crypto.getRandomValues(new Uint32Array(1))[0];
}

// ---- the session

// Events: 'status' { stage, detail }, 'received' (payload bytes), 'answer' (ACCEPT,
// REJECT or CANCEL), 'ended' (why, or null when stopped), 'log' (text).
// Stages: looking, joining, connecting, ready, receiving, sending.
export class MiiLink extends EventTarget {
    constructor(esp) {
        super();
        this.esp = esp;
        this.running = false;
        this.stage = null;
        this.onLine = (event) => this.line(event.detail);
        this.onRestarted = () => this.end('The board restarted.');
    }

    log(text) { this.dispatchEvent(new CustomEvent('log', { detail: text })); }

    status(stage, detail = null) {
        this.stage = stage;
        this.dispatchEvent(new CustomEvent('status', { detail: { stage, detail } }));
    }

    async start() {
        const esp = this.esp;
        this.running = true;
        this.token = null;
        this.sendQueue = Promise.resolve();
        esp.addEventListener('log', this.onLine);
        esp.addEventListener('restarted', this.onRestarted);
        try {
            const stopped = await esp.command('LDN_BRIDGE_STOP', 5000);
            if (!stopped.includes('LDN_BRIDGE_STOPPED')) throw new Error('The board did not hand over its radio.');
            const tap = await esp.command('LDN_TAP 1');
            if (!tap.some((line) => line.startsWith('LDN_TAP 1'))) throw new Error(`The board's firmware cannot do this; install ${LINK_FIRMWARE} or newer in step 1.`);
            const join = await esp.command(`LDN_JOIN ${COMMUNICATION_ID} ${toHex(PASSPHRASE)}`);
            if (!join.some((line) => line.startsWith('LDN_JOIN_STARTED'))) throw new Error(`The board would not join (${join.join(' ') || 'no answer'}).`);
        } catch (error) {
            await this.stop();
            throw error;
        }
        this.status('looking');
        this.timer = setInterval(() => this.tick(), 100);
    }

    async stop() {
        const esp = this.esp;
        this.running = false;
        clearInterval(this.timer);
        esp.removeEventListener('log', this.onLine);
        esp.removeEventListener('restarted', this.onRestarted);
        if (!esp.attached) return;
        for (const command of ['LDN_TAP 0', 'LDN_JOIN_STOP', 'LDN_BRIDGE_START']) {
            try { await esp.command(command, 3000); } catch {}
        }
    }

    // The session ends by itself: the Switch left, the board failed or restarted.
    async end(reason) {
        if (!this.running) return;
        await this.stop();
        this.dispatchEvent(new CustomEvent('ended', { detail: reason }));
    }

    get ready() { return this.stage === 'ready'; }

    // Supply a payload once both connections are up; the Switch's answer arrives as an
    // 'answer' event.
    send(payload) {
        if (!this.ready) throw new Error('The Switch is not connected yet.');
        this.status('sending', { total: payload.length });
        this.out.cltp.supply(payload);
        this.log(`supplied ${payload.length} bytes`);
    }

    // Frames go out one command at a time, in order.
    sendFrame(frame) {
        const esp = this.esp;
        this.sendQueue = this.sendQueue.then(() => esp.command(`LDN_ETH ${toHex(frame)}`, 1000)).then((reply) => {
            if (!reply.includes('LDN_ETH_RESULT 0')) this.log(`a frame was not sent: ${reply.join(' ') || 'no answer'}`);
        }, () => {});
    }

    line(text) {
        if (!this.running) return;
        if (text.startsWith('LDN_TAP_FRAME ')) { this.frame(fromHex(text.slice(14))); return; }
        const fields = text.split(' ');
        if (fields[0] === 'LDN_JOIN_ROOM') this.status('joining', { host: fields.slice(2).join(' ') });
        else if (fields[0] === 'LDN_JOINED') this.joined(fields);
        else if (fields[0] === 'LDN_JOIN_FAILED') this.end(JOIN_FAILURES[fields[1]] ?? `Joining failed (${fields[1]}).`);
        else if (text.startsWith('LDN_NET_LOST')) this.end('The Switch left Local Play.');
    }

    joined(fields) {
        [, this.ourIp, this.ourMac, this.hostIp, this.hostMac] = fields;
        this.hostName = fields.slice(5).join(' ');
        this.in = new Tcp(this, CLTP_PORT, 'in');
        this.out = new Tcp(this, 49200 + (randomU32() & 255), 'out');
        this.nextPing = 0;
        this.nextBeacon = 0;
        this.log(`in the room as ${this.ourIp}, the Switch is ${this.hostIp}`);
        this.status('connecting', { host: this.hostName });
    }

    tick() {
        if (!this.running || !this.in) return;
        const now = Date.now();
        if (now >= this.nextPing) {
            this.nextPing = now + 1000;
            this.esp.command('LDN_PING', 1000).catch(() => {});
        }
        if (this.token && this.out.state === 'CLOSED' && !this.out.peer) {
            this.out = new Tcp(this, 49200 + (randomU32() & 255), 'out');
        }
        if (this.token && this.out.state === 'LISTEN' && !this.out.peer) this.out.connect([this.hostIp, CLTP_PORT]);
        this.out.poll();
        if (this.token && this.in.state === 'LISTEN' && now >= this.nextBeacon) {
            this.sendFrame(udpFrame(this.hostMac, this.ourIp, this.hostIp, BEACON_PORT, this.token));
            this.nextBeacon = now + 100;
        }
        const up = this.in.state === 'ESTABLISHED' && this.out.state === 'ESTABLISHED';
        if (!up && this.stage === 'ready') this.status('connecting', { host: this.hostName });
    }

    frame(frame) {
        if (!this.in) return;
        const reply = arpReply(frame, this.ourMac, this.ourIp);
        if (reply) { this.sendFrame(reply); return; }
        if (be16(frame, 12) !== 0x0800) return;
        const ip = frame.subarray(14);
        const proto = ip[9], src = ipText(ip.subarray(12, 16));
        const seg = ip.subarray((ip[0] & 15) * 4, be16(ip, 2));
        const sport = be16(seg, 0), dport = be16(seg, 2);
        if (proto === 17 && dport === BEACON_PORT && seg.length === 12 && !this.token) {
            this.token = seg.slice(8);
            this.log(`the Switch said hello (${toHex(this.token)})`);
        } else if (proto === 6) {
            for (const tcp of [this.out, this.in]) if (tcp.matches(src, sport, dport)) { tcp.receive(ip); break; }
        }
    }

    connected(tcp) {
        this.log(`TCP ${tcp.name}: connected`);
        if (this.in.state === 'ESTABLISHED' && this.out.state === 'ESTABLISHED') this.status('ready', { host: this.hostName });
    }

    supplied(payload) {
        this.log(`the Switch sent ${payload.length} bytes`);
        this.dispatchEvent(new CustomEvent('received', { detail: payload }));
        this.status(this.in.state === 'ESTABLISHED' && this.out.state === 'ESTABLISHED' ? 'ready' : 'connecting', { host: this.hostName });
    }

    answered(answer) {
        if (this.stage !== 'sending') return;
        this.dispatchEvent(new CustomEvent('answer', { detail: answer }));
        this.status(this.in.state === 'ESTABLISHED' && this.out.state === 'ESTABLISHED' ? 'ready' : 'connecting', { host: this.hostName });
    }
}

const JOIN_FAILURES = {
    NO_ROOM: 'No Tomodachi Life room was found. Open Local Play on the Switch and press "Look for another player" first.',
    ASSOCIATION: 'The board could not connect to the Switch\'s wireless.',
    REFUSED: 'The Switch did not let the board join.',
    MEMBERSHIP: 'The Switch let the board in but never listed it as a player.',
    NO_KEYS: 'The board is missing its keys. Add your prod.keys in step 1.',
    AUTH_BUILD: 'The board could not build its join request.',
    LINK_LOST: 'The Switch left Local Play.',
};
