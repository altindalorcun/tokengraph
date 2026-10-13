export { longDate, shortDate } from '../dates.js';

/** Cuts `text` to `width` columns, ending in `…` when it was shortened. */
export function truncate(text: string, width: number): string {
  const chars = [...text];
  if (width <= 0) return '';
  if (chars.length <= width) return text;
  return width === 1 ? '…' : `${chars.slice(0, width - 1).join('')}…`;
}
