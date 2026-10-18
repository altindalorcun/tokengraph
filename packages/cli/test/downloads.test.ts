import { describe, expect, it } from 'vitest';
import { downloadsDir, type DownloadsIO } from '../src/downloads.js';

const io = (files: Record<string, string> = {}, registry: string | null = null): DownloadsIO => ({
  readFile: (path) => files[path] ?? null,
  readRegistry: (key, value) => {
    expect(key).toBe('HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\User Shell Folders');
    expect(value).toBe('{374DE290-123F-4565-9164-39C4925E467B}');
    return registry;
  },
});

describe('downloadsDir', () => {
  it('is ~/Downloads on macOS whatever the language', () => {
    expect(downloadsDir('darwin', '/Users/me', { LANG: 'tr_TR.UTF-8' }, io())).toBe('/Users/me/Downloads');
  });

  it("reads a localised Linux folder from user-dirs.dirs, honouring XDG_CONFIG_HOME", () => {
    const dirs = '# written by xdg-user-dirs-update\nXDG_DESKTOP_DIR="$HOME/Masaüstü"\nXDG_DOWNLOAD_DIR="$HOME/İndirilenler"\n';
    expect(downloadsDir('linux', '/home/me', {}, io({ '/home/me/.config/user-dirs.dirs': dirs }))).toBe('/home/me/İndirilenler');
    expect(downloadsDir('linux', '/home/me', { XDG_CONFIG_HOME: '/cfg' }, io({ '/cfg/user-dirs.dirs': 'XDG_DOWNLOAD_DIR="/data/dl/"' }))).toBe('/data/dl');
    expect(downloadsDir('freebsd', '/home/me', {}, io({ '/home/me/.config/user-dirs.dirs': 'XDG_DOWNLOAD_DIR="${HOME}/Téléchargements"' }))).toBe('/home/me/Téléchargements');
  });

  it('prefers XDG_DOWNLOAD_DIR from the environment', () => {
    expect(downloadsDir('linux', '/home/me', { XDG_DOWNLOAD_DIR: '/home/me/Herunterladen' }, io())).toBe('/home/me/Herunterladen');
  });

  it('says nothing on Linux when the folder is unset, disabled ($HOME) or relative', () => {
    expect(downloadsDir('linux', '/home/me', {}, io())).toBeNull();
    expect(downloadsDir('linux', '/home/me', {}, io({ '/home/me/.config/user-dirs.dirs': 'XDG_DOWNLOAD_DIR="$HOME/"' }))).toBeNull();
    expect(downloadsDir('linux', '/home/me', {}, io({ '/home/me/.config/user-dirs.dirs': 'XDG_DOWNLOAD_DIR="dl"' }))).toBeNull();
  });

  it('reads a moved Windows folder from the registry and expands its variables', () => {
    expect(downloadsDir('win32', 'C:\\Users\\me', { USERPROFILE: 'C:\\Users\\me' }, io({}, '%USERPROFILE%\\Downloads'))).toBe('C:\\Users\\me\\Downloads');
    expect(downloadsDir('win32', 'C:\\Users\\me', { UserProfile: 'C:\\Users\\me' }, io({}, '%USERPROFILE%\\Downloads'))).toBe('C:\\Users\\me\\Downloads');
    expect(downloadsDir('win32', 'C:\\Users\\me', {}, io({}, 'D:\\İndirilenler'))).toBe('D:\\İndirilenler');
  });

  it('says nothing on Windows without a usable registry value', () => {
    expect(downloadsDir('win32', 'C:\\Users\\me', {}, io({}, null))).toBeNull();
    expect(downloadsDir('win32', 'C:\\Users\\me', {}, io({}, '%NOPE%\\Downloads'))).toBeNull();
  });
});
