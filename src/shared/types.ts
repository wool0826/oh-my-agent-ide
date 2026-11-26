// Data shapes shared by the main process and the renderer.

import type { SessionSpend, Spend } from './spend';
import type { UsageClock } from './usage';
import type { UpdateView } from './update';

export type Lang = 'en' | 'ko';

export type Effort = 'low' | 'medium' | 'high' | 'xhigh' | 'max';
export const EFFORTS: Effort[] = ['low', 'medium', 'high', 'xhigh', 'max'];

export type UsageWindow = { utilization: number | null; resetsAt: string | null };

export type AccountPlan = 'team' | 'enterprise';

/** Whose agents an account or a model belongs to: Claude Code, or Codex signed in with a ChatGPT account. */
export type Provider = 'claude' | 'chatgpt';

/** At most this many accounts can be registered. */
export const MAX_ACCOUNTS = 4;

export interface AccountView {
  id: string;
  label: string;
  /** token: stored OAuth token, login: this PC's existing Claude Code login */
  kind: 'token' | 'login';
  plan: AccountPlan;
  provider: Provider;
  /** ChatGPT: the plan Codex reports (free, plus, pro, ...). */
  planLabel?: string | null;
  /**
   * ChatGPT: how long the windows in `fiveHour` and `sevenDay` really are, in minutes (a plan has one or two windows,
   * and not of those lengths). Unset for Claude accounts, whose windows are 5 hours and 7 days.
   */
  windowMins?: [number | null, number | null] | null;
  fiveHour: UsageWindow;
  sevenDay: UsageWindow;
  usageUpdatedAt: string | null;
  /** endpoint: the usage endpoint; probe: the headers of a one-token request (a token the endpoint refuses); events: its sessions. */
  usageSource: 'endpoint' | 'probe' | 'events' | null;
  /** The server asked the app to wait before reading usage again (429), until then. */
  usageBackoffUntil: string | null;
  /** A usage limit rejected the account. */
  limited: boolean;
  /** When that limit resets, while it holds. */
  limitedUntil: string | null;
  lastError: string | null;
}

export interface Repo {
  name: string;
  url: string;
  path: string;
  description: string;
  defaultBranch: string;
  addedAt: string;
  /** A local folder with no `origin` remote: Workers branch from the local default branch, and nothing is pushed or opened as a PR. */
  local?: boolean;
  /** Shell command run in each new worktree (install dependencies, copy .env, ...). */
  setup?: string;
  /** Shell command that runs the project (a dev server, the app), started in a Worker's worktree on request. */
  run?: string;
}

export type WorkerStatus = 'starting' | 'running' | 'waiting' | 'idle' | 'error' | 'archived';

export interface Worker {
  id: string;
  title: string;
  model: string;
  accountId: string | null;
  sessionId: string | null;
  cwd: string;
  repo: string | null;
  status: WorkerStatus;
  statusText: string;
  contextTokens: number;
  taskIds: string[];
  createdAt: string;
  lastActiveAt: string;
  knowledge: string;
  /** Running totals of its current session, to turn Claude Code's cumulative figures into per-turn ones. */
  sessionSpend?: SessionSpend | null;
  /** A question from the Dispatcher (ask_worker) that this Worker has not answered yet. */
  ask?: OpenNote | null;
  /** What this Worker asked the Dispatcher for (tell_dispatcher request, or a BLOCKED report), not answered yet. */
  request?: OpenNote | null;
  /** Its task is open but nothing has run it for a while, even after a reminder (shared/stall.ts). Cleared by its next turn. */
  stalledAt?: string | null;
}

/** One step of a task's plan, as its Worker declared it; doneAt is set once the Worker reports it finished. */
export interface TaskStep {
  title: string;
  doneAt: string | null;
}

/** A question or request between the Dispatcher and a Worker that still waits for its answer. */
export interface OpenNote {
  text: string;
  at: string;
}

/** blocked: waiting for another task's PR to merge (afterTaskId). */
export type TaskStatus = 'blocked' | 'queued' | 'running' | 'waiting' | 'pr_open' | 'done' | 'failed' | 'cancelled';

export interface Task {
  id: string;
  title: string;
  prompt: string;
  kind: 'code' | 'other';
  repo: string | null;
  workerId: string | null;
  status: TaskStatus;
  branch: string | null;
  prUrl: string | null;
  prState: 'OPEN' | 'MERGED' | 'CLOSED' | null;
  summary: string | null;
  files: string[];
  /** URLs the final report named besides its PR (published artifacts, other PRs), as "url" or "[title](url)". Unset on tasks saved before this existed. */
  links?: string[];
  createdAt: string;
  updatedAt: string;
  /** When the task message reached the Worker. Null while a usage limit has kept it from starting; unset on tasks saved before this existed. */
  startedAt?: string | null;
  finishedAt: string | null;
  reviewSyncedAt: string | null;
  seenCommentIds: string[];
  /** Start this task only after that task's PR is merged. */
  afterTaskId?: string | null;
  /** Why a queued task waits: every Worker slot is taken (slot) or a usage limit holds every account (limit, or unset). */
  queueReason?: 'slot' | 'limit' | null;
  /** When it entered the queue (queued or blocked); cleared when it leaves. Set by stampQueued (shared/queue.ts). */
  queuedSince?: string | null;
  /** The steps its Worker planned and which are done (shared/steps.ts). Unset or null: the Worker gave none. */
  steps?: TaskStep[] | null;
  /** When the task began waiting for an answer, and whether it has since given its slot back (shared/slots.ts). */
  waitingSince?: string | null;
  slotReleased?: boolean;
  /** Effort the Dispatcher chose for this task; null = the Worker default. */
  effort?: Effort | null;
  mergedAt?: string | null;
  /** The Worker plans in read-only mode first; the user approves the plan in the decision inbox. */
  planFirst?: boolean;
  planApproved?: boolean;
  /** What the task's turns cost (API-equivalent estimate) and their tokens, summed over every turn. */
  spend?: Spend;
  /** Merge readiness of the open PR, from the PR monitor. */
  prChecks?: PrChecks | null;
  /** CI runs (GitHub Actions run IDs, or external checks) whose failure was already handled. */
  seenCiRuns?: string[];
  /** The head and base commits of the conflict last handed to the Worker, so one conflict is sent once. */
  conflictSeen?: string;
  /** Times the Worker was sent failed CI checks to fix. */
  ciFixAttempts?: number;
  /** Times the Worker was sent failed CI checks in all: ciFixAttempts starts over when the user says to keep fixing. Unset on tasks saved before this existed. */
  ciFixTotal?: number;
  /** Who a waiting task waits for, when it is the Dispatcher rather than the user. */
  waitingOn?: 'dispatcher' | null;
  /** Each status the task went through, oldest first (shared/retro.ts). Unset on tasks made before this existed. */
  history?: TaskMark[];
  /** The permissions asked for during the task, and the actions an allow-for-this-task rule let through (shared/retro.ts). */
  permissions?: PermissionMark[];
  /** Kinds of action the user allowed for the length of this task (shared/grants.ts). */
  grants?: { key: string; label: string }[];
  /** The request this task is one part of, when it spans several repositories (shared/bundle.ts). */
  bundle?: string | null;
  /** One of two attempts at the same task (shared/compare.ts): its group, and the attempt the user picked once they did. */
  compare?: { group: string; picked?: string | null };
  /** It failed because the user pressed Stop, not because of an error. Shown as stopped, not in red. */
  stopped?: boolean;
  /** Files its branch changes against the base, from git in its worktree, refreshed when its Worker's turn ends (code tasks). */
  changedFiles?: string[] | null;
  /** Tasks in progress that already changed files its prompt names, found when it was created (shared/overlap.ts). */
  overlaps?: TaskOverlap[] | null;
}

/** A task in progress whose branch already changes files a new task's prompt names. */
export interface TaskOverlap {
  taskId: string;
  files: string[];
}

/** Where a PR is in the merge queue (shared/mergeQueue.ts): in line, taking the base, waiting for its checks, being merged. */
export type MergeQueuePhase = 'waiting' | 'updating' | 'checks' | 'merging';

/** Why a PR left the merge queue without being merged. */
export type MergeQueueLeft = 'ciFailed' | 'conflict' | 'changes' | 'review' | 'worker' | 'timeout' | 'baseMoved' | 'updateFailed' | 'mergeFailed' | 'bundle';

/** One PR in the merge queue, or one that left it and still says why. */
export interface MergeQueueEntry {
  taskId: string;
  prUrl: string;
  /** Its bundle (shared/bundle.ts): the PRs of one bundle merge in the order their tasks were made, and stop together. */
  group?: string | null;
  phase: MergeQueuePhase;
  /** When the phase began, which its time limits count from. */
  since: string;
  /** The head commit before the base was last taken into the branch: checks on it no longer count. */
  updatedFrom?: string | null;
  /** Times the base was taken into the branch. */
  updates?: number;
  /** The PR had checks before the base was taken, so the new head is not merged before its own appear. */
  expectChecks?: boolean;
  /** Those checks by name: the new head is not merged on the first of them alone while the others have yet to start. */
  expectNames?: string[];
  /** Times in a row GitHub refused to take the base in for a reason other than a conflict. */
  fails?: number;
  left?: { why: MergeQueueLeft; at: string; detail?: string } | null;
}

/** A status a task entered, and when. on: a waiting task waits for the Dispatcher, not the user. */
export interface TaskMark {
  status: TaskStatus;
  at: string;
  on?: 'dispatcher';
}

/** A permission asked for during a task: the action, when it was asked and answered, and the answer (ALLOW, ALLOW_TASK, DENY or the user's note), or GRANT_USED with no answer time for an action a rule let through. */
export interface PermissionMark {
  at: string;
  answeredAt: string | null;
  code: string;
  answer: string;
}

/** Is the open PR ready to merge: CI, conflicts and review. */
export interface PrChecks {
  /** none: the PR has no checks. failing wins over pending. */
  ci: 'passing' | 'failing' | 'pending' | 'none';
  /** Names of the failed checks. */
  failed: string[];
  conflicts: boolean;
  /** GitHub's review decision; null when the branch needs no review. */
  review: 'approved' | 'changes' | 'required' | null;
}

export interface DecisionOption { label: string; description?: string }

export interface Decision {
  id: string;
  source: 'permission' | 'question' | 'dispatcher' | 'plan';
  workerId: string | null;
  taskId: string | null;
  title: string;
  detail: string;
  code: string | null;
  options: DecisionOption[];
  /** question: the AskUserQuestion text, used as the key when answering */
  questionKey: string | null;
  status: 'pending' | 'answered';
  answer: string | null;
  createdAt: string;
  answeredAt: string | null;
  /** plan: the plan's WHAT / HOW / OUTPUT lines, shown on the card above the collapsed plan. */
  summary?: PlanSummary | null;
  /** Why the user is asked (src/shared/askWhy.ts). The card, the sidebar row and the OS notification all show it. Unset on older decisions. */
  reason?: DecisionReason | null;
  /**
   * permission: what the action is for, in one line: the task's current plan step and the Worker's last words before
   * asking (askWhy.ts permissionPurpose). Unset when neither is known, and the card then shows no line for it.
   */
  purpose?: string | null;
  /** The card's one-line fields (src/shared/brief.ts), set when it is asked; older decisions get them from the fields above. */
  brief?: DecisionBrief | null;
  /** ci: the PR monitor asks whether to keep fixing CI. It is kept over a restart and waited for again. */
  kind?: 'ci';
}

/** Why a decision needs the user, in one or two short sentences. */
export interface DecisionReason {
  /** What is asked: who, which task, which action. */
  what: string;
  /** Why it is not decided without the user, and what it risks or affects. */
  why: string;
}

/** A risk class a permission card shows as a badge: from the command itself, or an always-ask rule (with its label). */
export type RiskTag = 'read' | 'write' | 'network' | 'delete' | 'rule' | 'unknown';

/** One line each, at most BRIEF_MAX characters (src/shared/brief.ts); an empty one is not shown. */
export interface DecisionBrief {
  what: string;
  why: string;
  risk: string;
  /** What comes of it: a plan's OUTPUT, the Dispatcher's outcome. */
  out?: string;
  /** permission: risk badges in order, strongest first. */
  tags?: { kind: RiskTag; label?: string }[];
}

/** Three one-sentence lines at the top of a plan-first plan (src/shared/plan.ts). */
export interface PlanSummary {
  what: string;
  how: string;
  output: string;
  /** An optional RISK line: what could go wrong or is hard to undo. */
  risk?: string;
  /** The Worker left the lines out even when asked; these were pulled from the plan text. */
  auto?: boolean;
}

/** Answer values for permission decisions. The renderer shows localized labels. */
export const ALLOW = 'allow';
export const DENY = 'deny';
/** Allow, and do not ask again for the same kind of action until this task ends (shared/grants.ts). */
export const ALLOW_TASK = 'allow-task';
/** A PermissionMark for an action an allow-for-this-task rule let through without asking. */
export const GRANT_USED = 'grant-used';

export interface AutoAnswer {
  id: string;
  workerId: string;
  question: string;
  answer: string;
  basis: string;
  createdAt: string;
  corrected: { answer: string; scope: 'once' | 'preference'; at: string } | null;
  cleared: boolean;
}

/** A fact worth remembering, drawn from a decision answer or a correction, waiting for the user's OK. */
export interface MemorySuggestion {
  id: string;
  /** One card per key: the task id, or the decision id when there is no task. */
  key: string;
  taskId: string | null;
  workerId: string | null;
  repo: string | null;
  scope: 'preference' | 'repo';
  text: string;
  /** Why it is worth keeping, in the UI language. */
  reason: string;
  /** Saved with the fact: task, Worker and the decision or correction it came from. */
  source: string;
  status: 'pending' | 'saved' | 'dismissed';
  createdAt: string;
}

export type ChatKind ='user' | 'dispatcher' | 'event' | 'result' | 'auto' | 'decision' | 'error' | 'shell';

/**
 * A line the user ran from the chat with "!" (main/shell.ts): where, how it ended, and the end of its output.
 * `sent`: the hand-over to the Dispatcher. 'wait' while it runs, 'queued' once it ended and waits for the
 * Dispatcher's next turn, 'sent' when a turn took it, 'off' when it was stopped (a stopped run is not sent).
 */
export interface ShellRun {
  cmd: string;
  /** Where it ran: a repository's name, or '' for the IDE home. */
  repo: string;
  running: boolean;
  stopped: boolean;
  code: number | null;
  startedAt: string;
  ms: number;
  /** The last SHELL_KEEP lines of the output. */
  out: string;
  /** Lines of output in all. */
  lines: number;
  /** The lines of `out` that came from stderr, by their index in it (shared/shell.ts errRows). */
  err?: number[];
  sent: 'wait' | 'queued' | 'sent' | 'off';
  /** The saved script's name, when it was one (shared/scripts.ts). */
  script?: string;
  /** When it ends, the Dispatcher takes a turn for its result (Settings shellAsk when it started); else it goes with the next message. */
  ask?: boolean;
}

export interface ChatItem {
  id: string;
  ts: string;
  kind: ChatKind;
  text: string;
  /** result card: task id, auto: auto-answer id */
  ref?: string;
  /** The thread this message is a reply in: its root's chat id, or a task id for that task's report (shared/thread.ts). */
  replyTo?: string;
  /** kind 'shell': the run. */
  shell?: ShellRun;
  /** 'handout': a Worker made or a task handed out (ref: the task), folded with its neighbours (shared/handouts.ts). */
  sub?: 'handout';
  cleared?: boolean;
}

export interface WorkerLogItem {
  ts: string;
  from: 'dispatcher' | 'worker' | 'user' | 'event' | 'auto';
  text: string;
  /** The task a set_steps or step_done event wrote to. */
  task?: string;
}

/** A page of a Worker's log: `items` are lines `start` to `start + items.length` of its `total` (decision 85). */
export interface LogPage { items: WorkerLogItem[]; start: number; total: number }

export type SoundName = 'chime' | 'bell' | 'ping' | 'soft' | 'none' | 'custom';

export interface SettingsView {
  language: Lang;
  home: string;
  githubHost: string;
  /** OS notification when a decision is needed */
  notifications: boolean;
  /** OS notification when a task ends, a PR is merged or closed, or a release is out; separate from `notifications`. */
  notifyDone: boolean;
  /** Do-not-disturb hours as "HH:MM"; both empty = off. No sound and no OS notification inside them. */
  quietFrom: string;
  quietTo: string;
  sound: SoundName;
  /** The sound when a task ends (shared/sounds.ts, DONE_SOUNDS); 'none' is silent. Same volume as `sound`. */
  doneSound: SoundName;
  soundVolume: number;
  customSound: string;
  archiveDays: number;
  memoryRemote: string;
  dispatcherModel: string;
  workerModel: string;
  designModel: string;
  dispatcherEffort: Effort;
  workerEffort: Effort;
  /** Let the Dispatcher pick a different effort per task. */
  effortPerTask: boolean;
  /** Code tasks have a reviewer subagent check the diff before the PR opens (small changes skip it). */
  selfReview: boolean;
  /** Workers running at once (1–8). More tasks wait in the queue for a free slot. */
  maxWorkers: number;
  /** Minutes a Worker waiting for an answer keeps its slot; 0 = for as long as it waits. */
  waitSlotMinutes: number;
  /** Minutes between rounds of reading usage (shared/usage USAGE_INTERVALS); 0 = only by hand. */
  usageRefreshMins: number;
  /** Always-ask rules the user switched off (keys of shared/grants.ts ASK_RULES). */
  askOff: string[];
  /** Look for a newer release on GitHub. */
  updateCheck: boolean;
  /** System-wide shortcut for the quick message box, in Electron's spelling; empty = off. */
  quickKey: string;
  /** Jira site address, and the account's email (Jira Cloud; empty for a Data Center personal access token). */
  jiraUrl: string;
  jiraEmail: string;
  /** A Jira token is stored. The token itself never leaves the main process. */
  jiraTokenSet: boolean;
  /** UI font. Empty = system font. Several can be listed, separated by commas. */
  fontFamily: string;
  /** Base text size (px). Other sizes scale with it. */
  fontSize: number;
  /** Appearance: dark, light, or the system's (shared/theme.ts). */
  theme: 'dark' | 'light' | 'system';
  /** Give agents the user's Claude Code rules (~/.claude/CLAUDE.md, rules/*.md). */
  claudeRules: boolean;
  /** Workers read and write the Claude Code memory of their repository's checkout. */
  claudeMemory: boolean;
  /** claude.ai connectors (Claude Docs) and the Artifact tool in the Dispatcher's and Workers' Claude sessions. */
  claudeConnectors: boolean;
  /** With the connectors on: sessions may reply to comments on their artifacts without asking (ArtifactComments). */
  artifactAutoReply: boolean;
  /** Offer to remember reusable facts from decision answers and corrections. */
  memorySuggest: boolean;
  /** A "!" run or a saved script the user ran hands its result to the Dispatcher, which takes a turn for it. */
  shellAsk: boolean;
  /** "!" lines, saved scripts and the side terminal run in an interactive shell with the user's rc files or PowerShell profile (shared/shell.ts shellArgs). */
  shellProfile: boolean;
  /** Closing the window leaves the app working, with an icon in the tray. */
  background: boolean;
  /** Start with the window hidden when the user signs in to the OS. */
  openAtLogin: boolean;
  /** The computer does not sleep while a Worker works or the Dispatcher is in a turn (shared/awake.ts). */
  keepAwake: boolean;
}

/** What Settings shows about the user's Claude Code setup. */
export interface ClaudeInfo { home: string; rules: string[]; memoryHome: string }

/** A model the account can use, from the API's model list. */
export interface ModelInfo { id: string; name: string; created: string; provider?: Provider }
/** The model list and when it was last read; error is the last failed refresh, if any. */
export interface ModelList { models: ModelInfo[]; fetchedAt: string | null; error: string | null }

/** What sets an automation off: a time every day (local, "HH:MM"; on weekdays only if asked), or a PR being merged. */
export type AutoTrigger = { kind: 'daily'; time: string; weekdays: boolean } | { kind: 'merged' };

/** Work the Dispatcher is handed by itself (shared/automations.ts). */
export interface Automation {
  id: string;
  title: string;
  /** What the Dispatcher is asked to do. */
  prompt: string;
  trigger: AutoTrigger;
  enabled: boolean;
  lastRunAt: string | null;
  /** The chat message the last run handed the Dispatcher, so "Last run" can show it. */
  lastRunChatId?: string;
  /** When a daily one runs next; null for an event trigger. */
  nextRunAt: string | null;
  createdAt: string;
}

/** A repository's run command going in a Worker's worktree, or its last output once it ended. */
export interface RunView {
  workerId: string;
  running: boolean;
  /** The user stopped it; its exit code then says nothing. */
  stopped?: boolean;
  /** Exit code once it ended. */
  code: number | null;
  /** The end of its output. */
  tail: string;
  /** The first local address it printed, to open in a browser. */
  url: string | null;
  startedAt: string;
}

export interface AppState {
  ready: boolean;
  /** A repository being added, with git's last progress line (src/main/repos.ts). */
  repoAdding?: { name: string; progress: string } | null;
  /** How many of the launch checks failed (shared/preflight.ts); 0 before they have run. */
  preflightFailed?: number;
  /** Fake agent mode is on: every agent follows a script, and the window says so. */
  fake?: boolean;
  /** The newer version and how far it is (null with the update setting off). */
  update?: UpdateView | null;
  setupNeeded: boolean;
  settings: SettingsView;
  accounts: AccountView[];
  /** The rounds of reading usage: the last, the next, and whether one runs now. */
  usageClock: UsageClock;
  repos: Repo[];
  workers: Worker[];
  tasks: Task[];
  /** Each Worker's open task as main sees it (shared/currentTask.ts), for the Workers that have one. */
  openTasks?: Record<string, string>;
  /** The merge queue, in order, with the PRs that left it (shared/mergeQueue.ts). */
  mergeQueue: MergeQueueEntry[];
  decisions: Decision[];
  autoAnswers: AutoAnswer[];
  /** Pending only. */
  memorySuggestions: MemorySuggestion[];
  /** The last CHAT_SNAPSHOT (shared/paging) chat items; older ones come from `chat:page`. */
  chat: ChatItem[];
  /** Task outcomes not cleared from the inspector (results, and errors of a task), oldest first. */
  results: ChatItem[];
  /** The user's memos, shown in the right sidebar's Memos tab. */
  memos: Memo[];
  automations: Automation[];
  /** Saved shell scripts, shown in the right sidebar's Scripts tab. */
  scripts: ShellScript[];
  /** Run commands started in this session of the app. */
  runs: RunView[];
  /** The IDE memory's sync with its remote repository. */
  memorySync: MemorySync;
  dispatcher: { busy: boolean; contextTokens: number; accountId: string | null; statusText: string; spend: Spend | null; busySince?: string | null };
}

export interface DiffFile { path: string; added: number; removed: number; status: 'A' | 'M' | 'D' | 'R' | '?'; patch: string }
export interface DiffView { base: string; branch: string; files: DiffFile[]; truncated: boolean; error?: string }

/** A note the user keeps in the app. A shared one is also given to the Dispatcher with its system prompt. */
/** A shell command or script the user keeps and runs with a click (shared/scripts.ts). */
export interface ShellScript {
  id: string;
  name: string;
  /** One or more lines, run as one "!" line is. */
  cmd: string;
  /** Where it runs: a repository's name, or '' for the IDE home. */
  repo: string;
  createdAt: string;
  updatedAt: string;
  lastRunAt: string | null;
}

export interface Memo {
  id: string;
  text: string;
  shared: boolean;
  createdAt: string;
  updatedAt: string;
}

/** How the last sync of IDE memory with its remote went. */
export interface MemorySync {
  /** A remote repository is set. */
  remote: boolean;
  state: 'off' | 'syncing' | 'ok' | 'error';
  /** When the last sync ended. */
  at: string | null;
  /** One line from git, when it failed. */
  error: string | null;
  /** Commits merged in from the remote and sent to it by the last sync. */
  pulled: number;
  pushed: number;
  /** Commits here that the remote still lacks. */
  pending: number;
}

export interface MemoryFile { path: string; title: string; kind: 'preference' | 'repo' | 'decision' | 'task' | 'other'; size: number; updatedAt: string }
export interface MemoryHit { path: string; line: number; text: string; score: number }
/** A page of memory search hits, best first, out of `total`. */
export interface MemoryHits { hits: MemoryHit[]; total: number }
