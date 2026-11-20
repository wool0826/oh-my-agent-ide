import fs from 'node:fs';
import { paths } from './paths';

function write(level: string, args: unknown[]) {
  const line = `${new Date().toISOString()} ${level} ${args.map((a) => (a instanceof Error ? a.stack ?? a.message : typeof a === 'string' ? a : JSON.stringify(a))).join(' ')}`;
  // eslint-disable-next-line no-console
  (level === 'ERROR' ? console.error : console.log)(line);
  try { fs.appendFileSync(paths().appLog, line + '\n', 'utf8'); } catch { /* the home folder may not exist yet */ }
}

export const log = {
  info: (...a: unknown[]) => write('INFO', a),
  warn: (...a: unknown[]) => write('WARN', a),
  error: (...a: unknown[]) => write('ERROR', a),
};
