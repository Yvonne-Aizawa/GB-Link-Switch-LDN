"""Find calls to imported functions in a flat NSO image and disassemble before each.
Usage: ldn_calls.py image.bin [instructions_before] [symbol_prefix ...]"""
import struct, sys
import numpy as np
from capstone import Cs, CS_ARCH_ARM64, CS_MODE_ARM
img = open(sys.argv[1], 'rb').read(); before = int(sys.argv[2]) if len(sys.argv) > 2 else 60
u32 = lambda o: struct.unpack_from('<I', img, o)[0]; u64 = lambda o: struct.unpack_from('<Q', img, o)[0]
mod0 = u32(4); assert img[mod0:mod0 + 4] == b'MOD0'
dyn = mod0 + struct.unpack_from('<i', img, mod0 + 4)[0]
tags = {}
o = dyn
while True:
    t, v = u64(o), u64(o + 8); o += 16
    if t == 0: break
    tags.setdefault(t, v)
strtab, symtab = tags[5], tags[6]
def name(i):
    start = strtab + struct.unpack_from('<I', img, symtab + 24 * i)[0]
    return img[start:img.find(b'\0', start)].decode()
got = {}
for start, size in ((tags.get(23), tags.get(2)), (tags.get(7), tags.get(8))):
    if not start: continue
    for r in range(start, start + size, 24):
        off, info = u64(r), u64(r + 8)
        if info & 0xffffffff in (1025, 1026): got[off] = name(info >> 32)
prefixes = tuple(sys.argv[3:]) or ('_ZN2nn3ldn13CreateNetwork', '_ZN2nn3ldn7Connect')
targets = {a: n for a, n in got.items() if n.startswith(prefixes)}
print('GOT slots:', {hex(a): n for a, n in targets.items()})
W = np.frombuffer(img[:len(img) // 4 * 4], dtype='<u4'); idx = np.arange(len(W), dtype=np.int64)
# PLT stubs: adrp x16, page ; ldr x17, [x16, #off] ; add x16, x16, #off ; br x17
cand = np.nonzero(((W[:-3] & 0x9f00001f) == 0x90000010) & ((W[1:-2] & 0xffc003ff) == 0xf9400211) & (W[3:] == 0xd61f0220))[0]
stubs = {}
for k in cand:
    w, w2 = int(W[k]), int(W[k + 1]); o = int(k) * 4
    imm = ((w >> 29) & 3) | (((w >> 5) & 0x7ffff) << 2)
    if imm & (1 << 20): imm -= 1 << 21
    slot = ((o & ~0xfff) + (imm << 12)) + ((w2 >> 10) & 0xfff) * 8
    if slot in targets: stubs[o] = targets[slot]
print('stubs:', {hex(a): n for a, n in stubs.items()}, flush=True)
bl = np.nonzero((W & 0xfc000000) == 0x94000000)[0]
imm = (W[bl] & 0x3ffffff).astype(np.int64); imm = np.where(imm & (1 << 25), imm - (1 << 26), imm)
dest = bl * 4 + imm * 4
hits = [(int(bl[i]) * 4, int(dest[i])) for i in np.nonzero(np.isin(dest, list(stubs)))[0]]
md = Cs(CS_ARCH_ARM64, CS_MODE_ARM)
for o, t in hits:
    print(f'\n==== call at {o:#x} -> {stubs[t][:40]}')
    s = max(0, o - before * 4)
    for i in md.disasm(img[s:o + 8], s): print(f'  {i.address:08x}  {i.mnemonic:8} {i.op_str}')
