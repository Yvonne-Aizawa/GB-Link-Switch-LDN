# Tomodachi Life: Living the Dream over LDN

Tools for sending Miis to Tomodachi Life: Living the Dream on an unmodified Switch,
with the ESP32 board standing in as the other player in Local Play. They need the
bridge firmware with `LDN_TAP` and `LDN_ETH` (see `docs/SERIAL_PROTOCOL.md`), pyserial,
cryptography and `~/.switch/prod.keys`.

On the Switch, open Local Play and press *Look for another player*: that hosts the
room, which the board joins.

- `send_mii.py <payload> [--name NAME]` sends a Mii the Switch supplied before, with
  a new Mii ID (so the game takes it as a new resident) and optionally a new name, and
  reports whether the Switch accepted it. `--dry-run --out FILE` only builds it.
- `byml.py <file>` dumps a payload's BYAML tree; it reads and rewrites the documents
  byte for byte.
- `ldn_scan.py [seconds]` lists the LDN rooms around and decrypts what they advertise.
- `ldn_capture.py [seconds]` joins the room and logs everything the Switch sends, to a
  pcap and a text log. `BEACON=1` answers the game's handshake and accepts what the
  Switch supplies (saved as `supply-*.bin`); `SEND=<file>` also supplies that payload
  to the Switch. `CLTP_REPLY=REJECT|NONE` changes the answer to a supply.
- `re/` holds the small disassembly helpers used to read the game's code
  (`nso_unpack.py` turns an NSO into a flat image for the others).

Run them with `uv run --with pyserial --with cryptography python -I <script>`.

## The protocol (version 1.0.4)

- **Room.** Communication ID `010051f0207b2000`, LDN passphrase
  `ABCDEFGHIJKLMNOPQRSTUVWXYZ` (26 bytes), protocol 1 advertisement, two players.
- **Handshake.** Each side sends the other a 4-byte version (5) to UDP port 5001 until
  connected. The side that hears it connects to the other's TCP port 5002; the game is
  connected only once both directions are.
- **CLTP.** NUL-terminated text messages over TCP: `CLTP SUPPLY 0x<len>` followed by
  `<len>` bytes, answered with `CLTP ACCEPT` or `CLTP REJECT` (also what declining in
  the game sends), or `CLTP CANCEL`.
- **Payload.** A BYAML document (version 7) whose dictionaries are keyed by 32-bit
  hashes. The outer one holds the displayed name (`25efa387`), the transfer's UUID as
  text (`ceb3a288`) and the Mii itself as a nested document (`b77378b7`). In that, the
  152-byte core data (`05f5f62c`) starts with the Mii's ID, a v4 UUID; a new ID makes it
  a new resident. Clothes and personality traits are small documents of their own,
  their names under `25efa387` too. Some hashes appear twice (`71f55538`). String
  tables must stay sorted, or the Switch rejects the payload at once.

`samples/` and `captures/` hold personal data and are not committed.
