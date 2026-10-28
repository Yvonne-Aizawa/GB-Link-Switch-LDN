"""Send a ShareMii .ltd Mii to Tomodachi Life: Living the Dream over Local Play.

A .ltd (https://github.com/Star-F0rce/ShareMii) is a Mii exported from the save. It
holds the same 152-byte core data as the network payload, plus the personality, voice,
birthday, name, pronunciation and face paint. The network payload holds more (clothes,
foods, habits), so the .ltd's fields go into a template: a payload the Switch sent
before (supply-*.bin). Use one with face paint for a .ltd with face paint, and one
without otherwise. The work is done by mii.Mii.apply_ltd; this is its command line.

Usage: uv run --with pyserial --with cryptography python -I ltd_to_payload.py
       <mii.ltd> <template> [--name NAME] [--out FILE] [--dry-run] [--seconds N]
"""
import argparse, os, sys, tempfile
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import send_mii
from mii import Mii, murmur3   # murmur3 stays importable from here


def convert(ltd, template, name=None):
    """The payload for a .ltd laid over a template (both bytes), with new IDs."""
    m = Mii.from_ltd(ltd, template)
    if name: m.name = name
    return m.build()


def main():
    p = argparse.ArgumentParser(description="Send a ShareMii .ltd Mii to Tomodachi Life over Local Play")
    p.add_argument("ltd", help="a .ltd file exported by ShareMii")
    p.add_argument("template", help="a Mii payload received from a Switch (supply-*.bin)")
    p.add_argument("--name", help="a different displayed name")
    p.add_argument("--out", help="also write the payload sent to this file")
    p.add_argument("--dry-run", action="store_true", help="only build the payload")
    p.add_argument("--seconds", type=float, default=90, help="how long to wait for the Switch")
    a = p.parse_args()

    m = Mii.from_ltd(a.ltd, a.template)
    if a.name: m.name = a.name
    path = a.out or os.path.join(tempfile.mkdtemp(prefix="ltd_to_payload-"), "payload.bin")
    payload = m.save(path)
    print(f"{m.name!r}: {len(payload)} bytes in {path}")
    if not a.dry_run: send_mii.send(path, repr(m.name), a.seconds)


if __name__ == "__main__":
    main()
