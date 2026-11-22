# Real-use checklist

What the automated tests cannot reach, to be run by hand on the installed app with real accounts. The end-to-end tests (`npm run e2e`, decision 128) cover the app's own flows with fake agents; everything here needs a real model, a real GitHub or Jira, the operating system, or a person.

How to use it: install the current build, work through a section, and write the result in its table: `ok`, or what happened instead. A row that fails becomes an issue or a message to the Dispatcher. Nothing here has been run yet unless its row says so.

Before starting: one repository you can open throwaway PRs in, registered in the app, and at least one account.

## 1. A real task from start to finish

| # | Do | Expect | Result |
|---|---|---|---|
| 1.1 | Ask for a small code change in the test repository. | A Worker is created, works in its own worktree, and opens a PR. The result card links the PR. | |
| 1.2 | Ask "plan first" for another change. | A plan arrives in the inbox with its WHAT / HOW / OUTPUT lines. Approving it starts the work. | |
| 1.3 | Ask for something that needs a command outside the worktree (for example a global install). | A permission card with "Allow for this task". After choosing it, the same kind of command does not ask again in that task. | |
| 1.4 | Ask a Worker to force-push its branch. | The card names the always-ask rule and has no "Allow for this task". | |
| 1.5 | Ask a non-code question ("summarize this file into notes"). | A result card with the file; clicking it opens the file. | |

## 2. Pull requests on real GitHub

| # | Do | Expect | Result |
|---|---|---|---|
| 2.1 | Let a PR's CI pass and approve it (or use a repository without required review). | "Merge" appears next to its badges. It asks once, merges the way the repository allows, and the task shows merged. The worktree and branch are removed. | |
| 2.2 | Make a PR conflict with its base (merge another change to the same lines). | The Worker is told, merges the base in, resolves it and pushes. No rebase, no force-push. | |
| 2.3 | Make CI fail on a PR. | The Worker gets the end of the failed log and pushes a fix, up to three times. | |
| 2.4 | Comment on a PR line in GitHub. | The Worker applies the comment and reports. | |
| 2.5 | Have two PRs ready at once. | "Merge 2" on the sidebar's heading merges both, one after the other. | |
| 2.6 | Ask for a change that spans two repositories. | The Dispatcher makes one task per repository with the same bundle. The inbox shows them in order, and "Merge 2 in order" merges them in that order. | |
| 2.7 | On the company GitHub host (Settings → General). | 1.1 and 2.1 work there too. | |

## 3. Working while you are away

| # | Do | Expect | Result |
|---|---|---|---|
| 3.1 | Close the window while a Worker is running. | The app stays in the tray; a notification says so once. The Worker finishes. | |
| 3.2 | Click the tray icon; open its menu. | The window comes back. The menu lists what is going on, with Open and Quit. Quit stops the app. | |
| 3.3 | Turn on "Start when you sign in", sign out and in. | The app is in the tray without its window. | |
| 3.4 | With the window closed, let a Worker ask for a permission. | The notification has Allow and Deny. Pressing one answers it without opening the window. | |
| 3.5 | Leave a decision unanswered for more than 10 minutes with a task queued behind it. | The queued task starts. The waiting Worker's conversation notes that its slot went to the queue, and it goes on when answered. | |
| 3.6 | Come back to the window after a while. | The inbox shows "While you were away" with what finished, failed or merged. | |
| 3.7 | Press Ctrl+Shift+Space in another app, type a request, press Enter. | The box says "Sent" and goes away. The request is in the chat and the Dispatcher acts on it. | |

## 4. Things that start by themselves

| # | Do | Expect | Result |
|---|---|---|---|
| 4.1 | Add a daily automation a minute or two ahead. | At that time the Dispatcher gets its text and acts on it. | |
| 4.2 | Add an automation for merges, then merge a PR. | It fires once for that merge. | |
| 4.3 | Ask in the chat for an automation ("every weekday at 9, check for outdated dependencies"). | It appears in the Automations tab. | |

## 5. Looking at and undoing a Worker's work

| # | Do | Expect | Result |
|---|---|---|---|
| 5.1 | Open a Worker's Changes tab during a task. Comment on two lines and send. | The Worker gets one message with both comments and acts on them. | |
| 5.2 | After several messages to a Worker, open Checkpoints and go back to an earlier one. | The files are as they were then. The branch and its commits are untouched, and the Worker is told on its next message. | |
| 5.3 | Set a run command on the repository and start it from a Worker. | The output shows; a printed local address opens; Stop ends it. | |
| 5.4 | Ask to compare ("try this with two models and let me pick"). | Two Workers on different models, neither with a PR. "Use this one" has that Worker open the PR. | |

## 6. Jira

| # | Do | Expect | Result |
|---|---|---|---|
| 6.1 | Enter the site address, your email (Jira Cloud only) and an API token in Settings → General. | The Repositories view lists your open issues. Note here whether the site is Cloud or Data Center. | |
| 6.2 | Enter a wrong token. | "Jira refused the sign-in." | |
| 6.3 | Press "Assign" on an issue. | The Dispatcher gets the key, summary and description, and the PR title carries the key. | |

## 7. Usage limits and accounts

| # | Do | Expect | Result |
|---|---|---|---|
| 7.1 | Watch the usage rings over a working day. | They match what the account's own usage page says. | |
| 7.2 | Run until one account passes 80% of its five-hour window. | Work moves to the other account, with a line in the log and no interruption. | |
| 7.3 | With a ChatGPT account registered, give a Worker a ChatGPT model. | It runs on Codex; permissions arrive as the same cards. | |

## 8. Installing and updating

| # | Do | Expect | Result |
|---|---|---|---|
| 8.1 | Install the new build over the old one. | Settings, tasks and conversations are kept. | |
| 8.2 | Publish a release with `npm run release`, then start an older build. | Within a minute the gear has a dot, and Settings shows "Get <version>" linking to the release. | |
| 8.3 | On a Mac: `npm run dist:mac`, install, and repeat 1.1, 3.1, 3.2, 3.4 and 3.7 (⌘⇧Space). | The same results. CI builds the app on macOS; it has never been used there. | |
