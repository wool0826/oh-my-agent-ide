// The quick message box: one line to the Dispatcher from anywhere, then it goes away (decisions 123 and 135).
import { addRecent, completeRepo, recentStep } from '../shared/quickInput';
import { clampFontSize, fontStack } from '../shared/font';

interface QuickText { ph: string; sent: string; lang: string; theme: string; repos: string[]; files: string; fontFamily?: string; fontSize?: number }
interface Bridge { call<T = unknown>(channel: string, ...args: unknown[]): Promise<T>; pathForFile(f: File): string }
const ide = (window as unknown as { ide: Bridge }).ide;

const form = document.getElementById('f') as HTMLFormElement;
const input = document.getElementById('q') as HTMLInputElement;
const go = document.getElementById('go') as HTMLButtonElement;
const hint = document.getElementById('hint') as HTMLElement;
const chip = document.getElementById('files') as HTMLButtonElement;

let text: QuickText = { ph: '', sent: '', lang: 'en', theme: 'dark', repos: [], files: '{n}' };
let busy = false;
let files: string[] = [];
/** Lines sent from this box, newest first, kept by the page; `at` is the place in them while going back (-1: typing). */
const RECENT_KEY = 'oma.quick.recent';
let recent: string[] = [];
let at = -1;
let draft = '';

try { recent = JSON.parse(localStorage.getItem(RECENT_KEY) ?? '[]') as string[]; } catch { recent = []; }
if (!Array.isArray(recent)) recent = [];

async function load() {
  try { text = await ide.call<QuickText>('quick:text'); } catch { /* keeps the last */ }
  document.documentElement.lang = text.lang;
  document.documentElement.dataset.theme = text.theme || 'dark';
  input.placeholder = text.ph;
  input.setAttribute('aria-label', text.ph);
  // The font and size chosen in Settings, as the main window has them.
  document.documentElement.style.setProperty('--font-sans', fontStack(text.fontFamily ?? ''));
  document.documentElement.style.setProperty('--ui-font-size', `${clampFontSize(text.fontSize)}px`);
  draw();
}

/** What the caret's @word would become, and the attached files, beside the field. */
function draw() {
  const c = input.selectionStart === input.value.length ? completeRepo(input.value, input.value.length, text.repos) : null;
  hint.hidden = !c;
  hint.textContent = c ? `@${c.repo}` : '';
  chip.hidden = !files.length;
  chip.textContent = text.files.replace('{n}', String(files.length));
  go.disabled = busy || !input.value.trim();
}

function reset() {
  busy = false;
  files = [];
  at = -1;
  draft = '';
  form.classList.remove('sent', 'drop');
  input.readOnly = false;
  input.value = '';
  draw();
}

// Shown again: a fresh, focused field in the current language.
window.addEventListener('focus', () => { reset(); void load(); input.focus(); });
input.addEventListener('input', () => { at = -1; draw(); });
input.addEventListener('click', draw);
input.addEventListener('keyup', (e) => { if (e.key.startsWith('Arrow')) draw(); });

window.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') { void ide.call('quick:close'); return; }
  if (busy || e.isComposing) return;
  // Tab takes the repository offered. With nothing offered it does nothing: there is nowhere else to go.
  if (e.key === 'Tab') {
    e.preventDefault();
    const c = input.selectionStart === input.value.length ? completeRepo(input.value, input.value.length, text.repos) : null;
    if (c) { input.value = c.text; input.setSelectionRange(c.caret, c.caret); at = -1; draw(); }
    return;
  }
  if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
    const next = recentStep(recent.length, at, e.key === 'ArrowUp' ? 'up' : 'down');
    if (next === at) return;
    e.preventDefault();
    if (at === -1) draft = input.value;
    at = next;
    input.value = at === -1 ? draft : recent[at];
    input.setSelectionRange(input.value.length, input.value.length);
    draw();
  }
});

// Files dropped on the box go with the message as paths, as in the chat. Nothing is copied.
window.addEventListener('dragover', (e) => { e.preventDefault(); form.classList.add('drop'); });
window.addEventListener('dragleave', () => form.classList.remove('drop'));
window.addEventListener('drop', (e) => {
  e.preventDefault();
  form.classList.remove('drop');
  for (const f of Array.from(e.dataTransfer?.files ?? [])) {
    const p = ide.pathForFile(f);
    if (p && !files.includes(p)) files.push(p);
  }
  draw();
  input.focus();
});
chip.addEventListener('click', () => { files = []; draw(); input.focus(); });

form.addEventListener('submit', async (e) => {
  e.preventDefault();
  const v = input.value.trim();
  if (!v || busy) return;
  busy = true;
  draw();
  try {
    await ide.call('quick:send', v, files);
    recent = addRecent(recent, v);
    try { localStorage.setItem(RECENT_KEY, JSON.stringify(recent)); } catch { /* not kept */ }
    form.classList.add('sent');
    input.readOnly = true;
    input.value = text.sent;
    hint.hidden = true;
    chip.hidden = true;
    setTimeout(() => void ide.call('quick:close'), 700);
  } catch (err) {
    busy = false;
    input.value = v;
    input.title = err instanceof Error ? err.message : String(err);
    draw();
  }
});

void load();
