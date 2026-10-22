import { FAMILY_LABELS, MODEL_FAMILIES, type ModelFamily } from '@tokengraph/core';
import { RANGE_LABELS, familyBuckets, modelBreakdown, rangeBuckets } from '../model.js';
import type { Rect, ScreenBuffer } from '../screen.js';
import { familyColor } from '../theme.js';
import { drawColumnChart } from './chart.js';
import type { TableState, ViewProps, ViewResult } from './props.js';
import { drawBreakdownTable } from './table.js';

/** Models ranked by weighted tokens for the selected range, each in its family colour, with the range's usage stacked by family below. */
export function drawModels(buf: ScreenBuffer, rect: Rect, props: ViewProps & { state: TableState }): ViewResult {
  const { vm, theme, state } = props;
  return drawBreakdownTable(buf, rect, props, {
    label: 'MODEL',
    rows: modelBreakdown(vm, state.range),
    color: (row) => familyColor(row.family, theme),
    extras: true,
    chart: (view, area) => {
      const buckets = familyBuckets(vm, rangeBuckets(vm, state.range));
      const present = new Set<ModelFamily>(buckets.flatMap((b) => b.families.map((f) => f.family)));
      drawColumnChart(view, area, theme, {
        title: `TOKENS BY MODEL FAMILY · ${RANGE_LABELS[state.range].toUpperCase()}`,
        columns: buckets.map((b) => ({
          label: b.bucket.label,
          segments: b.families.map((f) => ({ value: f.weighted, color: familyColor(f.family, theme), key: f.family })),
        })),
        legend: MODEL_FAMILIES.filter((family) => present.has(family)).map((family) => ({ text: FAMILY_LABELS[family], color: familyColor(family, theme), key: family })),
      });
    },
  });
}
