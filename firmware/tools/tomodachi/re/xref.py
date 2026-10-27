"""Find adrp+add/ldr pairs that form an address. Usage: xref.py image.bin text_end_hex addr_hex [addr_hex ...]"""
import sys, numpy as np
img = open(sys.argv[1], 'rb').read(); end = int(sys.argv[2], 16); want = [int(a, 16) for a in sys.argv[3:]]
W = np.frombuffer(img[:end // 4 * 4], dtype='<u4').astype(np.int64)
adrp = np.nonzero((W & 0x9f000000) == 0x90000000)[0]
imm = ((W[adrp] >> 29) & 3) | (((W[adrp] >> 5) & 0x7ffff) << 2)
imm = np.where(imm & (1 << 20), imm - (1 << 21), imm)
page = (adrp * 4 & ~0xfff) + (imm << 12); rd = W[adrp] & 31
for a in want:
    hit = np.nonzero(page == (a & ~0xfff))[0]
    for h in hit:
        k = int(adrp[h])
        for j in range(k + 1, min(k + 8, len(W))):
            w = int(W[j])
            if (w & 0xffc00000) == 0x91000000 and (w >> 5) & 31 == rd[h] and (w >> 10) & 0xfff == a & 0xfff:
                print(hex(a), 'at', hex(k * 4)); break
