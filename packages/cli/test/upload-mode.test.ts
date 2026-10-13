import { describe, expect, it } from 'vitest';
import { uploadMode, uploadModeLine } from '../src/upload-mode.js';

const DEVICE = '3f2504e0-4f89-41d3-9a0c-0305e82c3301';
const LOGGED_IN = { apiKey: 'tg_abc', deviceId: DEVICE, username: 'octo' };

describe('uploadMode', () => {
  it('uploads only when logged in and not switched off', () => {
    expect(uploadMode(LOGGED_IN)).toBe('upload');
    expect(uploadMode({ ...LOGGED_IN, uploads: true })).toBe('upload');
    expect(uploadMode({ ...LOGGED_IN, uploads: false })).toBe('off');
    expect(uploadMode({ uploads: false })).toBe('off');
    expect(uploadMode({})).toBe('local');
    expect(uploadMode({ apiKey: 'tg_abc' })).toBe('local'); // no device id: cannot upload
  });
});

describe('uploadModeLine', () => {
  it('describes each mode with the command that changes it', () => {
    expect(uploadModeLine(LOGGED_IN, 'https://tg.example')).toBe(
      'uploads: on — sync sends daily totals to https://tg.example as octo.',
    );
    expect(uploadModeLine({ uploads: false }, 'https://tg.example')).toBe(
      'uploads: off — sync only updates the local ledger. Turn on with `tokengraph uploads on`.',
    );
    expect(uploadModeLine({}, 'https://tg.example')).toBe(
      'uploads: on, but this machine is not logged in — everything stays local. Run `tokengraph login` to publish your graph.',
    );
  });
});
