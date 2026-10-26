// Public giveaway page: a ticket up top, steps, ways to enter, and the entry form with a live ticket count.
const app = document.getElementById('app');
const id = location.pathname.split('/').pop();
let timer;

function countdown(target, offset) {
  const bs = [], box = h('div', { class: 'count', role: 'timer' });
  for (const label of ['days', 'hrs', 'min', 'sec']) {
    const b = h('b', {}, '00');
    bs.push(b);
    box.append(h('div', {}, b, h('small', {}, label)));
  }
  const tick = () => {
    const ms = target - (Date.now() + offset);
    if (ms <= 0) { clearInterval(timer); setTimeout(load, 1500); return; } // delay avoids a reload loop if clocks differ slightly
    const s = Math.floor(ms / 1000);
    [Math.floor(s / 86400), Math.floor(s / 3600) % 24, Math.floor(s / 60) % 60, s % 60].forEach((n, i) => { bs[i].textContent = String(n).padStart(2, '0'); });
  };
  tick();
  timer = setInterval(tick, 1000);
  return box;
}

const signInGate = () => h('section', { class: 'panel done' },
  h('h2', {}, 'Sign in to enter'),
  h('p', { class: 'muted' }, 'Sign in with Google so everyone gets one entry. We see your name and email, nothing else.'),
  h('a', { class: 'btn primary big', href: '/auth/enter/' + id }, 'Sign in with Google'));

const signedInBar = (u) => h('p', { class: 'muted', style: 'margin:0' }, 'Signed in as ', h('b', {}, u.email), ' ',
  h('button', { type: 'button', class: 'btn small', onclick: async () => { await api('POST', '/api/public/signout', {}); load(); } }, 'Use a different account'));

async function load() {
  clearInterval(timer);
  let g;
  try { g = await api('GET', '/api/public/' + id); } catch (e) {
    document.title = 'Giveaway not found';
    mount(app, h('section', { class: 'panel done' }, h('h1', {}, 'Giveaway unavailable'), h('p', { class: 'muted' }, e.message)));
    return;
  }
  document.title = g.name;
  const shut = g.stopped || g.full; // closed early by date, or every spot is taken
  const taking = g.phase === 'open' && !shut; // entries can still come in
  const live = taking || g.phase === 'upcoming';
  const lastDay = g.stop || g.end;
  const stubRight = live
    ? h('div', {}, h('div', { class: 'muted-on-ticket', style: 'font-size:.82rem;opacity:.75;margin-bottom:6px' }, taking ? 'Closes in' : 'Opens in'),
      countdown(Date.parse(taking ? lastDay : g.start), g.serverNow - Date.now()))
    : h('span', { class: 'closed-tag' }, 'Closed');

  mount(app, 
    h('article', { class: 'ticket' },
      g.bannerUrl && h('img', { class: 'ticket-banner', src: g.bannerUrl, alt: '', referrerpolicy: 'no-referrer' }),
      h('div', { class: 'ticket-body' },
        g.prize && h('p', { class: 'prize' }, g.prize),
        h('h1', {}, g.name),
        g.description && h('p', { class: 'desc' }, g.description)),
      h('div', { class: 'perf' }),
      h('div', { class: 'ticket-stub' },
        h('div', { class: 'when' },
          h('div', {}, h('span', {}, 'Opens'), h('b', {}, fmtDate(g.start, g.timezone))),
          h('div', {}, h('span', {}, 'Closes'), h('b', {}, fmtDate(lastDay, g.timezone)))),
        stubRight)),
    g.steps.length > 0 && h('section', { class: 'panel' }, h('h2', {}, 'How it works'),
      h('ol', { class: 'steps' }, g.steps.map((s) => h('li', {}, h('div', {}, h('b', {}, s.title), s.text && h('span', { class: 'muted pre' }, s.text)))))),
    taking && (g.requireLogin && !g.guest ? signInGate() : enterForm(g)),
    g.phase === 'open' && shut && h('section', { class: 'panel done' },
      h('h2', {}, g.full ? 'This giveaway is full' : 'Entries are closed'), h('p', { class: 'muted' }, 'Thanks to everyone who entered. Winners will be drawn soon.')),
    g.phase === 'ended' && h('section', { class: 'panel done' },
      h('h2', {}, 'This giveaway has ended'),
      g.winners?.length
        ? [h('p', { class: 'muted' }, 'Congratulations to the winner' + (g.winners.length > 1 ? 's' : '') + ':'), h('div', { class: 'winners' }, g.winners.map((n) => h('span', {}, n)))]
        : h('p', { class: 'muted' }, 'Thanks to everyone who entered.')),
    g.rules && h('details', { class: 'panel' }, h('summary', {}, 'Rules and terms'), h('p', { class: 'pre', style: 'margin:12px 0 0' }, g.rules)),
  );
}

function enterForm(g) {
  const done = new Set(), answers = {};
  const total = h('span', { class: 'n' }, '1');
  const err = h('p', { class: 'error', role: 'alert' });
  const bump = () => {
    total.textContent = String(1 + g.entryMethods.filter((m) => done.has(m.id)).reduce((s, m) => s + m.points, 0));
    total.classList.remove('bump'); void total.offsetWidth; total.classList.add('bump');
  };

  const methods = g.entryMethods.map((m) => {
    const box = h('input', { type: 'checkbox', disabled: !!m.url });
    const hint = m.url && h('div', { class: 'm-text' }, 'Open the link first, then tick the box.');
    box.addEventListener('change', () => { box.checked ? done.add(m.id) : done.delete(m.id); bump(); });
    const open = m.url && h('a', {
      class: 'btn small', href: m.url, target: '_blank', rel: 'noopener noreferrer',
      onclick: () => { box.disabled = false; hint.textContent = 'Tick the box once you have done it.'; },
    }, 'Open');
    return h('label', { class: 'method' },
      h('span', { class: 'plus', 'aria-hidden': 'true' }, '+' + m.points),
      h('div', {},
        h('div', { class: 'm-title' }, m.title, m.required && h('span', { class: 'req' }, 'Required')),
        m.description && h('div', { class: 'm-text' }, m.description), hint, open && h('div', { class: 'm-open' }, open),
        h('span', { class: 'sr-only' }, `${m.points} bonus ${m.points === 1 ? 'entry' : 'entries'}`)),
      h('div', { class: 'm-side' }, box));
  });

  const fields = g.form.fields.map((f) => {
    const fid = 'f-' + f.id;
    if (f.type === 'checkbox') {
      const el = h('input', { type: 'checkbox', id: fid });
      el.addEventListener('change', () => { answers[f.id] = el.checked; });
      return h('label', { class: 'check', for: fid }, el, h('span', {}, f.label + (f.required ? ' *' : '')));
    }
    let el;
    if (f.type === 'textarea') el = h('textarea', { id: fid, rows: 3, maxlength: 1000 });
    else if (f.type === 'select') el = h('select', { id: fid }, h('option', { value: '' }, 'Choose…'), f.options.map((o) => h('option', { value: o }, o)));
    else el = h('input', { id: fid, type: f.type === 'email' ? 'email' : f.type === 'url' ? 'url' : 'text', maxlength: 200, autocomplete: f.id === 'email' ? 'email' : f.id === 'name' ? 'name' : 'off' });
    if (g.requireLogin && f.id === 'email') { el.value = g.guest.email; el.readOnly = true; answers.email = g.guest.email; } // comes from Google
    if (g.requireLogin && f.id === 'name') { el.value = g.guest.name; answers.name = g.guest.name; }
    el.addEventListener('input', () => { answers[f.id] = el.value; });
    return h('label', { class: 'field', for: fid }, h('span', {}, f.label + (f.required ? ' *' : '')), el);
  });

  const btn = h('button', { class: 'btn big', type: 'submit' }, g.form.submitLabel);
  const hp = h('input', { class: 'hp', type: 'text', name: 'website', tabindex: '-1', autocomplete: 'off', 'aria-hidden': 'true' });
  const form = h('form', { class: 'enter', novalidate: '', onsubmit: async (e) => {
    e.preventDefault(); err.textContent = ''; btn.disabled = true;
    try {
      const r = await api('POST', `/api/public/${id}/enter`, { answers, methods: [...done], hp: hp.value });
      const ok = h('section', { class: 'panel done' },
        h('h2', {}, r.message),
        h('p', { class: 'big' }, String(r.entries)),
        h('p', { class: 'muted' }, r.entries === 1 ? 'ticket in the draw' : 'tickets in the draw'),
        r.entryId && h('span', { class: 'serial' }, 'Entry ' + r.entryId));
      form.replaceWith(ok);
      ok.scrollIntoView({ block: 'center' });
    } catch (ex) {
      if (ex.status === 401) return load(); // signed out in another tab: show the sign-in step again
      err.textContent = ex.message; btn.disabled = false;
      err.scrollIntoView({ block: 'center' });
    }
  } },
  methods.length > 0 && h('section', { class: 'panel' }, h('h2', {}, 'Ways to enter'),
    h('p', { class: 'muted' }, 'Entering gives you 1 ticket. Each extra you complete adds more. We trust you to be honest.'), methods),
  h('section', { class: 'panel stack' }, h('h2', {}, g.form.title), g.guest && signedInBar(g.guest), fields, hp, err),
  h('div', { class: 'entry-bar' },
    h('div', { class: 'tickets' }, total, h('span', { class: 'lbl' }, 'Your', h('br'), 'tickets')),
    btn));
  return form;
}

load();
