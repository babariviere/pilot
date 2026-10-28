"""Regenerate the shared, wholly synthetic 1040×420 PNG using stdlib only."""
import struct
import zlib
from pathlib import Path

w, h = 1040, 420
rows = []
for y in range(h):
    row = bytearray()
    for x in range(w):
        color = (241, 244, 248)
        if 290 - x * 0.15 + 25 * ((x // 130) % 2) < y:
            color = (199, 218, 238)
        if 350 - x * 0.08 + 20 * ((x // 170) % 2) < y:
            color = (125, 185, 232)
        if 390 - x * 0.06 + 12 * ((x // 210) % 2) < y:
            color = (47, 111, 198)
        row.extend((*color, 255))
    rows.append(b"\0" + row)

def chunk(kind, data):
    return struct.pack(">I", len(data)) + kind + data + struct.pack(">I", zlib.crc32(kind + data))

Path(__file__).with_name("fixture.png").write_bytes(
    b"\x89PNG\r\n\x1a\n"
    + chunk(b"IHDR", struct.pack(">IIBBBBB", w, h, 8, 6, 0, 0, 0))
    + chunk(b"IDAT", zlib.compress(b"".join(rows)))
    + chunk(b"IEND", b"")
)
