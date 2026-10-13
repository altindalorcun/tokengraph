import { describe, expect, it } from 'vitest';
import { DISPLAY_SURFACES, FAMILY_RAMPS, FAMILY_RAMPS_LIGHT } from '../src/graph-colors.js';
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
    expect(svg).not.toContain('<style>');
    expect(svg).not.toContain('@font-face');
  });

  it('inlines the given font-face CSS, and only then', () => {
    const css = "@font-face{font-family:'IBM Plex Sans';src:url(data:font/woff2;base64,AAAA) format('woff2');}";
    const svg = renderGraphSvg([], { endDate: END, fontFaceCss: css });
    expect(svg).toContain(`<style>${css}</style>`);
    expect(renderNoticeSvg('x', { fontFaceCss: css })).toContain(`<style>${css}</style>`);
  });

  it('renders one cell per day for a full year plus the card and the legend swatches', () => {
    const svg = renderGraphSvg(daysEndingAt(END, 400, () => 1000), { endDate: END });
    const cells = (svg.match(/<title>/g) ?? []).length;
    expect(cells).toBe(WEEKS * 7 - OMITTED_AFTER_END);
    // Cells, six Less/More swatches, and the card's surface, shade and ring (the clip is in defs).
    expect((svg.match(/<rect /g) ?? []).length).toBe(cells + 6 + 3 + 1);
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
    expect(dark).toContain('rx="12"');
    expect(dark).not.toContain('>token-graph<');
    expect(dark).not.toContain('last 12 months —');
  });

  it('writes the header like the dashboard: total, caption, active days', () => {
    const svg = renderGraphSvg(daysEndingAt(END, 3, () => 47_531_939), { endDate: END });
    expect(svg).toMatch(/font-weight="500"[^>]*>142\.6M<\/text>/);
    expect(svg).toContain('>tokens, last 12 months</text>');
    expect(svg).toMatch(/text-anchor="end"[^>]*>3 active days<\/text>/);
    expect(renderGraphSvg([{ date: END, weighted: 5 }], { endDate: END })).toContain('>1 active day</text>');
  });

  it('shows a custom title in the header position, muted, when there is nothing to count', () => {
    const svg = renderGraphSvg([], { endDate: END, title: 'No tokens synced yet' });
    expect(svg).toContain('>—</text>');
    expect(svg).toContain('>No tokens synced yet</text>');
    expect(svg).toContain('>0 active days</text>');
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
    expect(perModel).not.toMatch(/#dc2626|#b91c1c|#f87171/);
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
    expect(svg).toContain('role="img" aria-label="Token usage graph, 3.0M weighted tokens over 3 active days"');
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
