"""Disassemble a range and annotate socket calls. Usage: ann.py image.bin start end"""
import re, sys
from capstone import Cs, CS_ARCH_ARM64, CS_MODE_ARM
import os; S = os.environ.get('NSO_DIR', os.path.dirname(os.path.abspath(__file__)) + '/../nso/')
calls = {}
for l in open(S + 'socket-1.0.4.txt'):
    m = re.match(r'==== call at (0x[0-9a-f]+) -> _ZN2nn6socket\d+(\w+)', l)
    if m: calls[int(m.group(1), 16)] = m.group(2)[:10]
img = open(sys.argv[1], 'rb').read(); a, b = int(sys.argv[2], 16), int(sys.argv[3], 16)
md = Cs(CS_ARCH_ARM64, CS_MODE_ARM); md.skipdata = True
for i in md.disasm(img[a:b], a):
    print(f'{i.address:08x}  {i.mnemonic:8} {i.op_str}' + (f'   ; {calls[i.address]}' if i.address in calls else ''))
