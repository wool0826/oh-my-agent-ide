// Renders the SVGs in build/ with Chromium (run through Electron):
//   build/icon.png   1024 px, macOS layout
//   build/icon.icns  macOS, 16 to 1024 px
//   build/icon.ico   Windows, 16 to 256 px
// Each size is rendered from the vector. 32 px and below use the simplified small layout.
// Usage: electron scripts/render-icon.cjs
const { app, BrowserWindow } = require('electron');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const out = (f) => path.join(root, 'build', f);
const ICO_SIZES = [16, 20, 24, 32, 40, 48, 64, 128, 256];
const SMALL_UP_TO = 32;

app.commandLine.appendSwitch('force-device-scale-factor', '1');
app.disableHardwareAcceleration();

app.whenReady().then(async () => {
  const { ico, icns, ICNS_SIZES } = await import('./icon-files.mjs');
  const win = new BrowserWindow({
    width: 1024, height: 1024, show: false, frame: false, transparent: true,
    backgroundColor: '#00000000', useContentSize: true,
    webPreferences: { offscreen: true },
  });
  win.webContents.setFrameRate(1);
  await win.loadURL('data:text/html,<body style="margin:0;background:transparent"><img id="i" style="display:block"></body>');

  async function render(svgFile, size) {
    // A data: page may not load file:// images, so the SVG goes in as a data URL too.
    const url = `data:image/svg+xml;base64,${fs.readFileSync(out(svgFile)).toString('base64')}`;
    await win.webContents.executeJavaScript(`new Promise((ok, no) => { const i = document.getElementById('i'); i.onload = () => requestAnimationFrame(() => requestAnimationFrame(ok)); i.onerror = () => no(new Error('image failed to load')); i.width = ${size}; i.height = ${size}; i.src = ${JSON.stringify(url)}; })`);
    win.webContents.invalidate();
    await new Promise((r) => setTimeout(r, 150));
    const img = await win.webContents.capturePage({ x: 0, y: 0, width: size, height: size });
    const got = img.getSize();
    if (got.width !== size || got.height !== size) throw new Error(`${svgFile} at ${size} px was captured as ${got.width}x${got.height}`);
    return img.toPNG();
  }

  const mac = {};
  for (const size of ICNS_SIZES) mac[size] = await render(size <= SMALL_UP_TO ? 'icon-small.svg' : 'icon.svg', size);
  fs.writeFileSync(out('icon.png'), mac[1024]);
  fs.writeFileSync(out('icon.icns'), icns(mac));
  const windows = [];
  for (const size of ICO_SIZES) windows.push({ size, png: await render(size <= SMALL_UP_TO ? 'icon-win-small.svg' : 'icon-win.svg', size) });
  fs.writeFileSync(out('icon.ico'), ico(windows));
  console.log('wrote build/icon.png, build/icon.icns, build/icon.ico');
  app.quit();
}).catch((e) => {
  console.error('icon render failed:', e && e.message ? e.message : e);
  app.exit(1);
});
