"""List BL/B call sites targeting an address. Usage: callers.py image.bin target_hex"""
import sys, numpy as np
img = open(sys.argv[1], 'rb').read(); t = int(sys.argv[2], 16)
W = np.frombuffer(img[:len(img) // 4 * 4], dtype='<u4')
for mask, op in ((0xfc000000, 0x94000000), (0xfc000000, 0x14000000)):
    k = np.nonzero((W & mask) == op)[0]
    imm = (W[k] & 0x3ffffff).astype(np.int64); imm = np.where(imm & (1 << 25), imm - (1 << 26), imm)
    for i in np.nonzero(k * 4 + imm * 4 == t)[0]: print(('bl' if op == 0x94000000 else 'b'), hex(int(k[i]) * 4))
