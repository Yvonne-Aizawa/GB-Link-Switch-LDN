"""Disassemble a region of a flat image and print lines matching a regex with context.
Usage: near.py image.bin start end regex [context]"""
import re, sys
from capstone import Cs, CS_ARCH_ARM64, CS_MODE_ARM
img = open(sys.argv[1], 'rb').read(); a, b = int(sys.argv[2], 16), int(sys.argv[3], 16)
pat = re.compile(sys.argv[4]); ctx = int(sys.argv[5]) if len(sys.argv) > 5 else 6
md = Cs(CS_ARCH_ARM64, CS_MODE_ARM); md.skipdata = True
ins = [f'{i.address:08x}  {i.mnemonic:8} {i.op_str}' for i in md.disasm(img[a:b], a)]
shown = -1
for k, line in enumerate(ins):
    if pat.search(line):
        lo = max(k - ctx, shown + 1)
        if lo > shown + 1: print('  ...')
        for j in range(lo, min(k + ctx + 1, len(ins))): print(ins[j])
        shown = min(k + ctx, len(ins) - 1)
