/** What is written in the Worker composer and not sent yet. One field serves every Worker, so each keeps its own. */

export interface Draft<R> { text: string; files: string[]; reply: R | null }

export class Drafts<R> {
  private map = new Map<string, Draft<R>>();

  /** Keep what the composer holds for `id`. An empty composer leaves nothing. */
  put(id: string, d: Draft<R>): void {
    if (!d.text.trim() && !d.files.length && !d.reply) this.map.delete(id);
    else this.map.set(id, { text: d.text, files: [...d.files], reply: d.reply });
  }

  /** The draft for `id`, handed to the composer: it is no longer kept here. */
  take(id: string): Draft<R> {
    const d = this.map.get(id);
    this.map.delete(id);
    return d ?? { text: '', files: [], reply: null };
  }

  /**
   * A message for `id` went while another Worker was on screen. What went leaves the draft;
   * text written after the send, and files added after it, stay.
   */
  sent(id: string, text: string, files: string[], reply: R | null): void {
    const d = this.map.get(id);
    if (!d) return;
    this.put(id, { text: d.text === text ? '' : d.text, files: d.files.filter((f) => !files.includes(f)), reply: d.reply === reply ? null : d.reply });
  }

  /** Drop the drafts of Workers that are gone. */
  keep(there: (id: string) => boolean): void {
    for (const id of [...this.map.keys()]) if (!there(id)) this.map.delete(id);
  }

  has(id: string): boolean {
    return this.map.has(id);
  }
}
