"""The game's clothes, outfits, foods and habits with their English names, as tables.json,
so clothes.py, foods.py and habits.py work without a romfs dump.

The catalogs read tables.json when it is there and no romfs is given; with --romfs DIR
(or no tables.json and $TOMODACHI_ROMFS) they read the romfs instead.

Usage: uv run --with zstandard python -I tables.py --romfs DIR
regenerates tables.json from a romfs dump.
"""
import argparse, json, os, sys
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

PATH = os.path.join(os.path.dirname(os.path.abspath(__file__)), "tables.json")
_tables = None


def load():
    """The tables, or None if there is no tables.json."""
    global _tables
    if _tables is None and os.path.exists(PATH): _tables = json.load(open(PATH, encoding="utf-8"))
    return _tables


def romfs_of(romfs):
    """The romfs to read: the one given, else $TOMODACHI_ROMFS."""
    romfs = romfs or os.environ.get("TOMODACHI_ROMFS")
    if not romfs: raise SystemExit(f"No {os.path.basename(PATH)} and no romfs: pass --romfs or set TOMODACHI_ROMFS.")
    return romfs


def main():
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("--romfs", help="the game's romfs (or set TOMODACHI_ROMFS)")
    p.add_argument("--language", default="EUen", help="the message archive the names come from")
    a = p.parse_args()
    import clothes, foods, habits
    romfs = romfs_of(a.romfs)
    c, f, h = clothes.Catalog(romfs, a.language), foods.Catalog(romfs, a.language), habits.Catalog(romfs, a.language)
    tables = {"language": a.language,
              "pieces": {p: [t, c.name(p)] for p, t in sorted(c.type.items())},
              "outfits": {o: [c.name(o), pieces, colours] for o, (pieces, colours) in sorted(c.outfits.items())},
              "foods": {x: f.name(x) for x in sorted(f.ids)},
              "habits": {x: [h.name(x), h.group(x)] for x in sorted(h.ids)}}
    with open(PATH, "w", encoding="utf-8") as out:
        out.write("{\n" + ",\n".join(f"{json.dumps(k)}: {{\n" + ",\n".join(f"  {json.dumps(i)}: {json.dumps(v, ensure_ascii=False)}"
                                                                         for i, v in table.items()) + "\n}"
                                    if isinstance(table, dict) else f"{json.dumps(k)}: {json.dumps(table)}"
                                    for k, table in tables.items()) + "\n}\n")
    print(f"{len(tables['pieces'])} pieces, {len(tables['outfits'])} outfits, {len(tables['foods'])} foods, "
          f"{len(tables['habits'])} habits in {PATH}")


if __name__ == "__main__":
    main()
