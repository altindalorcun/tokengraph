import { describe, expect, it } from 'vitest';
import { hexToRgb, mix, nearest16, nearest256, rgbToHex, sgrBg, sgrFg } from '../../src/tui/color.js';

describe('color', () => {
  it('parses and prints hex', () => {
    expect(hexToRgb('#fb923c')).toEqual([251, 146, 60]);
    expect(hexToRgb('#fff')).toEqual([255, 255, 255]);
    expect(rgbToHex([251, 146, 60])).toBe('#fb923c');
    expect(rgbToHex([300, -4, 12.6])).toBe('#ff000d');
    expect(() => hexToRgb('rgb(1 2 3)')).toThrow();
  });

  it('mixes linearly and clamps t', () => {
    expect(mix('#000000', '#ffffff', 0.5)).toBe('#808080');
    expect(mix('#000000', '#ffffff', -1)).toBe('#000000');
    expect(mix('#000000', '#ffffff', 2)).toBe('#ffffff');
  });

  it('downgrades to 256 and 16 colours', () => {
    expect(nearest256([255, 0, 0])).toBe(196);
    expect(nearest256([128, 128, 128])).toBe(244);
    expect(nearest16([255, 0, 0])).toBe(9);
    expect(nearest16([0, 0, 0])).toBe(0);
  });

  it('emits SGR parameters per depth', () => {
    expect(sgrFg('#fb923c', 'truecolor')).toBe('38;2;251;146;60');
    expect(sgrBg('#fb923c', 'truecolor')).toBe('48;2;251;146;60');
    expect(sgrFg('#ff0000', '256')).toBe('38;5;196');
    expect(sgrFg('#ff0000', '16')).toBe('91');
    expect(sgrBg('#000000', '16')).toBe('40');
    expect(sgrFg(null, 'truecolor')).toBe('39');
    expect(sgrBg(null, '256')).toBe('49');
    expect(sgrFg('#ff0000', 'none')).toBe('');
  });
});
