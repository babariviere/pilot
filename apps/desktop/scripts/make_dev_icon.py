#!/usr/bin/env python3
"""Deterministic Next development mark. No Swift asset, font, image service or app discovery."""
from pathlib import Path
import struct
import sys
import zlib

BAYER = ((0, 8, 2, 10), (12, 4, 14, 6), (3, 11, 1, 9), (15, 7, 13, 5))


def png(size):
    def chunk(kind, data):
        return struct.pack(">I", len(data)) + kind + data + struct.pack(">I", zlib.crc32(kind + data))
    rows = bytearray()
    for y in range(size):
        rows.append(0)
        for x in range(size):
            u, v = (x + 0.5) / size, (y + 0.5) / size
            edge = max(abs(u - 0.5) - 0.29, 0)**2 + max(abs(v - 0.5) - 0.29, 0)**2
            color = (246, 247, 249, 255) if edge < 0.18**2 else (0, 0, 0, 0)
            if color[3] and BAYER[y % 4][x % 4] < max(0, (u + v - 1.05) * 16):
                color = (177, 190, 216, 255)
            if 0.29 < v < 0.71 and (0.29 < u < 0.37 or 0.63 < u < 0.71 or abs(u - (0.33 + (v - 0.29) * 0.81)) < 0.04):
                color = (48, 53, 64, 255)
            rows.extend(color)
    return b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", struct.pack(">IIBBBBB", size, size, 8, 6, 0, 0, 0)) + chunk(b"IDAT", zlib.compress(rows, 9)) + chunk(b"IEND", b"")


def icon():
    entries = []
    for kind, size in ((b"ic07", 128), (b"ic08", 256), (b"ic09", 512)):
        data = png(size)
        entries.append(kind + struct.pack(">I", len(data) + 8) + data)
    data = b"".join(entries)
    return b"icns" + struct.pack(">I", len(data) + 8) + data


if __name__ == "__main__":
    if len(sys.argv) != 2:
        raise SystemExit("Use make_dev_icon.py FRESH_OUTPUT.icns")
    with Path(sys.argv[1]).open("xb") as stream:
        stream.write(icon())
