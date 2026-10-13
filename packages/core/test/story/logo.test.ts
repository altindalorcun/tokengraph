import { describe, expect, it } from 'vitest';
import {
  LOGO_CELL,
  LOGO_CELLS,
  LOGO_ICON_VIEWBOX,
  LOGO_LOCKUP_VIEWBOX,
  LOGO_PALETTE,
  LOGO_WORDMARK_SHIFT_Y,
  LOGO_WORDMARK_TRANSFORM,
  logoAppSvg,
  logoIconSvg,
  logoLockupSvg,
} from '../../src/story/logo.js';

describe('logo', () => {
  it('references nothing outside itself', () => {
    for (const svg of [logoIconSvg(), logoLockupSvg('light'), logoAppSvg('dark')]) {
      expect(svg.match(/https?:\/\/[^"']+/g) ?? []).toEqual(['http://www.w3.org/2000/svg']);
    }
  });

  it('outlines the wordmark instead of relying on a font', () => {
    expect(logoLockupSvg('light')).not.toContain('<text');
  });

  it('keeps every cell inside the icon view box, with the flame centred', () => {
    const [vx, vy, vw, vh] = LOGO_ICON_VIEWBOX.split(' ').map(Number);
    const xs = LOGO_CELLS.map(([x]) => x);
    const ys = LOGO_CELLS.map(([, y]) => y);
    const left = Math.min(...xs) - vx;
    const right = vx + vw - (Math.max(...xs) + LOGO_CELL);
    const top = Math.min(...ys) - vy;
    const bottom = vy + vh - (Math.max(...ys) + LOGO_CELL);
    expect(Math.min(left, right, top, bottom)).toBeGreaterThanOrEqual(0);
    expect(Math.abs(left - right)).toBeLessThan(0.05);
    expect(Math.abs(top - bottom)).toBeLessThan(0.05);
  });

  it('uses only palette colours and a lockup wider than the icon', () => {
    for (const [, , colour] of LOGO_CELLS) expect(LOGO_PALETTE[colour]).toBeDefined();
    expect(Number(LOGO_LOCKUP_VIEWBOX.split(' ')[2])).toBeGreaterThan(Number(LOGO_ICON_VIEWBOX.split(' ')[2]));
  });
});

describe('wordmark alignment', () => {
  it("centres the wordmark's lowercase body on the flame's visual centre, not its bounding box", () => {
    const centroid = LOGO_CELLS.reduce((sum, [, y]) => sum + y + LOGO_CELL / 2, 0) / LOGO_CELLS.length;
    const xHeightMiddle = (18.5 + 33.15) / 2;
    expect(xHeightMiddle + LOGO_WORDMARK_SHIFT_Y).toBeCloseTo(centroid, 1);
    // The drop's weight sits low, so the wordmark moves down from the box centre, by about two units.
    expect(LOGO_WORDMARK_SHIFT_Y).toBeGreaterThan(1.5);
    expect(LOGO_WORDMARK_SHIFT_Y).toBeLessThan(2.5);
  });

  it('draws the shifted wordmark in the exported lockups', () => {
    for (const theme of ['light', 'dark'] as const) {
      expect(logoLockupSvg(theme)).toContain(`transform="${LOGO_WORDMARK_TRANSFORM}"`);
    }
  });
});
