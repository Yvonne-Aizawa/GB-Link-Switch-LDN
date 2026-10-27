"""Unpack an NSO into a flat image (segments at their memory offsets). Usage: nso_unpack.py in.nso out.bin"""
import struct, sys, lz4.block
d = open(sys.argv[1], 'rb').read()
flags = struct.unpack_from('<I', d, 0xC)[0]
segs = [struct.unpack_from('<III', d, 0x10 + i * 0x10) for i in range(3)]
csizes = struct.unpack_from('<III', d, 0x60)
end = segs[2][1] + segs[2][2] + struct.unpack_from('<I', d, 0x3C)[0]   # data + bss
img = bytearray(end)
for i, ((off, mem, size), csize) in enumerate(zip(segs, csizes)):
    raw = d[off:off + csize]
    img[mem:mem + size] = lz4.block.decompress(raw, uncompressed_size=size) if flags >> i & 1 else raw
open(sys.argv[2], 'wb').write(img)
print(sys.argv[2], len(img), 'segments', [(hex(m), hex(s)) for _, m, s in segs])
