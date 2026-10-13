/** Tiny colour helpers for the story cards, which are drawn outside the browser (no color-mix there). */

function channels(hex: string): [number, number, number] {
  const value = hex.replace('#', '');
  const full = value.length === 3 ? [...value].map((c) => c + c).join('') : value;
  return [0, 2, 4].map((i) => Number.parseInt(full.slice(i, i + 2), 16)) as [number, number, number];
}

function toHex(rgb: readonly number[]): string {
  return `#${rgb.map((c) => Math.round(Math.min(255, Math.max(0, c))).toString(16).padStart(2, '0')).join('')}`;
}

/** `amount` of the way from `a` to `b`, in sRGB. */
export function mix(a: string, b: string, amount: number): string {
  const ca = channels(a);
  const cb = channels(b);
  return toHex(ca.map((c, i) => c + (cb[i]! - c) * amount));
}

export function darken(hex: string, amount: number): string {
  return mix(hex, '#000000', amount);
}

export function lighten(hex: string, amount: number): string {
  return mix(hex, '#ffffff', amount);
}

/** `rgba()` for a hex colour, for gradients that fade a hue to nothing. */
export function alpha(hex: string, opacity: number): string {
  const [r, g, b] = channels(hex);
  return `rgba(${r}, ${g}, ${b}, ${opacity})`;
}
