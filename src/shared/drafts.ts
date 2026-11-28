/** What is written in the Worker composer and not sent yet. One field serves every Worker, so each keeps its own. */

import type { Mention } from './types';

/** `mentions`: the "@" chips over the text (decision 7C). */
export interface Draft<R> { text: string; files: string[]; reply: R | null; mentions?: Mention[] }

export class Drafts<R> {
  private map = new Map<string, Draft<R>>();

  /** Keep what the composer holds for `id`. An empty composer leaves nothing. */
  put(id: string, d: Draft<R>): void {
    if (!d.text.trim() && !d.files.length && !d.reply && !d.mentions?.length) this.map.delete(id);
    else this.map.set(id, { text: d.text, files: [...d.files], reply: d.reply, mentions: [...(d.mentions ?? [])] });
  }

  /** The draft for `id`, handed to the composer: it is no longer kept here. */
  take(id: string): Draft<R> {
    const d = this.map.get(id);
    this.map.delete(id);
    return d ?? { text: '', files: [], reply: null, mentions: [] };
  }

  /**
   * A message for `id` went while another Worker was on screen. What went leaves the draft;
   * text written after the send, and files added after it, stay.
   */
  sent(id: string, text: string, files: string[], reply: R | null, mentions: readonly Mention[] = []): void {
    const d = this.map.get(id);
    if (!d) return;
    const went = (m: Mention) => mentions.some((x) => x.kind === m.kind && x.id === m.id && x.repo === m.repo);
    this.put(id, {
      text: d.text === text ? '' : d.text, files: d.files.filter((f) => !files.includes(f)), reply: d.reply === reply ? null : d.reply,
      mentions: (d.mentions ?? []).filter((m) => !went(m)),
    });
  }

  /** Drop the drafts of Workers that are gone. */
  keep(there: (id: string) => boolean): void {
    for (const id of [...this.map.keys()]) if (!there(id)) this.map.delete(id);
  }

  has(id: string): boolean {
    return this.map.has(id);
  }

  /**
   * The drafts as they are kept on disk for the next start (5A): the ones held here, with what the composers on
   * screen hold now in `shown` (by Worker id, or DISPATCHER_DRAFT). Empty composers leave nothing.
   */
  saved(shown: Record<string, Draft<R>>): Record<string, Draft<R>> {
    const out: Record<string, Draft<R>> = {};
    for (const [id, d] of this.map) out[id] = d;
    for (const [id, d] of Object.entries(shown)) {
      if (!d.text.trim() && !d.files.length && !d.reply) delete out[id];
      else out[id] = { text: d.text, files: [...d.files], reply: d.reply };
    }
    return out;
  }

  /** The drafts kept by the last run, for the Workers still `there`; a saved entry that is not a draft is left out. */
  load(v: unknown, there: (id: string) => boolean, reply: (r: unknown) => R | null): void {
    if (!v || typeof v !== 'object') return;
    for (const [id, d] of Object.entries(v as Record<string, unknown>)) {
      const p = parseDraft(d, reply);
      if (p && there(id)) this.put(id, p);
    }
  }
}

/** The key of the Dispatcher composer's draft among the Workers' ones. */
export const DISPATCHER_DRAFT = 'dispatcher';

/** A draft read back from disk, or null when it is not one. */
export function parseDraft<R>(v: unknown, reply: (r: unknown) => R | null): Draft<R> | null {
  const o = v as Partial<Record<keyof Draft<R>, unknown>> | null;
  if (!o || typeof o.text !== 'string') return null;
  const files = Array.isArray(o.files) ? o.files.filter((f): f is string => typeof f === 'string') : [];
  return { text: o.text, files, reply: o.reply ? reply(o.reply) : null };
}
