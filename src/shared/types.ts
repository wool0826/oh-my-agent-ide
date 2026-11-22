// Data shapes shared by the main process and the renderer.

import type { SessionSpend, Spend } from './spend';

export type Lang = 'en' | 'ko';

export type Effort = 'low' | 'medium' | 'high' | 'xhigh' | 'max';
export const EFFORTS: Effort[] = ['low', 'medium', 'high', 'xhigh', 'max'];

export type UsageWindow = { utilization: number | null; resetsAt: string | null };

export type AccountPlan = 'team' | 'enterprise';

/** At most this many accounts can be registered. */
export const MAX_ACCOUNTS = 4;

export interface AccountView {
  id: string;
  label: string;
  /** token: stored OAuth token, login: this PC's existing Claude Code login */
  kind: 'token' | 'login';
  plan: AccountPlan;
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
  /** Shell command run in each new worktree (install dependencies, copy .env, ...). */
  setup?: string;
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
  /** Times the Worker was sent failed CI checks to fix. */
  ciFixAttempts?: number;
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
  cleared?: boolean;
}

export interface WorkerLogItem {
  ts: string;
  from: 'dispatcher' | 'worker' | 'user' | 'event' | 'auto';
  text: string;
}

/** A page of a Worker's log: `items` are lines `start` to `start + items.length` of its `total` (decision 85). */
export interface LogPage { items: WorkerLogItem[]; start: number; total: number }

export type SoundName = 'chime' | 'bell' | 'ping' | 'none' | 'custom';

export interface SettingsView {
  language: Lang;
  home: string;
  githubHost: string;
  /** OS notification when a decision is needed */
  notifications: boolean;
  sound: SoundName;
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
  /** UI font. Empty = system font. Several can be listed, separated by commas. */
  fontFamily: string;
  /** Base text size (px). Other sizes scale with it. */
  fontSize: number;
  /** Give agents the user's Claude Code rules (~/.claude/CLAUDE.md, rules/*.md). */
  claudeRules: boolean;
  /** Workers read and write the Claude Code memory of their repository's checkout. */
  claudeMemory: boolean;
  /** Offer to remember reusable facts from decision answers and corrections. */
  memorySuggest: boolean;
}

/** What Settings shows about the user's Claude Code setup. */
export interface ClaudeInfo { home: string; rules: string[]; memoryHome: string }

/** A model the account can use, from the API's model list. */
export interface ModelInfo { id: string; name: string; created: string }
/** The model list and when it was last read; error is the last failed refresh, if any. */
export interface ModelList { models: ModelInfo[]; fetchedAt: string | null; error: string | null }

export interface AppState {
  ready: boolean;
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
  /** The IDE memory's sync with its remote repository. */
  memorySync: MemorySync;
  dispatcher: { busy: boolean; contextTokens: number; accountId: string | null; statusText: string; spend: Spend | null };
}

export interface DiffFile { path: string; added: number; removed: number; status: 'A' | 'M' | 'D' | 'R' | '?'; patch: string }
export interface DiffView { base: string; branch: string; files: DiffFile[]; truncated: boolean; error?: string }

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
