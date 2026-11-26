// What Workers are told in fixed words, and the limits that go with it: the messages that restart a task, the notes about plans and questions, and the tools and environment every Worker session gets.
import { langName } from '../i18n';
import { BRIEF_MAX } from '../../shared/brief';
import { type Task } from '../../shared/types';

export const RESUME_MSG = 'The app restarted and interrupted your work. Continue the task where you left off.';

export const LIMIT_RESET_MSG = 'The usage limit has reset. Continue the task where you left off.';

export const SLOT_FREE_MSG = 'Continue the task where you left off.';

/** A Worker that answered a question mid-task and stopped: the answer is no task result. */
export const GO_ON_MSG ='[Dispatcher] Your answer was delivered. Go on with your task where you left off, and report it with the RESULT lines when it is done.';

/** The one reminder a Worker gets when its task sits open with nothing running it (sweepStalled). */
export const stallMsg = (taskId: string, min: number, shells = false) => `[Dispatcher] Your task ${taskId} is still open, but your session has been idle for ${min} min with ${shells ? 'only background commands running. If one is a server or hung, stop it and go on; if a run is still useful, say so with tell_dispatcher' : 'nothing running'}. Go on with it where you left off. If you are waiting for something, say what with tell_dispatcher; when the task is done, report it with the RESULT lines.`;

/** Built-in tools a Worker never needs. Left out, their definitions are not re-read on every step. */
export const UNUSED_TOOLS = ['Workflow', 'ScheduleWakeup', 'ReportFindings', 'ListAgents'];
/**
 * Environment for a Worker's Claude Code process (its subagents inherit it).
 * - A 5-minute prompt cache. A Worker steps every few seconds, so the cache stays warm while it works, and writing
 *   to it costs 1.25x input instead of the 2x of the 1-hour cache Claude Code uses on subscriptions. In 1,617 measured
 *   Worker steps only 4 came 5 to 60 minutes after the one before. The Dispatcher waits minutes between turns and
 *   keeps the 1-hour cache.
 * - No bundled skills (debug, verify, code-review, claude-api and others). Their listing is about 2,300 tokens sent
 *   with every request, and no Worker used one. The app's own skills and the repository's stay.
 */

export const WORKER_ENV = { FORCE_PROMPT_CACHING_5M: '1', CLAUDE_CODE_DISABLE_BUNDLED_SKILLS: '1' };

/** Command output a Worker gets inline; Claude Code saves the rest to a file it can read in parts (its default is 30,000). */
export const SHELL_OUTPUT_CHARS = 12_000;

/** Requests from one task that each start a Dispatcher turn; later ones wait for its next turn. */
export const MAX_REQUEST_WAKES = 5;

/** What the Dispatcher is told about a task that stopped for it: only a message to the Worker sets it going again. */
export const REPLY_NOTE = 'Its task stays open and keeps its Worker slot until the Worker hears from you: reply with send_to_worker, also after you did something else about it (create_task, request_decision).';

export type TellKind = 'answer' | 'request' | 'note';

/** Long text for the Dispatcher, cut where it would crowd its context; read_worker has the rest. */
export const clip = (text: string, max: number) => {
  const s = text.trim().replace(/\r?\n/g, '\n  ');
  return s.length > max ? `${s.slice(0, max)}… (cut; read_worker has the rest)` : s;
};

export const QUESTION_TAG = '[Dispatcher question]';

export const question = (text: string) =>
  `${QUESTION_TAG} ${text}\n\nAnswer with the tell_dispatcher tool (kind "answer"), then go on with what you were doing. This is a question, not a new task.`;

export const planNudge = (task: Task) =>
  `[Plan needed] Your turn ended without a plan for ${task.id}. This task is plan-first, so it is not finished until the user approves a plan. Finish investigating and present your plan with ExitPlanMode now; if the user must decide something first, ask with AskUserQuestion. If you were told to hold, reply in one line and stop.`;

/** The task message may say to plan only or to wait for approval; this is that approval. */
export const planApproved = (task: Task) =>
  `[Plan approved] The user approved your plan for ${task.id}. That is the go-ahead this task was waiting for, even where the task message says to plan only: carry out the plan now in this session${task.kind === 'code' && task.branch ? ` on branch ${task.branch}` : ''}, and report the finished work as usual${task.kind === 'code' ? ', with the PR' : ''}. Do not stop at the plan.`;

/** The user approves from these lines; the full plan stays folded under them. */
export const planSummaryRule = () =>
  `Start the plan with these lines in ${langName()}, each one short phrase of at most ${BRIEF_MAX} characters, not a sentence: "WHAT: " what you will do, "HOW: " how you will do it, "RISK: " what could go wrong or is hard to undo, "OUTPUT: " what the user gets when it is done. The approval card shows them as they are; put the details below them.`;
