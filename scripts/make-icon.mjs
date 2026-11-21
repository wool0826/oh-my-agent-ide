// Writes the app icon as SVG into build/. Render PNG, ICO and ICNS afterwards with `npm run icon`.
//   icon.svg, icon-small.svg          macOS layout
//   icon-win.svg, icon-win-small.svg  Windows layout
// Graphite Glass (docs/design-system): a graphite glass squircle holding a formation of dots.
// One white lead (the Dispatcher) hands down to two blue agents, and they to three.
// The small files are for 32 px and below: no links, halo or gloss, and equal, larger dots on a 64 unit grid,
// so on the full-bleed Windows body every dot lands on whole pixels at 16 and 32 px.
// The body is drawn in a 1024 unit box and placed on a 1024 canvas:
//   mac: 824 body with room for its shadow (macOS icon grid); win: 960 body, lighter shadow; win small: full bleed, no shadow.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const f2 = (n) => String(+n.toFixed(2));

// Primitives from docs/design-system/source/tokens.mjs (ref.gray, ref.blue).
const GRAY = { 0: '#ffffff', 750: '#3a3a3f', 850: '#222226', 950: '#131316' };
const BLUE = { 300: '#64b1ff', 400: '#1a8cff', 500: '#007aff', 600: '#0a6ae8', 700: '#0058c7' };
// Dot fills, top to bottom, per row. The lead is white, shaded toward blue.
const TONES = [[GRAY[0], '#cfe0ff'], [BLUE[300], BLUE[500]], [BLUE[400], BLUE[700]]];

// Dot centers per row, their radii, and the link width (0: no links).
const LAYOUTS = {
  full: { rows: [[[512, 292]], [[384, 516], [640, 516]], [[256, 736], [512, 736], [768, 736]]], r: [104, 86, 68], link: 14 },
  small: { rows: [[[512, 192]], [[320, 512], [704, 512]], [[192, 832], [512, 832], [832, 832]]], r: [128, 128, 128], link: 0 },
};

const TARGETS = {
  'icon.svg': { layout: 'full', size: 824, shadow: [12, 16, 0.34] },
  'icon-small.svg': { layout: 'small', size: 824, shadow: [12, 16, 0.34] },
  'icon-win.svg': { layout: 'full', size: 960, shadow: [6, 8, 0.24] },
  'icon-win-small.svg': { layout: 'small', size: 1024, shadow: null },
};

/** Superellipse |x|^n + |y|^n = 1: close to Apple's continuous-corner icon shape at n = 5. */
function squircle(n = 5, a = 512, c = 512, steps = 720) {
  const pts = [];
  for (let i = 0; i < steps; i++) {
    const t = (2 * Math.PI * i) / steps;
    const co = Math.cos(t), si = Math.sin(t);
    pts.push(`${f2(c + a * Math.sign(co) * Math.abs(co) ** (2 / n))},${f2(c + a * Math.sign(si) * Math.abs(si) ** (2 / n))}`);
  }
  return `M${pts.join(' L')} Z`;
}

const stops = (s) => s.map(([o, c, op = 1]) => `<stop offset="${o}" stop-color="${c}"${op === 1 ? '' : ` stop-opacity="${f2(op)}"`}/>`).join('');
// Gradient coordinates are in user space: the same 1024 unit box the shapes are drawn in.
const lin = (id, s, [x1, y1, x2, y2]) => `<linearGradient id="${id}" gradientUnits="userSpaceOnUse" x1="${f2(x1)}" y1="${f2(y1)}" x2="${f2(x2)}" y2="${f2(y2)}">${stops(s)}</linearGradient>`;
const rad = (id, s, [cx, cy, r]) => `<radialGradient id="${id}" gradientUnits="userSpaceOnUse" cx="${f2(cx)}" cy="${f2(cy)}" r="${f2(r)}">${stops(s)}</radialGradient>`;
const dropShadow = (id, dy, blur, color, opacity, pad) =>
  `<filter id="${id}" x="-${pad}%" y="-${pad}%" width="${100 + 2 * pad}%" height="${110 + 2 * pad}%"><feDropShadow dx="0" dy="${dy}" stdDeviation="${blur}" flood-color="${color}" flood-opacity="${opacity}"/></filter>`;

/** Graphite glass body: dark gradient, a sheen from the upper left, a blue glow under the dots, a top-lit rim. */
function body(small) {
  const defs =
    `<path id="body" d="${squircle()}"/><clipPath id="bodyClip"><use href="#body"/></clipPath>` +
    lin('bg', [[0, GRAY[750]], [0.45, GRAY[850]], [1, GRAY[950]]], [0, 0, 0, 1024]) +
    rad('sheen', [[0, GRAY[0], 0.17], [1, GRAY[0], 0]], [300, -40, 900]) +
    rad('glow', [[0, BLUE[400], 0.34], [0.55, BLUE[600], 0.1], [1, BLUE[600], 0]], [512, 470, 480]) +
    // Small sizes get a stronger rim, which keeps the body apart from a dark taskbar.
    lin('rim', [[0, GRAY[0], small ? 0.6 : 0.5], [0.2, GRAY[0], 0.16], [0.6, GRAY[0], small ? 0.14 : 0.07], [1, GRAY[0], small ? 0.3 : 0.2]], [0, 0, 0, 1024]);
  const under = '<use href="#body" fill="url(#bg)"/><use href="#body" fill="url(#sheen)"/><use href="#body" fill="url(#glow)"/>';
  // The stroke is centered on the outline and clipped, so half its width shows.
  const over = `<use href="#body" fill="none" stroke="url(#rim)" stroke-width="${small ? 44 : 9}"/>`;
  return { defs, under, over };
}

/** The dots: each one hands down to the two below it. */
function formation(small) {
  const L = LAYOUTS[small ? 'small' : 'full'];
  let defs = '', dots = '', links = '';
  L.rows.forEach((row, i) => row.forEach(([x, y], j) => {
    const r = L.r[i];
    const circle = (fill) => `<circle cx="${x}" cy="${y}" r="${r}" fill="url(#${fill})"/>`;
    defs += lin(`d${i}${j}`, [[0, TONES[i][0]], [1, TONES[i][1]]], [x, y - r, x, y + r]);
    dots += circle(`d${i}${j}`);
    // Blue dots are glossy beads: a soft highlight toward the upper left.
    if (!small && i > 0) {
      defs += rad(`g${i}${j}`, [[0, GRAY[0], 0.55], [1, GRAY[0], 0]], [x - r * 0.32, y - r * 0.42, r * 0.95]);
      dots += circle(`g${i}${j}`);
    }
    if (L.link && i < L.rows.length - 1) for (const [qx, qy] of [L.rows[i + 1][j], L.rows[i + 1][j + 1]]) links += `<path d="M${x} ${y} L${qx} ${qy}"/>`;
  }));
  if (small) return { defs, content: dots };
  // The lead is the light source: a soft halo around it.
  const [[lx, ly]] = L.rows[0];
  const halo = L.r[0] * 2.5;
  defs += rad('halo', [[0, TONES[0][1], 0.34], [0.5, BLUE[300], 0.12], [1, BLUE[300], 0]], [lx, ly, halo]) + dropShadow('dotShadow', 10, 14, '#000814', 0.45, 40);
  const content =
    `<circle cx="${lx}" cy="${ly}" r="${f2(halo)}" fill="url(#halo)"/>` +
    `<g fill="none" stroke="${GRAY[0]}" stroke-opacity="0.2" stroke-width="${L.link}" stroke-linecap="round">${links}</g>` +
    `<g filter="url(#dotShadow)">${dots}</g>`;
  return { defs, content };
}

function icon(target) {
  const T = TARGETS[target];
  const small = T.layout === 'small';
  const b = body(small);
  const f = formation(small);
  const off = (1024 - T.size) / 2;
  const inner = `<g clip-path="url(#bodyClip)">${b.under}${f.content}${b.over}</g>`;
  const placed = T.size === 1024 ? inner : `<g transform="translate(${off} ${off}) scale(${T.size / 1024})">${inner}</g>`;
  return (
    '<svg xmlns="http://www.w3.org/2000/svg" width="1024" height="1024" viewBox="0 0 1024 1024">' +
    `<defs>${b.defs}${f.defs}${T.shadow ? dropShadow('iconShadow', T.shadow[0], T.shadow[1], '#000', T.shadow[2], 20) : ''}</defs>` +
    (T.shadow ? `<g filter="url(#iconShadow)">${placed}</g>` : placed) +
    '</svg>'
  );
}

fs.mkdirSync(path.join(root, 'build'), { recursive: true });
for (const target of Object.keys(TARGETS)) fs.writeFileSync(path.join(root, 'build', target), icon(target));
console.log(`wrote ${Object.keys(TARGETS).map((t) => `build/${t}`).join(', ')}`);
