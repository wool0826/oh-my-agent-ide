# 1. Current design system — extraction and audit

Source: `wool0826/oh-my-agent-ide` `origin/main` at `73d8433` ("Route at any usage and retry when a usage limit resets").
Files read: `src/renderer/styles.css` (567 lines), `src/renderer/index.html` (symbols, layout), `src/renderer/app.ts` (markup of every component, glide script, usage levels), `src/shared/i18n.ts` (EN/KO copy), `docs/DECISIONS.md` (#30 fonts, #46/#48 custom controls, #65 Liquid Glass, #66 sliding pill, #71 dark frame).
Line numbers below refer to `styles.css` unless another file is named.

The app follows Apple HIG "Liquid Glass" (macOS Tahoe): dark only, a graphite backdrop, floating glass panels with a specular rim, capsule controls and a glass pill that slides between segments.

## 1.1 Color

### Tokens in `:root` (lines 2–33)

| Group | Variables | Values |
|---|---|---|
| Backdrop | `--canvas`, `--win`, `--accents`, `--backdrop`, `--page` | `#131316` (twice), white 4% top wash, `rgba(0,0,0,.32)` |
| Glass | `--glass`, `--glass-2`, `--glass-3`, `--glass-hi`, `--glass-menu`, `--group` | white 5.5 / 8.5 / 14 / 20%, `rgba(38,38,42,.68)`, alias of `--glass` |
| Fills | `--fill`, `--fill-2`, `--bubble-ai`, `--seg-on` | white 12 / 7 / 9 / 20% |
| Text | `--label`, `--label-2`, `--label-3` | `#f5f5f7`, `#a7a7ad`, `#8d8d93` |
| Lines | `--sep`, `--win-line` | white 9%, 12% |
| Accent | `--blue` `#0a84ff`, `--accent-fill` (gradient `#3d9bff → #0a6cff`), `--accent-rim` | |
| Hues (Apple dark system colors) | `--red #ff453a`, `--orange #ff9f0a`, `--green #30d158`, `--yellow #ffd60a`, `--purple #bf5af2`, `--indigo #5e5ce6`, `--teal #40c8e0`, `--gray #98989d`, `--pink #ff375f` | |
| Effects | `--rim`, `--rim-hi`, `--rim-panel`, `--sheen`, `--lift`, `--well`, `--blur`, `--focus` | |
| Radius | `--r-panel 20px`, `--r-card 14px` | used in 3 places only |

### Semantic use of hues (by meaning, from `app.ts`)

| Meaning | Color | Where |
|---|---|---|
| Needs your decision / waiting for you | red | `.k-ask`, `.pill.red`, `.count`, sidebar header blink |
| Error | red | `.k-err`, `.pill.red`, `.event.err`, `.toast.err` |
| Running | blue | `.k-run` (spinning ring), `.pill.blue` |
| PR open / merged | purple | `.k-pr`, `.pill.purple`, merge glyph |
| Queued, after merge, waiting for limit | orange | `.k-wait`, `.pill.orange` |
| Done, answered for you, success | green | `.k-done`, check glyphs, `.fixed`, switch on |
| Archived, idle | gray | `.k-arch`, `.k-idle` |
| Repository / preference / document | indigo / pink / teal | `.k-repo`, `.k-pref`, `.k-doc` |
| Usage 5h/7d | green ≤30, yellow ≤50, orange ≤80, red >80 | `app.ts` 145–148 (toolbar) |
| Account meters | blue, orange ≥80 | `app.ts` 1027–1030 (Settings) |

"Waiting for you" and "Error" share the same red pill; only the sidebar glyph tells them apart (`!` vs `×`).

### Hard-coded colors outside the tokens

17 distinct hex values and about 30 `rgba()` literals sit in rules instead of tokens.

| Value | Uses | Lines | Problem |
|---|---|---|---|
| `#fff` | 16 | 131, 176, 188, 212, 243, 360, 369, 391, 427, 468, 483, 487, 521 … | One literal for "text on accent", "text on red", knob, avatar |
| `#ff6961` | 2 | 392 (`.amenu .danger`), 513 (`b.minus`) | A second red next to `--red #ff453a` |
| `#3fb950`, `#2ea043`, `#d1453b`, `#b0832a`, `rgba(46,160,67,.16)`, `rgba(248,81,73,.16)` | 1 each | 512, 522–524, 531–532 | GitHub's palette inside an Apple palette (diff view) |
| `#6cb6ff`, `#d9a1f7` | 1 each | 374–375 (`.plan-badge`) | Lighter blue/purple invented for one badge |
| `linear-gradient(#ff6259, #e5322a)` | 1 | 406 (`.btn.danger-fill`) | Not a token; white text on it is 2.94:1 |
| `#f5f5f7` | 1 | 459 (slider thumb) | Duplicates `--label` |
| `rgba(42,42,46,.52)` | 2 | 161, 474 (composer) | Near-duplicate of `--glass-menu` |
| `rgba(0,0,0,.24/.22/.22/.2/.18)` | 5 | 217, 299, 320, 536, 409 | Five "wells" with five alphas |
| `rgba(255,255,255,.1/.06/.06/.16)` | 4 | 117, 382, 357, 362, 467 | Tracks: meter, segmented, round icon button, switch |
| `#1e1e21 #252528 #2f2f33 #27272a #3b3b40 #242427` | 6 | 562, 566 | Reduce-transparency fallbacks, not paired with the glass tokens they replace |
| `var(--blue)` etc. inline in `style=` | 4 | `app.ts` 879, 1055, 1068 (`AVATAR`) | Avatar colors in script |

### Duplicate and unused tokens

- `--win` and `--canvas` are both `#131316`.
- Unused: `--group`, `--win-line`, `--glass-hi`. `--page` is used once (diff body).
- Near-duplicates: `--glass-2` (8.5%) vs `--bubble-ai` (9%) vs `--fill-2` (7%); `--glass-3` (14%) vs `--fill` (12%).
- The same value is written two ways: `calc(13 * var(--px))` (6 uses) and `var(--ui-font-size)` (15 uses).

## 1.2 Typography

- Font stack (line 28): `-apple-system, BlinkMacSystemFont, "SF Pro Text", "Segoe UI Variable Text", "Segoe UI", "Apple SD Gothic Neo", "Malgun Gothic", "Noto Sans KR", system-ui`. System fonts only (decision 30). Mono: `--mono`, but `.df-b` (529) and `.inp.mono` (543) repeat a shorter literal stack without Cascadia Mono/Menlo.
- Base 13px. Every size is `calc(N * var(--px))` so the text-size setting (10–20px) scales the UI (decision 44).
- **12 sizes** in use:

| Size | Uses | Typical role |
|---|---:|---|
| 10 | 1 | diff status letter |
| 10.5 | 3 | pill, usage capsule, result time |
| 11 | 26 | meta lines, section headers, badges |
| 11.5 | 18 | event lines, list meta, chips |
| 12 | 22 | buttons, inputs in panels, captions |
| 12.5 | 8 | inspector titles, memory text |
| 13 | 21 (+ root) | body, settings rows |
| 14 | 1 | settings title bar |
| 15 | 5 | empty-state and dialog titles |
| 17 | 2 | view header |
| 20 | 1 | result card glyph |
| 24 | 1 | settings pane title |

- **Weights**: 400 ×3, 500 ×6, 600 ×29, 700 ×7. 700 is used for both page titles (view header, pane title) and small labels (inspector header `.ins-h b` 13px, Worker session title, avatar, diff letter), so 13px/700 headers outweigh 17px titles visually.
- **Line heights**: 1.38 (body), 1.4, 1.45 (bubbles), 1.5. Body at 1.38 is tight for two-line Hangul.
- **Korean**: no `word-break: keep-all`, so Korean words can break mid-word in bubbles and cards (`overflow-wrap: anywhere` is used for long paths). Korean copy keeps English product terms ("보관된 Worker", "Dispatcher 컨텍스트", "PR 리뷰 대기"), so every line mixes Hangul and Latin.

## 1.3 Spacing, sizes, radius

- **Spacing**: 25 distinct padding/margin/gap values from 1 to 48px: 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 16, 18, 20, 22, 24, 26, 28, 30, 32, 46, 48. Fourteen of them (all odd values plus 14, 18, 22, 26, 28, 30, 46) are off a 4px grid with 2/6/10 half steps. Most common: 8 (×48), 6 (×42), 12 (×38), 10 (×31), 4 (×25).
- **Control heights**: 16, 18, 20, 22, 24, 26, 28, 30, 32, 34, 36, 44, 46. Icon buttons alone come in eight variants: `.fchip button` 16, `.clear-x` 18, `.combo-btn` 20, `.hov` 24, `.btn.icon` 28×26 (not square), `.foot-btn`/`.back`/`.segico` 30, `.send` 32.
- **Buttons** change size by context: `.btn` is ~24px/12px, `.settings-win .btn` overrides it to 30px/13px (316–317).
- **Radius**: 14 values — 0, 2, 3, 4, 6, 8, 10, 12, 14, 16, 18, 20, 24, 999 and 50%. The same role gets different radii: inspector `.group` 14 vs settings `.sgrp` 16; sidebar `.side-empty` 12 vs `.row` 10 vs `.li` 14; usage capsule 16 next to 999 capsules.
- **Hit targets below 24×24** (WCAG 2.5.8): `.fchip button` 16, `.clear-x` 18, `.combo-btn` 20.

## 1.4 Elevation, borders, glass

- **Rims** (specular edge): `--rim`, `--rim-hi`, `--rim-panel` — three nearly identical recipes.
- **Shadows**: `--lift` plus ad-hoc `0 6px 18px -8px .5` (seg), `0 18px 40px -12px .65` (composer, toast), `0 24px 48px -12px .7` (menus ×3), `0 30px 70px -20px .8` (dialog), and four 1–5px knob shadows.
- **Blur**: five recipes — `28px/180%` (`--blur`), `26px/190%` (composer), `30px/190%` (menus, popover, context menu, toast), `34px/190%` (dialog), `3px` (scrim).
- **Separators**: `.5px solid var(--sep)` everywhere (good).
- **Focus**: `--focus` is `3px solid` blue at 45% alpha (1.77:1 against a panel). Variants: `.ssearch:focus-within` box-shadow 45% (323), `.composer:focus-within` 38% (162), slider 50% (462); `.inp:focus` uses `:focus` rather than `:focus-visible` (218).
- **Reduce transparency** (560–567) swaps glass for six hard-coded solids; the composer gets its own (`#242427`).

## 1.5 Icons

- 30 line symbols (`s-*`) and 11 status glyphs (`g-*`) in `index.html`.
- Grids: 20×20 (18 symbols), 16×16 (19), 10×10, 8×12 (2), 12×16.
- Stroke widths: 1.5, 1.6 (×16), 1.7 (×6), 1.8, 1.9, 2.2, 2.4.
- **Bug**: `id="s-back"` is defined twice (`index.html` 27 as 8×12 and 38 as 16×16). `<use href="#s-back">` resolves to the first, so the Settings back button (`.stopbar .sback svg` 16×16, line 314) draws the 8×12 chevron.
- `s-pencil` carries no stroke attributes and depends on `.hov svg` CSS.
- Status glyphs are colored by `.k-*` classes (`--c`), and the running glyph spins.

## 1.6 Motion

| What | Duration | Easing | Lines |
|---|---|---|---|
| Tab pill slide (transform, width) | .46s | `cubic-bezier(.28, 1.32, .5, 1)` (overshoot) | 103 |
| Tab pill squash and stretch | .46s | `cubic-bezier(.3, .8, .4, 1)`; keyframes 1.14/.82 → .97/1.04 | 104–105 |
| Pill height / opacity | .3s / .2s | ease | 103 |
| Segment text color | .18s | ease | 93, 358 |
| Buttons, switch, composer shadow | .15s | ease | 161, 210, 467–468 |
| Hover reveal (clear ×, pencil), chevron | .12s | ease | 192, 241, 519 |
| Popover / menu in | .12s | ease-out | 388, 423 |
| Slider thumb press | .1s | ease | 459 |
| Running glyph | 1s linear infinite | | 83 |
| Attention pulse | 1s ×3 (sidebar header), 1.1s ×3 (count), 1.2s infinite (typing) | | 61, 189, 139 |
| New decision flash | 1.2s | ease-out | 199 |

Ten durations and five easing curves, none named. `prefers-reduced-motion` is handled in three separate rules (86, 107, 425). The glide logic (`app.ts` 961–1017) measures the selected button, writes `--gx/--gy/--gw/--gh`, and a `MutationObserver` re-runs it on any `class`/`aria-*` change. It works on `.seg` and `.segc` but **not on `.radios`** (the correction-scope control), which uses a different markup and gets no sliding pill.

## 1.7 Components

| Component | Classes | Pattern |
|---|---|---|
| Sidebar | `.sidebar` (glass panel, r20, inset 8), `.side-sec h4` (11/600 label-3), `.row` (gap 9, padding 6/8, r10; hover `--fill-2`; selected `--glass-3` + rim; `.zero` opacity .45), `.badge`, `.side-empty`, `.foot-btn` (gear) | |
| Tab pill (view switcher) | `.seg` (toolbar, glass + blur, `aria-pressed`) | Glide pill; selected text `--label` |
| Segmented control | `.segc` (settings and Worker tabs, `.on`, 26px) | Glide pill; selected text `#fff` 600 |
| Radio capsule | `.radios` (label + hidden radio) | No glide; selected via `:has(input:checked)` |
| Chat bubbles | `.bub.me` (accent gradient, white), `.bub.ai` (`--bubble-ai` + rim), `.bub.wk` (`--glass` + rim), r18, padding 7/12, max 78% | `.who` name tag, `.stamp` time divider |
| Events | `.event` (11.5px, centered), `.event.self` (button card), `.event.err`, `.typing` + `.dots` | |
| Result card | `.attach` (glass, r18, 11/14) + `.tile` glyph + links | |
| Task card | `.li` Worker list item: grid 22 / 1fr / auto; glyph, "W-id title" 13/600, meta 11.5; context ring + status `.pill`; `.dim` opacity .55 | |
| Inbox (inspector) | `.sect` + `.ins-h` (13/700 + red `.count`) + `.group` of `.dec` (decision/permission/plan), `.res` (results), `.aa` (answered-for-you, hover pencil `.hov`), `.allclear` | |
| Composer | `.composer` floating capsule (r24, blur 26), `.field.input` textarea, `.ctx` context ring button, `.send` (32 circle; `.stop`), `.fchips`/`.fchip` | |
| Usage gauge | `.usage` (toolbar capsule, r16) → `.acct` grid: name, 5h bar, %, 7d bar, %; `.cap` + `.lv-g/y/o/r`; compact mode hides numbers | Settings: `.acc-meters` + `.meter` (blue/orange) |
| Buttons | `.btn`, `.btn.def` (accent), `.btn.danger` (red text), `.btn.danger-fill`, `.btn.icon`; plus `.foot-btn`, `.back`, `.segico`, `.hov`, `.clear-x`, `.combo-btn` | |
| Inputs | `.inp` (well, r10), `.searchbar`, `.ssearch`, `textarea.inp`, `.combo`, `.dd-btn`, `.step`, `.slider`, `.switch` | |
| Settings | `.settings-win`, `.stopbar`, `.snav` + `.snav-i` (34px, `.on` = glass-3 + rim + 600 + blue icon), `.pane h2` 24/700, `.scap`, `.sgrp` (r16) + `.srow` (min 46), `.acc-card`, `.avatar`, `.plan-badge` | |
| Menus | `.amenu` (account), `.pop` (dropdown list), `.ctxmenu` (right click) | Same look, three implementations: item padding 0 12 0 28 / 5 12 5 6 / 5 10; hover solid blue + white |
| Dialog, toast | `.dlg` + `.dlg-back`, `.toast` (`.err`) | |
| Diff | `.diffv`, `.dfs`/`.df`/`.df-h` (status letter on solid GitHub colors), `.dl.add/.del/.h` | |

## 1.8 Inconsistencies found

1. **Three segmented controls** (`.seg`, `.segc`, `.radios`) with different heights (≈25 / 26 / ≈24), selected text color (`--label` vs `#fff`), selected weight (500 vs 600) and motion (`.radios` has no glide).
2. **Three menus** (`.amenu`, `.pop`, `.ctxmenu`) with the same look and different item heights and paddings.
3. **Buttons size by context** (`.settings-win .btn`), and `.btn.icon` is 28×26.
4. **Usage colors disagree**: the toolbar shows 82% in red, the account card shows the same 82% in orange; the 80% "hot" rule outlived decision 72, which removed the 80% routing rule.
5. **Two palettes mixed**: Apple system colors plus GitHub's diff colors and a third red (`#ff6961`).
6. **Dimming by opacity** (`.row.zero` .45, `.li.dim` .55) pulls text below AA for rows that are informative, not disabled.
7. **Same role, different radius** (group 14 vs settings group 16; usage 16 vs capsules 999).
8. **Hover fills differ**: `.row` uses 7%, `.li`/`.snav-i`/`.hit`/`.df-h` use 5.5%, `.event.self` uses 8.5%.
9. **Focus styles differ** (outline 3px 45%, box-shadow 38/45/50%, `:focus` vs `:focus-visible`).
10. **z-index clash**: `.ctxmenu` and `.dlg-back` are both `z-index: 50` (401, 485).
11. **Duplicate symbol id** `s-back`.
12. **Weights by accident**: 13px/700 inspector headers next to 17px/700 view titles.
13. **"Waiting for you" and "Error"** use the same red pill.

## 1.9 Contrast audit (WCAG 2.2 AA)

Computed by `source/audit-current.mjs`: glass layers composited over `#131316` the way they render, worst case with the top wash and panel sheen. **20 of 38 pairs fail.**

| Pair | FG | BG | Ratio | Need | Result |
|---|---|---|---|---|---|
| label on canvas | #f5f5f7 | #131316 | 17.03 | 4.5 | pass |
| label-2 on canvas | #a7a7ad | #131316 | 7.75 | 4.5 | pass |
| label-2 on panel top (sheen) | #a7a7ad | #2d2d30 | 5.71 | 4.5 | pass |
| label-2 on group in panel | #a7a7ad | #39393b | 4.82 | 4.5 | pass |
| label-2 on selected row | #a7a7ad | #4b4b4d | 3.65 | 4.5 | **FAIL** |
| label-3 on canvas (stamp) | #8d8d93 | #131316 | 5.62 | 4.5 | pass |
| label-3 on panel top (side h4) | #8d8d93 | #2d2d30 | 4.14 | 4.5 | **FAIL** |
| label-3 on group in panel (time) | #8d8d93 | #39393b | 3.50 | 4.5 | **FAIL** |
| label-3 placeholder on composer | #8d8d93 | #1f1f22 | 4.98 | 4.5 | pass |
| #fff on accent top #3d9bff (bubble me) | #ffffff | #3d9bff | 2.86 | 4.5 | **FAIL** |
| #fff on accent mid | #ffffff | #2484ff | 3.63 | 4.5 | **FAIL** |
| #fff on --blue (menu hover) | #ffffff | #0a84ff | 3.65 | 4.5 | **FAIL** |
| --blue link on canvas | #0a84ff | #131316 | 5.08 | 4.5 | pass |
| --blue link on group in panel | #0a84ff | #39393b | 3.16 | 4.5 | **FAIL** |
| --red text on canvas (event.err) | #ff453a | #131316 | 5.44 | 4.5 | pass |
| --red text on .btn.danger (inspector) | #ff453a | #3f3f42 | 3.07 | 4.5 | **FAIL** |
| --orange text on group (warn) | #ff9f0a | #39393b | 5.61 | 4.5 | pass |
| --green text on group (fixed) | #30d158 | #39393b | 5.71 | 4.5 | pass |
| --purple on canvas | #bf5af2 | #131316 | 5.26 | 4.5 | pass |
| pill.blue | #0a84ff | #112c49 | 3.89 | 4.5 | **FAIL** |
| pill.red | #ff453a | #471e1e | 4.19 | 4.5 | **FAIL** |
| pill.purple | #bf5af2 | #392346 | 3.98 | 4.5 | **FAIL** |
| pill.orange | #ff9f0a | #473213 | 5.91 | 4.5 | pass |
| pill.green | #30d158 | #193d25 | 6.00 | 4.5 | pass |
| pill (neutral) label-2 on fill | #a7a7ad | #2f2f32 | 5.55 | 4.5 | pass |
| .count #fff on --red | #ffffff | #ff453a | 3.41 | 4.5 | **FAIL** |
| plan-badge #6cb6ff | #6cb6ff | #30465f | 4.49 | 4.5 | **FAIL** |
| diff A #fff on #2ea043 | #ffffff | #2ea043 | 3.37 | 4.5 | **FAIL** |
| diff D #fff on #d1453b | #ffffff | #d1453b | 4.54 | 4.5 | pass |
| diff M #fff on #b0832a | #ffffff | #b0832a | 3.43 | 4.5 | **FAIL** |
| diff R #fff on --purple | #ffffff | #bf5af2 | 3.52 | 4.5 | **FAIL** |
| danger-fill #fff on #ff6259 | #ffffff | #ff6259 | 2.94 | 4.5 | **FAIL** |
| row.zero label @.45 on panel | #87878a | #2d2d30 | 3.82 | 4.5 | **FAIL** |
| toast.err red on menu | #ff453a | #202024 | 4.77 | 4.5 | pass |
| NON-TEXT focus ring blue45% vs panel | #1d548d | #2d2d30 | 1.77 | 3 | **FAIL** |
| NON-TEXT switch off track vs group | #59595b | #39393b | 1.64 | 3 | **FAIL** |
| NON-TEXT --yellow bar vs track | #ffd60a | #363639 | 8.50 | 3 | pass |
| NON-TEXT --gray idle glyph on panel | #98989d | #2d2d30 | 4.76 | 3 | pass |
| NON-TEXT --indigo repo glyph on canvas | #5e5ce6 | #131316 | 3.66 | 3 | pass |

The worst offenders are the most visible ones: white text on the blue gradient (every message the user sends, every primary button) and on the solid blue menu highlight.
