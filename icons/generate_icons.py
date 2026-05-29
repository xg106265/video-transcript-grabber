#!/usr/bin/env python3
"""生成插件图标：红色圆角方块 + 白色下载箭头。仅用标准库。"""
import struct, zlib, os

RED = (232, 52, 42)
WHITE = (255, 255, 255)


def inside_round_rect(x, y, size, radius):
    r = radius
    for cx, cy in ((r, r), (size - r, r), (r, size - r), (size - r, size - r)):
        in_corner_x = (x < r and cx == r) or (x > size - r and cx == size - r)
        in_corner_y = (y < r and cy == r) or (y > size - r and cy == size - r)
        if in_corner_x and in_corner_y:
            if (x - cx) ** 2 + (y - cy) ** 2 > r * r:
                return False
    return True


def is_arrow(nx, ny):
    # 箭头杆
    if 0.43 <= nx <= 0.57 and 0.20 <= ny <= 0.52:
        return True
    # 向下箭头头部（倒三角）
    if 0.48 <= ny <= 0.74:
        hw = 0.20 * (0.74 - ny) / (0.74 - 0.48)
        if 0.5 - hw <= nx <= 0.5 + hw:
            return True
    # 下载托盘（开口的方框）
    if 0.80 <= ny <= 0.88 and 0.26 <= nx <= 0.74:
        return True
    if 0.66 <= ny <= 0.88 and (0.26 <= nx <= 0.32 or 0.68 <= nx <= 0.74):
        return True
    return False


def make_png(size):
    radius = max(2, int(size * 0.22))
    rows = bytearray()
    for y in range(size):
        rows.append(0)  # filter type 0
        for x in range(size):
            if not inside_round_rect(x + 0.5, y + 0.5, size, radius):
                rows += bytes((0, 0, 0, 0))
                continue
            nx, ny = (x + 0.5) / size, (y + 0.5) / size
            r, g, b = WHITE if is_arrow(nx, ny) else RED
            rows += bytes((r, g, b, 255))

    def chunk(tag, data):
        c = struct.pack(">I", len(data)) + tag + data
        return c + struct.pack(">I", zlib.crc32(tag + data) & 0xFFFFFFFF)

    sig = b"\x89PNG\r\n\x1a\n"
    ihdr = struct.pack(">IIBBBBB", size, size, 8, 6, 0, 0, 0)
    idat = zlib.compress(bytes(rows), 9)
    return sig + chunk(b"IHDR", ihdr) + chunk(b"IDAT", idat) + chunk(b"IEND", b"")


if __name__ == "__main__":
    here = os.path.dirname(os.path.abspath(__file__))
    for s in (16, 48, 128):
        with open(os.path.join(here, f"icon{s}.png"), "wb") as f:
            f.write(make_png(s))
        print(f"icon{s}.png")
