// Host dashboard: sign-in, giveaway list, and the giveaway editor.
const app = document.getElementById('app');
const topbar = document.getElementById('topbar');
let me = null;

const rid = () => Math.random().toString(16).slice(2, 10);
const TZS = (Intl.supportedValuesOf ? Intl.supportedValuesOf('timeZone') : ['UTC']).concat('UTC');
const METHOD_TYPES = { follow: 'Follow', subscribe: 'Subscribe', join: 'Join', visit: 'Visit', share: 'Share', comment: 'Comment', custom: 'Custom' };
const FIELD_TYPES = { text: 'Short text', textarea: 'Long text', select: 'Dropdown', checkbox: 'Checkbox', url: 'Link', email: 'Email' };

// ---------- shell ----------
function drawTop() {
  topbar.replaceChildren(
    h('a', { class: 'brand', href: '#/' }, '🎁 Giveaway Host'),
    me?.user && h('span', { class: 'muted' }, me.user.email),
    me?.user?.picture && h('img', { class: 'avatar', src: me.user.picture, alt: '', referrerpolicy: 'no-referrer' }),
    me?.user && h('button', { class: 'btn small', onclick: async () => { await api('POST', '/auth/logout'); me = { user: null }; route(); } }, 'Sign out'),
  );
}

function loginView() {
  app.replaceChildren(h('section', { class: 'hero' },
    h('h1', {}, 'Run giveaways without the spreadsheet chaos'),
    h('p', { class: 'muted' }, 'Sign in with Google. Every giveaway lives in your own Google Drive, and entries land in a Google Sheet you control.'),
    h('p', {}, h('a', { class: 'btn primary', href: '/auth/google' }, me?.mock ? 'Continue as dev host (mock mode)' : 'Sign in with Google')),
    me?.mock && h('p', { class: 'muted' }, 'Mock mode: data is kept in memory and nothing is sent to Google.'),
  ));
}

// ---------- list ----------
async function listView() {
  app.replaceChildren(h('p', { class: 'muted' }, 'Loading…'));
  const list = await api('GET', '/api/giveaways');
  const create = async () => {
    const { id } = await api('POST', '/api/giveaways', {});
    location.hash = '#/g/' + id;
  };
  app.replaceChildren(
    h('div', { class: 'row between', style: 'margin:24px 0' },
      h('h1', { style: 'margin:0' }, 'Your giveaways'),
      h('button', { class: 'btn primary', onclick: () => create().catch((e) => toast(e.message, true)) }, '+ New giveaway')),
    list.length === 0
      ? h('div', { class: 'card' }, h('p', {}, 'No giveaways yet. Create your first one to get started.'))
      : h('div', { class: 'grid' }, list.map((g) => {
        const ph = phaseOf({ status: g.status, start: g.start, end: g.end });
        return h('div', { class: 'card' },
          h('div', { class: 'row between' }, h('h3', { style: 'margin:0' }, g.name), h('span', { class: 'pill ' + ph }, ph)),
          h('p', { class: 'muted' }, 'Ends ' + new Date(g.end).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' })),
          h('div', { class: 'row' },
            h('a', { class: 'btn primary small', href: '#/g/' + g.id }, 'Manage'),
            g.status !== 'draft' && h('button', { class: 'btn small', onclick: () => copyText(location.origin + '/g/' + g.id) }, 'Copy link')));
      })),
  );
}

// ---------- editor ----------
async function editorView(id) {
  app.replaceChildren(h('p', { class: 'muted' }, 'Loading…'));
  const d = await api('GET', '/api/giveaways/' + id);
  const S = { id, cfg: d.config, entries: d.entries, winners: d.winners, sheetUrl: d.sheetUrl, tab: 'details', dirty: false, q: '' };
  const TABS = [['details', 'Details'], ['form', 'Entry form'], ['methods', 'Ways to enter'], ['steps', 'Steps'], ['entries', 'Participants'], ['winners', 'Winners']];
  let saveBtn;

  const markDirty = () => { S.dirty = true; if (saveBtn) { saveBtn.disabled = false; saveBtn.textContent = 'Save changes'; } };
  const redraw = () => draw();
  const save = async (patch) => {
    if (patch) Object.assign(S.cfg, patch);
    try {
      const r = await api('PUT', '/api/giveaways/' + id, S.cfg);
      S.cfg = r.config; S.dirty = false;
      toast('Saved');
      redraw();
    } catch (e) { toast(e.message, true); }
  };

  // --- input helpers (typing mutates state without re-rendering, so focus is kept) ---
  const field = (label, input, hint) => h('label', { class: 'field' }, h('span', {}, label), input, hint && h('small', {}, hint));
  const text = (obj, key, o = {}) => {
    const el = h(o.area ? 'textarea' : 'input', { type: o.area ? undefined : o.type || 'text', value: obj[key] ?? '', placeholder: o.ph, maxlength: o.max, rows: o.rows, min: o.min, max: o.maxN });
    el.addEventListener('input', () => { obj[key] = o.num ? el.value : el.value; markDirty(); });
    return el;
  };
  const check = (obj, key, label, dis) => {
    const el = h('input', { type: 'checkbox', checked: !!obj[key], disabled: dis });
    el.addEventListener('change', () => { obj[key] = el.checked; markDirty(); });
    return h('label', { class: 'check' }, el, h('span', {}, label));
  };
  const select = (obj, key, opts, o = {}) => {
    const el = h('select', { disabled: o.disabled }, Object.entries(opts).map(([v, l]) => h('option', { value: v }, l)));
    el.value = obj[key];
    el.addEventListener('change', () => { obj[key] = el.value; markDirty(); if (o.rerender) redraw(); });
    return el;
  };
  const listEditor = (arr, render, make, addLabel, o = {}) => h('div', {},
    arr.map((item, i) => h('div', { class: 'item' },
      h('div', { class: 'item-head' }, h('span', {}, `${o.noun} ${i + 1}`),
        h('span', { class: 'row' },
          h('button', { class: 'btn icon small', title: 'Move up', disabled: i === 0, onclick: () => { [arr[i - 1], arr[i]] = [arr[i], arr[i - 1]]; markDirty(); redraw(); } }, '↑'),
          h('button', { class: 'btn icon small', title: 'Move down', disabled: i === arr.length - 1, onclick: () => { [arr[i + 1], arr[i]] = [arr[i], arr[i + 1]]; markDirty(); redraw(); } }, '↓'),
          !item.locked && h('button', { class: 'btn icon small danger', title: 'Remove', onclick: () => { arr.splice(i, 1); markDirty(); redraw(); } }, '✕'))),
      render(item))),
    h('p', {}, h('button', { class: 'btn', onclick: () => { arr.push(make()); markDirty(); redraw(); } }, addLabel)));

  // --- tabs ---
  const tabDetails = () => {
    const c = S.cfg;
    const dateInput = (key) => {
      const el = h('input', { type: 'datetime-local', value: utcToZoned(c[key], c.timezone) });
      el.dataset.key = key;
      el.addEventListener('input', () => { const iso = zonedToUtc(el.value, c.timezone); if (iso) { c[key] = iso; markDirty(); } });
      return el;
    };
    const startEl = dateInput('start'), endEl = dateInput('end');
    const tz = h('select', {}, [...new Set(TZS)].map((z) => h('option', { value: z }, z)));
    tz.value = c.timezone;
    tz.addEventListener('change', () => { // keep the wall-clock times the host typed, reinterpret them in the new zone
      c.timezone = tz.value;
      for (const el of [startEl, endEl]) { const iso = zonedToUtc(el.value, c.timezone); if (iso) c[el.dataset.key] = iso; }
      markDirty();
    });
    return h('div', { class: 'card stack' },
      field('Giveaway name', text(c, 'name', { max: 120 })),
      h('div', { class: 'cols' }, field('Prize', text(c, 'prize', { max: 200, ph: 'e.g. $50 Steam gift card' })),
        field('Number of winners', text(c, 'winnersCount', { type: 'number', num: true, min: 1, maxN: 100 }))),
      field('Description', text(c, 'description', { area: true, rows: 5, max: 4000 })),
      field('Banner image link', text(c, 'bannerUrl', { type: 'url', ph: 'https://…' }), 'Optional. Paste an image URL.'),
      h('div', { class: 'cols' }, field('Starts', startEl), field('Ends', endEl), field('Time zone', tz)),
      field('Rules / terms', text(c, 'rules', { area: true, rows: 4, max: 6000 }), 'Shown at the bottom of the public page.'),
      check(c, 'showWinners', 'Announce winners on the public page after the giveaway ends (first name + last initial)'),
      h('div', { class: 'row end' },
        h('button', { class: 'btn danger', onclick: async () => {
          if (!confirm('Delete this giveaway? Its Google Sheet moves to your Drive trash.')) return;
          try { await api('DELETE', '/api/giveaways/' + id); location.hash = '#/'; } catch (e) { toast(e.message, true); }
        } }, 'Delete giveaway')));
  };

  const tabForm = () => {
    const f = S.cfg.form;
    return h('div', { class: 'stack' },
      h('div', { class: 'card stack' },
        h('div', { class: 'cols' }, field('Form heading', text(f, 'title', { max: 120 })), field('Submit button text', text(f, 'submitLabel', { max: 40 }))),
        field('Success message', text(f, 'successMessage', { max: 300 }))),
      h('div', { class: 'card' },
        h('h2', {}, 'Form fields'),
        h('p', { class: 'muted' }, 'Name and email are always required: email is used to stop duplicate entries and to contact winners.'),
        listEditor(f.fields, (fld) => h('div', { class: 'stack' },
          h('div', { class: 'cols' },
            field('Label', text(fld, 'label', { max: 120 })),
            field('Type', select(fld, 'type', FIELD_TYPES, { disabled: fld.locked, rerender: true }))),
          fld.type === 'select' && field('Options', (() => {
            const el = h('input', { type: 'text', value: (fld.options || []).join(', '), placeholder: 'Option A, Option B' });
            el.addEventListener('input', () => { fld.options = el.value.split(',').map((s) => s.trim()).filter(Boolean); markDirty(); });
            return el;
          })(), 'Separate with commas.'),
          check(fld, 'required', 'Required', fld.locked)),
        () => ({ id: rid(), label: 'New field', type: 'text', required: false, options: [] }), '+ Add field', { noun: 'Field' })));
  };

  const tabMethods = () => h('div', { class: 'card' },
    h('h2', {}, 'Ways to enter'),
    h('p', { class: 'muted' }, 'Everyone gets 1 entry for filling in the form. Each method below adds bonus entries. Participants confirm they completed a method (honor system, the app cannot verify actions on other sites).'),
    listEditor(S.cfg.entryMethods, (m) => h('div', { class: 'stack' },
      h('div', { class: 'cols' }, field('Entry title', text(m, 'title', { max: 120, ph: 'Follow us on Twitter' })), field('Type', select(m, 'type', METHOD_TYPES))),
      h('div', { class: 'cols' }, field('Link (optional)', text(m, 'url', { type: 'url', ph: 'https://…' })), field('Bonus entries', text(m, 'points', { type: 'number', num: true, min: 0, maxN: 100 }))),
      field('Short description', text(m, 'description', { max: 300 })),
      check(m, 'required', 'Required to enter')),
    () => ({ id: rid(), type: 'custom', title: 'New way to enter', description: '', url: '', points: 1, required: false }), '+ Add way to enter', { noun: 'Method' }));

  const tabSteps = () => h('div', { class: 'card' },
    h('h2', {}, 'How it works'),
    h('p', { class: 'muted' }, 'Numbered steps shown to participants on the public page.'),
    listEditor(S.cfg.steps, (s) => h('div', { class: 'stack' },
      field('Step title', text(s, 'title', { max: 120 })),
      field('Details', text(s, 'text', { area: true, rows: 2, max: 600 }))),
    () => ({ id: rid(), title: 'New step', text: '' }), '+ Add step', { noun: 'Step' }));

  const tabEntries = () => {
    const tbody = h('tbody');
    const total = S.entries.reduce((s, e) => s + e.entries, 0);
    const fill = () => {
      const q = S.q.toLowerCase();
      const rows = S.entries.filter((e) => !q || e.name.toLowerCase().includes(q) || e.email.toLowerCase().includes(q));
      tbody.replaceChildren(...(rows.length ? rows.map((e) => h('tr', {}, h('td', {}, e.name), h('td', {}, e.email), h('td', {}, String(e.entries)),
        h('td', {}, new Date(e.ts).toLocaleString([], { dateStyle: 'short', timeStyle: 'short' })))) : [h('tr', {}, h('td', { colspan: 4, class: 'muted' }, 'No entries to show.'))]));
    };
    const search = h('input', { type: 'text', placeholder: 'Search name or email', value: S.q });
    search.addEventListener('input', () => { S.q = search.value; fill(); });
    fill();
    return h('div', { class: 'card stack' },
      h('div', { class: 'stats' },
        h('div', { class: 'stat' }, h('b', {}, String(S.entries.length)), 'participants'),
        h('div', { class: 'stat' }, h('b', {}, String(total)), 'total entries')),
      h('div', { class: 'row' },
        h('button', { class: 'btn', onclick: async () => { try { const r = await api('GET', '/api/giveaways/' + id); S.entries = r.entries; S.winners = r.winners; redraw(); } catch (e) { toast(e.message, true); } } }, '↻ Refresh'),
        h('a', { class: 'btn', href: `/api/giveaways/${id}/export.csv` }, 'Export CSV'),
        S.sheetUrl && h('a', { class: 'btn', href: S.sheetUrl, target: '_blank', rel: 'noopener' }, 'Open Google Sheet ↗'),
        h('span', { style: 'flex:1' }), search),
      h('div', { class: 'table-wrap' }, h('table', {}, h('thead', {}, h('tr', {}, ['Name', 'Email', 'Entries', 'Entered'].map((t) => h('th', {}, t)))), tbody)));
  };

  const tabWinners = () => {
    const drawn = new Set(S.winners.map((w) => w.entryId));
    const eligible = S.entries.filter((e) => !drawn.has(e.id));
    const active = S.winners.filter((w) => w.status === 'active');
    const countEl = h('input', { type: 'number', min: 1, max: 100, value: String(S.cfg.winnersCount), style: 'width:90px' });
    const run = async (url, body, okMsg) => {
      try { const r = await api('POST', `/api/giveaways/${id}/${url}`, body); S.winners = r.winners; toast(okMsg); redraw(); } catch (e) { toast(e.message, true); }
    };
    const early = phaseOf(S.cfg) === 'open';
    return h('div', { class: 'stack' },
      h('div', { class: 'card stack' },
        h('div', { class: 'stats' },
          h('div', { class: 'stat' }, h('b', {}, String(eligible.length)), 'eligible entrants'),
          h('div', { class: 'stat' }, h('b', {}, String(active.length)), 'current winners')),
        h('p', { class: 'muted' }, 'Draws are random and weighted by each person\'s total entries. Anyone already drawn (including rerolled winners) can\'t be picked again.'),
        h('div', { class: 'row' },
          h('label', { class: 'row' }, 'Winners to draw', countEl),
          h('button', { class: 'btn primary', disabled: !eligible.length, onclick: () => {
            if (early && !confirm('The giveaway is still open. Draw anyway?')) return;
            run('draw', { count: parseInt(countEl.value, 10) || 1, force: early }, 'Winners drawn');
          } }, '🎲 Draw winners'))),
      S.winners.length > 0 && h('div', { class: 'card stack' },
        h('div', { class: 'row between' }, h('h2', { style: 'margin:0' }, 'Winners'),
          h('button', { class: 'btn small', disabled: !active.length, onclick: () => copyText(active.map((w) => w.email).join(', ')) }, 'Copy winner emails')),
        h('div', { class: 'table-wrap' }, h('table', {},
          h('thead', {}, h('tr', {}, ['Name', 'Email', 'Status', 'Drawn', 'Note', ''].map((t) => h('th', {}, t)))),
          h('tbody', {}, S.winners.slice().reverse().map((w) => h('tr', {},
            h('td', {}, w.name), h('td', {}, w.email), h('td', {}, h('span', { class: 'pill ' + w.status }, w.status)),
            h('td', {}, new Date(w.ts).toLocaleString([], { dateStyle: 'short', timeStyle: 'short' })), h('td', { class: 'muted' }, w.note),
            h('td', {}, w.status === 'active' && h('button', { class: 'btn small', onclick: () => {
              if (confirm(`Reroll ${w.name}? They'll be marked as rerolled and a new winner is drawn.`)) run('reroll', { winnerId: w.id }, 'Rerolled');
            } }, '↻ Reroll')))))))));
  };

  // --- layout ---
  function draw() {
    const c = S.cfg, ph = phaseOf(c), published = c.status !== 'draft';
    const link = location.origin + '/g/' + id;
    saveBtn = h('button', { class: 'btn primary', disabled: !S.dirty, onclick: () => save() }, S.dirty ? 'Save changes' : 'Saved');
    const body = { details: tabDetails, form: tabForm, methods: tabMethods, steps: tabSteps, entries: tabEntries, winners: tabWinners }[S.tab]();
    app.replaceChildren(
      h('p', { style: 'margin:16px 0 0' }, h('a', { href: '#/' }, '← All giveaways')),
      h('div', { class: 'row between', style: 'margin-top:8px' },
        h('div', { class: 'row' }, h('h1', { style: 'margin:0' }, c.name), h('span', { class: 'pill ' + ph }, ph)),
        h('div', { class: 'row' },
          saveBtn,
          c.status === 'published' && h('button', { class: 'btn', onclick: () => { if (confirm('Close this giveaway now? Entries stop immediately.')) save({ status: 'closed' }); } }, 'Close now'),
          c.status === 'closed' && h('button', { class: 'btn', onclick: () => save({ status: 'published' }) }, 'Reopen'),
          c.status === 'draft' && h('button', { class: 'btn', onclick: () => { if (confirm('Publish this giveaway? Anyone with the link can enter between the start and end times.')) save({ status: 'published' }); } }, 'Publish'),
          c.status === 'published' && h('button', { class: 'btn', onclick: () => save({ status: 'draft' }) }, 'Unpublish'))),
      published && h('div', { class: 'card row', style: 'margin-top:12px' },
        h('input', { type: 'text', readonly: true, value: link, style: 'flex:1;min-width:200px', onfocus: (e) => e.target.select() }),
        h('button', { class: 'btn', onclick: () => copyText(link) }, 'Copy'),
        h('a', { class: 'btn', href: link, target: '_blank', rel: 'noopener' }, 'Open ↗')),
      !published && h('p', { class: 'muted' }, 'Draft: only you can see it. Publish when you\'re ready to share the link.'),
      h('div', { class: 'tabs', role: 'tablist' }, TABS.map(([k, label]) =>
        h('button', { role: 'tab', 'aria-selected': String(S.tab === k), onclick: () => { S.tab = k; redraw(); } }, label))),
      body);
  }
  draw();
  window.onbeforeunload = () => (S.dirty ? true : undefined);
  window.addEventListener('hashchange', () => { window.onbeforeunload = null; }, { once: true });
}

// ---------- router ----------
async function route() {
  drawTop();
  if (!me?.user) return loginView();
  const m = /^#\/g\/([\w-]+)/.exec(location.hash);
  try { await (m ? editorView(m[1]) : listView()); } catch (e) {
    if (e.status === 401) { me = { user: null, mock: me.mock }; drawTop(); loginView(); toast(e.message, true); return; }
    app.replaceChildren(h('div', { class: 'card' }, h('p', { class: 'error' }, e.message), h('a', { href: '#/' }, '← Back')));
  }
}
window.addEventListener('hashchange', route);
api('GET', '/api/me').then((r) => { me = r; route(); }).catch(() => { me = { user: null }; route(); });
