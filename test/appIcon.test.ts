import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { trayIconFile, windowIconFile } from '../src/shared/appIcon';

const dev = { packaged: false, resourcesPath: '/nowhere', appPath: process.cwd() };

test('appIcon: run from the repo, the icons are found in build/', () => {
  assert.ok(windowIconFile(dev, 'win32').endsWith(path.join('build', 'icon.ico')));
  assert.ok(fs.existsSync(windowIconFile(dev, 'win32')));
  assert.ok(fs.existsSync(windowIconFile(dev, 'linux')));
  assert.ok(fs.existsSync(trayIconFile(dev)));
});

test('appIcon: packaged, the icons are the extraResources copies named in package.json', () => {
  const p = { packaged: true, resourcesPath: '/res', appPath: '/res/app.asar' };
  const extra = (JSON.parse(fs.readFileSync(path.join(dev.appPath, 'package.json'), 'utf8')).build.extraResources as { to: string }[]).map((e) => e.to);
  for (const f of [windowIconFile(p, 'win32'), windowIconFile(p, 'linux'), trayIconFile(p)]) {
    assert.equal(path.dirname(f), path.join('/res'));
    assert.ok(extra.includes(path.basename(f)), path.basename(f));
  }
});

test('appIcon: the Windows .ico holds every taskbar size', () => {
  const b = fs.readFileSync(windowIconFile(dev, 'win32'));
  const sizes = Array.from({ length: b.readUInt16LE(4) }, (_, i) => b[6 + 16 * i] || 256);
  for (const s of [16, 24, 32, 48, 64, 128, 256]) assert.ok(sizes.includes(s), `${s}px`);
});

test('appIcon: the AppUserModelID matches the installer appId', () => {
  const appId = JSON.parse(fs.readFileSync(path.join(dev.appPath, 'package.json'), 'utf8')).build.appId;
  const src = fs.readFileSync(path.join(dev.appPath, 'src', 'main', 'index.ts'), 'utf8');
  assert.ok(src.includes(`APP_ID = '${appId}'`) && src.includes('setAppUserModelId(APP_ID)'));
});
