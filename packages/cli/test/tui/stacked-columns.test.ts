import { describe, expect, it } from 'vitest';
import { ScreenBuffer, toPlainText } from '../../src/tui/screen.js';
import { drawStackedColumns } from '../../src/tui/widgets/stacked-columns.js';

const RED = '#ff0000';
const BLUE = '#0000ff';
const options = { width: 1, gap: 1, emptyColor: '#444444', highlightColor: '#ffff00' };

describe('stacked columns', () => {
  it('stacks segments bottom-up and scales to the tallest column', () => {
    const buf = new ScreenBuffer(5, 2);
    drawStackedColumns(buf, { x: 0, y: 0, width: 5, height: 2 }, [
      { segments: [{ value: 4, color: RED }, { value: 4, color: BLUE }] },
      { segments: [{ value: 2, color: RED }] },
    ], options);
    expect(toPlainText(buf).split('\n')).toEqual(['█', '█ ▄']);
    expect(buf.get(0, 1)!.fg).toBe(RED);
    expect(buf.get(0, 0)!.fg).toBe(BLUE);
    expect(buf.get(2, 1)!.fg).toBe(RED);
  });

  it('draws a shared cell as the lower share over the upper colour', () => {
    const buf = new ScreenBuffer(1, 1);
    drawStackedColumns(buf, { x: 0, y: 0, width: 1, height: 1 }, [{ segments: [{ value: 3, color: RED }, { value: 1, color: BLUE }] }], options);
    expect(buf.get(0, 0)).toMatchObject({ ch: '▆', fg: RED, bg: BLUE });
  });

  it('does not paint the empty eighths above a column that ends inside a shared cell', () => {
    const buf = new ScreenBuffer(3, 1);
    drawStackedColumns(buf, { x: 0, y: 0, width: 3, height: 1 }, [
      { segments: [{ value: 3, color: RED }, { value: 1, color: BLUE }] },
      { segments: [{ value: 8, color: RED }] },
    ], options);
    // Column 0 is 4 eighths: red 3, blue 1, all inside the top (only) cell.
    expect(buf.get(0, 0)).toMatchObject({ ch: '▄', fg: BLUE, bg: null });
  });

  it('keeps the time axis for zero columns and marks the highlight', () => {
    const buf = new ScreenBuffer(5, 3);
    drawStackedColumns(buf, { x: 0, y: 0, width: 5, height: 3 }, [
      { segments: [{ value: 0, color: RED }], highlight: true },
      { segments: [{ value: 1, color: RED }], highlight: true },
    ], options);
    expect(toPlainText(buf).split('\n')).toEqual(['  █', '▾ █', '▁ █']);
    expect(buf.get(0, 2)!.fg).toBe(options.emptyColor);
    expect(buf.get(0, 1)!.fg).toBe(options.highlightColor); // the full column's ▾ would be above the rect, so it is dropped
  });

  it('never writes outside the rect and drops columns that do not fit', () => {
    const buf = new ScreenBuffer(8, 5);
    const rect = { x: 2, y: 1, width: 3, height: 2 };
    drawStackedColumns(buf, rect, [1, 2, 3].map((v) => ({ segments: [{ value: v, color: RED }], highlight: true })), options);
    for (let y = 0; y < buf.height; y++) {
      for (let x = 0; x < buf.width; x++) {
        const inside = x >= rect.x && x < rect.x + rect.width && y >= rect.y && y < rect.y + rect.height;
        if (!inside) expect(buf.get(x, y)!.ch).toBe(' ');
      }
    }
    // The third column starts at x=6, outside the 3-wide rect.
    expect(buf.get(6, 2)!.ch).toBe(' ');
    expect(buf.get(4, 2)!.ch).toBe('█');
    expect(buf.get(4, 1)!.ch).toBe('▃'); // scaled against the tallest column even though it is dropped
  });

  it('draws wide columns', () => {
    const buf = new ScreenBuffer(5, 1);
    drawStackedColumns(buf, { x: 0, y: 0, width: 5, height: 1 }, [{ segments: [{ value: 1, color: RED }] }, { segments: [{ value: 1, color: RED }] }], { ...options, width: 2 });
    expect(toPlainText(buf)).toBe('██ ██');
  });
});
