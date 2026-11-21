# 2. Design System v1 — "Graphite Glass"

The v1 system keeps the current impression: dark by default, a graphite backdrop, floating glass panels with a specular rim, capsule controls and the sliding tab pill. It resolves the inconsistencies in `01-current-audit.md`, passes WCAG 2.2 AA in both themes (`03-contrast-report.md`: 250/250 pairs), and adds a light theme.

Files:

| File | What |
|---|---|
| `tokens/tokens.css` | CSS variables: primitives, scales, dark + light + system themes, reduce-transparency and reduce-motion switches |
| `tokens/tokens.json` | The same tokens in the W3C design-tokens draft format (`$type`/`$value`, aliases as `{ref.blue.400}`) |
| `tokens/components.css` | Reference CSS for every component below, written only against the tokens |
| `design-system.html` | Self-contained artifact: palette, type, scales, motion, icons, component gallery with states, main-screen mockup (EN/한국어, dark/light) |
| `source/tokens.mjs` | Single source of truth; `node source/build.mjs` regenerates everything and fails if any contrast pair fails |

## 2.1 Principles

1. **Glass, but readable.** Glass alphas were lowered where layers stack (card inside a panel inside a wash), so text on the lightest stacked surface still clears 4.5:1.
2. **Meaning over hue.** Components ask for `--state-run`, `--danger-text`, `--meter-warn`, never `--blue`. Each hue has a text step, a vivid step and a solid step, so colored text, glyphs and filled badges each get a value that passes.
3. **One component per job.** One segmented control, one button with sizes, one menu, one pill with tones, one meter.
4. **Named steps only.** Every size, space, radius, shadow, blur, duration and easing is a token. A value that is not a token is a bug.
5. **Both languages are first class.** Korean sentences carry English product terms; type, line height and breaking are tuned for mixed lines.

## 2.2 Token architecture

```
ref.*        primitives      --ref-blue-400          never used by components
scale.*      theme-free      --fs-body, --space-8, --radius-lg, --dur-base, --z-menu
theme.*      semantic roles  --surface-panel, --text-secondary, --state-run, --meter-warn
component    in components.css, built only from the two layers above
```

- **Themes**: `<html data-theme="dark | light | system">`. Dark is the default (`:root`). `system` follows `prefers-color-scheme`. A theme attribute on any subtree re-themes that subtree (derived values such as `--accent-fill` are declared inside each theme block).
- **Reduce transparency**: `prefers-reduced-transparency: reduce` or `data-transparency="reduced"` swaps every glass role for its `*-solid` partner and turns blur, wash and sheen off.
- **Reduce motion**: `prefers-reduced-motion: reduce` or `data-motion="reduced"` sets all durations to 0; components also stop looping animations (spin, pulse, typing dots).
- **Text size**: `--ui-font-size` (default 13px) drives `--px`; every type token is `calc(N * var(--px))`, as today.

## 2.3 Color

### Primitives

Gray (16 steps, slightly cool) plus nine Apple system hues in five steps:

| Step | Role | Rule |
|---|---|---|
| 300 | Text and links on dark surfaces | ≥4.5:1 on the lightest dark card, hover and button surface |
| 400 | Vivid on dark: glyphs, bars, accents | ≥3:1 on a selected glass row |
| 500 | Vivid on light | |
| 600 | Solid fill under white text; glyphs and bars on light | white on it ≥4.5:1 |
| 700 | Text and links on light surfaces | ≥4.5:1 on the light canvas |

Dark 400s were nudged so glyphs keep 3:1 on selected glass rows: blue `#0a84ff → #1a8cff`, red `#ff453a → #ff4a40`, purple `#bf5af2 → #c463f3`, pink `#ff375f → #ff476b` (each channel ≤16/255). Green, orange, yellow, teal are unchanged.

### Semantic roles (dark / light)

| Role | Dark | Light |
|---|---|---|
| **Backdrop** | | |
| `--bg-canvas` | gray.950 `#131316` | gray.100 `#ececf0` |
| `--bg-wash-color` | `rgba(255, 255, 255, .03)` | `rgba(255, 255, 255, .55)` |
| **Glass surfaces** | | |
| `--surface-panel` | `rgba(255, 255, 255, .055)` | `rgba(255, 255, 255, .62)` |
| `--surface-sheen-color` | `rgba(255, 255, 255, .03)` | `rgba(255, 255, 255, .5)` |
| `--surface-card` | `rgba(255, 255, 255, .04)` | `rgba(255, 255, 255, .72)` |
| `--surface-raised` | `rgba(255, 255, 255, .075)` | `rgba(255, 255, 255, .9)` |
| `--surface-hover` | `rgba(255, 255, 255, .045)` | `rgba(0, 0, 0, .045)` |
| `--surface-pressed` | `rgba(255, 255, 255, .1)` | `rgba(0, 0, 0, .08)` |
| `--surface-selected` | `rgba(255, 255, 255, .09)` | `rgba(0, 0, 0, .07)` |
| `--surface-thumb` | `rgba(255, 255, 255, .2)` | `rgba(255, 255, 255, 1)` |
| `--surface-track` | `rgba(255, 255, 255, .07)` | `rgba(0, 0, 0, .06)` |
| `--surface-sunken` | `rgba(0, 0, 0, .24)` | `rgba(0, 0, 0, .045)` |
| `--surface-overlay` | `rgba(38, 38, 42, .72)` | `rgba(250, 250, 252, .84)` |
| `--surface-composer` | `rgba(42, 42, 46, .56)` | `rgba(255, 255, 255, .74)` |
| `--surface-code` | `rgba(255, 255, 255, .07)` | `rgba(0, 0, 0, .045)` |
| `--surface-code-inline` | `rgba(255, 255, 255, .1)` | `rgba(0, 0, 0, .06)` |
| `--surface-scrim` | `rgba(0, 0, 0, .4)` | `rgba(0, 0, 0, .22)` |
| **Opaque fallbacks** | | |
| `--surface-panel-solid` | `#1e1e21` | `#f7f7f9` |
| `--surface-card-solid` | `#252528` | `#ffffff` |
| `--surface-raised-solid` | `#2c2c30` | `#ffffff` |
| `--surface-selected-solid` | `#36363b` | `#e4e4e9` |
| `--surface-thumb-solid` | `#45454b` | `#ffffff` |
| `--surface-overlay-solid` | `#27272a` | `#fafafc` |
| `--surface-composer-solid` | `#242427` | `#ffffff` |
| **Text** | | |
| `--text-primary` | gray.50 `#f5f5f7` | gray.900 `#1d1d1f` |
| `--text-secondary` | gray.300 `#b4b4bb` | gray.700 `#4c4c53` |
| `--text-tertiary` | gray.400 `#a1a1a8` | gray.600 `#636369` |
| `--text-disabled` | gray.600 `#636369` | gray.400 `#a1a1a8` |
| `--text-link` | blue.300 `#64b1ff` | blue.700 `#0058c7` |
| `--text-on-accent` | gray.0 `#ffffff` | gray.0 `#ffffff` |
| `--text-on-solid` | gray.0 `#ffffff` | gray.0 `#ffffff` |
| **Lines and focus** | | |
| `--border-subtle` | `rgba(255, 255, 255, .09)` | `rgba(0, 0, 0, .08)` |
| `--border-default` | `rgba(255, 255, 255, .14)` | `rgba(0, 0, 0, .12)` |
| `--border-strong` | `rgba(255, 255, 255, .4)` | `rgba(0, 0, 0, .45)` |
| `--focus-ring` | blue.300 `#64b1ff` | blue.500 `#007aff` |
| **Accent** | | |
| `--accent` | blue.400 `#1a8cff` | blue.500 `#007aff` |
| `--accent-text` | blue.300 `#64b1ff` | blue.700 `#0058c7` |
| `--accent-solid` | blue.600 `#0a6ae8` | blue.600 `#0a6ae8` |
| `--accent-fill-top` | `#1570ea` | `#1570ea` |
| `--accent-fill-bottom` | `#0659d4` | `#0659d4` |
| `--accent-soft` | `rgba(26, 140, 255, .14)` | `rgba(0, 122, 255, .12)` |
| `--accent-glow` | `rgba(10, 108, 255, .5)` | `rgba(0, 102, 214, .32)` |
| **Status** | | |
| `--success` | green.400 `#30d158` | green.500 `#34c759` |
| `--success-text` | green.300 `#3ddc68` | green.700 `#19702f` |
| `--success-soft` | `rgba(48, 209, 88, .14)` | `rgba(52, 199, 89, .14)` |
| `--success-solid` | green.600 `#1e7d36` | green.600 `#1e7d36` |
| `--warning` | orange.400 `#ff9f0a` | orange.500 `#ff9500` |
| `--warning-text` | orange.300 `#ffb340` | orange.700 `#a84300` |
| `--warning-soft` | `rgba(255, 159, 10, .14)` | `rgba(255, 149, 0, .14)` |
| `--danger` | red.400 `#ff4a40` | red.500 `#ff3b30` |
| `--danger-text` | red.300 `#ff8a83` | red.700 `#b8150c` |
| `--danger-soft` | `rgba(255, 74, 64, .14)` | `rgba(255, 59, 48, .12)` |
| `--danger-solid` | red.600 `#d42a20` | red.600 `#d42a20` |
| `--danger-fill-top` | `#dc3027` | `#dc3027` |
| `--danger-fill-bottom` | `#c0221a` | `#c0221a` |
| `--danger-glow` | `rgba(229, 50, 42, .45)` | `rgba(212, 42, 32, .3)` |
| `--review` | purple.400 `#c463f3` | purple.500 `#af52de` |
| `--review-text` | purple.300 `#d794f7` | purple.700 `#7d3aa3` |
| `--review-soft` | `rgba(196, 99, 243, .14)` | `rgba(175, 82, 222, .12)` |
| `--neutral-soft` | `rgba(255, 255, 255, .08)` | `rgba(0, 0, 0, .06)` |
| **Agent states and kinds** | | |
| `--state-ask` | red.400 `#ff4a40` | red.600 `#d42a20` |
| `--state-run` | blue.400 `#1a8cff` | blue.600 `#0a6ae8` |
| `--state-review` | purple.400 `#c463f3` | purple.600 `#9442c4` |
| `--state-wait` | orange.400 `#ff9f0a` | orange.600 `#c25400` |
| `--state-done` | green.400 `#30d158` | green.600 `#1e7d36` |
| `--state-idle` | gray.400 `#a1a1a8` | gray.500 `#7d7d85` |
| `--state-error` | red.400 `#ff4a40` | red.600 `#d42a20` |
| `--kind-repo` | indigo.300 `#a5a4f2` | indigo.500 `#5856d6` |
| `--kind-pref` | pink.400 `#ff476b` | pink.700 `#c0103f` |
| `--kind-doc` | teal.400 `#40c8e0` | teal.700 `#006b7f` |
| **Meter and switch** | | |
| `--meter-track` | `rgba(255, 255, 255, .08)` | `rgba(0, 0, 0, .1)` |
| `--meter-ok` | green.400 `#30d158` | green.600 `#1e7d36` |
| `--meter-caution` | yellow.400 `#ffd60a` | yellow.600 `#9a6c00` |
| `--meter-warn` | orange.400 `#ff9f0a` | orange.600 `#c25400` |
| `--meter-critical` | red.400 `#ff4a40` | red.600 `#d42a20` |
| `--switch-off` | `rgba(255, 255, 255, .16)` | `rgba(120, 120, 128, .28)` |
| `--switch-on` | green.400 `#30d158` | green.600 `#1e7d36` |
| `--switch-knob` | gray.0 `#ffffff` | gray.0 `#ffffff` |
| **Diff** | | |
| `--diff-add-bg` | `rgba(48, 209, 88, .14)` | `rgba(52, 199, 89, .16)` |
| `--diff-del-bg` | `rgba(255, 74, 64, .14)` | `rgba(255, 59, 48, .12)` |
| `--diff-hunk-bg` | `rgba(26, 140, 255, .08)` | `rgba(0, 122, 255, .07)` |
| `--diff-add-text` | green.300 `#3ddc68` | green.700 `#19702f` |
| `--diff-del-text` | red.300 `#ff8a83` | red.700 `#b8150c` |
| **Other** | | |
| `--scrollbar-thumb` | `rgba(255, 255, 255, .16)` | `rgba(0, 0, 0, .2)` |

Gradients built from these: `--accent-fill` (top → bottom), `--danger-fill`, `--bg-wash`, `--surface-sheen`; `--accent-rim` and `--danger-rim` add the glossy top edge and glow.

### Color usage rules

- `--text-tertiary` is for static meta text only: section headers, timestamps, placeholders, the version string. It is never a button label; on a selected row it steps up to `--text-secondary`.
- Colored text always uses a `*-text` role (`--danger-text`, `--accent-text` …); colored glyphs, bars and dots use the base role (`--danger`, `--state-run` …); white text sits only on `*-solid` or `*-fill` roles.
- Pills and tags: background `*-soft` (hue at 14% dark / 12–14% light) + text `*-text`.
- Status never relies on color alone: glyphs differ in shape, pills carry words, meters show numbers.
- **Agent states**: ask = red, run = blue, review (PR) = purple, wait = orange, done = green, idle/archived = gray, error = red. Kinds: repo = indigo, preference = pink, document = teal. `--state-ask` and `--state-error` are separate tokens with the same value today so they can diverge (see 2.12).
- **Usage meter levels** (one rule for the toolbar and account cards): ≤30 `ok`, ≤50 `caution`, ≤80 `warn`, >80 `critical`, set with `data-level` on `.meter`.

## 2.4 Typography

Stack unchanged (system fonts, Hangul fallbacks included). Mono gains Menlo and Cascadia Mono everywhere.

| Token | px @13 | Line height | Weight | Use |
|---|---:|---|---|---|
| `--fs-display` | 24 | `--lh-title` 1.25 | 700, tracking −0.01em | Settings pane title |
| `--fs-title` | 17 | 1.25 | 700, −0.01em | View header (Worker, Repositories, Memory) |
| `--fs-headline` | 15 | 1.25 | 600 | Empty-state title, dialog title, settings title bar |
| `--fs-body` | 13 | `--lh-ui` 1.4 (rows) / `--lh-body` 1.5 (messages, cards) | 400; 500 row titles; 600 labels | Default text, bubbles, settings labels |
| `--fs-caption` | 12 | 1.4 / 1.5 | 400–500 | Secondary lines, buttons, chips, fields in panels, event lines |
| `--fs-caption2` | 11 | 1.4 | 400; 600 for headers, badges | Pills, badges, timestamps, meter labels, section headers |
| `--fs-code` | 12 | `--lh-code` 1.5 | 400 | Code blocks, diffs, mono fields |

Mapping from today: 10 and 10.5 → 11; 11.5 → 12; 12.5 → 13 (titles) or 12 (meta); 14 → 15; 20 (result glyph) becomes an icon size. Nothing is smaller than 11px.

Weights by role: 400 body · 500 controls and row titles · 600 labels, inspector and section headers, selected segment · 700 only for `--fs-title` and `--fs-display`.

**Korean and mixed copy**

- `:lang(ko) { word-break: keep-all; }` so Hangul words never split; `overflow-wrap: anywhere` still breaks long paths and URLs. `<html lang>` already follows the language setting.
- Messages, cards and descriptions use `--lh-body` 1.5; single-line UI uses 1.4.
- No letter-spacing on Hangul. Tight tracking only on titles ≥17px.
- Product terms stay English inside Korean sentences (Worker, Dispatcher, PR, Claude Code), and particles attach directly ("W-02는", "Worker에게").
- Numbers use `tabular-nums` (counts, %, times, token sizes).

## 2.5 Space, radius, size

| Space | 2 | 4 | 6 | 8 | 10 | 12 | 16 | 20 | 24 | 32 | 48 |
|---|---|---|---|---|---|---|---|---|---|---|---|
| Typical | pill/segment gap | icon gap | row padding y, menu padding | default gap, row padding x | card item padding | panel padding, button x | composer inset, settings row x | view header x | pane gap | pane padding | pane bottom |

| Radius | Value | Use |
|---|---|---|
| `--radius-xs` | 4 | kbd, inline code, diff tag |
| `--radius-sm` | 8 | menu items, code blocks |
| `--radius-md` | 10 | sidebar rows, fields, settings nav items |
| `--radius-lg` | 14 | cards, inspector and settings groups, task cards, menus, event buttons |
| `--radius-xl` | 20 | glass panels, chat bubbles, result cards |
| `--radius-2xl` | 24 | composer, dialog |
| `--radius-full` | 999 | buttons, pills, segmented controls, meters, usage capsule |

Nested corners stay concentric (inner ≈ outer − padding).

| Size | Value | Use |
|---|---|---|
| `--control-sm` | 24 | small buttons, segment items, link chips, file chips, hover pencil; minimum hit target |
| `--control-md` | 28 | default button, segmented control (24 + 2·2), stepper, dropdown, fields, menu items |
| `--control-lg` | 32 | toolbar tab pill (28 + 2·2), send, search, settings nav, large buttons (Settings, dialogs) |
| `--row-min` | 44 | settings rows |
| `--icon-sm/md/lg/hero` | 13/16/18/44 | in-button icons / glyph art / glyph box / empty states |
| Layout | 272 · 344 · 52 · 8 | sidebar, inspector, toolbar height, panel inset (unchanged) |

Targets smaller than 24px visually (chip remove 20, clear 24) get a transparent inset so the clickable area is ≥24×24 (WCAG 2.5.8).

## 2.6 Elevation and glass

| Level | Dark | Use |
|---|---|---|
| `--shadow-1` | `0 1px 4px /.3` | segment thumb, switch and slider knobs |
| `--shadow-2` | `0 6px 18px -8px /.5` | toolbar capsules |
| `--shadow-3` | `0 18px 40px -14px /.6, 0 2px 8px /.16` | panels, composer, toast |
| `--shadow-4` | `0 24px 48px -12px /.7` | menus, popovers |
| `--shadow-5` | `0 30px 70px -20px /.8` | dialogs |

Light theme uses the same geometry at about a third of the opacity.

Rims: `--rim-subtle` (hairline), `--rim` (cards, controls, panels), `--rim-strong` (floating glass, thumbs). In light theme a rim is a white top-left highlight plus a dark 0.5px hairline, so white cards stay visible on the light canvas.

Blur: `--blur-panel` 28px/180% (panels, toolbar capsules, result card), `--blur-overlay` 32px/190% (composer, menus, dialog, toast), `--blur-scrim` 3px.

| Surface | Fill | Rim | Shadow | Blur |
|---|---|---|---|---|
| Panel | `--surface-sheen, --surface-panel` | `--rim` | 3 | panel |
| Card in a panel | `--surface-card` | `--rim` | — | — |
| Toolbar capsule | `--surface-panel` | `--rim` | 2 | panel |
| Composer | `--surface-composer` | `--rim-strong` | 3 | overlay |
| Menu / popover / toast | `--surface-overlay` | `--rim-strong` | 4 (toast 3) | overlay |
| Dialog | `--surface-overlay` on `--surface-scrim` | `--rim-strong` | 5 | overlay / scrim |

## 2.7 Motion

| Token | Value | Use |
|---|---|---|
| `--dur-instant` | 80ms | press scale (buttons, send), slider knob |
| `--dur-fast` | 120ms | hover reveal (pencil, clear), row hover, menu in |
| `--dur-base` | 180ms | color/background changes, switch |
| `--dur-slow` | 300ms | meter width, pill height |
| `--dur-glide` | 460ms | tab pill travel and stretch |
| `--dur-spin` | 1000ms | running glyph |
| `--dur-attention` | 1100ms | pulse ×3 (decision count, sidebar header) |
| `--ease-standard` | `cubic-bezier(.2, 0, 0, 1)` | default |
| `--ease-out` | `cubic-bezier(0, 0, .2, 1)` | things entering |
| `--ease-in-out` | `cubic-bezier(.4, 0, .2, 1)` | pulses, size changes |
| `--ease-spring` | `cubic-bezier(.28, 1.32, .5, 1)` | tab pill travel (overshoot, unchanged) |
| `--ease-stretch` | `cubic-bezier(.3, .8, .4, 1)` | tab pill squash and stretch (unchanged) |

The tab pill keeps its exact current motion and script. With reduce motion every duration is 0 and spin/pulse/typing/flash/pop animations are off.

## 2.8 Icons

- Line icons, `currentColor`, round caps and joins. UI symbols on a 20×20 grid at stroke 1.6; small controls (chevrons, ×, tick, ±) on 16 or 8×12 grids; status glyphs on 16×16 with the stroke from CSS (1.6).
- Normalize stroke widths 1.5/1.7/1.8/1.9 to 1.6. Keep 2.2 for the send arrow and 2.4 for gear spokes (they render at 13–16px).
- Fix the duplicate `s-back`: `s-back` (16×16) for the Settings back button, `s-chev-l` (8×12) for the Worker session back button.
- Sizes: 13 in buttons, 16 glyph art in an 18 box, 17 settings nav, 18 sidebar footer, 44 empty states.

## 2.9 Components

All states below are shown in `design-system.html` (forced with `.is-hover` / `.is-active` / `disabled`). Reference CSS: `tokens/components.css`.

### Buttons — `.btn`
- Sizes: `.btn-sm` 24 · default 28 · `.btn-lg` 32 (Settings, dialogs). Font 12/500 (lg 13). Capsule. `.btn-icon` makes it square.
- Intents: default (`--surface-raised` + `--rim`), `.btn-primary` (`--accent-fill` + `--accent-rim`, white), `.btn-danger` (`--danger-text`), `.btn-danger-fill` (`--danger-fill`, white 600), `.btn-ghost` (transparent, `--text-secondary`).
- States: hover adds `--surface-hover` over the fill (primary/danger-fill darken to 94% instead, so white text never drops below 4.5:1); pressed adds `--surface-pressed` and scales to .98 (primary 86%); focus = `--focus-outline` with 2px offset; disabled = 45% opacity, no pointer.
- Replaces `.btn.def`, `.btn.danger`, `.btn.danger-fill`, `.btn.icon`, `.settings-win .btn`, `.foot-btn`, `.back`, `.segico`, `.hov`, `.clear-x`.

### Segmented control / tab pill — `.seg`
- Track `--surface-track` + `--rim`, padding 2, items 24 tall (`.seg-lg` 28 for the toolbar and Worker tabs). `.seg-glass` adds panel glass + blur + `--shadow-2` (toolbar). `.seg-fill` stretches items equally (correction scope).
- Selected: glide pill (`::before`) with `--surface-thumb` + `--rim-strong` + `--shadow-1`; text `--text-primary` 600. Each item reserves its semibold width (`::after` with `data-label`), so selecting never shifts the layout.
- Unselected: `--text-secondary` 500; hover `--text-primary`. Disabled 45%.
- Works for `aria-pressed` (toolbar), `aria-checked` (radio groups) and `aria-selected` (tabs). The glide script from `app.ts` is unchanged; it now also runs on the former `.radios`.

### Sidebar — `.row`, `.side-h`
- Row: glyph box 18, gap 8, padding 6/8, radius 10. Title 13/500 `--text-primary`, meta 11 `--text-secondary`, badge 11/600 tabular.
- States: hover `--surface-hover`, pressed `--surface-pressed`, selected (`aria-current`) `--surface-selected` + `--rim`, zero count = title in `--text-secondary`/400 and idle glyph (no opacity).
- Section header 11/600 `--text-tertiary`; "Needs your decision" uses `--danger-text` and pulses 3× when a decision arrives.

### Pills, badges, tags — `.pill[data-tone]`, `.count`, `.diff-tag`
- Pill 18 tall, 11/600, padding 0/8, tones: neutral, accent, danger, review, warning, success.
- Count badge: `--danger-solid` + white, min 18.
- Diff file status A/M/D/R: 16×16 tag, radius 4, success/warning/danger/review tones.
- Plan badge (Team/Enterprise) = accent/review pill.

### Chat — `.bubble`, `.event`, `.card-result`
- Bubble radius 20, padding 8/12, 13/1.5, max-width 78%. Me: `--accent-fill` + white (≥4.63:1). Dispatcher: `--surface-raised` + rim. Worker: `--surface-card` + rim, with a report header (`.rep-h`: title 600, link chips).
- Event line: 12 `--text-secondary`, centered, glyph 13; `.is-error` in `--danger-text`; clickable events (`.event-btn`) are cards with radius 14.
- Stamp 11/500 `--text-tertiary`; typing dots on `--surface-raised`.
- Result card: radius 20, padding 12/16, glyph 20, title 600, summary 12 `--text-secondary`, links 12.

### Composer — `.composer`
- Floating capsule, radius 24, padding 6/6/6/16, `--surface-composer` + `--blur-overlay` + `--rim-strong` + `--shadow-3`.
- Textarea 13/1.5, placeholder `--text-tertiary`; context button (ring + "42K / 250K", 11, ghost); send 32 circle.
- States: focus = 2px `--focus-ring` ring; drop = `--accent-soft` wash + 2px `--accent` ring; busy = send becomes stop (`--surface-selected`), ring turns `--meter-warn` near the compaction point; disabled 60%.
- File chips: 24 tall, radius full, remove button 20 with a 24 target.

### Task card — `.task`
- Grid 22 / 1fr / auto, gap 10, padding 10/12, radius 14, 0.5px top hairline between cards.
- Title "W-id title" 13/600; meta (repo, model, account, now) 12 `--text-secondary`; right side: context ring + K count + status pill.
- States: hover `--surface-hover`, pressed `--surface-pressed`, selected `--surface-selected` + rim, archived = title `--text-secondary`/500 + archive glyph (no opacity).

### Inbox — `.group` of `.dec`, `.res`, `.aa`
- Header `.ins-h`: 13/600 (was 700) + count badge or clear button (24, revealed on hover/focus).
- Decision: padding 12, gap 8; source 11 `--text-secondary` with glyph; question 13/600; detail 12; command as a code block; buttons right-aligned, primary last; free-text field below. Plan: markdown in a sunken well (max 220). Questions with descriptions stack options as full-width buttons.
- Result row: glyph 17, title 12/600, time 11 `--text-tertiary` tabular, links 12, summary 11.
- Answered-for-you: selected = `--accent-soft`; pencil appears on hover/focus/selection; correction scope is a `.seg-fill`; corrected answers strike through in `--text-secondary` with the new one in `--accent-text`.
- All clear: 44 glyph `--text-tertiary`, 15/600 title, optional "N Workers are busy" link button.

### Usage gauge — `.usage`, `.meter`
- Toolbar capsule (radius full, panel glass, `--shadow-2`): per account name (11/600), "5h", bar 64×6, %, "7d", bar, %. Limited accounts show the name in `--danger-text`.
- Bars use `.meter[data-level]` with the shared thresholds; the same component renders account-card meters in Settings. Bars are ≥3:1 against their track in both themes.
- Compact mode (3+ accounts) should keep the numbers in the tooltip and the level colors identical.

### Fields and controls
- `.field`: 28, radius 10, `--surface-sunken` + `--well`, 12px; hover adds a `--border-default` edge; focus `--focus-outline` (offset 0); `.is-warning` (font not installed) and `[aria-invalid]` outlines; disabled 45%. Textarea min 60, 1.5. `.mono` uses `--font-mono`.
- `.search`: 32 capsule well, icon 14, focus ring.
- `.switch`: 38×22, off = `--switch-off` + 1px `--border-strong` edge (3:1), on = `--switch-on`, knob 18 with `--shadow-1`; the knob stretches while pressed; spring easing.
- `.step`: 28 capsule, buttons 28, value 42 wide tabular; focus ring on the group.
- `.slider`: 4px track (`--accent` fill / `--meter-track`), knob 18; focus ring around the knob.
- `.dd-btn`: 28 capsule, min 180, up/down glyph; open state = pressed fill.

### Settings
- Window: title bar 52 (title 15/600), nav panel 240 (glass), pane max 680 centered, pane title 24/700, group caption 12/600.
- Nav item 32, radius 10, icon 17; hover `--surface-hover`; current `--surface-selected` + rim + 600 + `--accent` icon; setup-needed dot `--danger`.
- Group `.sgroup` radius 14 (same as inspector groups), rows min 44, padding 8/16, 0.5px separators.

### Menus, dialog, toast
- `.menu` replaces `.amenu`, `.pop`, `.ctxmenu`: padding 6, radius 14, overlay glass, `--rim-strong` + `--shadow-4`, enters with `--dur-fast`.
- `.menu-item` 28, radius 8, padding 0/12/0/6, tick column 14 (radio items), optional mono hint on the right. Highlight `--accent-solid` + white (4.95:1). Danger items `--danger-text`, highlighted with `--danger-solid`. Disabled `--text-disabled`. Separator 0.5px; group header 11/600 tertiary.
- `.dialog` 320 wide, radius 24, padding 24/20/20, title 15/600, body 12/1.5 secondary, two large buttons; scrim `--surface-scrim` + 3px blur.
- `.toast` capsule, 12, overlay glass; `.is-error` in `--danger-text`.
- z-index: composer 2, menu-catch 30, menu 31, settings 40, scrim 50, dialog 51, toast 60, popover 80, context menu 90 (resolves the 50/50 clash).

## 2.10 Accessibility summary

- **Contrast**: 250/250 checked pairs pass AA in dark and light (`03-contrast-report.md`). Before → after (dark): white on the blue gradient 2.86 → 4.63; menu highlight 3.65 → 4.95; count badge 3.41 → 5.06; danger button 2.94 → 4.67; tertiary text in an inspector card 3.50 → 4.72; link in a card 3.16 → 5.36; focus ring against a panel 1.77 → 6.05.
- **Focus**: one visible style, `2px solid --focus-ring`, offset 2 (fields: 0); `:focus-visible` everywhere except text fields.
- **Targets**: every interactive control is ≥24×24.
- **Motion and transparency**: both OS settings honored, plus attribute switches for testing.
- **Color independence**: glyph shapes, pill words and meter numbers carry the meaning.
- **Disabled**: 45% opacity, exempt from contrast, never used for informative rows.

## 2.11 Light theme

- Canvas `#ececf0` with a white wash at the top; panels are white glass (62%), cards 72%, raised 90%; selection and hover are black tints (7% / 4.5%).
- Text `#1d1d1f` / `#4c4c53` / `#636369`; links and accent text `#0058c7`.
- Vivid hues use the 500 steps for fills and the 600/700 steps for glyphs, bars and text (light glyphs on a light canvas would fail 3:1).
- The accent and danger fills (`#1570ea → #0659d4`, `#dc3027 → #c0221a`) are the same in both themes.
- On Windows the frame follows `nativeTheme` (decision 71); with a light theme the app would set `themeSource` to match the chosen theme instead of forcing dark.

## 2.12 Migration plan

1. Add `tokens.css` above `styles.css`; alias the old variables to the new ones (`--label: var(--text-primary)` …) so nothing changes visually except the contrast fixes.
2. Replace literals rule by rule using the migration tables in `design-system.html` (#migration): colors → roles, `calc(N * var(--px))` → `--fs-*`, radii, shadows, blurs, durations, z-index.
3. Merge components: `.segc`/`.radios` → `.seg`, menus → `.menu`, button variants → `.btn` modifiers, pill/badge/diff colors → tones, meters → `.meter[data-level]`.
4. Fix the duplicate `s-back` symbol and normalize strokes.
5. Add `word-break: keep-all` for Korean and the line-height split (1.4 UI / 1.5 body).
6. Add a Display → Appearance setting (Dark / Light / System) that sets `data-theme` and `nativeTheme.themeSource`.

The window grid, panel widths, glass look and the glide script stay as they are.

## 2.13 Choices made in this proposal

- The accent gradient is darker (`#3d9bff → #0a6cff` becomes `#1570ea → #0659d4`). This is the most visible change and the only way to keep white text on blue bubbles and buttons above 4.5:1.
- Secondary and tertiary text are slightly brighter (`#a7a7ad → #b4b4bb`, `#8d8d93 → #a1a1a8`), so the gap between them is smaller; size and weight carry more of the hierarchy.
- The usage meter keeps the toolbar thresholds (30/50/80) and applies them to account cards too.
- "Waiting for you" and "Error" stay red as today, under separate tokens (`--state-ask`, `--state-error`) so they can be split later.
