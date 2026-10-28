"""Edit a Tomodachi Life Mii payload as a Python object and write it back out.

A payload can't be made from nothing yet: start from one the Switch sent (a template,
supply-*.bin), or from a ShareMii .ltd laid over one. What isn't changed stays as the
template has it (clothes, favourite foods, habits, island and creator).

    m = Mii.load("samples/supply-20261028-112535-1.bin")
    m.name, m.pronunciation = "Miku", "mee koo"
    m.gender, m.pronouns, m.voice_preset = "Female", "She", "RobotL"
    m.birthday = (2007, 8, 31)
    m.personality["gaiety"] = 8
    m.set_face_paint("face.png")          # needs zstandard and pillow
    m.save("miku.bin")                    # new transfer UUIDs and Mii ID

Fields without a property are reached by name or hash: m["TasteType"], m[0x3cc01748].

Usage as a script: uv run --with pyserial --with cryptography python -I mii.py
       <template> [--ltd FILE] [--name ...] [--pronunciation ...] [--gender ...]
       [--pronouns ...] [--cloth-style ...] [--loves ...] [--birthday Y-M-D]
       [--voice-preset ...] [--face-paint IMAGE] [--out FILE] [--send] [--seconds N]
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
                         "BigCharacter", "SmallCharacter", "RobotL", "RobotS"]}
FIRST = {"VoicePreset": -3}
KEYS = {"VoicePreset": 0xa90584fa}         # fields whose names are not known
PERSONALITY = ["Sociability", "Audaciousness", "Activeness", "Commonsense", "Gaiety"]
VOICE = ["Formant", "Speed", "Intonation", "Pitch", "Tension"]
# The .ltd's 18 values at offset 160, in order, by their field names in the payload.
LTD_FIELDS = [f"Character{p}" for p in PERSONALITY] + [f"Voice{v}" for v in VOICE] + \
             ["VoicePreset", "Gender", "PronounType", "ClothStyle", "BirthYear", "BirthDay", "DirectAge", "BirthMonth"]
CATEGORY, FACE_PAINT = 0x689b60b2, 7       # an item's category; 7 is face paint
ITEM_ID = 0x2155012a                       # an item's ID, a hash of its internal name
CANVAS, UGCTEX = 0x25997a82, 0xb0f5c106    # the face paint's zstd files (names unknown)


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
    del _enum

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
        lines = [f"{self.name!r} (says {self.pronunciation!r}), Mii ID {self.core[:16].hex()}",
                 f"  {self.gender}, {self.pronouns}, clothes {self.cloth_style}, dates {', '.join(sorted(self.loves)) or 'nobody'}",
                 f"  born {born}, voice {self.voice_preset} {dict(self.voice)}",
                 f"  personality {dict(self.personality)}",
                 f"  from {self['PlayerName']!r} on {self['IslandName']!r}"]
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
    p.add_argument("--name"); p.add_argument("--pronunciation")
    p.add_argument("--gender", choices=GENDERS); p.add_argument("--pronouns", choices=ENUMS["PronounType"])
    p.add_argument("--cloth-style", choices=GENDERS)
    p.add_argument("--loves", help="comma-separated genders the Mii dates, or none")
    p.add_argument("--birthday", metavar="Y-M-D")
    p.add_argument("--voice-preset", choices=ENUMS["VoicePreset"][2:])
    p.add_argument("--face-paint", metavar="IMAGE", help="needs --with zstandard --with pillow")
    p.add_argument("--keep-ids", action="store_true", help="keep the Mii ID and transfer UUIDs")
    p.add_argument("--out", help="write the payload to this file")
    p.add_argument("--send", action="store_true", help="send it to the Switch")
    p.add_argument("--seconds", type=float, default=90, help="how long to wait for the Switch")
    a = p.parse_args()

    m = Mii.from_ltd(a.ltd, a.template) if a.ltd else Mii.load(a.template)
    if a.name is not None:
        if not a.name or len(a.name) > send_mii.MAX_NAME:
            print(f"warning: {len(a.name)} characters, more than the game allows when naming a Mii")
        if m.pronunciation == m.name: m.pronunciation = a.name   # it said the old name
        m.name = a.name
    if a.pronunciation is not None: m.pronunciation = a.pronunciation
    if a.gender: m.gender = a.gender
    if a.pronouns: m.pronouns = a.pronouns
    if a.cloth_style: m.cloth_style = a.cloth_style
    if a.loves is not None: m.loves = [] if a.loves == "none" else a.loves.split(",")
    if a.birthday: m.birthday = tuple(int(x) for x in a.birthday.split("-"))
    if a.voice_preset: m.voice_preset = a.voice_preset
    if a.face_paint: m.set_face_paint(a.face_paint)
    if not (a.out or a.send): print(m); return
    path = a.out or os.path.join(tempfile.mkdtemp(prefix="mii-"), "payload.bin")
    data = m.save(path, not a.keep_ids)
    print(Mii(data))   # as sent, with its new Mii ID
    print(f"{len(data)} bytes in {path}")
    if a.send: send_mii.send(path, repr(m.name), a.seconds)


if __name__ == "__main__":
    main()
