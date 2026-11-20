// Data shapes shared by the main process and the renderer.

export type Lang = 'en' | 'ko';

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
  limited: boolean;
  lastError: string | null;
}

export interface Repo {
  name: string;
  url: string;
  path: string;
  description: string;
  defaultBranch: string;
  addedAt: string;
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
  mergedAt?: string | null;
}

export interface DecisionOption { label: string; description?: string }

export interface Decision {
  id: string;
  source: 'permission' | 'question' | 'dispatcher';
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
  /** UI font. Empty = system font. Several can be listed, separated by commas. */
  fontFamily: string;
  /** Base text size (px). Other sizes scale with it. */
  fontSize: number;
}

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

export interface MemoryFile { path: string; title: string; kind: 'preference' | 'repo' | 'decision' | 'task' | 'other'; size: number; updatedAt: string }
export interface MemoryHit { path: string; line: number; text: string; score: number }
