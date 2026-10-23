// Public giveaway page: info, steps, ways to enter, and the entry form.
const app = document.getElementById('app');
const id = location.pathname.split('/').pop();
const ICONS = { follow: '➕', subscribe: '🔔', join: '👥', visit: '🔗', share: '📣', comment: '💬', custom: '⭐' };
let timer;

async function load() {
  clearInterval(timer);
  let g;
  try { g = await api('GET', '/api/public/' + id); } catch (e) {
    document.title = 'Giveaway not found';
    app.replaceChildren(h('div', { class: 'card', style: 'margin-top:40px' }, h('h1', {}, 'Giveaway unavailable'), h('p', { class: 'muted' }, e.message)));
    return;
  }
  document.title = g.name;
  const offset = g.serverNow - Date.now();
  const cd = h('div', { class: 'countdown', 'aria-live': 'off' });
  const target = g.phase === 'upcoming' ? Date.parse(g.start) : Date.parse(g.end);
  const tick = () => {
    const ms = target - (Date.now() + offset);
    if (ms <= 0) { load(); return; }
    const s = Math.floor(ms / 1000), d = Math.floor(s / 86400);
    const p = (n) => String(n).padStart(2, '0');
    cd.textContent = `${d ? d + 'd ' : ''}${p(Math.floor(s / 3600) % 24)}:${p(Math.floor(s / 60) % 60)}:${p(s % 60)}`;
  };
  if (g.phase === 'open' || g.phase === 'upcoming') { tick(); timer = setInterval(tick, 1000); }

  app.replaceChildren(
    g.bannerUrl && h('img', { class: 'banner', src: g.bannerUrl, alt: '', referrerpolicy: 'no-referrer' }),
    h('div', { style: 'margin-top:24px' },
      h('h1', {}, g.name),
      g.prize && h('p', {}, h('span', { class: 'prize' }, '🏆 ' + g.prize)),
      g.description && h('p', { class: 'pre' }, g.description)),
    h('div', { class: 'card' },
      h('div', { class: 'row between' },
        h('div', {}, h('div', { class: 'muted' }, 'Starts'), h('b', {}, fmtDate(g.start, g.timezone))),
        h('div', {}, h('div', { class: 'muted' }, 'Ends'), h('b', {}, fmtDate(g.end, g.timezone)))),
      (g.phase === 'open' || g.phase === 'upcoming') && h('div', { style: 'margin-top:12px' }, h('div', { class: 'muted' }, g.phase === 'open' ? 'Time left' : 'Starts in'), cd)),
    g.steps.length > 0 && h('div', { class: 'card' }, h('h2', {}, 'How it works'),
      h('ol', { class: 'steps' }, g.steps.map((s) => h('li', {}, h('div', {}, h('b', {}, s.title), s.text && h('div', { class: 'muted pre' }, s.text)))))),
    g.phase === 'open' && enterForm(g),
    g.phase === 'ended' && h('div', { class: 'card success' },
      h('div', { class: 'big' }, '🏁'), h('h2', {}, 'This giveaway has ended'),
      g.winners?.length ? h('div', {}, h('p', { class: 'muted' }, 'Congratulations to the winner' + (g.winners.length > 1 ? 's' : '') + ':'), h('p', {}, h('b', {}, g.winners.join(', '))))
        : h('p', { class: 'muted' }, 'Thanks to everyone who entered.')),
    g.rules && h('details', { class: 'card' }, h('summary', {}, h('b', {}, 'Rules & terms')), h('p', { class: 'pre' }, g.rules)),
  );
}

function enterForm(g) {
  const done = new Set(), visited = new Set();
  const answers = {};
  const total = h('b', {}, '1');
  const err = h('p', { class: 'error', role: 'alert' });
  const updateTotal = () => { total.textContent = String(1 + g.entryMethods.filter((m) => done.has(m.id)).reduce((s, m) => s + m.points, 0)); };

  const methodEls = g.entryMethods.map((m) => {
    const box = h('input', { type: 'checkbox', id: 'm-' + m.id, disabled: !!m.url });
    const card = h('div', { class: 'method' });
    box.addEventListener('change', () => { box.checked ? done.add(m.id) : done.delete(m.id); card.classList.toggle('done', box.checked); updateTotal(); });
    const open = m.url && h('a', { class: 'btn small', href: m.url, target: '_blank', rel: 'noopener noreferrer', onclick: () => { visited.add(m.id); box.disabled = false; hint.textContent = 'Tick the box once you have done it.'; } }, 'Open ↗');
    const hint = h('small', { class: 'muted' }, m.url ? 'Open the link first, then tick the box.' : '');
    card.append(
      h('span', { class: 'ico', 'aria-hidden': 'true' }, ICONS[m.type] || '⭐'),
      h('div', {}, h('b', {}, m.title), ' ', m.points > 0 && h('span', { class: 'badge' }, `+${m.points} ${m.points === 1 ? 'entry' : 'entries'}`), ' ', m.required && h('span', { class: 'badge' }, 'REQUIRED'),
        m.description && h('div', { class: 'muted' }, m.description), hint),
      h('div', { class: 'row' }, open, h('label', { class: 'check', for: 'm-' + m.id }, box, h('span', {}, 'Done'))));
    return card;
  });

  const fields = g.form.fields.map((f) => {
    const id = 'f-' + f.id;
    const label = f.label + (f.required && f.type !== 'checkbox' ? ' *' : '');
    if (f.type === 'checkbox') {
      const el = h('input', { type: 'checkbox', id }); el.addEventListener('change', () => { answers[f.id] = el.checked; });
      return h('label', { class: 'check', for: id }, el, h('span', {}, f.label + (f.required ? ' *' : '')));
    }
    let el;
    if (f.type === 'textarea') el = h('textarea', { id, rows: 3, maxlength: 1000 });
    else if (f.type === 'select') el = h('select', { id }, h('option', { value: '' }, 'Choose…'), f.options.map((o) => h('option', { value: o }, o)));
    else el = h('input', { id, type: f.type === 'email' ? 'email' : f.type === 'url' ? 'url' : 'text', maxlength: 200, autocomplete: f.id === 'email' ? 'email' : f.id === 'name' ? 'name' : 'off' });
    el.addEventListener('input', () => { answers[f.id] = el.value; });
    return h('label', { class: 'field', for: id }, h('span', {}, label), el);
  });

  const btn = h('button', { class: 'btn primary', type: 'submit' }, g.form.submitLabel);
  const hp = h('input', { class: 'hp', type: 'text', name: 'website', tabindex: '-1', autocomplete: 'off', 'aria-hidden': 'true' });
  const form = h('form', { class: 'stack', novalidate: '', onsubmit: async (e) => {
    e.preventDefault(); err.textContent = ''; btn.disabled = true;
    try {
      const r = await api('POST', `/api/public/${id}/enter`, { answers, methods: [...done], hp: hp.value });
      form.parentElement.replaceWith(h('div', { class: 'card success' }, h('div', { class: 'big' }, '🎉'), h('h2', {}, r.message),
        h('p', { class: 'muted' }, `You have ${r.entries} ${r.entries === 1 ? 'entry' : 'entries'} in the draw.`)));
    } catch (ex) { err.textContent = ex.message; btn.disabled = false; }
  } }, fields, hp, err, h('div', { class: 'row between' }, h('span', {}, 'Your entries: ', total), btn));

  return h('div', {},
    g.entryMethods.length > 0 && h('div', { class: 'card' }, h('h2', {}, 'Ways to enter'),
      h('p', { class: 'muted' }, 'You get 1 entry for entering. Complete extras for more chances. We trust you to be honest.'), methodEls),
    h('div', { class: 'card' }, h('h2', {}, g.form.title), form));
}

load();
