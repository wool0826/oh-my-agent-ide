// The quick message box: one line to the Dispatcher from anywhere, then it goes away (decision 123).
(() => {
  const form = document.getElementById('f');
  const input = document.getElementById('q');
  const go = document.getElementById('go');
  let text = { ph: '', sent: '', lang: 'en', theme: 'dark' };
  let busy = false;

  async function load() {
    try { text = await window.ide.call('quick:text'); } catch { /* keeps the last */ }
    document.documentElement.lang = text.lang;
    document.documentElement.dataset.theme = text.theme || 'dark';
    input.placeholder = text.ph;
  }

  function reset() {
    busy = false;
    form.classList.remove('sent');
    input.readOnly = false;
    input.value = '';
    go.disabled = true;
  }

  // Shown again: a fresh, focused field in the current language.
  window.addEventListener('focus', () => { reset(); void load(); input.focus(); });
  input.addEventListener('input', () => { go.disabled = busy || !input.value.trim(); });
  window.addEventListener('keydown', (e) => { if (e.key === 'Escape') void window.ide.call('quick:close'); });
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const v = input.value.trim();
    if (!v || busy) return;
    busy = true;
    go.disabled = true;
    try {
      await window.ide.call('quick:send', v);
      form.classList.add('sent');
      input.readOnly = true;
      input.value = text.sent;
      setTimeout(() => void window.ide.call('quick:close'), 700);
    } catch (err) {
      busy = false;
      input.value = v;
      go.disabled = false;
      input.title = String(err && err.message ? err.message : err);
    }
  });
  void load();
})();
