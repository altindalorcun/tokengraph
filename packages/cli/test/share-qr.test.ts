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

  type Cell = { glyph: string; fg: boolean | null; bg: boolean | null };

  /** Each visible cell with its forced colours: true for black, null when unset. */
  function cells(line: string): Cell[] {
    const out: Cell[] = [];
    let fg: boolean | null = null;
    let bg: boolean | null = null;
    for (const part of line.split(/(\x1b\[[0-9;]*m)/)) {
      const code = /^\x1b\[(38|48);5;(16|231)m$/.exec(part);
      if (code) {
        if (code[1] === '38') fg = code[2] === '16';
        else bg = code[2] === '16';
      } else if (part === '\x1b[0m') fg = bg = null;
      else for (const glyph of part) out.push({ glyph, fg, bg });
    }
    return out;
  }

  it('paints matching halves with the background and mixed halves as ▄ over the top module', () => {
    const matrix = qrMatrix(url);
    const lines = qrLines(matrix);
    expect(lines).toHaveLength(Math.ceil((matrix.length + 4) / 2));
    lines.forEach((line, index) => {
      expect(line.endsWith('\x1b[0m')).toBe(true);
      const row = cells(line);
      expect(row).toHaveLength(matrix.length + 4);
      row.forEach((cell, col) => {
        const at = (r: number) => r >= 2 && col >= 2 && r < matrix.length + 2 && col < matrix.length + 2 && matrix[r - 2]![col - 2]!;
        const [top, bottom] = [at(index * 2), at(index * 2 + 1)];
        expect(cell.bg).toBe(top);
        if (top === bottom) expect(cell.glyph).toBe(' ');
        else expect(cell).toEqual({ glyph: '▄', fg: bottom, bg: top });
      });
    });
    expect(lines.join('')).not.toMatch(/[█▀]/);
  });

  it('decodes from the painted cells themselves', () => {
    const lines = qrLines(qrMatrix(url)).map(cells);
    const scale = 6;
    const width = lines[0]!.length * scale;
    const height = lines.length * 2 * scale;
    const data = new Uint8ClampedArray(width * height * 4).fill(255);
    lines.forEach((row, lineIndex) =>
      row.forEach((cell, col) => {
        const halves = [cell.bg!, cell.glyph === '▄' ? cell.fg! : cell.bg!];
        halves.forEach((on, half) => {
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

  it('prints plain half blocks with the same layout when colour is off', () => {
    const matrix = qrMatrix(url);
    const plain = qrLines(matrix, { color: false });
    expect(plain.join('\n')).not.toContain('\x1b');
    expect(plain).toHaveLength(qrLines(matrix).length);
    expect(plain.join('')).toMatch(/[█▀▄]/);
  });

  it('still takes the quiet zone as an option', () => {
    const matrix = qrMatrix(url);
    expect(qrLines(matrix, { quiet: 4, color: false })[0]).toHaveLength(matrix.length + 8);
    expect(qrLines(matrix, { quiet: 4 })).toHaveLength(Math.ceil((matrix.length + 8) / 2));
  });

  it('decodes from the printed half-block characters themselves', () => {
    const lines = qrLines(qrMatrix(url), { color: false });
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
