# Decisions made during implementation

What was agreed with the user during design was followed as is. Below are the choices made while implementing. To change one, refer to it by number.

## Storage and layout

1. **State is a single JSON file, not SQLite.**
   - Tasks, Workers, decisions and chat live in `<home>/data/state.json`, written atomically and batched every 300 ms.
   - Worker conversations go to `<home>/data/workers/W-xx.jsonl`.
   - Why: without native modules, Windows and macOS packaging stays simple. A personal tool has little data.
2. **Memory search scans the markdown for word matches instead of SQLite FTS.**
   - As agreed, markdown plus git is the source of truth. Add FTS if it slows down past a few hundred files.
3. **One worktree per Worker per repository** (`<home>/worktrees/<repo>/<W-id>`).
   - For each task the Worker creates a new `agent/t-xxxx` branch inside that worktree.
   - Why: when the same Worker continues, the session's folder must not change (resume is tied to the folder path).
4. **When a PR is merged or closed** the local and remote branches are deleted and the worktree goes back to the default branch.
   - The worktree folder itself is removed when the Worker is archived.
   - This is the only difference from the agreed plan ("delete the worktree on merge"): a Worker that keeps its context needs its folder to take the next task.
5. **Output of non-code tasks** goes to `<home>/workspaces/<W-id>/<T-id>/`.
6. **Repository registration accepts a git URL, `org/name` (turned into a company GitHub URL), or the path of a folder already cloned.**

## Agents

7. **Dispatcher tools.**
   - Read-only tools only: Read, Glob, Grep, WebSearch, WebFetch.
   - Plus the IDE task-board MCP tools: `list_repos`, `register_repo`, `list_workers`, `create_task`, `send_to_worker`, `stop_worker`, `request_decision`, `remember`, `recall`, `task_detail`.
   - It cannot edit code.
8. **The MCP server is named `board`.** Claude Code reserves `ide` for IDE integration and filters its tools. This actually happened.
9. **Effort.** Dispatcher medium, Workers high, the answer-on-your-behalf check low.
10. **The Dispatcher starts a new session each day.**
    - Its system prompt carries a memory digest and the repository list.
    - Worker news does not wake the Dispatcher; it is prefixed to the next user message. This avoids extra turns and cost.
11. **Worker result format.** The final message starts with `RESULT:`, `PR:` and `FILE:` lines that the app parses. Result cards take their summary, PR link and file links from these.
12. **A follow-up (from the user, the Dispatcher, or a correction) on a task finished less than 3 days ago** reopens that task, and its result card says "Applied the follow-up".
13. **On restart** running Workers reopen their sessions and get a "continue where you left off" message. Pending questions and permission requests are withdrawn; Workers ask again as they continue.

## Questions, permissions, answering on the user's behalf

14. **The app intercepts Workers' AskUserQuestion.**
    - First the Dispatcher model checks memory and answers only with clear support (structured output).
    - Without support, the question goes to the decision inbox and the Worker waits.
    - It never answers questions that are hard to undo: cost, security, deleting data, making something public.
15. **Permissions.** Auto mode is used; only what auto mode cannot decide goes to the decision inbox.
16. **Always ask, regardless of auto mode** (PreToolUse hook):
    - force push
    - direct push to main, master, develop, release/*
    - DROP/TRUNCATE, DELETE without WHERE
    - production database clients
    - kubectl, terraform, helm changes
    - `gh pr merge`, deleting a repository or release
    - `rm -rf` of the root or home folder
    - (Editing files outside the Worker folder was on this list until decision 58.)
17. **Answers given in the decision inbox** are kept in memory under `decisions/YYYY-MM.md`. Finished tasks go to `tasks/YYYY-MM.md`.
18. **Corrections.**
    - "Just this once" sends only a `[Correction]` message to that Worker.
    - "Fix the preference" also rewrites the line in `preferences.md` the answer was based on.

## Accounts and usage

19. **Two kinds of account.**
    - A token from `claude setup-token`, encrypted with the OS secure store.
    - This PC's Claude Code login as is. Only one can be registered.
20. **Assignment.**
    - Pick the account whose larger of 5-hour and 7-day usage is lowest.
    - Within 5 points, pick the one assigned longest ago.
    - Accounts above 80% get no new sessions.
21. **Hitting a limit.**
    - A limit error mid-task resumes the same session with another account's token.
    - When every account is above 80%, new work is queued and retried every 2 minutes.
22. **Usage comes from three places.**
    - Token accounts: Claude Code's usage endpoint every 5 minutes.
    - Rate-limit events from every session.
    - The session usage API after each turn (at most once a minute). This also fills tokens without endpoint access and the login account.
23. **Child process environment.** Started from a Claude Code terminal, the app inherits variables such as `CLAUDECODE` and `CLAUDE_CODE_*`, which confuse child sessions. They are stripped.

## Compaction, archiving, notifications, PRs

24. **Compaction.** When a turn ends above 250K context, `/compact` is sent. That turn is hidden.
25. **Auto-archive.**
    - Workers idle for the configured period (default 7 days) are archived. Workers with an open PR or a task waiting for a merge are not.
    - If the Dispatcher gives an archived Worker new work, it is restored automatically.
26. **Notifications.**
    - Decisions: the app's own sound, an OS notification, taskbar flash on Windows (Dock bounce on macOS), and a blinking sidebar.
    - Finished tasks: a silent notification, only while the window is in the background.
27. **PR checks.**
    - Every 3 minutes, `gh` checks open PRs.
    - New conversation, review or inline comments (bots excluded) are handed to the Worker that opened the PR to address and push.
28. **The CLAUDE.md PR** is created only from the button shown when `repos/<repo>.md` is open in the Memory view. The Worker that has been working on that repository takes it if there is one.

## UI

29. **Windows window.** The title bar is hidden and the OS window buttons overlay the top right. On macOS the traffic lights sit above the sidebar.
30. **Fonts.** System fonts only, so it looks the same offline.
31. **Shortcuts.**

    | Key | Action |
    |---|---|
    | ⌘/Ctrl+1–4 | Switch view |
    | ⌘/Ctrl+, | Settings |
    | ⌘/Ctrl+Z | Undo clearing a list |
    | Enter | Send |
    | Shift+Enter | New line |

    While the Dispatcher is working and the input is empty, the send button becomes a stop button.
32. **No "add repository" button.** During the mock review we agreed that adding happens through the chat. The Repositories view can edit descriptions and unregister.
33. **Model IDs are editable in Settings.** Defaults: Dispatcher Sonnet 5.5, Worker Opus 5.5, design work Fable 5.2.

## Packaging

34. **NSIS installer on Windows, dmg on macOS.**
    - The SDK's Claude binary is unpacked outside the asar.
    - No code signing. It is a personal tool, so the OS warns once on first run.
35. **`OMA_DATA_DIR`** puts settings and data in another folder. Meant for testing; also works as a second profile.

## Round 3 (0.2.0)

36. **Usage endpoint 429 is not an account limit.** It is the usage endpoint's own request limit (Claude Code on the same PC calls it too). The app keeps the last known values, shows no error, and waits for Retry-After or 15 minutes before asking again. The 7-day number appears only when the endpoint or the session usage API reports it; rate-limit events during work only carry the 5-hour window. Unknown values show as "–" in both the toolbar and Settings, with a tooltip saying why.
37. **Language.** English is the default; Korean can be chosen in Settings → General. All UI text lives in `src/shared/i18n.ts`. Agent prompts are written in English and tell agents to write to the user in the chosen language. Chat lines already written stay in the language they were written in. Code, comments, docs and commit messages in this repository are in English.
38. **PR language for Workers.** Workers follow the language of the repository's recent PRs; without a clear convention they use the UI language.
39. **Settings layout.** Sections on the left (Accounts, General, Display, Notifications, Memory, Models), the chosen section on the right, one Save button for everything. Switching sections keeps unsaved values. Settings carry no explanatory paragraphs; labels and placeholders only.
40. **Accounts: at most 4, each marked Team or Enterprise.** The plan is a label the user picks; it does not change assignment. Accounts that report no usage window are scored as 0% and rely on rate-limit events, as before.
41. **Decision sound.** Built-in sounds are synthesized with Web Audio (chime, bell, ping), so no audio files ship with the app. A custom file (mp3, wav, ogg, m4a, aac, flac, up to 8 MB) can be chosen. OS notifications are silent so the sound plays only once. Windows needs an AppUserModelID for toast notifications, so the app sets `dev.ohmyagent.ide` (same as `build.appId`).
42. **Dropped files are passed as paths, not copied or uploaded.** The message gets an `[Attached files]` list of absolute paths. The Dispatcher puts those paths in the task prompt, and Workers may Read, Glob and Grep at or under them without a permission prompt. Other writes still follow the normal rules. Files dropped anywhere else in the window are ignored instead of opening in the window.
43. **Tasks that wait for a merge.** `create_task` takes `after_task_id`. Such a task is assigned right away (the Worker shows "After merge") but starts only when the PR monitor sees that PR merged. If the PR is closed without merging, the waiting task is cancelled and the chat says so; the Dispatcher hears it with the next message. A merge also posts a silent notification, marks the result card "merged", and is checked again whenever the window comes to the front (at most once a minute) in addition to every 3 minutes.
44. **Font and text size** (from PR #1) are set in Settings → Display and stored as `fontFamily` (empty = system font) and `fontSize` (10–20 px, default 13) in `settings.json`.
    - The chosen font applies to all UI text, with the system fonts appended as fallbacks. Code and logs keep the monospace font.
    - Text size scales every font size relative to 13 px (`--ui-font-size`, `--px`); window and panel widths stay the same.
    - Changes preview live in the settings sheet and revert if you close without saving.
45. **Effort.** Settings hold a default effort for the Dispatcher (medium) and for Workers (high). With "Effort per task" on (default), `create_task` takes an optional `effort` and the Dispatcher sets it only when a task clearly needs more or less than the default; the Worker session switches level live (`applyFlagSettings`) before each task. With it off, every task uses the Worker default.
46. **Custom controls instead of native ones.** Dropdowns are pop-up buttons with a popover list (keyboard: arrows, Enter, Escape). Number fields are steppers, volume is a custom slider. The font picker lists only fonts installed on this computer (read with `queryLocalFonts`), each shown in its own typeface; a typed name that is not installed gets an orange outline. Fonts that aren't installed used to fall back to the system font silently, which is why picking a suggested font seemed to change nothing.
47. **Settings is a full window, not a sheet** (from the approved mockup).
    - Top bar: back to the workspace on the left, the title fixed in the center, and "Unsaved changes", Revert and Save on the right. The title never moves when the label appears.
    - Save keeps the window open. Leaving with the back button or Escape drops unsaved changes.
    - The left list has a search box that keeps only the sections whose labels match, and the app version at the bottom. Its icons are plain line icons; the chosen one is blue.
    - Content is centered at 680 px in grouped rows.
48. **Segmented controls replace dropdowns** wherever the choices are few: plan, language, decision sound, models and effort. The play button matches the control's height. Model choices are fixed lists; a model ID set earlier that is not in the list stays as an extra choice. Only the font keeps a list (installed fonts).
49. **Accounts are cards** with initials, plan badge, login kind and 5h/7d meters (orange at 80% and above). The ⋯ menu has Rename, Refresh usage, Plan and Remove. Rename edits in place (Enter saves; Escape or a click elsewhere cancels). Remove asks in a small dialog. A click outside the menu closes it.
50. **Fonts with coarse Hangul at small sizes.** D2Coding's `gasp` table turns smoothing off at 9–16 ppem, but Chromium on Windows ignores `gasp`: a copy with `gasp` set to smooth renders pixel-for-pixel the same. So the app does not patch fonts. Coding fonts look rough as the UI font because of their design at 13 px.

## Round 4: ideas from other agent IDEs

The survey is in [RESEARCH-agent-ides.md](RESEARCH-agent-ides.md).

51. **Plan-first tasks.** `create_task` takes `plan_first`. The Dispatcher sets it when the user asks to see the approach first, or when a code change is large, risky or open to several designs. The Worker session runs in plan mode (read-only) until the plan is approved. Its `ExitPlanMode` call becomes a "Review the plan" card in the decision inbox with the plan rendered as markdown. Approve switches the session to auto mode and the Worker builds. Typed feedback denies `ExitPlanMode` with that text, so the Worker revises and presents the plan again. Like other pending requests, an open plan card is withdrawn on restart; the Worker resumes in plan mode and presents it again.
52. **Changes tab in the Worker conversation** (repository Workers only). It lists files that differ between the worktree and its merge base with `origin/<default>`: committed and uncommitted changes, plus untracked files. Each file expands to its diff. The diff is read when the tab opens or Refresh is pressed, not on every state update. Patches are capped at about 600 KB in total so a huge change cannot freeze the window. Reading only: changes still go through the Worker.
53. **Setup command per repository.** Set in the Repositories view. It runs once in each new worktree, through PowerShell on Windows and the login shell elsewhere, with `ROOT_PATH` set to the main checkout (for example `cp $env:ROOT_PATH/.env .`). A failure is reported in the chat; the Worker still starts.
54. **Usage in the toolbar with 3 or 4 accounts.** One row per account no longer fits the 52 px toolbar, so from three accounts on they sit two per row and the "5h"/"7d" labels are dropped (the bars stay in that order). Hovering an account shows its name, both percentages and when they were read.
55. **Usage past its reset time is ignored.** A 5h or 7d value whose `resetsAt` has passed counts as unknown (0 for picking accounts, "–" on screen). Before this, an account stored above 80% stayed "limited" after the window reset. A PC-login account learns usage only from running sessions, and none start while every account looks limited, so the app could stay stuck.
56. **Composer.** No placeholder text. The box grows with its text up to half the window, then scrolls with the scrollbar hidden. The stop button had picked up the settings top bar's `.stop` layout and stretched into an ellipse; that bar's class is now `.stopbar`.
57. **UI polish pass.**
    - Selection prompts and "nothing here" states show a title only. The sidebar's "nothing in progress" is one quiet row instead of a large block. The first-run chat and empty Repositories views keep their one line of guidance, since adding a repository only works through the chat.
    - The settings account badge used the global `.pill` class and turned every status pill blue (idle Workers looked busy). It is now `.plan-badge`.
    - The Worker conversation subtitle shows repository · branch · model.
    - Long paths: the Repositories inspector shows the last three segments with the full path on hover; the IDE home field in Settings scrolls to the end.
    - A Worker's final report shows its `RESULT:` line as a bold summary with PR and file chips, instead of the raw `RESULT:`/`PR:`/`FILE:` lines.
58. **File edits are left to auto mode.** The always-ask list no longer includes edits outside the Worker folder. Claude Code itself writes outside the worktree all the time (auto-memory under `~/.claude/projects`, plan files under `~/.claude/plans`, its temp scratchpad), so the rule filled the decision inbox with harmless requests. Auto mode still asks through the inbox when it cannot decide. The always-ask list keeps only destructive or shared-state shell commands (decision 16).
59. **Dependency audit.** All direct dependencies were already at their latest versions; the 6 moderate warnings came from `minimatch` 9.x and 10.x inside electron-builder (GHSA-g3hv-75wg-m249). `npm audit fix --force` would downgrade electron-builder, so `package.json` overrides only those two ranges to `^11.0.9`. The 3.x and 5.x copies are outside the advisory and keep their older API. `npm audit` reports 0; the Windows installer builds and the packaged app starts. The macOS-only `@electron/universal` path is untested until the next dmg build.
60. **Compact or clear the Dispatcher by hand.** The context indicator next to the send button opens a menu: Compact conversation sends `/compact` to the current session (hidden turn; the chat notes the size before and after), and Start new conversation drops the session so the next message starts fresh. The chat on screen, Workers, tasks and memory stay. Both are disabled while the Dispatcher is working or has no context. Automatic compaction at 250K stays as before.
61. **Claude Code rules and memory reach every agent, like subagents.** Claude Code passes CLAUDE.md to its subagents and keys agent memory by role, not by run; the app does the same.
    - **Rules:** `~/.claude/CLAUDE.md` and `~/.claude/rules/*.md` (or under `CLAUDE_CONFIG_DIR`) are read and appended to the Dispatcher's and every Worker's system prompt (up to 20K characters), and given to the auto-answer check. The `user` settings source stays off, so `~/.claude/settings.json` (permissions, hooks, MCP) does not reach agent sessions.
    - **Auto-memory:** a Worker's `autoMemoryDirectory` is the Claude Code memory of its repository's main checkout (`~/.claude/projects/<checkout path>/memory`), so all Workers on a repository and the user's own Claude Code sessions there read and write one memory. Workers without a repository share the IDE home's, which is also the Dispatcher's. Workers are told to save only durable repository or preference facts there, never task progress. Verified with a live session: the folder's `MEMORY.md` index is loaded.
    - **recall tool:** Workers get `recall` (MCP server `oma`) over IDE memory plus their shared Claude Code memory. The Dispatcher's `recall` also searches the Claude Code memory of every registered repository and of the IDE home.
    - Repositories registered by URL live under `<home>/repos/<name>`, where the user has not run Claude Code, so their shared memory starts empty.
62. **Second UI pass on the main screen.**
    - Results list task outcomes only. Errors without a task (every account at its limit, Dispatcher errors) stay in the chat, where the same error repeated back to back shows once with a count.
    - Each result shows when it finished: the time today, the date before that, the full time on hover.
    - Agent summaries render `code` spans in result cards, the results list and Worker reports.
    - Multi-line chat events keep their icon at the first line; usage percentages keep a gap before the next label.
63. **Settings pass.**
    - **Add account** starts with the sign-in method (Token or This PC's login). The token field and the matching button show only for the chosen method; the method choice is hidden once a PC login is registered.
    - **Memory** has two groups. IDE memory: its folder (Open) and the remote. Claude Code: which rule files were found, a switch for passing user rules to agents (`claudeRules`), a switch for sharing the repository's Claude Code memory with Workers (`claudeMemory`; off turns Claude Code auto-memory off for Workers instead of one per worktree), and the Claude Code folder (Open). Changing either switch gives the Dispatcher a fresh session; Workers pick it up when their session starts.
    - The text preview in Display uses the chat window's background instead of black.
    - The company GitHub host keeps only the host name (scheme, path and case are dropped).
64. **App icon.** Stacked frosted glass windows with a prompt on a blue squircle, in the Liquid Glass style of macOS Tahoe / iOS 26: the windows blur what lies beneath them, carry a thin top-lit rim, and cast soft blue shadows. It stands for several agent sessions running at once. `scripts/make-icon.mjs` writes the SVGs into `build/` and `scripts/render-icon.cjs` renders them with Chromium (`npm run icon`):
    - `build/icon.png`, 1024 px on the macOS grid (824 px body with room for its shadow); electron-builder makes the `.icns` from it.
    - `build/icon.ico`, 16 to 256 px, with a larger body for Windows. Each size is rendered from the vector. At 32 px and below a simplified layout (two windows, heavier prompt, no fine shadows) keeps it legible in the taskbar.
65. **Liquid Glass UI.** The main window and Settings follow the macOS Tahoe look.
    - **Floating panels.** The sidebar, inspector and Settings navigation float as rounded glass panels, inset 8 px from the window edge. Each panel shows the blurred backdrop through it, has a soft sheen at the top, and carries a specular rim: light from the upper left catches the top and left edges, with a fainter glint opposite.
    - **Capsule controls.** The toolbar has no bar of its own: the view switcher and usage sit on it as glass capsules. Buttons and segmented controls are capsules too; the default button uses the accent gradient. Menus, dialogs and toasts are glass sheets over the content.
    - **Floating composer.** The message box floats over the end of the conversation as a glass capsule, so messages scroll under it. The conversation keeps room below its last message for the composer's current height, measured as it grows. If the view was at the end, it stays there.
    - **Window stays opaque.** The window does not use the OS material (Windows acrylic, macOS vibrancy); the app paints its own backdrop instead: neutral graphite (`#131316`), slightly lighter at the top. A blue and violet wash was tried first and dropped as too loud. The desktop showing through hurt legibility behind busy wallpapers, transparent Electron windows have resize artifacts on Windows, and neither could be checked on screen here.
    - On Windows and Linux the sidebar does not keep the empty band reserved for the macOS traffic lights. The traffic lights now sit inside the floating sidebar.
    - Text boxes in inspectors grow with their text instead of showing a resize grip.
    - With Reduce transparency (macOS) or transparency effects off (Windows), surfaces turn solid and nothing is blurred.
66. **Selection slides like Liquid Glass.** Every segmented control (the view switcher, the Worker conversation/changes tabs, the choices in Settings) has one glass pill under the chosen segment. Choosing another slides the pill there with a slight overshoot and stretches it along the way. A control that is new, shown again or resized places the pill without motion; with Reduce motion it never animates. The pill follows the selection however a control was updated, so re-rendered controls need no extra code.
67. **Settings save as they change.** No Save or Revert. Switches, segments, pickers and steppers save at once; typed text after a short pause or when the field loses focus. The IDE home folder saves only when its field loses focus or a folder is picked, then asks in an in-app dialog whether to restart now. The home folder is now read once per launch, so a new one really waits for the restart (before, part of the app switched to it right away). Changing it back to the folder in use asks nothing.
68. **Models come from the API.** Settings > Models lists every model the registered accounts can use, read from the Anthropic API's model list (`GET /v1/models`) with an account's token, newest first. New models appear without an app update. The list is kept in `models.json` in the app data folder: it is read again at startup when older than 6 hours, on opening Models when older than a minute, and by Refresh. If no token can read it (macOS keeps the PC login in the Keychain; a PC login token may have expired), the running Dispatcher session's list from Claude Code is used. Otherwise the last list stays. Each role (Dispatcher, Worker, design work) picks from the list in a dropdown that shows the name and the model ID; a configured model missing from the list stays selectable. Model names elsewhere come from the same list.
69. **Default home folder is `~/oh-my-agent-ide`.** New installs use it. Existing installs keep the folder already saved in their settings; changing it in Settings does not move data.
70. **UI fixes.** The account menu in Settings drew under the next card (each card was its own blur layer); settings cards no longer blur, which changes nothing visible on the plain backdrop. Labels in info tables (Repositories, Workers) size to the longest label up to 140 px and wrap past that, instead of a fixed 84 px column that "Default branch" overflowed.
71. **Dark window frame on Windows.** The UI is dark only, but Windows draws the window frame from the system theme. In light mode the outline was light, and on a monitor whose DPI differs from the primary one a 1px `#f3f3f3` strip showed on the left, right and bottom edges (Chromium leaves that strip to the system frame; it cannot be removed from the app). On Windows the app now sets `nativeTheme.themeSource = 'dark'`, so the frame is dark (the strip turns `#202020`, next to the `#131316` canvas). macOS and Linux keep following the system theme; nothing there changes.
