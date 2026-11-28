// Oh My Agent IDE — Design System v1 "Graphite Glass".
// Single source of truth. `node source/build.mjs` writes tokens/tokens.css, tokens/tokens.json,
// 03-contrast-report.md and design-system.html from this file.
//
// Three layers:
//   1. ref.*      primitives (raw palette). Components never use these directly.
//   2. themes.*   semantic roles per theme (dark default, light). Components use these.
//   3. scale.*    theme-independent scales: type, space, radius, size, motion, blur, mask, z-index.
// A value written as "{ref.blue.400}" is an alias; in CSS it becomes var(--ref-blue-400).

export const ref = {
  gray: {
    0: '#ffffff', 50: '#f5f5f7', 100: '#ececf0', 150: '#e3e3e8', 200: '#d1d1d7',
    300: '#b4b4bb', 400: '#a1a1a8', 500: '#7d7d85', 600: '#636369', 700: '#4c4c53',
    750: '#3a3a3f', 800: '#2c2c30', 850: '#222226', 900: '#1d1d1f', 950: '#131316', 1000: '#000000',
  },
  // 300 = text on dark surfaces, 400 = vivid on dark, 500 = vivid on light,
  // 600 = solid fill under white text, 700 = text on light surfaces.
  blue: { 300: '#64b1ff', 400: '#1a8cff', 500: '#007aff', 600: '#0a6ae8', 700: '#0058c7' },
  red: { 300: '#ff8a83', 400: '#ff4a40', 500: '#ff3b30', 600: '#d42a20', 700: '#b8150c' },
  orange: { 300: '#ffb340', 400: '#ff9f0a', 500: '#ff9500', 600: '#c25400', 700: '#a84300' },
  yellow: { 300: '#ffd426', 400: '#ffd60a', 500: '#ffcc00', 600: '#9a6c00', 700: '#8a5c00' },
  green: { 300: '#3ddc68', 400: '#30d158', 500: '#34c759', 600: '#1e7d36', 700: '#19702f' },
  purple: { 300: '#d794f7', 400: '#c463f3', 500: '#af52de', 600: '#9442c4', 700: '#7d3aa3' },
  indigo: { 300: '#a5a4f2', 400: '#5e5ce6', 500: '#5856d6', 700: '#3634a3' },
  teal: { 300: '#5de6ff', 400: '#40c8e0', 500: '#30b0c7', 700: '#006b7f' },
  pink: { 300: '#ff859d', 400: '#ff476b', 500: '#ff2d55', 700: '#c0103f' },
};

const sansKo = '-apple-system, BlinkMacSystemFont, "SF Pro Text", "Segoe UI Variable Text", "Segoe UI", "Apple SD Gothic Neo", "Malgun Gothic", "Noto Sans KR", system-ui, sans-serif';

export const scale = {
  font: {
    sans: sansKo,
    mono: 'ui-monospace, "SF Mono", Menlo, "Cascadia Mono", Consolas, monospace',
  },
  // Every size follows the text-size setting through --px (1px at the default 13px).
  'ui-font-size': '13px',
  px: 'calc(var(--ui-font-size) / 13)',
  fs: {
    micro: 'calc(9 * var(--px))', // the two letters of an editor's badge (open in editor)
    caption2: 'calc(11 * var(--px))', // badges, pills, timestamps, meter labels, section headers
    caption: 'calc(12 * var(--px))', // secondary lines, buttons, chips, inputs in panels
    body: 'var(--ui-font-size)', // default UI and message text
    headline: 'calc(15 * var(--px))', // empty states, dialog titles, settings title bar
    title: 'calc(17 * var(--px))', // view headers (Worker, Repositories, Memory)
    display: 'calc(24 * var(--px))', // settings pane titles
    glyph: 'calc(20 * var(--px))', // the glyph of a result or failure card in the chat
    code: 'calc(12 * var(--px))', // code blocks, diffs, mono inputs
  },
  lh: { title: '1.25', ui: '1.4', body: '1.5', code: '1.5' },
  fw: { regular: '400', medium: '500', semibold: '600', bold: '700' },
  tracking: { tight: '-0.01em', normal: '0' },
  space: { 0: '0', 2: '2px', 4: '4px', 6: '6px', 8: '8px', 10: '10px', 12: '12px', 16: '16px', 20: '20px', 24: '24px', 32: '32px', 48: '48px' },
  radius: { xs: '4px', sm: '8px', md: '10px', lg: '14px', xl: '20px', '2xl': '24px', full: '999px' },
  size: {
    'control-sm': '24px', 'control-md': '28px', 'control-lg': '32px', 'row-min': '44px',
    'icon-sm': '13px', 'icon-md': '16px', 'icon-lg': '18px', 'icon-hero': '44px',
    // toolbar-h is the top strip across the window: as tall as the window's own buttons over it (STRIP_H in src/shared/theme.ts).
    'sidebar-w': '272px', 'inspector-w': '344px', 'toolbar-h': '56px', 'panel-inset': '8px', 'settings-nav-w': '240px', 'settings-max': '680px',
  },
  dur: { instant: '80ms', fast: '120ms', base: '180ms', slow: '300ms', glide: '460ms', spin: '1000ms', attention: '1100ms' },
  ease: {
    standard: 'cubic-bezier(.2, 0, 0, 1)',
    out: 'cubic-bezier(0, 0, .2, 1)',
    'in-out': 'cubic-bezier(.4, 0, .2, 1)',
    spring: 'cubic-bezier(.28, 1.32, .5, 1)', // tab pill travel: slight overshoot
    stretch: 'cubic-bezier(.3, .8, .4, 1)', // tab pill squash and stretch
  },
  blur: { panel: 'blur(28px) saturate(180%)', overlay: 'blur(32px) saturate(190%)', scrim: 'blur(3px)' },
  mask: { solid: '#000' }, // opaque stop of a fade mask: only its alpha counts, so one value for both themes
  z: { raised: '1', composer: '2', resize: '3', drawer: '20', 'menu-catch': '30', menu: '31', settings: '40', scrim: '50', dialog: '51', toast: '60', popover: '80', ctxmenu: '90', tooltip: '100' },
};

// Semantic roles. Keys are the CSS variable names without "--".
// Colors used in contrast checks must be hex or rgba(); gradients are built from *-top/*-bottom stops.
const common = {
  'text-on-accent': '{ref.gray.0}',
  'text-on-solid': '{ref.gray.0}',
  // on an accent fill (a sent message, a highlighted row): a chip or key cap, and a well
  'surface-on-accent': 'rgba(255, 255, 255, .2)',
  'surface-on-accent-sunken': 'rgba(0, 0, 0, .2)',
  // on the user's blue bubble (the same blue in both themes): the hairline under a quote
  'on-accent-line': 'rgba(255, 255, 255, .4)',
  // PR state, as on GitHub: open = green, merged = purple, closed = gray. Glyphs use pr-*, pill text pr-*-text on
  // pr-*-soft. Aliases of the roles of each theme, so dark, light and system all follow.
  'pr-open': 'var(--state-done)', 'pr-open-text': 'var(--success-text)', 'pr-open-soft': 'var(--success-soft)',
  'pr-merged': 'var(--state-review)', 'pr-merged-text': 'var(--review-text)', 'pr-merged-soft': 'var(--review-soft)',
  'pr-closed': 'var(--state-idle)', 'pr-closed-text': 'var(--text-secondary)', 'pr-closed-soft': 'var(--neutral-soft)',
  // Account avatars: white initials on a fill that holds 4.5:1 in both themes.
  'avatar-1': 'var(--accent-solid)', 'avatar-2': 'var(--success-solid)', 'avatar-3': '{ref.purple.600}', 'avatar-4': '{ref.orange.600}',
  // Editor badges (open in editor): two letters on a fill, not the product's logo.
  'editor-vscode': '{ref.blue.600}', 'editor-cursor': '{ref.gray.900}', 'editor-idea': '{ref.orange.600}',
};

export const themes = {
  dark: {
    'color-scheme': 'dark',
    // backdrop
    'bg-canvas': '{ref.gray.950}',
    'bg-wash-color': 'rgba(255, 255, 255, .03)',
    // glass surfaces (alpha over whatever lies beneath)
    'surface-panel': 'rgba(255, 255, 255, .055)',
    'surface-sheen-color': 'rgba(255, 255, 255, .03)',
    'surface-card': 'rgba(255, 255, 255, .04)',
    'surface-raised': 'rgba(255, 255, 255, .075)',
    'surface-hover': 'rgba(255, 255, 255, .045)',
    'surface-pressed': 'rgba(255, 255, 255, .1)',
    'surface-selected': 'rgba(255, 255, 255, .09)',
    'surface-thumb': 'rgba(255, 255, 255, .2)',
    'surface-track': 'rgba(255, 255, 255, .07)',
    'surface-sunken': 'rgba(0, 0, 0, .24)',
    'surface-overlay': 'rgba(38, 38, 42, .72)',
    'surface-composer': 'rgba(42, 42, 46, .56)',
    'surface-code': 'rgba(255, 255, 255, .07)',
    'surface-code-inline': 'rgba(255, 255, 255, .1)',
    'surface-scrim': 'rgba(0, 0, 0, .4)',
    // opaque fallbacks (Reduce transparency)
    'surface-panel-solid': '#1e1e21', 'surface-card-solid': '#252528', 'surface-raised-solid': '#2c2c30',
    'surface-selected-solid': '#36363b', 'surface-thumb-solid': '#45454b', 'surface-overlay-solid': '#27272a', 'surface-composer-solid': '#242427',
    // text
    'text-primary': '{ref.gray.50}',
    'text-secondary': '{ref.gray.300}',
    'text-tertiary': '{ref.gray.400}',
    'text-disabled': '{ref.gray.600}',
    'text-link': '{ref.blue.300}',
    ...common,
    // lines
    'border-subtle': 'rgba(255, 255, 255, .09)',
    'border-default': 'rgba(255, 255, 255, .14)',
    'border-strong': 'rgba(255, 255, 255, .4)',
    // reply branches in the chat: one opaque colour, so joints never double up; blue while lit
    'reply-line': '{ref.gray.600}',
    'reply-line-on': '{ref.blue.400}',
    'focus-ring': '{ref.blue.300}',
    // accent
    accent: '{ref.blue.400}',
    'accent-text': '{ref.blue.300}',
    'accent-solid': '{ref.blue.600}',
    'accent-fill-top': '#1570ea',
    'accent-fill-bottom': '#0659d4',
    'accent-soft': 'rgba(26, 140, 255, .14)',
    'accent-glow': 'rgba(10, 108, 255, .5)',
    // status
    success: '{ref.green.400}', 'success-text': '{ref.green.300}', 'success-soft': 'rgba(48, 209, 88, .14)', 'success-solid': '{ref.green.600}',
    warning: '{ref.orange.400}', 'warning-text': '{ref.orange.300}', 'warning-soft': 'rgba(255, 159, 10, .14)',
    danger: '{ref.red.400}', 'danger-text': '{ref.red.300}', 'danger-soft': 'rgba(255, 74, 64, .14)', 'danger-solid': '{ref.red.600}',
    'danger-fill-top': '#dc3027', 'danger-fill-bottom': '#c0221a', 'danger-glow': 'rgba(229, 50, 42, .45)',
    review: '{ref.purple.400}', 'review-text': '{ref.purple.300}', 'review-soft': 'rgba(196, 99, 243, .14)',
    'neutral-soft': 'rgba(255, 255, 255, .08)',
    // agent states and kinds (glyph colors; 3:1 against panels). state-ask is a fill with text-on-ask on it: "needs you" is a
    // solid disc, pill or badge, told from running (a blue glyph) and from an error (red) by its shape.
    'state-ask': '{ref.blue.400}', 'text-on-ask': '{ref.gray.950}', 'state-run': '{ref.blue.400}', 'state-review': '{ref.purple.400}', 'state-wait': '{ref.orange.400}',
    'state-done': '{ref.green.400}', 'state-idle': '{ref.gray.400}', 'state-error': '{ref.red.400}',
    'kind-repo': '{ref.indigo.300}', 'kind-pref': '{ref.pink.400}', 'kind-doc': '{ref.teal.400}',
    // usage meter
    'meter-track': 'rgba(255, 255, 255, .08)',
    'meter-ok': '{ref.green.400}', 'meter-caution': '{ref.yellow.400}', 'meter-warn': '{ref.orange.400}', 'meter-critical': '{ref.red.400}',
    // switch
    'switch-off': 'rgba(255, 255, 255, .16)', 'switch-on': '{ref.green.400}', 'switch-knob': '{ref.gray.0}',
    // diff
    'diff-add-bg': 'rgba(48, 209, 88, .14)', 'diff-del-bg': 'rgba(255, 74, 64, .14)', 'diff-hunk-bg': 'rgba(26, 140, 255, .08)',
    'diff-add-text': '{ref.green.300}', 'diff-del-text': '{ref.red.300}',
    // scrollbar
    'scrollbar-thumb': 'rgba(255, 255, 255, .16)',
    // side terminal (xterm.js): its ground, text, cursor and selection, and the 16 colours programs print in
    'term-bg': '{ref.gray.900}', 'term-fg': '{ref.gray.50}', 'term-cursor': '{ref.gray.50}', 'term-selection': 'rgba(100, 177, 255, .3)', 'term-match': '{ref.yellow.700}', 'term-match-current': '{ref.orange.600}',
    'ansi-black': '{ref.gray.750}', 'ansi-red': '{ref.red.400}', 'ansi-green': '{ref.green.400}', 'ansi-yellow': '{ref.yellow.400}',
    'ansi-blue': '{ref.blue.400}', 'ansi-magenta': '{ref.purple.400}', 'ansi-cyan': '{ref.teal.400}', 'ansi-white': '{ref.gray.300}',
    'ansi-bright-black': '{ref.gray.500}', 'ansi-bright-red': '{ref.red.300}', 'ansi-bright-green': '{ref.green.300}', 'ansi-bright-yellow': '{ref.yellow.300}',
    'ansi-bright-blue': '{ref.blue.300}', 'ansi-bright-magenta': '{ref.purple.300}', 'ansi-bright-cyan': '{ref.teal.300}', 'ansi-bright-white': '{ref.gray.0}',
  },
  light: {
    'color-scheme': 'light',
    'bg-canvas': '{ref.gray.100}',
    'bg-wash-color': 'rgba(255, 255, 255, .55)',
    'surface-panel': 'rgba(255, 255, 255, .62)',
    'surface-sheen-color': 'rgba(255, 255, 255, .5)',
    'surface-card': 'rgba(255, 255, 255, .72)',
    'surface-raised': 'rgba(255, 255, 255, .9)',
    'surface-hover': 'rgba(0, 0, 0, .045)',
    'surface-pressed': 'rgba(0, 0, 0, .08)',
    'surface-selected': 'rgba(0, 0, 0, .07)',
    'surface-thumb': 'rgba(255, 255, 255, 1)',
    'surface-track': 'rgba(0, 0, 0, .06)',
    'surface-sunken': 'rgba(0, 0, 0, .045)',
    'surface-overlay': 'rgba(250, 250, 252, .84)',
    'surface-composer': 'rgba(255, 255, 255, .74)',
    'surface-code': 'rgba(0, 0, 0, .045)',
    'surface-code-inline': 'rgba(0, 0, 0, .06)',
    'surface-scrim': 'rgba(0, 0, 0, .22)',
    'surface-panel-solid': '#f7f7f9', 'surface-card-solid': '#ffffff', 'surface-raised-solid': '#ffffff',
    'surface-selected-solid': '#e4e4e9', 'surface-thumb-solid': '#ffffff', 'surface-overlay-solid': '#fafafc', 'surface-composer-solid': '#ffffff',
    'text-primary': '{ref.gray.900}',
    'text-secondary': '{ref.gray.700}',
    'text-tertiary': '{ref.gray.600}',
    'text-disabled': '{ref.gray.400}',
    'text-link': '{ref.blue.700}',
    ...common,
    'border-subtle': 'rgba(0, 0, 0, .08)',
    'border-default': 'rgba(0, 0, 0, .12)',
    'border-strong': 'rgba(0, 0, 0, .45)',
    'reply-line': '{ref.gray.400}',
    'reply-line-on': '{ref.blue.500}',
    'focus-ring': '{ref.blue.500}',
    accent: '{ref.blue.500}',
    'accent-text': '{ref.blue.700}',
    'accent-solid': '{ref.blue.600}',
    'accent-fill-top': '#1570ea',
    'accent-fill-bottom': '#0659d4',
    'accent-soft': 'rgba(0, 122, 255, .12)',
    'accent-glow': 'rgba(0, 102, 214, .32)',
    success: '{ref.green.500}', 'success-text': '{ref.green.700}', 'success-soft': 'rgba(52, 199, 89, .14)', 'success-solid': '{ref.green.600}',
    warning: '{ref.orange.500}', 'warning-text': '{ref.orange.700}', 'warning-soft': 'rgba(255, 149, 0, .14)',
    danger: '{ref.red.500}', 'danger-text': '{ref.red.700}', 'danger-soft': 'rgba(255, 59, 48, .12)', 'danger-solid': '{ref.red.600}',
    'danger-fill-top': '#dc3027', 'danger-fill-bottom': '#c0221a', 'danger-glow': 'rgba(212, 42, 32, .3)',
    review: '{ref.purple.500}', 'review-text': '{ref.purple.700}', 'review-soft': 'rgba(175, 82, 222, .12)',
    'neutral-soft': 'rgba(0, 0, 0, .06)',
    'state-ask': '{ref.blue.600}', 'text-on-ask': '{ref.gray.0}', 'state-run': '{ref.blue.600}', 'state-review': '{ref.purple.600}', 'state-wait': '{ref.orange.600}',
    'state-done': '{ref.green.600}', 'state-idle': '{ref.gray.500}', 'state-error': '{ref.red.600}',
    'kind-repo': '{ref.indigo.500}', 'kind-pref': '{ref.pink.700}', 'kind-doc': '{ref.teal.700}',
    'meter-track': 'rgba(0, 0, 0, .1)',
    'meter-ok': '{ref.green.600}', 'meter-caution': '{ref.yellow.600}', 'meter-warn': '{ref.orange.600}', 'meter-critical': '{ref.red.600}',
    'switch-off': 'rgba(120, 120, 128, .28)', 'switch-on': '{ref.green.600}', 'switch-knob': '{ref.gray.0}',
    'diff-add-bg': 'rgba(52, 199, 89, .16)', 'diff-del-bg': 'rgba(255, 59, 48, .12)', 'diff-hunk-bg': 'rgba(0, 122, 255, .07)',
    'diff-add-text': '{ref.green.700}', 'diff-del-text': '{ref.red.700}',
    'scrollbar-thumb': 'rgba(0, 0, 0, .2)',
    'term-bg': '{ref.gray.0}', 'term-fg': '{ref.gray.900}', 'term-cursor': '{ref.gray.900}', 'term-selection': 'rgba(0, 122, 255, .2)', 'term-match': '{ref.yellow.300}', 'term-match-current': '{ref.orange.300}',
    'ansi-black': '{ref.gray.900}', 'ansi-red': '{ref.red.600}', 'ansi-green': '{ref.green.600}', 'ansi-yellow': '{ref.yellow.600}',
    'ansi-blue': '{ref.blue.600}', 'ansi-magenta': '{ref.purple.600}', 'ansi-cyan': '{ref.teal.700}', 'ansi-white': '{ref.gray.500}',
    'ansi-bright-black': '{ref.gray.600}', 'ansi-bright-red': '{ref.red.700}', 'ansi-bright-green': '{ref.green.700}', 'ansi-bright-yellow': '{ref.yellow.700}',
    'ansi-bright-blue': '{ref.blue.700}', 'ansi-bright-magenta': '{ref.purple.700}', 'ansi-bright-cyan': '{ref.teal.500}', 'ansi-bright-white': '{ref.gray.400}',
  },
};

// Shadows and specular rims differ per theme (dark: light catches the rim; light: a hairline defines the edge).
export const effects = {
  dark: {
    'rim-subtle': 'inset 0 0 0 .5px rgba(255, 255, 255, .06)',
    rim: 'inset 1px 1px 0 rgba(255, 255, 255, .16), inset -1px -1px 0 rgba(255, 255, 255, .06), inset 0 0 0 .5px rgba(255, 255, 255, .06)',
    'rim-strong': 'inset 1.2px 1.2px 0 rgba(255, 255, 255, .3), inset -1px -1px 0 rgba(255, 255, 255, .11), inset 0 0 0 .5px rgba(255, 255, 255, .1)',
    well: 'inset 0 1px 2px rgba(0, 0, 0, .28), inset 0 0 0 .5px rgba(255, 255, 255, .1)',
    'shadow-1': '0 1px 4px rgba(0, 0, 0, .3)',
    'shadow-2': '0 6px 18px -8px rgba(0, 0, 0, .5)',
    'shadow-3': '0 18px 40px -14px rgba(0, 0, 0, .6), 0 2px 8px rgba(0, 0, 0, .16)',
    'shadow-4': '0 24px 48px -12px rgba(0, 0, 0, .7)',
    'shadow-5': '0 30px 70px -20px rgba(0, 0, 0, .8)',
  },
  light: {
    'rim-subtle': 'inset 0 0 0 .5px rgba(0, 0, 0, .06)',
    rim: 'inset 1px 1px 0 rgba(255, 255, 255, .9), inset 0 0 0 .5px rgba(0, 0, 0, .1)',
    'rim-strong': 'inset 1.2px 1.2px 0 rgba(255, 255, 255, 1), inset 0 0 0 .5px rgba(0, 0, 0, .14)',
    well: 'inset 0 1px 2px rgba(0, 0, 0, .08), inset 0 0 0 .5px rgba(0, 0, 0, .14)',
    'shadow-1': '0 1px 3px rgba(0, 0, 0, .14)',
    'shadow-2': '0 6px 18px -8px rgba(0, 0, 0, .16)',
    'shadow-3': '0 18px 40px -16px rgba(0, 0, 0, .2), 0 2px 8px rgba(0, 0, 0, .05)',
    'shadow-4': '0 24px 48px -12px rgba(0, 0, 0, .24)',
    'shadow-5': '0 30px 70px -20px rgba(0, 0, 0, .32)',
  },
};

// Contrast pairs. A background is a stack of layers from the bottom; the checker composites them.
// "@top" layers add the wash/sheen highlight; the checker evaluates with and without it and keeps the worst.
const CANVAS = ['bg-canvas', '@bg-wash-color'];
const PANEL = [...CANVAS, 'surface-panel', '@surface-sheen-color'];
const CARD_IN_PANEL = [...PANEL, 'surface-card'];
const SEL_IN_PANEL = [...PANEL, 'surface-selected'];
const HOVER_IN_PANEL = [...PANEL, 'surface-hover'];
const RAISED_ON_CANVAS = [...CANVAS, 'surface-raised'];
const CARD_ON_CANVAS = [...CANVAS, 'surface-card'];
const BTN_IN_PANEL = [...PANEL, 'surface-raised'];
const COMPOSER = [...CANVAS, 'surface-composer'];
const OVERLAY = [...PANEL, 'surface-overlay'];
const SUNKEN_IN_CARD = [...CARD_ON_CANVAS, 'surface-sunken'];
const SUNKEN_IN_PANEL = [...PANEL, 'surface-sunken'];
const THUMB = [...PANEL, 'surface-track', 'surface-thumb'];

export const surfaces = { CANVAS, PANEL, CARD_IN_PANEL, SEL_IN_PANEL, HOVER_IN_PANEL, RAISED_ON_CANVAS, CARD_ON_CANVAS, BTN_IN_PANEL, COMPOSER, OVERLAY, SUNKEN_IN_CARD, SUNKEN_IN_PANEL, THUMB };

const text = (fg, bgs, note = '') => bgs.map(([name, stack]) => ({ kind: 'text', fg, bg: stack, bgName: name, need: 4.5, note }));
const ui = (fg, bgs, note = '') => bgs.map(([name, stack]) => ({ kind: 'non-text', fg, bg: stack, bgName: name, need: 3, note }));
const ALL = [['canvas', CANVAS], ['panel', PANEL], ['card in panel', CARD_IN_PANEL], ['selected row', SEL_IN_PANEL], ['hover row', HOVER_IN_PANEL], ['AI bubble', RAISED_ON_CANVAS], ['button in panel', BTN_IN_PANEL], ['composer', COMPOSER], ['menu', OVERLAY], ['input in card', SUNKEN_IN_CARD], ['segment thumb', THUMB]];
const NO_THUMB = ALL.filter(([n]) => n !== 'segment thumb');
const TERTIARY_OK = ALL.filter(([n]) => !['selected row', 'segment thumb', 'button in panel'].includes(n));
const CARDS = [['canvas', CANVAS], ['panel', PANEL], ['card in panel', CARD_IN_PANEL], ['AI bubble', RAISED_ON_CANVAS]];
const softOn = (soft) => [['own tint on canvas', [...CANVAS, soft]], ['own tint in card', [...CARD_IN_PANEL, soft]]];

export const pairs = [
  ...text('text-primary', ALL),
  ...text('text-secondary', NO_THUMB, 'The selected segment of a segmented control always uses text-primary.'),
  ...text('text-tertiary', TERTIARY_OK, 'text-tertiary is for static meta text (section headers, timestamps, placeholders, version). It is never a button label; on a selected row it steps up to text-secondary.'),
  ...text('text-link', [...CARDS, ['menu', OVERLAY], ['button in panel', BTN_IN_PANEL]]),
  ...text('text-on-accent', [['accent fill (top)', ['accent-fill-top']], ['accent fill (bottom)', ['accent-fill-bottom']], ['accent solid (menu highlight)', ['accent-solid']]]),
  ...text('text-on-ask', [['needs-you fill (pill, badge, glyph disc)', ['state-ask']]]),
  ...text('text-on-solid', [['danger solid (badge)', ['danger-solid']], ['danger fill (top)', ['danger-fill-top']], ['success solid', ['success-solid']]]),
  ...text('text-on-solid', [['avatar 3', ['avatar-3']], ['avatar 4', ['avatar-4']]], 'Avatars 1 and 2 are accent-solid and success-solid, checked above.'),
  ...text('danger-text', [...CARDS, ['button in panel', BTN_IN_PANEL], ['menu', OVERLAY], ...softOn('danger-soft')]),
  ...text('warning-text', [...CARDS, ...softOn('warning-soft')]),
  ...text('success-text', [...CARDS, ...softOn('success-soft')]),
  ...text('review-text', [...CARDS, ...softOn('review-soft')]),
  ...text('accent-text', [...CARDS, ...softOn('accent-soft')]),
  ...text('text-secondary', softOn('neutral-soft'), 'Neutral pill.'),
  ...text('diff-add-text', [['add line in card', [...CARD_ON_CANVAS, 'diff-add-bg']]]),
  ...text('diff-del-text', [['del line in card', [...CARD_ON_CANVAS, 'diff-del-bg']]]),
  ...text('text-primary', [['add line in card', [...CARD_ON_CANVAS, 'diff-add-bg']], ['del line in card', [...CARD_ON_CANVAS, 'diff-del-bg']]]),
  ...ui('focus-ring', [['canvas', CANVAS], ['panel', PANEL], ['card in panel', CARD_IN_PANEL], ['input in panel', SUNKEN_IN_PANEL]]),
  ...['state-ask', 'state-run', 'state-review', 'state-wait', 'state-done', 'state-idle', 'kind-repo', 'kind-pref', 'kind-doc'].flatMap((s) => ui(s, [['panel', PANEL], ['card in panel', CARD_IN_PANEL], ['selected row', SEL_IN_PANEL], ['canvas', CANVAS]])),
  ...['meter-ok', 'meter-caution', 'meter-warn', 'meter-critical'].flatMap((m) => ui(m, [['meter track', [...PANEL, 'meter-track']]])),
  ...ui('border-strong', [['card in panel (switch off rim)', CARD_IN_PANEL]]),
  ...ui('switch-on', [['card in panel', CARD_IN_PANEL]]),
];
