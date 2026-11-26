import type { LimitsBlock } from './views/limits.js';
import type { StoryRange, Theme } from '@tokengraph/core';
import type { CollectProgress, LocalCollection } from '../collect-local.js';
import type { Ledger } from '../ledger.js';
import type { MachineFile } from '../publish/machines.js';
import type { ProjectEdit, ProjectEditResult } from '../project-names.js';
import { easeOutCubic, MotionController } from './animate.js';
import { actionItems, type ActionId, type SetupStatus } from './actions.js';
import { initialState, reduce, requestAction, selectProject, withViewModel, type AppState, type Effect, type Scope, type ToastTone } from './app-state.js';
import type { AutoSyncStatus } from './auto-sync.js';
import { mix, type ColorDepth } from './color.js';
import { renderFrame, type FrameHits } from './frame.js';
import type { InputEvent } from './input.js';
import { buildViewModel, shiftDate } from './model.js';
import { ScreenBuffer, diff } from './screen.js';
import { applyStoryEvent, type StoryCommand } from './story-panel.js';
import type { StoryEvent, StorySession } from './story-session.js';
import { applyTaskEvent, type TaskAfter, type TaskCommand } from './task-panel.js';
import type { TaskEvent, TaskSession } from './task-session.js';
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
  /** The names the user gave projects (`tokengraph projects name`). */
  projectNames: () => Promise<Record<string, string>>;
  /**
   * Merges, renames or splits projects in the config (`editProjects` in commands/projects.ts); never touches a count.
   * Planned against the ledger the view shows, so the edit names the folders on screen.
   */
  editProjects: (edit: ProjectEdit, ledger: Ledger) => Promise<ProjectEditResult>;
  /** The home folder project names are worked out against; the real one unless a test says otherwise. */
  home?: string;
  scan: (ledger: Ledger, since: Date, onProgress: (p: CollectProgress) => void) => Promise<LocalCollection>;
  persist: (ledger: Ledger) => Promise<'saved' | 'busy'>;
  /** 'local only' | '↑ publishing as @user' */
  modeLabel: () => Promise<string>;
  autoSync: () => Promise<AutoSyncStatus>;
  /** Plan limit readings for the Overview (`tokengraph limits`); without it the Overview shows none. */
  limits?: () => Promise<LimitsBlock>;
  /** The other machines cached by the last publish (`machines.json`); never the network. Without it the view is this machine alone. */
  machines?: () => Promise<CachedMachines>;
  /** The scope the view opens in (`--this-machine` is 'this'); 'all' by default. */
  scope?: Scope;
  /** Wall clock in ms, for the age of the cached machines; `Date.now` by default. */
  now?: () => number;
  /** Returns a cancel function. */
  setTimer: (fn: () => void, ms: number) => () => void;
  /** Config and installed hooks, for the action list. */
  setupStatus: () => Promise<SetupStatus>;
  /** Asks npm for the latest version in the background; the answer arrives through `setupStatus`. */
  checkForUpdate: () => Promise<void>;
  /** Runs an `inline` action behind the view and returns its output for a toast. */
  runAction: (id: ActionId, status: SetupStatus | null) => Promise<{ code: number; lines: string[] }>;
  /** Runs a `task` action for the task box; its output, questions and end arrive through `emit`. Never writes to the terminal. */
  startTask: (id: ActionId, status: SetupStatus | null, emit: (event: TaskEvent) => void) => TaskSession;
  /** Draws and shares story cards for the story box; everything it has to say arrives through `emit`. */
  startStory: (range: StoryRange, emit: (event: StoryEvent) => void) => StorySession;
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
const SPINNER_FRAME_MS = 80; // the task box's busy line turns while a command works
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

export interface CachedMachines {
  files: MachineFile[];
  publishedAt: string | null;
}

/** The cached machines, or none when there is no reader or it fails: a broken cache never stops the view. */
async function loadMachines(deps: AppDeps): Promise<CachedMachines> {
  try {
    return (await deps.machines?.()) ?? { files: [], publishedAt: null };
  } catch {
    return { files: [], publishedAt: null };
  }
}

function machinesInfo(cached: CachedMachines): AppState['machines'] {
  return { count: cached.files.length, publishedAt: cached.publishedAt };
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
    let names = await deps.projectNames().catch(() => ({}));
    let cached = await loadMachines(deps);
    let scope: Scope = deps.scope ?? 'all';
    const viewModel = (from: Ledger) =>
      buildViewModel(from, deps.today(), { projectNames: names, home: deps.home, others: scope === 'all' ? cached.files : [] });
    return await new Promise<number>((resolve, reject) => {
      let ledger = loaded;
      let state: AppState = { ...initialState(viewModel(ledger), '…', deps.live, scope), machines: machinesInfo(cached) };
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
      // The story box's session; a closed box's late events are dropped by comparing against it.
      let story: StorySession | null = null;
      // The task box's session, the same way.
      let task: TaskSession | null = null;

      const finish = (code: number | Error): void => {
        if (finished) return;
        finished = true;
        story?.stop();
        story = null;
        task?.stop();
        task = null;
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
          const frame = renderFrame(state, { theme: deps.theme, now: (deps.now ?? Date.now)() }, width, height, motionFrame);
          buffer = frame.buffer;
          hits = frame.hits;
        }
        deps.onFrame?.(buffer);
        const out = diff(prev, buffer, deps.depth);
        if (out) terminal.write(out);
        prev = buffer;
      };

      const taskBusy = (): boolean => state.task?.status === 'running' && state.task.prompt === null;

      // A command printing many lines in a row gets one frame for them, not one per line.
      let soonTimer: (() => void) | null = null;
      const drawSoon = (): void => {
        if (!soonTimer) soonTimer = after(() => { soonTimer = null; draw(); }, 0);
      };

      const draw = (): void => {
        cancelTimer(frameTimer);
        frameTimer = null;
        cancelTimer(soonTimer);
        soonTimer = null;
        paint();
        if (motion.active()) {
          animating = true;
          frameTimer = after(draw, FRAME_MS);
        } else if (animating) {
          // One last frame so the settled values reach the screen.
          animating = false;
          paint();
        }
        if (!frameTimer && taskBusy()) frameTimer = after(draw, SPINNER_FRAME_MS);
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
          // `tokengraph projects name` may have run in another terminal since the last scan.
          names = await deps.projectNames().catch(() => names);
          if (finished) return;
          const before = todayWeighted();
          ledger = result.ledger;
          const vm = viewModel(ledger);
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
        // A scan may have found a limit hit, and readings age: read them again.
        await loadLimits();
        if (finished) return;
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
          else if (effect === 'scope') {
            scope = state.scope;
            state = withViewModel(state, viewModel(ledger));
            motion.startBars();
          }
          else if (typeof effect === 'object') {
            if ('run' in effect) void execute(effect.run);
            else if ('task' in effect) taskCommand(effect);
            else if ('projects' in effect) editProjects(effect).catch((error: unknown) => finish(error instanceof Error ? error : new Error(String(error))));
            else if ('toast' in effect) toast(effect.toast, effect.tone);
            else storyCommand(effect);
          }
        }
        return true;
      };

      const loadLimits = async (): Promise<void> => {
        if (!deps.limits) return;
        try {
          const limits = await deps.limits();
          if (!finished) state = { ...state, limits };
        } catch {
          // Keep the last readings.
        }
      };

      const refreshSetup = async (): Promise<void> => {
        try {
          const setup = await deps.setupStatus();
          if (!finished) state = { ...state, setup };
        } catch {
          // Keep the last known status; the action list shows unknown states without one.
        }
      };

      /** Re-reads what an action may have changed: the ledger (task actions), the mode pill, the hooks and the config. */
      const reload = async (ledgerChanged: boolean): Promise<void> => {
        // A sync or login rewrites the machines cache; any action may have, so it is re-read every time.
        const before = cached;
        cached = await loadMachines(deps);
        const machinesChanged = cached.publishedAt !== before.publishedAt || cached.files.length !== before.files.length;
        if (!finished) state = { ...state, machines: machinesInfo(cached) };
        if (ledgerChanged) {
          try {
            ledger = await deps.loadLedger();
            names = await deps.projectNames().catch(() => names);
          } catch {
            // The in-memory ledger stays; the next scan merges into it.
          }
        }
        if ((ledgerChanged || machinesChanged) && !finished) state = withViewModel(state, viewModel(ledger));
        await Promise.all([
          refreshSetup(),
          deps.modeLabel().then((mode) => { if (!finished) state = { ...state, mode }; }, () => {}),
          deps.autoSync().then((autoSync) => { if (!finished) state = { ...state, autoSync }; }, () => {}),
          loadLimits(),
        ]);
      };

      const toast = (text: string, tone: ToastTone): void => {
        state = { ...state, toast: { text, tone, at: deps.clock() } };
      };

      const errorText = (error: unknown): string => (error instanceof Error ? error.message : String(error));

      /** Starts the story box's session once a scan or ledger write in flight is done, so the cards see the newest ledger. */
      const startStory = async (range: StoryRange): Promise<void> => {
        await settleScans();
        if (finished || state.story?.step !== 'drawing' || state.story.range !== range || story) return;
        const session: StorySession = deps.startStory(range, guard((event: StoryEvent) => {
          if (story !== session || !state.story) return;
          state = { ...state, story: applyStoryEvent(state.story, event) };
          draw();
        }));
        story = session;
      };

      /** Carries out what the story box asks for; closing stops sharing and lets the scans run again. */
      const storyCommand = (command: StoryCommand): void => {
        if (command.story === 'start') {
          startStory(command.range).catch((error: unknown) => finish(error instanceof Error ? error : new Error(String(error))));
        } else if (command.story === 'save') {
          story?.save();
        } else {
          story?.stop();
          story = null;
          startScan(LIVE_SCAN_DAYS);
        }
      };

      /** Waits for a scan or ledger write in flight, so a command never meets the sync lock held by the view itself. */
      const settleScans = async (): Promise<void> => {
        cancelTimer(nextScan);
        nextScan = null;
        while (scanning) await scanTask;
        await persisting?.catch(() => {});
      };

      /** Lets go of an action: reloads what it may have changed, then the scans run again. */
      const release = async (ledgerChanged: boolean): Promise<void> => {
        await reload(ledgerChanged);
        if (finished) return;
        state = { ...state, running: null };
        draw();
        startScan(LIVE_SCAN_DAYS);
      };

      /** Starts the task box's command once the scans are out of the way; its events fold into the box. */
      const startTask = async (id: ActionId): Promise<void> => {
        await settleScans();
        if (finished || state.task?.id !== id || task) return;
        // An event may arrive before startTask returns; until then the box belongs to this session as no other runs.
        let session: TaskSession | null = null;
        const onEvent = guard((event: TaskEvent) => {
          if (task !== session || !state.task) return;
          state = { ...state, task: applyTaskEvent(state.task, event, deps.clock()) };
          drawSoon();
        });
        try {
          session = deps.startTask(id, state.setup, onEvent);
        } catch (error) {
          // The box reports a command that could not even start, like any other failure, and closes as usual.
          onEvent({ kind: 'line', text: errorText(error), tone: 'err' });
          onEvent({ kind: 'done', code: 1, after: 'reload', cancelled: false });
          return;
        }
        task = session;
      };

      /** Closing a finished box: the view reloads, or leaves for the new version or because the data is gone. */
      const closeTask = async (after: TaskAfter): Promise<void> => {
        task?.stop();
        task = null;
        if (after !== 'reload') return finish(0);
        await release(true);
      };

      /** Carries out what the task box asks for. */
      const taskCommand = (command: TaskCommand): void => {
        const fail = (error: unknown): void => finish(error instanceof Error ? error : new Error(String(error)));
        if (command.task === 'start') startTask(command.id).catch(fail);
        else if (command.task === 'answer') task?.answer(command.value);
        else if (command.task === 'cancel') task?.cancel();
        // A second Ctrl-C while a command that cannot stop hangs: finish stops the session (putting the console, the
        // prompts and the spinner back) and restores the terminal; the command is abandoned with the process.
        else if (command.task === 'quit') finish(130);
        else closeTask(command.after).catch(fail);
      };

      /** Runs an `inline` action behind the view and reports with a toast. */
      const execute = async (id: ActionId): Promise<void> => {
        if (state.running !== null || finished) return;
        const item = actionItems(state.setup, state.vm.localSources).find((candidate) => candidate.id === id);
        if (item?.kind !== 'inline') return;
        state = { ...state, running: id };
        draw();
        try {
          await settleScans();
          if (finished) return;
          const { code, lines } = await deps.runAction(id, state.setup);
          // Success reads best as the first line ("Installed ..."), failure as the last (the reason); hints trail the first.
          const shown = lines.map((line) => line.replace(ANSI, '').trim()).filter(Boolean);
          const line = code === 0 ? shown[0] : shown.at(-1);
          toast(line ?? (code === 0 ? 'Done.' : 'Failed.'), code === 0 ? 'good' : 'bad');
        } catch (error) {
          if (!finished) toast(errorText(error), 'bad');
        }
        if (finished) return;
        await release(false);
      };

      /**
       * Applies a project edit from the Projects tab. A scan in flight finishes first (it re-reads the names when it
       * ends, so it must not end after this write), none starts until the new names are in the view, and the next one
       * reads them again.
       */
      const editProjects = async (edit: ProjectEdit): Promise<void> => {
        try {
          await settleScans();
          if (finished) return;
          const result = await deps.editProjects(edit, ledger);
          if (finished) return;
          if (result.ok) {
            names = await deps.projectNames().catch(() => result.names);
            if (finished) return;
            state = selectProject(withViewModel(state, viewModel(ledger)), result.select);
            toast(result.message, 'good');
          } else {
            toast(result.error, 'bad');
          }
        } catch (error) {
          if (!finished) toast(errorText(error), 'bad');
        }
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
          const out = reduce(state, event, hits, deps.clock());
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
      // Never awaited and never reported: the view opens at once, and being offline is not an error.
      void deps.checkForUpdate().then(refreshSetup).then(guard(draw), () => {});
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
      void loadLimits().then(() => { if (!finished) draw(); });
      startScan(FIRST_SCAN_DAYS);
    });
  } finally {
    for (const cancel of cancels) cancel();
    restore();
  }
}
