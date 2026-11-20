// Writes the app icon as SVG: build/icon.svg (macOS layout) and build/icon-win.svg (Windows layout).
// Liquid Glass style: stacked frosted glass windows with a prompt, on a blue squircle.
// The body is drawn in a 1024 unit box and placed on a 1024 canvas:
//   mac: 824 body with room for its shadow (macOS icon grid); win: 960 body, lighter shadow.
// Render PNG/ICO afterwards with `npm run icon`.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const f2 = (n) => n.toFixed(2);

/** Superellipse |x|^n + |y|^n = 1: close to Apple's continuous-corner icon shape at n = 5. */
function squircle(n = 5, a = 512, c = 512, steps = 900) {
  const pts = [];
  for (let i = 0; i < steps; i++) {
    const t = (2 * Math.PI * i) / steps;
    const co = Math.cos(t), si = Math.sin(t);
    pts.push(`${f2(c + a * Math.sign(co) * Math.abs(co) ** (2 / n))},${f2(c + a * Math.sign(si) * Math.abs(si) ** (2 / n))}`);
  }
  return `M${pts.join(' L')} Z`;
}

/** Rounded rectangle whose corners are superellipse quadrants. */
function crect(x, y, w, h, r, n = 4, steps = 40) {
  const q = (t) => [Math.cos(t) ** (2 / n), Math.sin(t) ** (2 / n)];
  const pts = [];
  const corner = (cx, cy, sx, sy, from, to) => {
    for (let i = 0; i <= steps; i++) {
      const t = (Math.PI / 2) * (from + (to - from) * (i / steps));
      const [c, s] = q(t);
      pts.push([cx + sx * r * c, cy + sy * r * s]);
    }
  };
  corner(x + w - r, y + r, 1, -1, 1, 0);
  corner(x + w - r, y + h - r, 1, 1, 0, 1);
  corner(x + r, y + h - r, -1, 1, 1, 0);
  corner(x + r, y + r, -1, -1, 0, 1);
  return `M${pts.map(([a, b]) => `${f2(a)},${f2(b)}`).join(' L')} Z`;
}

const grad = (id, stops, [x1, y1, x2, y2] = [0, 0, 0, 1], units = '') =>
  `<linearGradient id="${id}" x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}"${units ? ` gradientUnits="${units}"` : ''}>` +
  stops.map(([o, c, op]) => `<stop offset="${o}" stop-color="${c}" stop-opacity="${op}"/>`).join('') +
  '</linearGradient>';

const STYLE = {
  bg: [[0, '#5DB2FF', 1], [1, '#1C57EE', 1]],
  glow: ['#FFFFFF', 0.26],
  // back, middle, front pane: top color/opacity, bottom color/opacity
  panes: [
    ['#FFFFFF', 0.34, '#FFFFFF', 0.16],
    ['#FFFFFF', 0.46, '#FFFFFF', 0.24],
    ['#FFFFFF', 0.9, '#F2F7FF', 0.78],
  ],
  glyph: ['#3A8DFF', '#1A4FE0'],
  shadow: ['#0A2A8A', 0.4],
  rim: 0.95,
  bodyRim: 0.55,
};

// Full layout: three panes. Small layout (Windows 16-32 px): two panes, a heavier prompt, no fine shadows,
// because three panes and a thin prompt turn to mush at that size.
const LAYOUTS = {
  full: {
    panes: [
      { x: 296, y: 232, w: 560, h: 400, r: 118, fill: STYLE.panes[0] },
      { x: 232, y: 320, w: 560, h: 400, r: 118, fill: STYLE.panes[1] },
      { x: 168, y: 408, w: 560, h: 400, r: 118, fill: STYLE.panes[2] },
    ],
    glyph: { d: 'M262 540 L346 608 L262 676 M394 676 H514', width: 46, y0: 530, y1: 690, shadow: true },
    paneShadow: { dy: 26, blur: 26 },
    backdrop: 18,
  },
  small: {
    panes: [
      { x: 252, y: 196, w: 640, h: 440, r: 130, fill: ['#FFFFFF', 0.52, '#FFFFFF', 0.3] },
      { x: 132, y: 360, w: 660, h: 470, r: 138, fill: ['#FFFFFF', 0.97, '#F2F7FF', 0.92] },
    ],
    glyph: { d: 'M250 503 L376 595 L250 687 M436 687 H606', width: 84, y0: 480, y1: 710, shadow: false },
    paneShadow: { dy: 18, blur: 18 },
    backdrop: 12,
  },
};

function body(S, L) {
  const d = [];
  const [sc, so] = S.shadow;
  d.push(`<path id="body" d="${squircle()}"/>`, '<clipPath id="bodyClip"><use href="#body"/></clipPath>');
  d.push(grad('bg', S.bg));
  d.push(`<radialGradient id="glow" cx="0.26" cy="0.06" r="0.85"><stop offset="0" stop-color="${S.glow[0]}" stop-opacity="${S.glow[1]}"/><stop offset="1" stop-color="${S.glow[0]}" stop-opacity="0"/></radialGradient>`);
  d.push(grad('bodyRim', [[0, '#FFFFFF', S.bodyRim], [0.18, '#FFFFFF', S.bodyRim * 0.25], [0.5, '#FFFFFF', 0], [1, '#FFFFFF', S.bodyRim * 0.3]]));
  d.push(grad('rim', [[0, '#FFFFFF', S.rim], [0.22, '#FFFFFF', S.rim * 0.32], [0.6, '#FFFFFF', 0.04], [1, '#FFFFFF', S.rim * 0.42]]));
  d.push(grad('sheen', [[0, '#FFFFFF', 0.3], [0.42, '#FFFFFF', 0]]));
  d.push(`<filter id="bblur" x="-5%" y="-5%" width="110%" height="110%"><feGaussianBlur stdDeviation="${L.backdrop}" edgeMode="duplicate"/></filter>`);
  d.push(`<filter id="pshadow" x="-40%" y="-40%" width="180%" height="190%"><feGaussianBlur stdDeviation="${L.paneShadow.blur}"/></filter>`);
  d.push(`<filter id="gshadow" x="-30%" y="-30%" width="160%" height="170%"><feDropShadow dx="0" dy="7" stdDeviation="9" flood-color="${sc}" flood-opacity="${(so * 0.55).toFixed(3)}"/></filter>`);
  d.push(grad('glyph', [[0, S.glyph[0], 1], [1, S.glyph[1], 1]], [0, L.glyph.y0, 0, L.glyph.y1], 'userSpaceOnUse'));
  d.push('<g id="L0"><rect width="1024" height="1024" fill="url(#bg)"/><rect width="1024" height="1024" fill="url(#glow)"/></g>');

  const layers = L.panes.map((_, k) => `P${k}`);
  L.panes.forEach(({ x, y, w, h, r, fill: [tc, to, bc, bo] }, k) => {
    const id = `pane${k}`;
    d.push(`<path id="${id}" d="${crect(x, y, w, h, r)}"/>`);
    d.push(`<path id="${id}-in" d="${crect(x + 2.5, y + 2.5, w - 5, h - 5, r - 2.5)}"/>`);
    d.push(`<clipPath id="${id}-clip"><use href="#${id}"/></clipPath>`);
    d.push(grad(`${id}-fill`, [[0, tc, to], [1, bc, bo]]));
    // Frosted glass: what lies beneath, blurred, seen through a white tint, with a light rim.
    const backdrop = ['L0', ...layers.slice(0, k)].map((b) => `<use href="#${b}"/>`).join('');
    d.push(
      `<g id="${layers[k]}">` +
        `<use href="#${id}" fill="${sc}" opacity="${so}" filter="url(#pshadow)" transform="translate(0 ${L.paneShadow.dy})"/>` +
        `<g clip-path="url(#${id}-clip)"><g filter="url(#bblur)">${backdrop}</g></g>` +
        `<use href="#${id}" fill="url(#${id}-fill)"/>` +
        `<use href="#${id}" fill="url(#sheen)"/>` +
        `<use href="#${id}-in" fill="none" stroke="url(#rim)" stroke-width="5"/>` +
      '</g>',
    );
  });

  const content =
    '<g clip-path="url(#bodyClip)">' +
    '<use href="#L0"/>' + layers.map((l) => `<use href="#${l}"/>`).join('') +
    `<path d="${L.glyph.d}"${L.glyph.shadow ? ' filter="url(#gshadow)"' : ''} fill="none" stroke="url(#glyph)" stroke-width="${L.glyph.width}" stroke-linecap="round" stroke-linejoin="round"/>` +
    '<use href="#body" fill="none" stroke="url(#bodyRim)" stroke-width="7"/>' +
    '</g>';
  return { defs: d.join(''), content };
}

const TARGETS = {
  mac: { layout: 'full', size: 824, shadow: [12, 16, 0.32] },
  win: { layout: 'full', size: 960, shadow: [6, 8, 0.22] },
  'win-small': { layout: 'small', size: 1000, shadow: null },
};

function icon(target) {
  const T = TARGETS[target];
  const { defs, content } = body(STYLE, LAYOUTS[T.layout]);
  const off = (1024 - T.size) / 2;
  const shadow = T.shadow
    ? `<filter id="ishadow" x="-20%" y="-20%" width="140%" height="150%"><feDropShadow dx="0" dy="${T.shadow[0]}" stdDeviation="${T.shadow[1]}" flood-color="#000" flood-opacity="${T.shadow[2]}"/></filter>`
    : '';
  const placed = `<g transform="translate(${off} ${off}) scale(${T.size / 1024})">${content}</g>`;
  return (
    '<svg xmlns="http://www.w3.org/2000/svg" width="1024" height="1024" viewBox="0 0 1024 1024">' +
    `<defs>${defs}${shadow}</defs>` +
    (T.shadow ? `<g filter="url(#ishadow)">${placed}</g>` : placed) +
    '</svg>'
  );
}

fs.mkdirSync(path.join(root, 'build'), { recursive: true });
fs.writeFileSync(path.join(root, 'build', 'icon.svg'), icon('mac'));
fs.writeFileSync(path.join(root, 'build', 'icon-win.svg'), icon('win'));
fs.writeFileSync(path.join(root, 'build', 'icon-win-small.svg'), icon('win-small'));
console.log('wrote build/icon.svg, build/icon-win.svg, build/icon-win-small.svg');
