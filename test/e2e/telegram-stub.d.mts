// Types for telegram-stub.mjs, so the unit tests in TypeScript can start it.
export const STUB_TOKEN: string;

export interface StubSent { chat_id: number; text: string; message_id: number; disable_notification?: boolean; [k: string]: unknown }

export interface TelegramStub {
  url: string;
  token: string;
  state: { token: string; sent: StubSent[];calls: { method: string; params: Record<string, any> }[]; updates: any[]; bot: { id: number; username: string; [k: string]: unknown }; waiting: unknown };
  push(update: Record<string, unknown>): { update_id: number; [k: string]: any };
  user(id: number, text: string, o?: { date?: number; type?: string; name?: string }): Record<string, unknown>;
  failNext(method: string, status: number, description: string, extra?: Record<string, unknown>, times?: number): void;
  revoke(): void;
  close(): Promise<void>;
}

export function startTelegramStub(o?: { token?: string; bot?: Record<string, unknown> }): Promise<TelegramStub>;
