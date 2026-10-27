"""Send a ShareMii .ltd Mii to Tomodachi Life: Living the Dream over Local Play.

A .ltd (https://github.com/Star-F0rce/ShareMii) is a Mii exported from the save. It
holds the same 152-byte core data as the network payload, plus the personality, voice,
birthday, name and face paint. The network payload holds more (clothes, traits), so the
.ltd's fields go into a template: a payload the Switch sent before (supply-*.bin). Use
one with face paint for a .ltd with face paint, and one without otherwise. What the
.ltd lacks comes from the template, and so do the voice preset and the pronunciation,
whose network fields are not known yet.

Usage: uv run --with pyserial --with cryptography python -I ltd_to_payload.py
       <mii.ltd> <template> [--name NAME] [--out FILE] [--dry-run] [--seconds N]
"""
import argparse, os, struct, sys, tempfile, uuid
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
# The .ltd's 18 values at offset 160, in order, by their field names in the payload.
# The save's enums are hashes of names; the payload numbers them (assumed in this order).
FIELDS = ["CharacterSociability", "CharacterAudaciousness", "CharacterActiveness", "CharacterCommonsense",
          "CharacterGaiety", "VoiceFormant", "VoiceSpeed", "VoiceIntonation", "VoicePitch", "VoiceTension",
          None, "Gender", "PronounType", "ClothStyle", "BirthYear", "BirthDay", "DirectAge", "BirthMonth"]
ENUMS = {"Gender": ["Male", "Female", "NonBinary"], "ClothStyle": ["Male", "Female", "NonBinary"],
         "PronounType": ["He", "She", "They"]}
ITEM_TYPE, FACE_PAINT = 0x689b60b2, 7      # an item's type; 7 is face paint
CANVAS, UGCTEX = 0x25997a82, 0xb0f5c106    # the face paint's zstd blobs (names unknown)


def read_ltd(data):
    """The .ltd's fields; only version 3 (ShareMii's current one) is read."""
    if data[0] != 3: raise ValueError(f".ltd version {data[0]}: only version 3 is supported")
    if struct.unpack_from("<I", data, 4)[0] != 152: raise ValueError("not a .ltd: no 152-byte Mii core")
    canvas_at, ugc_at = data.find(b"\xa3" * 4, 428), data.rfind(b"\xa4" * 4)
    if canvas_at != 428 or ugc_at < 0: raise ValueError("not a .ltd: no face paint markers")
    utf16 = lambda b: b.decode("utf-16-le").split("\0")[0]
    return {"core": data[8:160], "values": struct.unpack_from("<18i", data, 160),
            "name": utf16(data[232:296]), "pronunciation": utf16(data[296:424]),
            "love": data[424] & 7,  # one bit per gender, as in the payload
            "canvas": data[432:ugc_at] if data[1] else None, "ugctex": data[ugc_at + 4:] if data[2] else None}


def nested(doc, key):
    """The BYAML document stored as binary under key, and a function to store it back."""
    r = byml.Reader(bytes(doc.get(key)))
    return r.root, lambda: doc.set(key, byml.Writer(r.root, version=r.version).build())


def set_number(doc, key, value):
    old = doc.items[key]
    doc.set(key, byml.Value(old.type, value & 0xffffffff if old.type == 0xd3 else value))


def convert(ltd, template, name=None):
    mii = read_ltd(ltd)
    outer = byml.Reader(template)
    inner, store_inner = nested(outer.root, send_mii.MII)
    name = name or mii["name"]
    outer.root.set(send_mii.NAME, name)
    inner.set(H("CallName"), name)
    inner.set(send_mii.CORE, bytes(mii["core"]))

    for field, value in zip(FIELDS, mii["values"]):
        if field is None: continue
        if field in ENUMS:
            names = {H(n): i for i, n in enumerate(ENUMS[field])}
            if value & 0xffffffff not in names:
                print(f"warning: unknown {field} {value & 0xffffffff:#x}, the template's is kept"); continue
            value = names[value & 0xffffffff]
        set_number(inner, H(field), value)
    set_number(inner, H("LoveGender"), mii["love"])

    paints = [k for k, v in inner.items.items() if isinstance(v, (bytes, bytearray))
              and v[:2] == b"YB" and byml.Reader(bytes(v)).root.items.get(ITEM_TYPE, byml.Value(0, 0)).value == FACE_PAINT]
    if bool(paints) != bool(mii["canvas"] or mii["ugctex"]):
        raise ValueError("the template must have face paint exactly when the .ltd does")
    for key in paints:
        item, store_item = nested(inner, key)
        item.set(send_mii.TRANSFER, str(uuid.uuid4()))
        paint, store_paint = nested(item, send_mii.MII)
        if mii["canvas"]: paint.set(CANVAS, bytes(mii["canvas"]))
        if mii["ugctex"]: paint.set(UGCTEX, bytes(mii["ugctex"]))
        store_paint(); store_item()
    store_inner()
    payload = byml.Writer(outer.root, version=outer.version).build()
    return send_mii.prepare(payload)  # a new transfer UUID and Mii ID


def main():
    p = argparse.ArgumentParser(description="Send a ShareMii .ltd Mii to Tomodachi Life over Local Play")
    p.add_argument("ltd", help="a .ltd file exported by ShareMii")
    p.add_argument("template", help="a Mii payload received from a Switch (supply-*.bin)")
    p.add_argument("--name", help="a different displayed name")
    p.add_argument("--out", help="also write the payload sent to this file")
    p.add_argument("--dry-run", action="store_true", help="only build the payload")
    p.add_argument("--seconds", type=float, default=90, help="how long to wait for the Switch")
    a = p.parse_args()

    payload = convert(open(a.ltd, "rb").read(), open(a.template, "rb").read(), a.name)
    shown = byml.Reader(payload).root.get(send_mii.NAME)
    path = a.out or os.path.join(tempfile.mkdtemp(prefix="ltd_to_payload-"), "payload.bin")
    open(path, "wb").write(payload)
    print(f"{shown!r}: {len(payload)} bytes in {path}")
    if not a.dry_run: send_mii.send(path, shown, a.seconds)


if __name__ == "__main__":
    main()
