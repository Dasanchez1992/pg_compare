#!/usr/bin/env python3
"""Genera ``build/icon.png`` (el icono que usa electron-builder).

No necesita dependencias: dibuja con distancias con signo y antialiasing y
escribe el PNG con ``zlib``. El diseño reproduce el logo de la app (degradado
azul→índigo) con las dos bases que se comparan y la flecha BD1 → BD2.

    python3 desktop/build/make-icon.py [tamaño]
"""
from __future__ import annotations

import math
import struct
import sys
import zlib
from pathlib import Path

OUTPUT = Path(__file__).resolve().parent / "icon.png"

ACCENT = (0x38, 0xBD, 0xF8)   # --accent de la app
INDIGO = (0x63, 0x66, 0xF1)
BODY = (0xF1, 0xF5, 0xF9)     # cuerpo de las bases
BODY_DARK = (0xC7, 0xD8, 0xEC)
TOP = (0xFF, 0xFF, 0xFF)
INK = (0x0B, 0x11, 0x20)      # --bg, para la flecha


def clamp(value: float, low: float = 0.0, high: float = 1.0) -> float:
    return low if value < low else high if value > high else value


def mix(color_a, color_b, t: float):
    t = clamp(t)
    return tuple(a + (b - a) * t for a, b in zip(color_a, color_b))


def rounded_rect(px: float, py: float, cx: float, cy: float,
                 half_w: float, half_h: float, radius: float) -> float:
    """Distancia con signo a un rectángulo redondeado (negativa dentro)."""
    qx = abs(px - cx) - (half_w - radius)
    qy = abs(py - cy) - (half_h - radius)
    outside = math.hypot(max(qx, 0.0), max(qy, 0.0))
    return outside + min(max(qx, qy), 0.0) - radius


def ellipse(px: float, py: float, cx: float, cy: float, rx: float, ry: float) -> float:
    """Distancia aproximada a una elipse (paso de Newton sobre la implícita)."""
    dx = (px - cx) / rx
    dy = (py - cy) / ry
    value = dx * dx + dy * dy - 1.0
    grad = 2.0 * math.hypot((px - cx) / (rx * rx), (py - cy) / (ry * ry))
    return value / grad if grad > 1e-9 else -min(rx, ry)


def band(px: float, py: float, x0: float, x1: float, y0: float, y1: float) -> float:
    """Distancia con signo a un rectángulo recto."""
    qx = max(x0 - px, px - x1)
    qy = max(y0 - py, py - y1)
    return math.hypot(max(qx, 0.0), max(qy, 0.0)) + min(max(qx, qy), 0.0)


def triangle(px: float, py: float, ax, bx, cx) -> float:
    """Distancia (aproximada, suficiente para el antialiasing) a un triángulo."""
    def edge(p, q):
        ex, ey = q[0] - p[0], q[1] - p[1]
        return ((px - p[0]) * ey - (py - p[1]) * ex) / math.hypot(ex, ey)

    return max(edge(ax, bx), edge(bx, cx), edge(cx, ax))


def render(size: int) -> bytes:
    s = float(size)
    aa = s / 1024.0                     # ancho del antialiasing en píxeles

    # Geometría relativa al lienzo.
    radius = 0.2237 * s                 # esquinas estilo macOS
    cyl_rx, cyl_ry = 0.150 * s, 0.052 * s
    top_y, bottom_y = 0.375 * s, 0.610 * s
    left_cx, right_cx = 0.285 * s, 0.715 * s
    mid_y = (top_y + bottom_y) / 2.0

    rows = []
    for y in range(size):
        py = y + 0.5
        row = bytearray()
        for x in range(size):
            px = x + 0.5

            # Fondo: degradado a 135° dentro del rectángulo redondeado.
            cover = clamp(0.5 - rounded_rect(px, py, s / 2, s / 2,
                                             s / 2, s / 2, radius) / aa)
            if cover <= 0.0:
                row += b"\x00\x00\x00\x00"
                continue

            t = clamp((px + py) / (2.0 * s))
            r, g, b = mix(ACCENT, INDIGO, t)
            alpha = cover

            for cx in (left_cx, right_cx):
                # Cilindro = cuerpo + tapa superior + panza inferior.
                d = min(
                    band(px, py, cx - cyl_rx, cx + cyl_rx, top_y, bottom_y),
                    ellipse(px, py, cx, top_y, cyl_rx, cyl_ry),
                    ellipse(px, py, cx, bottom_y, cyl_rx, cyl_ry),
                )
                c = clamp(0.5 - d / aa)
                if c > 0.0:
                    shade = mix(BODY, BODY_DARK, (py - top_y) / (bottom_y - top_y))
                    r, g, b = mix((r, g, b), shade, c)
                # Tapa superior más clara y línea del "disco" intermedio.
                c_top = clamp(0.5 - ellipse(px, py, cx, top_y, cyl_rx, cyl_ry) / aa)
                if c_top > 0.0:
                    r, g, b = mix((r, g, b), TOP, c_top)
                ring = abs(ellipse(px, py, cx, mid_y, cyl_rx, cyl_ry)) - 0.006 * s
                c_ring = clamp(0.5 - ring / aa) * (1.0 if py > mid_y - cyl_ry else 0.0)
                if c_ring > 0.0:
                    r, g, b = mix((r, g, b), BODY_DARK, c_ring * 0.9)

            # Flecha BD1 → BD2 entre las dos bases.
            shaft = band(px, py, 0.447 * s, 0.505 * s, mid_y - 0.020 * s, mid_y + 0.020 * s)
            head = triangle(
                px, py,
                (0.495 * s, mid_y - 0.056 * s),
                (0.553 * s, mid_y),
                (0.495 * s, mid_y + 0.056 * s),
            )
            c_arrow = clamp(0.5 - min(shaft, head) / aa)
            if c_arrow > 0.0:
                r, g, b = mix((r, g, b), INK, c_arrow * 0.92)

            row += bytes((int(r + 0.5), int(g + 0.5), int(b + 0.5),
                          int(clamp(alpha) * 255 + 0.5)))
        rows.append(row)

    raw = b"".join(b"\x00" + bytes(row) for row in rows)
    return _png(size, size, raw)


def _png(width: int, height: int, raw: bytes) -> bytes:
    def chunk(kind: bytes, payload: bytes) -> bytes:
        return (struct.pack(">I", len(payload)) + kind + payload
                + struct.pack(">I", zlib.crc32(kind + payload) & 0xFFFFFFFF))

    header = struct.pack(">IIBBBBB", width, height, 8, 6, 0, 0, 0)
    return (b"\x89PNG\r\n\x1a\n"
            + chunk(b"IHDR", header)
            + chunk(b"IDAT", zlib.compress(raw, 9))
            + chunk(b"IEND", b""))


def main() -> int:
    size = int(sys.argv[1]) if len(sys.argv) > 1 else 1024
    OUTPUT.write_bytes(render(size))
    print(f"✔ {OUTPUT} ({size}×{size}, {OUTPUT.stat().st_size // 1024} KB)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
