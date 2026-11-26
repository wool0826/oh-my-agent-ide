# Oh My Agent IDE — rules for agents

Electron app: `src/main` (main process, agents, git, IPC), `src/renderer` (window UI), `src/shared` (code both sides use).
Product and user docs are in `README.md`; past choices are in `docs/DECISIONS.md`.

## Where rules live

- Put every rule (what to show, when to retry, how to merge, what a string means) in a pure module in `src/shared/`:
  no Electron, DOM or file system in it. Main and renderer only call it and wire up the result.
- Each shared module is covered by a unit test in `test/`, usually `test/<name>.test.ts`. A new rule gets its
  test in the same PR.

## Checks

Run all of these before you commit; CI runs the same.

```bash
npm run typecheck   # tsc -p .
npm test            # unit tests in test/*.test.ts, including test/cssTokens.test.ts
npm run e2e         # builds, then drives the real window with fake agents (no account or network)
```

Run the one unit test you changed first:
`npx esbuild test/<name>.test.ts --bundle --platform=node --format=esm --outfile=dist/test/<name>.test.mjs && node --test dist/test/<name>.test.mjs`
(add `--alias:electron=./test/stubs/electron.ts` when the code imports `electron`).

## Design

The spec, tokens and component gallery are in `docs/design-system/` (start with its `README.md`).

- **Tokens only.** Colours, font sizes, radii and spacing in `src/renderer/styles.css` are `var(--…)` from
  `src/renderer/tokens.css`. `test/cssTokens.test.ts` fails on literals; it allows 0, 1px hairlines, em/%, numbers
  inside `var()` fallbacks and `calc()`/`min()`/`max()`/`clamp()`, and a short explicit allow-list. Add a token to `tokens.css` only when none fits, for both themes.
- **Dark is the default theme**; light must work too. Check both.
- **Selection is a ring, never a fill**: a selected row or card gets a 2px accent ring, no tint under its text.
- **No explanatory help sentences in the UI.** Labels, titles and tooltips are enough. No native `select`,
  `datalist` or `range` looks: use the custom controls already in the app.
- **Check narrow windows.** Before you call a UI change done, look at it at a narrow width (about 900px) and make
  sure nothing overflows, clips or scrolls sideways.

## Tests

- **No fixed sleeps** to wait for the app. Wait for a condition with the harness helpers in `test/e2e/harness.mjs`:
  `app.until(js, 'what it waits for')`, `app.reconnect(ready)`, `app.drag(selector, dx, { ready })`. Give `until` a
  readable second argument; it is the failure message.
- **E2e flows live in one file per area**, `test/e2e/<area>.e2e.mjs`: add a flow to its area's file, or start a new
  file for a new area. Write each with `flow(name, opts, fn)` from the harness; a failed one keeps a screenshot, the
  page and the logs under `test-results/e2e/`. `npm run e2e` and the CI shards (`test/e2e/shard.mjs`) find files by
  pattern.
- Unit tests use `node:test` and `node:assert/strict`, one behaviour per `test(...)`, named `'<area>: what it does'`.
- **Screen pictures.** `test/e2e/visual.e2e.mjs` compares the main screens in both themes with `test/e2e/visual/*.png`
  (Windows only; CI job `visual`). When a change is meant to change how one of those screens looks (a token, a
  component, a string on it), run `npm run e2e:visual:update` in the same PR, look at each changed picture, and commit
  them. A failure you did not mean is a regression: its expected, actual and diff pictures are in `test-results/visual/`.

## Where things go

- **i18n.** Every user-visible string is a key in `src/shared/i18n.ts`, added to both `en` and `ko`, next to the
  keys of the same screen or group (not at the end of the file). Call it with `tr(...)`.
- **CSS.** Add rules to `src/renderer/styles.css` next to the group for the same component (each group starts with a
  `/* … */` comment), not at the end of the file. New tokens go into the matching section of `tokens.css`.

## Decisions

Record every choice the user did not make themselves in `docs/DECISIONS.md`, in the same PR:

- Append the next number under the matching heading (or the latest round): `N. **One-line rule in bold** (T-xxxx).`
- Below it, short bullets: what was chosen, why this way, and what was rejected. Refer to an earlier entry by number
  when it changes or follows one (`follows 195`).

## Commits and PRs

- One branch per task (`agent/t-xxxx`) and a PR to `main`; nothing is pushed to `main` directly.
- Commit subjects in English, imperative, one line. PR title and body in English: what changed and which checks ran.
