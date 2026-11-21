// Data shapes shared by the main process and the renderer.

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
  finishedAt: string | null;
  reviewSyncedAt: string | null;
  seenCommentIds: string[];
  /** Start this task only after that task's PR is merged. */
  afterTaskId?: string | null;
  /** Effort the Dispatcher chose for this task; null = the Worker default. */
  effort?: Effort | null;
  mergedAt?: string | null;
  /** The Worker plans in read-only mode first; the user approves the plan in the decision inbox. */
  planFirst?: boolean;
  planApproved?: boolean;
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

export type ChatKind = 'user' | 'dispatcher' | 'event' | 'result' | 'auto' | 'decision' | 'error';

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
  /** UI font. Empty = system font. Several can be listed, separated by commas. */
  fontFamily: string;
  /** Base text size (px). Other sizes scale with it. */
  fontSize: number;
  /** Give agents the user's Claude Code rules (~/.claude/CLAUDE.md, rules/*.md). */
  claudeRules: boolean;
  /** Workers read and write the Claude Code memory of their repository's checkout. */
  claudeMemory: boolean;
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
  chat: ChatItem[];
  dispatcher: { busy: boolean; contextTokens: number; accountId: string | null; statusText: string };
}

export interface DiffFile { path: string; added: number; removed: number; status: 'A' | 'M' | 'D' | 'R' | '?'; patch: string }
export interface DiffView { base: string; branch: string; files: DiffFile[]; truncated: boolean; error?: string }

export interface MemoryFile { path: string; title: string; kind: 'preference' | 'repo' | 'decision' | 'task' | 'other'; size: number; updatedAt: string }
export interface MemoryHit { path: string; line: number; text: string; score: number }
