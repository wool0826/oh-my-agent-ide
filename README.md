# Oh My Agent IDE

Tell a Dispatcher what needs doing in one window, and it hands the work to Worker agents. You see only the decisions that need you and the results. Built with Electron and the Claude Agent SDK; runs on Windows and macOS. The UI is in English by default, with Korean available in Settings.

![Oh My Agent IDE main window: sidebar with decisions, running Workers, PRs in review and the queue; the Dispatcher chat with result cards and auto-answers; the decision inbox and results on the right](docs/images/main-screen.png)

The main window with sample data: the sidebar lists what waits for you, running Workers, PRs in review and the queue; the chat holds the Dispatcher conversation and result cards; the right side holds decisions (a plan to approve, a command to allow) and results.

Decisions made during implementation are in [docs/DECISIONS.md](docs/DECISIONS.md). The design system (an audit of the current UI, the v1 "Graphite Glass" spec and tokens, and a self-contained `design-system.html`) is in [docs/design-system/](docs/design-system/README.md); the app's styles are built on its tokens. What has to be checked by hand with real accounts, because no automated test can reach it, is in [docs/REAL-USE-CHECKLIST.md](docs/REAL-USE-CHECKLIST.md).

## Install

Windows: build the installer (see below) and run `release/OhMyAgentIDE-Setup-<version>.exe`. It is unsigned, so if SmartScreen appears choose "More info → Run anyway".

macOS: build a dmg on a Mac:

```bash
npm install
npm run dist:mac
```

## First run

Settings opens. Sections are on the left. The Status group at the top of General shows what this computer still needs (git, the GitHub CLI and its sign-in, an account, a writable home folder) and how to fix it; a red dot on the gear means one of them is missing. "Save report…" under Diagnostics there writes a text file describing the app and the end of its log, with tokens and the names of your company's hosts removed, for when something goes wrong. Changes are saved as you make them; a new IDE home folder is used after a restart.

1. **Accounts.** Up to 4. For each Team or Enterprise account, run `claude setup-token` in a terminal and paste the token, then pick its plan. To use the Claude Code login already on this PC, choose "Use this PC's login". To use a ChatGPT account, install the Codex CLI, sign in with `codex login`, and choose "ChatGPT (Codex)": the app runs your Codex CLI and stores no token for it. One ChatGPT account can be registered.
2. **General.** Language, IDE home folder (clones, worktrees, results and memory live here; default `~/oh-my-agent-ide`), company GitHub host such as `github.company.com` (log in first with `gh auth login --hostname github.company.com`), and how long idle Workers stay before they are archived.
3. **Display.** Appearance (dark, light, or the system's), the font and the text size.
4. **Notifications.** OS notifications on or off, the sound played when a decision is needed (built-in chime, bell, ping, your own file, or none), and its volume. Do-not-disturb hours (for example 22:00 to 07:00) silence the sound and the notifications without hiding anything from the inbox, and notifications for finished tasks can be turned off. Several decisions from one Worker within a few seconds sound once.
5. **Memory.** Optional remote for the memory git repository: the clone URL of a private repository, such as `https://github.com/me/agent-memory.git` or `git@github.com:me/agent-memory.git`. The app merges what the remote holds and pushes what it lacks at launch and after each memory change, so several PCs can share one repository; the result of the last sync is shown under the address. Leave it empty to keep memory in a local git repository only.
6. **Models.** The model for the Dispatcher, for Workers, and for design work, picked from the models your accounts can use. The list is read from the Anthropic API, so new models appear without an app update. With a ChatGPT account registered, the list also has the models Codex offers it; an agent set to one of them runs on Codex. On Codex there is no plan-first step, no self-review and no cost estimate, and a usage limit makes the work wait for the reset.

## Using it

- Say what needs doing in the chat. Use `@repo` to pick a repository.
- Press Ctrl+Shift+Space (⌘⇧Space on macOS) anywhere to open a small box, type one line and press Enter: it goes to the Dispatcher like a chat message, without bringing the window up. Type `@` and the start of a repository's name and press Tab to finish it, drop files on the box to send their paths along, and use Up and Down for lines sent before. Change the shortcut, or clear it to turn this off, in Settings → General. Starting the app again with `--quick` opens the same box.
- Register repositories by asking, for example: "Clone github.company.com/payments/billing and register it. It runs the settlement batch."
- Drag files or folders onto the chat (or onto an open Worker conversation) to attach their paths. Agents read them from where they are; nothing is copied.
- When a follow-up needs a change that is still in an open PR, say so ("after that PR is merged, …"). The task waits and starts by itself once the PR is merged.
- At most 3 Workers run at once; change it with "Workers at once" (1 to 8) in Settings → Models. More tasks wait in the sidebar's Queue as "Waiting for a slot 3/3" and start by themselves, the longest waiting first, when one finishes. A Worker waiting for your answer keeps its slot, and messages to Workers already at work go out right away.
- A decision's notification has buttons when the answer is simple: Allow and Deny for a permission, or a question's two or three short options. A Worker that waits for an answer longer than 10 minutes gives its slot to the queue and still goes on as soon as you answer; change the time, or turn this off with 0, in Settings → Models.
- Click a task in the sidebar's Queue to see why it waits and what starts it: a free slot (with its place in line), a usage limit (with the account and the time it resets), or another task's PR to merge. The card at the top of the Worker view also shows its request and the tasks waiting on it. When the task it waits for failed or was cancelled, the card says in red that this one is cancelled too. Hover over a queue row for the same reason.
- To cancel a task that is still waiting (for a free Worker slot, for a usage limit to reset, or for a merge), use the × on its row in the sidebar's Queue or "Cancel task" in the Worker view; "Clear" on the Queue heading cancels them all. You can also ask in the chat ("clear the queue"). Tasks waiting on it are cancelled too. Its branch is cleaned up unless it holds commits or uncommitted changes, and an open PR is left open.
- The right side collects decisions waiting for you, results (PR links and result files), and answers the Dispatcher gave on your behalf. Correct an auto-answer with the pencil button or by right-clicking it.
- Come back to the window after five minutes or more and the inbox shows "While you were away": how many tasks failed, finished or had their PR merged, how many decisions came in, and the tasks themselves, each a click from its Worker.
- Every decision says why it needs you: which Worker asks to do what for which task, and why it is not decided without you (the always-ask rule and its risk, a path outside the Worker's folders, or what memory could not answer). The sidebar row and the OS notification show the same reason.
- A permission card also has "Allow for this task": the same kind of action (the same command and subcommand, or the same tool in the same folder) then goes ahead without asking until the task ends. What you allowed is listed under the task in the Worker view, where each can be taken back. The actions the app always asks about, such as a force push or a PR merge, are listed in Settings → General and can be switched off one by one; those are asked every time while on.
- A new task goes to an idle Worker that already worked on the same repository, preferring one that worked on the same area of the code. A Worker that is busy, has other open work, or whose context is at 60% of the window or more is passed over. A new Worker is created only when none fits, or when you ask for a fresh one.
- The Dispatcher and Workers talk to each other. The Dispatcher can ask a Worker a question or read its conversation, and a Worker can answer, ask for something or report that it is blocked without finishing its task. When an answer, a request or a result comes in, the Dispatcher tells you what it means without waiting for your next message; the chat shows one line per exchange. A Worker that waits for the Dispatcher reads "Waiting for the Dispatcher" and keeps its slot; you can also answer it yourself in its conversation.
- Each result shows what its task cost as an "API-equivalent estimate" (Claude Code's figure at API list prices) with its input, output and cache tokens. Subscription accounts are not billed this amount, and nothing is held back because of it. The Dispatcher's own cost this month is in the menu of the context indicator next to the send button.
- When an answer or a correction holds a fact worth reusing, a "Remember this?" card offers to save it to memory (save, edit, or dismiss). It appears only when the check is confident, at most once per task; turn it off in Settings > Memory.
- The Automations tab on the right sets up work that starts by itself: every day at a time (weekdays only if you like), or each time a PR is merged. When one fires, the Dispatcher gets its text as a message and handles it like a request you typed. You can also ask in the chat ("check for outdated dependencies every weekday at 9"). The app must be open; a daily one missed while it was closed runs once at the next start.
- In the Worker view, select a Worker to see its conversation with the Dispatcher and message it directly. "Done today" and "Archived Workers" in the sidebar filter the Worker list; "All" shows every Worker again.
- A Worker's Summary tab shows its work without the conversation: totals (tasks, PRs, files, spend), then each task with what was asked, how long it took, its full report, its PR and its files.
- Long conversations (the chat and a Worker's) open at their latest messages; scroll up for earlier ones. Long lists (results, auto-answers, archived Workers, a repository's tasks, memory search) end in "Show more".
- Say "plan first" (or ask for a large change) and the Worker plans before touching code. The plan arrives in the decision inbox: approve it, or type what to change.
- Ask to compare ("try this with two models and let me pick") and the task goes to two new Workers on different models, a Claude one and a ChatGPT one when both accounts exist. Neither opens a PR. The inbox shows the two attempts side by side; "Use this one" has that Worker push and open the PR. The other attempt stays on its local branch until you archive its Worker. This uses twice the usage.
- A request that changes several repositories ("rename this API in billing and in the web app") becomes one task per repository, shown together in the inbox as "Across repositories" in the order their PRs should merge. When every PR is ready, "Merge N in order" merges them one after another and stops at the first that fails.
- Press Ctrl+K (⌘K on macOS), or the search button in the toolbar, and type to go to a waiting decision, a view, a Worker, a repository or a settings pane. Rows show their own shortcuts. Typing also finds past tasks by id, title, PR number ("#24") or a word of their report, and opens the task's Worker on its Summary tab. From two characters on it also lists what was said that matches, in the chat and in Workers' conversations; a chat message opens the chat at that message.
- Closing the window leaves the app working: Workers, automations and the PR watch go on, and the tray icon opens the window again or quits. Turn this off, or have the app start when you sign in, in Settings → General.
- The app looks for a newer release on GitHub at launch and every six hours. When there is one, the gear shows a dot and Settings has a "Get <version>" link to the release page. Turn the check off in Settings → General. To publish a release: `npm run dist:win`, then `npm run release`.
- In a Worker's conversation, the Changes tab shows what it changed on its branch, committed or not, before a PR exists.
- In the Changes tab, click a line of the diff to comment on it. Comments stay under their lines until you press "Send N comments", which sends them to the Worker as one message with each file, line and comment.
- A Worker's files are saved as a checkpoint before each message it is handed (the newest 20 are kept). "Checkpoints" in the Changes tab lists them; picking one asks, then puts the files back to that point. The branch and its commits are not touched, the state before going back is saved too, and the Worker is told on its next message. Stop a running Worker first.
- Before opening a PR, a Worker has a reviewer on the Dispatcher's (lighter) model check its diff, fixes what holds up, and notes the result in one line of the PR body. Small changes (up to 30 lines in up to 3 files, or docs only) skip it. Turn it off with "Self-review before PR" in Settings → Models.
- Open PRs show whether they are ready to merge: CI, conflicts and review, on the result cards and in the Worker view. When CI fails, the Worker gets the end of the failed GitHub Actions log (or just the link, for other CI) and fixes it on the same branch, up to 3 times per task; after that the decision inbox asks whether to keep going.
- When an open PR conflicts with its base branch, its Worker merges the base in and resolves the conflict on the same branch (no rebase, no force-push), and asks when a conflict needs a decision. When a PR is ready (CI passed or none, no conflicts, no review still asked for), a Merge button appears next to its badges; it asks once, then merges the way the repository allows.
- With two or more PRs ready, the sidebar's "PRs in review" heading has "Merge N": it asks once and merges them one after another, checking each again first. Any that could not be merged stay in the list.
- In the Repositories view, a setup command (for example `npm ci`) runs in every new worktree. `ROOT_PATH` points at the main checkout, so `cp $env:ROOT_PATH/.env .` (Windows) or `cp "$ROOT_PATH/.env" .` copies local config.
- A repository can also have a run command (for example `npm run dev`). The Worker view then has a Run section: start it in that Worker's worktree to try its change, open the local address it prints, read the end of its output, and stop it. Quitting the app stops what is running.
- A GitHub repository's open issues are listed in the Repositories view. "Assign" hands one to the Dispatcher as a task: the Worker reads the issue and its comments first, and its PR closes the issue.
- With a Jira site set up in Settings → General (address, your email for Jira Cloud, and an API token you create in Jira), the Repositories view lists the open issues assigned to you. "Assign" hands one to the Dispatcher with its description, and the PR title carries the issue key. The app only reads Jira.
- In the Memory view, review and edit preferences, repository notes and past decisions. Opening a repository note offers a button to have a Worker open a PR adding it to that repository's CLAUDE.md.

### Shortcuts

| Key | Action |
|---|---|
| ⌘/Ctrl+1–4 | Switch view |
| Mouse back button, Alt+← (⌘[ on macOS) | Back to the previous screen |
| Mouse forward button, Alt+→ (⌘] on macOS) | Forward again |
| ⌘/Ctrl+, | Settings |
| ⌘/Ctrl+Z | Undo clearing a list |
| Enter | Send |
| Shift+Enter | New line |

## Development

```bash
npm install
npm run typecheck
npm test
npm run e2e
npm start
```

`npm test` runs the unit tests of the rules in `src/shared`. `npm run e2e` starts the built app on an empty profile with fake agents and a stand-in for `gh`, and drives its window through whole flows (`test/e2e/flows.e2e.mjs`); it uses no account and no network.

Build output goes to `dist/`, installers to `release/`.

- `npm run dist:win` builds the Windows installer.
- `npm run dist:mac` builds the macOS dmg (on a Mac).
- To keep settings and data in another folder, set `OMA_DATA_DIR=<folder>`. Its `settings.json` holds `home`.
- To run without accounts or usage, set `OMA_FAKE_AGENT=1`: every agent follows the `@fake` lines of the message it gets (see `src/shared/fakeScript.ts`), asking for permissions and reporting results through the app's real paths. The toolbar shows "Fake agents".

### Layout

| Path | What it does |
|---|---|
| `src/main/agents/session.ts` | One Claude Code session: account failover, compaction (80% of a 250K window, and by Claude Code mid-turn), usage reading |
| `src/main/agents/dispatcher.ts` | The Dispatcher session, its task-board MCP tools, and the turns Worker news starts |
| `src/main/agents/workers.ts` | Creating and assigning Workers, questions and permissions, talking to the Dispatcher, results, tasks that wait for a merge |
| `src/main/agents/advisor.ts` | Decides whether a Worker's question can be answered from memory |
| `src/main/agents/memorySuggest.ts` | Offers to remember reusable facts from decision answers and corrections |
| `src/main/agents/permissions.ts` | Actions that always ask |
| `src/main/accounts.ts` | Account pool, usage, assignment |
| `src/main/prmonitor.ts` | PR status, cleanup after merge, review comments, failed CI |
| `src/main/prchecks.ts` | Merge readiness from PR checks, which CI failures to hand back, log tails |
| `src/main/attachments.ts` | Paths of files dropped into messages |
| `src/main/memory.ts` | Markdown memory with git history |
| `src/shared/i18n.ts` | English and Korean UI text |
| `src/shared/askWhy.ts` | Why each decision needs the user, for its card, sidebar row and notification |
| `src/shared/routing.ts` | Which idle Worker takes a new task, or whether to create one |
| `src/renderer/app.ts` | The window's entry: draws every screen, what each control does, start-up |
| `src/renderer/ui/` | One module per screen (`sidebar`, `chat`, `workers`, `repos`, `memory`, `settings`, `palette`), plus `core` (shared state and helpers), `controls` and `history` |
| `test/e2e/` | End-to-end flows: the built app with fake agents and a stand-in for `gh` |
| `src/main/agents/selfReview.ts` | Self-review before a PR: the task-message rule, skip limits, reviewer subagent |
| `resources/plugin/` | Skills every Worker gets: token-saving habits and the self-review step |
