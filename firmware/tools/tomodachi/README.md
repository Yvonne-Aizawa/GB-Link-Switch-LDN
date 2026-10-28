# Tomodachi Life: Living the Dream over LDN

Tools for sending Miis to Tomodachi Life: Living the Dream on an unmodified Switch,
with the ESP32 board standing in as the other player in Local Play. They need the
bridge firmware with `LDN_TAP` and `LDN_ETH` (see `docs/SERIAL_PROTOCOL.md`), pyserial,
cryptography and `~/.switch/prod.keys`.

On the Switch, open Local Play and press *Look for another player*: that hosts the
room, which the board joins.

- `mii.py <template>` edits a Mii as a Python object (`Mii` class) and writes or sends
  it: name, pronunciation, gender, pronouns, clothing style, who they date, birthday,
  voice preset, personality and voice numbers, face paint, or any field by name
  (`m["TasteType"]`). `--ltd FILE` lays a ShareMii `.ltd` over the template first. On
  the command line, `--name`, `--pronunciation`, `--gender`, `--pronouns`,
  `--cloth-style`, `--loves`, `--birthday`, `--age` (Adult, Child or years), `--tucked-in`, `--voice-preset`, `--face-paint` and `--face-paint-front` set
  those; without `--out` or `--send` it only prints the Mii. `--wear ITEM[:COLOUR]` puts
  on a piece or a whole outfit by its ID, `--take-off TYPE` takes a piece off, and
  `--clothes-from FILE` copies another Mii's clothes, and `--phrase` sets the Mii's phrase (`--phrase-kind` when it is said: TalkStart,
  TalkEnd, Phrase, TalkInSleep, ...). `--favourite-foods A,B` and `--hated-foods A,B` set
  the two all-time favourite and two hated foods by English name or ID. `--habits A,B,...`
  replaces the habits (in slot order), `--add-habit` adds one in place of any of its
  kind (a Mii has one greeting, one walk, ...), `--remove-habit` takes one away.
- `clothes.py <text>` searches the game's 1087 pieces and 347 outfits by ID or English
  name. It, `foods.py`, `habits.py` and the clothes, food and habit options read
  `tables.json`: the game's pieces, outfits, foods and habits with their English names.
  `tables.py --romfs DIR` (with `--with zstandard`) regenerates it from a romfs dump;
  without `tables.json` the tools read the romfs (`--romfs DIR` or `$TOMODACHI_ROMFS`).
- `foods.py <text>` and `habits.py <text>` search the game's foods and habits the same
  way, for the food and habit options.
- `send_mii.py <payload> [--name NAME]` sends a Mii the Switch supplied before, with
  a new Mii ID (so the game takes it as a new resident) and optionally a new name, and
  reports whether the Switch accepted it. `--dry-run --out FILE` only builds it. Other
  items the Switch supplied, such as custom food, go the same way with a new transfer
  UUID. `--face-paint IMAGE` replaces a Mii's face paint with an image (the payload must
  have face paint already; add `--with zstandard --with pillow`).
- `ltd_to_payload.py <mii.ltd> <template>` sends a Mii exported by
  [ShareMii](https://github.com/Star-F0rce/ShareMii): its face, face paint, name,
  pronunciation, personality, voice and birthday go into a payload the Switch supplied
  before (one with face paint when the `.ltd` has it). Takes the same `--name`, `--out`,
  `--dry-run`. It is `mii.py --ltd` with fewer options.
- `face_paint.py <payload> <image> <out>` does only the face paint part of that.
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
  `Name` is `25efa387`, and the Mii document has `CallName` (the pronunciation),
  `Gender`, `PronounType`, `ClothStyle`, `LoveGender` (a bit per gender), `BirthYear`/`BirthMonth`/`BirthDay`,
  `DirectAge`, `CharacterSociability` and the other four traits, and `VoiceFormant`,
  `VoiceSpeed`, `VoiceIntonation`, `VoicePitch`, `VoiceTension`. Face paint is an item
  of type 7 whose own document holds the zstd canvas (`25997a82`, 256x256 RGBA8) and
  ugctex (`b0f5c106`, 512x512 BC1), the same files a `.ltd` carries. Both are Tegra
  block-linear surfaces with 16-GOB blocks.
- **Clothes.** Each piece worn is an item of `Category` 9, and a whole outfit adds one
  of `Category` 8; habits are items of `Category` 16. An item holds the MurmurHash3 of
  its ID (`2155012a`, `ClothHeadwearHatWitch` or `Coordinate0091`), its display name
  and its `ColorIndex`. The twelve item slot keys seen are a list, not one per type:
  clothes, the outfit, the face paint and habits share them (a Mii with a four-piece
  outfit and seven habits used all twelve). The game
  numbers the items in the order their data is stored, and fields point at the one of
  each kind by that number (-1 for none): Tops `09862234`, Topslong `4f5d6ba9`,
  BottomsA `be30923f`, BottomsB (socks) `3dc2dbcd`, Shoes `d6d4ea8f`, Headwear
  `8ab92078`, Accessory `012523d9`, All (costume) `fcfe477c`, the outfit `41b5252b`, face paint `ba906068`, and seven habit slots, filled in the order `0433c2eb`, `63d7d8b3`, `ac690f5c`, `8138aa2d`, `6677d657`, `ca2cf8c7`, `e153d8ce`, each with a field that is 1 once the slot is used (`502a5d7d`, `49dbacc0`, `f6e0191f`, `02d2f68c`, `edcf1f80`, `5287f5cc`, `7d49dca1`, absent before);
  `7bf9decb` counts the items. Fields that point at the wrong items make the game show
  "A communication error has occurred" after "Someone sent you a Mii!" and hang up. An
  outfit's pieces are stored All first and Accessory before Headwear. Changing one piece
  in the game drops the outfit item and reuses its slot.
  When a Mii's clothes came from someone else, the Switch sends it in starter clothes and
  sets the outer `4dfe38dc` to -3 (0 otherwise; the same field is 0 in every item).
- **Age.** With a birth year, `AgeType` and `DirectAge` are -1. Without one, the age is
  `DirectAge` (years) or else `AgeType`: the save's Invalid, Adult, Child numbered from -1
  (a child is 1). A .ltd has no `AgeType`.
- **Face paint in front.** `IsFacePaintFront` 1 draws the face paint over the eyes,
  eyebrows and mouth; 0 (all captures) under them. The nose is in front either way.
- **Tucked-in top.** `7de5dfb0` (the save's `IsTopsIn`) is 1 when the top is tucked in.
- **Phrase.** Four fields that exist only once a Mii has a phrase: the text
  (`c3f3d6a6`), an empty string (`87c1aff6`, likely its pronunciation), its language
  (`51110d81`, 5 like the other language fields) and `e5da2956`, when it is said: the
  save's WordKind numbered from TalkStart (TalkStart 0, TalkEnd 1, Phrase 2, TalkInSleep 7;
  confirmed on received Miis). Removing face paint
  in the game drops its item and sets `ba906068` to -1.
- **Foods.** Four fields hold the MurmurHash3 of a food's `RSDB/FoodParam` Name (`Tofu`,
  `Crab`): all-time favourites `3cc01748` then `79612bf3`, hated foods `a95867bb` then
  `85d70c73`, in the order the game lists them (confirmed by feeding). The foods a Mii
  has been seen to enjoy aren't sent.
- **Voice preset.** `a90584fa` numbers the save's presets from Boy: Custom is -1,
  Robot L (top row, fifth) is 8.
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
- **Custom items** travel in the same wrapper. Food is `Category` 12; its document has
  `Price`, `BaseScale`, `Temperature`, `AttrTaste`, `AttrType`, the `Emission…` fields,
  `TextureSourceType`, `IslandName` and `PlayerName`, and three zstd files: the
  drawing (`04fff1c1`, 256×256 RGBA in the GPU's block-linear layout, 16 GOBs per block),
  a 64 KB one (`784e7ede`, likely the ugctex) and a 96 KB one (`afa60833`). Sent back to
  its own island with a new transfer UUID, food is accepted and shown as received from
  another owner, as the game seems to mark every item that arrives over Local Play.
  Clothing is `Category` 9 (as are a Mii's own clothes), with `ClothType`,
  `ClothGender`, `ClothSeasonType`, `UgcClothGenreType`, `BaseColor` and `Price`, and
  three zstd files: the drawing (`4b1686c3`, the same 256×256 layout), a 128 KB one
  (`8d018ba1`) and a 64 KB one (`8e3888dd`). It goes back to its island the same way.
  Binary values sit back to back, unaligned; the next container aligns to 4 bytes.

`samples/` and `captures/` hold personal data and are not committed.
