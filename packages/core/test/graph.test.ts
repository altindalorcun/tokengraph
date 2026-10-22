import { describe, expect, it } from 'vitest';
import { DISPLAY_SURFACES, FAMILY_RAMPS, FAMILY_RAMPS_LIGHT } from '../src/graph-colors.js';
import { FAMILY_LABELS, MODEL_FAMILIES } from '../src/model-makers.js';
import { LOGO_CELLS, logoCellMarkup, logoLockupMarkup } from '../src/story/logo.js';
import { buildGraphGrid, gridFamilies, formatTokens, formatTokensExact, renderGraphSvg, renderNoticeSvg, WEEKS, type GraphDay } from '../src/graph.js';

function daysEndingAt(endDate: string, count: number, value: (index: number) => number): GraphDay[] {
  const end = new Date(`${endDate}T00:00:00Z`).getTime();
  return Array.from({ length: count }, (_, index) => ({
    date: new Date(end - (count - 1 - index) * 86_400_000).toISOString().slice(0, 10),
    weighted: value(index),
  }));
}

// A Thursday, so the Friday and Saturday of its week are omitted from the grid.
const END = '2026-09-10';
const OMITTED_AFTER_END = 2;

describe('renderGraphSvg', () => {
  it('produces a self-contained SVG with no external references', () => {
    const svg = renderGraphSvg(daysEndingAt(END, 30, () => 1000), { endDate: END });
    expect(svg.startsWith('<svg')).toBe(true);
    expect(svg.trimEnd().endsWith('</svg>')).toBe(true);
    expect(svg).not.toContain('<image');
    expect(svg).not.toContain('<script');
    expect(svg).not.toContain('@import');
    // The SVG namespace is the only permitted URL — nothing is fetched at render time.
    const urls = svg.match(/https?:\/\/[^"']+/g) ?? [];
    expect(urls).toEqual(['http://www.w3.org/2000/svg']);
  });

  it('asks for IBM Plex Sans with a system fallback stack, and loads nothing by itself', () => {
    const svg = renderGraphSvg([], { endDate: END });
    expect(svg).toContain(`font-family="'IBM Plex Sans', -apple-system, 'Segoe UI', Helvetica, Arial, sans-serif"`);
    expect(svg).not.toContain('@font-face');
  });

  it('inlines the given font-face CSS, and only then', () => {
    const css = "@font-face{font-family:'IBM Plex Sans';src:url(data:font/woff2;base64,AAAA) format('woff2');}";
    const svg = renderGraphSvg([], { endDate: END, fontFaceCss: css });
    expect(svg).toContain(`<style>${css}`);
    expect(renderNoticeSvg('x', { fontFaceCss: css })).toContain(`<style>${css}</style>`);
  });

  it('renders one cell per day for a full year plus the card and the legend swatches', () => {
    const svg = renderGraphSvg(daysEndingAt(END, 400, () => 1000), { endDate: END });
    const cells = (svg.match(/<title>/g) ?? []).length;
    expect(cells).toBe(WEEKS * 7 - OMITTED_AFTER_END);
    // Cells, six Less/More swatches, today's halo and ring, the strip's panel and outline, the
    // card's surface, glow and ring, and the footer flame.
    expect((svg.match(/<rect /g) ?? []).length).toBe(cells + 6 + 2 + 2 + 3 + LOGO_CELLS.length);
  });

  it('never draws a day after the end date', () => {
    const svg = renderGraphSvg([], { endDate: END });
    expect(svg).toContain('2026-09-10');
    expect(svg).not.toContain('2026-09-11');
  });

  it('gives every cell a title, so the graph is never colour alone', () => {
    const svg = renderGraphSvg(daysEndingAt(END, 5, () => 2500), { endDate: END });
    expect(svg).toContain('<title>2.5K tokens on 2026-09-10</title>');
    expect(svg).toContain('<title>No tokens on ');
  });

  it('uses brand-red shades, not GitHub green', () => {
    const svg = renderGraphSvg(daysEndingAt(END, 40, (i) => (i + 1) * 1000), { endDate: END });
    expect(svg).toContain('#f87171');
    expect(svg).toContain('#b91c1c');
    expect(svg).not.toMatch(/#40c463|#216e39|#9be9a8/i);
  });

  it('paints busier days darker in the light theme, which inverts the ramp', () => {
    const svg = renderGraphSvg(daysEndingAt(END, 40, (i) => (i + 1) * 1000), { endDate: END, theme: 'light' });
    expect(svg.match(/fill="([^"]+)"><title>1\.0K tokens on/)?.[1]).toBe('#fecaca');
    expect(svg.match(/fill="([^"]+)"><title>40\.0K tokens on/)?.[1]).toBe('#991b1b');
  });

  it('paints the display surface, not GitHub’s, with no brand text and no outer bezel', () => {
    const dark = renderGraphSvg([], { endDate: END, theme: 'dark' });
    const light = renderGraphSvg([], { endDate: END, theme: 'light' });
    expect(dark).toContain('fill="#0b0c0e"');
    expect(light).toContain('fill="#ffffff"');
    expect(dark).toContain('rx="14"');
    expect(dark).not.toContain('>token-graph<');
    expect(dark).not.toContain('last 12 months —');
  });

  it('writes the header like the dashboard: total, caption, active days', () => {
    const svg = renderGraphSvg(daysEndingAt(END, 3, () => 47_531_939), { endDate: END });
    expect(svg).toMatch(/font-weight="500"[^>]*>142\.6M<\/text>/);
    expect(svg).toContain('>tokens, last 12 months</text>');
    expect(svg).toMatch(/text-anchor="end"[^>]*>Sep 2025 to Sep 2026<\/text>/);
    expect(renderGraphSvg([{ date: END, weighted: 5 }], { endDate: END, compact: true })).toContain('>1 active day</text>');
  });

  it('shows a custom title in the header position, muted, when there is nothing to count', () => {
    const svg = renderGraphSvg([], { endDate: END, title: 'No tokens synced yet' });
    expect(svg).toContain('>—</text>');
    expect(svg).toContain('>No tokens synced yet</text>');
    expect(svg).not.toContain('NaN');
    expect(svg).toContain(`fill="${DISPLAY_SURFACES.dark.muted}"`);
  });

  it('leaves days without usage at the display’s empty colour, legend included', () => {
    const dark = renderGraphSvg([{ date: END, weighted: 5000 }], { endDate: END });
    expect(dark).toContain(`fill="${DISPLAY_SURFACES.dark.empty}"><title>No tokens on`);
    expect(dark).toMatch(new RegExp(`<rect [^>]*fill="${DISPLAY_SURFACES.dark.empty}"/>`));
    const light = renderGraphSvg([{ date: END, weighted: 5000 }], { endDate: END, theme: 'light' });
    expect(light).toContain('fill="#e3e6ea"><title>No tokens on');
  });

  it('keeps the Less -> More scale hueless in per-model mode and red in single mode', () => {
    const days = daysEndingAt(END, 40, (i) => (i + 1) * 1000).map((day) => ({ ...day, topFamily: 'gpt' as const }));
    const single = renderGraphSvg(days, { endDate: END });
    const perModel = renderGraphSvg(days, { endDate: END, colorMode: 'per-model' });
    expect(single).toContain('#dc2626');
    // The footer logo is the product mark and keeps its own reds.
    expect(perModel.replace(logoCellMarkup(), '')).not.toMatch(/#dc2626|#b91c1c|#f87171/);
    expect(perModel).toContain('#9ba2ab');
  });

  it('colours a day by its top agent only in per-model mode', () => {
    const days = daysEndingAt(END, 40, (i) => (i + 1) * 1000).map((day) => ({ ...day, topFamily: 'gpt' as const }));
    const single = renderGraphSvg(days, { endDate: END });
    const perModel = renderGraphSvg(days, { endDate: END, colorMode: 'per-model' });
    expect(single.match(/fill="([^"]+)"><title>40\.0K tokens on/)?.[1]).toBe('#f87171');
    expect(perModel.match(/fill="([^"]+)"><title>40\.0K tokens on/)?.[1]).toBe('#60a5fa');
  });

  it('uses the light family ramps in per-model mode on the light theme', () => {
    const days = daysEndingAt(END, 40, (i) => (i + 1) * 1000).map((day) => ({ ...day, topFamily: 'gpt' as const }));
    const svg = renderGraphSvg(days, { endDate: END, colorMode: 'per-model', theme: 'light' });
    expect(svg.match(/fill="([^"]+)"><title>40\.0K tokens on/)?.[1]).toBe(FAMILY_RAMPS_LIGHT.gpt[5]);
    // The hue key's swatch is the mid-ramp step, as in the app.
    expect(svg).toContain(`fill="${FAMILY_RAMPS_LIGHT.gpt[4]}"/>`);
  });

  it('keeps the intensity legend in both colour modes', () => {
    expect(renderGraphSvg([], { endDate: END })).toContain('>Less</text>');
    expect(renderGraphSvg([], { endDate: END, colorMode: 'per-model' })).toContain('>Less</text>');
  });

  it('draws the designed widths: 900 full, 560 compact', () => {
    expect(renderGraphSvg([], { endDate: END })).toMatch(/width="900" height="\d+"/);
    expect(renderGraphSvg([], { endDate: END, compact: true })).toMatch(/width="560" height="\d+"/);
  });

  it('keeps the header in the compact variant', () => {
    const svg = renderGraphSvg(daysEndingAt(END, 3, () => 1_000_000), { endDate: END, compact: true });
    expect(svg).toContain('>3.0M</text>');
    expect(svg).toContain('active days</text>');
  });

  it('drops the labels and legends in the compact variant', () => {
    const svg = renderGraphSvg([], { endDate: END, compact: true });
    expect(svg).not.toContain('>Less</text>');
    expect(svg).not.toContain('>Mon</text>');
  });

  it('escapes text so a crafted title cannot inject markup', () => {
    const svg = renderGraphSvg([], { endDate: END, title: '</svg><script>alert(1)</script>' });
    expect(svg).not.toContain('<script>');
    expect(svg).toContain('&lt;/svg&gt;');
  });

  it('reports the weighted total in the accessible label and the heading', () => {
    const svg = renderGraphSvg(daysEndingAt(END, 3, () => 1_000_000), { endDate: END });
    expect(svg).toContain(
      'role="img" aria-label="Token usage graph, 3.0M weighted tokens over 3 active days, current streak 3 days"',
    );
    expect(svg).toContain('>3.0M</text>');
  });
});

describe('renderNoticeSvg', () => {
  it('returns a readable card at the same size, so a README never shows a broken image', () => {
    const svg = renderNoticeSvg('This graph is private');
    expect(svg).toContain('width="900" height="200"');
    expect(svg).toContain('>This graph is private</text>');
    expect(svg).toContain('aria-label="This graph is private"');
  });

  it('escapes the message', () => {
    expect(renderNoticeSvg('<script>alert(1)</script>')).not.toContain('<script>');
  });
});

describe('formatTokens', () => {
  it('scales units', () => {
    expect(formatTokens(999)).toBe('999');
    expect(formatTokens(1500)).toBe('1.5K');
    expect(formatTokens(2_400_000)).toBe('2.4M');
    expect(formatTokens(3_100_000_000)).toBe('3.1B');
  });
});

describe('formatTokensExact', () => {
  it('groups digits without depending on the host locale', () => {
    expect(formatTokensExact(847_209)).toBe('847,209');
    expect(formatTokensExact(0)).toBe('0');
    expect(formatTokensExact(999)).toBe('999');
  });
});

describe('per-model legend', () => {
  const days = [
    { date: '2026-09-01', weighted: 900, topFamily: 'qwen' as const },
    { date: '2026-09-02', weighted: 500, topFamily: 'claude' as const },
    { date: '2026-09-03', weighted: 0, topFamily: 'kimi' as const },
  ];

  it('lists only families that topped a day with usage, in family order, with names', () => {
    const svg = renderGraphSvg(days, { endDate: '2026-09-30', colorMode: 'per-model' });
    expect(svg.indexOf('>Claude<')).toBeGreaterThan(-1);
    expect(svg.indexOf('>Qwen<')).toBeGreaterThan(svg.indexOf('>Claude<'));
    expect(svg).not.toContain('>Kimi<');
    expect(svg).not.toContain('>GPT<');
  });

  it('never prints a model id or an agent name', () => {
    const svg = renderGraphSvg(days, { endDate: '2026-09-30', colorMode: 'per-model' });
    expect(svg).not.toMatch(/qwen3|claude-|Claude Code|Codex|OpenCode/);
  });

  it('draws no hue legend and only the orange ramp in single-hue mode', () => {
    const svg = renderGraphSvg(days, { endDate: '2026-09-30', colorMode: 'single' });
    expect(svg).not.toContain('>Qwen<');
    expect(svg).not.toContain(FAMILY_RAMPS.qwen[5]);
    expect(svg).not.toContain(FAMILY_RAMPS.qwen[4]);
  });

  it('draws each family mark once with unique gradient ids that all resolve', () => {
    const mixed = [
      { date: '2026-09-01', weighted: 900, topFamily: 'claude' as const },
      { date: '2026-09-02', weighted: 800, topFamily: 'gemini' as const },
      { date: '2026-09-03', weighted: 700, topFamily: 'deepseek' as const },
      { date: '2026-09-04', weighted: 600, topFamily: 'other' as const },
    ];
    const svg = renderGraphSvg(mixed, { endDate: '2026-09-30', colorMode: 'per-model' });
    expect(svg).toContain('fill="#D97757"');
    expect(svg).toContain('>Other models<');
    const ids = [...svg.matchAll(/id="([^"]*)"/g)].map((m) => m[1]!);
    const logoIds = ids.filter((id) => id.startsWith('lg'));
    expect(logoIds.length).toBeGreaterThan(0);
    expect(new Set(ids).size).toBe(ids.length);
    const refs = [...svg.matchAll(/url\(#([^)]+)\)/g)].map((m) => m[1]!);
    for (const ref of refs) expect(ids).toContain(ref);
  });
});

describe('legend with every family present', () => {
  const all = MODEL_FAMILIES.map((family, i) => ({ date: `2026-09-${String(i + 1).padStart(2, '0')}`, weighted: 100 + i, topFamily: family }));

  it('names all thirteen families and wraps them inside the card width', () => {
    const svg = renderGraphSvg(all, { endDate: '2026-09-30', colorMode: 'per-model' });
    for (const family of MODEL_FAMILIES) expect(svg).toContain(`>${FAMILY_LABELS[family]}<`);
    const width = Number(/width="(\d+)"/.exec(svg)![1]);
    const names = MODEL_FAMILIES.map((family) => FAMILY_LABELS[family]).join('|');
    const xs = [...svg.matchAll(new RegExp(`<text x="([\\d.]+)" y="[\\d.]+" font-size="13"[^>]*>(?:${names})<`, 'g'))].map((m) => Number(m[1]));
    expect(xs).toHaveLength(MODEL_FAMILIES.length);
    for (const x of xs) expect(x).toBeLessThan(width - 40);
    // Wrapped: the x position restarts at least once.
    expect(xs.some((x, i) => i > 0 && x < xs[i - 1]!)).toBe(true);
  });

  it('draws a unique gradient id per mark and resolves every reference', () => {
    const svg = renderGraphSvg(all, { endDate: '2026-09-30', colorMode: 'per-model', theme: 'light' });
    const ids = [...svg.matchAll(/id="([^"]*)"/g)].map((m) => m[1]!);
    expect(new Set(ids).size).toBe(ids.length);
    for (const ref of [...svg.matchAll(/url\(#([^)]+)\)/g)].map((m) => m[1]!)) expect(ids).toContain(ref);
  });
});

describe('gridFamilies', () => {
  it('lists only families on drawn cells with usage, in family order', () => {
    const grid = buildGraphGrid(
      [
        { date: '2026-09-01', weighted: 5, topFamily: 'kimi' as const },
        { date: '2026-09-02', weighted: 5, topFamily: 'claude' as const },
        { date: '2026-09-03', weighted: 0, topFamily: 'gpt' as const },
        // far outside the 52-week window
        { date: '2020-01-01', weighted: 5, topFamily: 'glm' as const },
      ],
      '2026-09-30',
    );
    expect(gridFamilies(grid)).toEqual(['claude', 'kimi']);
  });
});

describe('the alive README graph', () => {
  const mixed = daysEndingAt(END, 120, (i) => (i % 7 === 3 ? 0 : 1000 + i * 40)).map((d, i) => ({
    ...d,
    topFamily: (i % 3 === 0 ? 'claude' : 'gpt') as 'claude' | 'gpt',
  }));
  const full = (options: Partial<Parameters<typeof renderGraphSvg>[1]> = {}) =>
    renderGraphSvg(mixed, { endDate: END, colorMode: 'per-model', ...options });

  it('is deterministic: the same data gives the same bytes, with no clock in it', () => {
    expect(full()).toBe(full());
    expect(full({ compact: true, theme: 'light' })).toBe(full({ compact: true, theme: 'light' }));
  });

  it('animates only inside the no-preference media query, so reduced motion and no-CSS renders show the finished graph', () => {
    const svg = full();
    const media = svg.indexOf('@media (prefers-reduced-motion:no-preference){');
    expect(media).toBeGreaterThan(-1);
    expect(svg.slice(0, media)).not.toContain('animation');
    expect(svg.slice(0, media)).not.toContain('@keyframes');
    expect(svg.slice(media)).toContain('@keyframes tgin');
    expect(svg.slice(media)).toContain('@keyframes tgpulse');
    // The default state hides only the halo, which exists to be animated.
    expect(svg).toContain('.halo{opacity:0;');
    expect(svg).toContain('.ring{opacity:.7}');
  });

  it('appears column by column: 52 column groups, each with its own delay', () => {
    const svg = full();
    expect((svg.match(/<g class="c d\d+">/g) ?? []).length).toBe(WEEKS);
    expect((svg.match(/\.d\d+\{animation-delay:/g) ?? []).length).toBe(WEEKS);
    expect(svg).toContain('<g class="h">');
  });

  it('pulses a halo and ring on today when it has tokens', () => {
    const svg = full();
    expect(svg).toContain('class="halo"');
    expect(svg).toMatch(/class="ring"[^>]*stroke="#eef0f2"/);
    expect(svg).not.toContain('stroke-opacity="0.6"');
  });

  it('still marks an empty today with a dimmer ring and no halo', () => {
    const svg = renderGraphSvg(daysEndingAt(END, 20, (i) => (i === 19 ? 0 : 500)), { endDate: END });
    expect(svg).not.toContain('class="halo"');
    expect(svg).toMatch(/class="ring"[^>]*stroke-opacity="0.6"/);
  });

  it('draws month dividers and the month labels', () => {
    const svg = full();
    const dividers = svg.match(/<path d="M[\d.]+ [\d.]+V[\d.]+" stroke="rgb\(255 255 255 \/ 0\.075\)"\/>/g) ?? [];
    expect(dividers).toHaveLength(buildGraphGrid(mixed, END).months.length - 1);
    for (const label of ['Oct', 'Nov', 'Dec', 'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug']) {
      expect(svg).toContain(`>${label}</text>`);
    }
  });

  it('shows the stats strip with the five figures, led days instead of a percentage', () => {
    const svg = full();
    for (const label of ['TODAY', 'STREAK', 'BEST DAY', 'ACTIVE DAYS', 'TOP FAMILY']) {
      expect(svg).toContain(`>${label}</text>`);
    }
    expect(svg).toMatch(/>led \d+ days<\/text>/);
    expect(svg).toContain('>of 362</text>');
    expect(svg).not.toMatch(/\d%</);
  });

  it('swaps the top family for the average active day in single-colour mode', () => {
    const svg = full({ colorMode: 'single' });
    expect(svg).toContain('>AVG ACTIVE DAY</text>');
    expect(svg).not.toContain('>TOP FAMILY</text>');
    expect(svg).not.toContain('>led ');
  });

  it('keeps the longest family name and a three-digit day count inside the strip', () => {
    const allOther = renderGraphSvg(
      daysEndingAt(END, 400, () => 100).map((d) => ({ ...d, topFamily: 'other' as const })),
      { endDate: END, colorMode: 'per-model' },
    );
    const led = /<text x="([\d.]+)"[^>]*font-size="12.5"[^>]*>led (\d+) days<\/text>/.exec(allOther)!;
    expect(Number(led[2])).toBe(WEEKS * 7 - OMITTED_AFTER_END);
    // 12 glyphs at ~0.55em each, ending inside the strip.
    expect(Number(led[1]) + 12 * 12.5 * 0.55).toBeLessThan(900 - 20);
  });

  it('merges the current and longest streak into one figure, best streak in the caption', () => {
    const svg = renderGraphSvg(
      [...daysEndingAt(END, 3, () => 100), ...daysEndingAt('2026-08-01', 9, () => 100)],
      { endDate: END },
    );
    expect(svg).toMatch(/>3<\/text><text[^>]*>days · best 9<\/text>/);
    expect(svg).not.toContain('LONGEST STREAK');
    expect(svg).not.toContain('CURRENT STREAK');
  });

  it("shows today's tokens first in the strip", () => {
    const svg = renderGraphSvg(daysEndingAt(END, 5, (i) => (i === 4 ? 1_250_000 : 100)), { endDate: END });
    expect(svg).toMatch(/>TODAY<\/text><text[^>]*>1\.3M<\/text><text[^>]*>tokens<\/text>/);
  });

  it('keeps a full-year streak and its best inside the streak column', () => {
    const svg = renderGraphSvg(daysEndingAt(END, 400, () => 100), { endDate: END });
    const sub = /<text x="([\d.]+)"[^>]*font-size="12.5"[^>]*>days · best (\d+)<\/text>/.exec(svg)!;
    expect(Number(sub[2])).toBe(WEEKS * 7 - OMITTED_AFTER_END);
    // 15 glyphs, narrow ones among them, at ~0.5em each (Plex lays this out at 86px), ending
    // before the next column's divider.
    expect(Number(sub[1]) + 15 * 12.5 * 0.5).toBeLessThan(20 + 136 + 160 - 8);
  });

  it('keeps the glow neutral: not tinted by the leading family', () => {
    const glow = (family: 'claude' | 'qwen') =>
      renderGraphSvg(
        daysEndingAt(END, 60, () => 900).map((d) => ({ ...d, topFamily: family })),
        { endDate: END, colorMode: 'per-model' },
      ).match(/<radialGradient id="tg-glow".*?<\/radialGradient>/)![0];
    expect(glow('claude')).toBe(glow('qwen'));
    expect(glow('claude')).toContain('stop-color="#ffffff"');
  });

  it('makes the light ring stronger than the dark one', () => {
    expect(full({ theme: 'light' })).toContain('stroke="rgb(31 35 40 / 0.14)"');
    expect(full()).toContain('stroke="rgb(255 255 255 / 0.08)"');
  });

  it('carries the logo lockup opposite Less and More, in the full graph only', () => {
    const svg = full();
    expect(svg).toContain(logoLockupMarkup(DISPLAY_SURFACES.dark.ink));
    expect(full({ theme: 'light' })).toContain(logoLockupMarkup(DISPLAY_SURFACES.light.ink));
    // The wordmark is outlined like the site's logo, not set as text.
    expect(svg).not.toContain('>tokengraph</text>');
    expect(renderGraphSvg([], { endDate: END, compact: true })).not.toContain(logoCellMarkup());
  });

  it('puts the streak in the accessible label, and leaves it out of an empty graph', () => {
    expect(full()).toMatch(/aria-label="Token usage graph, [\d.]+K weighted tokens over \d+ active days, current streak \d+ days?"/);
    expect(renderGraphSvg([], { endDate: END })).toContain('aria-label="Token usage graph, 0 weighted tokens over 0 active days"');
  });

  it('renders a brand-new account (a few days, or none) without NaN or empty figures', () => {
    const few = renderGraphSvg([{ date: END, weighted: 1234 }], { endDate: END, colorMode: 'per-model' });
    const none = renderGraphSvg([], { endDate: END, colorMode: 'per-model', title: 'No tokens synced yet' });
    for (const svg of [few, none]) {
      expect(svg).not.toMatch(/NaN|undefined|Infinity/);
      expect(svg).not.toContain('></text>');
    }
    expect(few).toContain('>1.2K</text>');
    expect(few).toContain('>of 362</text>');
    // Empty: dashes in the strip, no led-days claim.
    expect((none.match(/>—<\/text>/g) ?? []).length).toBeGreaterThanOrEqual(5);
    expect(none).not.toContain('>led ');
    expect(none).toContain('>0</text>');
  });

  it('keeps full and compact graphs under the size budget even with a font and thirteen families', () => {
    const font = `@font-face{font-family:x;src:url(data:font/woff2;base64,${'A'.repeat(48_000)})}`;
    const all = daysEndingAt(END, 400, (i) => 100 + i * 37).map((d, i) => ({
      ...d,
      topFamily: MODEL_FAMILIES[i % MODEL_FAMILIES.length]!,
    }));
    for (const theme of ['dark', 'light'] as const) {
      for (const compact of [false, true]) {
        const svg = renderGraphSvg(all, { endDate: END, theme, compact, colorMode: 'per-model', fontFaceCss: font });
        expect(Buffer.byteLength(svg)).toBeLessThan(150_000);
      }
    }
  });
});

describe('the compact README graph', () => {
  const svg = renderGraphSvg(
    daysEndingAt(END, 90, () => 2000).map((d) => ({ ...d, topFamily: 'gpt' as const })),
    { endDate: END, compact: true, colorMode: 'per-model', theme: 'light' },
  );

  it('keeps the refined chrome and the motion, without the strip, labels or footer', () => {
    expect(svg).toMatch(/width="560" height="\d+"/);
    expect(svg).toContain('@media (prefers-reduced-motion:no-preference)');
    expect(svg).toContain('stroke="rgb(31 35 40 / 0.14)"');
    expect(svg).toContain('class="halo"');
    expect((svg.match(/<g class="c d\d+">/g) ?? []).length).toBe(WEEKS);
    for (const gone of ['>STREAK<', '>Less<', '>Mon<', '>Oct<', '>GPT<', '>tokengraph<']) expect(svg).not.toContain(gone);
  });

  it('stays small', () => {
    expect(Number(/height="(\d+)"/.exec(svg)![1])).toBeLessThan(170);
  });
});
