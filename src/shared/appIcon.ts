// Where the app's own icon files are: next to the app when packaged (extraResources), in build/ when run with `electron .`.

import path from 'node:path';

export interface IconPlace { packaged: boolean; resourcesPath: string; appPath: string }

/** The window and taskbar icon: a multi-size .ico on Windows, the PNG elsewhere. */
export function windowIconFile(p: IconPlace, platform: string): string {
  const ico = platform === 'win32';
  if (p.packaged) return path.join(p.resourcesPath, ico ? 'app.ico' : 'tray.png');
  return path.join(p.appPath, 'build', ico ? 'icon.ico' : 'icon.png');
}

/** The tray icon source (a PNG, resized by the caller). */
export function trayIconFile(p: IconPlace): string {
  return p.packaged ? path.join(p.resourcesPath, 'tray.png') : path.join(p.appPath, 'build', 'icon.png');
}
