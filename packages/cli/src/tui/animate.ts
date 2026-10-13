/** Clamp to the 0..1 range; NaN counts as 0. */
export function clamp01(t: number): number {
  return t > 0 ? (t < 1 ? t : 1) : 0;
}

/** Fast start, gentle landing. */
export function easeOutCubic(t: number): number {
  return 1 - (1 - t) ** 3;
}

/** Smooth both ends. */
export function easeInOutSine(t: number): number {
  return -(Math.cos(Math.PI * t) - 1) / 2;
}

/** What the pure views read for the current frame. */
export interface Motion {
  /** 0..1 reveal progress of heatmap cell (column, row). */
  cell(column: number, row: number): number;
  /** The value an odometer for `key` shows now, rolling towards `target`. */
  number(key: string, target: number): number;
  /** 0..1 growth of row `index` in the current bar table. */
  bar(index: number): number;
  /** 0..1 intensity of today's pulse (1 = just pulsed). */
  pulse: number;
  /** 0..1 progress of the tab wipe (columns beyond `wipe × width` are not drawn yet). */
  wipe: number;
  /** 0..1 splash progress; 1 = splash finished. */
  splash: number;
  /** Clock in ms, for spinners and the LIVE dot. */
  now: number;
}

/** Everything settled — used by --print, --no-motion and tests. */
export const STILL: Motion = {
  cell: () => 1,
  number: (_key, target) => target,
  bar: () => 1,
  pulse: 0,
  wipe: 1,
  splash: 1,
  now: 0,
};

const SPLASH_MS = 900;
const REVEAL_STEP_MS = 12;
const REVEAL_CELL_MS = 250;
// The heatmap is at most 52 columns by 7 rows, so the last cell starts at (51 + 6) steps.
const REVEAL_TOTAL_MS = (51 + 6) * REVEAL_STEP_MS + REVEAL_CELL_MS;
const BAR_STEP_MS = 30;
const BAR_MS = 400;
// Bar tables are assumed to have at most 40 rows, which bounds how long the stagger can run.
const BARS_TOTAL_MS = BAR_MS + BAR_STEP_MS * 40;
const WIPE_MS = 150;
const PULSE_MS = 1200;
const ODOMETER_MS = 600;

interface Roll {
  from: number;
  to: number;
  start: number;
}

function odometerValue(roll: Roll, now: number): number {
  return Math.round(roll.from + (roll.to - roll.from) * easeOutCubic(clamp01((now - roll.start) / ODOMETER_MS)));
}

/** Owns the animation clocks; `frame()` snapshots them for one drawn frame. */
export class MotionController {
  private readonly enabled: boolean;
  private readonly clock: () => number;
  // A null start means "never started or skipped": that animation reads as settled.
  private splashStart: number | null = null;
  private revealStart: number | null = null;
  private barsStart: number | null = null;
  private wipeStart: number | null = null;
  private pulseStart: number | null = null;
  private readonly rolls = new Map<string, Roll>();

  constructor(options: { enabled: boolean; clock?: () => number }) {
    this.enabled = options.enabled;
    this.clock = options.clock ?? (() => performance.now());
  }

  startSplash(): void {
    if (this.enabled) this.splashStart = this.clock();
  }

  startReveal(): void {
    if (this.enabled) this.revealStart = this.clock();
  }

  startBars(): void {
    if (this.enabled) this.barsStart = this.clock();
  }

  startWipe(): void {
    if (this.enabled) this.wipeStart = this.clock();
  }

  pulseToday(): void {
    if (this.enabled) this.pulseStart = this.clock();
  }

  /** Finish every running animation now (any key during the splash). */
  skip(): void {
    this.splashStart = null;
    this.revealStart = null;
    this.barsStart = null;
    this.wipeStart = null;
    this.pulseStart = null;
    for (const roll of this.rolls.values()) roll.from = roll.to;
  }

  /** Snapshot of the motion state at the current clock value; `number()` on it may start odometer rolls. */
  frame(): Motion {
    const now = this.clock();
    if (!this.enabled) return { ...STILL, now };
    const { splashStart, revealStart, barsStart, wipeStart, pulseStart } = this;
    return {
      now,
      splash: splashStart === null ? 1 : clamp01((now - splashStart) / SPLASH_MS),
      wipe: wipeStart === null ? 1 : clamp01((now - wipeStart) / WIPE_MS),
      pulse: pulseStart === null ? 0 : 1 - easeInOutSine(clamp01((now - pulseStart) / PULSE_MS)),
      cell: (column, row) =>
        revealStart === null ? 1 : clamp01((now - revealStart - (column + row) * REVEAL_STEP_MS) / REVEAL_CELL_MS),
      bar: (index) =>
        barsStart === null ? 1 : easeOutCubic(clamp01((now - barsStart - index * BAR_STEP_MS) / BAR_MS)),
      number: (key, target) => {
        const roll = this.rolls.get(key);
        if (!roll) {
          this.rolls.set(key, { from: 0, to: target, start: now });
          return 0;
        }
        if (roll.to === target) return odometerValue(roll, now);
        const shown = odometerValue(roll, now);
        this.rolls.set(key, { from: shown, to: target, start: now });
        return shown;
      },
    };
  }

  /** True while any animation or odometer is still moving — the app keeps a 60 fps loop only then. */
  active(): boolean {
    if (!this.enabled) return false;
    const now = this.clock();
    const running = (start: number | null, duration: number) => start !== null && now < start + duration;
    if (
      running(this.splashStart, SPLASH_MS) ||
      running(this.revealStart, REVEAL_TOTAL_MS) ||
      running(this.barsStart, BARS_TOTAL_MS) ||
      running(this.wipeStart, WIPE_MS) ||
      running(this.pulseStart, PULSE_MS)
    ) {
      return true;
    }
    for (const roll of this.rolls.values()) {
      if (roll.from !== roll.to && now < roll.start + ODOMETER_MS) return true;
    }
    return false;
  }
}
