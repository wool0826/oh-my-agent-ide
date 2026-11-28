import { handle } from './handle';
import { store } from '../store';
import { remember, revisePreference } from '../memory';
import { answer as answerDecision } from '../decisions';
import { dispatcher } from '../agents/dispatcher';
import { workers } from '../agents/workers';
import { dismissSuggestion, saveSuggestion, suggestFromCorrection, suggestFromDecision } from '../agents/memorySuggest';
import { t } from '../i18n';
import { nowIso, oneLine } from '../util';
import { worthRemembering } from '../../shared/decisionMemory';
import { shownAnswer } from '../../shared/remoteDecision';

/**
 * The user's answer to a decision, from the inbox, a Worker's composer, a notification button or the phone
 * (`via` 'telegram': the Dispatcher's turn about it answers there too).
 */
export function userAnswer(id: string, ans: string, via?: 'telegram') {
  const d = answerDecision(id, ans);
  if (!d) return;
  const shown = shownAnswer(t, d, ans);
  const who = d.workerId ? `${d.workerId}: ` : '';
  store.chat('decision', `${who}${oneLine(d.title, 80)} → ${shown}`);
  if (d.source === 'dispatcher') dispatcher.decisionAnswered(d.title, ans, via === 'telegram');
  // Permissions, plans approved as they were and other bare yes-or-no answers stay out of memory (decisionMemory.ts).
  if (worthRemembering(d)) remember('decision', `${d.workerId ?? 'Dispatcher'}: ${oneLine(d.title, 160)} → ${shown}`);
  suggestFromDecision(d);
}

/** Decisions, the Dispatcher's answers the user corrects, and memory suggestions. */
export function registerDecisionIpc() {
  handle('decision:answer', (id: string, ans: string) => userAnswer(id, ans));
  handle('auto:correct', (id: string, newAnswer: string, scope: 'once' | 'preference') => {
    const a = store.data.autoAnswers.find((x) => x.id === id);
    if (!a) throw new Error(t('err.noItem'));
    a.corrected = { answer: newAnswer, scope, at: nowIso() };
    store.event(t(scope === 'preference' ? 'ev.correctedPref' : 'ev.corrected', { q: oneLine(a.question, 60), a: newAnswer }), { k: 'corrected', worker: a.workerId, title: oneLine(a.question, 120) });
    if (scope === 'preference') revisePreference(a.basis, `${oneLine(a.question, 120)} → ${newAnswer}`);
    workers.send(a.workerId, 'user', `[Correction] For "${a.question}" the Dispatcher answered "${a.answer}" on the user's behalf, but the user corrected it to "${newAnswer}". Adjust anything you already did accordingly.`)
      .catch((e) => store.event(t('err.correction', { id: a.workerId, msg: (e as Error).message }), { k: 'correctFailed', worker: a.workerId, title: oneLine(a.question, 120) }, { kind: 'error' }));
    store.changed();
    suggestFromCorrection(a);
  });
  handle('suggest:save', (id: string, text?: string) => { const file = saveSuggestion(id, text); dispatcher.refreshContext(); return file; });
  handle('suggest:dismiss', (id: string) => dismissSuggestion(id));
}
