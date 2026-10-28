"""The game's habits, read from a romfs dump, for giving a Mii habits (mii.py).

Habits come from RSDB/HabitParam (their IDs, such as UntidySleeper for "Restless
sleeper", and an exclusion group: a Mii has at most one habit of each group, such as
one way of greeting), display names from Mals/<language>/ReplaceMsg/Habit_Name.msbt.
A payload refers to a habit by the MurmurHash3 of its ID.

The tables come from tables.json when it is there; otherwise from the romfs
($TOMODACHI_ROMFS).

Usage as a script: uv run --with zstandard python -I habits.py <text>
lists the habits whose ID or English name contains text.
"""
import os, sys
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import foods
from mii import plain


class Catalog(foods.Catalog):
    TABLE, MESSAGES, KEY = "HabitParam", "Habit_Name", "habits"

    def _load(self, table):
        self.ids = list(table)
        self.names, self.groups = {h: n for h, (n, _) in table.items()}, {h: g for h, (_, g) in table.items()}

    def group(self, habit): return self.groups[habit] if self.rows is None else plain(self.rows[habit]["ExcludeGroup"])


def catalog(): return foods.catalog(Catalog)


if __name__ == "__main__":
    if len(sys.argv) != 2: raise SystemExit(__doc__)
    for habit, name in Catalog().search(sys.argv[1]): print(f"{habit:30} {name}")
