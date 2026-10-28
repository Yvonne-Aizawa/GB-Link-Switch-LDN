// Tomodachi Life payloads: what the Switch supplies over Local Play (a Mii, face paint,
// custom food or clothing), read for display and made ready to send back. The layout is
// in firmware/tools/tomodachi/README.md; this follows send_mii.py and mii.py.

import { Hash32, Reader, Value, Writer } from './byml.js';

export const NAME = 0x25efa387;       // the displayed name, in the outer document
export const TRANSFER = 0xceb3a288;   // the transfer's UUID, as text (UgcUuid)
export const INNER = 0xb77378b7;      // the item's own document (UgcBinary)
export const CORE = 0x05f5f62c;       // in a Mii's document: CharInfoEx, the Mii ID first
export const CATEGORY = 0x689b60b2;
// The game's own limit when renaming; it shows and accepts 30, longer only warns.
export const MAX_NAME = 13;

const CATEGORIES = { 6: 'Mii', 7: 'Face paint', 8: 'Outfit', 9: 'Clothing', 12: 'Food', 16: 'Habit' };
const GENDERS = ['Male', 'Female', 'Non-binary'];

// MurmurHash3 (x86, 32-bit), seed 0: the game's hash of field names.
export function murmur3(bytes, seed = 0) {
    const mix = (k) => {
        k = Math.imul(k, 0xcc9e2d51);
        k = (k << 15) | (k >>> 17);
        return Math.imul(k, 0x1b873593);
    };
    let h = seed;
    const end = bytes.length & ~3;
    for (let i = 0; i < end; i += 4) {
        h ^= mix(bytes[i] | (bytes[i + 1] << 8) | (bytes[i + 2] << 16) | (bytes[i + 3] << 24));
        h = (h << 13) | (h >>> 19);
        h = (Math.imul(h, 5) + 0xe6546b64) | 0;
    }
    let tail = 0;
    for (let i = bytes.length - 1; i >= end; i--) tail = (tail << 8) | bytes[i];
    if (end < bytes.length) h ^= mix(tail);
    h ^= bytes.length;
    h ^= h >>> 16;
    h = Math.imul(h, 0x85ebca6b);
    h ^= h >>> 13;
    h = Math.imul(h, 0xc2b2ae35);
    h ^= h >>> 16;
    return h >>> 0;
}

const field = (name) => murmur3(new TextEncoder().encode(name));
const plain = (v) => (v instanceof Value ? v.value : v);
const isDocument = (v) => v instanceof Uint8Array && v[0] === 0x59 && v[1] === 0x42;

function uuidBytes() {
    const bytes = crypto.getRandomValues(new Uint8Array(16));
    bytes[6] = (bytes[6] & 0x0f) | 0x40;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;
    return bytes;
}

function uuidText(bytes = uuidBytes()) {
    const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

// What a payload is, for the page: { kind, name, gender?, birthday? }. Throws on bytes
// that are not a payload.
export function describe(data) {
    const outer = new Reader(data).root;
    if (!(outer instanceof Hash32) || !outer.has(INNER)) throw new Error('not a Tomodachi Life payload');
    const category = plain(outer.get(CATEGORY));
    const inner = new Reader(outer.get(INNER)).root;
    const mii = inner.has(CORE);
    const out = { kind: mii ? 'Mii' : CATEGORIES[category] ?? 'Item', name: outer.get(NAME) ?? '' };
    if (mii) {
        const gender = plain(inner.get(field('Gender')));
        if (GENDERS[gender]) out.gender = GENDERS[gender];
        const [year, month, day] = ['BirthYear', 'BirthMonth', 'BirthDay'].map((f) => plain(inner.get(field(f))));
        if (month && day) out.birthday = { year, month, day };
    }
    return out;
}

// The payload with new transfer UUIDs, and optionally a new name and (for a Mii) a new Mii
// ID, so the island takes it as new. An item whose transfer UUID the island already has
// gets no answer: the Switch hangs up. Face paint nested in a Mii carries one of its own.
export function prepare(data, { name = null, newId = true, uuid = uuidText, id = uuidBytes } = {}) {
    const outer = new Reader(data);
    const root = outer.root;
    root.set(TRANSFER, uuid());
    if (name !== null) root.set(NAME, name);
    const inner = new Reader(root.get(INNER));
    for (const entry of inner.root.entries) {
        if (!isDocument(entry[1])) continue;
        const item = new Reader(entry[1]);
        if (!item.root.has(TRANSFER)) continue;
        item.root.set(TRANSFER, uuid());
        entry[1] = new Writer(item.root, [], item.version).build();
    }
    if (newId && inner.root.has(CORE)) {
        const core = inner.root.get(CORE).slice();
        core.set(id(), 0);
        inner.root.set(CORE, core);
    }
    root.set(INNER, new Writer(inner.root, inner.strings, inner.version).build());
    // Only the strings still in use: the old name and UUID drop out.
    return new Writer(root, [], outer.version).build();
}
