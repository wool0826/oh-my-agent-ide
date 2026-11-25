import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

// Every value in the renderer's CSS comes from src/renderer/tokens.css. This check fails on colours,
// font sizes, radii and spacing written as literals anywhere else.
//
// Not flagged: 0 and 1px (hairlines, below the smallest space token), em and % (relative to the
// element), and numbers inside calc()/min()/max()/clamp() (geometry arithmetic around a token).

const DIR = path.join(process.cwd(), 'src', 'renderer');
const files = fs.readdirSync(DIR).filter((f) => f.endsWith('.css') && f !== 'tokens.css');

/** Literals kept on purpose: optical offsets tied to one component's own geometry. */
const ALLOW: { file: string; selector: string; property: string; literal: string; why: string }[] = [
  { file: 'styles.css', selector: '.disc', property: 'margin', literal: '-3px', why: 'pulls the 24px disclosure button into the 18px text line' },
  { file: 'styles.css', selector: '.sub', property: 'margin', literal: '17px', why: 'puts the sub-list rail under the disclosure centre' },
  { file: 'styles.css', selector: '.br', property: 'margin', literal: '26px', why: 'reply branch elbow position, paired with --er and --bw' },
  { file: 'styles.css', selector: '.br', property: 'padding-left', literal: '22px', why: 'reply branch elbow length, paired with --er and --bw' },
  { file: 'styles.css', selector: '.slider::-webkit-slider-thumb', property: 'margin-top', literal: '-7px', why: 'centres the 18px thumb on the 4px track' },
];

const NAMED = ['white', 'black', 'red', 'green', 'blue', 'gray', 'grey', 'yellow', 'orange', 'purple', 'pink', 'silver', 'navy', 'teal', 'maroon'];
const COLOR = new RegExp(`#[0-9a-f]{3,8}\\b|\\b(?:rgba?|hsla?|hwb|lab|lch|oklab|oklch|color)\\(|(?<![\\w-])(?:${NAMED.join('|')})(?![\\w-])`, 'i');
const SPACING = /^(?:margin|padding)(?:-[a-z]+)*$|^(?:row-|column-)?gap$/;
const RADIUS = /^border(?:-[a-z]+)*-radius$/;
const FONT = /^font(?:-size)?$/;

type Decl = { file: string; line: number; selector: string; property: string; value: string };

function declarations(file: string): Decl[] {
  const raw = fs.readFileSync(path.join(DIR, file), 'utf8');
  const css = raw.replace(/\/\*[\s\S]*?\*\//g, (c) => c.replace(/[^\n]/g, ' '));
  const out: Decl[] = [];
  for (const block of css.matchAll(/([^{}]*)\{([^{}]*)\}/g)) {
    const selector = block[1].trim();
    let at = block.index! + block[1].length + 1;
    for (const part of block[2].split(';')) {
      const colon = part.indexOf(':');
      if (colon > 0) {
        const lead = part.length - part.trimStart().length;
        const line = css.slice(0, at + lead).split('\n').length;
        out.push({ file, line, selector, property: part.slice(0, colon).trim().toLowerCase(), value: part.slice(colon + 1).trim() });
      }
      at += part.length + 1;
    }
  }
  return out;
}

/** Drops custom property names, var() and math functions, so only stand-alone literals remain. */
function bare(value: string): string {
  let s = value.replace(/--[\w-]+/g, '');
  for (let prev = ''; prev !== s; ) {
    prev = s;
    s = s.replace(/\b(?:var|calc|min|max|clamp|env)\([^()]*\)/g, ' ');
  }
  return s;
}

function lengths(value: string, ok: RegExp): string[] {
  return (bare(value).match(/-?\d*\.?\d+(?:px|rem|pt)\b/gi) ?? []).filter((n) => !ok.test(n));
}

const decls = files.flatMap(declarations);
const used = new Set<number>();

function problems(kind: string, test: (d: Decl) => string[]): string[] {
  const out: string[] = [];
  for (const d of decls) {
    for (const literal of test(d)) {
      const i = ALLOW.findIndex((a) => a.file === d.file && a.selector === d.selector && a.property === d.property && a.literal === literal);
      if (i >= 0) used.add(i);
      else out.push(`${d.file}:${d.line} ${d.selector} { ${d.property}: ${d.value} } — ${kind} literal ${literal}; use a token from tokens.css`);
    }
  }
  return out;
}

const colourProblems = problems('colour', (d) => {
  const m = d.value.replace(/--[\w-]+/g, '').match(COLOR);
  return m ? [m[0]] : [];
});
const sizeProblems = [
  ...problems('font size', (d) => (FONT.test(d.property) ? lengths(d.value, /^$/) : [])),
  ...problems('radius', (d) => (RADIUS.test(d.property) ? lengths(d.value, /^0(?:px)?$/) : [])),
  ...problems('spacing', (d) => (SPACING.test(d.property) ? lengths(d.value, /^-?(?:0|1)px$/) : [])),
];

test('css tokens: the renderer has stylesheets to check', () => {
  assert.ok(files.includes('styles.css'));
  assert.ok(decls.length > 500);
});

test('css tokens: no literal colours outside tokens.css', () => {
  assert.deepEqual(colourProblems, []);
});

test('css tokens: no literal font sizes, radii or spacing outside tokens.css', () => {
  assert.deepEqual(sizeProblems, []);
});

test('css tokens: every allow-list entry is still needed', () => {
  const stale = ALLOW.filter((_, i) => !used.has(i)).map((a) => `${a.selector} { ${a.property} } ${a.literal}`);
  assert.deepEqual(stale, []);
});

test('css tokens: the check catches literals', () => {
  const sample = '.x { color: #fff; margin: 0 5px; border-radius: 6px; font-size: 13px; gap: var(--space-4); padding: calc(var(--space-4) + 3px); background: rgba(0,0,0,.2); }';
  const found = [...sample.matchAll(/([a-z-]+):\s*([^;]+)/g)].flatMap(([, p, v]) => [
    ...(COLOR.test(v.replace(/--[\w-]+/g, '')) ? [p] : []),
    ...((SPACING.test(p) || RADIUS.test(p) || FONT.test(p)) && lengths(v, /^-?(?:0|1)px$/).length ? [p] : []),
  ]);
  assert.deepEqual(found, ['color', 'margin', 'border-radius', 'font-size', 'background']);
});
