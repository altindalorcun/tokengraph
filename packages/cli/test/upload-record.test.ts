import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { UsagePayload } from '@tokengraph/core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  emptyUploadRecord,
  parseUploadRecord,
  pendingPayload,
  readUploadRecord,
  recordUpload,
  REFRESH_AFTER_MS,
  uploadTarget,
  writeUploadRecord,
} from '../src/upload-record.js';

const DEVICE = '3f2504e0-4f89-41d3-9a0c-0305e82c3301';
const TARGET = uploadTarget('https://tokengraph.dev', DEVICE);
const NOW = Date.UTC(2026, 9, 12, 12);

function day(date: string, inputTokens: number) {
  return { date, models: [{ model: 'claude-opus-5-5', inputTokens, outputTokens: 1, cacheCreationTokens: 0, cacheReadTokens: 0 }] };
}

function payload(...days: ReturnType<typeof day>[]): UsagePayload {
  return { deviceId: DEVICE, source: 'claude-code', days };
}

describe('pendingPayload', () => {
  it('sends everything when nothing was uploaded yet', () => {
    const full = payload(day('2026-10-11', 10), day('2026-10-12', 20));
    expect(pendingPayload(full, emptyUploadRecord(TARGET), NOW)).toEqual(full);
  });

  it('sends only days that are new or changed', () => {
    const record = recordUpload(emptyUploadRecord(TARGET), payload(day('2026-10-11', 10), day('2026-10-12', 20)), NOW);
    const next = payload(day('2026-10-11', 10), day('2026-10-12', 25), day('2026-10-13', 5));
    expect(pendingPayload(next, record, NOW + 60_000)?.days.map((d) => d.date)).toEqual(['2026-10-12', '2026-10-13']);
  });

  it('returns null when nothing changed', () => {
    const full = payload(day('2026-10-11', 10));
    const record = recordUpload(emptyUploadRecord(TARGET), full, NOW);
    expect(pendingPayload(full, record, NOW + 60_000)).toBeNull();
  });

  it('re-sends an unchanged day once it was last sent long enough ago', () => {
    const full = payload(day('2026-10-11', 10));
    const record = recordUpload(emptyUploadRecord(TARGET), full, NOW);
    expect(pendingPayload(full, record, NOW + REFRESH_AFTER_MS - 1)).toBeNull();
    expect(pendingPayload(full, record, NOW + REFRESH_AFTER_MS)).toEqual(full);
  });

  it('keeps sources apart', () => {
    const record = recordUpload(emptyUploadRecord(TARGET), payload(day('2026-10-11', 10)), NOW);
    const codex: UsagePayload = { ...payload(day('2026-10-11', 10)), source: 'codex-cli' };
    expect(pendingPayload(codex, record, NOW)).toEqual(codex);
  });
});

describe('recordUpload', () => {
  it('forgets days not sent for over a month and a half', () => {
    const old = recordUpload(emptyUploadRecord(TARGET), payload(day('2026-08-01', 1)), NOW - 46 * 86_400_000);
    const record = recordUpload(old, payload(day('2026-10-12', 1)), NOW);
    expect(Object.keys(record.sources['claude-code'] ?? {})).toEqual(['2026-10-12']);
  });
});

describe('parseUploadRecord', () => {
  it('reads a record for another server or device as empty', () => {
    const record = recordUpload(emptyUploadRecord(TARGET), payload(day('2026-10-11', 10)), NOW);
    const raw = JSON.parse(JSON.stringify(record));
    expect(parseUploadRecord(raw, TARGET)).toEqual(record);
    expect(parseUploadRecord(raw, uploadTarget('http://localhost:3000', DEVICE)).sources).toEqual({});
  });

  it('drops malformed entries and unknown sources', () => {
    const raw = {
      version: 1,
      target: TARGET,
      sources: {
        'claude-code': { '2026-10-11': { fingerprint: 'abc', at: NOW }, 'not-a-date': { fingerprint: 'x', at: NOW }, '2026-10-12': { at: NOW } },
        nope: { '2026-10-11': { fingerprint: 'abc', at: NOW } },
      },
    };
    expect(parseUploadRecord(raw, TARGET).sources).toEqual({ 'claude-code': { '2026-10-11': { fingerprint: 'abc', at: NOW } } });
  });
});

describe('reading and writing', () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'upload-record-'));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('round-trips, and reads a missing or damaged file as empty', async () => {
    const path = join(dir, 'uploaded.json');
    expect(await readUploadRecord(path, TARGET)).toEqual(emptyUploadRecord(TARGET));
    const record = recordUpload(emptyUploadRecord(TARGET), payload(day('2026-10-11', 10)), NOW);
    await writeUploadRecord(path, record);
    expect(await readUploadRecord(path, TARGET)).toEqual(record);
    await writeFile(path, '{not json');
    expect(await readUploadRecord(path, TARGET)).toEqual(emptyUploadRecord(TARGET));
  });
});
