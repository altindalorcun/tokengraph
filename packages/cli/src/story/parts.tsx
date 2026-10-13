import type { CSSProperties, ReactNode } from 'react';
import { makerLogoUri, shareLabel, type StoryModel, type StoryStat } from '@tokengraph/core';

/** Model ids can be long router paths; a card row fits about this many characters. */
export function shortName(name: string, max: number): string {
  return name.length > max ? `${name.slice(0, max - 1)}…` : name;
}

/**
 * Building blocks shared by the story cards. These render through Satori (next/og), not the
 * browser: every element with more than one child needs display:flex, styles are inline, and
 * there is no CSS cascade, so each piece sets its own font.
 */

export const SANS = 'Plex Sans';
export const MONO = 'Plex Mono';

export function Row({ style, children }: { style?: CSSProperties; children: ReactNode }) {
  return <div style={{ display: 'flex', flexDirection: 'row', alignItems: 'center', ...style }}>{children}</div>;
}

export function Column({ style, children }: { style?: CSSProperties; children: ReactNode }) {
  return <div style={{ display: 'flex', flexDirection: 'column', ...style }}>{children}</div>;
}

/** A model's mark, or a dot in its colour when the maker is unknown, so rows stay aligned. */
export function ModelMark({ model, size, ink }: { model: Pick<StoryModel, 'maker' | 'color'>; size: number; ink: string }) {
  const uri = makerLogoUri(model.maker, ink);
  if (uri) return <img src={uri} width={size} height={size} alt="" />;
  return (
    <div style={{ display: 'flex', width: size, height: size, alignItems: 'center', justifyContent: 'center' }}>
      <div style={{ width: size * 0.5, height: size * 0.5, borderRadius: size, background: model.color }} />
    </div>
  );
}

/** Every model as a slice of one bar, heaviest first; slivers under 0.6% are dropped so the gaps stay even. */
export function ShareStrip({ models, height, gap, track }: { models: readonly StoryModel[]; height: number; gap: number; track: string }) {
  const visible = models.filter((model) => model.share >= 0.006);
  return (
    <div style={{ display: 'flex', width: '100%', height, borderRadius: height, overflow: 'hidden', background: track }}>
      {visible.map((model, index) => (
        <div
          key={model.name}
          style={{
            display: 'flex',
            flexGrow: model.share,
            flexBasis: 0,
            height: '100%',
            background: model.color,
            marginLeft: index === 0 ? 0 : gap,
          }}
        />
      ))}
    </div>
  );
}

export interface ModelLine {
  key: string;
  label: string;
  share: number;
  maker: StoryModel['maker'];
  color: string;
}

/** Up to three named models and a "+N more" line, each with its mark, name and share. */
export function ModelList({
  lines,
  ink,
  muted,
  size,
}: {
  lines: readonly ModelLine[];
  ink: string;
  muted: string;
  size: number;
}) {
  return (
    <Column style={{ gap: size * 0.62 }}>
      {lines.map((line) => (
        <Row key={line.key} style={{ gap: size * 0.55 }}>
          <ModelMark model={{ maker: line.maker, color: line.color }} size={size * 1.1} ink={ink} />
          <div style={{ display: 'flex', flexGrow: 1, fontFamily: SANS, fontSize: size, fontWeight: 500, color: ink }}>
            {shortName(line.label, 34)}
          </div>
          <div style={{ display: 'flex', fontFamily: SANS, fontSize: size, fontWeight: 500, color: muted }}>{shareLabel(line.share)}</div>
        </Row>
      ))}
    </Column>
  );
}

/** Strava's row of three: small label over a big value, columns split by hairlines. */
export function StatRow({ stats, ink, muted, rule }: { stats: readonly StoryStat[]; ink: string; muted: string; rule: string }) {
  return (
    <Row style={{ width: '100%', alignItems: 'stretch' }}>
      {stats.map((stat, index) => (
        <Column
          key={stat.label}
          style={{
            flexGrow: 1,
            flexBasis: 0,
            gap: 8,
            paddingLeft: index === 0 ? 0 : 36,
            borderLeft: index === 0 ? 'none' : `2px solid ${rule}`,
          }}
        >
          <div style={{ display: 'flex', fontFamily: SANS, fontSize: 27, fontWeight: 400, color: muted }}>{stat.label}</div>
          <div style={{ display: 'flex', fontFamily: SANS, fontSize: stat.value.length <= 7 ? 52 : stat.value.length <= 9 ? 46 : 40, fontWeight: 600, color: ink, letterSpacing: -1.5, whiteSpace: 'nowrap' }}>
            {stat.value}
          </div>
        </Column>
      ))}
    </Row>
  );
}
