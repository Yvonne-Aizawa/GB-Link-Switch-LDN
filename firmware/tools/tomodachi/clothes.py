"""The game's clothes and outfits, read from a romfs dump, for dressing a Mii (mii.py).

Pieces come from RSDB/Cloth (name and type: Headwear, Tops, Topslong, BottomsA, BottomsB
for socks, Shoes, Accessory, All for full-body costumes), outfits from RSDB/Coordinate
and CoordinateClothInfo (their pieces, and the pieces' colours for each outfit colour),
display names from the Mals/<language> message archive. A payload refers to a piece or
outfit by the MurmurHash3 of its name (ClothHeadwearHatWitch, Coordinate0091).

The romfs is found at --romfs, or $TOMODACHI_ROMFS.

Usage as a script: uv run --with zstandard python -I clothes.py <text>
lists the pieces and outfits whose name or ID contains text.
"""
import os, struct, sys
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import byml
from mii import murmur3

TYPES = ["Headwear", "Tops", "Topslong", "BottomsA", "BottomsB", "Shoes", "Accessory", "All"]


def sarc(data):
    """{name: bytes} of a little-endian SARC archive."""
    if data[:4] != b"SARC": raise ValueError("not a SARC archive")
    header = struct.unpack_from("<H", data, 4)[0]
    data_at = struct.unpack_from("<I", data, 12)[0]
    count = struct.unpack_from("<H", data, header + 6)[0]
    nodes = [struct.unpack_from("<IIII", data, header + 12 + 16 * i) for i in range(count)]
    names_at = header + 12 + 16 * count + 8
    out = {}
    for hash_, attr, start, end in nodes:
        name = data[names_at + (attr & 0xffff) * 4:].split(b"\0")[0].decode() if attr >> 24 else f"{hash_:08x}"
        out[name] = data[data_at + start:data_at + end]
    return out


def msbt(data):
    """{label: text} of a little-endian MSBT message file; formatting tags are dropped."""
    if data[:8] != b"MsgStdBn": raise ValueError("not an MSBT file")
    sections, at = {}, 0x20
    for _ in range(struct.unpack_from("<H", data, 0x0e)[0]):
        size = struct.unpack_from("<I", data, at + 4)[0]
        sections[data[at:at + 4]] = data[at + 16:at + 16 + size]
        at += 16 + size; at += -at % 16
    labels, lbl = {}, sections[b"LBL1"]
    for group in range(struct.unpack_from("<I", lbl, 0)[0]):
        count, at = struct.unpack_from("<II", lbl, 4 + 8 * group)
        for _ in range(count):
            n = lbl[at]
            labels[struct.unpack_from("<I", lbl, at + 1 + n)[0]] = lbl[at + 1:at + 1 + n].decode()
            at += 1 + n + 4
    txt = sections[b"TXT2"]
    count = struct.unpack_from("<I", txt, 0)[0]
    offsets = list(struct.unpack_from(f"<{count}I", txt, 4)) + [len(txt)]
    out = {}
    for i in range(count):
        raw, chars, j = txt[offsets[i]:offsets[i + 1]], [], 0
        while j + 1 < len(raw):
            c = struct.unpack_from("<H", raw, j)[0]
            if c == 0: break
            if c == 0x0e: j += 8 + struct.unpack_from("<H", raw, j + 6)[0]; continue   # tag
            if c == 0x0f: j += 6; continue                                             # closing tag
            chars.append(chr(c)); j += 2
        out[labels.get(i, str(i))] = "".join(chars)
    return out


class Catalog:
    def __init__(self, romfs=None, language="EUen"):
        romfs = romfs or os.environ.get("TOMODACHI_ROMFS")
        if not romfs: raise SystemExit("Where is the game's romfs? Pass --romfs or set TOMODACHI_ROMFS.")
        import zstandard
        read = lambda path: zstandard.ZstdDecompressor().decompressobj().decompress(open(os.path.join(romfs, path), "rb").read())
        table = lambda name: byml.Reader(read(f"RSDB/{name}.Product.100.rstbl.byml.zs")).root
        self.type = {row["__RowId"]: row["Type"] for row in table("Cloth")}            # piece: type
        self.names = {}
        for path, data in sarc(read(f"Mals/{language}.Product.100.sarc.zs")).items():
            if path.startswith(("ReplaceMsg/Cloth", "ReplaceMsg/Coordinate")) and path.endswith(".msbt"):
                self.names.update(msbt(data))
        info = {row["__RowId"].value: row for row in table("CoordinateClothInfo")}
        by_hash = {murmur3(p.encode()): p for p in self.type}
        self.outfits = {}   # outfit: ({type: piece}, [{type: colour} for each outfit colour])
        for row in table("Coordinate"):
            name = row["__RowId"].split("/")[-1].split(".")[0]
            ci = info[row["ComponentsHash"]["CoordinateClothInfoRef"].value]
            pieces = {t: by_hash[ci[t + "Hash"].value] for t in TYPES if ci[t + "Hash"].value}
            colours = [{t: c[t].value for t in pieces} for c in ci["Color"]]
            self.outfits[name] = (pieces, colours)
        self.by_hash = {murmur3(n.encode()): n for n in [*self.type, *self.outfits]}

    def name(self, item): return self.names.get(item, item)

    def search(self, text):
        """Pieces and outfits whose ID or display name contains text, as (ID, kind, name)."""
        text = text.lower()
        hits = [(p, t, self.name(p)) for p, t in self.type.items()] + \
               [(o, f"outfit, {len(c)} colour{'s' * (len(c) != 1)}", self.name(o)) for o, (_, c) in self.outfits.items()]
        return [h for h in hits if text in h[0].lower() or text in h[2].lower()]


if __name__ == "__main__":
    if len(sys.argv) != 2: raise SystemExit(__doc__)
    for item, kind, name in Catalog().search(sys.argv[1]): print(f"{item:40} {kind:18} {name}")
