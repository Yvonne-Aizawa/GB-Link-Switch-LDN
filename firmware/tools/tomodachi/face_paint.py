"""Put an image into a Mii payload's face paint.

The face paint item's document holds two zstd blobs, both Tegra block-linear surfaces
(64x8-byte GOBs, 16 GOBs per block): the canvas (25997a82), 256x256 RGBA8 as drawn in
the game, and the ugctex (b0f5c106), the same picture as a 512x512 BC1 texture.
Transparent BC1 blocks are 00000000 ffffffff, as the game writes them.

Usage as a script: uv run --with zstandard --with pillow python -I face_paint.py
       <payload> <image> <out>   (send the result with send_mii.py)
"""
import os, struct, sys
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))


def bl_offset(x, y, width, bpp, block_gobs=16):
    """Byte offset of element (x, y) in a block-linear surface."""
    xb, gobs_x = x * bpp, (width * bpp + 63) // 64
    gob = (y // (8 * block_gobs)) * gobs_x * block_gobs + xb // 64 * block_gobs + y % (8 * block_gobs) // 8
    return gob * 512 + xb % 64 // 32 * 256 + y % 8 // 2 * 64 + xb % 32 // 16 * 32 + y % 2 * 16 + xb % 16


def swizzle(elements, width, height, bpp):
    """Linear rows of elements (bpp bytes each) to a block-linear surface."""
    out = bytearray(len(elements))
    for y in range(height):
        for x in range(width):
            o, i = bl_offset(x, y, width, bpp), (y * width + x) * bpp
            out[o:o + bpp] = elements[i:i + bpp]
    return bytes(out)


def rgb565(c): return (c[0] * 31 + 127) // 255 << 11 | (c[1] * 63 + 127) // 255 << 5 | (c[2] * 31 + 127) // 255


def unpack565(v): return ((v >> 11) * 255 // 31, (v >> 5 & 63) * 255 // 63, (v & 31) * 255 // 31)


def bc1_block(pixels):
    """One BC1 block from 16 RGBA pixels: the two furthest-apart colours as endpoints."""
    opaque = [p[:3] for p in pixels if p[3] >= 128]
    if not opaque: return b"\0\0\0\0\xff\xff\xff\xff"
    dist = lambda a, b: sum((x - y) ** 2 for x, y in zip(a, b))
    a, b = max(((p, q) for p in opaque for q in opaque), key=lambda pq: dist(*pq))
    c0, c1 = rgb565(a), rgb565(b)
    transparent = len(opaque) < 16
    if transparent or c0 == c1:   # three colours and transparent: c0 <= c1
        c0, c1 = min(c0, c1), max(c0, c1)
        e0, e1 = unpack565(c0), unpack565(c1)
        palette = [e0, e1, tuple((x + y) // 2 for x, y in zip(e0, e1))]
    else:                         # four colours: c0 > c1
        c0, c1 = max(c0, c1), min(c0, c1)
        e0, e1 = unpack565(c0), unpack565(c1)
        palette = [e0, e1, tuple((2 * x + y) // 3 for x, y in zip(e0, e1)), tuple((x + 2 * y) // 3 for x, y in zip(e0, e1))]
    indices = 0
    for k, p in enumerate(pixels):
        i = 3 if p[3] < 128 else min(range(len(palette)), key=lambda j: dist(p[:3], palette[j]))
        indices |= i << 2 * k
    return struct.pack("<HHI", c0, c1, indices)


def encode(path):
    """The canvas and ugctex blobs, zstd-compressed, for the image at path."""
    from PIL import Image
    import zstandard
    image = Image.open(path).convert("RGBA")
    canvas = image.resize((256, 256), Image.LANCZOS).tobytes()
    big = image.resize((512, 512), Image.LANCZOS).load()
    blocks = b"".join(bc1_block([big[bx * 4 + k % 4, by * 4 + k // 4] for k in range(16)])
                      for by in range(128) for bx in range(128))
    z = zstandard.ZstdCompressor(level=19)
    return z.compress(swizzle(canvas, 256, 256, 4)), z.compress(swizzle(blocks, 128, 128, 8))


def apply(data, path):
    """The payload with the image as its face paint; it must already have face paint."""
    from mii import Mii
    m = Mii(data)
    m.set_face_paint(path)
    return m.build(new_ids=False)


if __name__ == "__main__":
    if len(sys.argv) != 4: raise SystemExit(__doc__)
    open(sys.argv[3], "wb").write(apply(open(sys.argv[1], "rb").read(), sys.argv[2]))
