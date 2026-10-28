"""Edit a Tomodachi Life Mii payload as a Python object and write it back out.

A payload can't be made from nothing yet: start from one the Switch sent (a template,
supply-*.bin), or from a ShareMii .ltd laid over one. What isn't changed stays as the
template has it (island and creator, and anything not set).

    m = Mii.load("samples/supply-20261028-112535-1.bin")
    m.name, m.pronunciation = "Miku", "mee koo"
    m.gender, m.pronouns, m.voice_preset = "Female", "She", "RobotL"
    m.birthday = (2007, 8, 31)
    m.personality["gaiety"] = 8
    m.set_face_paint("face.png")          # needs zstandard and pillow
    m.wear("Coordinate0091")              # an outfit (the witch outfit); needs the romfs
    m.wear("ClothHeadwearHatSimpleCap", color=2)   # or one piece, replacing what it covers
    m.favourite_foods = ["tofu", "gnocchi"]          # English names or IDs; needs the romfs
    m.hated_foods = ["panini", "Crab"]
    m.add_habit("Walks cutely")                     # replaces the walk it had; needs the romfs
    m.save("miku.bin")                    # new transfer UUIDs and Mii ID

Fields without a property are reached by name or hash: m["TasteType"], m["HatedFood1"], m[0x7de5dfb0].
Clothes are named by their IDs in the game's tables; clothes.py <text> finds them, and
foods.py <text> finds foods.

Usage as a script: uv run --with pyserial --with cryptography python -I mii.py
       <template> [--ltd FILE] [--name ...] [--pronunciation ...] [--phrase ...] [--phrase-kind ...] [--gender ...]
       [--pronouns ...] [--cloth-style ...] [--loves ...] [--birthday Y-M-D]
       [--voice-preset ...] [--face-paint IMAGE] [--wear ITEM[:COLOUR] ...]
       [--take-off TYPE ...] [--clothes-from FILE] [--favourite-foods A,B] [--hated-foods A,B]
       [--habits A,B,...] [--add-habit HABIT ...] [--remove-habit HABIT ...]
       [--romfs DIR]
       [--out FILE] [--send] [--seconds N]
Without --out or --send it prints the Mii.
"""
import argparse, os, struct, sys, tempfile
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import byml, send_mii


def murmur3(data, seed=0):
    """MurmurHash3 (x86, 32-bit): the game's hash of field names, in the save and payload."""
    rotl = lambda x, r: (x << r | x >> 32 - r) & 0xffffffff
    mix = lambda k: rotl(k * 0xcc9e2d51 & 0xffffffff, 15) * 0x1b873593 & 0xffffffff
    h, end = seed, len(data) // 4 * 4
    for i in range(0, end, 4):
        h = (rotl(h ^ mix(int.from_bytes(data[i:i + 4], "little")), 13) * 5 + 0xe6546b64) & 0xffffffff
    if end < len(data): h ^= mix(int.from_bytes(data[end:], "little"))
    h ^= len(data)
    for shift, mul in ((16, 0x85ebca6b), (13, 0xc2b2ae35), (16, None)):
        h ^= h >> shift
        if mul: h = h * mul & 0xffffffff
    return h


H = lambda name: murmur3(name.encode())
GENDERS = ["Male", "Female", "NonBinary"]
# The save's enums are hashes of names; the payload numbers them, from FIRST when not 0.
ENUMS = {"Gender": GENDERS, "ClothStyle": GENDERS, "PronounType": ["He", "She", "They"],
         # Numbered from Boy: Custom is -1 (a custom voice), Robot L 8 (seen in game)
         "VoicePreset": ["Pet", "System", "Custom", "Boy", "Girl", "Male", "Female", "OldMan", "OldWoman",
                         "BigCharacter", "SmallCharacter", "RobotL", "RobotS"],
         # When the phrase is said; numbered from TalkStart (seen in game: TalkEnd 1, Phrase 2, TalkInSleep 7)
         "WordKind": ["Invalid", "TalkStart", "TalkEnd", "Phrase", "Happy", "Sad", "Angry", "Greeting",
                      "TalkInSleep", "ShoutToSea", "BeforeEat"]}
FIRST = {"VoicePreset": -3, "WordKind": -1}
# Fields whose names are not known. Foods hold the MurmurHash3 of a RSDB/FoodParam Name
# (Crab): two all-time favourites and two hated foods, each in the order the game lists them.
KEYS = {"VoicePreset": 0xa90584fa, "WordKind": 0xe5da2956,
        "FavouriteFood1": 0x3cc01748, "FavouriteFood2": 0x79612bf3, "HatedFood1": 0xa95867bb, "HatedFood2": 0x85d70c73}
PERSONALITY = ["Sociability", "Audaciousness", "Activeness", "Commonsense", "Gaiety"]
VOICE = ["Formant", "Speed", "Intonation", "Pitch", "Tension"]
# The .ltd's 18 values at offset 160, in order, by their field names in the payload.
LTD_FIELDS = [f"Character{p}" for p in PERSONALITY] + [f"Voice{v}" for v in VOICE] + \
             ["VoicePreset", "Gender", "PronounType", "ClothStyle", "BirthYear", "BirthDay", "DirectAge", "BirthMonth"]
CATEGORY, FACE_PAINT = 0x689b60b2, 7       # an item's category; 7 is face paint
ITEM_ID = 0x2155012a                       # an item's ID, a hash of its internal name
CANVAS, UGCTEX = 0x25997a82, 0xb0f5c106    # the face paint's zstd files (names unknown)
OUTFIT, CLOTHING, HABIT = 8, 9, 16         # more item categories
# ColorIndex, and what can't be shared: 0 in items; in the outer document -3 when the Mii's
# clothes came from someone else, which the Switch then sends as starter clothes instead.
COLOUR, ITEM_FLAG = 0xbd0d09d7, 0x4dfe38dc
CLOTHES_WITHHELD = -3
# The item slots: clothes, the outfit, the face paint and habits share them. Twelve keys
# seen; a Mii with an outfit of four pieces and seven habits used all twelve.
SLOTS = [0x0247a06d, 0x14e70791, 0x2421f5bf, 0x51a6b6a2, 0x6e9f1596, 0x8ce538bc, 0x3a01765a, 0xffa7b0eb,
         0x99a2b6e1, 0x14cdbc7d, 0x01e0b2b5, 0x215e6297]
# The game numbers a Mii's items in the order their data is stored, and points at the one
# of each kind by that number (-1 for none). Pieces are listed here in the order the game
# stores an outfit's (All first, Accessory before Headwear). Each habit has its own field.
INDEX = {"All": 0xfcfe477c, "Tops": 0x09862234, "Topslong": 0x4f5d6ba9, "BottomsA": 0xbe30923f,
         "BottomsB": 0x3dc2dbcd, "Shoes": 0xd6d4ea8f, "Accessory": 0x012523d9, "Headwear": 0x8ab92078,
         "Outfit": 0x41b5252b, "FacePaint": 0xba906068}
# Habits fill seven numbered slots in this order (a Mii with n habits uses the first n,
# true of all 33 captures). Each slot has an index field and a field that is 1 once it is
# used and absent before; the game's list shows them grouped by kind, not in slot order.
HABIT_INDEX = [0x0433c2eb, 0x63d7d8b3, 0xac690f5c, 0x8138aa2d, 0x6677d657, 0xca2cf8c7, 0xe153d8ce]
HABIT_USED = [0x502a5d7d, 0x49dbacc0, 0xf6e0191f, 0x02d2f68c, 0xedcf1f80, 0x5287f5cc, 0x7d49dca1]
ITEM_COUNT = 0x7bf9decb
# The phrase: these fields exist only once a Mii has one (names unknown), with WordKind.
PHRASE, PHRASE_SAYS, PHRASE_LANGUAGE = 0xc3f3d6a6, 0x87c1aff6, 0x51110d81
# What a piece of each type takes off besides one of its own type.
REPLACES = {"All": {"Tops", "Topslong", "BottomsA", "BottomsB", "Shoes"}, "Topslong": {"Tops", "BottomsA", "All"},
            "Tops": {"Topslong", "All"}, "BottomsA": {"Topslong", "All"}, "BottomsB": {"All"}, "Shoes": {"All"}}


def item_doc(category, item, name, colour=None):
    """A clothing, outfit or habit item's document, as the game writes them (habits have no colour)."""
    fields = [[ITEM_ID, byml.Value(byml.UINT, murmur3(item.encode()))], [send_mii.NAME, name],
              [ITEM_FLAG, byml.Value(byml.INT, 0)], [CATEGORY, byml.Value(byml.INT, category)]]
    if colour is not None: fields.append([COLOUR, byml.Value(byml.INT, colour)])
    return byml.Writer(byml.Hash32(fields), version=7).build()


def remove_key(doc, key):
    """Drop a key from a Hash32 node, keeping the stored order of the others."""
    keep = [i for i, (k, _) in enumerate(doc.entries) if k != key]
    new = {old: i for i, old in enumerate(keep)}
    doc.entries = [doc.entries[i] for i in keep]
    doc.order = [new[i] for i in doc.order if i in new]


def key_of(field): return field if isinstance(field, int) else KEYS.get(field) or H(field)


def plain(v):
    """A stored value as Python sees it: Value nodes unwrapped, uints as signed if hashes."""
    return v.value if isinstance(v, byml.Value) else v


class Doc:
    """A BYAML document stored as binary inside another one, edited in place."""
    def __init__(self, data):
        r = byml.Reader(bytes(data))
        self.root, self.version = r.root, r.version

    def build(self): return byml.Writer(self.root, version=self.version).build()

    def get(self, field): return self.root.get(key_of(field))

    def has(self, field): return key_of(field) in self.root.items

    def set(self, field, value):
        """Set a field, keeping its node type; numbers only replace numbers."""
        key = key_of(field)
        if key not in self.root.items: raise KeyError(f"the template has no {field!r}")
        old = self.root.items[key]
        if isinstance(old, byml.Value):
            value = int(value) if old.type != byml.FLOAT else float(value)
            value = byml.Value(old.type, value & 0xffffffff if old.type == byml.UINT else value)
        elif type(value) is not type(old) and not (isinstance(old, (bytes, bytearray)) and isinstance(value, bytes)):
            raise TypeError(f"{field!r} holds {type(old).__name__}, not {type(value).__name__}")
        self.root.set(key, value)


class Mii:
    def __init__(self, data):
        self.outer = Doc(data)
        self.inner = Doc(self.outer.get(send_mii.MII))
        if not self.inner.has(send_mii.CORE): raise ValueError("not a Mii: no CharInfoEx")
        self.personality = Group(self, "Character", PERSONALITY)
        self.voice = Group(self, "Voice", VOICE)

    @classmethod
    def load(cls, path): return cls(open(path, "rb").read())

    # Names: the outer Name is what the game shows, CallName what it says.
    name = property(lambda self: self.outer.get(send_mii.NAME), lambda self, v: self.outer.set(send_mii.NAME, v))
    pronunciation = property(lambda self: self.inner.get("CallName"), lambda self, v: self.inner.set("CallName", v))

    @property
    def phrase(self):
        """The Mii's phrase ('Ahem'), or '' for none."""
        return self.inner.root.items.get(PHRASE, "")

    @phrase.setter
    def phrase(self, text):
        root = self.inner.root
        if PHRASE not in root.items:   # as the game adds them; the language as the name's
            root.set(PHRASE_SAYS, ""); root.set(KEYS["WordKind"], byml.Value(byml.INT, 0))
            root.set(PHRASE_LANGUAGE, byml.Value(byml.INT, self["NameRegionLanguageID"]))
        root.set(PHRASE, text)

    def _enum(field):
        def get(self):
            names, value = ENUMS[field], plain(self.inner.get(field))
            i = value - FIRST.get(field, 0)
            return names[i] if 0 <= i < len(names) else value
        def set(self, name):
            if name not in ENUMS[field]: raise ValueError(f"{field} is one of {', '.join(ENUMS[field])}")
            self.inner.set(field, ENUMS[field].index(name) + FIRST.get(field, 0))
        return property(get, set)
    gender, pronouns = _enum("Gender"), _enum("PronounType")
    cloth_style, voice_preset = _enum("ClothStyle"), _enum("VoicePreset")
    phrase_kind = _enum("WordKind")   # when the phrase is said: TalkStart, TalkEnd, TalkInSleep, ...
    del _enum

    def _foods(fields):
        def get(self):
            import foods
            c = foods.catalog()
            return [c.name(c.by_hash.get(self[f], f"{self[f]:08x}")) for f in fields]
        def set(self, names):
            import foods
            if len(names) != len(fields): raise ValueError(f"give {len(fields)} foods, in the order the game lists them")
            c = foods.catalog()
            for f, n in zip(fields, names): self.inner.set(f, murmur3(c.find(n).encode()))
        return property(get, set)
    # Two all-time favourites and two hated foods, in the game's order; read by English name
    favourite_foods = _foods(["FavouriteFood1", "FavouriteFood2"])
    hated_foods = _foods(["HatedFood1", "HatedFood2"])
    del _foods

    @property
    def loves(self):
        """The genders this Mii dates, as a set of GENDERS (one bit each in LoveGender)."""
        bits = plain(self.inner.get("LoveGender"))
        return {g for i, g in enumerate(GENDERS) if bits >> i & 1}

    @loves.setter
    def loves(self, genders):
        self.inner.set("LoveGender", sum(1 << GENDERS.index(g) for g in genders))

    @property
    def birthday(self):
        return tuple(plain(self.inner.get(f)) for f in ("BirthYear", "BirthMonth", "BirthDay"))

    @birthday.setter
    def birthday(self, ymd):
        for f, v in zip(("BirthYear", "BirthMonth", "BirthDay"), ymd): self.inner.set(f, v)

    @property
    def core(self):
        """The 152-byte CharInfoEx: the Mii ID (a v4 UUID), then the face."""
        return bytes(self.inner.get(send_mii.CORE))

    @core.setter
    def core(self, data):
        if len(data) != 152: raise ValueError("CharInfoEx is 152 bytes")
        self.inner.set(send_mii.CORE, bytes(data))

    def __getitem__(self, field): return plain(self.inner.get(field))

    def __setitem__(self, field, value): self.inner.set(field, value)

    def items(self):
        """The item slots (clothes, outfit, habits, face paint): {key: (category, item ID, name)}."""
        out = {}
        for k, v in self.inner.root.items.items():
            if not isinstance(v, (bytes, bytearray)) or v[:2] != b"YB": continue
            doc = Doc(v)
            if doc.has(CATEGORY):
                out[k] = (plain(doc.get(CATEGORY)), plain(doc.root.items.get(ITEM_ID)), doc.root.items.get(send_mii.NAME))
        return out

    def _paints(self): return [k for k, (category, _, _) in self.items().items() if category == FACE_PAINT]

    @property
    def has_face_paint(self): return bool(self._paints())

    def set_face_paint_files(self, canvas, ugctex):
        """Replace the face paint with zstd canvas and ugctex files (as a .ltd holds them)."""
        paints = self._paints()
        if not paints: raise ValueError("the template has no face paint; start from one that has")
        for key in paints:
            item = Doc(self.inner.get(key))
            paint = Doc(item.get(send_mii.MII))
            if canvas: paint.set(CANVAS, bytes(canvas))
            if ugctex: paint.set(UGCTEX, bytes(ugctex))
            item.set(send_mii.MII, paint.build())
            self.inner.set(key, item.build())

    def set_face_paint(self, image):
        """Replace the face paint with an image file (any size; it is stretched to fit)."""
        import face_paint
        self.set_face_paint_files(*face_paint.encode(image))

    def _order(self):
        """The item keys in the order their data is stored, which is how the game numbers them."""
        root, items = self.inner.root, self.items()
        later = [i for i in sorted(range(len(root.entries)), key=lambda i: root.entries[i][0])
                 if byml.kind_of(root.entries[i][1]) in byml.OUT_OF_LINE]
        order = [i for i in root.order if i in later] + [i for i in later if i not in root.order]
        return [root.entries[i][0] for i in order if root.entries[i][0] in items]

    def _kinds(self):
        """{item key: kind}, as the index fields say: a clothing type, Outfit or FacePaint."""
        order, out = self._order(), {}
        for kind, field in INDEX.items():
            i = self[field] if field in self.inner.root.items else -1
            if 0 <= i < len(order): out[order[i]] = kind
        return out

    @property
    def clothes_withheld(self):
        """The sender's clothes weren't theirs to share, so these are starter clothes."""
        return plain(self.outer.get(ITEM_FLAG)) == CLOTHES_WITHHELD

    def habits(self):
        """The habits' names in slot order (the order they fill the slots)."""
        order, items = self._order(), self.items()
        return [items[order[self[f]]][2] for f in HABIT_INDEX
                if f in self.inner.root.items and 0 <= self[f] < len(order)]

    def _habit_ids(self, catalog):
        order, items = self._order(), self.items()
        return [catalog.by_hash.get(items[order[self[f]]][1], items[order[self[f]]][1]) for f in HABIT_INDEX
                if f in self.inner.root.items and 0 <= self[f] < len(order)]

    def set_habits(self, habits, catalog=None):
        """Give the Mii these habits (English names or IDs), in slot order, at most one of
        each kind (one way of greeting, of walking, ...) and seven in all."""
        import habits as habit_table
        catalog = catalog or habit_table.catalog()
        ids = [catalog.find(h) for h in habits]
        groups = [catalog.group(h) for h in ids]
        clash = [catalog.name(h) for h, g in zip(ids, groups) if groups.count(g) > 1]
        if clash: raise ValueError(f"{' and '.join(clash)} are the same kind of habit; a Mii has one of each kind")
        self._dress(lambda kind: False, [], [item_doc(HABIT, h, catalog.name(h)) for h in ids])

    def add_habit(self, habit, catalog=None):
        """Add a habit after the others, replacing the one of its kind if there is one."""
        import habits as habit_table
        catalog = catalog or habit_table.catalog()
        new = catalog.find(habit)
        held = [h for h in self._habit_ids(catalog) if catalog.group(h) != catalog.group(new)]
        self.set_habits(held + [new], catalog)

    def remove_habit(self, habit, catalog=None):
        """Take a habit away; the ones after it move up a slot."""
        import habits as habit_table
        catalog = catalog or habit_table.catalog()
        gone, held = catalog.find(habit), self._habit_ids(catalog)
        if gone not in held: raise ValueError(f"the Mii has no habit {catalog.name(gone)!r}")
        self.set_habits([h for h in held if h != gone], catalog)

    def clothes(self, catalog=None):
        """The outfit and pieces worn, [(kind, item, colour, name)]: kind a clothing type or
        Outfit, item the ID name when a catalog (clothes.Catalog) knows it, else its hash."""
        kinds, items, out = self._kinds(), self.items(), []
        for key in self._order():
            if kinds.get(key, "FacePaint") == "FacePaint": continue
            _, item, name = items[key]
            colour = plain(Doc(self.inner.get(key)).root.items.get(COLOUR))
            out.append((kinds[key], catalog.by_hash.get(item, item) if catalog else item, colour, name))
        return out

    def _dress(self, takes_off, put_on, habits=None):
        """Take off the items whose kind takes_off(kind) holds, put on put_on [(kind, item
        document)], replace the habits with habits [item document] in slot order if given,
        and point the index fields at where everything is now. Emptied slots are reused in
        place, as the game does, so the other items keep their numbers."""
        root, order, kinds = self.inner.root, self._order(), self._kinds()
        stray = [items[2] for k, items in self.items().items() if items[0] in (OUTFIT, CLOTHING) and k not in kinds]
        if stray: raise ValueError(f"no index field points at {', '.join(map(repr, stray))}")
        held = [order[self[f]] for f in HABIT_INDEX if f in root.items and 0 <= self[f] < len(order)]
        gone = [k for k in order if kinds.get(k, "FacePaint") != "FacePaint" and takes_off(kinds[k])]
        if habits is not None: gone += held; held = []
        if habits and len(habits) > len(HABIT_INDEX): raise ValueError(f"a Mii has at most {len(HABIT_INDEX)} habits")
        for kind, doc in put_on + [("Habit", doc) for doc in habits or []]:
            key = gone.pop(0) if gone else next((k for k in SLOTS if k not in root.items), None)
            if key is None: raise ValueError(f"all {len(SLOTS)} item slots are full")
            root.set(key, doc); kinds[key] = kind
            if kind == "Habit": held.append(key)
        for key in gone: remove_key(root, key); kinds.pop(key, None)
        order = self._order()
        for kind, field in INDEX.items():
            self.inner.set(field, next((i for i, k in enumerate(order) if kinds.get(k) == kind), -1))
        for i, field in enumerate(HABIT_INDEX):
            if field in root.items or i < len(held): self.inner.set(field, order.index(held[i]) if i < len(held) else -1)
        if habits is not None:   # a used slot's flag is 1; an unused one has none
            for i, flag in enumerate(HABIT_USED):
                if i < len(held): root.set(flag, byml.Value(byml.BOOL, 1))
                elif flag in root.items: remove_key(root, flag)
        self.inner.set(ITEM_COUNT, len(order))

    def wear(self, item, colour=0, catalog=None):
        """Put on a piece (ClothHeadwearHatWitch) or a whole outfit (Coordinate0091) in one
        of its colours. A piece replaces the one of its type and those it covers, and
        breaks up the outfit, as changing a piece in the game does."""
        import clothes
        catalog = catalog or clothes.Catalog()
        unmapped = lambda types: [t for t in types if t not in INDEX]
        if item in catalog.outfits:
            pieces, colours = catalog.outfits[item]
            if not 0 <= colour < len(colours): raise ValueError(f"{item} comes in colours 0 to {len(colours) - 1}")
            if unmapped(pieces): raise ValueError(f"{item} has a piece of type {unmapped(pieces)[0]}, whose index field is not known yet")
            put_on = [(t, item_doc(CLOTHING, p, catalog.name(p), colours[colour][t])) for t, p in
                      sorted(pieces.items(), key=lambda tp: list(INDEX).index(tp[0]))]
            self._dress(lambda kind: True, put_on + [("Outfit", item_doc(OUTFIT, item, catalog.name(item), colour))])
        elif item in catalog.type:
            type_ = catalog.type[item]
            if unmapped([type_]): raise ValueError(f"the index field of {type_} pieces is not known yet")
            covers = {type_, "Outfit"} | REPLACES.get(type_, set())
            self._dress(lambda kind: kind in covers, [(type_, item_doc(CLOTHING, item, catalog.name(item), colour))])
        else: raise ValueError(f"no piece or outfit {item!r} in the game; clothes.py <text> searches")

    def take_off(self, type_):
        """Take off the piece of a type (Headwear, Shoes, ...), breaking up the outfit."""
        self._dress(lambda kind: kind in (type_, "Outfit"), [])

    def copy_clothes(self, other):
        """Dress this Mii in another Mii's clothes (both Mii objects)."""
        kinds = other._kinds()
        self._dress(lambda kind: True, [(kinds[k], bytes(other.inner.get(k))) for k in other._order()
                                        if kinds.get(k, "FacePaint") != "FacePaint"])

    def apply_ltd(self, data):
        """Lay a ShareMii .ltd (version 3) over this Mii: face, name, pronunciation,
        personality, voice, gender, birthday, dating and face paint."""
        if data[0] != 3: raise ValueError(f".ltd version {data[0]}: only version 3 is supported")
        if struct.unpack_from("<I", data, 4)[0] != 152: raise ValueError("not a .ltd: no 152-byte Mii core")
        canvas_at, ugc_at = data.find(b"\xa3" * 4, 428), data.rfind(b"\xa4" * 4)
        if canvas_at != 428 or ugc_at < 0: raise ValueError("not a .ltd: no face paint markers")
        text = lambda b: "".join(c for c in b.decode("utf-16-le").split("\0")[0] if c >= " ")
        self.core = data[8:160]
        self.name = text(data[232:296])
        # CallName is the pronunciation; the game says the name itself when it is the same
        self.pronunciation = text(data[296:424]) or self.name
        for field, value in zip(LTD_FIELDS, struct.unpack_from("<18i", data, 160)):
            if field in ENUMS:
                names = {H(n): n for n in ENUMS[field]}
                if value & 0xffffffff not in names:
                    print(f"warning: unknown {field} {value & 0xffffffff:#x}, the template's is kept"); continue
                setattr(self, {"Gender": "gender", "PronounType": "pronouns", "ClothStyle": "cloth_style",
                               "VoicePreset": "voice_preset"}[field], names[value & 0xffffffff])
            else: self.inner.set(field, value)
        self.inner.set("LoveGender", data[424] & 7)
        canvas, ugctex = data[432:ugc_at] if data[1] else None, data[ugc_at + 4:] if data[2] else None
        if bool(canvas or ugctex) != self.has_face_paint:
            raise ValueError("the template must have face paint exactly when the .ltd does")
        if canvas or ugctex: self.set_face_paint_files(canvas, ugctex)

    @classmethod
    def from_ltd(cls, ltd, template):
        """A Mii from a .ltd laid over a template; both are file paths or bytes."""
        read = lambda x: x if isinstance(x, (bytes, bytearray)) else open(x, "rb").read()
        m = cls(read(template)); m.apply_ltd(read(ltd)); return m

    def build(self, new_ids=True):
        """The payload. With new_ids, new transfer UUIDs and a new Mii ID, so the game
        takes it as a new resident; without, exactly what was edited."""
        self.outer.set(send_mii.MII, self.inner.build())
        data = self.outer.build()
        return send_mii.prepare(data) if new_ids else data

    def save(self, path, new_ids=True):
        data = self.build(new_ids)
        open(path, "wb").write(data)
        return data

    def __str__(self):
        born = "-".join("?" if v < 0 else f"{v:0{w}}" for v, w in zip(self.birthday, (4, 2, 2)))
        lines = [f"{self.name!r} (says {self.pronunciation!r}), Mii ID {self.core[:16].hex()}"
                 + (f", phrase {self.phrase!r} ({self.phrase_kind})" if self.phrase else ""),
                 f"  {self.gender}, {self.pronouns}, clothes {self.cloth_style}, dates {', '.join(sorted(self.loves)) or 'nobody'}",
                 f"  born {born}, voice {self.voice_preset} {dict(self.voice)}",
                 f"  personality {dict(self.personality)}",
                 f"  from {self['PlayerName']!r} on {self['IslandName']!r}"
                 + (", clothes withheld (not the sender's to share)" if self.clothes_withheld else "")]
        if os.environ.get("TOMODACHI_ROMFS"):
            lines.append(f"  loves {', '.join(self.favourite_foods)}; hates {', '.join(self.hated_foods)}")
        names = {1: "", 7: "face paint", 8: "outfit", 9: "clothes", 16: "habit"}
        for category, _, name in self.items().values():
            lines.append(f"  item: {names.get(category, f'category {category}')} {name!r}".rstrip())
        return "\n".join(lines)


class Group:
    """Five related numbers (personality, voice) as a dict-like view: m.voice["pitch"] = 40."""
    def __init__(self, mii, prefix, names): self.mii, self.prefix, self.names = mii, prefix, names

    def _field(self, name):
        match = [n for n in self.names if n.lower() == name.lower()]
        if not match: raise KeyError(f"{name!r}: one of {', '.join(n.lower() for n in self.names)}")
        return self.prefix + match[0]

    def __getitem__(self, name): return plain(self.mii.inner.get(self._field(name)))

    def __setitem__(self, name, value): self.mii.inner.set(self._field(name), value)

    def keys(self): return [n.lower() for n in self.names]

    def __iter__(self): return iter(self.keys())


def main():
    p = argparse.ArgumentParser(description="Edit a Tomodachi Life Mii payload, and send or save it")
    p.add_argument("template", help="a Mii payload received from a Switch (supply-*.bin)")
    p.add_argument("--ltd", help="lay a ShareMii .ltd over the template first")
    p.add_argument("--name"); p.add_argument("--pronunciation"); p.add_argument("--phrase")
    p.add_argument("--gender", choices=GENDERS); p.add_argument("--pronouns", choices=ENUMS["PronounType"])
    p.add_argument("--cloth-style", choices=GENDERS)
    p.add_argument("--loves", help="comma-separated genders the Mii dates, or none")
    p.add_argument("--birthday", metavar="Y-M-D")
    p.add_argument("--voice-preset", choices=ENUMS["VoicePreset"][2:])
    p.add_argument("--phrase-kind", choices=ENUMS["WordKind"][1:], help="when the phrase is said (default TalkStart)")
    p.add_argument("--face-paint", metavar="IMAGE", help="needs --with zstandard --with pillow")
    p.add_argument("--clothes-from", metavar="FILE", help="dress it in the clothes of another payload")
    p.add_argument("--take-off", metavar="TYPE", action="append", default=[],
                   help="take off the piece of a type (Headwear, Shoes, BottomsB, ...)")
    p.add_argument("--wear", metavar="ITEM[:COLOUR]", action="append", default=[],
                   help="put on a piece or outfit (clothes.py finds them); needs the romfs and --with zstandard")
    p.add_argument("--favourite-foods", metavar="A,B", help="the two all-time favourites (foods.py finds them); needs the romfs")
    p.add_argument("--hated-foods", metavar="A,B", help="the two hated foods; needs the romfs")
    p.add_argument("--habits", metavar="A,B,...", help="replace the habits, in slot order (habits.py finds them); needs the romfs")
    p.add_argument("--add-habit", metavar="HABIT", action="append", default=[], help="add a habit, replacing one of its kind")
    p.add_argument("--remove-habit", metavar="HABIT", action="append", default=[])
    p.add_argument("--romfs", help="the game's romfs, for clothes and foods (or set TOMODACHI_ROMFS)")
    p.add_argument("--keep-ids", action="store_true", help="keep the Mii ID and transfer UUIDs")
    p.add_argument("--out", help="write the payload to this file")
    p.add_argument("--send", action="store_true", help="send it to the Switch")
    p.add_argument("--seconds", type=float, default=90, help="how long to wait for the Switch")
    a = p.parse_args()
    if a.romfs: os.environ["TOMODACHI_ROMFS"] = a.romfs

    m = Mii.from_ltd(a.ltd, a.template) if a.ltd else Mii.load(a.template)
    if a.name is not None:
        if not a.name or len(a.name) > send_mii.MAX_NAME:
            print(f"warning: {len(a.name)} characters, more than the game allows when naming a Mii")
        if m.pronunciation == m.name: m.pronunciation = a.name   # it said the old name
        m.name = a.name
    if a.pronunciation is not None: m.pronunciation = a.pronunciation
    if a.phrase is not None: m.phrase = a.phrase
    if a.phrase_kind: m.phrase_kind = a.phrase_kind
    if a.gender: m.gender = a.gender
    if a.pronouns: m.pronouns = a.pronouns
    if a.cloth_style: m.cloth_style = a.cloth_style
    if a.loves is not None: m.loves = [] if a.loves == "none" else a.loves.split(",")
    if a.birthday: m.birthday = tuple(int(x) for x in a.birthday.split("-"))
    if a.voice_preset: m.voice_preset = a.voice_preset
    if a.favourite_foods: m.favourite_foods = a.favourite_foods.split(",")
    if a.hated_foods: m.hated_foods = a.hated_foods.split(",")
    if a.face_paint: m.set_face_paint(a.face_paint)
    if a.clothes_from: m.copy_clothes(Mii.load(a.clothes_from))
    for type_ in a.take_off: m.take_off(type_)
    if a.wear:
        import clothes
        catalog = clothes.Catalog(a.romfs)
        for spec in a.wear:
            item, _, colour = spec.partition(":")
            m.wear(item, int(colour or 0), catalog)
    if a.habits is not None: m.set_habits([h for h in a.habits.split(",") if h])
    for habit in a.remove_habit: m.remove_habit(habit)
    for habit in a.add_habit: m.add_habit(habit)
    if not (a.out or a.send): print(m); return
    path = a.out or os.path.join(tempfile.mkdtemp(prefix="mii-"), "payload.bin")
    data = m.save(path, not a.keep_ids)
    print(Mii(data))   # as sent, with its new Mii ID
    print(f"{len(data)} bytes in {path}")
    if a.send: send_mii.send(path, repr(m.name), a.seconds)


if __name__ == "__main__":
    main()
