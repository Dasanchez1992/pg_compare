#!/usr/bin/env node
'use strict';

/**
 * Genera `build/icon.png`, el icono que usa electron-builder.
 *
 *     npm run icon [tamaño]
 *
 * Sin dependencias: dibuja con distancias con signo (bordes suaves) y escribe
 * el PNG con el `zlib` de Node. El diseño reproduce el logo de la app:
 * degradado azul→índigo con las dos bases y la flecha BD1 → BD2.
 */

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const OUTPUT = path.join(__dirname, 'icon.png');

const ACCENT = [0x38, 0xBD, 0xF8];   // --accent de la app
const INDIGO = [0x63, 0x66, 0xF1];
const BODY = [0xF1, 0xF5, 0xF9];     // cuerpo de las bases
const BODY_DARK = [0xC7, 0xD8, 0xEC];
const TOP = [0xFF, 0xFF, 0xFF];
const INK = [0x0B, 0x11, 0x20];      // --bg, para la flecha

const clamp = (value, low = 0, high = 1) => (
  value < low ? low : (value > high ? high : value)
);

const mix = (a, b, t) => {
  const k = clamp(t);
  return [a[0] + (b[0] - a[0]) * k, a[1] + (b[1] - a[1]) * k, a[2] + (b[2] - a[2]) * k];
};

/** Distancia con signo a un rectángulo redondeado (negativa dentro). */
function roundedRect(px, py, cx, cy, halfW, halfH, radius) {
  const qx = Math.abs(px - cx) - (halfW - radius);
  const qy = Math.abs(py - cy) - (halfH - radius);
  const outside = Math.hypot(Math.max(qx, 0), Math.max(qy, 0));
  return outside + Math.min(Math.max(qx, qy), 0) - radius;
}

/** Distancia aproximada a una elipse (un paso de Newton sobre la implícita). */
function ellipse(px, py, cx, cy, rx, ry) {
  const dx = (px - cx) / rx;
  const dy = (py - cy) / ry;
  const value = dx * dx + dy * dy - 1;
  const grad = 2 * Math.hypot((px - cx) / (rx * rx), (py - cy) / (ry * ry));
  return grad > 1e-9 ? value / grad : -Math.min(rx, ry);
}

/** Distancia con signo a un rectángulo recto. */
function band(px, py, x0, x1, y0, y1) {
  const qx = Math.max(x0 - px, px - x1);
  const qy = Math.max(y0 - py, py - y1);
  return Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) + Math.min(Math.max(qx, qy), 0);
}

/** Distancia (aproximada, suficiente para suavizar) a un triángulo. */
function triangle(px, py, a, b, c) {
  const edge = (p, q) => {
    const ex = q[0] - p[0];
    const ey = q[1] - p[1];
    return ((px - p[0]) * ey - (py - p[1]) * ex) / Math.hypot(ex, ey);
  };
  return Math.max(edge(a, b), edge(b, c), edge(c, a));
}

function render(size) {
  const s = size;
  const aa = s / 1024;                  // ancho del suavizado, en píxeles

  const radius = 0.2237 * s;            // esquinas al estilo macOS
  const cylRx = 0.150 * s;
  const cylRy = 0.052 * s;
  const topY = 0.375 * s;
  const bottomY = 0.610 * s;
  const leftCx = 0.285 * s;
  const rightCx = 0.715 * s;
  const midY = (topY + bottomY) / 2;

  const raw = Buffer.alloc((size * 4 + 1) * size);
  let offset = 0;

  for (let y = 0; y < size; y += 1) {
    const py = y + 0.5;
    raw[offset] = 0;                    // filtro PNG "none" al inicio de la fila
    offset += 1;

    for (let x = 0; x < size; x += 1) {
      const px = x + 0.5;

      // Fondo: degradado a 135° dentro del rectángulo redondeado.
      const cover = clamp(0.5 - roundedRect(px, py, s / 2, s / 2, s / 2, s / 2, radius) / aa);
      if (cover <= 0) {
        offset += 4;                    // ya está a cero: transparente
        continue;
      }

      let color = mix(ACCENT, INDIGO, clamp((px + py) / (2 * s)));

      for (const cx of [leftCx, rightCx]) {
        // Cilindro = cuerpo + tapa superior + panza inferior.
        const d = Math.min(
          band(px, py, cx - cylRx, cx + cylRx, topY, bottomY),
          ellipse(px, py, cx, topY, cylRx, cylRy),
          ellipse(px, py, cx, bottomY, cylRx, cylRy),
        );
        const c = clamp(0.5 - d / aa);
        if (c > 0) {
          color = mix(color, mix(BODY, BODY_DARK, (py - topY) / (bottomY - topY)), c);
        }
        // Tapa superior más clara y línea del "disco" intermedio.
        const cTop = clamp(0.5 - ellipse(px, py, cx, topY, cylRx, cylRy) / aa);
        if (cTop > 0) color = mix(color, TOP, cTop);

        const ring = Math.abs(ellipse(px, py, cx, midY, cylRx, cylRy)) - 0.006 * s;
        const cRing = py > midY - cylRy ? clamp(0.5 - ring / aa) : 0;
        if (cRing > 0) color = mix(color, BODY_DARK, cRing * 0.9);
      }

      // Flecha BD1 → BD2 entre las dos bases.
      const shaft = band(px, py, 0.447 * s, 0.505 * s, midY - 0.020 * s, midY + 0.020 * s);
      const head = triangle(px, py,
        [0.495 * s, midY - 0.056 * s],
        [0.553 * s, midY],
        [0.495 * s, midY + 0.056 * s]);
      const cArrow = clamp(0.5 - Math.min(shaft, head) / aa);
      if (cArrow > 0) color = mix(color, INK, cArrow * 0.92);

      raw[offset] = Math.round(color[0]);
      raw[offset + 1] = Math.round(color[1]);
      raw[offset + 2] = Math.round(color[2]);
      raw[offset + 3] = Math.round(clamp(cover) * 255);
      offset += 4;
    }
  }

  return png(size, size, raw);
}

function png(width, height, raw) {
  const chunk = (kind, payload) => {
    const length = Buffer.alloc(4);
    length.writeUInt32BE(payload.length);
    const body = Buffer.concat([Buffer.from(kind, 'ascii'), payload]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(zlib.crc32 ? zlib.crc32(body) : crc32(body));
    return Buffer.concat([length, body, crc]);
  };

  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8;        // bits por canal
  header[9] = 6;        // RGBA
  header[10] = 0;       // deflate
  header[11] = 0;       // filtro adaptativo
  header[12] = 0;       // sin entrelazado

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]),
    chunk('IHDR', header),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/** CRC-32 propio para versiones de Node sin `zlib.crc32`. */
let CRC_TABLE = null;
function crc32(buffer) {
  if (!CRC_TABLE) {
    CRC_TABLE = new Int32Array(256);
    for (let n = 0; n < 256; n += 1) {
      let c = n;
      for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1;
      CRC_TABLE[n] = c;
    }
  }
  let crc = -1;
  for (const byte of buffer) crc = CRC_TABLE[(crc ^ byte) & 0xFF] ^ (crc >>> 8);
  return (crc ^ -1) >>> 0;
}

const size = Number(process.argv[2]) || 1024;
fs.writeFileSync(OUTPUT, render(size));
console.log(`✔ ${OUTPUT} (${size}×${size}, ${Math.round(fs.statSync(OUTPUT).size / 1024)} KB)`);
