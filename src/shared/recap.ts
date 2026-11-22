// What the Dispatcher's new session (a new day, or a model on the other agent) is told of the conversation before it.

import type { ChatItem } from './types';

/**
 * The end of the earlier conversation: what the user wrote and what the Dispatcher answered, oldest first, each clipped,
 * within `max` characters in all. Results and events are left out; the board tools show tasks as they are now.
 * Empty when there is nothing to carry over.
 */
export function recapChat(chat: Pick<ChatItem, 'kind' | 'text' | 'ts'>[], max = 4000, each = 400): string {
  const lines: string[] = [];
  let size = 0;
  for (let i = chat.length - 1; i >= 0; i--) {
    const c = chat[i];
    if (c.kind !== 'user' && c.kind !== 'dispatcher') continue;
    const text = c.text.replace(/\s+/g, ' ').trim();
    if (!text) continue;
    const line = `- ${c.kind === 'user' ? 'User' : 'You'} (${c.ts.slice(0, 16).replace('T', ' ')}): ${text.length > each ? `${text.slice(0, each - 1)}…` : text}`;
    if (size + line.length > max) break;
    lines.unshift(line);
    size += line.length + 1;
  }
  return lines.join('\n');
}
