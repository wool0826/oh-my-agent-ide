// The phone's messages into the app (decision 250): the owner's updates from the link go to Inbound, which hands
// words to the Dispatcher as a turn from the phone and answers commands from the board. Called once at boot.
import { dispatcher } from '../agents/dispatcher';
import { store } from '../store';
import { log } from '../log';
import { t } from '../i18n';
import { inboxText, statusText } from '../../shared/remoteChat';
import { Inbound } from './inbound';
import { outbox } from './bridge';
import { telegram } from './telegramLink';
import { onDecisionSettled } from '../decisions';
import { userAnswer } from '../ipc/decisions';
import { shownAnswer } from '../../shared/remoteDecision';

/** Update ids kept: as many as the poller remembers (remote.ts Seen). */
const SEEN_MAX = 200;

export function wireRemote() {
  const remote = () => (store.data.remote ??= {});
  const seenList = () => (remote().telegramSeen ??= []);
  const inbound = new Inbound({
    say: t,
    now: Date.now,
    toDispatcher: (text, replyTo) => {
      dispatcher.send(text, [], replyTo, 'telegram');
      return { held: dispatcher.holding };
    },
    stop: async () => {
      const was = dispatcher.busy;
      await dispatcher.stop();
      return was;
    },
    lock: () => telegram.setPrefs({ requests: false, buttons: false }),
    requests: () => telegram.prefs().requests,
    buttons: () => telegram.prefs().buttons,
    answer: (text, to, buttons) => { outbox.answer(text, to, buttons); },
    decision: (id) => store.data.decisions.find((d) => d.id === id) ?? null,
    answerDecision: (id, ans) => userAnswer(id, ans, 'telegram'),
    ack: (id, text) => { void telegram.ack(id, text); },
    clearButtons: (id) => outbox.clearButtons(id),
    refOf: (id) => outbox.sent.get(id),
    statusText: () => statusText(t, { dispatcherBusy: dispatcher.busy, workers: store.data.workers, tasks: store.data.tasks, decisions: store.data.decisions }),
    inboxText: () => inboxText(t, store.data.decisions),
    seen: {
      has: (id) => seenList().includes(id),
      add: (id) => {
        const l = seenList();
        l.push(id);
        if (l.length > SEEN_MAX) l.splice(0, l.length - SEEN_MAX);
        store.changed();
      },
    },
    waiting: {
      load: () => [...(remote().telegramHeld ?? [])],
      save: (list) => { remote().telegramHeld = [...list]; store.changed(); },
    },
    flush: () => { try { store.flush(); } catch (e) { log.warn('telegram flush', (e as Error).message); } },
  });
  telegram.inbound = (u) => inbound.handle(u);
  // Answered or withdrawn anywhere: its message on the phone loses its buttons (decision 251).
  onDecisionSettled((d, answered) => outbox.settle(d.id, answered ? shownAnswer(t, d, d.answer ?? '') : null));
  // Update ids count per bot: another bot, or none, starts them over.
  telegram.onForget = () => {
    const r = remote();
    r.telegramSeen = [];
    r.telegramHeld = [];
    inbound.forget();
    store.changed();
  };
  telegram.syncPoll();
}
