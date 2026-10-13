import { dateKey, OPENCODE_SOURCE, type CollectResult, type SplitTokenCounts } from '@tokengraph/core';
import { canonicalModelId } from '../model-ids.js';
import { RequestBuckets, tierForModel, type RequestRecord } from '../request-buckets.js';
import { parseStoredTokens, resolveV1Tokens, resolveV2Tokens, type Resolution, type SkipReason, type StoredTokens, type VersionContext } from './semantics.js';

export interface OpenCodeAggregatorOptions {
  since?: Date;
  timeZone?: string;
}

export interface OpenCodeMessage {
  id: string;
  sessionId: string;
  providerId: string | null;
  modelId: string | null;
  createdMs: number;
  completedMs: number | null;
  agent: string | null;
  cost: number | null;
  /** The message's own tokens object (raw, as stored). */
  tokens: unknown;
  /** step-finish parts' raw tokens objects, ordered by part id; empty if the message has none. */
  steps: unknown[];
}

export interface OpenCodeSession {
  id: string;
  version: string | null;
  createdMs: number | null;
}

export interface OpenCodeV2Message {
  id: string;
  providerId: string | null;
  modelId: string | null;
  createdMs: number;
  completedMs: number | null;
  agent: string | null;
  cost: number | null;
  tokens: unknown;
}

export interface OpenCodeDiagnostics {
  /** pre-1.3.16 records whose meaning could not be pinned down (no-total/ambiguous/aisdk6-window). */
  skippedOld: number;
  /** tokens missing, non-numeric, negative, or a `createdMs` too far out of range to date. */
  invalidRecords: number;
  /** `claude-code` provider: that usage is Claude Code itself, already counted by our Claude Code adapter. */
  skippedClaudeCode: number;
  /** databases or JSON files that could not be opened/parsed. */
  unreadableSources: number;
}

/** True for a finite number that also constructs a valid `Date` — a huge-but-finite `createdMs`
 * (e.g. `1e20`) is finite yet produces an out-of-range instant, and `dateKey` throws a
 * `RangeError` on that rather than returning a string. */
function isValidTimestamp(ms: number): boolean {
  return Number.isFinite(ms) && !Number.isNaN(new Date(ms).getTime());
}

/** True when `providerId` is OpenCode's own `claude-code` provider (running Claude Code as a
 * subprocess), whose usage the Claude Code adapter already counts from its own transcript. */
function isClaudeCodeProvider(providerId: string | null): boolean {
  return providerId !== null && providerId.toLowerCase() === 'claude-code';
}

/** A fingerprint of a message's identity fields alone — never its tokens or cost, which a v1→v2
 * migration rewrites into a different shape. Used to recognise a v2 fork copy of a v1 message
 * whose own migrated v2 row (same id) has since been deleted, so the copy can't be caught by the
 * usual id/fingerprint sentinel in {@link OpenCodeAggregator.resolveV2}. */
function identityOf(message: { createdMs: number; completedMs: number | null; providerId: string | null; modelId: string | null; agent: string | null }): string {
  return JSON.stringify([message.createdMs, message.completedMs, message.providerId, message.modelId, message.agent]);
}

/** A fingerprint of everything a v1 fork clone or v2 fork copy carries over verbatim. */
function fingerprintOf(message: { createdMs: number; completedMs: number | null; providerId: string | null; modelId: string | null; tokens: unknown; cost: number | null; agent: string | null }): string {
  return JSON.stringify([message.createdMs, message.completedMs, message.providerId, message.modelId, message.tokens, message.cost, message.agent]);
}

/** Plain code-point id order — stable and independent of locale/collation, unlike `localeCompare`. */
function byId<T extends { id: string }>(a: T, b: T): number {
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

/**
 * Resolves a canonical key for a message id: reuse the key already assigned to this id, else
 * the key already assigned to an identical fingerprint (a fork clone under a new id), else the
 * id itself. Both maps are updated so later messages in the same pass can find this one.
 */
function canonicalKey(id: string, fingerprint: string, idToKey: Map<string, string>, fingerprintToKey: Map<string, string>): string {
  const key = idToKey.get(id) ?? fingerprintToKey.get(fingerprint) ?? id;
  idToKey.set(id, key);
  fingerprintToKey.set(fingerprint, key);
  return key;
}

/**
 * Reads OpenCode's own local, per-request usage (never a provider bill — see
 * `docs/opencode-usage.md`) into tokengraph's four counters. v1 (SQLite `message`/`part`, and
 * the pre-1.2.0 JSON storage) and v2 (`session_message`) are buffered separately and resolved
 * in {@link result}, so the caller can add sessions and messages in any order.
 *
 * v1's request unit is a step-finish part, or the message's own tokens when it has none — never
 * both, since the message's tokens are overwritten to equal its last step (see
 * `docs/opencode-usage.md`, "Kayıtlar nasıl yazılıyor"). v1 fork clones are deduplicated by a
 * content fingerprint under a fresh id. A v2 row whose id matches a v1 message's id is a
 * migrated copy of that v1 message and is dropped outright (v1's step-finish record is
 * authoritative); a v2 *fork copy* of such a migrated row carries the same data under a new
 * `<forkEventId>_<seq>` id, so it is caught the same way, by fingerprint, not by id — see
 * {@link resolveV2} for how that fingerprint is registered order-independently.
 *
 * A request key can have more than one copy (a v1 fork clone, or several v2 fork copies) whose
 * *contexts* differ even though their token data is identical — a clone's session context is
 * only ever weaker (its message predates the cloning session), so it can fail a check the
 * original passed, but never succeed where the original failed. Diagnostics are therefore
 * decided per request key, not per copy: a key counts if *any* copy of it resolved, and is only
 * reported as skipped if *no* copy did (see {@link processUnit}).
 */
export class OpenCodeAggregator {
  private readonly options: OpenCodeAggregatorOptions;
  private readonly buckets = new RequestBuckets();
  private readonly sessions = new Map<string, OpenCodeSession>();
  /** Keyed by message id; when the same id arrives twice the copy with more steps wins (ties: last added). */
  private readonly v1Messages = new Map<string, OpenCodeMessage>();
  private readonly v2Messages = new Map<string, OpenCodeV2Message>();
  /** Request keys that resolved to counts in the most recent {@link result} call. */
  private readonly resolvedKeys = new Set<string>();
  /** Request keys with no resolved copy (yet) in the most recent {@link result} call, and why. */
  private readonly pendingSkips = new Map<string, SkipReason>();
  private unreadableSources = 0;

  constructor(options: OpenCodeAggregatorOptions = {}) {
    this.options = options;
  }

  addSession(session: OpenCodeSession): void {
    this.sessions.set(session.id, session);
  }

  addV1Message(message: OpenCodeMessage): void {
    const existing = this.v1Messages.get(message.id);
    if (!existing || message.steps.length >= existing.steps.length) {
      this.v1Messages.set(message.id, message);
    }
  }

  addV2Message(message: OpenCodeV2Message): void {
    this.v2Messages.set(message.id, message);
  }

  noteUnreadableSource(): void {
    this.unreadableSources += 1;
  }

  /**
   * A request key's fate isn't decided until every copy of it (across every `addV1Message` /
   * `addV2Message` call) has been resolved together, which only happens inside {@link result}.
   * Call `result()` at least once before reading this — before that, or if more messages are
   * added afterwards without calling `result()` again, these counts do not yet reflect them.
   */
  diagnostics(): OpenCodeDiagnostics {
    let invalidRecords = 0;
    let skippedOld = 0;
    let skippedClaudeCode = 0;
    for (const reason of this.pendingSkips.values()) {
      if (reason === 'invalid') invalidRecords += 1;
      else if (reason === 'claude-code') skippedClaudeCode += 1;
      else skippedOld += 1;
    }
    return { skippedOld, invalidRecords, skippedClaudeCode, unreadableSources: this.unreadableSources };
  }

  result(): CollectResult {
    this.resolvedKeys.clear();
    this.pendingSkips.clear();
    this.resolveV1();
    this.resolveV2();
    return { source: OPENCODE_SOURCE, usage: this.buckets.toUsage(), requestCount: this.buckets.size };
  }

  private resolveV1(): void {
    const idToKey = new Map<string, string>();
    const fingerprintToKey = new Map<string, string>();
    const messages = [...this.v1Messages.values()].sort(byId);

    for (const message of messages) {
      const key = canonicalKey(message.id, fingerprintOf(message), idToKey, fingerprintToKey);
      if (this.beforeSince(message.createdMs)) continue;

      const session = this.sessions.get(message.sessionId) ?? null;
      const context: VersionContext = {
        sessionVersion: session?.version ?? null,
        sessionCreatedMs: session?.createdMs ?? null,
        messageCreatedMs: message.createdMs,
      };

      const units: Array<{ raw: unknown; requestKey: string }> =
        message.steps.length > 0
          ? message.steps.map((raw, index) => ({ raw, requestKey: `${key}#${index}` }))
          : [{ raw: message.tokens, requestKey: `${key}#m` }];

      for (const { raw, requestKey } of units) {
        this.processUnit(raw, requestKey, message.createdMs, message.providerId, message.modelId, (tokens) => resolveV1Tokens(tokens, context));
      }
    }
  }

  /**
   * v2 rows are resolved in two passes so the outcome never depends on id sort order. Pass 1
   * registers every row whose id is a v1 message's id under a `v1:<id>` sentinel key — both by
   * id and by fingerprint, so a fork copy of that row (same data, a fresh `<forkEventId>_<seq>`
   * id) resolves to the same sentinel however the ids happen to sort. Pass 2 resolves everything
   * else; a row whose canonical key comes back as a v1-owned sentinel is a copy of a migrated v1
   * message and is dropped — not counted, not diagnosed, since v1's record already covers it.
   *
   * That id/fingerprint sentinel only catches a fork copy whose *migrated* v2 row (same id as the
   * v1 message) is still present to register the fingerprint. Once that migrated row is deleted —
   * a v1→v2 migration that later gets pruned — only the fork copy (a fresh id, and its data no
   * longer matches any *v2* fingerprint) survives, and it would otherwise be counted as a brand
   * new v2-only request even though v1 already has it. `v1Identities` catches this case directly:
   * every v1 message's own identity (createdMs, completedMs, providerId, modelId, agent —
   * deliberately excluding tokens and cost, which migration rewrites into a different shape) is
   * registered up front, and any v2 row matching one is dropped outright, id sentinel or not.
   */
  private resolveV2(): void {
    const v1Ids = new Set(this.v1Messages.keys());
    const v1Identities = new Set([...this.v1Messages.values()].map(identityOf));
    const idToKey = new Map<string, string>();
    const fingerprintToKey = new Map<string, string>();
    const sentinelKeys = new Set<string>();
    const messages = [...this.v2Messages.values()].sort(byId);

    for (const message of messages) {
      if (!v1Ids.has(message.id)) continue;
      const sentinel = `v1:${message.id}`;
      sentinelKeys.add(sentinel);
      idToKey.set(message.id, sentinel);
      fingerprintToKey.set(fingerprintOf(message), sentinel);
    }

    for (const message of messages) {
      if (v1Ids.has(message.id)) continue;
      if (v1Identities.has(identityOf(message))) continue; // a fork copy of a v1 message whose migrated v2 row was deleted.

      const key = canonicalKey(message.id, fingerprintOf(message), idToKey, fingerprintToKey);
      if (sentinelKeys.has(key)) continue; // a fork copy of a v1-migrated row; v1 already covers it.
      if (this.beforeSince(message.createdMs)) continue;

      const requestKey = `v2:${key}`;
      this.processUnit(message.tokens, requestKey, message.createdMs, message.providerId, message.modelId, (tokens) => ({
        counts: resolveV2Tokens(tokens),
      }));
    }
  }

  private beforeSince(createdMs: number): boolean {
    return this.options.since !== undefined && createdMs < this.options.since.getTime();
  }

  /**
   * Resolves one request unit and records its outcome against `requestKey`, per-key rather than
   * per-copy: a resolution always wins (added to the buckets and the key marked resolved,
   * clearing any earlier tentative skip), and a skip is only remembered while no copy of that
   * key has resolved yet. The `claude-code` provider and an out-of-range `createdMs` are checked
   * before the tokens are even parsed — neither one is a token-shape problem, and letting a bad
   * `createdMs` reach {@link addRequest} would throw inside `dateKey` instead of being skipped.
   */
  private processUnit(
    raw: unknown,
    requestKey: string,
    createdMs: number,
    providerId: string | null,
    modelId: string | null,
    resolve: (tokens: StoredTokens) => Resolution,
  ): void {
    let resolution: Resolution;
    if (isClaudeCodeProvider(providerId)) {
      resolution = { skip: 'claude-code' };
    } else if (!isValidTimestamp(createdMs)) {
      resolution = { skip: 'invalid' };
    } else {
      const tokens = parseStoredTokens(raw);
      resolution = tokens ? resolve(tokens) : { skip: 'invalid' };
    }

    if ('skip' in resolution) {
      if (!this.resolvedKeys.has(requestKey) && !this.pendingSkips.has(requestKey)) {
        this.pendingSkips.set(requestKey, resolution.skip);
      }
      return;
    }

    this.resolvedKeys.add(requestKey);
    this.pendingSkips.delete(requestKey);
    this.addRequest(requestKey, createdMs, providerId, modelId, resolution.counts);
  }

  private addRequest(requestKey: string, createdMs: number, providerId: string | null, modelId: string | null, counts: SplitTokenCounts): void {
    const model = canonicalModelId(providerId, modelId);
    const record: RequestRecord = {
      date: dateKey(new Date(createdMs), this.options.timeZone),
      model,
      pricingTier: tierForModel(model, counts),
      counts,
    };
    this.buckets.add(requestKey, record);
  }
}
