import type { AppState, AutoAnswer, ChatItem, Decision, MemoryFile, MemoryHit, Task, Worker, WorkerLogItem, AccountView } from '../shared/types';
import { FONT_SIZE_DEFAULT, FONT_SIZE_MAX, FONT_SIZE_MIN, FONT_SUGGESTIONS, clampFontSize, fontStack, normalizeFontFamily } from '../shared/font';

declare global {
  interface Window {
    ide: {
      platform: string;
      call<T = any>(channel: string, ...args: unknown[]): Promise<T>;
      onState(fn: (s: AppState) => void): void;
      onWorkerLog(fn: (id: string, item: WorkerLogItem) => void): void;
      onBlink(fn: () => void): void;
    };
  }
}

const ide = window.ide;
const $ = <T extends HTMLElement = HTMLElement>(sel: string) => document.querySelector(sel) as T;
const COMPACT_AT = 250_000;
const TASK_STATUS: Record<string, string> = { queued: '대기', running: '진행 중', waiting: '결정 대기', pr_open: 'PR 리뷰 대기', done: '끝남', failed: '실패', cancelled: '취소' };

let S: AppState | null = null;
const ui = {
  view: 'chat' as 'chat' | 'worker' | 'repo' | 'memory',
  wSel: null as string | null,
  wOpen: false,
  repoSel: null as string | null,
  memSel: null as string | null,
  memFiles: [] as MemoryFile[],
  memHits: null as MemoryHit[] | null,
  memText: '' as string,
  aaSel: null as string | null,
  aaEdit: null as string | null,
  logs: new Map<string, WorkerLogItem[]>(),
  undo: [] as { kind: 'result' | 'auto'; ids: string[] }[],
  lastChatKey: '',
  lastLogKey: '',
  settingsShown: false,
};

/* ---------- 작은 도우미 ---------- */

function esc(s: unknown) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));
}

function linkify(html: string) {
  return html.replace(/(https?:\/\/[^\s<>"')\]]+)/g, (u) => `<a data-action="open-url" data-href="${u}">${u}</a>`);
}

/** 아주 작은 마크다운: 코드 블록, 인라인 코드, 굵게, 목록, 링크, 줄바꿈 */
function md(src: string) {
  const parts = String(src ?? '').split(/```[\w-]*\n?/);
  return parts.map((p, i) => {
    if (i % 2 === 1) return `<pre>${esc(p.replace(/\n$/, ''))}</pre>`;
    let h = esc(p);
    h = h.replace(/`([^`\n]+)`/g, '<code>$1</code>');
    h = h.replace(/\*\*([^*\n]+)\*\*/g, '<b>$1</b>');
    h = linkify(h);
    return h.split(/\n{2,}/).map((para) => para.trim() ? `<p>${para.trim().replace(/\n/g, '<br>')}</p>` : '').join('');
  }).join('');
}

function oneLine(s: string, n = 120) {
  const t = String(s ?? '').replace(/\s+/g, ' ').trim();
  return t.length > n ? t.slice(0, n - 1) + '…' : t;
}

function ic(kind: string, glyph = kind) {
  return `<span class="ic k-${kind}" aria-hidden="true"><svg><use href="#g-${glyph}"/></svg></span>`;
}

function sym(id: string, cls = '') {
  return `<svg class="sym ${cls}" aria-hidden="true"><use href="#${id}"/></svg>`;
}

function hhmm(iso: string) {
  const d = new Date(iso);
  const now = new Date();
  const t = `${d.getHours() < 12 ? '오전' : '오후'} ${((d.getHours() + 11) % 12) + 1}:${String(d.getMinutes()).padStart(2, '0')}`;
  if (d.toDateString() === now.toDateString()) return `오늘 ${t}`;
  return `${d.getMonth() + 1}월 ${d.getDate()}일 ${t}`;
}

function ago(iso: string) {
  const m = Math.max(0, Math.round((Date.now() - Date.parse(iso)) / 60000));
  if (m < 1) return '방금';
  if (m < 60) return `${m}분`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}시간`;
  return `${Math.round(h / 24)}일`;
}

function k(n: number) { return `${Math.round(n / 1000)}K`; }
function ring(frac: number) {
  const v = Math.max(0, Math.min(100, frac * 100)).toFixed(1);
  return `<svg class="ring" viewBox="0 0 20 20" aria-hidden="true"><circle class="trk" cx="10" cy="10" r="7.5"/><circle class="val" cx="10" cy="10" r="7.5" pathLength="100" stroke-dasharray="${v} 100" transform="rotate(-90 10 10)"/></svg>`;
}
function lv(v: number | null) {
  if (v === null) return 'lv-n';
  return v <= 30 ? 'lv-g' : v <= 50 ? 'lv-y' : v <= 80 ? 'lv-o' : 'lv-r';
}
function modelLabel(m: string) {
  return m.includes('fable') ? 'Fable 5.2' : m.includes('opus') ? 'Opus 5.5' : m.includes('sonnet') ? 'Sonnet 5.5' : m;
}
function acctLabel(id: string | null) { return S?.accounts.find((a) => a.id === id)?.label ?? '–'; }
function prNum(url: string | null) { return url?.match(/\/pull\/(\d+)/)?.[1] ?? ''; }
function base(p: string) { return p.split(/[\\/]/).pop() ?? p; }
const task = (id: string | null | undefined) => (id ? S?.tasks.find((t) => t.id === id) ?? null : null);
const worker = (id: string | null | undefined) => (id ? S?.workers.find((w) => w.id === id) ?? null : null);

let toastTimer: number | undefined;
function toast(text: string, err = false) {
  const t = $('#toast');
  t.textContent = text;
  t.classList.toggle('err', err);
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => { t.hidden = true; }, err ? 6000 : 3000);
}

async function call<T = any>(ch: string, ...args: unknown[]): Promise<T | undefined> {
  try {
    return await ide.call<T>(ch, ...args);
  } catch (e) {
    toast((e as Error).message.replace(/^Error invoking remote method '[^']+': (Error: )?/, ''), true);
    return undefined;
  }
}

/** 다시 그릴 때 입력 중인 값과 포커스를 지킨다. data-keep 속성을 가진 입력만 대상. */
function keepInputs(root: HTMLElement, render: () => void) {
  const vals = new Map<string, string>();
  root.querySelectorAll<HTMLInputElement | HTMLTextAreaElement>('[data-keep]').forEach((el) => vals.set(el.dataset.keep!, el.value));
  const active = document.activeElement as HTMLInputElement | null;
  const focusKey = active && root.contains(active) ? active.dataset.keep : undefined;
  const sel = focusKey ? [active!.selectionStart, active!.selectionEnd] : null;
  const scroll = root.scrollTop;
  render();
  root.querySelectorAll<HTMLInputElement | HTMLTextAreaElement>('[data-keep]').forEach((el) => {
    const v = vals.get(el.dataset.keep!);
    if (v !== undefined && el.type !== 'radio') el.value = v;
  });
  if (focusKey) {
    const el = root.querySelector<HTMLInputElement>(`[data-keep="${CSS.escape(focusKey)}"]`);
    if (el) { el.focus(); if (sel && el.setSelectionRange) try { el.setSelectionRange(sel[0], sel[1]); } catch { /* 일부 입력은 선택 불가 */ } }
  }
  root.scrollTop = scroll;
}

/* ---------- 사이드바 ---------- */

function workerIcon(w: Worker) {
  if (w.status === 'running' || w.status === 'starting') return ic('run');
  if (w.status === 'waiting') return ic('ask');
  if (w.status === 'error') return ic('err');
  if (w.status === 'archived') return ic('arch');
  const t = w.taskIds.length ? task(w.taskIds[w.taskIds.length - 1]) : null;
  if (t?.status === 'queued') return ic('wait');
  if (t?.status === 'pr_open') return ic('pr');
  if (t?.status === 'done') return ic('done');
  return ic('idle');
}

function renderSidebar() {
  const s = S!;
  const pending = s.decisions.filter((d) => d.status === 'pending');
  const running = s.workers.filter((w) => w.status === 'running' || w.status === 'waiting' || w.status === 'starting' || w.status === 'error');
  const prs = s.tasks.filter((t) => t.status === 'pr_open');
  const queued = s.tasks.filter((t) => t.status === 'queued');
  const todayStr = new Date().toDateString();
  const doneToday = s.tasks.filter((t) => (t.status === 'done' || t.status === 'pr_open') && t.finishedAt && new Date(t.finishedAt).toDateString() === todayStr).length;
  const archived = s.workers.filter((w) => w.status === 'archived').length;
  const selW = ui.view === 'worker' && ui.wOpen ? ui.wSel : null;
  let selUsed = false;
  const selCls = (wid: string | null) => {
    if (!selUsed && selW && wid === selW) { selUsed = true; return ' sel'; }
    return '';
  };

  const sec = (title: string, rows: string, cls = '') => rows ? `<section class="side-sec ${cls}"><h4>${title}</h4>${rows}</section>` : '';
  const decRows = pending.map((d) => {
    const t = task(d.taskId);
    return `<div class="row" data-action="goto-decision" data-id="${d.id}">${ic('ask')}<span class="t"><b>${esc(oneLine(d.title, 60))}</b><small>${esc([d.workerId ?? 'Dispatcher', t?.title].filter(Boolean).join(', '))}</small></span></div>`;
  }).join('');
  const runRows = running.map((w) => {
    const t = w.taskIds.length ? task(w.taskIds[w.taskIds.length - 1]) : null;
    const what = t?.title ?? w.title;
    const small = w.status === 'error' ? `${w.id}, 오류` : w.status === 'waiting' ? `${w.id}, 내 결정 대기` : `${w.repo ?? '일반 작업'}, ${w.id}, ${ago(t?.updatedAt ?? w.lastActiveAt)}`;
    return `<div class="row${selCls(w.id)}" data-action="open-worker" data-id="${w.id}">${workerIcon(w)}<span class="t"><b>${esc(what)}</b><small>${esc(small)}</small></span></div>`;
  }).join('');
  const prRows = prs.map((t) => `<div class="row${selCls(t.workerId)}" data-action="open-worker" data-id="${t.workerId ?? ''}">${ic('pr')}<span class="t"><b>${esc(t.title)}</b><small>${esc(`${t.repo ?? ''} #${prNum(t.prUrl)}, 리뷰 대기`)}</small></span></div>`).join('');
  const qRows = queued.map((t) => `<div class="row${selCls(t.workerId)}" data-action="open-worker" data-id="${t.workerId ?? ''}">${ic('wait')}<span class="t"><b>${esc(t.title)}</b><small>${esc(`${t.repo ?? '일반 작업'}, ${t.workerId ?? ''} 대기`)}</small></span></div>`).join('');
  const any = decRows || runRows || prRows || qRows;
  const empty = any ? '' : `<div class="side-empty">${sym('s-check')}<b>진행 중인 일이 없어요</b><span>대화창에 일을 말하면 여기에 나타나요.</span></div>`;
  const misc = `<section class="side-sec"><h4>기록</h4>
    <div class="row${doneToday ? '' : ' zero'}" data-action="view" data-v="worker">${ic('done')}<span class="t"><b>오늘 완료</b></span><span class="badge">${doneToday}</span></div>
    <div class="row${archived ? '' : ' zero'}" data-action="view" data-v="worker">${ic('arch')}<span class="t"><b>보관된 Worker</b></span><span class="badge">${archived}</span></div>
  </section>`;
  $('#side').innerHTML = sec('결정 필요', decRows, 'sec-dec') + sec('실행 중', runRows) + sec('PR 리뷰 대기', prRows) + sec('대기열', qRows) + empty + misc;
}

function renderUsage() {
  const accs = S!.accounts;
  const el = $('#usage');
  if (!accs.length) {
    el.className = 'usage-empty nodrag';
    el.innerHTML = '<a data-action="open-settings">계정 등록</a>';
    return;
  }
  el.className = 'usage nodrag';
  const pc = (v: number | null) => (v === null ? '–' : `${v}%`);
  el.innerHTML = accs.map((a: AccountView) => {
    const tip = a.lastError ?? (a.usageUpdatedAt ? `${hhmm(a.usageUpdatedAt)} 기준` : '아직 사용량을 모름');
    return `<span class="acct${a.limited ? ' limited' : ''}" title="${esc(tip)}"><span class="nm">${esc(a.label)}</span>` +
      `<span>5h</span><span class="cap"><i class="${lv(a.fiveHour.utilization)}" style="width:${a.fiveHour.utilization ?? 0}%"></i></span><span class="pc">${pc(a.fiveHour.utilization)}</span>` +
      `<span>7d</span><span class="cap"><i class="${lv(a.sevenDay.utilization)}" style="width:${a.sevenDay.utilization ?? 0}%"></i></span><span class="pc">${pc(a.sevenDay.utilization)}</span></span>`;
  }).join('');
}

/* ---------- 대화 ---------- */

function chatItemHtml(c: ChatItem) {
  switch (c.kind) {
    case 'user': return `<div class="bub me">${linkify(esc(c.text))}</div>`;
    case 'dispatcher': return `<div class="bub ai">${md(c.text)}</div>`;
    case 'event': return `<span class="event">${sym('s-cpu', 'c-blue')}<span>${linkify(esc(c.text))}</span></span>`;
    case 'decision': return `<span class="event mine">${sym('s-check', 'c-green')}<span><b>결정했어요.</b> ${esc(c.text)}</span></span>`;
    case 'error': return `<span class="event err">${sym('s-alert', 'c-red')}<span>${esc(c.text)}</span></span>`;
    case 'auto': {
      const a = S!.autoAnswers.find((x) => x.id === c.ref);
      const lead = a?.corrected ? '대신 답했다가 정정했어요.' : '대신 답했어요.';
      return `<button class="event self" data-action="aa-select" data-id="${c.ref ?? ''}" title="오른쪽에서 보기">${sym('s-check', 'c-green')}<span><b>${lead}</b> ${esc(c.text)}</span><svg class="chev" aria-hidden="true"><use href="#s-chev"/></svg></button>`;
    }
    case 'result': {
      const t = task(c.ref);
      const links: string[] = [];
      if (t?.prUrl) links.push(`<a data-action="open-url" data-href="${esc(t.prUrl)}">PR #${prNum(t.prUrl)} 열기</a>`);
      for (const f of t?.files ?? []) links.push(`<a data-action="open-file" data-path="${esc(f)}" title="${esc(f)}">${esc(base(f))}</a>`);
      if (t?.workerId) links.push(`<a data-action="open-worker" data-id="${t.workerId}">${t.workerId} 대화 보기</a>`);
      const glyph = t?.prUrl ? sym('s-pr', 'c-purple') : t?.files.length ? sym('s-doc', 'c-teal') : sym('s-check', 'c-green');
      return `<div class="attach"><span class="tile">${glyph}</span><span class="body"><b>${esc(t?.title ?? '작업')}</b><span class="sm">${esc(c.text)}</span><span class="links">${links.join('')}</span></span></div>`;
    }
  }
}

function renderChat(force = false) {
  const s = S!;
  const key = `${s.chat.length}:${s.chat[s.chat.length - 1]?.id}:${s.dispatcher.busy}:${s.dispatcher.statusText}:${s.autoAnswers.filter((a) => a.corrected).length}:${s.tasks.map((t) => t.status + t.prUrl).join()}`;
  if (!force && key === ui.lastChatKey) return;
  ui.lastChatKey = key;
  const th = $('#chat-thread');
  const nearBottom = th.scrollHeight - th.scrollTop - th.clientHeight < 80;
  let html = '';
  let last = 0;
  for (const c of s.chat) {
    const t = Date.parse(c.ts);
    if (t - last > 30 * 60_000) html += `<span class="stamp">${hhmm(c.ts)}</span>`;
    last = t;
    html += chatItemHtml(c);
  }
  if (!s.chat.length) {
    html = `<div class="empty-view">${sym('s-chat')}<b>무엇을 맡길까요?</b><span>할 일을 말하면 Dispatcher가 Worker에게 나눠 맡기고, 결정할 것과 결과만 오른쪽에 모아 둬요. 저장소 등록도 "github.사내/org/repo 클론해서 등록해줘"처럼 말하면 돼요.</span></div>`;
  }
  if (s.dispatcher.busy) html += `<div class="typing"><span class="dots"><i></i><i></i><i></i></span>${esc(s.dispatcher.statusText ? oneLine(s.dispatcher.statusText, 80) : '')}</div>`;
  th.innerHTML = html;
  if (nearBottom || force) th.scrollTop = th.scrollHeight;
  const ctx = s.dispatcher.contextTokens;
  $('#chat-ctx').innerHTML = `${ring(ctx / COMPACT_AT).replace('class="ring"', '')}${k(ctx)} / 250K`;
  updateSendButton();
}

function updateSendButton() {
  const btn = $<HTMLButtonElement>('#chat-send');
  const empty = !$<HTMLTextAreaElement>('#chat-input').value.trim();
  const stop = !!S?.dispatcher.busy && empty;
  btn.classList.toggle('stop', stop);
  btn.innerHTML = sym(stop ? 's-stop' : 's-up');
  btn.setAttribute('aria-label', stop ? 'Dispatcher 멈추기' : '보내기');
  btn.title = stop ? 'Dispatcher 멈추기' : '';
}

function decisionHtml(d: Decision) {
  const t = task(d.taskId);
  const src = [d.workerId ?? 'Dispatcher', t?.title].filter(Boolean).join(', ');
  const icon = d.source === 'permission' ? sym('s-alert', 'c-red') : sym('s-chat', 'c-orange');
  let buttons: string;
  if (d.source === 'permission') {
    buttons = `<div class="btns"><button class="btn" data-action="answer" data-id="${d.id}" data-val="거부">거부</button><button class="btn def" data-action="answer" data-id="${d.id}" data-val="허용">허용</button></div>`;
  } else {
    const col = d.options.length > 2 || d.options.some((o) => o.description);
    buttons = `<div class="btns${col ? ' col' : ''}">${d.options.map((o) => `<button class="btn" data-action="answer" data-id="${d.id}" data-val="${esc(o.label)}">${esc(o.label)}${o.description && col ? `<div class="opt-d">${esc(o.description)}</div>` : ''}</button>`).join('')}</div>`;
  }
  const custom = `<input class="inp" data-keep="dec-${d.id}" data-enter="answer-custom" data-id="${d.id}" placeholder="${d.source === 'permission' ? '거부하면서 이유를 적으려면 여기에 쓰고 Enter' : '다른 답을 쓰고 Enter'}">`;
  return `<div class="dec" id="dec-${d.id}">
    <div class="src">${icon}<span>${esc(src)}</span></div>
    <div class="q">${esc(d.title)}</div>
    ${d.detail ? `<div class="d">${esc(d.detail)}</div>` : ''}
    ${d.code ? `<code>${esc(d.code)}</code>` : ''}
    ${buttons}${custom}
  </div>`;
}

function aaHtml(a: AutoAnswer) {
  const sel = ui.aaSel === a.id ? ' sel' : '';
  const editing = ui.aaEdit === a.id;
  const corrected = a.corrected ? ' corrected' : '';
  const q = `${esc(oneLine(a.question, 140))} → <em>${esc(a.answer)}</em>${a.corrected ? ` <ins>${esc(a.corrected.answer)}</ins>` : ''}`;
  const fix = editing ? `<div class="fix">
      <input class="inp" data-keep="aa-${a.id}" data-enter="aa-send" data-id="${a.id}" placeholder="이렇게 답했어야 해요">
      <div class="radios" role="radiogroup" aria-label="정정 범위">
        <label><input type="radio" name="scope-${a.id}" value="once" checked>이번만 예외</label>
        <label><input type="radio" name="scope-${a.id}" value="preference">선호도 고치기</label>
      </div>
      <div class="btns"><button class="btn" data-action="aa-cancel">취소</button><button class="btn def" data-action="aa-send" data-id="${a.id}">정정 보내기</button></div>
    </div>` : '';
  return `<div class="aa${sel}${editing ? ' editing' : ''}${corrected}" id="aa-${a.id}" data-ctx="aa" data-id="${a.id}">
    <div class="src">${sym('s-check', 'c-green')}<span>${esc(a.workerId)}, ${hhmm(a.createdAt)}</span></div>
    <div class="q">${q}</div>
    <div class="why">${esc(a.basis)}</div>
    ${a.corrected ? `<div class="fixed">${a.corrected.scope === 'preference' ? '선호도까지 고쳤어요' : '이번만 다르게 전했어요'}</div>` : ''}
    ${fix}
    <button class="hov" data-action="aa-edit" data-id="${a.id}" title="정정" aria-label="정정"><svg><use href="#s-pencil"/></svg></button>
  </div>`;
}

function renderChatInspector() {
  const s = S!;
  const root = $('#chat-ins');
  keepInputs(root, () => {
    const pending = s.decisions.filter((d) => d.status === 'pending');
    const results = s.chat.filter((c) => (c.kind === 'result' || c.kind === 'error') && !c.cleared).slice(-30).reverse();
    const autos = s.autoAnswers.filter((a) => !a.cleared).slice(-30).reverse();
    let html = '';
    if (pending.length) html += `<div class="sect" id="sec-dec"><div class="ins-h"><b>결정 대기</b><span class="count" id="dec-count">${pending.length}</span></div><div class="group">${pending.map(decisionHtml).join('')}</div></div>`;
    if (results.length) {
      html += `<div class="sect"><div class="ins-h"><b>결과</b><span class="gap"></span><button class="clear-x" data-action="clear" data-kind="result" title="목록 정리" aria-label="결과 목록 정리"><svg><use href="#s-x"/></svg></button></div><div class="group">${results.map((c) => {
        const t = task(c.ref);
        const glyph = c.kind === 'error' ? sym('s-alert', 'c-red') : t?.prUrl ? sym('s-pr', 'c-purple') : t?.files.length ? sym('s-doc', 'c-teal') : sym('s-check', 'c-green');
        const lk: string[] = [];
        if (t?.prUrl) lk.push(`<a data-action="open-url" data-href="${esc(t.prUrl)}">PR #${prNum(t.prUrl)}${t.prState && t.prState !== 'OPEN' ? (t.prState === 'MERGED' ? ' 머지됨' : ' 닫힘') : ''}</a>`);
        for (const f of t?.files ?? []) lk.push(`<a data-action="open-file" data-path="${esc(f)}" title="${esc(f)}">${esc(base(f))}</a>`);
        return `<div class="res"><span class="tile">${glyph}</span><span class="body"><b>${esc(t?.title ?? '작업')}</b>${lk.length ? `<span class="lk">${lk.join('')}</span>` : ''}<span>${esc(oneLine(c.text, 140))}</span></span></div>`;
      }).join('')}</div></div>`;
    }
    if (autos.length) html += `<div class="sect"><div class="ins-h"><b>대신 답한 것</b><span class="gap"></span><button class="clear-x" data-action="clear" data-kind="auto" title="목록 정리" aria-label="대신 답한 것 목록 정리"><svg><use href="#s-x"/></svg></button></div><div class="group">${autos.map(aaHtml).join('')}</div></div>`;
    if (!html) {
      const busy = s.workers.filter((w) => w.status === 'running' || w.status === 'waiting').length;
      html = `<div class="allclear"><svg class="big" aria-hidden="true"><use href="#s-check"/></svg><b>모두 처리했어요</b><span>결정할 것도, 새 결과도 없어요.</span>${busy ? `<button class="goto" data-action="view" data-v="worker">${ic('run')}Worker ${busy}개가 일하는 중</button>` : ''}</div>`;
    }
    root.innerHTML = html;
  });
}

/* ---------- Worker ---------- */

function statusPill(w: Worker) {
  const t = w.taskIds.length ? task(w.taskIds[w.taskIds.length - 1]) : null;
  switch (w.status) {
    case 'running': case 'starting': return `<span class="pill blue">${t ? ago(t.updatedAt) + '째' : '실행 중'}</span>`;
    case 'waiting': return '<span class="pill red">내 결정 대기</span>';
    case 'error': return '<span class="pill red">오류</span>';
    case 'archived': return '<span class="pill">보관됨</span>';
  }
  if (t?.status === 'queued') return '<span class="pill orange">한도 대기</span>';
  if (t?.status === 'pr_open') return '<span class="pill purple">PR 열림</span>';
  return `<span class="pill">${ago(w.lastActiveAt)} 전</span>`;
}

function renderWorkerList() {
  const s = S!;
  const root = $('#wk-list');
  const active = s.workers.filter((w) => w.status !== 'archived');
  const arch = s.workers.filter((w) => w.status === 'archived');
  const order = (w: Worker) => (w.status === 'waiting' ? 0 : w.status === 'running' || w.status === 'starting' ? 1 : w.status === 'error' ? 2 : 3);
  active.sort((a, b) => order(a) - order(b) || b.lastActiveAt.localeCompare(a.lastActiveAt));
  arch.sort((a, b) => b.lastActiveAt.localeCompare(a.lastActiveAt));
  const li = (w: Worker) => {
    const t = w.taskIds.length ? task(w.taskIds[w.taskIds.length - 1]) : null;
    return `<div class="li${ui.wSel === w.id ? ' sel' : ''}${w.status === 'archived' ? ' dim' : ''}" data-action="select-worker" data-id="${w.id}">${workerIcon(w)}
      <span class="m"><b>${esc(w.id)} ${esc(t?.title ?? w.title)}</b><span>${esc([w.repo ?? '일반 작업', modelLabel(w.model), acctLabel(w.accountId), w.statusText && w.status === 'running' ? w.statusText : ''].filter(Boolean).join(', '))}</span></span>
      <span class="r">${w.status !== 'archived' ? ring(w.contextTokens / COMPACT_AT) + k(w.contextTokens) : ''}${statusPill(w)}</span></div>`;
  };
  if (!s.workers.length) {
    root.innerHTML = `<div class="vhead"><b>Worker</b></div><div class="empty-view">${sym('s-cpu')}<b>아직 Worker가 없어요</b><span>대화창에서 일을 맡기면 Dispatcher가 Worker를 만들어요.</span></div>`;
    return;
  }
  root.innerHTML = `<div class="vhead"><b>Worker</b><small>활성 ${active.length}개, 보관 ${arch.length}개</small></div>
    <div class="lst">${active.map(li).join('')}${arch.length ? `<div class="lst-h">보관됨</div>${arch.map(li).join('')}` : ''}</div>`;
}

function logItemHtml(it: WorkerLogItem, wid: string, prev: WorkerLogItem | null) {
  switch (it.from) {
    case 'dispatcher': return `${prev?.from === 'dispatcher' ? '' : '<span class="who">Dispatcher</span>'}<div class="bub ai">${md(it.text)}</div>`;
    case 'worker': return `${prev?.from === 'worker' ? '' : `<span class="who">${esc(wid)}</span>`}<div class="bub wk">${md(it.text)}</div>`;
    case 'user': return `<div class="bub me">${linkify(esc(it.text))}</div>`;
    case 'auto': return `<span class="event self">${sym('s-check', 'c-green')}<span>${esc(it.text)}</span></span>`;
    default: return `<span class="event">${sym('s-cpu', 'c-blue')}<span>${esc(it.text)}</span></span>`;
  }
}

function renderSession(force = false) {
  const w = worker(ui.wSel);
  $('#wk-list').hidden = ui.wOpen && !!w;
  $('#wk-session').hidden = !(ui.wOpen && w);
  if (!ui.wOpen || !w) return;
  const t = w.taskIds.length ? task(w.taskIds[w.taskIds.length - 1]) : null;
  $('#ws-title').textContent = `${w.id} ${t?.title ?? w.title}`;
  $('#ws-sub').textContent = `Dispatcher와 주고받은 대화${w.repo ? `, ${w.repo}` : ''}`;
  $<HTMLTextAreaElement>('#ws-input').placeholder = `${w.id}에게 보내기. Dispatcher에도 기록돼요.`;
  const log = ui.logs.get(w.id) ?? [];
  const key = `${w.id}:${log.length}:${w.status}:${w.statusText}`;
  if (!force && key === ui.lastLogKey) return;
  ui.lastLogKey = key;
  const th = $('#ws-thread');
  const nearBottom = th.scrollHeight - th.scrollTop - th.clientHeight < 80;
  let html = '';
  let last = 0;
  log.forEach((it, i) => {
    const ts = Date.parse(it.ts);
    if (ts - last > 30 * 60_000) html += `<span class="stamp">${hhmm(it.ts)}</span>`;
    last = ts;
    html += logItemHtml(it, w.id, i > 0 && ts - last < 30 * 60_000 ? log[i - 1] : null);
  });
  if (!log.length) html = `<div class="empty-view"><span>아직 주고받은 대화가 없어요.</span></div>`;
  if (w.status === 'running' || w.status === 'starting') html += `<div class="typing"><span class="dots"><i></i><i></i><i></i></span>${esc(oneLine(w.statusText, 90))}</div>`;
  th.innerHTML = html;
  if (nearBottom || force) th.scrollTop = th.scrollHeight;
}

async function loadLog(id: string) {
  const items = await call<WorkerLogItem[]>('worker:log', id);
  if (items) ui.logs.set(id, items);
  renderSession(true);
}

function renderWorkerInspector() {
  const root = $('#wk-ins');
  const w = worker(ui.wSel);
  if (!w) {
    root.innerHTML = `<div class="allclear"><svg class="big" aria-hidden="true"><use href="#s-cpu"/></svg><b>Worker를 고르세요</b><span>목록에서 고르면 맡은 일과 대화를 볼 수 있어요.</span></div>`;
    return;
  }
  const tasks = w.taskIds.map((id) => task(id)).filter(Boolean).reverse() as Task[];
  const cur = tasks[0];
  const stLabel: Record<string, string> = { running: '실행 중', starting: '시작 중', waiting: '내 결정 대기', idle: '쉬는 중', error: '오류', archived: '보관됨' };
  const pillCls = w.status === 'running' ? 'blue' : w.status === 'waiting' || w.status === 'error' ? 'red' : '';
  const tStatus = TASK_STATUS;
  root.innerHTML = `
    <div class="ins-h"><b>${esc(w.id)}</b><span class="pill ${pillCls}">${stLabel[w.status] ?? w.status}</span></div>
    <div class="group kv">
      <span>작업</span><span>${esc(cur?.title ?? w.title)}</span>
      <span>저장소</span><span>${esc(w.repo ?? '일반 작업')}</span>
      ${cur?.branch ? `<span>브랜치</span><span>${esc(cur.branch)}</span>` : ''}
      <span>폴더</span><span><a data-action="reveal" data-path="${esc(w.cwd)}" title="${esc(w.cwd)}">${esc(base(w.cwd))}</a></span>
      <span>모델</span><span>${modelLabel(w.model)}</span>
      <span>계정</span><span>${esc(acctLabel(w.accountId))}</span>
      <span>컨텍스트</span><span>${k(w.contextTokens)} / 250K</span>
      ${w.statusText && (w.status === 'running' || w.status === 'waiting' || w.status === 'error') ? `<span>지금</span><span>${esc(oneLine(w.statusText, 140))}</span>` : ''}
    </div>
    <div class="ins-h"><b>맡았던 작업</b><small>${tasks.length}건</small></div>
    <div class="group">${tasks.map((t) => `<div class="mini"><b>${esc(t.id)} ${esc(t.title)}</b><span>${tStatus[t.status] ?? t.status}${t.prUrl ? ` · <a data-action="open-url" data-href="${esc(t.prUrl)}">PR #${prNum(t.prUrl)}</a>` : ''}${t.files.map((f) => ` · <a data-action="open-file" data-path="${esc(f)}">${esc(base(f))}</a>`).join('')}</span>${t.summary ? `<span>${esc(oneLine(t.summary, 160))}</span>` : ''}</div>`).join('') || '<div class="mini"><span>아직 없어요</span></div>'}</div>
    <div class="ins-act">
      ${w.status === 'running' || w.status === 'waiting' ? `<button class="btn" data-action="worker-stop" data-id="${w.id}">멈추기</button>` : ''}
      ${w.status === 'archived' ? `<button class="btn" data-action="worker-unarchive" data-id="${w.id}">복원</button>` : `<button class="btn" data-action="worker-archive" data-id="${w.id}">보관</button>`}
      <button class="btn def" data-action="worker-msg" data-id="${w.id}">메시지 보내기</button>
    </div>`;
}

/* ---------- 저장소 ---------- */

function renderRepos() {
  const s = S!;
  const main = $('#repo-main');
  if (!s.repos.length) {
    main.innerHTML = `<div class="vhead"><b>저장소</b></div><div class="empty-view">${sym('s-box')}<b>등록된 저장소가 없어요</b><span>대화창에 "github.사내/org/repo 클론해서 등록해줘"처럼 말하면 등록돼요. 이미 받아 둔 폴더 경로를 말해도 돼요.</span></div>`;
  } else {
    main.innerHTML = `<div class="vhead"><b>저장소</b><small>${s.repos.length}개</small></div><div class="lst">${s.repos.map((r) => {
      const ts = s.tasks.filter((t) => t.repo === r.name);
      const run = ts.filter((t) => t.status === 'running' || t.status === 'waiting').length;
      const pr = ts.filter((t) => t.status === 'pr_open').length;
      return `<div class="li${ui.repoSel === r.name ? ' sel' : ''}" data-action="repo-select" data-id="${esc(r.name)}">${ic('repo', 'box')}<span class="m"><b>${esc(r.name)}</b><span>${esc(r.description || r.url)}</span></span><span class="r">${run ? `<span class="pill blue">작업 ${run}</span>` : ''}${pr ? `<span class="pill purple">PR ${pr}</span>` : ''}</span></div>`;
    }).join('')}</div>`;
  }
  const ins = $('#repo-ins');
  const r = s.repos.find((x) => x.name === ui.repoSel) ?? null;
  if (!r) {
    ins.innerHTML = `<div class="allclear"><svg class="big" aria-hidden="true"><use href="#s-box"/></svg><b>저장소를 고르세요</b></div>`;
    return;
  }
  keepInputs(ins, () => {
    const ts = s.tasks.filter((t) => t.repo === r.name).slice(-15).reverse();
    ins.innerHTML = `<div class="ins-h"><b>${esc(r.name)}</b></div>
      <div class="group kv"><span>경로</span><span><a data-action="reveal" data-path="${esc(r.path)}">${esc(r.path)}</a></span><span>주소</span><span>${esc(r.url)}</span><span>기본 브랜치</span><span>${esc(r.defaultBranch)}</span></div>
      <div class="ins-h"><b>설명</b><small>Dispatcher가 저장소를 고를 때 봐요</small></div>
      <textarea class="inp" data-keep="repo-desc-${esc(r.name)}" id="repo-desc">${esc(r.description)}</textarea>
      <div class="ins-act"><button class="btn" data-action="repo-save" data-id="${esc(r.name)}">설명 저장</button></div>
      <div class="ins-h"><b>작업</b><small>${ts.length}건</small></div>
      <div class="group">${ts.map((t) => `<div class="mini"><b>${esc(t.title)}</b><span>${esc(t.workerId ?? '')} · ${TASK_STATUS[t.status] ?? esc(t.status)}${t.prUrl ? ` · <a data-action="open-url" data-href="${esc(t.prUrl)}">PR #${prNum(t.prUrl)}</a>` : ''}</span></div>`).join('') || '<div class="mini"><span>아직 없어요</span></div>'}</div>
      <div class="ins-act"><button class="btn danger" data-action="repo-remove" data-id="${esc(r.name)}">등록 해제</button></div>`;
  });
}

/* ---------- 메모리 ---------- */

async function loadMemory() {
  ui.memFiles = (await call<MemoryFile[]>('memory:list')) ?? [];
  renderMemory();
}

function memIcon(kind: MemoryFile['kind']) {
  return kind === 'preference' ? ic('pref', 'star') : kind === 'repo' ? ic('repo', 'box') : kind === 'decision' ? ic('done') : ic('doc', 'doc');
}

function renderMemory() {
  const list = $('#mem-list');
  if (ui.memHits) {
    list.innerHTML = ui.memHits.length ? ui.memHits.map((h) => `<div class="hit" data-action="mem-select" data-id="${esc(h.path)}"><small>${esc(h.path)}:${h.line}</small><span>${esc(h.text)}</span></div>`).join('') : `<div class="empty-view"><span>찾는 내용이 없어요.</span></div>`;
  } else {
    list.innerHTML = ui.memFiles.map((f) => `<div class="li${ui.memSel === f.path ? ' sel' : ''}" data-action="mem-select" data-id="${esc(f.path)}">${memIcon(f.kind)}<span class="m"><b>${esc(f.title)}</b><span>${esc(f.path)}</span></span><span class="r">${hhmm(f.updatedAt)}</span></div>`).join('')
      || `<div class="empty-view">${sym('s-sparkle')}<b>메모리가 비어 있어요</b><span>대화에서 밝힌 선호와 결정이 여기에 쌓여요.</span></div>`;
  }
  const ins = $('#mem-ins');
  if (!ui.memSel) {
    ins.innerHTML = `<div class="allclear"><svg class="big" aria-hidden="true"><use href="#s-sparkle"/></svg><b>메모리 파일을 고르세요</b><span>마크다운이 원본이에요. 여기서 고치면 git에 기록돼요.</span></div>`;
    return;
  }
  ins.innerHTML = `<div class="ins-h"><b>${esc(ui.memSel)}</b></div>
    <textarea class="inp memedit" id="mem-edit" spellcheck="false">${esc(ui.memText)}</textarea>
    <div class="ins-act">${ui.memSel.startsWith('repos/') ? `<button class="btn" data-action="mem-promote" data-id="${esc(ui.memSel.slice(6, -3))}" title="이 저장소 메모를 CLAUDE.md에 반영하는 PR을 Worker에게 맡겨요">CLAUDE.md 반영 PR</button>` : ''}<button class="btn def" data-action="mem-save">저장</button></div>`;
}

/* ---------- 설정 ---------- */

/** 화면 글꼴과 글자 크기를 CSS 변수로 적용한다. 설정 시트에서 고치는 동안에는 미리보기로도 쓴다. */
function applyFont(family: string, size: number) {
  const root = document.documentElement.style;
  root.setProperty('--font', fontStack(family));
  root.setProperty('--ui-font-size', `${clampFontSize(size)}px`);
}

function previewFont() {
  applyFont($<HTMLInputElement>('#set-font').value, Number($<HTMLInputElement>('#set-fsize').value));
}

function openSettings() {
  const s = S!;
  ui.settingsShown = true;
  const st = s.settings;
  const accRows = s.accounts.map((a) => `<div class="acc-row"><span class="m"><b>${esc(a.label)}</b><span>${a.kind === 'login' ? '이 PC의 Claude Code 로그인' : 'OAuth 토큰'} · 5시간 ${a.fiveHour.utilization ?? '–'}% · 7일 ${a.sevenDay.utilization ?? '–'}%${a.lastError ? ` · ${esc(a.lastError)}` : ''}</span></span>
      <span class="btns"><button class="btn" data-action="acc-rename" data-id="${a.id}">이름 바꾸기</button><button class="btn danger" data-action="acc-remove" data-id="${a.id}">삭제</button></span></div>`).join('');
  const hasLogin = s.accounts.some((a) => a.kind === 'login');
  $('#sheet').innerHTML = `<div class="sheet" role="dialog" aria-modal="true" aria-label="설정">
    <h2>설정</h2>
    ${s.setupNeeded ? '<p class="note">시작하려면 계정을 하나 이상 등록하세요. 팀 플랜 계정마다 터미널에서 <code>claude setup-token</code>을 실행해 받은 토큰을 붙여 넣으면 돼요. 이 PC에 이미 로그인한 Claude Code를 그대로 써도 됩니다.</p>' : ''}
    <div><h3>계정</h3><div class="group">${accRows || '<div class="acc-row"><span class="m"><span>등록된 계정이 없어요</span></span></div>'}</div></div>
    <div><h3>계정 추가</h3><div class="group form">
      <label for="acc-label">이름</label><div class="val"><input class="inp" id="acc-label" placeholder="예: Team A"></div>
      <label for="acc-token">토큰</label><div class="val"><input class="inp" id="acc-token" type="password" placeholder="claude setup-token으로 받은 sk-ant-… 토큰"></div>
      <span class="lbl"></span><div class="val" style="justify-content:flex-end"><button class="btn" data-action="acc-add-login" ${hasLogin ? 'disabled' : ''}>이 PC 로그인 쓰기</button><button class="btn def" data-action="acc-add">토큰 추가</button></div>
    </div><p class="note" style="margin-top:6px">토큰은 OS 보안 저장소(Windows DPAPI, macOS 키체인)로 암호화해 저장해요. 작업은 사용량이 낮은 계정부터 고르게 나눠 맡기고, 한 계정이 80%를 넘으면 다른 계정으로 이어서 진행해요.</p></div>
    <div><h3>일반</h3><div class="group form">
      <label for="set-home">IDE 홈 폴더</label><div class="val"><input class="inp" id="set-home" value="${esc(st.home)}"><button class="btn" data-action="pick-home">고르기</button></div>
      <label for="set-gh">사내 GitHub 호스트</label><div class="val"><input class="inp" id="set-gh" value="${esc(st.githubHost)}" placeholder="예: github.company.com (비우면 github.com)"></div>
      <label for="set-mem">메모리 원격 저장소</label><div class="val"><input class="inp" id="set-mem" value="${esc(st.memoryRemote)}" placeholder="비우면 로컬 git에만 기록"></div>
      <label for="set-arch">보관 기간(일)</label><div class="val"><input class="inp" id="set-arch" type="number" min="1" max="90" value="${st.archiveDays}" style="width:80px"></div>
      <label for="set-noti">알림</label><div class="val"><input class="switch" id="set-noti" type="checkbox" ${st.notifications ? 'checked' : ''}></div>
    </div></div>
    <div><h3>화면</h3><div class="group form">
      <label for="set-font">글꼴</label><div class="val"><input class="inp" id="set-font" list="font-list" value="${esc(st.fontFamily)}" placeholder="비우면 시스템 글꼴 (쉼표로 여러 개, 예: Pretendard, Malgun Gothic)"><datalist id="font-list">${FONT_SUGGESTIONS.map((f) => `<option value="${esc(f)}">`).join('')}</datalist></div>
      <label for="set-fsize">글자 크기(px)</label><div class="val"><input class="inp" id="set-fsize" type="number" min="${FONT_SIZE_MIN}" max="${FONT_SIZE_MAX}" step="1" value="${st.fontSize}" style="width:80px"><button class="btn" data-action="font-reset">기본값</button></div>
    </div><p class="note" style="margin-top:6px">고치는 대로 바로 미리 볼 수 있어요. 저장하지 않고 닫으면 원래대로 돌아가요. 코드와 로그는 고정폭 글꼴을 그대로 쓰고, 크기만 같이 바뀌어요.</p></div>
    <div><h3>모델</h3><div class="group form">
      <label for="set-dm">Dispatcher</label><div class="val"><input class="inp" id="set-dm" value="${esc(st.dispatcherModel)}"></div>
      <label for="set-wm">Worker</label><div class="val"><input class="inp" id="set-wm" value="${esc(st.workerModel)}"></div>
      <label for="set-fm">설계 작업</label><div class="val"><input class="inp" id="set-fm" value="${esc(st.designModel)}"></div>
    </div></div>
    <div class="foot"><button class="btn" data-action="close-settings">닫기</button><button class="btn def" data-action="save-settings">저장</button></div>
  </div>`;
  $('#sheet').hidden = false;
  for (const id of ['#set-font', '#set-fsize']) $(id).addEventListener('input', previewFont);
}

function closeSettings() {
  ui.settingsShown = false;
  $('#sheet').hidden = true;
  $('#sheet').innerHTML = '';
  // 저장하지 않은 미리보기는 되돌린다(저장했으면 S.settings가 이미 새 값이다).
  if (S) applyFont(S.settings.fontFamily, S.settings.fontSize);
}

/* ---------- 전체 그리기 ---------- */

function setView(v: typeof ui.view) {
  ui.view = v;
  document.querySelectorAll<HTMLButtonElement>('.seg button').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.v === v)));
  document.querySelectorAll<HTMLElement>('.view').forEach((el) => { el.hidden = el.dataset.view !== v; });
  if (v === 'memory') void loadMemory();
  renderAll(true);
}

function renderAll(force = false) {
  if (!S) return;
  document.body.classList.toggle('modal', ui.settingsShown);
  // 설정 시트가 열려 있으면 미리보기를 덮어쓰지 않는다.
  if (!ui.settingsShown) applyFont(S.settings.fontFamily, S.settings.fontSize);
  renderSidebar();
  renderUsage();
  if (ui.view === 'chat') { renderChat(force); renderChatInspector(); }
  if (ui.view === 'worker') { renderWorkerList(); renderSession(force); renderWorkerInspector(); }
  if (ui.view === 'repo') renderRepos();
  if (ui.view === 'memory' && force) renderMemory();
}

function openWorker(id: string) {
  if (!id) return;
  ui.wSel = id;
  ui.wOpen = true;
  ui.lastLogKey = '';
  if (ui.view !== 'worker') setView('worker');
  void loadLog(id);
  renderAll(true);
}

/* ---------- 동작 ---------- */

async function act(el: HTMLElement, e: Event) {
  const a = el.dataset.action!;
  const id = el.dataset.id ?? '';
  switch (a) {
    case 'view': setView(el.dataset.v as any); break;
    case 'open-settings': openSettings(); break;
    case 'close-settings': closeSettings(); break;
    case 'goto-decision': {
      setView('chat');
      const card = document.getElementById(`dec-${id}`);
      card?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
      card?.classList.remove('flash'); void card?.offsetWidth; card?.classList.add('flash');
      break;
    }
    case 'open-worker': openWorker(id); break;
    case 'select-worker': openWorker(id); break;
    case 'close-session': ui.wOpen = false; renderAll(true); break;
    case 'answer': {
      el.closest('.dec')?.querySelectorAll('button').forEach((b) => ((b as HTMLButtonElement).disabled = true));
      await call('decision:answer', id, el.dataset.val);
      break;
    }
    case 'open-url': e.preventDefault(); await call('open:external', el.dataset.href); break;
    case 'open-file': e.preventDefault(); await call('open:path', el.dataset.path); break;
    case 'reveal': e.preventDefault(); await call('reveal:path', el.dataset.path); break;
    case 'clear': {
      const kind = el.dataset.kind as 'result' | 'auto';
      const ids = kind === 'auto' ? S!.autoAnswers.filter((x) => !x.cleared).map((x) => x.id) : S!.chat.filter((c) => (c.kind === 'result' || c.kind === 'error') && !c.cleared).map((c) => c.id);
      ui.undo.push({ kind, ids });
      await call('chat:clear', kind);
      toast(`${kind === 'auto' ? '대신 답한 것' : '결과'} 목록을 정리했어요. ${navigator.platform.startsWith('Mac') ? '⌘Z' : 'Ctrl+Z'}로 되돌릴 수 있어요.`);
      break;
    }
    case 'aa-select': {
      if (ui.view !== 'chat') setView('chat');
      ui.aaSel = id;
      renderChatInspector();
      document.getElementById(`aa-${id}`)?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
      break;
    }
    case 'aa-edit': ui.aaEdit = id; ui.aaSel = id; renderChatInspector(); (document.querySelector(`[data-keep="aa-${id}"]`) as HTMLInputElement | null)?.focus(); break;
    case 'aa-cancel': ui.aaEdit = null; renderChatInspector(); break;
    case 'aa-send': {
      const inp = document.querySelector<HTMLInputElement>(`[data-keep="aa-${id}"]`);
      const v = inp?.value.trim();
      if (!v) { inp?.focus(); return; }
      const scope = (document.querySelector<HTMLInputElement>(`input[name="scope-${id}"]:checked`)?.value ?? 'once') as 'once' | 'preference';
      ui.aaEdit = null;
      await call('auto:correct', id, v, scope);
      break;
    }
    case 'worker-stop': await call('worker:stop', id); break;
    case 'worker-archive': await call('worker:archive', id); break;
    case 'worker-unarchive': await call('worker:unarchive', id); break;
    case 'worker-msg': openWorker(id); setTimeout(() => $('#ws-input').focus(), 30); break;
    case 'repo-select': ui.repoSel = id; renderRepos(); break;
    case 'repo-save': await call('repo:update', id, $<HTMLTextAreaElement>('#repo-desc').value); toast('설명을 저장했어요.'); break;
    case 'repo-remove': {
      if (!confirm(`${id} 저장소 등록을 해제할까요? 받아 둔 폴더는 지우지 않아요.`)) return;
      await call('repo:remove', id);
      ui.repoSel = null;
      break;
    }
    case 'mem-select': {
      ui.memSel = id;
      ui.memText = (await call<string>('memory:read', id)) ?? '';
      renderMemory();
      break;
    }
    case 'mem-save': {
      if (!ui.memSel) return;
      ui.memText = $<HTMLTextAreaElement>('#mem-edit').value;
      await call('memory:write', ui.memSel, ui.memText);
      toast('메모리를 저장했어요.');
      void loadMemory();
      break;
    }
    case 'mem-promote': {
      if (!S!.repos.some((r) => r.name === id)) { toast(`${id} 저장소가 등록돼 있지 않아요.`, true); return; }
      const tid = await call<string>('memory:promote', id);
      if (tid) toast(`${tid}로 맡겼어요. 결과는 대화에 올라와요.`);
      break;
    }
    case 'acc-add': {
      const label = $<HTMLInputElement>('#acc-label').value;
      const token = $<HTMLInputElement>('#acc-token').value;
      const r = await call('account:add', label, 'token', token);
      if (r) { toast('계정을 추가했어요.'); setTimeout(openSettings, 200); }
      break;
    }
    case 'acc-add-login': {
      const label = $<HTMLInputElement>('#acc-label').value || '이 PC 로그인';
      const r = await call('account:add', label, 'login', '');
      if (r) { toast('이 PC의 Claude Code 로그인을 계정으로 추가했어요.'); setTimeout(openSettings, 200); }
      break;
    }
    case 'acc-remove': {
      if (!confirm('이 계정을 삭제할까요? 저장된 토큰도 지워져요.')) return;
      await call('account:remove', id);
      setTimeout(openSettings, 200);
      break;
    }
    case 'acc-rename': {
      const cur = S!.accounts.find((x) => x.id === id)?.label ?? '';
      const nv = prompt('계정 이름', cur);
      if (nv && nv.trim()) { await call('account:rename', id, nv); setTimeout(openSettings, 200); }
      break;
    }
    case 'pick-home': {
      const p = await call<string | null>('settings:pickHome');
      if (p) $<HTMLInputElement>('#set-home').value = p;
      break;
    }
    case 'font-reset': {
      $<HTMLInputElement>('#set-font').value = '';
      $<HTMLInputElement>('#set-fsize').value = String(FONT_SIZE_DEFAULT);
      previewFont();
      break;
    }
    case 'save-settings': {
      const patch = {
        home: $<HTMLInputElement>('#set-home').value.trim(),
        githubHost: $<HTMLInputElement>('#set-gh').value.trim().replace(/^https?:\/\//, '').replace(/\/$/, ''),
        memoryRemote: $<HTMLInputElement>('#set-mem').value.trim(),
        archiveDays: Math.max(1, Number($<HTMLInputElement>('#set-arch').value) || 7),
        notifications: $<HTMLInputElement>('#set-noti').checked,
        dispatcherModel: $<HTMLInputElement>('#set-dm').value.trim(),
        workerModel: $<HTMLInputElement>('#set-wm').value.trim(),
        designModel: $<HTMLInputElement>('#set-fm').value.trim(),
        fontFamily: normalizeFontFamily($<HTMLInputElement>('#set-font').value),
        fontSize: clampFontSize($<HTMLInputElement>('#set-fsize').value),
      };
      const r = await call<{ restart: boolean }>('settings:save', patch);
      if (!r) return;
      Object.assign(S!.settings, patch); // 새 상태가 오기 전에 닫아도 새 글꼴이 유지되게
      closeSettings();
      if (r.restart) {
        if (confirm('IDE 홈 폴더가 바뀌었어요. 지금 다시 시작할까요? 기존 폴더의 데이터는 옮기지 않아요.')) await call('app:relaunch');
      } else toast('설정을 저장했어요.');
      break;
    }
  }
}

function autosize(t: HTMLTextAreaElement) {
  t.style.height = 'auto';
  t.style.height = Math.min(180, t.scrollHeight) + 'px';
}

function bindComposer(formSel: string, inputSel: string, send: (text: string) => Promise<void> | void) {
  const form = $<HTMLFormElement>(formSel);
  const input = $<HTMLTextAreaElement>(inputSel);
  input.addEventListener('input', () => { autosize(input); updateSendButton(); });
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing && e.keyCode !== 229) {
      e.preventDefault();
      form.requestSubmit();
    }
  });
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const text = input.value.trim();
    if (!text) return;
    input.value = '';
    autosize(input);
    updateSendButton();
    await send(text);
  });
}

function init() {
  document.body.classList.add(`platform-${ide.platform}`);
  document.addEventListener('click', (e) => {
    const el = (e.target as HTMLElement).closest<HTMLElement>('[data-action]');
    if (el) void act(el, e);
    if (!(e.target as HTMLElement).closest('#ctxmenu')) $('#ctxmenu').hidden = true;
  });
  document.querySelectorAll<HTMLButtonElement>('.seg button').forEach((b) => b.addEventListener('click', () => setView(b.dataset.v as any)));
  $('#sheet').addEventListener('click', (e) => { if (e.target === $('#sheet')) closeSettings(); });

  // 입력 칸에서 Enter: data-enter에 적힌 동작 실행
  document.addEventListener('keydown', (e) => {
    const t = e.target as HTMLElement;
    if (e.key === 'Enter' && !e.isComposing && e.keyCode !== 229 && t.dataset?.enter) {
      e.preventDefault();
      if (t.dataset.enter === 'answer-custom') {
        const v = (t as HTMLInputElement).value.trim();
        if (v) void call('decision:answer', t.dataset.id, v);
      } else if (t.dataset.enter === 'aa-send') {
        void act(Object.assign(document.createElement('button'), { dataset: { action: 'aa-send', id: t.dataset.id } }) as HTMLElement, e);
      }
      return;
    }
    if (e.key === 'Escape') {
      if (ui.settingsShown) closeSettings();
      $('#ctxmenu').hidden = true;
      if (ui.aaEdit) { ui.aaEdit = null; renderChatInspector(); }
    }
    const mod = e.metaKey || e.ctrlKey;
    if (mod && e.key.toLowerCase() === 'z' && !e.shiftKey) {
      if (t.matches('input, textarea')) return;
      const u = ui.undo.pop();
      if (u) { e.preventDefault(); void call('chat:unclear', u.kind, u.ids); toast('되돌렸어요.'); }
    }
    if (mod && e.key === ',') { e.preventDefault(); openSettings(); }
    if (mod && /^[1-4]$/.test(e.key)) { e.preventDefault(); setView((['chat', 'worker', 'repo', 'memory'] as const)[Number(e.key) - 1]); }
  });

  // 우클릭 메뉴: 대신 답한 것
  document.addEventListener('contextmenu', (e) => {
    const el = (e.target as HTMLElement).closest<HTMLElement>('[data-ctx="aa"]');
    const menu = $('#ctxmenu');
    if (!el) { menu.hidden = true; return; }
    e.preventDefault();
    const id = el.dataset.id!;
    menu.innerHTML = `<button data-action="aa-edit" data-id="${id}">정정…</button><button data-action="view" data-v="memory">메모리 보기</button>`;
    menu.style.left = `${Math.min(e.clientX, innerWidth - 200)}px`;
    menu.style.top = `${Math.min(e.clientY, innerHeight - 90)}px`;
    menu.hidden = false;
  });

  bindComposer('#chat-form', '#chat-input', async (text) => { await call('chat:send', text); });
  $('#chat-send').addEventListener('click', (e) => {
    if ($('#chat-send').classList.contains('stop')) { e.preventDefault(); void call('chat:stop'); }
  });
  bindComposer('#ws-form', '#ws-input', async (text) => {
    if (!ui.wSel) return;
    await call('worker:send', ui.wSel, text);
  });

  let memTimer: number | undefined;
  $<HTMLInputElement>('#mem-q').addEventListener('input', (e) => {
    clearTimeout(memTimer);
    const q = (e.target as HTMLInputElement).value.trim();
    memTimer = window.setTimeout(async () => {
      ui.memHits = q ? ((await call<MemoryHit[]>('memory:search', q)) ?? []) : null;
      renderMemory();
    }, 200);
  });

  ide.onState((s) => {
    const firstSetup = !S && s.setupNeeded;
    S = s;
    renderAll();
    if (firstSetup && !ui.settingsShown) openSettings();
  });
  ide.onWorkerLog((id, item) => {
    const l = ui.logs.get(id);
    if (l) l.push(item);
    if (ui.view === 'worker' && ui.wSel === id) renderSession();
  });
  ide.onBlink(() => {
    document.querySelector('.sec-dec')?.classList.add('blink');
    $('#dec-count')?.classList.add('pulse');
    setTimeout(() => { document.querySelector('.sec-dec')?.classList.remove('blink'); }, 3500);
  });
  window.addEventListener('focus', () => renderAll());
  setInterval(() => { if (S) { renderSidebar(); if (ui.view === 'worker') renderWorkerList(); } }, 60_000);

  void ide.call<AppState>('state').then((s) => {
    S = s;
    renderAll(true);
    if (s.setupNeeded) openSettings();
  });
}

init();
