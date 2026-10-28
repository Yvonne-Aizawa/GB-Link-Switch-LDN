// The little-endian BYAML (version 7) documents in Tomodachi Life payloads, read and
// written byte for byte as the game lays them out. A port of
// firmware/tools/tomodachi/byml.py; only the node types Mii payloads use are handled.

export const STRING = 0xa0, BINARY = 0xa1, ARRAY = 0xc0, DICT = 0xc1, TABLE = 0xc2;
export const BOOL = 0xd0, INT = 0xd1, FLOAT = 0xd2, UINT = 0xd3, INT64 = 0xd4, UINT64 = 0xd5, DOUBLE = 0xd6, NULL = 0xff;
export const HASH32 = 0x20;   // dictionary keyed by 32-bit hashes
const VALUE_TYPES = new Set([BOOL, INT, FLOAT, UINT]);
const WIDE_TYPES = new Set([INT64, UINT64, DOUBLE]);
const OUT_OF_LINE = new Set([BINARY, ARRAY, DICT, HASH32, INT64, UINT64, DOUBLE]);

// A typed leaf, so ints, uints and floats keep their node type.
export class Value {
    constructor(type, value) { this.type = type; this.value = value; }
}

// Entries as [hash, node] pairs: the game writes some hashes twice (0x71f55538).
export class Hash32 {
    constructor(entries = [], order = []) {
        this.entries = entries;
        this.order = order;   // entry indices of out-of-line values, in stored order
    }

    get(key) { return this.entries.find(([k]) => k === key)?.[1]; }
    has(key) { return this.entries.some(([k]) => k === key); }

    // Replace every entry with this hash (or add one).
    set(key, value) {
        let hit = false;
        for (const entry of this.entries) if (entry[0] === key) { entry[1] = value; hit = true; }
        if (!hit) this.entries.push([key, value]);
    }
}

const utf8 = new TextDecoder();
const encoder = new TextEncoder();

export class Reader {
    constructor(data) {
        this.d = data;
        this.view = new DataView(data.buffer, data.byteOffset, data.byteLength);
        if (data[0] !== 0x59 || data[1] !== 0x42) throw new Error('not a little-endian BYAML document');
        this.version = this.view.getUint16(2, true);
        const keysAt = this.u32(4), stringsAt = this.u32(8), rootAt = this.u32(12);
        this.keys = keysAt ? this.table(keysAt) : [];
        this.strings = stringsAt ? this.table(stringsAt) : [];
        this.root = rootAt ? this.node(data[rootAt], rootAt) : null;
    }

    u32(at) { return this.view.getUint32(at, true); }

    table(at) {
        if (this.d[at] !== TABLE) throw new Error(`expected a string table at ${at}`);
        const count = this.u32(at) >>> 8;
        const out = [];
        for (let i = 0; i < count; i++) {
            const start = at + this.u32(at + 4 + 4 * i), end = at + this.u32(at + 8 + 4 * i);
            const bytes = this.d.subarray(start, end);
            const nul = bytes.indexOf(0);
            out.push(utf8.decode(nul < 0 ? bytes : bytes.subarray(0, nul)));
        }
        return out;
    }

    // A value stored inline (in an array or dictionary slot) or by offset.
    value(kind, raw, at) {
        if (kind === STRING) return this.strings[raw];
        if (kind === BOOL || kind === UINT) return new Value(kind, raw);
        if (kind === INT) return new Value(kind, this.view.getInt32(at, true));
        if (kind === FLOAT) return new Value(kind, this.view.getFloat32(at, true));
        if (kind === NULL) return new Value(NULL, null);
        if (kind === INT64) return new Value(kind, this.view.getBigInt64(raw, true));
        if (kind === UINT64) return new Value(kind, this.view.getBigUint64(raw, true));
        if (kind === DOUBLE) return new Value(kind, this.view.getFloat64(raw, true));
        return this.node(kind, raw);
    }

    node(kind, at) {
        if (kind === BINARY) return this.d.slice(at + 4, at + 4 + this.u32(at));   // size, then data; no type byte
        if (this.d[at] !== kind) throw new Error(`node ${kind.toString(16)} expected at ${at}, found ${this.d[at].toString(16)}`);
        const count = this.u32(at) >>> 8;
        if (kind === ARRAY) {
            const base = at + 4 + Math.ceil(count / 4) * 4;
            return Array.from({ length: count }, (_, i) => this.value(this.d[at + 4 + i], this.u32(base + 4 * i), base + 4 * i));
        }
        if (kind === DICT) {
            const out = {};
            for (let i = 0; i < count; i++) {
                const e = at + 4 + 8 * i;
                out[this.keys[this.u32(e) & 0xffffff]] = this.value(this.d[e + 3], this.u32(e + 4), e + 4);
            }
            return out;
        }
        if (kind === HASH32) {
            const entries = [], placed = [];
            const typesAt = at + 4 + 8 * count;
            for (let i = 0; i < count; i++) {
                const e = at + 4 + 8 * i, raw = this.u32(e + 4), type = this.d[typesAt + i];
                entries.push([this.u32(e), this.value(type, raw, e + 4)]);
                if (OUT_OF_LINE.has(type)) placed.push([raw, i]);
            }
            placed.sort((a, b) => a[0] - b[0]);
            return new Hash32(entries, placed.map(([, i]) => i));
        }
        throw new Error(`unsupported node type ${kind.toString(16)} at ${at}`);
    }
}

export function kindOf(v) {
    if (typeof v === 'string') return STRING;
    if (v instanceof Value) return v.type;
    if (v instanceof Uint8Array) return BINARY;
    if (Array.isArray(v)) return ARRAY;
    if (v instanceof Hash32) return HASH32;
    if (v && typeof v === 'object') return DICT;
    throw new TypeError(`cannot store ${typeof v}`);
}

function compareBytes(a, b) {
    for (let i = 0; i < Math.min(a.length, b.length); i++) if (a[i] !== b[i]) return a[i] - b[i];
    return a.length - b.length;
}

// Serialise a tree the way the game lays it out: header, sorted string table, the
// out-of-line values of each container (in their stored order), then the container,
// the root last. `strings` are kept in the table even when unused, as the game does.
export class Writer {
    constructor(root, strings = [], version = 7) {
        this.root = root;
        this.version = version;
        const used = new Set(strings);
        this.collect(root, used);
        this.strings = [...used].map((s) => [s, encoder.encode(s)]).sort((a, b) => compareBytes(a[1], b[1]));
        this.index = new Map(this.strings.map(([s], i) => [s, i]));
        this.out = new Bytes();
    }

    collect(v, used) {
        if (typeof v === 'string') used.add(v);
        else if (v instanceof Hash32) for (const [, x] of v.entries) this.collect(x, used);
        else if (Array.isArray(v)) for (const x of v) this.collect(x, used);
        else if (v && typeof v === 'object' && !(v instanceof Value) && !(v instanceof Uint8Array)) {
            throw new TypeError('string-keyed dictionaries are not needed by Mii payloads');
        }
    }

    table() {
        const at = this.out.length;
        const blobs = this.strings.map(([, bytes]) => bytes);
        let offset = 4 + 4 * (blobs.length + 1);
        this.out.u32(TABLE | (blobs.length << 8));
        for (const blob of blobs) { this.out.u32(offset); offset += blob.length + 1; }
        this.out.u32(offset);
        for (const blob of blobs) { this.out.bytes(blob); this.out.bytes([0]); }
        this.out.align();
        return at;
    }

    // The 32-bit field for v in its container: an inline value, string index or offset.
    slot(v, placed) {
        const kind = kindOf(v);
        if (kind === STRING) return this.index.get(v);
        if (kind === BOOL || kind === UINT) return v.value >>> 0;
        if (kind === INT) return v.value | 0;
        if (kind === FLOAT) { const f = new DataView(new ArrayBuffer(4)); f.setFloat32(0, v.value, true); return f.getUint32(0, true); }
        if (kind === NULL) return 0;
        return placed.get(v);
    }

    // Write an out-of-line value and return its offset.
    place(v) {
        const kind = kindOf(v);
        // The game packs binary values back to back, unaligned; what follows aligns itself.
        if (kind === BINARY) {
            const at = this.out.length;
            this.out.u32(v.length);
            this.out.bytes(v);
            return at;
        }
        if (WIDE_TYPES.has(kind)) {
            this.out.align();
            const at = this.out.length;
            const view = new DataView(new ArrayBuffer(8));
            if (kind === INT64) view.setBigInt64(0, BigInt(v.value), true);
            else if (kind === UINT64) view.setBigUint64(0, BigInt(v.value), true);
            else view.setFloat64(0, v.value, true);
            this.out.bytes(new Uint8Array(view.buffer));
            return at;
        }
        if (kind === HASH32) {
            // Entries sorted by hash (stable, so a repeated hash keeps its order).
            const rows = v.entries.map((_, i) => i).sort((a, b) => v.entries[a][0] - v.entries[b][0] || a - b);
            const later = rows.filter((i) => OUT_OF_LINE.has(kindOf(v.entries[i][1])));
            const order = [...v.order.filter((i) => later.includes(i)), ...later.filter((i) => !v.order.includes(i))];
            const placed = new Map();
            for (const i of order) placed.set(v.entries[i][1], this.place(v.entries[i][1]));
            this.out.align();
            const at = this.out.length;
            this.out.u32(HASH32 | (rows.length << 8));
            for (const i of rows) { this.out.u32(v.entries[i][0]); this.out.u32(this.slot(v.entries[i][1], placed)); }
            this.out.bytes(rows.map((i) => kindOf(v.entries[i][1])));
            this.out.align();
            return at;
        }
        if (kind === ARRAY) {
            const placed = new Map();
            for (const x of v) if (OUT_OF_LINE.has(kindOf(x))) placed.set(x, this.place(x));
            this.out.align();
            const at = this.out.length;
            this.out.u32(ARRAY | (v.length << 8));
            this.out.bytes(v.map(kindOf));
            this.out.align();
            for (const x of v) this.out.u32(this.slot(x, placed));
            return at;
        }
        throw new TypeError(`cannot place node type ${kind.toString(16)}`);
    }

    build() {
        this.out = new Bytes();
        this.out.bytes(new Uint8Array(16));
        const stringsAt = this.strings.length ? this.table() : 0;
        const rootAt = this.place(this.root);
        const out = this.out.done();
        const view = new DataView(out.buffer);
        out[0] = 0x59; out[1] = 0x42;
        view.setUint16(2, this.version, true);
        view.setUint32(4, 0, true);
        view.setUint32(8, stringsAt, true);
        view.setUint32(12, rootAt, true);
        return out;
    }
}

// A growing byte buffer.
class Bytes {
    constructor() { this.buf = new Uint8Array(1024); this.length = 0; }

    room(n) {
        if (this.length + n <= this.buf.length) return;
        const bigger = new Uint8Array(Math.max(this.buf.length * 2, this.length + n));
        bigger.set(this.buf.subarray(0, this.length));
        this.buf = bigger;
    }

    bytes(data) { this.room(data.length); this.buf.set(data, this.length); this.length += data.length; }
    u32(v) { this.room(4); new DataView(this.buf.buffer).setUint32(this.length, v >>> 0, true); this.length += 4; }
    align() { this.bytes(new Uint8Array(-this.length & 3)); }
    done() { return this.buf.slice(0, this.length); }
}
