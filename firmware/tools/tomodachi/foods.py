"""The game's foods, read from a romfs dump, for a Mii's favourite and hated foods (mii.py).

Foods come from RSDB/FoodParam (their IDs, such as Tofu or Sundepokku), display names
from Mals/<language>/ReplaceMsg/Food_Name.msbt. A payload refers to a food by the
MurmurHash3 of its ID.

The romfs is found at --romfs, or $TOMODACHI_ROMFS.

Usage as a script: uv run --with zstandard python -I foods.py <text>
lists the foods whose ID or English name contains text.
"""
import os, sys
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import byml
from clothes import msbt, sarc
from mii import murmur3


class Catalog:
    TABLE, MESSAGES = "FoodParam", "Food_Name"   # habits.py reads habits the same way

    def __init__(self, romfs=None, language="EUen"):
        romfs = romfs or os.environ.get("TOMODACHI_ROMFS")
        if not romfs: raise SystemExit("Where is the game's romfs? Pass --romfs or set TOMODACHI_ROMFS.")
        import zstandard
        read = lambda path: zstandard.ZstdDecompressor().decompressobj().decompress(open(os.path.join(romfs, path), "rb").read())
        self.rows = {row["Name"]: row for row in byml.Reader(read(f"RSDB/{self.TABLE}.Product.100.rstbl.byml.zs")).root}
        self.ids = list(self.rows)
        self.names = msbt(sarc(read(f"Mals/{language}.Product.100.sarc.zs"))[f"ReplaceMsg/{self.MESSAGES}.msbt"])
        self.by_hash = {murmur3(f.encode()): f for f in self.ids}

    def name(self, food): return self.names.get(food) or food

    def find(self, text):
        """The ID of a food (or habit) named by its ID or English name, either in any case."""
        hits = [f for f in self.ids if text.lower() in (f.lower(), self.name(f).lower())]
        if len(hits) == 1: return hits[0]
        if hits: raise ValueError(f"{text!r} could be {', '.join(hits)}; give the ID")
        near = [self.name(f) for f, _ in self.search(text)][:8]
        what = self.TABLE.removesuffix("Param").lower()
        raise ValueError(f"no {what} {text!r}" + (f"; did you mean {', '.join(near)}?" if near else f"; {what}s.py <text> searches"))

    def search(self, text):
        """Foods whose ID or display name contains text, as (ID, name)."""
        text = text.lower()
        return [(f, self.name(f)) for f in self.ids if text in f.lower() or text in self.name(f).lower()]


_catalogs = {}


def catalog(cls=Catalog):
    """The catalog from $TOMODACHI_ROMFS, read once."""
    if cls not in _catalogs: _catalogs[cls] = cls()
    return _catalogs[cls]


if __name__ == "__main__":
    if len(sys.argv) != 2: raise SystemExit(__doc__)
    for food, name in Catalog().search(sys.argv[1]): print(f"{food:30} {name}")
