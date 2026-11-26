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
- **The app's copy**: `src/renderer/tokens.css` is `tokens/tokens.css` under a header comment, with nothing added (a unit test compares them). Every token the app uses is in `source/tokens.mjs`, including the names only the app needs (`--lights-*`, `--pr-*`, `--avatar-*`, `--on-accent-*`). To change a token: edit `source/tokens.mjs`, run `node source/build.mjs`, copy the file again.

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
| `--reply-line` | gray 600 | gray 400 |
| `--reply-line-on` | blue 400 | blue 500 |
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
| `--state-ask` | blue.400 `#1a8cff` | blue.600 `#0a6ae8` |
| `--text-on-ask` | gray.950 `#131316` | gray.0 `#ffffff` |
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

Aliases of the roles above, so they follow every theme:

| Alias | Glyph | Pill text | Pill fill |
|---|---|---|---|
| PR open `--pr-open` / `-text` / `-soft` | `--state-done` | `--success-text` | `--success-soft` |
| PR merged `--pr-merged` / `-text` / `-soft` | `--state-review` | `--review-text` | `--review-soft` |
| PR closed `--pr-closed` / `-text` / `-soft` | `--state-idle` | `--text-secondary` | `--neutral-soft` |

Account avatars carry white initials (`--text-on-solid`) on one of four fills, by the account's place in the list: `--avatar-1` = `--accent-solid`, `--avatar-2` = `--success-solid`, `--avatar-3` = purple.600, `--avatar-4` = orange.600. Each holds 4.5:1 in both themes.

### Color usage rules

- `--text-tertiary` is for static meta text only: section headers, timestamps, placeholders, the version string. It is never a button label; on a selected row it steps up to `--text-secondary`.
- Colored text always uses a `*-text` role (`--danger-text`, `--accent-text` …); colored glyphs, bars and dots use the base role (`--danger`, `--state-run` …); white text sits only on `*-solid` or `*-fill` roles.
- Pills and tags: background `*-soft` (hue at 14% dark / 12–14% light) + text `*-text`.
- Status never relies on color alone: glyphs differ in shape, pills carry words, meters show numbers.
- **Agent states**: ask = a solid accent fill (`--state-ask` under `--text-on-ask`: the glyph disc, the "Needs your decision" pill and the decision count badges), run = blue, review (PR) = purple, wait = orange, done = green, idle/archived = gray, error = red. Kinds: repo = indigo, preference = pink, document = teal. Red is for errors only: `--state-ask` was red like `--state-error` until T-0045, which split them so "needs you" and "broke" do not look alike. Ask and run share the hue and differ by fill and glyph (a solid disc with "!", a spinning arc).
- **Usage meter levels** (one rule for the toolbar rings, the usage popover and account cards): ≤30 `ok`, ≤50 `caution`, ≤80 `warn`, >80 `critical`. A bar carries the level as `data-level` on `.meter`, a ring as `lv-g/y/o/r`.

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
| `--fs-glyph` | 20 | 1 | 400 | The glyph of an attachment tile (`.attach .tile`); a drawing size that follows the text size, not a text style |

Mapping from today: 10 and 10.5 → 11; 11.5 → 12; 12.5 → 13 (titles) or 12 (meta); 14 → 15; 20 (result glyph) becomes an icon size. Nothing is smaller than 11px.

Weights by role: 400 body · 500 controls and row titles · 600 labels, inspector and section headers, selected segment · 700 only for `--fs-title` and `--fs-display`.

**Korean and mixed copy**

- `:lang(ko) { word-break: keep-all; }` so Hangul words never split; `overflow-wrap: anywhere` still breaks long paths and URLs. `<html lang>` already follows the language setting.
- Messages, cards and descriptions use `--lh-body` 1.5; single-line UI uses 1.4.
- No letter-spacing on Hangul. Tight tracking only on titles ≥17px.
- Malgun Gothic (Hangul on Windows) has only 400 and 700, so 500 falls to 400. In Korean on Windows the 500 titles (sidebar and history row titles, palette items, toolbar view tabs) take 600, which Malgun draws bold (`.platform-win32:lang(ko)`).
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
| `--lights-x/-w/-gap` | 22 · 52 · 14 | macOS traffic lights: where they start, the width of the three buttons, the gap after them. What sits at the top left of the window starts after `x + w + gap`, on macOS outside full screen only |

Targets smaller than 24px visually (chip remove 20, clear 24) get a transparent inset so the clickable area is ≥24×24 (WCAG 2.5.8). Link rows (`.linkbtn`, `.links a`, plan links) are one text line high and get the same 24px-high area through `::after`; links inside a sentence keep the height of their line.

## 2.6 Elevation and glass

| Level | Dark | Use |
|---|---|---|
| `--shadow-1` | `0 1px 4px /.3` | segment thumb, switch and slider knobs |
| `--shadow-2` | `0 6px 18px -8px /.5` | toolbar capsules |
| `--shadow-3` | `0 18px 40px -14px /.6, 0 2px 8px /.16` | panels, composer, toast |
| `--shadow-4` | `0 24px 48px -12px /.7` | menus, popovers |
| `--shadow-5` | `0 30px 70px -20px /.8` | dialogs |

Light theme uses the same geometry at about a third of the opacity.

Rims: `--rim-subtle` (hairline), `--rim` (cards, controls, panels), `--rim-strong` (floating glass, thumbs), `--rim-on-accent` (the top highlight of the user's own bubble), `--knob-edge` (the 0.5px edge of switch and slider knobs). In light theme a rim is a white top-left highlight plus a dark 0.5px hairline, so white cards stay visible on the light canvas.

Blur: `--blur-panel` 28px/180% (panels, toolbar capsules, result card), `--blur-overlay` 32px/190% (composer, menus, dialog, toast), `--blur-scrim` 3px.

| Surface | Fill | Rim | Shadow | Blur |
|---|---|---|---|---|
| Panel | `--surface-sheen, --surface-panel` | `--rim` | 3 | panel |
| Card in a panel | `--surface-card` | `--rim` | — | — |
| Toolbar capsule | `--surface-panel` | `--rim` | 2 | panel |
| Composer | `--surface-composer` | `--rim-strong` | 3 | overlay |
| Menu / popover / toast | `--surface-overlay` | `--rim-strong` | 4 (toast 3) | overlay |
| Dialog | `--surface-overlay` on `--surface-scrim` | `--rim-strong` | 5 | overlay / scrim |
| Chip or key on an accent fill | `--surface-on-accent` (lighter) / `--surface-on-accent-sunken` (the quote in the user's bubble) | — | — | — |
| Hairline and focus ring on an accent fill | `--on-accent-line` (under a quote in the user's bubble) / `--on-accent-focus` (2px `--text-on-accent`) | — | — | — |

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
- Sizes: `.btn-sm` 24 · default 28 · `.btn-lg` 32 (Settings, dialogs). These are minimum heights, so a label that wraps or a larger text size grows the button. Font 12/500 (lg 13). Capsule. `.btn-icon` makes it square.
- Intents: default (`--surface-raised` + `--rim`), `.btn-primary` (`--accent-fill` + `--accent-rim`, white), `.btn-danger` (`--danger-text`), `.btn-danger-fill` (`--danger-fill`, white 600), `.btn-ghost` (transparent, `--text-secondary`).
- States: hover adds `--surface-hover` over the fill (primary/danger-fill darken to 94% instead, so white text never drops below 4.5:1); pressed adds `--surface-pressed` and scales to .98 (primary 86%); focus = `--focus-outline` with 2px offset; disabled = 45% opacity, no pointer.
- Replaced `.btn.def`, `.btn.danger`, `.btn.danger-fill`, `.btn.icon`, `.settings-win .btn`, `.foot-btn`, `.back`, `.segico` (round 1, group 6). `.hov` and `.clear-x` stay as behaviour classes on a `.btn.btn-icon.btn-sm`: they place the button and show it on hover, and carry no look of their own.

### Segmented control / tab pill — `.seg`
- Track `--surface-track` + `--rim`, padding 2, items 24 tall (`.seg-lg` 28 for the toolbar and Worker tabs). `.seg-glass` adds panel glass + blur + `--shadow-2` (toolbar). `.seg-fill` stretches items equally (correction scope).
- Selected: glide pill (`::before`) with `--surface-thumb` + `--rim-strong` + `--shadow-1`; text `--text-primary` 600. Each item reserves its semibold width (`::after` with `data-label`), so selecting never shifts the layout.
- Unselected: `--text-secondary` 500; hover `--text-primary`. Disabled 45%.
- Works for `aria-pressed` (toolbar), `aria-checked` (radio groups) and `aria-selected` (tabs); the selected item is read from those attributes, there is no `.on` class. The glide script runs on every `.seg`, the former `.segc` and `.radios` included. The toolbar's tab pill keeps weight 500 when selected.

### Sidebar — `.row`, `.side-h`
- Row: glyph box 18, gap 8, padding 6/8, radius 10. Title 13/500 `--text-primary`, meta 11 `--text-secondary`, badge 11/600 tabular.
- States: hover `--surface-hover`, pressed `--surface-pressed`, selected (`aria-current`) a 2px `--accent` ring with no fill (T-0062), zero count = title in `--text-secondary`/400 and idle glyph (no opacity).
- Section header 11/600 `--text-tertiary`. When a decision arrives, the "Needs your decision" header turns `--accent-text` and pulses 3× (`--dur-attention`); red is for errors only.
- Decision row (`.drow`): the glyph is a solid `--state-ask` disc with the "!" in `--text-on-ask`; the title clamps to two lines; second line "Worker · kind"; the age sits at the right.
- Worker row while it runs: its step list under the title (see "Worker steps and queue").
- Foot (`.side-foot`): ghost icon buttons at `btn-lg` with 18 glyphs: the gear at the left, the sidebar toggle at the right. While the do-not-disturb hours are on, a moon (`#dnd-mark`, `#s-moon`) sits beside the gear in the same neutral colour; its tooltip and name say "Do not disturb until 07:00" and it opens Settings on the alerts. With the sidebar folded the three stack.

### Pills, badges, tags — `.pill[data-tone]`, `.count`, `.diff-tag`
- Pill 18 tall, 11/600, padding 0/8, tones (`data-tone`): neutral (none), `accent`, `danger`, `review`, `warning`, `success`, and the two app tones `pr-open` (an open PR) and `ask` (waits for the user, a solid fill).
- A pill holds only the state; how long sits beside it, outside (`.pstat .age`: 11, `--text-tertiary`, tabular). Meta lines next to a Worker read `W-id · repository · state`, and a plan reads `n/N · current step` or `Stopped at n/N · step` on every screen (T-0084).
- Count badge `.count`: `--state-ask` + `--text-on-ask` (the same solid fill as the `ask` pill and the decision glyph), 11/600 tabular, padding 0/6, min 18 wide. It counts decisions that wait; it pulses 3× when one arrives.
- Diff file status A/M/D/R: 16×16 tag, radius 4, success/warning/danger/review tones.
- Plan badge (Team/Enterprise) = accent/review pill.

### Chat — `.bubble`, `.event`, `.card-result`
- Bubble radius 20, padding 8/12, 13/1.5, max-width 78%. Me: `--accent-fill` + white (≥4.63:1). Dispatcher: `--surface-raised` + rim. Worker: `--surface-card` + rim, with a report header (`.rep-h`: title 600, link chips).
- Event line: 12 `--text-secondary`, centered, glyph 13; `.is-error` in `--danger-text`; clickable events (`.event-btn`) are cards with radius 14.
- Stamp 11/500 `--text-tertiary`; typing dots on `--surface-raised`.
- Result card: radius 20, padding 12/16, glyph 20, title 600, summary 12 `--text-secondary`, links 12.
- Reply branches (`.br`, A-1, T-0090): replies stay in the chat, one step in (48px) under what they answer, a report card or a Dispatcher message (`data-root`). A trunk runs down from the root's edge and each reply gets an elbow (20 wide, radius 9) that ends at its bubble's first line; the user's own bubble sits on the branch's end like the Dispatcher's, with no line across. Lines are 1.5px in `--reply-line` (opaque, gray 600 dark / 400 light) and never overlap: each row's trunk piece stops where its elbow starts. A reply that came after other messages keeps its place in time on a `.br.late` branch that starts from a tag (`.otag`: reply icon, who, what) pointing back to the root. A reply quoting its root (or a message in the same branch) drops the quote. Hover or focus on a reply turns its elbow and the trunk above it `--reply-line-on` and puts the 2px accent ring (`.reply-on`) on the root; on a tag or a root the whole branch lights. The line strip (`.br-go`), the tag and a quote go back to the root, which flashes once (no animation under reduced motion). One Reply entry point per message; R on a focused message replies to it, and on a reply to its branch's root.
- Folding: the newest thread is open, older ones fold to their heading; what the user opens or folds stays across redraws. The heading is a button with `aria-expanded` and keeps the focus when it toggles.
- Quotes: in a thread row, one line (`.t-q`: reply glyph, name 600, words with an ellipsis) only when it quotes a message other than the report or the row right above. In the user's bubble, two lines at the top over a `--on-accent-line` hairline (`.bq`), `--surface-on-accent` under the pointer. Both go back to the quoted message, which flashes a 2px `--accent` ring. Cut words show in full in the tooltip.
- While a reply is written: a two-line quote card inside the composer (`--surface-card` + rim, radius 14: name 11/600, two lines of the quote, a 20 close button), and the message it answers has a 2px `--accent` ring, no fill.

### Composer — `.composer`
- Floating capsule, radius 24, padding 6/6/6/16, `--surface-composer` + `--blur-overlay` + `--rim-strong` + `--shadow-3`.
- Textarea 13/1.5, placeholder `--text-tertiary`; context button (ring + "42K / 250K", 11, ghost); send 32 circle.
- States: focus = 2px `--focus-ring` ring; drop = `--accent-soft` wash + 2px `--accent` ring; busy = send becomes stop (`--surface-selected`), ring turns `--meter-warn` near the compaction point; disabled 60%.
- File chips: 24 tall, radius full, remove button 20 with a 24 target.

### Task card — `.task`
- Grid 22 / 1fr / auto, gap 10, padding 10/12, radius 14, 0.5px top hairline between cards.
- Title "W-id title" 13/600; meta (repo, model, account, now) 12 `--text-secondary`; right side: context ring + K count + status pill.
- States: hover `--surface-hover`, pressed `--surface-pressed`, selected a 2px `--accent` ring with no fill, archived = title `--text-secondary`/500 + archive glyph (no opacity).

### Inbox — `.group` of `.dec`, `.res`, `.aa`
- Header `.ins-h`: 13/600 (was 700) + count badge, or "Clear all" (`.clear-all`, a small ghost text button) on Results and Answered-for-you.
- Decision `.dec`: padding 12, gap 8, 0.5px hairline between cards. In order: the source line, the question 13/600, the reason and detail 12, a permission's purpose 12 `--text-primary` (at most two lines, left out when unknown), a command as a code block or a plan (markdown in a sunken well, max 220), the slot clock, the reach of "Allow for this task", the buttons, the free-text field (`.inp`: deny with a reason, revise the plan, another answer).
  - Source line `.src` (11 `--text-secondary`): the kind chip `.dkind` (capsule, padding 0/8, `--neutral-soft`, 11/600 `--text-primary`, 13 icon: Command, Permission, Question, Plan), then "Worker · task", then the age `.dage` at the right (`--text-tertiary`, tabular). The age turns `--warning-text` (`.late`) when a quarter of the slot time is left, when the slot was given back, or after 10 minutes without a clock. Under 30em the "Worker · task" part takes its own line.
  - Slot clock `.dhold`: a 48×3 track (`--neutral-soft`) that drains in `--state-wait`, then how long the Worker keeps its slot. After the slot is given back the line is `--warning-text` and the bar is empty. The clock starts when the task starts waiting, so the line is there from the card's first draw and only its text changes.
  - Reach `.scope` (11 `--text-secondary`, wraps): one line just above the buttons, "Allow for this task, and `npm run` is not asked again", the scope as inline code in `--text-primary`. Only on a permission that offers "Allow for this task".
  - Buttons `.btns`: one row, right-aligned, gap 6, primary last (Deny, Allow for this task, Allow). When the row would break into two, the buttons become a full-width stack in the same order (`data-fit="stack"`, set by `fit.ts`). The key hints keep their room on every card, so selecting a card never moves, resizes or reorders a button. A plan has one primary button. A question has no primary; with more than two options, or any description, the options are a left-aligned column (`.btns.col`, radius 10, padding 6/10) with the description under each label.
  - Keys, on the selected card only: `kbd` hints on its buttons (the key's fill is 16% of the button's text colour), shown by opacity alone (`--dur-fast`). Focus without selection is a 2px dashed `--focus-ring` outline 3px off the card; selected and focused is the solid `--focus-outline` 1px outside the ring. Enter allows or approves, D denies, T allows for the task, 1–9 pick an option. No modifiers; ignored while a syllable is being composed. A card that is focused but not selected takes no answer keys: Enter, Space, a click or ↑/↓ select it first, so there is no default card one Enter would approve.
  - Selected: a 2px `--accent` ring with no fill, radius 14. A new card flashes `--accent-soft` once (`--dur-attention`).
- Result row: glyph 17, title 12/600, time 11 `--text-tertiary` tabular, links 12, summary 11. Its ✕ (`.row-x`, 24 ghost, tooltip "Clear" with the key Delete) sits at the top right in `.row-acts` and shows on hover, focus inside the row and selection; Delete or Backspace on the focused row does the same. One cleared item says so in a toast with Undo (Ctrl/Cmd+Z too), and the focus goes to the next row, or the one before at the end.
- Answered-for-you: selected = the same 2px `--accent` ring with no fill; the pencil and the ✕ appear together (`.row-acts`) on hover/focus/selection; correction scope is a `.seg-fill`; corrected answers strike through in `--text-secondary` with the new one in `--accent-text`.
- Swipe (pointer only; the keyboard keeps Delete): a result or an answered-for-you row dragged sideways follows the pointer, and the side it leaves shows `--danger-soft` with an ✕ (`.swipe-under`). It turns `--danger-fill` with a white ✕ once letting go clears it: 35% of the row's width, or a flick of at least 32px. Then the row slides out (`--dur-base`), closes up (`--dur-fast`) and is cleared as its ✕ does, with the same toast and Undo. Short of that it slides back. Both directions work. The drag starts only once the move is more sideways than down (8px slop, `touch-action: pan-y`), so a vertical drag still scrolls, and never on a button, link or field in the row. A row that cannot be cleared (a decision, a while-you-were-away row) gives at most 14px and comes back. A drag is never a click, so it does not select a decision. With reduced motion the row follows the pointer but does not animate out, back or closed.
- All clear: 44 glyph `--text-tertiary`, 15/600 title, optional "N Workers are busy" link button.

### Usage gauge — `.usage`, `.upop`, `.meter`
- Toolbar capsule `.usage` (radius full, panel glass, `--shadow-2`, padding 4/8, gap 8): one pair of rings per account, in the order of Settings (T-0053, #120). Rings are 22 on a 24 grid, stroke 3 with round caps: 5 hours outside (r 10), 7 days inside (r 5.5). The track is `--meter-track`, or `--danger-soft` for a limited account. No number is shown in the toolbar.
- Levels, the same four everywhere: ≤30 `--meter-ok`, ≤50 `--meter-caution`, ≤80 `--meter-warn`, above `--meter-critical`. Rings carry them as `lv-g/y/o/r`, bars as `data-level`. Arcs and bars are ≥3:1 against their track in both themes.
- States: the rings under the pointer scale to 1.14; an account whose read failed is at 45% with a 7px `--warning` dot; a used-up account gets a danger pill beside its rings ("Resets in 2h 10m" or "Limited"), hidden under 1100px of window width.
- Popover `.upop` (opens from the rings, by pointer or keyboard): 356 wide, radius 20, padding 6, overlay glass, `--rim-strong` + `--shadow-4`, `--z-popover`. One block per account (`.ua`, radius 10, padding 8/10/10): its rings at 20, name 13/600 with the plan, then the time of the figures or a danger pill. Under it one row per window (`.uw`): label 11/600, a `.meter` bar, the percentage 12/600, and when it resets. Figures kept from before a failed read are at 50% with their time in `--warning-text`. The footer has the last refresh and a round refresh button (26, `--surface-track`), which spins while it reads.
- `.meter`: 6 tall, radius full, `--meter-track`; no figure = a hatched track (`.none`). Bars grow from 0 when the popover opens (`--dur-glide`). Account cards in Settings use the same bar at 5 tall.

### Fields and controls
- `.field`: 28, radius 10, `--surface-sunken` + `--well`, 12px; hover adds a `--border-default` edge; focus `--focus-outline` (offset 0); `.is-warning` (font not installed) and `[aria-invalid]` outlines; disabled 45%. Textarea min 60, 1.5. `.mono` uses `--font-mono`.
- `.search`: 32 capsule well, icon 14, focus ring.
- `.switch`: 38×22, off = `--switch-off` + 1px `--border-strong` edge (3:1), on = `--switch-on`, knob 18 with `--shadow-1`; the knob stretches while pressed; spring easing.
- `.step`: 28 capsule, buttons 28, value 42 wide tabular; focus ring on the group.
- `.slider`: 4px track (`--accent` fill / `--meter-track`), knob 18; focus ring around the knob.
- `.dd-btn`: 28 capsule, min 180, up/down glyph; open state = pressed fill.

### Settings
- Window: title bar 52 (title 15/600, centered over the panes, not the window; Back sits in the nav's column), nav panel 240 (glass), pane max 680 centered with a stable scrollbar gutter, pane title 24/700, group caption 12/600.
- Status group: one row with every check's name and a success pill while all pass; the rows (failed first, with the fixing command) only when one fails. Folder paths are shortened in the middle (`C:\Users\…\oma\home`), full path in the tooltip.
- Nav item 32, radius 10, icon 17; hover `--surface-hover`; current `--surface-selected` + rim + 600 + `--accent` icon; setup-needed dot `--danger`.
- Group `.sgroup` radius 14 (same as inspector groups), rows min 44, padding 8/16, 0.5px separators.

### Menus, dialog, toast
- `.menu` replaces `.amenu`, `.pop`, `.ctxmenu`: padding 6, radius 14, overlay glass, `--rim-strong` + `--shadow-4`, enters with `--dur-fast`.
- `.menu-item` 28, radius 8, padding 0/12/0/6, tick column 14 (radio items), optional mono hint on the right. Highlight `--accent-solid` + white (4.95:1). Danger items `--danger-text`, highlighted with `--danger-solid`. Disabled `--text-disabled`. Separator 0.5px; group header 11/600 tertiary.
- `.dialog` 320 wide, radius 24, padding 24/20/20, title 15/600, body 12/1.5 secondary, two large buttons; scrim `--surface-scrim` + 3px blur.
- `.toast` capsule, 12, overlay glass, `--rim-strong` + `--shadow-3`, padding 8/16, centred 84 above the bottom edge, `--z-toast`. Up to three stack, the newest at the bottom; the oldest that is not an error leaves first, and the same text again replaces its toast. A toast can carry one action as a link button (600, for example "Undo"); the action dismisses it. It stays 3 s, 6 s with an action. An error (`.err`) is `--danger-text`, has a 20 round close button and stays until closed.
- z-index: raised 1 (resize edges and grips), composer 2, resize 3 (the panel resize handles), menu-catch 30, menu 31, settings 40, scrim 50, dialog 51, toast 60, popover 80, context menu 90, tooltip 100 (resolves the 50/50 clash).

### Chat blocks — `.hand`, `.sh-run`
- **Hand-out fold `.hand`**: the tasks the Dispatcher handed out in one turn are one card (min(560, 92%), `--surface-card` + rim, radius 20, padding 6). The heading is a button: CPU glyph, "N tasks handed out", the counts by state, a chevron that turns 90° when open. Each task is a row (`.hrow`, radius 10, padding 4/8): status glyph, title 12/500 over "Worker · repository · detail" 11, and a pill: `ask` "Needs your decision", `accent` "Running", `danger` "Failed", `warning` "Queued" or "After merge", `success` "Done", `pr-open` "PR open", neutral "Stopped". A row with a Worker opens it. The card is open while anything is unsettled and folds to its heading when all is.
- **Shell run `.sh-run`** (T-0054, #121): a card across the thread (`--surface-card` + rim, radius 20). Header: a 20 "!" tile, the script's name if it has one, the first line of the command in mono 12/600 ("+n lines" when there are more), "in <folder>", then at the right a pill, the elapsed time 11 tabular and, while it runs, a small Stop button. Pill: `accent` with an 8px spinner while running, neutral when stopped, `success` "Exit 0", `danger` for another exit code. Output: mono 11 on `--surface-code`, radius 10, at most 50vh, the last 12 lines when folded, a blinking block cursor while it runs. stderr lines (`ShellRun.err`) are `--danger-text`; each stretch of them shows its first line and a "+N lines" link button (`.o-more`, `--text-link`, 11) that opens the rest and then reads "Show less" (T-0081, G2). The side terminal draws its output the same way. Footer: what happens to the output (sent = `--success-text` with a tick, waiting for the Dispatcher's turn = a pulsing `--state-run` dot, not sent = `--text-tertiary`), then Copy and Run again as links once it has ended.

### Composer states — `.dstat`, `.composer.shell`
- **Dispatcher status line `.dstat`**: the first row inside the composer while the Dispatcher works. A 7px `--state-run` dot with a 3px halo that pulses (`--dur-attention`), "Dispatcher" 12/600, what it is doing (one line, cut with an ellipsis), the elapsed time in `--text-tertiary` tabular, and "Stop" as a link button. A 0.5px hairline separates it from the text. The Chat tab of the toolbar shows a 6px pulsing dot meanwhile. Send stays Send; Stop is only on this line.
- **Shell mode `.composer.shell`**: typing `!` first turns the composer into a command line; Esc or Backspace on the empty line goes back. The composer keeps its surface and gets a 2px `--warning` ring (T-0081, G3); the "!" tile, the send button (a play glyph) and the mode pill are neutral (`--neutral-soft` / `--text-secondary`, send on `--surface-selected`); the text in mono 12 with a `--warning` caret. Red is kept for a line that is hard to undo (`shellRisky`: rm/del/Remove-Item at a command position, `--force`, `git push -f`, `git reset --hard`, `git clean -f`, `git branch -D`, SQL drop/truncate): then `.risky` turns the ring, the glow, the tile and the send button to `--danger` and the bar shows a "Hard to undo" chip (`--danger-soft` / `--danger-text`). A bar above the text holds the mode pill, the folder button, the "ask the Dispatcher about it" toggle (`--accent-soft` when on) and the key hints (↵, Esc).
- **Strips `.cstrip`, `.cerr`**: a waiting decision on a Worker's composer and a failed send (alert glyph, text, a 20 round close button). Padding 4/10, radius 14, sunken well, 12. A permission names its command: "Waiting for permission" (`--text-secondary`), the first line of the command as inline code cut with an ellipsis, then Deny and Allow at the right. Its purpose, when known, is a second line under it (`.cs-why`, `--text-secondary`, one line), lined up with the text after the glyph.

### Dock — `.dock`, `.sq`, `.tm`
- **Dock `.dock`** (T-0081, G1): the side terminal and the side question are two tabs of one panel in the chat column, between the thread and the composer, with 16 side margins and the composer's height + 24 under it. It takes its height from the chat, which gets shorter (`.content.dock-open`), so it never covers a card and the two never overlap. Opaque overlay surface, `--rim-strong` + `--shadow-2`, radius 24. Height 300 by default, at least 160, at most the chat's room less 160; kept in `oma.dockH`.
- **Header `.dock-h`**: the tablist (`.dock-tab`, pill 12/600, selected on `--surface-selected` + rim; ← → move between them), then the tools of the open tab (terminal: folder button, Clear; side question: the "Separate context" chip, "Close and forget"), then a 20 round "Put away" chevron. Esc in a tab puts the dock away; the composer buttons and Ctrl/Cmd+` / J open a tab.
- **Side question `.sq`**: the thread starts with a meta line (agent · model · folder, which can be picked until the first question); bubbles are 12 and at most 92% wide. After an answer two small buttons send it to the Dispatcher or save it as a memo. Its own composer is a sunken well without blur, with its own context meter.
- **Side terminal `.tm`**: the body is on `--surface-code`; each line run is "$ command" in mono 12/600 with "in <folder>", the same pill and timer as a shell run and a small Stop button, then its output in mono 11 `--text-secondary` (stderr as in a shell run). The input row gets a 2px `--accent` bottom line on focus.
- Both bodies start 12 under the header and fade lines scrolled up under it (a 10px top mask) rather than cutting them.
- **Resizing `.edge-rz.h`**: one 36×4 capsule centred on the dock's top edge, the same as the sidebars' handle: hidden until the pointer is over the dock (`--border-default`), stronger on the edge (`--border-strong`), `--accent` and 56 long while dragged or focused. ↑/↓ by 16, 64 with Shift; a double-click goes back to 300. The dock has no width of its own: it is as wide as the chat.

### Right sidebar — `.inspector`, `.ins-tabs`, `.ins-cols`
- A glass panel, 344 wide by default, resizable from 320 to 640 with the capsule handle on its left edge (`.rz`, 8 wide; capsule 4×36, `--accent` and 56 while dragged or focused).
- Tabs `.seg.ins-tabs`: Inbox (with the count of waiting decisions), Memos, Automations, Scripts; full width, at most 360, centred. When the labels do not fit, the tabs that are not selected fold to their icon (`data-fitted`) and show their name in a tooltip.
- Selection and focus (T-0077): nothing is selected by default; an item is selected by a click, Enter or Space, ↑/↓, or "Go there" from elsewhere, never by the focus alone. Each list is one Tab stop (roving tabindex: the focused item, else the selected one, else the last focused, else the first), and ↑/↓, Home and End move between its items. A pointer over an item fills nothing; only its own buttons show. Selected = the 2px `--accent` ring; keyboard focus = `--focus-outline`, drawn 1px outside the ring when both apply.
- One column at any width (T-0120): the cards take the sidebar's width, and the selected card opens in place. Only "New automation" and "New script" have a row (`.li`, at least 40 tall, padding 8/10), which stands for their closed form; selected = the 2px `--accent` ring.
- A card that can be changed (a script, an automation) has a pencil before its delete button (`.mact`). The card then becomes the form that adds one, filled in, with Cancel and a primary Save at the right of its last line. One card is changed at a time; an error on Save is a toast and the form keeps what was typed.

### Worker steps and queue — `.stp`, `.pips`, `.plan-steps`, `.q-row`
- **Step list `.stp`** (left sidebar, under a Worker that runs): one line per step, 11 `--text-tertiary`, a 7px pip joined by a 1px line. Done = a tick, current = a filled pip with a halo, to do = a ring. The colour follows the Worker: `--state-run`, `--state-wait` while it waits for the user, `--state-error` after a failure, `--state-done` when all are done. Up to five steps are drawn whole; a longer plan shows a window of three and counts the hidden ones above and below (`.stp-more`). A step that just finished pops (`--ease-spring`), and the window rolls up by a line (`--dur-glide`).
- **Pips `.pips`** (Worker list rows): one 9×3 bar per step; done `--state-run` at 55%, current `--state-run` pulsing, the rest `--neutral-soft`; after a failure the current one is `--state-error`.
- **Plan card `.plan-steps`** (Worker inspector): "Steps" with "done/total", then a numbered list 12 with a 14 circle per step: done = `--accent-soft` with an `--accent-text` tick, current = `--state-run` ring and dot with the text 600, failed = `--danger-soft` with a cross.
- **Queue**: the section header shows the slots as 6px dots (filled `--state-run` = taken; up to six) and "n/max slots". Each queued row starts with its place in an 18 ring joined to the row above (the next one is `--warning-text` in a `--state-wait` ring); its second line says the repository and why it waits ("next", "3rd in line", "after PR #12", an account limit). Tasks that are held have no place and sit under their own caption.

### Palette and shortcut list — `.cmdk`, `.dlg.keys`
- **Palette `.cmdk`**: 560 wide, 16vh from the top, at most min(440, 68vh) tall; overlay glass, `--rim-strong` + `--shadow-5`, radius 20, over the scrim at `--z-dialog`. Input row 44 tall with a search glyph, text 15 and an Esc key. Rows (`.cmdk-it`) 32 tall, radius 8, padding 0/10: icon, title 13/500, a second text 12 `--text-secondary`, the shortcut at the right. The selected row is `--accent-solid` with `--text-on-accent`; its key sits on `--surface-on-accent`. Group headers 11/600 `--text-tertiary` show only while the query is empty. Nothing found: one centred line.
- **Shortcut list `.dlg.keys`**: the dialog at 380 wide, left-aligned, title centred. Two groups (on a decision card, anywhere) with a 12/600 header; each row has the action 13 at the left and its keys at the right, one `kbd` cap per key (min 20 wide). One full-width primary Close button.

### Tooltip — `.tip`
One tooltip for the whole app, in place of the native `title` (which the OS draws in its own font, after its own delay, at the pointer, and never on keyboard focus). One element, `<div id="tip" class="tip" role="tooltip">`, and one delegated listener (`src/renderer/ui/tip.ts`).

- **Anatomy:** text, then an optional shortcut as a `kbd`. Overlay glass (`--surface-overlay` + `--blur-overlay`), `--rim-strong` + `--shadow-4`, radius `--radius-sm`, padding `--space-4` / `--space-8`, text `--fs-caption` in `--text-primary`, the key `--fs-caption2` in `--text-secondary` with no fill. At most 280 wide; several lines allowed, 14 at most.
- **Markup:** `data-tip="…"` on the control; `data-tip-key="Ctrl+B"` for its shortcut (never inside the sentence); `data-i18n-tip` for static markup (it sets the `aria-label` too); `data-tip-clip` when the hint should show only while the control or a part of it is cut (a tab folded to its icon).
- **Timing:** 500 ms after the pointer rests on a control; at once when the pointer comes from another tooltip within 300 ms; at once on keyboard focus (`:focus-visible`). It goes when the pointer leaves, on blur, any key (Escape included), a press, a scroll of the control's container, window blur or resize, and when the control is redrawn with other text. The pointer can move onto it.
- **Placement:** centred on the control, 6 away; below in the toolbar, above elsewhere; on the other side when there is no room; always 8 inside the window.
- **Motion:** opacity and a 2 px shift over `--dur-fast`; none with reduced motion (the token is 0).
- **Layer:** `--z-tooltip` (100), above the context menu.
- **Content rules:**
  - An icon-only control gets its name, and its shortcut as the key.
  - Text the layout cuts (an ellipsis or a line clamp) shows in full when the pointer rests on it or its control has the focus. This needs no attribute: the tooltip finds cut text itself.
  - No tooltip repeats text that is readable on the control.
  - Nothing exists only in a tooltip unless its owner can take the focus; what a decision needs (the reach of "Allow for this task", an error) is on the card.
- **Accessibility:** the owner gets `aria-describedby="tip"` while the tooltip is shown, except when the text is the control's accessible name or its own text.
- The usage popover stays a popover (`.upop`): it holds controls. It uses the same surface.

## 2.10 Accessibility summary

- **Contrast**: 250/250 checked pairs pass AA in dark and light (`03-contrast-report.md`). Before → after (dark): white on the blue gradient 2.86 → 4.63; menu highlight 3.65 → 4.95; count badge 3.41 → 5.06; danger button 2.94 → 4.67; tertiary text in an inspector card 3.50 → 4.72; link in a card 3.16 → 5.36; focus ring against a panel 1.77 → 6.05.
- **Focus on the blue bubble**: the blue ring would not show on blue, so controls inside the user's bubble use `--on-accent-focus` (2px white), offset 1.
- **Focus**: one visible style, `2px solid --focus-ring`, offset 2 (fields: 0); `:focus-visible` everywhere except text fields. A message that has the keyboard gets the same ring round its bubble or card.
- **Keyboard**: a layer (Settings, the palette, a dialog) takes the focus when it opens and gives it back when it closes. A tab list, a segmented choice and a conversation are one Tab stop each: the arrows, Home and End move inside (tabs and choices wrap and choose at once; messages stop at the ends), and Tab inside a message goes through its controls and then leaves the conversation. The toolbar's view tabs are such a tab list. The app starts with the focus in the message field, and Ctrl/Cmd+L goes back there; an informational pill that takes the focus only for its tooltip comes last in its row.
- **Invalid fields**: the outline always comes with `aria-invalid`.
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
3. Merge components: `.segc`/`.radios` → `.seg`, menus → `.menu`, button variants → `.btn` modifiers, pill/badge/diff colors → tones, meters → `.meter[data-level]`. Done in round 1, group 6 (T-0069), with the literal values that had no token and the spacing that was off the scale.
4. Fix the duplicate `s-back` symbol and normalize strokes.
5. Add `word-break: keep-all` for Korean and the line-height split (1.4 UI / 1.5 body).
6. Add a Display → Appearance setting (Dark / Light / System) that sets `data-theme` and `nativeTheme.themeSource`.

The window grid, panel widths, glass look and the glide script stay as they are.

## 2.13 Choices made in this proposal

- The accent gradient is darker (`#3d9bff → #0a6cff` becomes `#1570ea → #0659d4`). This is the most visible change and the only way to keep white text on blue bubbles and buttons above 4.5:1.
- Secondary and tertiary text are slightly brighter (`#a7a7ad → #b4b4bb`, `#8d8d93 → #a1a1a8`), so the gap between them is smaller; size and weight carry more of the hierarchy.
- The usage meter keeps the toolbar thresholds (30/50/80) and applies them to account cards too.
- "Waiting for you" and "Error" were both red under separate tokens (`--state-ask`, `--state-error`); T-0045 split them: "Waiting for you" is a solid accent fill, and red is kept for errors.
