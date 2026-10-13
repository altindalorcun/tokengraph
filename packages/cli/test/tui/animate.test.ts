import { describe, expect, it } from 'vitest';
import { MotionController, STILL, clamp01, easeInOutSine, easeOutCubic } from '../../src/tui/animate.js';

function clock(start = 1000) {
  let now = start;
  return { now: () => now, advance: (ms: number) => (now += ms) };
}

describe('easing', () => {
  it('maps 0→0 and 1→1', () => {
    for (const ease of [easeOutCubic, easeInOutSine]) {
      expect(ease(0)).toBeCloseTo(0);
      expect(ease(1)).toBeCloseTo(1);
    }
    expect(clamp01(-2)).toBe(0);
    expect(clamp01(3)).toBe(1);
    expect(easeOutCubic(0.5)).toBeCloseTo(0.875);
  });
});

describe('MotionController', () => {
  it('reveals the heatmap in a diagonal wave', () => {
    const c = clock();
    const motion = new MotionController({ enabled: true, clock: c.now });
    motion.startReveal();
    expect(motion.frame().cell(0, 0)).toBe(0);
    c.advance(125);
    expect(motion.frame().cell(0, 0)).toBeCloseTo(0.5);
    expect(motion.frame().cell(10, 0)).toBeCloseTo(0.02); // delay 120 ms, only 5 ms in
    c.advance(10_000);
    expect(motion.frame().cell(51, 6)).toBe(1);
    expect(motion.active()).toBe(false);
  });

  it('rolls odometers from zero, then from the shown value', () => {
    const c = clock();
    const motion = new MotionController({ enabled: true, clock: c.now });
    expect(motion.frame().number('today', 1000)).toBe(0);
    expect(motion.active()).toBe(true);
    c.advance(600);
    expect(motion.frame().number('today', 1000)).toBe(1000);
    expect(motion.frame().number('today', 2000)).toBe(1000);
    c.advance(300);
    const mid = motion.frame().number('today', 2000);
    expect(mid).toBeGreaterThan(1000);
    expect(mid).toBeLessThan(2000);
  });

  it('pulses and settles', () => {
    const c = clock();
    const motion = new MotionController({ enabled: true, clock: c.now });
    motion.pulseToday();
    expect(motion.frame().pulse).toBe(1);
    c.advance(1200);
    expect(motion.frame().pulse).toBe(0);
  });

  it('skip finishes everything at once', () => {
    const c = clock();
    const motion = new MotionController({ enabled: true, clock: c.now });
    motion.startSplash();
    motion.startReveal();
    motion.skip();
    const frame = motion.frame();
    expect(frame.splash).toBe(1);
    expect(frame.cell(40, 3)).toBe(1);
  });

  it('is still when disabled', () => {
    const motion = new MotionController({ enabled: false });
    motion.startSplash();
    motion.startReveal();
    motion.pulseToday();
    const frame = motion.frame();
    expect(frame.splash).toBe(1);
    expect(frame.cell(0, 0)).toBe(1);
    expect(frame.number('x', 42)).toBe(42);
    expect(frame.pulse).toBe(0);
    expect(motion.active()).toBe(false);
    expect(STILL.bar(3)).toBe(1);
  });

  it('reads as settled before any animation was started', () => {
    const motion = new MotionController({ enabled: true, clock: clock().now });
    const frame = motion.frame();
    expect(frame.cell(5, 5)).toBe(1);
    expect(frame.bar(2)).toBe(1);
    expect(frame.wipe).toBe(1);
    expect(frame.splash).toBe(1);
    expect(frame.pulse).toBe(0);
    expect(motion.active()).toBe(false);
  });

  it('grows bars with a per-row stagger and then settles', () => {
    const c = clock();
    const motion = new MotionController({ enabled: true, clock: c.now });
    motion.startBars();
    expect(motion.frame().bar(0)).toBe(0);
    c.advance(200);
    expect(motion.frame().bar(0)).toBeCloseTo(0.875);
    expect(motion.frame().bar(2)).toBeCloseTo(easeOutCubic(140 / 400));
    expect(motion.frame().bar(10)).toBeCloseTo(0); // delay 300 ms, not started yet
    c.advance(400 + 30 * 40);
    expect(motion.frame().bar(39)).toBe(1);
    expect(motion.active()).toBe(false);
  });

  it('runs the splash and the tab wipe, active until they finish', () => {
    const c = clock();
    const motion = new MotionController({ enabled: true, clock: c.now });
    motion.startSplash();
    motion.startWipe();
    expect(motion.frame().splash).toBe(0);
    expect(motion.frame().wipe).toBe(0);
    expect(motion.active()).toBe(true);
    c.advance(150);
    expect(motion.frame().wipe).toBe(1);
    expect(motion.frame().splash).toBeCloseTo(150 / 900);
    expect(motion.active()).toBe(true);
    c.advance(750);
    expect(motion.frame().splash).toBe(1);
    expect(motion.active()).toBe(false);
  });

  it('does not restart a roll when the target is unchanged, and skip settles odometers', () => {
    const c = clock();
    const motion = new MotionController({ enabled: true, clock: c.now });
    motion.frame().number('a', 500);
    c.advance(300);
    const midway = motion.frame().number('a', 500);
    expect(midway).toBeGreaterThan(0);
    expect(midway).toBeLessThan(500);
    c.advance(300);
    expect(motion.frame().number('a', 500)).toBe(500);
    motion.frame().number('a', 900);
    expect(motion.active()).toBe(true);
    motion.skip();
    expect(motion.frame().number('a', 900)).toBe(900);
    expect(motion.active()).toBe(false);
  });

  it('keeps frame.now on the clock', () => {
    const c = clock(5000);
    const motion = new MotionController({ enabled: true, clock: c.now });
    expect(motion.frame().now).toBe(5000);
    c.advance(16);
    expect(motion.frame().now).toBe(5016);
  });
});
