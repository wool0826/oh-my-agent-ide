// A repository's run command gets its own port in each Worker's worktree, so two Workers can run the same dev server
// side by side (13A). The repository sets a base port and a step; Worker W-02 gets base + 1 step, W-03 base + 2 steps.
// The run sees the port and the worktree as environment variables, read-only in the repository view.

export const PORT_MIN = 1024;
export const PORT_MAX = 65000;
export const PORT_STEPS = [1, 10, 100] as const;
export const DEFAULT_PORT_STEP = 10;
/** How many ports above the Worker's own one a run tries when that one is taken. */
export const PORT_TRIES = 20;

export interface PortSettings { basePort?: number; portStep?: number }

/** What the base port field holds: nothing (no port), a port, or something to fix. */
export function parseBasePort(text: string): number | null | 'bad' {
  const s = text.trim();
  if (!s) return null;
  if (!/^\d+$/.test(s)) return 'bad';
  const n = Number(s);
  return n >= PORT_MIN && n <= PORT_MAX ? n : 'bad';
}

export function portStep(r: PortSettings): number {
  return (PORT_STEPS as readonly number[]).includes(r.portStep ?? 0) ? r.portStep! : DEFAULT_PORT_STEP;
}

/** The number in a Worker id (W-02 → 2), or 1 when it has none. */
export function workerNumber(id: string): number {
  const m = /(\d+)\s*$/.exec(id);
  const n = m ? Number(m[1]) : 1;
  return n >= 1 ? n : 1;
}

/**
 * The port a Worker's run gets, or null when the repository sets no base port. W-01 gets the base port itself; the
 * steps wrap around before they pass PORT_MAX, so a high Worker number still gets a usable port.
 */
export function workerPort(r: PortSettings, workerId: string): number | null {
  const base = r.basePort;
  if (!base || base < PORT_MIN || base > PORT_MAX) return null;
  const step = portStep(r);
  const slots = Math.floor((PORT_MAX - base) / step) + 1;
  return base + ((workerNumber(workerId) - 1) % slots) * step;
}

/** The ports a run tries in order: its own, then the next ones up. */
export function portCandidates(port: number, tries = PORT_TRIES): number[] {
  const out: number[] = [];
  for (let p = port; p < port + tries && p <= 65535; p++) out.push(p);
  return out;
}

/** The variables a run gets on top of the app's environment, in the order the repository view lists them. */
export function runEnv(o: { repoPath: string; workerId: string; worktree: string; port: number | null }): [string, string][] {
  return [
    ...(o.port ? [['PORT', String(o.port)] as [string, string]] : []),
    ['WORKTREE_NAME', o.workerId],
    ['ROOT_PATH', o.repoPath],
    ['WORKTREE_PATH', o.worktree],
  ];
}

/**
 * PowerShell reads `$PORT` as its own variable, not the environment's: a line that copies each variable in first lets
 * the same run command (`npm run dev -- --port $PORT`) work under PowerShell and a POSIX shell.
 */
export function psPrelude(names: string[]): string {
  return names.filter((n) => /^[A-Z_][A-Z0-9_]*$/i.test(n)).map((n) => `$${n} = $env:${n}; `).join('');
}
