import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { AgentSession, type SessionEvents } from './agents/session';
import { FakeSession } from './agents/fakeSession';
import { accounts } from './accounts';
import { store } from './store';
import { fakeMode } from './fake';
import { t } from './i18n';
import { log } from './log';
import { cachedModels } from './models';
import { providerOf } from '../shared/models';
import { addSideItem, SIDE_EMPTY, sideModel, type SideView } from '../shared/side';

/**
 * A side question (shared/side.ts): one plain Claude Code session beside the Dispatcher. No Dispatcher prompt, no
 * board tools, no memory of the chat; it can read a folder the user picked and the web, and changes nothing. Its
 * thread is kept here, in memory, and pushed to the window on its own channel, never into the chat.
 */
const PROMPT = 'You answer a side question the user asks in Oh My Agent IDE, apart from its Dispatcher and Workers. '
  + 'You can read files and the web; you change nothing and cannot hand out work. Answer directly and briefly, in the language the user writes in.';

class Side {
  private session: AgentSession | FakeSession | null = null;
  private view: SideView = { ...SIDE_EMPTY };
  private listeners: ((v: SideView) => void)[] = [];
  /** Which session the events are from: a closed one may still say something on its way out. */
  private gen = 0;

  state(): SideView { return this.view; }
  onChange(fn: (v: SideView) => void) { this.listeners.push(fn); }

  /** Asks `text`. The first question starts the session with `model` in `repo` (null for no folder). */
  send(text: string, model?: string | null, repo?: string | null) {
    const q = text.trim();
    if (!q) return;
    if (!this.session || this.session.closed) this.open(model ?? null, repo ?? null);
    this.set({ items: addSideItem(this.view.items, { role: 'me', text: q }) });
    this.session!.send(q);
  }

  async stop() { await this.session?.interrupt(); }

  /** Close: the session ends and the thread is forgotten. */
  reset() {
    this.session?.close();
    this.session = null;
    this.gen += 1;
    this.set({ ...SIDE_EMPTY });
  }

  private open(model: string | null, repo: string | null) {
    const models = cachedModels().models;
    const m = model && providerOf(model, models) === 'claude' ? model : sideModel(models);
    const r = repo ? store.repo(repo) : null;
    if (repo && !r) throw new Error(t('err.noRepo', { name: repo }));
    const cwd = r ? r.path : path.join(os.tmpdir(), 'oma-side-question');
    fs.mkdirSync(cwd, { recursive: true });
    this.gen += 1;
    if (fakeMode()) {
      // A side question creates nothing; the hook only keeps the fake from adding a Worker's default report.
      this.session = new FakeSession({ label: 'Side', model: m, cwd, accountId: null, resume: null, createTask: async () => '' }, this.events());
    } else {
      const acc = accounts.pick(undefined, 'claude');
      if (!acc) throw new Error(t('sq.err.noAccount'));
      this.session = new AgentSession({
        label: 'Side',
        model: m,
        cwd,
        systemAppend: PROMPT,
        accountId: acc.id,
        resume: null,
        tools: ['Read', 'Glob', 'Grep', 'WebSearch', 'WebFetch'],
        canUseTool: async (_name, input) => ({ behavior: 'allow', updatedInput: input }),
      }, this.events());
    }
    this.view = { ...SIDE_EMPTY, model: m, repo: r?.name ?? null };
    log.info('side question opened', m, cwd);
  }

  private events(): SessionEvents {
    const gen = this.gen;
    const ev: SessionEvents = {
      onText: (text) => { if (text.trim()) this.set({ items: addSideItem(this.view.items, { role: 'ai', text }) }); },
      onTool: (_name, summary) => this.set({ status: summary }),
      onContext: (n) => this.set({ contextTokens: n }),
      onStatus: (st, text) => {
        this.set({ busy: st === 'busy', status: st === 'busy' ? this.view.status : '' });
        if (st === 'error' && text) this.set({ items: addSideItem(this.view.items, { role: 'error', text }) });
      },
      onTurnEnd: (r) => {
        if (r.isError && r.text && r.text !== 'Interrupted.') this.set({ items: addSideItem(this.view.items, { role: 'error', text: r.text }) });
        if (!r.queued) this.set({ busy: false, status: '' });
      },
      onLimited: () => this.set({ items: addSideItem(this.view.items, { role: 'error', text: t('sq.err.limited') }) }),
    };
    // Every handler is dropped once this session is not the side question's any more.
    for (const k of Object.keys(ev) as (keyof SessionEvents)[]) {
      const fn = ev[k] as (...a: unknown[]) => void;
      (ev as Record<string, unknown>)[k] = (...a: unknown[]) => { if (gen === this.gen) fn(...a); };
    }
    return ev;
  }

  private set(p: Partial<SideView>) {
    this.view = { ...this.view, ...p };
    for (const fn of this.listeners) fn(this.view);
  }
}

export const side = new Side();
