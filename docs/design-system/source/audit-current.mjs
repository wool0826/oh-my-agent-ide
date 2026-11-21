// Contrast audit of the CURRENT renderer colors (src/renderer/styles.css on origin/main, 73d8433).
// Usage: node source/audit-current.mjs  -> markdown table (used in 01-current-audit.md)
const hex = (h) => { h = h.replace('#', ''); if (h.length === 3) h = [...h].map((c) => c + c).join(''); return [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16)); };
const over = (fg, a, bg) => fg.map((c, i) => c * a + bg[i] * (1 - a));
const W = [255, 255, 255], K = [0, 0, 0];
const lum = (rgb) => { const [r, g, b] = rgb.map((v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; }); return 0.2126 * r + 0.7152 * g + 0.0722 * b; };
const cr = (a, b) => { const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p); return (x + 0.05) / (y + 0.05); };
const toHex = (c) => '#' + c.map((v) => Math.round(v).toString(16).padStart(2, '0')).join('');
const C = hex('#131316');
const panelTop = over(W, 0.06, over(W, 0.055, C));
const panelBot = over(W, 0.055, C);
const groupTop = over(W, 0.055, panelTop);
const selRow = over(W, 0.14, panelTop);
const bubAi = over(W, 0.09, C);
const composer = over(hex('#2a2a2e'), 0.52, C);
const menu = over(hex('#26262a'), 0.68, C);
const tint = (h, a, bg) => over(hex(h), a, bg);
const label = hex('#f5f5f7'), l2 = hex('#a7a7ad'), l3 = hex('#8d8d93');
const rows = [
  ['label on canvas', label, C, 4.5],
  ['label-2 on canvas', l2, C, 4.5],
  ['label-2 on panel top (sheen)', l2, panelTop, 4.5],
  ['label-2 on group in panel', l2, groupTop, 4.5],
  ['label-2 on selected row', l2, selRow, 4.5],
  ['label-3 on canvas (stamp)', l3, C, 4.5],
  ['label-3 on panel top (side h4)', l3, panelTop, 4.5],
  ['label-3 on group in panel (time)', l3, groupTop, 4.5],
  ['label-3 placeholder on composer', l3, composer, 4.5],
  ['#fff on accent top #3d9bff (bubble me)', W, hex('#3d9bff'), 4.5],
  ['#fff on accent mid', W, over(hex('#3d9bff'), 0.5, hex('#0a6cff')), 4.5],
  ['#fff on --blue (menu hover)', W, hex('#0a84ff'), 4.5],
  ['--blue link on canvas', hex('#0a84ff'), C, 4.5],
  ['--blue link on group in panel', hex('#0a84ff'), groupTop, 4.5],
  ['--red text on canvas (event.err)', hex('#ff453a'), C, 4.5],
  ['--red text on .btn.danger (inspector)', hex('#ff453a'), over(W, 0.085, panelTop), 4.5],
  ['--orange text on group (warn)', hex('#ff9f0a'), groupTop, 4.5],
  ['--green text on group (fixed)', hex('#30d158'), groupTop, 4.5],
  ['--purple on canvas', hex('#bf5af2'), C, 4.5],
  ['pill.blue', hex('#0a84ff'), tint('#0a84ff', 0.22, C), 4.5],
  ['pill.red', hex('#ff453a'), tint('#ff453a', 0.22, C), 4.5],
  ['pill.purple', hex('#bf5af2'), tint('#bf5af2', 0.22, C), 4.5],
  ['pill.orange', hex('#ff9f0a'), tint('#ff9f0a', 0.22, C), 4.5],
  ['pill.green', hex('#30d158'), tint('#30d158', 0.22, C), 4.5],
  ['pill (neutral) label-2 on fill', l2, over(W, 0.12, C), 4.5],
  ['.count #fff on --red', W, hex('#ff453a'), 4.5],
  ['plan-badge #6cb6ff', hex('#6cb6ff'), tint('#0a84ff', 0.18, groupTop), 4.5],
  ['diff A #fff on #2ea043', W, hex('#2ea043'), 4.5],
  ['diff D #fff on #d1453b', W, hex('#d1453b'), 4.5],
  ['diff M #fff on #b0832a', W, hex('#b0832a'), 4.5],
  ['diff R #fff on --purple', W, hex('#bf5af2'), 4.5],
  ['danger-fill #fff on #ff6259', W, hex('#ff6259'), 4.5],
  ['row.zero label @.45 on panel', over(label, 0.45, panelTop), panelTop, 4.5],
  ['toast.err red on menu', hex('#ff453a'), menu, 4.5],
  ['NON-TEXT focus ring blue45% vs panel', over(hex('#0a84ff'), 0.45, panelTop), panelTop, 3],
  ['NON-TEXT switch off track vs group', over(W, 0.16, groupTop), groupTop, 3],
  
  ['NON-TEXT --yellow bar vs track', hex('#ffd60a'), over(W, 0.1, over(W, 0.055, C)), 3],
  ['NON-TEXT --gray idle glyph on panel', hex('#98989d'), panelTop, 3],
  ['NON-TEXT --indigo repo glyph on canvas', hex('#5e5ce6'), C, 3],
];
console.log('| Pair | FG | BG | Ratio | Need | Result |\n|---|---|---|---|---|---|');
for (const [n, f, b, need] of rows) { const r = cr(f, b); console.log(`| ${n} | ${toHex(f)} | ${toHex(b)} | ${r.toFixed(2)} | ${need} | ${r >= need ? 'pass' : '**FAIL**'} |`); }
