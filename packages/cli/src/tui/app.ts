import type { Theme } from '@tokengraph/core';
import type { CollectProgress, LocalCollection } from '../collect-local.js';
import type { Ledger } from '../ledger.js';
import { easeOutCubic, MotionController } from './animate.js';
import { actionItems, type ActionId, type SetupStatus } from './actions.js';
import { initialState, reduce, requestAction, withViewModel, type AppState, type Effect } from './app-state.js';
import type { AutoSyncStatus } from './auto-sync.js';
import { mix, type ColorDepth } from './color.js';
import { renderFrame, type FrameHits } from './frame.js';
import type { InputEvent } from './input.js';
import { buildViewModel, shiftDate } from './model.js';
import { ScreenBuffer, diff } from './screen.js';
import type { Terminal } from './terminal.js';
import { tuiTheme } from './theme.js';
import { drawFlame } from './widgets/logo.js';

export * from './app-state.js';
export * from './frame.js';

export interface AppDeps {
  terminal: Terminal;
  depth: ColorDepth;
  theme: Theme;
  motion: boolean;
  live: boolean;
  /** Milliseconds on any monotonic base; scan times and the motion clock share it. */
  clock: () => number;
  /** Date key in the local time zone. */
  today: () => string;
  loadLedger: () => Promise<Ledger>;
  scan: (ledger: Ledger, since: Date, onProgress: (p: CollectProgress) => void) => Promise<LocalCollection>;
  persist: (ledger: Ledger) => Promise<'saved' | 'busy'>;
  /** 'local only' | '↑ publishing as @user' */
  modeLabel: () => Promise<string>;
  autoSync: () => Promise<AutoSyncStatus>;
  /** Returns a cancel function. */
  setTimer: (fn: () => void, ms: number) => () => void;
  /** Config and installed hooks, for the action list. */
  setupStatus: () => Promise<SetupStatus>;
  /** Runs a tokengraph command; `screen` ones print and prompt on the real terminal. */
  runAction: (id: ActionId, kind: 'inline' | 'screen', status: SetupStatus | null) => Promise<{ code: number; lines: string[] }>;
  /** Resolves when the person presses Enter on the normal screen. */
  waitForEnter: () => Promise<void>;
  /** Writes to the normal screen while the terminal is suspended. */
  write: (text: string) => void;
  /** Test hook: hands over the means to request an action, as the setup tab and palette will. */
  onReady?: (controls: { request: (id: ActionId) => void }) => void;
  /** Test hook: called with every composed frame before it is diffed and written. */
  onFrame?: (buffer: ScreenBuffer) => void;
}

const FIRST_SCAN_DAYS = 400;
const LIVE_SCAN_DAYS = 2;
const FRAME_MS = 16;
const TICK_MS = 1000;
const SAMPLE_WINDOW_MS = 15 * 60_000;
const MIN_SAMPLE_SPAN_MS = 30_000;
const PERSIST_GRACE_MS = 2000;
const FLAME_WIDTH = 8;
const FLAME_HEIGHT = 6;
const ANSI = /\x1b\[[0-9;]*m/g;

/** Local midnight `days` before the date key. */
function sinceDate(today: string, days: number): Date {
  return new Date(`${shiftDate(today, -days)}T00:00:00`);
}

/** The centred flame filling in, with the wordmark fading up beneath it. */
function splashBuffer(deps: AppDeps, width: number, height: number, progress: number): ScreenBuffer {
  const theme = tuiTheme(deps.theme);
  const buf = new ScreenBuffer(width, height, { fg: theme.ink, bg: theme.bg });
  const top = Math.max(0, Math.floor((height - FLAME_HEIGHT - 2) / 2));
  drawFlame(buf, Math.floor((width - FLAME_WIDTH) / 2), top, theme.bg, easeOutCubic(progress));
  const name = 'tokengraph';
  buf.text(Math.floor((width - name.length) / 2), top + FLAME_HEIGHT + 1, name, {
    fg: mix(theme.bg, theme.ink, progress),
    bold: true,
  });
  return buf;
}

/** Runs until the user quits; resolves with the exit code. Always restores the terminal. */
export async function runApp(deps: AppDeps): Promise<number> {
  const { terminal } = deps;
  let restored = false;
  const restore = (): void => {
    if (restored) return;
    restored = true;
    terminal.restore();
  };
  const cancels = new Set<() => void>();
  try {
    const loaded = await deps.loadLedger();
    return await new Promise<number>((resolve, reject) => {
      let ledger = loaded;
      let state: AppState = initialState(buildViewModel(ledger, deps.today()), '…', deps.live);
      const motion = new MotionController({ enabled: deps.motion, clock: deps.clock });
      let prev: ScreenBuffer | null = null;
      let hits: FrameHits | null = null;
      let finished = false;
      let intro = deps.motion;
      let animating = false;
      let frameTimer: (() => void) | null = null;
      let scanning = false;
      let nextScan: (() => void) | null = null;
      let samples: { t: number; weighted: number }[] = [];
      let persisting: Promise<unknown> | null = null;
      let scanTask: Promise<void> = Promise.resolve();

      const finish = (code: number | Error): void => {
        if (finished) return;
        finished = true;
        for (const cancel of cancels) cancel();
        cancels.clear();
        restore();
        if (typeof code !== 'number') return reject(code);
        // Let a ledger write that is already under way finish, so exiting cannot strand a .tmp file or the sync lock.
        const writing = persisting;
        if (!writing) return resolve(code);
        let timer: ReturnType<typeof setTimeout> | undefined;
        const timeout = new Promise<void>((done) => { timer = setTimeout(done, PERSIST_GRACE_MS); });
        void Promise.race([writing.then(() => {}, () => {}), timeout]).then(() => {
          clearTimeout(timer);
          resolve(code);
        });
      };
      const guard = <A extends unknown[]>(fn: (...args: A) => void) => (...args: A): void => {
        if (finished) return;
        try {
          fn(...args);
        } catch (error) {
          finish(error instanceof Error ? error : new Error(String(error)));
        }
      };
      const after = (fn: () => void, ms: number): (() => void) => {
        const cancel = deps.setTimer(guard(() => { cancels.delete(cancel); fn(); }), ms);
        cancels.add(cancel);
        return cancel;
      };
      const cancelTimer = (cancel: (() => void) | null): void => {
        if (!cancel) return;
        cancel();
        cancels.delete(cancel);
      };

      const paint = (): void => {
        const width = terminal.width;
        const height = terminal.height;
        let motionFrame = motion.frame();
        let buffer: ScreenBuffer;
        if (intro && motionFrame.splash < 1) {
          buffer = splashBuffer(deps, width, height, motionFrame.splash);
          hits = null;
        } else {
          if (intro) {
            // The splash just ended: the heatmap reveal starts now, not behind the splash.
            intro = false;
            motion.startReveal();
            motionFrame = motion.frame();
          }
          const frame = renderFrame(state, { theme: deps.theme }, width, height, motionFrame);
          buffer = frame.buffer;
          hits = frame.hits;
        }
        deps.onFrame?.(buffer);
        const out = diff(prev, buffer, deps.depth);
        if (out) terminal.write(out);
        prev = buffer;
      };

      const draw = (): void => {
        cancelTimer(frameTimer);
        frameTimer = null;
        paint();
        if (motion.active()) {
          animating = true;
          frameTimer = after(draw, FRAME_MS);
        } else if (animating) {
          // One last frame so the settled values reach the screen.
          animating = false;
          paint();
        }
      };

      const tick = (): void => {
        draw();
        after(tick, TICK_MS);
      };

      const todayWeighted = (): number => state.vm.byDate.get(state.vm.today)?.weighted ?? 0;

      /** Records a burn-rate sample after a scan; the rate is shown only once two samples are 30 s apart. */
      const sample = (): void => {
        const now = deps.clock();
        samples.push({ t: now, weighted: todayWeighted() });
        samples = samples.filter((s) => s.t >= now - SAMPLE_WINDOW_MS);
        const first = samples[0]!;
        const last = samples[samples.length - 1]!;
        const span = last.t - first.t;
        const rate = samples.length >= 2 && span >= MIN_SAMPLE_SPAN_MS ? (last.weighted - first.weighted) / (span / 60_000) : 0;
        state = { ...state, burnRate: rate > 0 ? rate : null };
      };

      const scanOnce = async (days: number): Promise<void> => {
        if (scanning || finished || state.running !== null) return;
        scanning = true;
        cancelTimer(nextScan);
        nextScan = null;
        const started = deps.clock();
        state = { ...state, scan: { ...state.scan, running: true, current: null, done: 0, total: 0 } };
        draw();
        try {
          const today = deps.today();
          // A paint error here is an app bug, not an adapter failure: route it to finish instead of into collectLocal.
          const result = await deps.scan(ledger, sinceDate(today, days), guard((p: CollectProgress) => {
            const scan = { ...state.scan };
            if (p.state === 'scanning') {
              scan.current = p.adapter;
              scan.total = Math.max(scan.total, scan.done + 1);
            } else {
              scan.done += 1;
            }
            state = { ...state, scan };
            draw();
          }));
          if (finished) return;
          const before = todayWeighted();
          ledger = result.ledger;
          const vm = buildViewModel(ledger, today);
          state = { ...withViewModel(state, vm), detected: result.detected, empty: vm.days.length === 0 && result.detected.length === 0 };
          if (todayWeighted() > before) motion.pulseToday();
          const [first] = result.failures;
          let note: string | null = first
            ? `${first.adapter} could not be read${result.failures.length > 1 ? ` +${result.failures.length - 1} more` : ''}`
            : null;
          try {
            const writing = deps.persist(ledger);
            persisting = writing;
            try {
              if ((await writing) === 'busy') note = 'ledger busy — not saved';
            } finally {
              if (persisting === writing) persisting = null;
            }
          } catch (error) {
            note = error instanceof Error ? error.message : String(error);
          }
          if (finished) return;
          sample();
          state = { ...state, scan: { ...state.scan, note } };
        } catch (error) {
          if (finished) return;
          state = { ...state, scan: { ...state.scan, note: error instanceof Error ? error.message : String(error) } };
        } finally {
          scanning = false;
        }
        if (finished) return;
        const lastScanMs = deps.clock() - started;
        state = { ...state, scan: { ...state.scan, running: false, current: null, lastScanAt: deps.clock() } };
        if (deps.live) {
          nextScan = after(() => startScan(LIVE_SCAN_DAYS), Math.min(60_000, Math.max(5000, 10 * lastScanMs)));
        }
        draw();
      };

      // scanOnce handles its own failures; this only catches a bug in drawing so it cannot become an unhandled rejection.
      const startScan = (days: number): void => {
        if (scanning || finished || state.running !== null) return;
        scanTask = scanOnce(days).catch((error: unknown) => finish(error instanceof Error ? error : new Error(String(error))));
      };

      /** Carries out reducer effects; false once the app has quit. */
      const applyEffects = (effects: Effect[]): boolean => {
        for (const effect of effects) {
          if (effect === 'quit') return finish(0), false;
          if (effect === 'rescan') startScan(LIVE_SCAN_DAYS);
          else if (effect === 'bars') motion.startBars();
          else if (effect === 'wipe') motion.startWipe();
          else if (typeof effect === 'object') void execute(effect.run);
        }
        return true;
      };

      const refreshSetup = async (): Promise<void> => {
        try {
          const setup = await deps.setupStatus();
          if (!finished) state = { ...state, setup };
        } catch {
          // Keep the last known status; the action list shows unknown states without one.
        }
      };

      /** Re-reads what an action may have changed: the ledger (screen actions), the mode pill, the hooks and the config. */
      const reload = async (ledgerChanged: boolean): Promise<void> => {
        if (ledgerChanged) {
          try {
            ledger = await deps.loadLedger();
            if (!finished) state = withViewModel(state, buildViewModel(ledger, deps.today()));
          } catch {
            // The in-memory ledger stays; the next scan merges into it.
          }
        }
        await Promise.all([
          refreshSetup(),
          deps.modeLabel().then((mode) => { if (!finished) state = { ...state, mode }; }, () => {}),
          deps.autoSync().then((autoSync) => { if (!finished) state = { ...state, autoSync }; }, () => {}),
        ]);
      };

      const toast = (text: string, tone: 'good' | 'bad'): void => {
        state = { ...state, toast: { text, tone, at: deps.clock() } };
      };

      const errorText = (error: unknown): string => (error instanceof Error ? error.message : String(error));

      /** Hands the terminal to a command: normal screen, its output, then a pause so the output can be read. */
      const runOnScreen = async (id: ActionId, title: string): Promise<void> => {
        terminal.suspend();
        try {
          deps.write(`\n› ${title}\n\n`);
          let code: number;
          try {
            ({ code } = await deps.runAction(id, 'screen', state.setup));
          } catch (error) {
            deps.write(`${errorText(error)}\n`);
            toast(errorText(error), 'bad');
            code = -1;
          }
          if (code > 0) toast(`${title} did not finish`, 'bad');
          deps.write('\nPress Enter to return to tokengraph.');
          await deps.waitForEnter();
        } finally {
          terminal.resume();
          prev = null;
        }
      };

      /** Runs one action. Waits for a scan or ledger write in flight first, so it never meets the sync lock held by us. */
      const execute = async (id: ActionId): Promise<void> => {
        if (state.running !== null || finished) return;
        const item = actionItems(state.setup, state.vm.sources).find((candidate) => candidate.id === id);
        const kind = item?.kind ?? 'screen';
        state = { ...state, running: id };
        draw();
        let ledgerChanged = false;
        try {
          cancelTimer(nextScan);
          nextScan = null;
          while (scanning) await scanTask;
          await persisting?.catch(() => {});
          if (finished) return;
          if (kind === 'inline') {
            const { code, lines } = await deps.runAction(id, 'inline', state.setup);
            const last = lines.map((line) => line.replace(ANSI, '').trim()).filter(Boolean).at(-1);
            toast(last ?? (code === 0 ? 'Done.' : 'Failed.'), code === 0 ? 'good' : 'bad');
          } else {
            ledgerChanged = true;
            await runOnScreen(id, item?.title ?? id);
          }
        } catch (error) {
          if (!finished) toast(errorText(error), 'bad');
        }
        if (finished) return;
        await reload(ledgerChanged);
        if (finished) return;
        state = { ...state, running: null };
        draw();
        startScan(LIVE_SCAN_DAYS);
      };

      const onInput = guard((events: InputEvent[]): void => {
        // An Alt+key chord arrives as an escape immediately followed by the key; the escape alone must not quit.
        const list = events.filter((event, i) => !(event.type === 'key' && event.key === 'escape' && i < events.length - 1));
        if (intro) {
          motion.skip();
          intro = false;
        }
        for (const event of list) {
          const out = reduce(state, event, hits);
          state = out.state;
          if (!applyEffects(out.effects)) return;
        }
        draw();
      });

      terminal.onInput(onInput);
      deps.onReady?.({
        request: guard((id: ActionId) => {
          const out = requestAction(state, id);
          state = out.state;
          if (applyEffects(out.effects)) draw();
        }),
      });
      terminal.onResize(guard(() => {
        prev = null;
        draw();
      }));

      motion.startSplash();
      draw();
      void refreshSetup();
      after(tick, TICK_MS);
      deps.modeLabel().then(
        guard((mode) => {
          state = { ...state, mode };
          draw();
        }),
        guard(() => {
          state = { ...state, mode: 'local only' };
          draw();
        }),
      );
      deps.autoSync().then(
        guard((autoSync) => {
          state = { ...state, autoSync };
          draw();
        }),
        () => {},
      );
      startScan(FIRST_SCAN_DAYS);
    });
  } finally {
    for (const cancel of cancels) cancel();
    restore();
  }
}
