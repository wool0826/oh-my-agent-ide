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
    - editing files outside the Worker folder
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
