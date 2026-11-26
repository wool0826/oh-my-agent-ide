// New versions (decisions 120 and 212).
// Windows, installed: electron-updater finds a release, downloads its installer in the background and checks it against
// the sha512 in the release's latest.yml. It installs when the app quits, or at once when the user asks and nothing is
// working. Elsewhere (macOS until the app is signed, a build run from source) the app finds the release and links to it.

import { app } from 'electron';
import { createRequire } from 'node:module';
import type { AppUpdater } from 'electron-updater';
import { loadSettings } from './settings';
import { log } from './log';
import { fakeMode } from './fake';
import {
  RELEASE_API, feedOverride, mayApply, releaseUrl, updateFrom,
  type ApplyBlockers, type UpdateInfo, type UpdateState, type UpdateView,
} from '../shared/update';

interface Hooks {
  /** Something the window shows changed. */
  changed: () => void;
  /** A newer version was found (`ready`: downloaded and checked) — said once per version and kind. */
  found: (version: string, ready: boolean) => void;
}

let hooks: Hooks = { changed: () => {}, found: () => {} };
let timer: NodeJS.Timeout | null = null;
let state: UpdateState = 'idle';
let version: string | null = null;
let url: string | null = null;
let percent = 0;
let told = '';
let updater: AppUpdater | null = null;
/** No install on this quit (the session is ending, or a restart happened while work was going on). */
let held = false;

/** Downloads and installs in the app: an installed Windows build, or any packaged build pointed at a local test feed. */
const inApp = () => !fakeMode() && app.isPackaged && (process.platform === 'win32' || !!feedOverride(process.env.OMA_UPDATE_FEED));

function set(next: { state?: UpdateState; version?: string | null; url?: string | null; percent?: number }) {
  if (next.state !== undefined) state = next.state;
  if (next.version !== undefined) version = next.version;
  if (next.url !== undefined) url = next.url;
  if (next.percent !== undefined) percent = next.percent;
  const key = `${version}:${state}`;
  if (version && (state === 'ready' || state === 'link') && told !== key) {
    told = key;
    hooks.found(version, state === 'ready');
  }
  hooks.changed();
}

/** The update for the window, with what a restart would wait for while one is ready. Null with the setting off. */
export function updateView(blockers: ApplyBlockers): UpdateView | null {
  if (!loadSettings().updateCheck) return null;
  return { state, version, url, percent, blockers: state === 'ready' ? blockers : null };
}

/** The version, if one is ready and checked. */
export const readyVersion = () => (state === 'ready' ? version : null);

function getUpdater(): AppUpdater {
  if (updater) return updater;
  // Loaded only here, so fake mode, macOS and the tests never load it. A CommonJS package: required, not imported.
  const { autoUpdater } = createRequire(import.meta.url)('electron-updater') as typeof import('electron-updater');
  const u = autoUpdater;
  u.logger = { info: (m: unknown) => log.info('updater', m), warn: (m: unknown) => log.warn('updater', m), error: (m: unknown) => log.warn('updater', m), debug: () => {} };
  u.autoDownload = true;
  u.autoInstallOnAppQuit = !held;
  u.allowPrerelease = false;
  u.allowDowngrade = false;
  // Releases carry the full installer; never fetch a web installer's payload from a URL in the feed.
  u.disableWebInstaller = true;
  const feed = feedOverride(process.env.OMA_UPDATE_FEED);
  if (feed) {
    log.info('updater feed', feed);
    u.setFeedURL({ provider: 'generic', url: feed });
  }
  u.on('checking-for-update', () => { if (state !== 'ready') set({ state: 'checking' }); });
  u.on('update-available', (i) => set({ state: 'downloading', version: i.version, url: releaseUrl(i.version), percent: 0 }));
  u.on('update-not-available', () => set({ state: 'idle', version: null, url: null, percent: 0 }));
  u.on('download-progress', (p) => { if (Math.floor(p.percent) !== percent) set({ percent: Math.floor(p.percent) }); });
  // Fired only after the file's sha512 (and, for a signed build, its publisher) matched.
  u.on('update-downloaded', (i) => set({ state: 'ready', version: i.version, url: releaseUrl(i.version), percent: 100 }));
  u.on('error', (e) => {
    log.warn('updater', (e as Error)?.message ?? String(e));
    // A download that broke off or did not match its sha512: nothing is installed. The next check starts it again.
    if (state === 'downloading') set({ state: 'failed', percent: 0 });
  });
  updater = u;
  return u;
}

/** One anonymous GET of the public repository's latest release. Nothing about the user or the app's data is sent. */
async function checkLink(): Promise<UpdateInfo | null> {
  try {
    const res = await fetch(RELEASE_API, { headers: { accept: 'application/vnd.github+json', 'user-agent': 'oh-my-agent-ide' }, signal: AbortSignal.timeout(15_000) });
    if (!res.ok) return null; // 404 while there are no releases yet, 403 when rate-limited
    return updateFrom(await res.json(), app.getVersion());
  } catch (e) {
    log.warn('update check', (e as Error).message);
    return null;
  }
}

/** Looks for a newer version now. Does nothing in fake mode or with the setting off. */
export async function checkUpdate() {
  if (fakeMode() || !loadSettings().updateCheck) return;
  if (state === 'ready' || state === 'downloading') return;
  if (inApp()) {
    try {
      const r = await getUpdater().checkForUpdates();
      // A failed download is reported through the 'error' event; its promise must not reject unhandled.
      r?.downloadPromise?.catch(() => {});
      return;
    } catch (e) {
      // A release without latest.yml (those before 0.7.0), or the feed is down: link to the release instead.
      log.warn('update download', (e as Error).message);
      if (state === 'checking') set({ state: 'idle' });
    }
  }
  const next = await checkLink();
  // Known but not downloadable here: the link stays, as "failed" where downloading was expected.
  if (next) set({ state: inApp() ? 'failed' : 'link', version: next.version, url: next.url });
}

export function startUpdateCheck(h: Hooks) {
  hooks = h;
  // A test of the window's update rows (OMA_FAKE_UPDATE=<version>, fake mode only): that version is ready. No network.
  const fake = fakeMode() ? process.env.OMA_FAKE_UPDATE : undefined;
  if (fake) { set({ state: 'ready', version: fake, url: releaseUrl(fake), percent: 100 }); return; }
  if (timer || fakeMode()) return;
  setTimeout(() => void checkUpdate(), 20_000).unref();
  timer = setInterval(() => void checkUpdate(), 6 * 3600_000);
  timer.unref();
}

/**
 * Restarts into the downloaded update when nothing is working (the window asks; the rule is checked here again).
 * Returns false and changes nothing otherwise.
 */
export function applyUpdate(blockers: ApplyBlockers): boolean {
  if (!mayApply(state, blockers)) return false;
  if (fakeMode()) { log.info('update apply (fake)', version); return true; }
  log.info('update apply', version);
  // Silent install, then the new version starts.
  getUpdater().quitAndInstall(true, true);
  return true;
}

/**
 * A restart the app does anyway (the language changed): with an update ready it installs on the way, so the installer
 * and the restarted app never run at once. Returns false when there is nothing to install or work is going on.
 */
export function restartIntoUpdate(blockers: ApplyBlockers): boolean {
  if (fakeMode() || state !== 'ready' || !updater) return false;
  // Work is going on: restart without installing, and the update waits for a later quit.
  if (!mayApply(state, blockers)) { held = true; syncInstallOnQuit(); return false; }
  updater.quitAndInstall(true, true);
  return true;
}

/** Install on quit only with the setting on (it was downloaded while it was) and not while held for this run. */
function syncInstallOnQuit() {
  if (updater) updater.autoInstallOnAppQuit = !held && loadSettings().updateCheck;
}

/** The update setting changed: a downloaded update installs on quit only while it is on. */
export const followUpdateSetting = () => syncInstallOnQuit();

/**
 * Windows is ending the session: an installer started now could be cut off half way (electron-builder #7807).
 * The update stays downloaded and installs on the next quit.
 */
export function holdInstallOnQuit() {
  held = true;
  syncInstallOnQuit();
}
