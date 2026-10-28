"""Send a Mii to Tomodachi Life: Living the Dream on a Switch, through the ESP32 board.

Takes a Mii payload the Switch sent before (ldn_capture.py with BEACON=1 saves them as
supply-*.bin), optionally renames it, gives it a new Mii ID so the game takes it as a
new resident, and supplies it once the Switch has connected. On the Switch, open Local
Play and press "Look for another player" first, then accept the Mii.

Usage: uv run --with pyserial --with cryptography python -I send_mii.py <payload>
       [--name NAME] [--keep-id] [--out FILE] [--dry-run] [--seconds N]
"""
import argparse, os, sys, tempfile, uuid
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import byml

NAME = 0x25efa387          # the displayed name, in the outer document
TRANSFER = 0xceb3a288      # the transfer's UUID, as text
MII = 0xb77378b7           # the inner document with the Mii's fields
CORE = 0x05f5f62c          # in the inner document: the Mii's core data, its ID first
MAX_NAME = 13              # the game's own limit when renaming; it shows and accepts 30, longer only warns


def prepare(data, name=None, new_id=True):
    """The payload with new transfer UUIDs, and optionally a new name and Mii ID."""
    outer = byml.Reader(data)
    root = outer.root
    root.set(TRANSFER, str(uuid.uuid4()))
    if name is not None:
        if not name or len(name) > MAX_NAME:
            print(f"warning: {len(name)} characters, more than the game allows when naming a Mii")
        root.set(NAME, name)
    inner = byml.Reader(root.get(MII))
    # Items with a transfer UUID of their own (face paint) need a new one too: one the
    # island already has makes the Switch hang up without an answer.
    for key, value in list(inner.root.items.items()):
        if not isinstance(value, (bytes, bytearray)) or value[:2] != b"YB": continue
        item = byml.Reader(bytes(value))
        if TRANSFER not in item.root.items: continue
        item.root.set(TRANSFER, str(uuid.uuid4()))
        inner.root.set(key, byml.Writer(item.root, version=item.version).build())
    if new_id:
        core = bytearray(inner.root.get(CORE))
        core[:16] = uuid.uuid4().bytes
        inner.root.set(CORE, bytes(core))
    root.set(MII, byml.Writer(inner.root, inner.strings, inner.version).build())
    # Only the strings still in use: the old name and UUID drop out.
    return byml.Writer(root, version=outer.version).build()


def send(path, shown, seconds):
    """Supply the payload at path once the Switch has connected; exits with its answer."""
    import ldn_capture
    os.environ["BEACON"], os.environ["SEND"] = "1", path
    sys.argv = [sys.argv[0], str(seconds)]
    ldn_capture.main()
    answer = ldn_capture.result
    print({"ACCEPT": f"The Switch accepted {shown}.", "REJECT": "The Switch declined it, or refused the payload.",
           "CANCEL": "The exchange was cancelled."}.get(answer, "No answer from the Switch."))
    sys.exit(0 if answer == "ACCEPT" else 1)


def main():
    p = argparse.ArgumentParser(description="Send a Mii to Tomodachi Life over Local Play")
    p.add_argument("payload", help="a Mii payload received from a Switch (supply-*.bin)")
    p.add_argument("--name", help="new displayed name")
    p.add_argument("--keep-id", action="store_true", help="keep the Mii ID (the game sees a duplicate)")
    p.add_argument("--out", help="also write the payload sent to this file")
    p.add_argument("--dry-run", action="store_true", help="only build the payload")
    p.add_argument("--seconds", type=float, default=90, help="how long to wait for the Switch")
    a = p.parse_args()

    payload = prepare(open(a.payload, "rb").read(), a.name, not a.keep_id)
    shown = byml.Reader(payload).root.get(NAME)
    path = a.out or os.path.join(tempfile.mkdtemp(prefix="send_mii-"), "payload.bin")
    open(path, "wb").write(payload)
    print(f"{shown!r}: {len(payload)} bytes in {path}")
    if a.dry_run: return
    send(path, shown, a.seconds)


if __name__ == "__main__":
    main()
