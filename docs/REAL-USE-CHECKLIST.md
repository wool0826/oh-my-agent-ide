# Real-use checklist

What the automated tests cannot reach, to be run by hand on the installed app with real accounts. The end-to-end tests (`npm run e2e`, decision 128) cover the app's own flows with fake agents: permissions and allowances, questions, plans, failures, slots, merging (one PR, all ready, a bundle in order), an automation fired by a merge, the palette and its search, "While you were away", issues, backups, the launch checks, the diagnostics report, the appearance setting, do-not-disturb hours and the quick message box's typing aids. Since task F2, `test/e2e/realuse.e2e.mjs` also runs the rest of the `e2e` rows: a slot given to the queue, a daily automation, review comments, checkpoints, the run command, refreshing the launch checks, files dropped on the quick message box and an allowance across a restart. Everything else here needs a real model, a real GitHub or Jira, the operating system, or a person.

Nothing in this file has been run yet. A result is written only by the person who ran that row, on that system, with the version they ran. A row that fails becomes an issue or a message to the Dispatcher.

## Categories

Every row carries one of these:

| Tag | Meaning | Rows |
|---|---|---|
| `e2e` | The app's own path, drivable with the fake agents (`@fake` scripts) and the gh stand-in (`test/e2e/gh-stub.mjs`). Not part of the hands-on pass: each runs in the flow its row names. | 15 |
| `win` | Needs the user's hands and eyes on Windows: tray, notifications, sound, global shortcut, installer, screen reader, OS theme. | 12 |
| `mac` | Needs a real Mac. Never run there so far. | 1 |
| `real` | Needs a real model, a real account, real GitHub, Jira, ChatGPT or a Telegram bot. | 23 |

A row is `e2e` when what it checks is the app's own path. When the expectation is about what a model does with real data (does the Worker merge the base, apply a review comment, does the Dispatcher split a bundle), it is `real`, even if part of it could be scripted.

## Before you start

- **Build**: the build under test installed with `npm run dist:win`, and the previous release (v0.6.2 installer) at hand for 8.1. Write the version from Settings → General in every row you fill.
- **Test repository on github.com**: a repository of your own that may receive throwaway PRs and merges, registered in the app, with
  - a CI workflow that runs on pull requests and can be made to fail on purpose (for example a test that reads a file the Worker can break),
  - no required review, or a second account to approve with,
  - squash merge allowed.
  A second small repository for 2.6 (two repositories, one bundle).
- **Company GitHub host** (2.7 only): a repository there that may receive a throwaway PR. Skip 2.7 if none is allowed.
- **Accounts**:
  - two Claude accounts registered in the app (7.2 needs both; one is enough for everything else),
  - one ChatGPT account for 7.3 (skip the row if there is none),
  - a Jira site with one open issue assigned to you and an API token (Cloud or Data Center) for 6.x,
  - `gh` signed in to github.com (and to the company host for 2.7),
  - a Telegram account on a phone, for 10.x (a new bot is made in 10.1).
- **Windows**: notifications on for the app, sound on, Narrator available (Win+Ctrl+Enter).
- **Usage** (estimate, not measured): the half-day pass runs about 12 small Worker tasks (each a one-file change or a note) plus their Dispatcher turns and a few CI fix and review rounds. Expect roughly a third to a half of one account's five-hour window. 7.2 deliberately runs an account past 80% and is left to a normal working day.

## The pass

The hands-on rows in run order. About four and a half hours of hands-on time; the day-long and Mac rows sit apart. Details for every row are under [Steps](#steps). Fill result with `ok` or what happened instead.

| Order | # | Tag | Time | Result | Date | Version | Note |
|---|---|---|---|---|---|---|---|
| **A. Install and sign in** (≈30 min) | | | | | | | |
| A1 | 8.1 | win | 10 min | | | | |
| A2 | 6.1 | real | 5 min | | | | |
| A3 | 6.2 | real | 2 min | | | | |
| A4 | 7.3 | real | 10 min | | | | |
| **B. Real tasks, with the window away** (≈80 min) | | | | | | | |
| B1 | 1.1 | real | 15 min | | | | |
| B2 | 3.1 | win | during B1 | | | | |
| B3 | 3.2 | win | during B1 | | | | |
| B4 | 3.4 | win | 10 min | | | | |
| B5 | 1.2 | real | 15 min | | | | |
| B6 | 6.3 | real | 15 min | | | | |
| B7 | 4.3 | real | 5 min | | | | |
| B8 | 5.4 | real | 20 min | | | | |
| **C. Pull requests on GitHub** (≈90 min) | | | | | | | |
| C1 | 2.1 | real | 10 min | | | | |
| C2 | 2.3 | real | 20 min | | | | |
| C3 | 2.4 | real | 15 min | | | | |
| C4 | 2.2 | real | 15 min | | | | |
| C5 | 2.6 | real | 20 min | | | | |
| C6 | 2.7 | real | 15 min | | | | |
| **D. Eyes and ears on Windows** (≈50 min) | | | | | | | |
| D1 | 3.7 | win | 5 min | | | | |
| D2 | 9.2 | win | 10 min | | | | |
| D3 | 9.3 | win | 5 min | | | | |
| D4 | 9.4 | win | 5 min | | | | |
| D5 | 9.1 | win | 15 min | | | | |
| D6 | 9.10 | win | 15 min | | | | |
| **E. Closing** (≈10 min) | | | | | | | |
| E1 | 3.3 | win | 5 min | | | | |
| **F. Alongside a normal working day** (not timed) | | | | | | | |
| F1 | 7.1 | real | all day | | | | |
| F2 | 7.2 | real | all day | | | | |
| F3 | 9.6 | win | 10 min at the end | | | | |
| **G. With the release** | | | | | | | |
| G1 | 8.2 | real | 15 min | | | | |
| **H. On a real Mac** | | | | | | | |
| H1 | 8.3 | mac | 60 min | | | | |
| **I. Telegram** (≈65 min) | | | | | | | |
| I1 | 10.1 | real | 10 min | | | | |
| I2 | 10.2 | real | 10 min | | | | |
| I3 | 10.3 | real | 10 min | | | | |
| I4 | 10.4 | real | 10 min | | | | |
| I5 | 10.5 | real | 15 min | | | | |
| I6 | 10.6 | real | 10 min | | | | |

## All rows

The original 45 rows and the 6 Telegram rows with their tag, and where each one is run: a pass order above, or the end-to-end flow that covers it, as `file`: "flow name" (the file is `test/e2e/<file>.e2e.mjs`).

### 1. A real task from start to finish

| # | Do | Expect | Tag | Where |
|---|---|---|---|---|
| 1.1 | Ask for a small code change in the test repository. | A Worker is created, works in its own worktree, and opens a PR. The result card links the PR. | real | B1 |
| 1.2 | Ask "plan first" for another change. | A plan arrives in the inbox with its WHAT / HOW / OUTPUT lines. Approving it starts the work. | real | B5 (app path: "a plan waits for approval before the work goes on") |
| 1.3 | Ask for something that needs a command outside the worktree (for example a global install). | A permission card with "Allow for this task". After choosing it, the same kind of command does not ask again in that task. | e2e | `decisions`: "a permission is asked once, allowed for the task, and the result card has the file" |
| 1.4 | Ask a Worker to force-push its branch. | The card names the always-ask rule and has no "Allow for this task". | e2e | `decisions`: "an always-ask rule offers no "Allow for this task", and a denial reaches the Worker" |
| 1.5 | Ask a non-code question ("summarize this file into notes"). | A result card with the file; clicking it opens the file. | e2e | `decisions`: "a permission is asked once, …, and the result card has the file"; the click: `realuse`: "row 1.5: the file on a result card opens from its link" |

### 2. Pull requests on real GitHub

| # | Do | Expect | Tag | Where |
|---|---|---|---|---|
| 2.1 | Let a PR's CI pass and approve it (or use a repository without required review). | "Merge" appears next to its badges. It asks once, merges the way the repository allows, and the task shows merged. The worktree and branch are removed. | real | C1 (stand-in path: "a code task opens a PR, which is merged from the app") |
| 2.2 | Make a PR conflict with its base (merge another change to the same lines). | The Worker is told, merges the base in, resolves it and pushes. No rebase, no force-push. | real | C4 |
| 2.3 | Make CI fail on a PR. | The Worker gets the end of the failed log and pushes a fix, up to three times. | real | C2 |
| 2.4 | Comment on a PR line in GitHub. | The Worker applies the comment and reports. | real | C3 |
| 2.5 | Have two PRs ready at once. | "Merge 2" on the sidebar's heading puts both in the merge queue. The second takes the new base into its branch, waits for its checks and is merged; the queue shows at the top of the Worker list meanwhile. | e2e | `prs`: ""Merge N" merges every ready PR from the sidebar"; `mergeQueue`: "two PRs merge in order, the second on the base the first one left" |
| 2.6 | Ask for a change that spans two repositories. | The Dispatcher makes one task per repository with the same bundle. The inbox shows them in order, and "Merge 2 in order" merges them in that order. | real | C5 (merge order: "a bundle across repositories is merged in the order its tasks were made") |
| 2.7 | On the company GitHub host (Settings → General). | 1.1 and 2.1 work there too. | real | C6 |

### 3. Working while you are away

| # | Do | Expect | Tag | Where |
|---|---|---|---|---|
| 3.1 | Close the window while a Worker is running. | The app stays in the tray; a notification says so once. The Worker finishes. | win | B2 |
| 3.2 | Click the tray icon; open its menu. | The window comes back. The menu lists what is going on, with Open and Quit. Quit stops the app. | win | B3 |
| 3.3 | Turn on "Start when you sign in", sign out and in. | The app is in the tray without its window. | win | E1 |
| 3.4 | With the window closed, let a Worker ask for a permission. | The notification has Allow and Deny. Pressing one answers it without opening the window. | win | B4 |
| 3.5 | Leave a decision unanswered for more than 10 minutes with a task queued behind it. | The queued task starts. The waiting Worker's conversation notes that its slot went to the queue, and it goes on when answered. | e2e | `realuse`: "row 3.5: a decision unanswered for longer than the setting gives its slot to the queued task" |
| 3.6 | Come back to the window after a while. | The inbox shows "While you were away" with what finished, failed or merged. | e2e | `search`: "the palette finds a finished task, and coming back shows what happened" |
| 3.7 | Press Ctrl+Shift+Space in another app, type a request, press Enter. | The box says "Sent" and goes away. The request is in the chat and the Dispatcher acts on it. | win | D1 (the box itself: "the quick message box completes a repository name, …") |

### 4. Things that start by themselves

| # | Do | Expect | Tag | Where |
|---|---|---|---|---|
| 4.1 | Add a daily automation a minute or two ahead. | At that time the Dispatcher gets its text and acts on it. | e2e | `realuse`: "row 4.1: a daily automation added a minute or two ahead runs at its time" |
| 4.2 | Add an automation for merges, then merge a PR. | It fires once for that merge. | e2e | `prs`: "a merged PR fires the automation set for merges" |
| 4.3 | Ask in the chat for an automation ("every weekday at 9, check for outdated dependencies"). | It appears in the Automations tab. | real | B7 |

### 5. Looking at and undoing a Worker's work

| # | Do | Expect | Tag | Where |
|---|---|---|---|---|
| 5.1 | Open a Worker's Changes tab during a task. Comment on two lines and send. | The Worker gets one message with both comments and acts on them. | e2e | `realuse`: "row 5.1: two comments on lines in the Changes tab reach the Worker as one message" |
| 5.2 | After several messages to a Worker, open Checkpoints and go back to an earlier one. | The files are as they were then. The branch and its commits are untouched, and the Worker is told on its next message. | e2e | `realuse`: "row 5.2: going back to a checkpoint puts the files back, keeps the branch and tells the Worker" |
| 5.3 | Set a run command on the repository and start it from a Worker. | The output shows; a printed local address opens; Stop ends it. | e2e | `realuse`: "row 5.3: a run command starts from a Worker, shows its output, opens its address and stops" |
| 5.4 | Ask to compare ("try this with two models and let me pick"). | Two Workers on different models, neither with a PR. "Use this one" has that Worker open the PR. | real | B8 |

### 6. Jira

| # | Do | Expect | Tag | Where |
|---|---|---|---|---|
| 6.1 | Enter the site address, your email (Jira Cloud only) and an API token in Settings → General. | The Repositories view lists your open issues. Note here whether the site is Cloud or Data Center. | real | A2 |
| 6.2 | Enter a wrong token. | "Jira refused the sign-in." | real | A3 |
| 6.3 | Press "Assign" on an issue. | The Dispatcher gets the key, summary and description, and the PR title carries the key. | real | B6 |

### 7. Usage limits and accounts

| # | Do | Expect | Tag | Where |
|---|---|---|---|---|
| 7.1 | Watch the usage rings over a working day. | They match what the account's own usage page says. | real | F1 |
| 7.2 | Run until one account passes 80% of its five-hour window. | Work moves to the other account, with a line in the log and no interruption. | real | F2 |
| 7.3 | With a ChatGPT account registered, give a Worker a ChatGPT model. | It runs on Codex; permissions arrive as the same cards. | real | A4 |

### 8. Installing and updating

| # | Do | Expect | Tag | Where |
|---|---|---|---|---|
| 8.1 | Install the new build over the old one. | Settings, tasks and conversations are kept. | win | A1 |
| 8.2 | Publish a release (docs/RELEASING.md: push the tag, publish the draft), then start an older build. | Within a minute the gear has a dot, and Settings shows "Get <version>" linking to the release. | real | G1 |
| 8.3 | On a Mac: `npm run dist:mac`, install, and repeat 1.1, 3.1, 3.2, 3.4 and 3.7 (⌘⇧Space). | The same results. CI builds the app on macOS; it has never been used there. | mac | H1 |

### 9. What only eyes and ears can check

| # | Do | Expect | Tag | Where |
|---|---|---|---|---|
| 9.1 | Settings → Display → Appearance: Light, then System. Go through every view, a Worker's Changes tab and Settings. | Everything is readable, nothing is left dark on light or light on dark. The window frame and its caption buttons match. With System, changing the OS theme changes the app. | win | D5 (the setting itself: "the appearance follows the setting, …") |
| 9.2 | Set do-not-disturb hours that include now, and have a Worker ask for a permission. | No sound and no notification; the decision is in the inbox, the tray counts it, the taskbar flashes. | win | D2 |
| 9.3 | Have a Worker ask three things within a few seconds. | One sound and one notification, three cards. | win | D3 |
| 9.4 | Turn off "Notify when a task ends" and let a task finish with the window in the background. | No notification for it; a decision still notifies. | win | D4 |
| 9.5 | Remove a sign-in (`gh auth logout` on a test host) and start the app. | A red dot on the gear; Settings → General → Status lists the sign-in first with its command. Signing in and pressing refresh clears it. | e2e | `settings`: "Settings shows what is missing on this computer and the command that fixes it"; the refresh: `realuse`: "row 9.5: a missing sign-in puts a dot on the gear, and refreshing after signing in clears it" |
| 9.6 | Settings → General → Diagnostics → "Save report…", after a day of use. Read the file. | No token, no company host name, no email, no OS user name. Note here anything in it you would not want to pass on. | win | F3 (empty profile: "the diagnostics report describes the app and holds no secrets") |
| 9.7 | Drop two files on the quick message box and send. | The box shows "2 files"; the message in the chat carries both paths. | e2e | `realuse`: "row 9.7: two files dropped on the quick message box go to the chat with the message" |
| 9.8 | Restart the app while a task with an "Allow for this task" is still running. | The allowance is still listed under the task and still applies. | e2e | `realuse`: "row 9.8: an "Allow for this task" outlives a restart of the app, listed under the task and still applied" |
| 9.9 | Search the palette for something said weeks ago in the chat. | The chat opens at that message, marked for a moment. | e2e | `search`: "the palette finds something said and shows the chat from that message" |
| 9.10 | Use the app for a few minutes with a screen reader (Narrator, VoiceOver). | Controls are announced by sensible names, and a new decision is noticed. Note what is confusing. | win | D6 (VoiceOver goes with H1) |

### 10. Telegram

| # | Do | Expect | Tag | Where |
|---|---|---|---|---|
| 10.1 | Make a bot with @BotFather, paste its token in Settings → Notifications → Telegram, pair from the phone and press "Send test message". | "Connected" with your account's name; the test message arrives. The diagnostics report and the app log carry no token. | real | I1 |
| 10.2 | From the phone, ask the Dispatcher for a small task; reply to its result; send `/status`, `/inbox`, `/lock`. Have someone else write to the bot. | The request is in the chat marked as from Telegram; the answer and the result come back; the reply goes into that thread. `/lock` turns requests off until turned on in Settings. The stranger gets nothing. | real | I2 |
| 10.3 | With the window closed, let a Worker ask a question with options, send a plan and ask a permission. | The question and the plan come with buttons; a press answers them and the message shows the answer. The permission has no buttons and no command. A decision answered in the app loses its buttons on the phone. | real | I3 |
| 10.4 | Send a photo with a caption, an album of three photos, a PDF and an `.exe`. | One Dispatcher message for the photo and one for the album with its three files, saved under the app's data folder; the PDF too. The `.exe` is refused with a reply. | real | I4 |
| 10.5 | Sleep the computer for ten minutes with the link connected, wake it and write from the phone. Then quit the app, write, start it. | After waking the message arrives within a minute. The message written while the app was off waits and goes with "Send". | real | I5 |
| 10.6 | Start a second computer with the same token. Then `/revoke` the token at @BotFather. | One of them shows "In use elsewhere". After the revoke, "Token invalid"; a new token pairs again. | real | I6 |

## Steps

For every hands-on row: what to do, what to look at, and what counts as pass. "Test repository" is the github.com repository from [Before you start](#before-you-start).

### A. Install and sign in

**8.1 Install over the old build** (win)
1. With v0.6.2 installed and used (at least one finished task, one conversation, a changed setting such as the font size), quit it from the tray.
2. Run the new installer. Start the app.
- Look at: the Settings value you changed, the finished task in the sidebar, the chat history, the registered repositories and accounts.
- Pass: all of them are as before, Settings → General shows the new version, and no "state file set aside" message appears.

**6.1 Jira sign-in** (real)
1. Settings → General → Jira: enter the site address, your email (Cloud only) and the API token.
2. Open the Repositories view.
- Look at: the issue list.
- Pass: your open issues are listed with key and summary. Write Cloud or Data Center in the note.

**6.2 Wrong Jira token** (real)
1. Replace the token with a wrong one (change one character). Open the Repositories view.
- Pass: "Jira refused the sign-in." is shown and nothing else breaks. Put the right token back afterwards.

**7.3 A Worker on ChatGPT** (real)
1. Settings → Accounts: register the ChatGPT account (skip the row if there is none; note "no account").
2. In the chat ask: "Using a ChatGPT model, create notes/codex-check.md in the test repository with today's date, and run `npm -g ls` first."
- Look at: the Worker's model label, its conversation, the permission card for the global command.
- Pass: the Worker runs on Codex (its model is a ChatGPT one), the permission arrives as the usual card with Allow / Deny / "Allow for this task", and the task finishes with a result card.

### B. Real tasks, with the window away

**1.1 A real code task** (real)
1. In the chat: "In the test repository, add a line to README.md saying this repo is for throwaway PRs." Do not wait; go to 3.1 while it runs.
- Look at: the Workers list, the Worker's worktree folder (its path in the Worker header), the result card.
- Pass: a Worker appears, works in its own worktree (not the registered checkout), opens a PR on GitHub, and the result card links that PR.

**3.1 Close the window during work** (win) — while 1.1 runs
1. Close the window with its ✕.
- Look at: the tray (the notification area, also the ^ overflow), the notifications.
- Pass: the app icon stays in the tray, one notification says it keeps running, and 1.1 still finishes (seen in 3.2). Closing a second time does not notify again.

**3.2 Tray icon and menu** (win) — while 1.1 runs
1. Right-click the tray icon. Read the menu.
2. Left-click the tray icon.
3. At the end of block B only: tray menu → Quit, then start the app again.
- Pass: the menu lists what is running (the 1.1 Worker) and has Open and Quit; the click brings the window back; Quit ends the app (no process left in Task Manager).

**3.4 Allow from the notification** (win)
1. Ask: "In the test repository, run `npm -g ls` and write the output to notes/global.md."
2. Close the window at once.
- Look at: the Windows notification when the permission is asked.
- Pass: it has Allow and Deny buttons; pressing Allow lets the Worker go on without the window opening, and the inbox shows the decision as answered when you open it.

**1.2 Plan first** (real)
1. Ask: "Plan first: in the test repository, add a CONTRIBUTING.md with three short rules."
- Look at: the inbox.
- Pass: a plan card arrives with WHAT, HOW and OUTPUT lines and the work has not started; after Approve the Worker starts and opens a PR.

**6.3 Assign a Jira issue** (real)
1. Repositories view → the Jira issue → "Assign" (pick the test repository if asked).
- Look at: the Dispatcher's message in the chat, then the PR on GitHub.
- Pass: the Dispatcher's message carries the issue key, summary and description, and the PR title starts with or contains the key.

**4.3 Automation from the chat** (real)
1. Ask: "Every weekday at 9, check the test repository for outdated dependencies."
- Look at: Automations tab.
- Pass: a new automation with Monday–Friday 09:00 and that text. Delete it afterwards.

**5.4 Compare two models** (real)
1. Ask: "Try this with two models and let me pick: in the test repository, write a one-paragraph summary of README.md to notes/summary.md."
2. When both finish, open each, then press "Use this one" on one.
- Look at: the two Workers' model labels, GitHub's PR list.
- Pass: two Workers on different models, no PR until you pick; after "Use this one" only that Worker opens a PR.

### C. Pull requests on GitHub

**2.1 Merge from the app** (real) — the PR from 1.1
1. Wait for its CI to pass (approve it on GitHub if the repository needs a review).
2. Press "Merge" next to its badges and confirm.
- Look at: the confirmation, GitHub's merge method, the task state, the worktree folder, `git branch -a` in the registered checkout.
- Pass: one confirmation, the PR is merged with a method the repository allows (squash if that is all it allows), the task shows merged, its worktree folder and branch are gone locally and on GitHub.

**2.3 CI failure** (real)
1. Ask: "In the test repository, change <the file your failing-on-purpose test reads> so that it says FAIL." (pick a change that makes CI red).
- Look at: the Worker's conversation after CI fails, the PR's commits.
- Pass: the Worker gets a message with the end of the failed log, pushes a fix, and CI goes green; if it keeps failing, it stops after three tries and the task says so.

**2.4 A review comment** (real) — any open PR from this pass
1. On GitHub, comment on one changed line: "Use 'throwaway' instead of 'test' here."
- Pass: within a few minutes the Worker gets the comment, pushes a commit that applies it, and reports in its conversation.

**2.2 A conflict with the base** (real)
1. Ask for a change to README.md's first line; let it open a PR.
2. On GitHub, edit the same line on `main` directly and commit.
- Look at: the PR's mergeable state, the Worker's conversation, the PR's commits.
- Pass: the Worker is told about the conflict, adds a merge commit of `main` into its branch with the conflict resolved, and pushes. No rebase, no force-push (the history keeps its old commits).

**2.6 A bundle over two repositories** (real)
1. Ask: "In both test repositories, add a VERSION file containing 0.0.1; the second one's README should mention it."
2. When both PRs are ready, press "Merge 2 in order".
- Look at: the inbox, the tasks' bundle label, merge times on GitHub.
- Pass: two tasks with the same bundle, listed in order in the inbox; they merge in that order.

**2.7 The company host** (real)
1. Settings → General: set the company GitHub host, make sure `gh auth status --hostname <host>` is signed in.
2. Repeat 1.1 and 2.1 in the company repository.
- Pass: as 1.1 and 2.1. Skip and note if no throwaway PR is allowed there.

### D. Eyes and ears on Windows

**3.7 Quick message from another app** (win)
1. Focus another app (Notepad). Press Ctrl+Shift+Space.
2. Type "What is running right now?" and press Enter.
- Pass: the box appears over Notepad, says "Sent" and goes away; the message is in the chat and the Dispatcher answers it.

**9.2 Do-not-disturb hours** (win)
1. Settings → Notifications: set do-not-disturb from one hour ago to one hour ahead.
2. Minimize the window. Ask a Worker for something that needs a permission (as in 3.4).
- Look at and listen to: sound, notifications, the tray icon's count, the taskbar button.
- Pass: no sound and no notification; the decision is in the inbox, the tray icon counts it, the taskbar button flashes. Turn the hours off afterwards.

**9.3 Three asks at once** (win)
1. Minimize the window. Ask: "Run these three commands one after the other without waiting: `npm -g ls`, `npm -g outdated`, `npm config get prefix`."
- Pass: one sound and one notification for the burst; three cards in the inbox.

**9.4 Task-end notifications off** (win)
1. Settings → Notifications: turn off "Notify when a task ends".
2. Ask for a small non-code task, put the window behind another one, wait for it to finish. Then ask for one that needs a permission.
- Pass: no notification for the finish; the permission does notify. Turn the setting back on.

**9.1 Light and System appearance** (win)
1. Settings → Display → Appearance: Light. Visit Chat, Workers (a Worker's conversation and Changes tab), Inbox, Repositories, Automations, Settings (every section), the palette, the quick message box.
2. Appearance: System. Switch Windows between dark and light (Settings → Personalization → Colors).
- Look at: text and icons on every background, the window frame and its caption buttons, popovers and tooltips.
- Pass: everything readable, nothing dark on light or light on dark, the frame matches; with System the app follows the Windows switch at once. Note any screen that does not.

**9.10 Narrator** (win)
1. Start Narrator (Win+Ctrl+Enter). Tab through the main screen, the sidebar, a Worker, Settings.
2. Have a Worker ask for a permission while the window has focus.
- Pass: controls are announced by names that say what they do (no "button", no raw icon names), and the new decision is announced. Note what is confusing.

### E. Closing

**3.3 Start when you sign in** (win)
1. Settings → General: turn on "Start when you sign in".
2. Sign out of Windows and sign in again.
- Pass: the app icon is in the tray and no window opens. Turn the setting back off if you do not want it.

### F. Alongside a normal working day

**7.1 Usage rings** (real)
1. Use the app for real work through the day. Three times (morning, midday, evening) compare the rings with each account's own usage page (claude.ai → Settings → Usage).
- Pass: each ring is within a few percent of the page; note the three readings.

**7.2 Moving to the other account** (real)
1. With both accounts registered, keep working until one passes 80% of its five-hour window.
- Look at: the usage rings, the log, a Worker that is running at that moment.
- Pass: new work goes to the other account, a line in the log says so, and no running Worker is interrupted.

**9.6 Diagnostics report after a day** (win)
1. Settings → General → Diagnostics → "Save report…". Open the file in an editor.
2. Search it for: your email, your Windows user name, the company host name, `ghp_`, `gho_`, `sk-`, `token`.
- Pass: none of those found. Note anything else you would not pass on.

### G. With the release

**8.2 The update check** (real) — run when the next version (0.7.0) is actually released, not as a test release
1. Release it as docs/RELEASING.md says: push the tag `v<version>`, wait for the Release workflow, and publish the draft release it made.
2. Start the older build (0.6.2).
- Pass: within a minute the gear has a dot, and Settings shows "Get <version>" linking to that release.

### H. On a real Mac

**8.3 macOS** (mac)
1. On a Mac: `npm run dist:mac`, install the .dmg, open it (allow it in System Settings → Privacy & Security if blocked) and register the test repository and an account.
2. Repeat 1.1, 3.1 (the menu bar instead of the tray; closing the window keeps the app), 3.2 (menu bar icon), 3.4 and 3.7 with ⌘⇧Space.
3. Turn on VoiceOver (⌘F5) and repeat 9.10.
- Pass: the same results as on Windows. Note anything that differs, even when it works. Until this row has a result, no Mac check is on record.

### I. Telegram

**10.1 A real bot** (real)
1. In Telegram, @BotFather: `/newbot`, then `/setjoingroups` → the bot → Disable.
2. Settings → Notifications → Telegram: turn on Use, paste the token, open the bot link from the phone, press Connect on your account's name, press "Send test message".
3. Settings → General → Diagnostics → "Save report…"; search it and the log folder for the part of the token after the colon.
- Pass: "Connected", the test message on the phone, the token in neither.

**10.2 Chat both ways** (real)
1. From the phone: "add a line to the README of the test repository". Wait for the result on the phone and reply to it with "also fix the typo".
2. Send `/status`, `/inbox`, then `/lock`, then another request. Turn requests on again in Settings.
3. From another Telegram account, write to the bot.
- Pass: as 10.2 expects. Nothing from the second account shows in the app.

**10.3 Decisions on the phone** (real)
1. Close the window. Ask a Worker for a change "plan first", and another to ask you which of two names to use.
2. Press a button on each. Have a third question asked and answer it in the app.
3. Ask for something that needs a permission (a global install).
- Pass: as 10.3 expects. The buttons and the edited text read well on the phone.

**10.4 Photos and files** (real)
1. Send a photo with a caption ("what is on this screen?"), then three photos at once, then a PDF, then an `.exe`.
- Pass: as 10.4 expects. The files open from the chat; the photo is the full size, not a thumbnail.

**10.5 Sleep, and an app that was off** (real)
1. With the link connected, sleep the computer for ten minutes, wake it and write from the phone.
2. Quit the app (tray → Quit), write from the phone, start the app, press "Send" on the waiting message.
- Pass: as 10.5 expects.

**10.6 One token, two computers, and a revoke** (real)
1. On a second computer (or a second test profile), paste the same token.
2. At @BotFather, `/revoke` the token. Paste the new token in Settings and pair again.
- Pass: as 10.6 expects.
