"""Print strings and wide constants referenced inside a code range (adrp+add/ldr, movz/movk chains).
Usage: strrefs.py image.bin start_hex end_hex"""
import sys, re
from capstone import Cs, CS_ARCH_ARM64, CS_MODE_ARM
img = open(sys.argv[1], 'rb').read(); a, b = int(sys.argv[2], 16), int(sys.argv[3], 16)
md = Cs(CS_ARCH_ARM64, CS_MODE_ARM); md.skipdata = True
pages = {}; seen = set()
for i in md.disasm(img[a:b], a):
    ops = i.op_str
    if i.mnemonic == 'adrp':
        r, v = ops.split(', #'); pages[r] = int(v, 16)
    elif i.mnemonic == 'add' and re.match(r'(x\d+), (x\d+), #(0x[0-9a-f]+)$', ops):
        d, s, v = re.match(r'(x\d+), (x\d+), #(0x[0-9a-f]+)$', ops).groups()
        if s in pages:
            addr = pages[s] + int(v, 16)
            if addr < len(img):
                t = img[addr:addr + 80].split(b'\0')[0]
                if len(t) >= 4 and all(32 <= c < 127 for c in t) and addr not in seen:
                    seen.add(addr); print(f'{i.address:08x} str {t.decode()!r}')
    elif i.mnemonic in ('mov', 'movk') and re.search(r'#0x[0-9a-f]{4,}', ops) and i.mnemonic == 'movk':
        print(f'{i.address:08x} {i.mnemonic} {ops}')
