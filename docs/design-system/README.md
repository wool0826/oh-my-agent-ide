# T-0009 — Oh My Agent IDE design system: extraction and v1 "Graphite Glass"

Source: `wool0826/oh-my-agent-ide` `origin/main` at `73d8433`. No app code was changed.

## Files

| File | What |
|---|---|
| `design-system.html` | **The artifact.** One self-contained file (no network, fonts or scripts from outside); open it in a browser. Palette, contrast table, type scale, space/radius/size, elevation, motion demos, icons, component gallery by state, the main screen redrawn, migration tables. Controls at the top: Dark / Light / System, English / 한국어, text size, Reduce motion, Reduce transparency. |
| `tokens/tokens.css` | Token definitions as CSS variables (primitives, scales, dark + light + system, reduce transparency/motion) |
| `tokens/tokens.json` | The same tokens as JSON (W3C design-tokens draft format) |
| `tokens/components.css` | Reference CSS for every component, written only against the tokens |
| `01-current-audit.md` | Extracted current system: colors, type, spacing, radius, elevation, icons, motion, components, hard-coded values, duplicates, inconsistencies, contrast audit |
| `02-design-system.md` | v1 spec: token architecture, roles table (dark/light), scales, component specs, accessibility, light theme, migration plan |
| `03-contrast-report.md` | Generated WCAG 2.2 AA report: 250 pairs, both themes |
| `previews/*.png` | Screenshots of the main screen (dark EN, light KO) and two gallery sections |
| `source/` | `tokens.mjs` (source of truth), `build.mjs` (writes tokens, report, HTML; fails on any contrast miss), the HTML template, `audit-current.mjs` |

Rebuild: `node source/build.mjs` (Node 18+).

## Main changes from the current system

1. **Contrast fixed.** 20 of 38 audited pairs fail AA today, including white on the blue gradient (2.86:1, every sent message and primary button), the blue menu highlight (3.65), the decision count badge (3.41), tertiary text in inspector cards (3.50), blue/red/purple pills and the focus ring (1.77). In v1, 250/250 checked pairs pass in dark and light.
2. **Visible but small color shifts.** The accent gradient is darker (`#3d9bff→#0a6cff` becomes `#1570ea→#0659d4`); secondary/tertiary text is a little brighter (`#a7a7ad→#b4b4bb`, `#8d8d93→#a1a1a8`); glass alphas are lower where cards stack inside panels. Colored text uses lighter `*-text` steps; white text sits only on `*-solid` fills.
3. **Three token layers** (primitives → semantic roles → components) replace 46 loosely named variables, 17 hard-coded hex colors and about 30 inline `rgba()` values. GitHub diff colors and the third red (`#ff6961`) are gone.
4. **Named scales.** 12 font sizes → 7 roles (11–24px, nothing under 11), 25 spacing values → 12, 14 radii → 7, ad-hoc shadows → 5 levels, 5 blurs → 3, 10 durations → 7 named plus 5 named easings. Control heights 24/28/32; all targets ≥24px.
5. **One component per job.** `.seg/.segc/.radios` → one segmented control (the correction-scope radios now get the sliding pill too); three menus → one; button variants → `.btn` with sizes and intents; pill/plan-badge/diff letters/count → pill tones; toolbar and account meters share one level rule.
6. **Korean and mixed copy.** `word-break: keep-all` for Korean, 1.5 line height for messages and cards, English product terms kept inside Korean sentences.
7. **Light theme and System mode**, with Reduce transparency and Reduce motion working in both.
8. **Bugs found on the way.** Duplicate `s-back` symbol id (Settings back button draws the 8×12 chevron), `.ctxmenu` and dialog scrim both at z-index 50, account cards and toolbar color the same usage differently, 55%/45% opacity rows that fall below AA.

The tab pill motion (spring slide + squash-and-stretch, 460ms) and the window layout are unchanged.
