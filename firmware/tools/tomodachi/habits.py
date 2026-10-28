"""The game's habits, read from a romfs dump, for giving a Mii habits (mii.py).

Habits come from RSDB/HabitParam (their IDs, such as UntidySleeper for "Restless
sleeper", and an exclusion group: a Mii has at most one habit of each group, such as
one way of greeting), display names from Mals/<language>/ReplaceMsg/Habit_Name.msbt.
A payload refers to a habit by the MurmurHash3 of its ID.

The romfs is found at --romfs, or $TOMODACHI_ROMFS.

Usage as a script: uv run --with zstandard python -I habits.py <text>
lists the habits whose ID or English name contains text.
"""
import os, sys
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import foods
from mii import plain


class Catalog(foods.Catalog):
    TABLE, MESSAGES = "HabitParam", "Habit_Name"

    def group(self, habit): return plain(self.rows[habit]["ExcludeGroup"])


def catalog(): return foods.catalog(Catalog)


if __name__ == "__main__":
    if len(sys.argv) != 2: raise SystemExit(__doc__)
    for habit, name in Catalog().search(sys.argv[1]): print(f"{habit:30} {name}")
