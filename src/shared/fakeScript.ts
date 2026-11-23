// The script language of the fake agent (decision 127): lines of "@fake <step> <text>" in a message tell the
// stand-in session what to do in that turn, so every flow of the app can be run without an account or usage.

export type FakeStep =
  | { do: 'say'; text: string }
  /** Says the lines of the message it received that contain `match` (what an agent was told, for a test to read). */
  | { do: 'echo'; match: string }
  | { do: 'tool'; name: string; summary: string }
  /** Asks for a shell command through the real permission path. */
  | { do: 'permission'; command: string }
  /** Asks the user a question with options through the real question path. */
  | { do: 'ask'; question: string; options: string[] }
  /** Submits a plan for approval. */
  | { do: 'plan'; plan: string }
  /** Writes a file in the working folder. */
  | { do: 'write'; file: string; content: string }
  /** Commits everything in the working folder. */
  | { do: 'commit'; message: string }
  | { do: 'wait'; ms: number }
  | { do: 'tokens'; n: number }
  /** Worker only: declares its plan (set_steps), labels split by "|". */
  | { do: 'steps'; steps: string[] }
  /** Worker only: marks step n done (step_done). */
  | { do: 'step'; n: number }
  /** Dispatcher only: creates a task. `prompt` is the Worker's own script. */
  | { do: 'task'; repo: string | null; title: string; prompt: string; bundle: string | null }
  /** Lines of the turn's last message: what a real Worker reports with. */
  | { do: 'result'; text: string }
  | { do: 'pr'; url: string }
  | { do: 'file'; path: string }
  | { do: 'blocked'; why: string }
  /** The turn ends in an error. */
  | { do: 'fail'; message: string };

const LINE = /^\s*@fake\s+([a-z]+)(?:\s+(.*))?$/i;
const SUB = /^\s*@@fake\s+(.*)$/i;

/**
 * The steps a message asks for, in order. Unknown steps are skipped, so a typo does nothing rather than something else.
 * After a "task" line, the "@@fake" lines that follow are that task's own script, handed to its Worker as "@fake" lines.
 */
export function parseFakeScript(text: string): FakeStep[] {
  const out: FakeStep[] = [];
  let task: Extract<FakeStep, { do: 'task' }> | null = null;
  for (const raw of text.split(/\r?\n/)) {
    const sub = SUB.exec(raw);
    if (sub) { if (task) task.prompt += `${task.prompt ? '\n' : ''}@fake ${sub[1]}`; continue; }
    const m = LINE.exec(raw);
    if (!m) continue;
    task = null;
    const arg = (m[2] ?? '').trim();
    const [head, ...rest] = arg.split(/\s+/);
    const tail = rest.join(' ');
    switch (m[1].toLowerCase()) {
      case 'say': if (arg) out.push({ do: 'say', text: arg }); break;
      case 'echo': if (arg) out.push({ do: 'echo', match: arg }); break;
      case 'tool': if (head) out.push({ do: 'tool', name: head, summary: tail || head }); break;
      case 'permission': if (arg) out.push({ do: 'permission', command: arg }); break;
      case 'ask': {
        const [question, ...options] = arg.split('|').map((s) => s.trim()).filter(Boolean);
        if (question && options.length >= 2) out.push({ do: 'ask', question, options });
        break;
      }
      case 'plan': if (arg) out.push({ do: 'plan', plan: arg.replace(/\\n/g, '\n') }); break;
      case 'write': if (head) out.push({ do: 'write', file: head, content: tail.replace(/\\n/g, '\n') }); break;
      case 'commit': out.push({ do: 'commit', message: arg || 'Fake change' }); break;
      case 'wait': out.push({ do: 'wait', ms: Math.min(60_000, Math.max(0, Number(arg) || 0)) }); break;
      case 'tokens': out.push({ do: 'tokens', n: Math.max(0, Number(arg) || 0) }); break;
      case 'steps': {
        const steps = arg.split('|').map((s) => s.trim()).filter(Boolean);
        if (steps.length) out.push({ do: 'steps', steps });
        break;
      }
      case 'step': if (Number(arg) >= 1) out.push({ do: 'step', n: Math.floor(Number(arg)) }); break;
      case 'task': {
        // "@fake task <repo or -> [bundle=<name>] <title>"
        if (!head || !tail) break;
        const b = /^bundle=(\S+)\s+(.*)$/.exec(tail);
        task = { do: 'task', repo: head === '-' ? null : head, title: (b ? b[2] : tail).trim(), prompt: '', bundle: b ? b[1].replace(/_/g, ' ') : null };
        out.push(task);
        break;
      }
      case 'result': out.push({ do: 'result', text: arg || 'Done.' }); break;
      case 'pr': if (arg) out.push({ do: 'pr', url: arg }); break;
      case 'file': if (arg) out.push({ do: 'file', path: arg }); break;
      case 'blocked': out.push({ do: 'blocked', why: arg || 'Blocked.' }); break;
      case 'fail': out.push({ do: 'fail', message: arg || 'Failed.' }); break;
      default: break;
    }
  }
  return out;
}

/** The turn's last message from its report steps, in the lines a Worker's report is read from. Empty with none. */
export function fakeReport(steps: readonly FakeStep[]): string {
  const lines: string[] = [];
  for (const s of steps) {
    if (s.do === 'result') lines.push(`RESULT: ${s.text}`);
    else if (s.do === 'pr') lines.push(`PR: ${s.url}`);
    else if (s.do === 'file') lines.push(`FILE: ${s.path}`);
    else if (s.do === 'blocked') lines.push(`BLOCKED: ${s.why}`);
  }
  return lines.join('\n');
}

/** A message with no script still ends its turn with a report, so follow-ups (a pick, an answer) settle. */
export const FAKE_DEFAULT_REPORT = 'RESULT: Done (fake agent).';
