// Data shapes shared by the main process and the renderer.

import type { SessionSpend, Spend } from './spend';

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
  usageSource: 'endpoint' | 'events' | null;
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
  /** Kinds of action the user allowed for the length of this task (shared/grants.ts). */
  grants?: { key: string; label: string }[];
  /** The request this task is one part of, when it spans several repositories (shared/bundle.ts). */
  bundle?: string | null;
  /** One of two attempts at the same task (shared/compare.ts): its group, and the attempt the user picked once they did. */
  compare?: { group: string; picked?: string | null };
  /** It failed because the user pressed Stop, not because of an error. Shown as stopped, not in red. */
  stopped?: boolean;
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

/** Three one-sentence lines at the top of a plan-first plan (src/shared/plan.ts). */
export interface PlanSummary {
  what: string;
  how: string;
  output: string;
  /** The Worker left the lines out even when asked; these were pulled from the plan text. */
  auto?: boolean;
}

/** Answer values for permission decisions. The renderer shows localized labels. */
export const ALLOW = 'allow';
export const DENY = 'deny';
/** Allow, and do not ask again for the same kind of action until this task ends (shared/grants.ts). */
export const ALLOW_TASK = 'allow-task';

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

export type ChatKind ='user' | 'dispatcher' | 'event' | 'result' | 'auto' | 'decision' | 'error';

export interface ChatItem {
  id: string;
  ts: string;
  kind: ChatKind;
  text: string;
  /** result card: task id, auto: auto-answer id */
  ref?: string;
  /** The task whose report this message answers: drawn one step in under that report's card (shared/thread.ts). */
  replyTo?: string;
  cleared?: boolean;
}

export interface WorkerLogItem {
  ts: string;
  from: 'dispatcher' | 'worker' | 'user' | 'event' | 'auto';
  text: string;
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
  /** Offer to remember reusable facts from decision answers and corrections. */
  memorySuggest: boolean;
  /** Closing the window leaves the app working, with an icon in the tray. */
  background: boolean;
  /** Start with the window hidden when the user signs in to the OS. */
  openAtLogin: boolean;
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
  /** A newer release than the one running, when the check found one. */
  update?: { version: string; url: string } | null;
  setupNeeded: boolean;
  settings: SettingsView;
  accounts: AccountView[];
  repos: Repo[];
  workers: Worker[];
  tasks: Task[];
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
  /** Run commands started in this session of the app. */
  runs: RunView[];
  /** The IDE memory's sync with its remote repository. */
  memorySync: MemorySync;
  dispatcher: { busy: boolean; contextTokens: number; accountId: string | null; statusText: string; spend: Spend | null };
}

export interface DiffFile { path: string; added: number; removed: number; status: 'A' | 'M' | 'D' | 'R' | '?'; patch: string }
export interface DiffView { base: string; branch: string; files: DiffFile[]; truncated: boolean; error?: string }

/** A note the user keeps in the app. A shared one is also given to the Dispatcher with its system prompt. */
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
