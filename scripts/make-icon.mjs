// Writes the app icon as SVG into build/. Render PNG, ICO and ICNS afterwards with `npm run icon`.
//   icon.svg, icon-small.svg          macOS layout
//   icon-win.svg, icon-win-small.svg  Windows layout
// Graphite Glass (docs/design-system): a graphite glass squircle holding the name in three lines,
// "Oh," and "My" in white and "Agent" in blue italic, with a blue bar down their left.
// The small files are for 32 px and below, where three lines cannot be read: the bar and a large "Oh".
// The lettering is outlines (scripts/icon-lettering.mjs), so no font is needed here.
// The body is drawn in a 1024 unit box and placed on a 1024 canvas:
//   mac: 824 body with room for its shadow (macOS icon grid); win: 960 body, lighter shadow; win small: full bleed, no shadow.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { AGENT, MY, OH, OH_SMALL } from './icon-lettering.mjs';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const f2 = (n) => String(+n.toFixed(2));

// Primitives from docs/design-system/source/tokens.mjs (ref.gray, ref.blue).
const GRAY = { 0: '#ffffff', 750: '#3a3a3f', 850: '#222226', 950: '#131316' };
const BLUE = { 400: '#1a8cff' };

// The bar, on the 100 unit grid the lettering was set on: [x, y, width, height].
// Full: from the top of "Oh," to below the "g" of "Agent". Small: the height of "Oh".
const BAR = { full: [12, 18, 3.6, 68], small: [11, 33.5, 7.5, 33.5] };
/** Extra weight for the small "Oh", as a stroke in its own color (1024 units). */
const SMALL_STROKE = 14;

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

/** Graphite glass body: dark gradient, a sheen from the upper left, a top-lit rim. */
function body(small) {
  const defs =
    `<path id="body" d="${squircle()}"/><clipPath id="bodyClip"><use href="#body"/></clipPath>` +
    lin('bg', [[0, GRAY[750]], [0.45, GRAY[850]], [1, GRAY[950]]], [0, 0, 0, 1024]) +
    rad('sheen', [[0, GRAY[0], 0.17], [1, GRAY[0], 0]], [300, -40, 900]) +
    // Small sizes get a stronger rim, which keeps the body apart from a dark taskbar.
    lin('rim', [[0, GRAY[0], small ? 0.6 : 0.5], [0.2, GRAY[0], 0.16], [0.6, GRAY[0], small ? 0.14 : 0.07], [1, GRAY[0], small ? 0.3 : 0.2]], [0, 0, 0, 1024]);
  const under = '<use href="#body" fill="url(#bg)"/><use href="#body" fill="url(#sheen)"/>';
  // The stroke is centered on the outline and clipped, so half its width shows.
  const over = `<use href="#body" fill="none" stroke="url(#rim)" stroke-width="${small ? 44 : 9}"/>`;
  return { defs, under, over };
}

/** The bar and the name. The bar and "Agent" carry the accent. */
function lettering(small) {
  const [x, y, w, h] = BAR[small ? 'small' : 'full'].map((v) => f2(v * 10.24));
  const bar = `<rect x="${x}" y="${y}" width="${w}" height="${h}" fill="${BLUE[400]}"/>`;
  if (small) return `${bar}<path d="${OH_SMALL}" fill="${GRAY[0]}" stroke="${GRAY[0]}" stroke-width="${SMALL_STROKE}" stroke-linejoin="round"/>`;
  return `${bar}<path d="${OH}${MY}" fill="${GRAY[0]}"/><path d="${AGENT}" fill="${BLUE[400]}"/>`;
}

function icon(target) {
  const T = TARGETS[target];
  const small = T.layout === 'small';
  const b = body(small);
  const off = (1024 - T.size) / 2;
  const inner = `<g clip-path="url(#bodyClip)">${b.under}${lettering(small)}${b.over}</g>`;
  const placed = T.size === 1024 ? inner : `<g transform="translate(${off} ${off}) scale(${T.size / 1024})">${inner}</g>`;
  return (
    '<svg xmlns="http://www.w3.org/2000/svg" width="1024" height="1024" viewBox="0 0 1024 1024">' +
    `<defs>${b.defs}${T.shadow ? dropShadow('iconShadow', T.shadow[0], T.shadow[1], '#000', T.shadow[2], 20) : ''}</defs>` +
    (T.shadow ? `<g filter="url(#iconShadow)">${placed}</g>` : placed) +
    '</svg>'
  );
}

fs.mkdirSync(path.join(root, 'build'), { recursive: true });
for (const target of Object.keys(TARGETS)) fs.writeFileSync(path.join(root, 'build', target), icon(target));
console.log(`wrote ${Object.keys(TARGETS).map((t) => `build/${t}`).join(', ')}`);
