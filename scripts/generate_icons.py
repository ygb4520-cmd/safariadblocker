#!/usr/bin/env python3
"""Generate simple placeholder toolbar icons (no-entry blocking symbol) as
PNG files, using only the Python standard library (no PIL/ImageMagick
required). Produces icons/icon-<size>.png for each requested size.
"""
import os
import struct
import zlib

OUT_DIR = os.path.normpath(os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "ExtensionSource", "icons"))
SIZES = [16, 32, 48, 128]

BLUE = (0, 122, 255, 255)
WHITE = (255, 255, 255, 255)
TRANSPARENT = (0, 0, 0, 0)


def make_pixels(size):
    cx = cy = size / 2
    r = size * 0.46
    bar_half_width = max(1.0, size * 0.09)
    pixels = [[TRANSPARENT] * size for _ in range(size)]
    for y in range(size):
        for x in range(size):
            dx, dy = x + 0.5 - cx, y + 0.5 - cy
            dist = (dx * dx + dy * dy) ** 0.5
            if dist > r:
                continue
            # diagonal "no entry" bar from top-left to bottom-right
            # distance from point to the line y = x (rotated coords), offset to canvas center
            diag_dist = abs(dx - dy) / (2 ** 0.5)
            ring = dist > r - max(1.5, size * 0.09)
            if diag_dist <= bar_half_width:
                pixels[y][x] = WHITE
            elif ring:
                pixels[y][x] = WHITE
            else:
                pixels[y][x] = BLUE
    return pixels


def write_png(pixels, size, path):
    def chunk(tag, data):
        return (
            struct.pack("!I", len(data))
            + tag
            + data
            + struct.pack("!I", zlib.crc32(tag + data) & 0xFFFFFFFF)
        )

    raw = bytearray()
    for row in pixels:
        raw.append(0)  # filter type: none
        for (r, g, b, a) in row:
            raw += bytes((r, g, b, a))

    sig = b"\x89PNG\r\n\x1a\n"
    ihdr = struct.pack("!IIBBBBB", size, size, 8, 6, 0, 0, 0)
    idat = zlib.compress(bytes(raw), 9)

    with open(path, "wb") as f:
        f.write(sig)
        f.write(chunk(b"IHDR", ihdr))
        f.write(chunk(b"IDAT", idat))
        f.write(chunk(b"IEND", b""))


def main():
    os.makedirs(OUT_DIR, exist_ok=True)
    for size in SIZES:
        pixels = make_pixels(size)
        path = os.path.join(OUT_DIR, f"icon-{size}.png")
        write_png(pixels, size, path)
        print(f"wrote {path}")


if __name__ == "__main__":
    main()
