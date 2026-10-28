"""Read and write the little-endian BYAML (version 7) documents in Tomodachi Life payloads.

A document is a header ("YB", version, key table, string table, root), the tables
(node 0xC2: sorted strings) and a tree of nodes. Values are kept as typed Python objects
so a document round-trips byte for byte when nothing changes. Only the node types the
game's Mii payloads use are handled; anything else raises.

Usage as a script: byml.py <file> dumps the tree, looking inside binary values that are
themselves documents.
"""
import struct, sys
from dataclasses import dataclass, field

STRING, BINARY, ARRAY, DICT, TABLE = 0xA0, 0xA1, 0xC0, 0xC1, 0xC2
BOOL, INT, FLOAT, UINT, INT64, UINT64, DOUBLE, NULL = 0xD0, 0xD1, 0xD2, 0xD3, 0xD4, 0xD5, 0xD6, 0xFF
HASH32 = 0x20                                   # dictionary keyed by 32-bit hashes
VALUE_TYPES = {BOOL: '<I', INT: '<i', FLOAT: '<f', UINT: '<I'}
WIDE_TYPES = {INT64: '<q', UINT64: '<Q', DOUBLE: '<d'}


@dataclass
class Value:
    """A typed leaf, so ints, uints and floats keep their node type."""
    type: int
    value: object


@dataclass
class Hash32:
    """Entries as [hash, node] pairs: the game writes some hashes twice (0x71f55538)."""
    entries: list = field(default_factory=list)
    order: list = field(default_factory=list)   # entry indices of out-of-line values, in stored order

    def get(self, key):
        return next(v for k, v in self.entries if k == key)

    def set(self, key, value):
        """Replace every entry with this hash (or add one)."""
        hits = [e for e in self.entries if e[0] == key]
        for e in hits: e[1] = value
        if not hits: self.entries.append([key, value])

    @property
    def items(self): return dict((k, v) for k, v in self.entries)


class Reader:
    def __init__(self, data):
        self.d = data
        if data[:2] != b'YB': raise ValueError('not a little-endian BYAML document')
        self.version = struct.unpack_from('<H', data, 2)[0]
        keys_at, strings_at, root_at = struct.unpack_from('<III', data, 4)
        self.keys = self.table(keys_at) if keys_at else []
        self.strings = self.table(strings_at) if strings_at else []
        self.root = self.node(self.d[root_at], root_at) if root_at else None

    def u32(self, at): return struct.unpack_from('<I', self.d, at)[0]

    def table(self, at):
        if self.d[at] != TABLE: raise ValueError(f'expected a string table at {at:#x}')
        count = self.u32(at) >> 8
        offsets = [self.u32(at + 4 + 4 * i) for i in range(count + 1)]
        return [self.d[at + offsets[i]:at + offsets[i + 1]].split(b'\0')[0].decode('utf-8') for i in range(count)]

    def value(self, kind, raw):
        """A value stored inline (in an array or dictionary slot) or by offset."""
        if kind == STRING: return self.strings[raw]
        if kind in VALUE_TYPES: return Value(kind, struct.unpack(VALUE_TYPES[kind], struct.pack('<I', raw))[0])
        if kind == NULL: return Value(NULL, None)
        if kind in WIDE_TYPES: return Value(kind, struct.unpack_from(WIDE_TYPES[kind], self.d, raw)[0])
        return self.node(kind, raw)

    def node(self, kind, at):
        if kind == BINARY: return bytes(self.d[at + 4:at + 4 + self.u32(at)])   # size, then data; no type byte
        if self.d[at] != kind: raise ValueError(f'node {kind:#x} expected at {at:#x}, found {self.d[at]:#x}')
        count = self.u32(at) >> 8
        if kind == ARRAY:
            types = self.d[at + 4:at + 4 + count]
            base = at + 4 + (count + 3) // 4 * 4
            return [self.value(types[i], self.u32(base + 4 * i)) for i in range(count)]
        if kind == DICT:
            out = {}
            for i in range(count):
                e = at + 4 + 8 * i
                key = self.u32(e) & 0xffffff
                out[self.keys[key]] = self.value(self.d[e + 3], self.u32(e + 4))
            return out
        if kind == HASH32:
            entries, placed = [], []
            types_at = at + 4 + 8 * count
            for i in range(count):
                e = at + 4 + 8 * i
                key, raw, kind_i = self.u32(e), self.u32(e + 4), self.d[types_at + i]
                entries.append([key, self.value(kind_i, raw)])
                if kind_i in OUT_OF_LINE: placed.append((raw, i))
            return Hash32(entries, [i for _, i in sorted(placed)])
        raise ValueError(f'unsupported node type {kind:#x} at {at:#x}')


OUT_OF_LINE = {BINARY, ARRAY, DICT, HASH32, INT64, UINT64, DOUBLE}


def kind_of(v):
    if isinstance(v, str): return STRING
    if isinstance(v, Value): return v.type
    if isinstance(v, bytes): return BINARY
    if isinstance(v, list): return ARRAY
    if isinstance(v, Hash32): return HASH32
    if isinstance(v, dict): return DICT
    raise TypeError(f'cannot store {type(v).__name__}')


class Writer:
    """Serialise a tree the way the game lays it out: header, sorted string table, the
    out-of-line values of each container (in their stored order), then the container,
    the root last. `strings` are kept in the table even when unused, as the game does."""
    def __init__(self, root, strings=(), version=7):
        self.root, self.version = root, version
        used = set(strings)
        self.collect(root, used)
        self.strings = sorted(used, key=lambda s: s.encode('utf-8'))
        self.index = {s: i for i, s in enumerate(self.strings)}
        self.out = bytearray()

    def collect(self, v, used):
        if isinstance(v, str): used.add(v)
        elif isinstance(v, Hash32): [self.collect(x, used) for _, x in v.entries]
        elif isinstance(v, dict): raise TypeError('string-keyed dictionaries are not needed by Mii payloads')
        elif isinstance(v, list): [self.collect(x, used) for x in v]

    def align(self): self.out += bytes(-len(self.out) % 4)

    def table(self):
        at = len(self.out)
        blobs = [s.encode('utf-8') + b'\0' for s in self.strings]
        offsets, o = [], 4 + 4 * (len(blobs) + 1)
        for b in blobs: offsets.append(o); o += len(b)
        offsets.append(o)
        self.out += struct.pack('<I', TABLE | len(blobs) << 8) + b''.join(struct.pack('<I', x) for x in offsets) + b''.join(blobs)
        self.align()
        return at

    def slot(self, v, placed):
        """The 32-bit field for v in its container: an inline value, string index or offset."""
        kind = kind_of(v)
        if kind == STRING: return self.index[v]
        if kind in VALUE_TYPES: return struct.unpack('<I', struct.pack(VALUE_TYPES[kind], v.value))[0]
        if kind == NULL: return 0
        return placed[id(v)]

    def place(self, v):
        """Write an out-of-line value and return its offset."""
        kind = kind_of(v)
        # The game packs binary values back to back, unaligned; what follows aligns itself.
        if kind == BINARY:
            at = len(self.out); self.out += struct.pack('<I', len(v)) + v; return at
        if kind in WIDE_TYPES:
            self.align(); at = len(self.out); self.out += struct.pack(WIDE_TYPES[kind], v.value); return at
        if kind == HASH32:
            # Entries sorted by hash (stable, so a repeated hash keeps its order).
            rows = sorted(range(len(v.entries)), key=lambda i: v.entries[i][0])
            later = [i for i in rows if kind_of(v.entries[i][1]) in OUT_OF_LINE]
            order = [i for i in v.order if i in later] + [i for i in later if i not in v.order]
            placed = {id(v.entries[i][1]): self.place(v.entries[i][1]) for i in order}
            self.align(); at = len(self.out)
            self.out += struct.pack('<I', HASH32 | len(rows) << 8)
            for i in rows: self.out += struct.pack('<II', v.entries[i][0], self.slot(v.entries[i][1], placed))
            self.out += bytes(kind_of(v.entries[i][1]) for i in rows); self.align()
            return at
        if kind == ARRAY:
            placed = {id(x): self.place(x) for x in v if kind_of(x) in OUT_OF_LINE}
            self.align(); at = len(self.out)
            self.out += struct.pack('<I', ARRAY | len(v) << 8) + bytes(kind_of(x) for x in v); self.align()
            for x in v: self.out += struct.pack('<I', self.slot(x, placed))
            return at
        raise TypeError(f'cannot place node type {kind:#x}')

    def build(self):
        self.out = bytearray(16)
        strings_at = self.table() if self.strings else 0
        root_at = self.place(self.root)
        self.out[:16] = b'YB' + struct.pack('<HIII', self.version, 0, strings_at, root_at)
        return bytes(self.out)


def dump(node, indent=0, out=print):
    pad = '  ' * indent
    if isinstance(node, dict):
        for k, v in node.items(): out(f'{pad}{k}:'); dump(v, indent + 1, out)
    elif isinstance(node, Hash32):
        for k, v in node.entries:
            if isinstance(v, (dict, list, Hash32, bytes)): out(f'{pad}{k:08x}:'); dump(v, indent + 1, out)
            else: out(f'{pad}{k:08x}: {show(v)}')
    elif isinstance(node, list):
        for i, v in enumerate(node):
            if isinstance(v, (dict, list, Hash32, bytes)): out(f'{pad}[{i}]'); dump(v, indent + 1, out)
            else: out(f'{pad}[{i}] {show(v)}')
    elif isinstance(node, bytes):
        if node[:2] == b'YB':
            out(f'{pad}<document, {len(node)} bytes>'); dump(Reader(node).root, indent + 1, out)
        else: out(f'{pad}<{len(node)} bytes> {node[:24].hex(" ")}{" ..." if len(node) > 24 else ""}')
    else: out(f'{pad}{show(node)}')


def show(v):
    if isinstance(v, Value): return f'{ {BOOL:"bool",INT:"int",FLOAT:"float",UINT:"uint",INT64:"int64",UINT64:"uint64",DOUBLE:"double",NULL:"null"}[v.type]} {v.value}'
    return repr(v)


if __name__ == '__main__':
    r = Reader(open(sys.argv[1], 'rb').read())
    print(f'version {r.version}, {len(r.keys)} keys, {len(r.strings)} strings')
    dump(r.root)
