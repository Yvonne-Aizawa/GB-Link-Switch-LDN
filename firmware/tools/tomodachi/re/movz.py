"""Find movz wN/xN, #value in the text segment. Usage: movz.py image.bin value_hex [text_end_hex]"""
import sys, numpy as np
img = open(sys.argv[1], 'rb').read(); v = int(sys.argv[2], 16); end = int(sys.argv[3], 16) if len(sys.argv) > 3 else len(img)
W = np.frombuffer(img[:end // 4 * 4], dtype='<u4')
k = np.nonzero(((W & 0x7fe00000) == 0x52800000) & (((W >> 5) & 0xffff) == v))[0]
print(' '.join(hex(int(i) * 4) for i in k))
