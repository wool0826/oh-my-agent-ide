import type { IpcContext } from './handle';
import { registerChatIpc } from './chat';
import { registerToolIpc } from './tools';
import { registerDecisionIpc } from './decisions';
import { registerWorkerIpc } from './workers';
import { registerRepoIpc } from './repos';
import { registerMemoryIpc } from './memory';
import { registerSettingsIpc } from './settings';
import { registerAppIpc } from './app';
import { registerTelegramIpc } from './telegram';

export type { IpcContext } from './handle';
export { userAnswer } from './decisions';
export { registerE2eIpc } from './e2e';

/** The channels the window calls, one file per area. */
export function registerIpc(ctx: IpcContext) {
  registerChatIpc(ctx);
  registerToolIpc();
  registerDecisionIpc();
  registerWorkerIpc(ctx);
  registerRepoIpc(ctx);
  registerMemoryIpc();
  registerSettingsIpc(ctx);
  registerAppIpc();
  registerTelegramIpc();
}
