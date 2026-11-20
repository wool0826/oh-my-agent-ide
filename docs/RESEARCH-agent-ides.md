# Other agent IDEs: what to borrow

Survey of agent-first coding tools as of November 2026, and what Oh My Agent IDE takes from them.
Sources are mostly vendor changelogs, forums and third-party write-ups; check details against current docs.

## Landscape

| Tool | Shape | Ideas worth noting |
|---|---|---|
| Cursor 2–3 | Editor + Agents Window | Up to 8 parallel agents, each in a git worktree or cloud sandbox. Plan Mode (Shift+Tab): plan with one model, build with another; several plans in parallel; "send tasks to new agents". Compares parallel runs and recommends the best. Per-change accept/reject in the editor. |
| Windsurf / Devin Desktop | Editor + local and cloud agents | Parallel sessions with worktrees; Devin-style playbooks and session insights. |
| OpenAI Codex app | Agent manager | Worktree per thread, review pane with inline comments on the diff, sub-agents with structured messaging, scheduled automations, skills. |
| Conductor (Melty Labs) | Orchestrator, not an editor | Runs Claude Code / Codex agents side by side, one worktree each. Per-repo setup and run scripts, diff review before PR, checkpoints. |
| Kiro (AWS) | Spec-driven IDE | requirements.md → design.md → tasks.md before code, with review checkpoints. Steering files (persistent project context). Hooks: shell command or agent prompt on IDE events (save, create). |
| Google Antigravity | Agent manager + editor + browser | Agents produce artifacts (task list, implementation plan, walkthrough, screenshots, browser recordings) that the user comments on instead of reading raw logs. |
| Zed, Augment Intent | Editor / coordinator | Parallel agents; a coordinator agent splits work for implementors in worktrees (closest to our Dispatcher). |
| Claude Code desktop | Sessions + panes | Plan mode with approval, diff pane, tasks, routines (scheduled agents). |

## Where we already are

Dispatcher → Workers in per-Worker worktrees, a single decision inbox, auto-answers from memory,
PR monitoring with review-comment follow-ups, tasks that wait for a merge, account failover.
That covers the "parallel agents + coordinator" core that most of these tools converged on.

## Adopted in this round

1. **Plan-first tasks** (Cursor Plan Mode, Kiro specs, Antigravity implementation plans).
   The Dispatcher can mark a task `plan_first`. The Worker starts in plan mode (read-only), and its plan
   lands in the decision inbox. Approve to let it build; type feedback to have it revise.
2. **Changes view** (Codex review pane, Conductor diff review, Cursor accept/reject).
   The Worker conversation has a Changes tab: files changed on the Worker's branch against the default
   branch, committed or not, with the diff. Review before the PR exists, or without opening GitHub.
3. **Setup command per repository** (Conductor setup scripts, Codex environments).
   A shell command run in each new worktree (for example `npm ci`, copying `.env`), so Workers start
   from a ready checkout instead of each one rediscovering how.

## Backlog (not built yet)

- **Best-of-N**: run one task on two Workers and compare. Costs double the usage; useful for design spikes.
- **Hooks / automations**: run a command or prompt on events (task finished, PR merged) or on a schedule.
- **Artifacts with comments**: comment on a specific line of a plan or diff and send it to the Worker.
- **Checkpoints**: restore a Worker's worktree to an earlier turn.
- **Run script**: start the app from a Worker's worktree to try a change locally.
- **Usage per task**: tokens spent per task, to see what work is expensive.
