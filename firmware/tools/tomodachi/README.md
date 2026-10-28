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
- `ltd_to_payload.py <mii.ltd> <template>` sends a Mii exported by
  [ShareMii](https://github.com/Star-F0rce/ShareMii): its face, face paint, name,
  personality, voice and birthday go into a payload the Switch supplied before (one
  with face paint when the `.ltd` has it). Takes the same `--name`, `--out`, `--dry-run`.
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
- **Refusals.** A full island also answers `CLTP REJECT`, about two seconds after the
  supply, so `send_mii.py` cannot tell it from declining. An item whose transfer UUID
  (`ceb3a288`) the island already has gets no answer at all: within a second the Switch
  closes both connections and leaves the room, and the game stays on its receiving
  screen. Face paint is such an item, nested in the Mii document with a UUID of its own,
  so a Mii sent back to its island needs new UUIDs for its face paint as well as for the
  Mii; its Mii ID, name and `IslandName` do not matter.
- **Payload.** A BYAML document (version 7) whose dictionaries are keyed by 32-bit
  hashes. The outer one holds the displayed name (`25efa387`), the transfer's UUID as
  text (`ceb3a288`) and the Mii itself as a nested document (`b77378b7`). In that, the
  152-byte core data (`05f5f62c`) starts with the Mii's ID, a v4 UUID; a new ID makes it
  a new resident. Clothes and personality traits are small documents of their own,
  their names under `25efa387` too. Some hashes appear twice (`71f55538`). String
  tables must stay sorted, or the Switch rejects the payload at once.
- **Field names.** The keys are MurmurHash3 (seed 0) of field names, as in the save:
  `Name` is `25efa387`, and the Mii document has `CallName`, `Gender`, `PronounType`,
  `ClothStyle`, `LoveGender` (a bit per gender), `BirthYear`/`BirthMonth`/`BirthDay`,
  `DirectAge`, `CharacterSociability` and the other four traits, and `VoiceFormant`,
  `VoiceSpeed`, `VoiceIntonation`, `VoicePitch`, `VoiceTension`. Face paint is an item
  of type 7 whose own document holds the zstd canvas (`25997a82`) and ugctex
  (`b0f5c106`), the same files a `.ltd` carries.
- **More names**, from the hash table of
  [ltd-save-editor](https://github.com/alexislours/ltd-save-editor)
  (`scripts/lib/byml-hashes.tsv`). Every item, the Mii included, is a UGC wrapper:
  `Category` (`689b60b2`: 6 a Mii, 7 face paint, 8 and 9 clothes), `UgcBinary`
  (`b77378b7`) and `UgcUuid` (`ceb3a288`). The core data is `CharInfoEx`, laid out in
  the editor's `packages/ltd-savedata/src/struct/defs/charInfoEx.ts`: `createId1` to
  `createId4` (the Mii ID), then a name of 11 UTF-16 characters that reads `no name` in
  received Miis (the game shows the outer `Name`), then the face. The Mii and its face
  paint also carry where they come from: `IslandName`, `PlayerName` and their
  `…RegionLanguageID`s.

`samples/` and `captures/` hold personal data and are not committed.
