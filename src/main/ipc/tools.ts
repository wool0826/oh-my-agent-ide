import { handle } from './handle';
import { loadSettings } from '../settings';
import { side } from '../side';
import { terminal } from '../terminal';
import { shell as shellRuns } from '../shell';
import { runs } from '../runs';
import { addScript, removeScript, runScript, updateScript } from '../scripts';
import type { ScriptInput } from '../../shared/scripts';

/** The side question, the side terminal, lines run with !, saved scripts and a Worker's run command. */
export function registerToolIpc() {
  // A side question: its own session and thread, never the Dispatcher's (main/side.ts).
  handle('side:send', (text: string, model?: string | null, repo?: string | null) => side.send(text, model, repo));
  handle('side:stop', () => side.stop());
  handle('side:reset', () => side.reset());
  handle('side:state', () => side.state());
  // The side terminal (main/terminal.ts): its runs stay out of the chat and away from the Dispatcher.
  handle('term:run', (cmd: string, repo?: string | null) => terminal.run(String(cmd ?? ''), typeof repo === 'string' && repo ? repo : null));
  handle('term:stop', (id: string) => terminal.stop(String(id)));
  handle('term:clear', () => terminal.clear());
  handle('term:state', () => terminal.state());
  handle('run:start', (id: string) => runs.start(id));
  handle('run:stop', (id: string) => runs.stop(id));
  handle('run:clear', (id: string) => runs.clear(id));
  handle('shell:run', (cmd: string, repo?: string | null) => shellRuns.run(String(cmd ?? ''), typeof repo === 'string' && repo ? repo : null, { ask: loadSettings().shellAsk }));
  handle('shell:stop', (id: string) => shellRuns.stop(id));
  // Saved scripts: only the Run button starts one, and it runs the stored command (main/scripts.ts).
  handle('script:add', (input: Partial<ScriptInput>) => addScript(input));
  handle('script:update', (id: string, input: Partial<ScriptInput>) => updateScript(id, input));
  handle('script:remove', (id: string) => removeScript(id));
  handle('script:run', (id: string) => runScript(id));
}
