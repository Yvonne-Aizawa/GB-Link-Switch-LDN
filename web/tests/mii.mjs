// Tomodachi Life over Local Play against a stand-in for the board and the Switch:
// node web/tests/mii.mjs. The board joins at once; the Switch says hello on UDP 5001,
// connects and accepts connections on TCP 5002 and speaks CLTP both ways, as
// firmware/tools/tomodachi/README.md describes.

import { readFileSync } from 'node:fs';
import { MiiLink } from '../js/mii/link.js';
import { describe, murmur3, prepare } from '../js/mii/payload.js';
import { Hash32, Reader, Value, Writer, INT, UINT } from '../js/mii/byml.js';

let failures = 0;
function check(ok, what) {
    if (!ok) { failures++; console.log('FAIL', what); }
}
const hex = (bytes) => Buffer.from(bytes).toString('hex');
const unhex = (text) => Uint8Array.from(Buffer.from(text, 'hex'));
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const OUR_IP = '169.254.1.2', SWITCH_IP = '169.254.1.1', SWITCH_MAC = '0a0b0c0d0e0f', OUR_MAC = '020000000001';

function frame(src, dst, proto, segment) {
    const ip = Buffer.alloc(20);
    ip[0] = 0x45; ip.writeUInt16BE(20 + segment.length, 2); ip[8] = 64; ip[9] = proto;
    Buffer.from(src.split('.').map(Number)).copy(ip, 12);
    Buffer.from(dst.split('.').map(Number)).copy(ip, 16);
    return Buffer.concat([Buffer.from(OUR_MAC, 'hex'), Buffer.from(SWITCH_MAC, 'hex'), Buffer.from([8, 0]), ip, segment]);
}

// One side of a TCP connection on the Switch.
class SwitchTcp {
    constructor(sw, port, peerPort) { Object.assign(this, { sw, port, peerPort, seq: 1000, ack: 0, up: false, buf: Buffer.alloc(0), need: 0 }); }
    segment(flags, data = Buffer.alloc(0)) {
        const h = Buffer.alloc(20);
        h.writeUInt16BE(this.port, 0); h.writeUInt16BE(this.peerPort, 2); h.writeUInt32BE(this.seq, 4); h.writeUInt32BE(this.ack, 8);
        h[12] = 5 << 4; h[13] = flags;
        this.sw.emit(frame(SWITCH_IP, OUR_IP, 6, Buffer.concat([h, data])));
        this.seq = (this.seq + data.length) >>> 0;
    }
    send(data) { for (let i = 0; i < data.length; i += 1000) this.segment(0x18, data.subarray(i, i + 1000)); }
    receive(seg) {
        const flags = seg[13], seq = seg.readUInt32BE(4), data = seg.subarray((seg[12] >> 4) * 4);
        if (flags & 2 && flags & 16) { this.seq++; this.ack = seq + 1; this.up = true; this.segment(16); return; }
        if (flags & 2) { this.ack = seq + 1; this.segment(0x12); this.seq++; return; }
        if (flags & 16 && !this.up) { this.up = true; }
        if (!data.length || seq !== this.ack) return;
        this.ack += data.length;
        this.segment(16);
        this.buf = Buffer.concat([this.buf, data]);
        for (;;) {
            if (this.need) {
                if (this.buf.length < this.need) return;
                this.sw.got.push(this.buf.subarray(0, this.need));
                this.buf = this.buf.subarray(this.need); this.need = 0;
                this.send(Buffer.from(`CLTP ${this.sw.answer}\0`));
                continue;
            }
            const end = this.buf.indexOf(0);
            if (end < 0) return;
            const text = this.buf.subarray(0, end).toString('latin1');
            this.buf = this.buf.subarray(end + 1);
            this.sw.messages.push(text);
            if (text.startsWith('CLTP SUPPLY ')) this.need = parseInt(text.slice(12), 16);
        }
    }
}

class FakeSwitch {
    constructor(esp) { Object.assign(this, { esp, got: [], messages: [], answer: 'ACCEPT', toUs: null, fromUs: null, dropEvery: 0, count: 0 }); }
    emit(bytes) { setTimeout(() => this.esp.event(`LDN_TAP_FRAME ${hex(bytes)}`), 1); }
    hello() {
        const udp = Buffer.alloc(12);
        udp.writeUInt16BE(5001, 0); udp.writeUInt16BE(5001, 2); udp.writeUInt16BE(12, 4); udp.writeUInt32BE(5, 8);
        this.emit(frame(SWITCH_IP, OUR_IP, 17, udp));
    }
    // A frame the page sent.
    take(bytes) {
        if (bytes.readUInt16BE(12) !== 0x0800) return;
        const ip = bytes.subarray(14), seg = ip.subarray(20, ip.readUInt16BE(2));
        if (ip[9] === 17) {
            if (!this.toUs) { this.toUs = new SwitchTcp(this, 40000, 5002); this.toUs.segment(2); }
            return;
        }
        const sport = seg.readUInt16BE(0), dport = seg.readUInt16BE(2);
        if (dport === 5002) {
            this.fromUs ??= new SwitchTcp(this, 5002, sport);
            this.fromUs.receive(seg);
        } else if (dport === 40000) this.toUs.receive(seg);
    }
    supply(payload) { this.toUs.send(Buffer.concat([Buffer.from(`CLTP SUPPLY 0x${payload.length.toString(16)}\0`), payload])); }
}

class FakeEsp extends EventTarget {
    constructor() { super(); this.attached = true; this.commands = []; this.sw = new FakeSwitch(this); }
    event(text) { this.dispatchEvent(new CustomEvent('log', { detail: text })); }
    async command(text) {
        this.commands.push(text.split(' ')[0]);
        await sleep(1);
        if (text === 'LDN_BRIDGE_STOP') return ['LDN_BRIDGE_STOPPED'];
        if (text === 'LDN_TAP 1') return ['LDN_TAP 1 dropped=0'];
        if (text.startsWith('LDN_JOIN ')) {
            setTimeout(() => {
                this.event('LDN_JOIN_ROOM 6 Yvonne');
                this.event(`LDN_JOINED ${OUR_IP} ${OUR_MAC} ${SWITCH_IP} ${SWITCH_MAC} Yvonne's Switch`);
                this.sw.hello();
            }, 5);
            return ['LDN_JOIN_STARTED 010051f0207b2000'];
        }
        if (text.startsWith('LDN_ETH ')) { this.sw.take(Buffer.from(text.slice(8), 'hex')); return ['LDN_ETH_RESULT 0']; }
        return [];
    }
}

async function until(test, ms = 3000) {
    const end = Date.now() + ms;
    while (!test()) { if (Date.now() > end) return false; await sleep(5); }
    return true;
}

// ---- a small Mii payload: outer wrapper around an inner document with CharInfoEx

function sampleMii(extra = 0) {
    const h = (name) => murmur3(new TextEncoder().encode(name));
    const paint = new Writer(new Hash32([[0xceb3a288, 'paint-uuid'], [0x689b60b2, new Value(INT, 7)]])).build();
    const inner = new Writer(new Hash32([
        [0x05f5f62c, new Uint8Array(152).fill(7)],
        [h('Gender'), new Value(INT, 1)],
        [h('BirthYear'), new Value(INT, 2004)], [h('BirthMonth'), new Value(INT, 7)], [h('BirthDay'), new Value(INT, 25)],
        [0x0247a06d, paint],
        [0x2155012a, new Value(UINT, 0xdeadbeef)],
        ...(extra ? [[0x784e7ede, Uint8Array.from({ length: extra }, (_, i) => i * 7)]] : []),
    ])).build();
    return new Writer(new Hash32([[0x25efa387, 'Test02'], [0xceb3a288, 'outer-uuid'], [0x689b60b2, new Value(INT, 6)], [0xb77378b7, inner]])).build();
}

// ---- payloads

{
    const mii = sampleMii();
    const about = describe(mii);
    check(about.kind === 'Mii' && about.name === 'Test02' && about.gender === 'Female' && about.birthday?.day === 25, `describe: ${JSON.stringify(about)}`);
    const sent = prepare(mii, { name: 'Miku' });
    const outer = new Reader(sent).root, inner = new Reader(outer.get(0xb77378b7)).root;
    check(outer.get(0x25efa387) === 'Miku', 'prepare renames');
    check(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(outer.get(0xceb3a288)), 'a new v4 transfer UUID');
    check(new Reader(inner.get(0x0247a06d)).root.get(0xceb3a288) !== 'paint-uuid', 'face paint gets a new transfer UUID');
    check(hex(inner.get(0x05f5f62c).subarray(0, 16)) !== '07'.repeat(16) && inner.get(0x05f5f62c).subarray(16).every((b) => b === 7), 'a new Mii ID, the face kept');
    check(!new Reader(sent).strings.includes('outer-uuid') && !new Reader(sent).strings.includes('Test02'), 'old strings drop out');
    check(prepare(mii, { name: 'Miku' }).length === sent.length, 'prepare is stable in size');
}

// A payload the Switch sent, kept out of git (personal data): checked only when present.
try {
    const dir = new URL('../../firmware/tools/tomodachi/samples/', import.meta.url);
    const data = new Uint8Array(readFileSync(new URL('test02-newpaint.bin', dir)));
    const r = new Reader(data);
    check(Buffer.compare(Buffer.from(new Writer(r.root, r.strings, r.version).build()), Buffer.from(data)) === 0, 'a real payload round-trips');
} catch (error) {
    if (error.code !== 'ENOENT') throw error;
}

// ---- the link

{
    const esp = new FakeEsp();
    const link = new MiiLink(esp);
    const stages = [], received = [], answers = [];
    link.addEventListener('status', (e) => stages.push(e.detail.stage));
    link.addEventListener('received', (e) => received.push(e.detail));
    link.addEventListener('answer', (e) => answers.push(e.detail));
    await link.start();
    check(esp.commands.slice(0, 3).join() === 'LDN_BRIDGE_STOP,LDN_TAP,LDN_JOIN', `start commands: ${esp.commands.slice(0, 3)}`);
    check(await until(() => link.ready), `both connections up (stages ${stages})`);
    check(stages.includes('joining') && stages.includes('connecting'), `stages: ${stages}`);

    // The Switch sends a Mii: accepted, and handed to the page.
    // Big enough for many segments each way, like a Mii with face paint.
    const fromSwitch = sampleMii(20000);
    esp.sw.supply(Buffer.from(fromSwitch));
    check(await until(() => received.length === 1), 'a supplied Mii arrives');
    check(received[0] && hex(received[0]) === hex(fromSwitch), 'it arrives whole');
    check(await until(() => esp.sw.messages.includes('CLTP ACCEPT')), 'and the page accepts it');
    check(link.ready, 'ready again after receiving');

    // The page sends one back: the Switch gets it whole and answers.
    const payload = prepare(fromSwitch, { name: 'Back' });
    link.send(payload);
    check(link.stage === 'sending', 'sending');
    check(await until(() => answers.length === 1), 'the Switch answers');
    check(answers[0] === 'ACCEPT', `answer ${answers[0]}`);
    check(esp.sw.got.length === 1 && hex(esp.sw.got[0]) === hex(payload), 'the Switch got the payload whole');
    check(link.ready, 'ready again after sending');

    // The board loses the room: the session ends with a reason.
    let ended = null;
    link.addEventListener('ended', (e) => { ended = e.detail; });
    esp.event('LDN_JOIN_FAILED LINK_LOST');
    check(await until(() => ended !== null), 'the session ends when the Switch leaves');
    check(/left/.test(ended ?? ''), `why: ${ended}`);
    check(esp.commands.slice(-3).join() === 'LDN_TAP,LDN_JOIN_STOP,LDN_BRIDGE_START', `stop commands: ${esp.commands.slice(-3)}`);
}

{
    // Old firmware: no tap, so the start fails and hands the radio back.
    const esp = new FakeEsp();
    const command = esp.command.bind(esp);
    esp.command = async (text) => (text === 'LDN_TAP 1' ? ['LDN_ERROR UNKNOWN_COMMAND'] : command(text));
    const link = new MiiLink(esp);
    let error = null;
    try { await link.start(); } catch (e) { error = e; }
    check(/2\.2\.0/.test(error?.message ?? ''), `old firmware is named: ${error?.message}`);
    check(esp.commands.at(-1) === 'LDN_BRIDGE_START', 'and the bridge restarts');
}

console.log(failures ? `${failures} FAILED` : 'all passed');
process.exit(failures ? 1 : 0);
