// Renders build/icon.svg and build/icon-win.svg with Chromium (run through Electron):
//   build/icon.png  1024 px, macOS layout (electron-builder makes the .icns from it)
//   build/icon.ico  16-256 px, Windows layout (simplified at 32 px and below); each size rendered from the vector
// Usage: electron scripts/render-icon.cjs
const { app, BrowserWindow } = require('electron');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const out = (f) => path.join(root, 'build', f);
const ICO_SIZES = [16, 20, 24, 32, 40, 48, 64, 128, 256];

app.commandLine.appendSwitch('force-device-scale-factor', '1');
app.disableHardwareAcceleration();

/** ICO container holding PNG images (supported since Windows Vista). */
function ico(images) {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(images.length, 4);
  const dir = Buffer.alloc(16 * images.length);
  let offset = 6 + dir.length;
  images.forEach(({ size, png }, i) => {
    const e = i * 16;
    dir.writeUInt8(size >= 256 ? 0 : size, e);
    dir.writeUInt8(size >= 256 ? 0 : size, e + 1);
    dir.writeUInt8(0, e + 2);
    dir.writeUInt8(0, e + 3);
    dir.writeUInt16LE(1, e + 4);
    dir.writeUInt16LE(32, e + 6);
    dir.writeUInt32LE(png.length, e + 8);
    dir.writeUInt32LE(offset, e + 12);
    offset += png.length;
  });
  return Buffer.concat([header, dir, ...images.map((x) => x.png)]);
}

app.whenReady().then(async () => {
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
    return img.toPNG();
  }

  fs.writeFileSync(out('icon.png'), await render('icon.svg', 1024));
  const images = [];
  // 32 px and below use the simplified small layout.
  for (const size of ICO_SIZES) images.push({ size, png: await render(size <= 32 ? 'icon-win-small.svg' : 'icon-win.svg', size) });
  fs.writeFileSync(out('icon.ico'), ico(images));
  console.log('wrote build/icon.png, build/icon.ico');
  app.quit();
}).catch((e) => {
  console.error('icon render failed:', e && e.message ? e.message : e);
  app.exit(1);
});
