import { describe, expect, it } from 'vitest';
import { ScreenBuffer, toPlainText } from '../../src/tui/screen.js';
import { FLAME_PALETTE, familyColor, tuiTheme } from '../../src/tui/theme.js';
import { drawBox } from '../../src/tui/widgets/box.js';
import { drawTabs } from '../../src/tui/widgets/tabs.js';
import { drawTiles } from '../../src/tui/widgets/tiles.js';
import { drawBar, drawStackedBar } from '../../src/tui/widgets/bars.js';
import { drawColumns, drawSparkline } from '../../src/tui/widgets/sparkline.js';
import { bigTextWidth, drawBigText } from '../../src/tui/widgets/big-digits.js';
import { FLAME, drawFlame, drawHeaderMark } from '../../src/tui/widgets/logo.js';

const theme = tuiTheme('dark');

describe('widgets', () => {
  it('draws a titled box and returns the inner rect', () => {
    const buf = new ScreenBuffer(12, 4);
    expect(drawBox(buf, { x: 0, y: 0, width: 12, height: 4 }, theme, 'Today')).toEqual({ x: 1, y: 1, width: 10, height: 2 });
    expect(toPlainText(buf)).toBe('╭─ TODAY ──╮\n│          │\n│          │\n╰──────────╯');
  });

  it('draws tabs and reports hit boxes', () => {
    const buf = new ScreenBuffer(40, 1);
    const hits = drawTabs(buf, 0, 0, ['Overview', 'Models'], 1, theme);
    expect(toPlainText(buf)).toBe('1 Overview  2 Models');
    expect(hits).toEqual([{ index: 0, x: 0, width: 10 }, { index: 1, x: 12, width: 8 }]);
    expect(buf.get(12, 0)!.fg).toBe(theme.accent);
  });

  it('drops tiles that do not fit', () => {
    const buf = new ScreenBuffer(30, 4);
    drawTiles(buf, { x: 0, y: 0, width: 30, height: 4 }, [
      { title: 'Today', value: '4.2M' }, { title: 'Week', value: '31M' }, { title: 'Streak', value: '3' },
    ], theme);
    const text = toPlainText(buf);
    expect(text).toContain('TODAY');
    expect(text).toContain('WEEK');
    expect(text).not.toContain('STREAK');
  });

  it('draws bars with eighth-block precision', () => {
    const buf = new ScreenBuffer(10, 2);
    drawBar(buf, 0, 0, 4, 0.5625, '#ff0000'); // 2.25 cells
    expect(toPlainText(buf).split('\n')[0]).toBe('██▎');
    drawStackedBar(buf, 0, 1, 10, [{ fraction: 0.5, color: '#ff0000' }, { fraction: 0.01, color: '#00ff00' }, { fraction: 0.49, color: '#0000ff' }]);
    const colours = Array.from({ length: 10 }, (_, x) => buf.get(x, 1)!.fg);
    expect(colours.filter((c) => c === '#00ff00')).toHaveLength(1);
    expect(colours.filter((c) => c === '#ff0000').length + colours.filter((c) => c === '#0000ff').length).toBe(9);
  });

  it('draws sparklines and columns', () => {
    const buf = new ScreenBuffer(4, 3);
    drawSparkline(buf, 0, 0, 4, [0, 1, 2, 8], '#ffffff', theme);
    expect(toPlainText(buf).split('\n')[0]).toBe('·▁▂█');
    drawColumns(buf, { x: 0, y: 1, width: 4, height: 2 }, [1, 2], ['#fff', '#fff'], 1);
    expect(toPlainText(buf).split('\n').slice(1)).toEqual(['  █', '█ █']);
  });

  it('renders seven-segment big digits with units on the baseline', () => {
    expect(bigTextWidth('12')).toBe(7);
    expect(bigTextWidth('4.2')).toBe(9);
    expect(bigTextWidth('4.2M')).toBe(10);
    expect(bigTextWidth('$12')).toBe(8);
    const zero = new ScreenBuffer(3, 3);
    drawBigText(zero, 0, 0, '0', '#ffffff');
    expect(toPlainText(zero)).toBe('┏━┓\n┃ ┃\n┗━┛');
    const eight = new ScreenBuffer(3, 3);
    drawBigText(eight, 0, 0, '8', '#ffffff');
    expect(toPlainText(eight)).toBe('┏━┓\n┣━┫\n┗━┛');
    const buf = new ScreenBuffer(10, 3);
    drawBigText(buf, 0, 0, '7.8M', '#ffffff', '#ff0000');
    expect(toPlainText(buf).split('\n')).toEqual(['╺━┓   ┏━┓', '  ┃   ┣━┫', '  ╹ • ┗━┛M']);
    expect(buf.get(9, 2)).toMatchObject({ ch: 'M', fg: '#ff0000', bold: true });
    const all = new ScreenBuffer(39, 3);
    drawBigText(all, 0, 0, '0123456789', '#ffffff');
    expect(toPlainText(all).split('\n')[0]).toBe('┏━┓ ╺┓  ╺━┓ ╺━┓ ╻ ╻ ┏━╸ ┏━╸ ╺━┓ ┏━┓ ┏━┓');
  });

  it('draws the flame and reveals it from the base', () => {
    expect(FLAME).toHaveLength(11);
    const full = new ScreenBuffer(8, 6);
    drawFlame(full, 0, 0, theme.bg, 1);
    expect(toPlainText(full).replace(/\s/g, '').length).toBeGreaterThan(20);
    const half = new ScreenBuffer(8, 6);
    drawFlame(half, 0, 0, theme.bg, 0.3);
    expect(toPlainText(half).split('\n')[0]!.trim()).toBe('');
    const header = new ScreenBuffer(20, 2);
    drawHeaderMark(header, 0, 0, theme);
    expect(toPlainText(header).split('\n')).toEqual([' ▀▄  tokengraph', '▀▀▀▀']);
    expect(header.get(1, 0)).toMatchObject({ fg: FLAME_PALETTE[6], bg: FLAME_PALETTE[5] });
    expect(header.get(2, 0)).toMatchObject({ fg: FLAME_PALETTE[5], bg: theme.bg });
    expect(header.get(0, 0)).toMatchObject({ ch: ' ', bg: theme.bg });
  });

  it('gives every family a colour', () => {
    expect(familyColor('claude', theme)).toBe('#fb923c');
    expect(familyColor(null, theme)).toBe(theme.muted);
  });
});
