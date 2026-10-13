import {
  FAMILY_RAMPS,
  heroNumber,
  lighten,
  logoLockupSvg,
  periodPhrase,
  renderSkyline,
  shareLabel,
  shortHandle,
  storyStats,
  svgUri,
  topModels,
} from '@tokengraph/core';
import { Column, ModelMark, MONO, Row, SANS, shortName } from '../parts.js';
import type { CardContext } from './context.js';

const W = 1080;
const H = 1380;
const INK = '#ffffff';
/** Soft dark halo under every glyph, so white text survives a bright photo. */
const HALO = '0 2px 4px rgba(0,0,0,0.35), 0 4px 22px rgba(0,0,0,0.35)';

/**
 * Strava's trick: a transparent PNG with nothing but the numbers, to lay over your own photo. The
 * unlit city turns to frosted glass so the photo shows through it; the period's towers stay lit.
 * Cropped to its content, so pasting it into a story makes a sticker rather than a background.
 */
export function StickerCard({ data, showCost, cta }: CardContext) {
  const accent = FAMILY_RAMPS[data.family][5];
  const hero = heroNumber(data.total);
  const beaconDate = data.range === 'today' ? (data.total > 0 ? data.endDate : null) : (data.peak?.date ?? null);
  const skyline = renderSkyline(data.weeks, {
    width: 860,
    maxHeight: data.range === '1y' ? 170 : 200,
    beaconDate,
    family: data.family,
    surface: 'clear',
    headroom: 40,
  });
  const { shown, rest } = topModels(data.models, 3);
  const stats = storyStats(data, showCost);

  return (
    <Column style={{ width: W, height: H, alignItems: 'center', padding: '56px 70px 0' }}>
      <img src={svgUri(logoLockupSvg('dark'))} height={54} width={Math.round((54 * 189.82) / 49.36)} alt="" />

      <Row style={{ alignItems: 'flex-end', marginTop: 34 }}>
        <div style={{ display: 'flex', fontFamily: SANS, fontSize: 236, fontWeight: 600, letterSpacing: -11, lineHeight: 1, color: INK, textShadow: HALO }}>
          {hero.figure}
        </div>
        {hero.unit && (
          <div
            style={{
              display: 'flex',
              fontFamily: SANS,
              fontSize: 140,
              fontWeight: 600,
              letterSpacing: -4,
              lineHeight: 1,
              marginLeft: 10,
              marginBottom: 12,
              color: lighten(accent, 0.1),
              textShadow: HALO,
            }}
          >
            {hero.unit}
          </div>
        )}
      </Row>
      <div style={{ display: 'flex', marginTop: 4, fontFamily: SANS, fontSize: 44, fontWeight: 500, color: INK, textShadow: HALO }}>
        {periodPhrase(data.range)}
      </div>

      <img src={svgUri(skyline.svg)} width={skyline.width} height={skyline.height} style={{ marginTop: 18 }} alt="" />

      <Row style={{ marginTop: 22, gap: 26, justifyContent: 'center', flexWrap: 'wrap' }}>
        {shown.map((model) => (
          <Row key={model.name} style={{ gap: 12 }}>
            <ModelMark model={model} size={38} ink={INK} />
            <div style={{ display: 'flex', fontFamily: SANS, fontSize: 30, fontWeight: 600, color: INK, textShadow: HALO }}>{shortName(model.name, 22)}</div>
            <div style={{ display: 'flex', fontFamily: SANS, fontSize: 30, fontWeight: 500, color: 'rgba(255,255,255,0.78)', textShadow: HALO }}>
              {shareLabel(model.share)}
            </div>
          </Row>
        ))}
        {rest && (
          <div style={{ display: 'flex', fontFamily: SANS, fontSize: 30, fontWeight: 500, color: 'rgba(255,255,255,0.78)', textShadow: HALO }}>
            +{rest.count} more
          </div>
        )}
      </Row>

      <Row style={{ marginTop: 34, gap: 64, justifyContent: 'center' }}>
        {stats.map((stat) => (
          <Column key={stat.label} style={{ alignItems: 'center', gap: 2 }}>
            <div style={{ display: 'flex', fontFamily: SANS, fontSize: 28, fontWeight: 500, color: 'rgba(255,255,255,0.82)', textShadow: HALO }}>{stat.label}</div>
            <div style={{ display: 'flex', fontFamily: SANS, fontSize: stat.value.length <= 9 ? 56 : 46, fontWeight: 600, letterSpacing: -1.5, color: INK, textShadow: HALO, whiteSpace: 'nowrap' }}>
              {stat.value}
            </div>
          </Column>
        ))}
      </Row>
      <div style={{ display: 'flex', marginTop: 26, fontFamily: SANS, fontSize: 28, fontWeight: 500, color: 'rgba(255,255,255,0.82)', textShadow: HALO }}>
        @{shortHandle(data.handle, 30)}
        {data.demo ? ' · sample data' : ''}
      </div>
      <div style={{ display: 'flex', marginTop: 6, fontFamily: MONO, fontSize: 26, fontWeight: 500, color: 'rgba(255,255,255,0.82)', textShadow: HALO }}>{cta}</div>
    </Column>
  );
}
