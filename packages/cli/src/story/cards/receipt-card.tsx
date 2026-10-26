import {
  backdropSvg,
  barcodeSvg,
  CACHE_READ_WEIGHT,
  costLabel,
  FAMILY_RAMPS,
  fitFont,
  formatTokens,
  formatTokensExact,
  heatmapSvg,
  logoLockupSvg,
  periodDateLabel,
  shareLabels,
  shortHandle,
  svgUri,
  topModels,
  zigzagSvg,
} from '@tokengraph/core';
import { Column, MONO, Row } from '../parts.js';
import type { CardContext } from './context.js';

const W = 1080;
const H = 1920;
const PAPER = '#f5f2ea';
const INK = '#23211d';
const FADED = '#6f6a60';
const RECEIPT_WIDTH = 800;
const TEXT = 30;
/** Characters across the receipt at TEXT px of Plex Mono (0.6em advance), inside its padding. */
const COLUMNS = 37;

function dayOfYear(date: string): number {
  const d = Date.parse(`${date}T00:00:00Z`);
  return Math.floor((d - Date.UTC(new Date(d).getUTCFullYear(), 0, 1)) / 86_400_000) + 1;
}

function Line({ left, right, size = TEXT, weight = 500, color = INK }: { left: string; right?: string; size?: number; weight?: number; color?: string }) {
  return (
    <Row style={{ justifyContent: 'space-between', fontFamily: MONO, fontSize: size, fontWeight: weight, color, lineHeight: 1.35 }}>
      <div style={{ display: 'flex', whiteSpace: 'pre' }}>{left}</div>
      {right !== undefined && <div style={{ display: 'flex' }}>{right}</div>}
    </Row>
  );
}

function Rule({ char = '-' }: { char?: string }) {
  return (
    <div style={{ display: 'flex', fontFamily: MONO, fontSize: TEXT, fontWeight: 400, color: FADED, lineHeight: 1.1, margin: '14px 0' }}>
      {char.repeat(COLUMNS)}
    </div>
  );
}

const clip = (text: string, length: number) => (text.length > length ? `${text.slice(0, length - 1)}…` : text);

const TITLES = { today: 'DAILY TOKEN BURN', '7d': 'WEEKLY TOKEN BURN', '30d': 'MONTHLY TOKEN BURN', '1y': 'YEARLY TOKEN BURN' } as const;

/**
 * A thermal-printer receipt for the period: every model a line item, the token types underneath
 * with cache reads "discounted" to a tenth (the weighting, spelled out), and the weighted total at
 * the bottom. The barcode is Code 128 for the call to action.
 */
export function ReceiptCard({ data, showCost, cta }: CardContext) {
  const ramp = FAMILY_RAMPS[data.family];
  const { shown, rest } = topModels(data.models, 6);
  // Every model is on the receipt, so its percentages add up to 100.
  const labels = shareLabels([...shown.map((model) => model.share), ...(rest ? [rest.share] : [])]);
  const cost = showCost ? costLabel(data.cost) : null;
  // The sample account is nobody's handle.
  const profile = data.demo ? 'SAMPLE ACCOUNT' : `@${shortHandle(data.handle, 30)}`;
  const barcode = barcodeSvg(data.demo ? 'TOKENGRAPH SAMPLE' : cta, 90, 2, INK);
  const types = [
    ['INPUT', data.counts.inputTokens],
    ['OUTPUT', data.counts.outputTokens],
    ['CACHE WRITE', data.counts.cacheCreationTokens],
    ['CACHE READ', data.counts.cacheReadTokens],
  ] as const;
  // Exact digits, so the lines add up to the total as printed (rounded to one decimal they can be off by 100K).
  const discount = Math.round(data.counts.cacheReadTokens * (1 - CACHE_READ_WEIGHT));
  // The person's own recent weeks, huge and tilted, as the table the receipt lies on.
  const table = heatmapSvg(data.weeks, 118, 16, (family, level) => (level === 0 ? '#1c1a19' : (FAMILY_RAMPS[family ?? 'other'][Math.max(2, level)] ?? '#1c1a19')));

  return (
    <div
      style={{
        display: 'flex',
        position: 'relative',
        width: W,
        height: H,
        alignItems: 'center',
        justifyContent: 'center',
        background: '#0c0b0a',
      }}
    >
      <img
        src={svgUri(table.svg)}
        width={table.width}
        height={table.height}
        style={{ position: 'absolute', left: (W - table.width) / 2, top: (H - table.height) / 2, transform: 'rotate(-14deg) scale(1.45)', opacity: 1 }}
        alt=""
      />
      <img
        src={svgUri(
          backdropSvg(W, H, [
            { kind: 'radial', cx: 0.5, cy: 0, rx: 0.7, ry: 0.4, stops: [[ramp[4], 0.45, 0], [ramp[4], 0, 1]] },
            { kind: 'radial', cx: 0.5, cy: 0.5, rx: 0.8, ry: 0.55, stops: [['#0c0b0a', 0, 0], ['#0c0b0a', 0.2, 0.55], ['#0c0b0a', 0.78, 1]] },
            // The paper's shadow, as a gradient: a blurred box-shadow costs seconds to rasterise.
            { kind: 'radial', cx: 0.5, cy: 0.53, rx: 0.5, ry: 0.46, stops: [['#000000', 0.55, 0], ['#000000', 0.35, 0.6], ['#000000', 0, 1]] },
          ]),
        )}
        width={W}
        height={H}
        style={{ position: 'absolute', top: 0, left: 0 }}
        alt=""
      />
      <Column style={{ width: RECEIPT_WIDTH, transform: 'rotate(-2.2deg) scale(0.92)', marginTop: -10 }}>
        <img src={svgUri(zigzagSvg(RECEIPT_WIDTH, 28, PAPER, 'up'))} width={RECEIPT_WIDTH} height={14} alt="" />
        <Column
          style={{
            background: PAPER,
            padding: '44px 66px 40px',
          }}
        >
          <Column style={{ alignItems: 'center', gap: 18 }}>
            <img src={svgUri(logoLockupSvg('light'))} height={58} width={Math.round((58 * 189.82) / 49.36)} alt="" />
            <div style={{ display: 'flex', fontFamily: MONO, fontSize: TEXT, fontWeight: 600, color: INK, letterSpacing: 4 }}>{TITLES[data.range]}</div>
            <Column style={{ alignItems: 'center', fontFamily: MONO, fontSize: 24, fontWeight: 400, color: FADED, gap: 2 }}>
              <div style={{ display: 'flex' }}>{`${periodDateLabel(data.startDate, data.endDate).toUpperCase()} · DAY ${dayOfYear(data.endDate)}`}</div>
              <div style={{ display: 'flex' }}>{`CUSTOMER @${shortHandle(data.handle, 30).toUpperCase()}`}</div>
            </Column>
          </Column>

          <Rule />
          <Line left="QTY  ITEM" right="TOKENS" size={24} weight={400} color={FADED} />
          <Column style={{ gap: 4, marginTop: 6 }}>
            {shown.map((model, index) => (
              <Line key={model.name} left={`${labels[index]!.padEnd(5)}${clip(model.name.toUpperCase(), 21)}`} right={formatTokens(model.weighted)} />
            ))}
            {rest && <Line left={`${labels[shown.length]!.padEnd(5)}+${rest.count} MORE`} right={formatTokens(rest.weighted)} />}
          </Column>

          <Rule />
          <Column style={{ gap: 2 }}>
            {types.map(([label, value]) => (
              <Line key={label} left={label} right={formatTokensExact(value)} size={26} weight={400} />
            ))}
            <Line left="  CACHE READ @ 0.1×" right={`${discount > 0 ? '-' : ''}${formatTokensExact(discount)}`} size={26} weight={400} color={FADED} />
          </Column>

          <Rule char="=" />
          <Row style={{ justifyContent: 'space-between', alignItems: 'flex-end' }}>
            <Column>
              <div style={{ display: 'flex', fontFamily: MONO, fontSize: 44, fontWeight: 600, color: INK }}>TOTAL</div>
              <div style={{ display: 'flex', fontFamily: MONO, fontSize: 22, fontWeight: 400, color: FADED }}>WEIGHTED TOKENS</div>
            </Column>
            <div style={{ display: 'flex', fontFamily: MONO, fontSize: 76, fontWeight: 600, color: INK, letterSpacing: -2, lineHeight: 1 }}>
              {formatTokens(data.total)}
            </div>
          </Row>
          <Column style={{ gap: 2, marginTop: 20 }}>
            {cost && <Line left="EST. API COST" right={cost} size={26} weight={500} />}
            {data.streak > 0 && <Line left="CURRENT STREAK" right={`${data.streak} ${data.streak === 1 ? 'DAY' : 'DAYS'}`} size={26} weight={500} />}
            {data.highlight && data.highlight.kind !== 'streak' && (
              <Line left="ACHIEVEMENT" right={data.highlight.label.toUpperCase()} size={26} weight={600} />
            )}
          </Column>

          <Rule />
          <Column style={{ alignItems: 'center', gap: 12, marginTop: 6 }}>
            <img src={svgUri(barcode.svg)} width={Math.min(barcode.width, RECEIPT_WIDTH - 132)} height={84} alt="" />
            <div style={{ display: 'flex', fontFamily: MONO, fontSize: fitFont(profile, RECEIPT_WIDTH - 140, 22), fontWeight: 400, color: FADED, whiteSpace: 'nowrap' }}>{profile}</div>
            <div style={{ display: 'flex', fontFamily: MONO, fontSize: fitFont(cta, RECEIPT_WIDTH - 140, 30), fontWeight: 600, color: INK, whiteSpace: 'nowrap', letterSpacing: 1 }}>{cta}</div>
            <div style={{ display: 'flex', fontFamily: MONO, fontSize: 26, fontWeight: 600, color: INK, marginTop: 14, letterSpacing: 2 }}>
              THANK YOU FOR BURNING
            </div>
            {data.demo && <div style={{ display: 'flex', fontFamily: MONO, fontSize: 22, fontWeight: 400, color: FADED }}>* SAMPLE DATA *</div>}
          </Column>
        </Column>
        <img src={svgUri(zigzagSvg(RECEIPT_WIDTH, 28, PAPER, 'down'))} width={RECEIPT_WIDTH} height={14} alt="" />
      </Column>
    </div>
  );
}
