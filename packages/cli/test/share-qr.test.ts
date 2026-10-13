import jsQR from 'jsqr';
import { describe, expect, it } from 'vitest';
import { qrLines, qrMatrix } from '../src/share/qr.js';

function toPixels(matrix: boolean[][], quiet: number, scale: number) {
  const size = (matrix.length + quiet * 2) * scale;
  const data = new Uint8ClampedArray(size * size * 4).fill(255);
  matrix.forEach((row, y) =>
    row.forEach((dark, x) => {
      if (!dark) return;
      for (let dy = 0; dy < scale; dy += 1)
        for (let dx = 0; dx < scale; dx += 1) {
          const i = (((y + quiet) * scale + dy) * size + (x + quiet) * scale + dx) * 4;
          data[i] = data[i + 1] = data[i + 2] = 0;
        }
    }),
  );
  return { data, size };
}

describe('qr', () => {
  const url = 'http://192.168.1.23:53211/Xq3v9cJfL2mN8pR4sT6uWy/';

  it('encodes a URL that a QR reader decodes back', () => {
    const matrix = qrMatrix(url);
    const { data, size } = toPixels(matrix, 4, 6);
    expect(jsQR(data, size, size)?.data).toBe(url);
  });

  it('draws two module rows per line with the quiet zone, forced black on white', () => {
    const matrix = qrMatrix(url);
    const lines = qrLines(matrix);
    expect(lines).toHaveLength(Math.ceil((matrix.length + 8) / 2));
    for (const line of lines) {
      expect(line.startsWith('\x1b[38;5;16m\x1b[48;5;231m')).toBe(true);
      expect(line.endsWith('\x1b[0m')).toBe(true);
      expect(line.replace(/\x1b\[[0-9;]*m/g, '')).toHaveLength(matrix.length + 8);
    }
  });

  it('decodes from the printed half-block characters themselves', () => {
    const lines = qrLines(qrMatrix(url)).map((line) => line.replace(/\x1b\[[0-9;]*m/g, ''));
    const scale = 6;
    const cols = lines[0]!.length;
    const rows = lines.length * 2;
    const width = cols * scale;
    const height = rows * scale;
    const data = new Uint8ClampedArray(width * height * 4).fill(255);
    lines.forEach((line, lineIndex) =>
      [...line].forEach((ch, col) => {
        const marks: [boolean, boolean] = [ch === '█' || ch === '▀', ch === '█' || ch === '▄'];
        marks.forEach((on, half) => {
          if (!on) return;
          for (let dy = 0; dy < scale; dy += 1)
            for (let dx = 0; dx < scale; dx += 1) {
              const i = (((lineIndex * 2 + half) * scale + dy) * width + col * scale + dx) * 4;
              data[i] = data[i + 1] = data[i + 2] = 0;
            }
        });
      }),
    );
    expect(jsQR(data, width, height)?.data).toBe(url);
  });
});
