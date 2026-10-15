import {
  alpha,
  backdropSvg,
  darken,
  FAMILY_RAMPS,
  fitFont,
  heroNumber,
  lighten,
  logoLockupSvg,
  periodDateLabel,
  periodPhrase,
  renderSkyline,
  shortHandle,
  storyStats,
  svgUri,
  topModels,
} from '@tokengraph/core';
import { Column, ModelList, MONO, Row, SANS, ShareStrip, StatRow, type ModelLine } from '../parts.js';
import { SAFE_BOTTOM, SAFE_TOP, type CardContext } from './context.js';

const W = 1080;
const H = 1920;
const GUTTER = 84;
const INK = '#f4f5f6';
const MUTED = '#9aa1a9';
const BASE = '#07080a';
const LOCKUP_RATIO = 189.82 / 49.36;

/**
 * The hero card: the big number up top, the person's recent weeks as a lit city below it, then the
 * models, three stats and the brand. Everything that matters sits between SAFE_TOP and SAFE_BOTTOM,
 * clear of the progress bar and reply box Instagram and TikTok draw over a story; only light and
 * the city's glow run under them.
 */
export function SkylineCard({ data, showCost, cta }: CardContext) {
  const ramp = FAMILY_RAMPS[data.family];
  const accent = ramp[5];
  const deep = ramp[2];
  const hero = heroNumber(data.total);
  const beaconDate = data.range === 'today' ? (data.total > 0 ? data.endDate : null) : (data.peak?.date ?? null);

  const skylineLeft = 40;
  const skylineTop = 600;
  const skyline = renderSkyline(data.weeks, {
    width: W - skylineLeft * 2,
    maxHeight: data.range === '1y' ? 220 : 240,
    beaconDate,
    family: data.family,
    surface: 'dark',
    headroom: 40,
  });
  const modelsTop = Math.round(skylineTop + skyline.floorBottom + 30);

  const { shown, rest } = topModels(data.models, 3);
  const lines: ModelLine[] = shown.map((model) => ({ key: model.name, label: model.name, share: model.share, maker: model.maker, color: model.color }));
  if (rest) lines.push({ key: 'rest', label: `${rest.count} more`, share: rest.share, maker: null, color: '#64748b' });

  const stats = storyStats(data, showCost);
  const beaconLabel = data.range === 'today' ? 'Today' : 'Best day';
  const beaconOnRight = skyline.beacon !== null && skyline.beacon.x > skyline.width * 0.62;
  const footer = `${data.demo ? 'sample data' : `@${shortHandle(data.handle, 18)}`} · ${cta}`;

  return (
    <div style={{ display: 'flex', position: 'relative', width: W, height: H, background: BASE, overflow: 'hidden' }}>
      {/* Light: the family's darkest tone at the very top and bottom, the accent rising off the city. */}
      <img
        src={svgUri(
          backdropSvg(W, H, [
            { kind: 'solid', color: BASE },
            { kind: 'linear', angle: 180, stops: [[darken(ramp[1], 0.55), 1, 0], [BASE, 1, 0.24], [BASE, 1, 0.74], [darken(ramp[1], 0.5), 1, 1]] },
            { kind: 'radial', cx: 0.5, cy: 0.5, rx: 1.1, ry: 0.4, stops: [[deep, 0.42, 0], [deep, 0.12, 0.5], [deep, 0, 0.78]] },
          ]),
        )}
        width={W}
        height={H}
        style={{ position: 'absolute', top: 0, left: 0 }}
        alt=""
      />

      <img src={svgUri(skyline.svg)} width={skyline.width} height={skyline.height} style={{ position: 'absolute', left: skylineLeft, top: skylineTop }} alt="" />

      {skyline.beacon && (
        <Row
          style={{
            position: 'absolute',
            // Never above the city's own top edge, where it would run into the line under the number.
            top: Math.max(skylineTop + 12, skylineTop + skyline.beacon.y - 96),
            gap: 12,
            ...(beaconOnRight
              ? { right: W - (skylineLeft + skyline.beacon.x) + 30, flexDirection: 'row-reverse' }
              : { left: skylineLeft + skyline.beacon.x + 30 }),
          }}
        >
          <div style={{ width: 14, height: 14, borderRadius: 14, background: lighten(accent, 0.3), boxShadow: `0 0 18px 4px ${alpha(accent, 0.8)}` }} />
          <div style={{ display: 'flex', fontFamily: SANS, fontSize: 28, fontWeight: 500, color: lighten(accent, 0.45) }}>{beaconLabel}</div>
        </Row>
      )}

      <Column style={{ position: 'absolute', top: SAFE_TOP, left: GUTTER, width: W - GUTTER * 2 }}>
        <Row style={{ justifyContent: 'space-between' }}>
          <Row style={{ gap: 16 }}>
            <div style={{ display: 'flex', fontFamily: SANS, fontSize: 30, fontWeight: 400, color: MUTED }}>{periodDateLabel(data.startDate, data.endDate)}</div>
            {data.highlight && (
              <div
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 10,
                  padding: '7px 16px 7px 13px',
                  boxSizing: 'border-box',
                  borderRadius: 40,
                  background: alpha(accent, 0.16),
                  border: `2px solid ${alpha(accent, 0.45)}`,
                  fontFamily: SANS,
                  fontSize: 24,
                  fontWeight: 600,
                  color: lighten(accent, 0.35),
                }}
              >
                <div style={{ width: 9, height: 9, borderRadius: 9, background: lighten(accent, 0.2) }} />
                {data.highlight.label}
              </div>
            )}
          </Row>
          <div style={{ display: 'flex', fontFamily: SANS, fontSize: 30, fontWeight: 500, color: MUTED, whiteSpace: 'nowrap' }}>
            @{shortHandle(data.handle, data.highlight ? 16 : 22)}
          </div>
        </Row>

        <Row style={{ alignItems: 'flex-end', marginTop: 10 }}>
          <div style={{ display: 'flex', fontFamily: SANS, fontSize: 250, fontWeight: 600, letterSpacing: -12, lineHeight: 1, color: INK }}>{hero.figure}</div>
          {hero.unit && (
            <div
              style={{
                display: 'flex',
                fontFamily: SANS,
                fontSize: 150,
                fontWeight: 500,
                letterSpacing: -5,
                lineHeight: 1,
                marginLeft: 10,
                marginBottom: 12,
                color: accent,
              }}
            >
              {hero.unit}
            </div>
          )}
        </Row>
        <div style={{ display: 'flex', marginTop: 4, fontFamily: SANS, fontSize: 42, fontWeight: 400, color: '#d4d8dc', letterSpacing: -0.5 }}>
          {periodPhrase(data.range)}
        </div>
      </Column>

      <Column style={{ position: 'absolute', left: GUTTER, width: W - GUTTER * 2, top: modelsTop, gap: 26 }}>
        <ShareStrip models={data.models} height={12} gap={5} track="rgba(255,255,255,0.08)" />
        <ModelList lines={lines} ink={INK} muted={MUTED} size={30} />
      </Column>

      <Column style={{ position: 'absolute', left: GUTTER, width: W - GUTTER * 2, top: SAFE_BOTTOM - 208 }}>
        <StatRow stats={stats} ink={INK} muted={MUTED} rule="rgba(255,255,255,0.1)" />
      </Column>

      <Row style={{ position: 'absolute', left: GUTTER, width: W - GUTTER * 2, top: SAFE_BOTTOM - 50, justifyContent: 'space-between' }}>
        <img src={svgUri(logoLockupSvg('dark'))} height={44} width={Math.round(44 * LOCKUP_RATIO)} alt="" />
        <div style={{ display: 'flex', fontFamily: MONO, fontSize: fitFont(footer, 660, 24), fontWeight: 500, color: '#7d848c', whiteSpace: 'nowrap' }}>
          {footer}
        </div>
      </Row>
    </div>
  );
}
