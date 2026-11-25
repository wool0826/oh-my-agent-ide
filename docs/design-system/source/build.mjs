// Builds the design-system outputs from source/tokens.mjs:
//   tokens/tokens.css, tokens/tokens.json, 03-contrast-report.md, design-system.html
// Usage: node source/build.mjs        (exit code 1 if any required contrast pair fails)
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ref, scale, themes, effects, pairs } from './tokens.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const out = join(here, '..');

/* ---------- resolve ---------- */
const alias = (v) => (typeof v === 'string' ? v.match(/^\{ref\.(\w+)\.(\w+)\}$/) : null);
function resolve(theme, key) {
  const v = themes[theme][key];
  if (v === undefined) throw new Error(`unknown token ${theme}.${key}`);
  const a = alias(v);
  return a ? ref[a[1]][a[2]] : v;
}
const cssValue = (v) => { const a = alias(v); return a ? `var(--ref-${a[1]}-${a[2]})` : v; };

/* ---------- color math (WCAG 2.x) ---------- */
function parse(c) {
  c = c.trim();
  if (c === 'transparent') return [0, 0, 0, 0];
  if (c.startsWith('#')) { let h = c.slice(1); if (h.length === 3) h = [...h].map((x) => x + x).join(''); return [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16)).concat(1); }
  const m = c.match(/rgba?\(([^)]+)\)/);
  if (!m) throw new Error(`cannot parse color ${c}`);
  const p = m[1].split(',').map((s) => parseFloat(s));
  return [p[0], p[1], p[2], p[3] ?? 1];
}
const over = (fg, bg) => { const a = fg[3]; return [0, 1, 2].map((i) => fg[i] * a + bg[i] * (1 - a)).concat(1); };
const lum = (c) => { const [r, g, b] = c.slice(0, 3).map((v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; }); return 0.2126 * r + 0.7152 * g + 0.0722 * b; };
const ratio = (a, b) => { const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p); return (x + 0.05) / (y + 0.05); };
const hex = (c) => '#' + c.slice(0, 3).map((v) => Math.round(v).toString(16).padStart(2, '0')).join('');

function composite(theme, stack, withTop) {
  let bg = [0, 0, 0, 1];
  for (const layer of stack) {
    const top = layer.startsWith('@');
    if (top && !withTop) continue;
    bg = over(parse(resolve(theme, top ? layer.slice(1) : layer)), bg);
  }
  return bg;
}

function check(theme) {
  return pairs.map((p) => {
    const variants = [false, true].map((t) => composite(theme, p.bg, t));
    const results = variants.map((bg) => { const fg = over(parse(resolve(theme, p.fg)), bg); return { bg, fg, r: ratio(fg, bg) }; });
    const worst = results.sort((a, b) => a.r - b.r)[0];
    return { theme, kind: p.kind, fg: p.fg, bgName: p.bgName, need: p.need, ratio: +worst.r.toFixed(2), fgHex: hex(worst.fg), bgHex: hex(worst.bg), pass: worst.r >= p.need, note: p.note };
  });
}

/* ---------- CSS ---------- */
const flat = (prefix, obj) => Object.entries(obj).flatMap(([k, v]) => (typeof v === 'object' ? flat(`${prefix}-${k}`, v) : [[`${prefix}-${k}`.replace(/^-/, ''), v]]));
const decl = (entries, ind = '  ') => entries.map(([k, v]) => `${ind}--${k}: ${v};`).join('\n');

const derived = [
  ['bg-wash', 'linear-gradient(180deg, var(--bg-wash-color) 0, transparent 45%)'],
  ['bg-backdrop', 'var(--bg-wash), var(--bg-canvas)'],
  ['surface-sheen', 'linear-gradient(180deg, var(--surface-sheen-color) 0, color-mix(in srgb, var(--surface-sheen-color) 25%, transparent) 110px, transparent 220px)'],
  ['accent-fill', 'linear-gradient(180deg, var(--accent-fill-top), var(--accent-fill-bottom))'],
  ['accent-rim', 'inset 0 1px 0 rgba(255, 255, 255, .28), 0 2px 10px -2px var(--accent-glow)'],
  ['danger-fill', 'linear-gradient(180deg, var(--danger-fill-top), var(--danger-fill-bottom))'],
  ['danger-rim', 'inset 0 1px 0 rgba(255, 255, 255, .26), 0 2px 10px -2px var(--danger-glow)'],
  ['rim-on-accent', 'inset 0 1px 0 rgba(255, 255, 255, .22)'],
  ['knob-edge', '0 0 0 .5px rgba(0, 0, 0, .3)'],
  ['focus-outline', '2px solid var(--focus-ring)'],
  // on the user's blue bubble the blue ring would not show, so the focus ring is white
  ['on-accent-focus', '2px solid var(--text-on-accent)'],
  ['focus-offset', '2px'],
];

function themeBlock(name) {
  const colors = Object.entries(themes[name]).filter(([k]) => k !== 'color-scheme').map(([k, v]) => [k, cssValue(v)]);
  return `  color-scheme: ${themes[name]['color-scheme']};\n${decl(colors)}\n${decl(Object.entries(effects[name]))}\n${decl(derived)}`;
}

const solidSwap = ['panel', 'card', 'raised', 'selected', 'thumb', 'overlay', 'composer'].map((s) => [`surface-${s}`, `var(--surface-${s}-solid)`])
  .concat([['surface-sheen-color', 'transparent'], ['bg-wash-color', 'transparent'], ['blur-panel', 'none'], ['blur-overlay', 'none'], ['blur-scrim', 'none']]);
const motionOff = ['instant', 'fast', 'base', 'slow', 'glide'].map((d) => [`dur-${d}`, '0ms']);

const scaleEntries = [
  ['font-sans', scale.font.sans], ['font-mono', scale.font.mono],
  ['ui-font-size', scale['ui-font-size']], ['px', scale.px],
  ...flat('fs', scale.fs), ...flat('lh', scale.lh), ...flat('fw', scale.fw), ...flat('tracking', scale.tracking),
  ...flat('space', scale.space), ...flat('radius', scale.radius), ...Object.entries(scale.size),
  ...flat('dur', scale.dur), ...flat('ease', scale.ease), ...flat('blur', scale.blur), ...flat('z', scale.z),
];

const css = `/* Oh My Agent IDE — Design System v1 "Graphite Glass" tokens.
   Generated by source/build.mjs from source/tokens.mjs. Do not edit by hand.
   Themes: <html data-theme="dark|light|system">. Dark is the default.
   Accessibility switches: prefers-reduced-transparency / [data-transparency="reduced"],
   prefers-reduced-motion / [data-motion="reduced"]. */

/* 1. Primitives — never used by components directly */
:root {
${decl(flat('ref', ref))}
}

/* 2. Scales — theme independent */
:root {
${decl(scaleEntries)}
}

/* 3. Semantic roles — dark (default) */
:root, [data-theme="dark"] {
${themeBlock('dark')}
}

/* 3. Semantic roles — light */
[data-theme="light"] {
${themeBlock('light')}
}
@media (prefers-color-scheme: light) {
  [data-theme="system"] {
${themeBlock('light').replace(/^/gm, '  ')}
  }
}

/* Reduce transparency: opaque surfaces, no blur, no sheen */
@media (prefers-reduced-transparency: reduce) {
  :root, [data-theme] {
${decl(solidSwap, '    ')}
  }
}
[data-transparency="reduced"], [data-transparency="reduced"] [data-theme] {
${decl(solidSwap)}
}

/* Reduce motion: transitions become instant; components also drop looping animations */
@media (prefers-reduced-motion: reduce) {
  :root {
${decl(motionOff, '    ')}
  }
}
[data-motion="reduced"] {
${decl(motionOff)}
}
`;

/* ---------- JSON (W3C design tokens draft format) ---------- */
const typeOf = (k, v) => (/^(#|rgba?\()/.test(String(v)) || /^\{ref/.test(String(v)) ? 'color' : /shadow|rim|well/.test(k) ? 'shadow' : undefined);
const tok = (k, v) => { const t = typeOf(k, v); return t ? { $type: t, $value: v } : { $value: v }; };
const json = {
  $description: 'Oh My Agent IDE — Design System v1 "Graphite Glass". Generated by source/build.mjs. Aliases use {ref.<hue>.<step>}.',
  ref: Object.fromEntries(Object.entries(ref).map(([h, steps]) => [h, Object.fromEntries(Object.entries(steps).map(([s, v]) => [s, { $type: 'color', $value: v }]))])),
  scale: {
    font: { sans: { $type: 'fontFamily', $value: scale.font.sans }, mono: { $type: 'fontFamily', $value: scale.font.mono } },
    'ui-font-size': { $type: 'dimension', $value: scale['ui-font-size'] },
    fs: Object.fromEntries(Object.entries(scale.fs).map(([k, v]) => [k, { $type: 'dimension', $value: v }])),
    lh: Object.fromEntries(Object.entries(scale.lh).map(([k, v]) => [k, { $type: 'number', $value: +v }])),
    fw: Object.fromEntries(Object.entries(scale.fw).map(([k, v]) => [k, { $type: 'fontWeight', $value: +v }])),
    tracking: Object.fromEntries(Object.entries(scale.tracking).map(([k, v]) => [k, { $type: 'dimension', $value: v }])),
    space: Object.fromEntries(Object.entries(scale.space).map(([k, v]) => [k, { $type: 'dimension', $value: v }])),
    radius: Object.fromEntries(Object.entries(scale.radius).map(([k, v]) => [k, { $type: 'dimension', $value: v }])),
    size: Object.fromEntries(Object.entries(scale.size).map(([k, v]) => [k, { $type: 'dimension', $value: v }])),
    dur: Object.fromEntries(Object.entries(scale.dur).map(([k, v]) => [k, { $type: 'duration', $value: v }])),
    ease: Object.fromEntries(Object.entries(scale.ease).map(([k, v]) => [k, { $type: 'cubicBezier', $value: v.match(/[\d.]+/g).map(Number) }])),
    blur: Object.fromEntries(Object.entries(scale.blur).map(([k, v]) => [k, { $value: v }])),
    z: Object.fromEntries(Object.entries(scale.z).map(([k, v]) => [k, { $type: 'number', $value: +v }])),
  },
  theme: Object.fromEntries(Object.keys(themes).map((t) => [t, {
    ...Object.fromEntries(Object.entries(themes[t]).map(([k, v]) => [k, tok(k, v)])),
    ...Object.fromEntries(Object.entries(effects[t]).map(([k, v]) => [k, { $type: 'shadow', $value: v }])),
  }])),
};

/* ---------- contrast report ---------- */
const results = Object.keys(themes).flatMap(check);
const fails = results.filter((r) => !r.pass);
const md = [`# Contrast report — Design System v1

Generated by \`source/build.mjs\`. Every pair is composited the way it renders (glass alpha layers over the canvas, worst case
with and without the top wash/sheen highlight). Text needs **4.5:1** (WCAG 2.2 AA 1.4.3); non-text UI parts and glyphs need **3:1** (1.4.11).

**${results.length - fails.length} / ${results.length} pairs pass.**${fails.length ? ` Failing: ${fails.map((f) => `${f.theme} ${f.fg} on ${f.bgName}`).join('; ')}` : ''}
`];
for (const t of Object.keys(themes)) {
  for (const kind of ['text', 'non-text']) {
    const rows = results.filter((r) => r.theme === t && r.kind === kind);
    md.push(`\n## ${t === 'dark' ? 'Dark' : 'Light'} theme — ${kind === 'text' ? 'text (4.5:1)' : 'non-text (3:1)'}\n\n| Foreground token | On | FG | BG | Ratio | Result |\n|---|---|---|---|---:|---|`);
    for (const r of rows) md.push(`| \`${r.fg}\` | ${r.bgName} | \`${r.fgHex}\` | \`${r.bgHex}\` | ${r.ratio.toFixed(2)} | ${r.pass ? 'pass' : '**FAIL**'} |`);
  }
}
const notes = [...new Set(pairs.map((p) => p.note).filter(Boolean))];
if (notes.length) md.push(`\n## Usage rules the checks rely on\n\n${notes.map((n) => `- ${n}`).join('\n')}`);
md.push(`- Disabled controls (\`text-disabled\`, 45% opacity) are exempt from 1.4.3 and are not checked.
- Glyphs always sit next to a text label, so status never depends on color alone (1.4.1).`);

/* ---------- write ---------- */
writeFileSync(join(out, 'tokens', 'tokens.css'), css);
writeFileSync(join(out, 'tokens', 'tokens.json'), JSON.stringify(json, null, 2) + '\n');
writeFileSync(join(out, '03-contrast-report.md'), md.join('\n') + '\n');

const tplPath = join(here, 'design-system.template.html');
let tpl = null;
try { tpl = readFileSync(tplPath, 'utf8'); } catch { /* template not written yet */ }
if (tpl) {
  const data = JSON.stringify({ results, ref, themes, effects, scale }).replace(/</g, '\\u003c');
  const html = tpl.replace('/*@TOKENS_CSS@*/', () => css).replace('/*@DATA@*/', () => `window.DS = ${data};`);
  writeFileSync(join(out, 'design-system.html'), html);
  // The component layer is also shipped on its own, for porting into src/renderer/styles.css.
  const comp = tpl.match(/<style id="ds-components">\r?\n([\s\S]*?)<\/style>/);
  if (comp) writeFileSync(join(out, 'tokens', 'components.css'), `/* Generated by source/build.mjs from source/design-system.template.html. Needs tokens.css. */\n${comp[1]}`);
}

console.log(`contrast: ${results.length - fails.length}/${results.length} pass`);
for (const f of fails) console.log(`  FAIL ${f.theme} ${f.kind} ${f.fg} on ${f.bgName}: ${f.ratio} (${f.fgHex} on ${f.bgHex}, need ${f.need})`);
console.log(`wrote tokens.css (${css.length} B), tokens.json, 03-contrast-report.md${tpl ? ', design-system.html' : ''}`);
process.exitCode = fails.length ? 1 : 0;
