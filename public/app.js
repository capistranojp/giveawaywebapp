// Host dashboard: sign-in, giveaway list, and the giveaway editor with a live preview.
const app = document.getElementById('app');
const topbar = document.getElementById('topbar');
const subbar = document.getElementById('subbar');
let me = null;

const rid = () => Math.random().toString(16).slice(2, 10);
const cap = (s) => s[0].toUpperCase() + s.slice(1);
const TZS = (Intl.supportedValuesOf ? Intl.supportedValuesOf('timeZone') : ['UTC']).concat('UTC');
const METHOD_TYPES = { follow: 'Follow', subscribe: 'Subscribe', join: 'Join', visit: 'Visit', share: 'Share', comment: 'Comment', custom: 'Custom' };
const FIELD_TYPES = { text: 'Short text', textarea: 'Long text', select: 'Dropdown', checkbox: 'Checkbox', url: 'Link', email: 'Email' };
const when = (iso) => new Date(iso).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' });

// "Hide names and emails" for screen-sharing; masks display only, copy/export still use real data
let hidePII = false;
const maskName = (n) => (hidePII ? String(n).split(/\s+/).map((w) => w.slice(0, 1) + '•••').join(' ') : n);
const maskEmail = (e) => {
  if (!hidePII) return e;
  const [u, d = ''] = String(e).split('@'), i = d.lastIndexOf('.');
  return u.slice(0, 1) + '•••@' + d.slice(0, 1) + '•••' + (i > 0 ? d.slice(i) : '');
};
const hideToggle = (redraw) => h('label', { class: 'row', style: 'gap:.4rem' },
  h('input', { type: 'checkbox', checked: hidePII, onchange: (ev) => { hidePII = ev.target.checked; redraw(); } }), 'Hide names and emails');

// ---------- shell ----------
function drawTop() {
  mount(topbar, 
    h('a', { class: 'brand', href: '#/' }, h('img', { src: '/favicon.svg', alt: '', width: 26, height: 26 }), 'Giveaway Host'),
    me?.user && h('span', { class: 'muted hide-s' }, me.user.name || me.user.email),
    me?.user?.picture && h('img', { class: 'avatar', src: me.user.picture, alt: '', referrerpolicy: 'no-referrer' }),
    me?.user && h('button', { class: 'btn small', onclick: async () => { await api('POST', '/auth/logout'); me = { user: null, mock: me.mock }; route(); } }, 'Sign out'),
  );
}

function loginView() {
  const seg = (n, l) => h('div', {}, h('b', {}, n), h('small', {}, l));
  mount(app, h('section', { class: 'hero' },
    h('div', {},
      h('h1', {}, 'Host giveaways without the spreadsheet mess'),
      h('p', { class: 'lead' }, 'Sign in with Google. Each giveaway is saved in your own Google Drive, and every entry lands in a Google Sheet you control.'),
      h('p', {}, h('a', { class: 'btn primary big', href: '/auth/google' }, me?.mock ? 'Continue as dev host' : 'Sign in with Google')),
      h('p', { class: 'muted' }, me?.mock
        ? 'Mock mode: data stays in memory and nothing is sent to Google.'
        : ['The app can only open files it creates. ', h('a', { href: '/privacy' }, 'Read the privacy policy'), '.'])),
    h('article', { class: 'ticket', 'aria-hidden': 'true' },
      h('div', { class: 'ticket-body' },
        h('p', { class: 'prize' }, 'Example: $50 game credit'),
        h('h2', { class: 't-name' }, 'Spring community giveaway'),
        h('p', { class: 'desc' }, 'Follow the channel, join the server, fill in the form. Each step earns more tickets.')),
      h('div', { class: 'perf' }),
      h('div', { class: 'ticket-stub' }, h('div', { class: 'count' }, seg('02', 'days'), seg('14', 'hrs'), seg('36', 'min'), seg('09', 'sec')))),
  ));
}

// ---------- list ----------
async function listView() {
  mount(app, h('p', { class: 'muted', style: 'margin-top:36px' }, 'Loading…'));
  const list = await api('GET', '/api/giveaways');
  const create = async (e) => {
    e.currentTarget.disabled = true;
    try { const { id } = await api('POST', '/api/giveaways', { timezone: Intl.DateTimeFormat().resolvedOptions().timeZone }); location.hash = '#/g/' + id; } catch (ex) { toast(ex.message, true); e.currentTarget.disabled = false; }
  };
  const stub = { open: 'Open', upcoming: 'Starts soon', draft: 'Draft', ended: 'Ended' };
  const line = (g, ph) => ph === 'draft' ? 'Not published yet' : ph === 'upcoming' ? 'Opens ' + when(g.start) : ph === 'ended' ? 'Ended ' + when(g.end) : 'Closes ' + when(g.end);
  mount(app, 
    h('div', { class: 'page-title' }, h('h1', {}, 'Your giveaways'), list.length > 0 && h('button', { class: 'btn primary', onclick: create }, 'New giveaway')),
    list.length === 0
      ? h('section', { class: 'empty' }, h('h2', {}, 'No giveaways yet'),
        h('p', {}, 'Create one, set the dates and share the link. Entries are saved to a Google Sheet in your Drive.'),
        h('button', { class: 'btn primary big', onclick: create }, 'Create your first giveaway'))
      : h('ul', { class: 'g-list' }, list.map((g) => {
        const ph = phaseOf({ status: g.status, start: g.start, end: g.end });
        return h('li', { class: 'g-row ' + ph },
          h('div', { class: 'g-stub' }, stub[ph]),
          h('div', { class: 'g-main' }, h('h2', {}, g.name), h('p', {}, line(g, ph))),
          h('div', { class: 'g-actions' },
            h('a', { class: 'btn primary small', href: '#/g/' + g.id }, 'Manage'),
            g.status !== 'draft' && h('button', { class: 'btn small', onclick: () => copyText(location.origin + '/g/' + g.id) }, 'Copy link')));
      })),
  );
}

// ---------- editor ----------
async function editorView(id) {
  mount(app, h('p', { class: 'muted', style: 'margin-top:36px' }, 'Loading…'));
  const d = await api('GET', '/api/giveaways/' + id);
  const S = { id, cfg: d.config, entries: d.entries, winners: d.winners, sheetUrl: d.sheetUrl, tab: 'details', dirty: false, q: '' };
  S.cfg.requireLogin = S.cfg.requireLogin !== false; // older giveaways have no setting and behave as "on"
  for (const f of S.cfg.form.fields) if (f.id === 'email') f.unique = true;
  const TABS = [['details', 'Details'], ['form', 'Entry form'], ['methods', 'Ways to enter'], ['steps', 'Steps'], ['entries', 'Participants'], ['winners', 'Winners']];
  let saveBtn, previewEl, previewTimer, titleEl;

  const chip = (t) => h('span', { class: 'chip' }, t);
  const previewTicket = (c) => h('article', { class: 'ticket' },
    c.bannerUrl && h('img', { class: 'ticket-banner', src: c.bannerUrl, alt: '', referrerpolicy: 'no-referrer' }),
    h('div', { class: 'ticket-body' },
      c.prize && h('p', { class: 'prize' }, c.prize),
      h('h2', { class: 't-name' }, c.name || 'Untitled giveaway'),
      c.description && h('p', { class: 'desc clamp' }, c.description)),
    h('div', { class: 'perf' }),
    h('div', { class: 'ticket-stub' },
      h('div', { class: 'when' },
        h('div', {}, h('span', {}, 'Opens'), h('b', {}, fmtDate(c.start, c.timezone))),
        h('div', {}, h('span', {}, 'Closes'), h('b', {}, fmtDate(c.end, c.timezone)))),
      h('div', { class: 'chips' },
        chip(`${c.entryMethods.length} ${c.entryMethods.length === 1 ? 'way' : 'ways'} to enter`),
        chip(`${c.steps.length} ${c.steps.length === 1 ? 'step' : 'steps'}`),
        chip(`${c.winnersCount || 1} ${(c.winnersCount || 1) == 1 ? 'winner' : 'winners'}`))));
  const renderPreview = () => previewEl && previewEl.replaceChildren(previewTicket(S.cfg));

  const markDirty = () => {
    S.dirty = true;
    if (saveBtn) { saveBtn.disabled = false; saveBtn.textContent = 'Save changes'; }
    if (titleEl) titleEl.textContent = S.cfg.name || 'Untitled giveaway';
    clearTimeout(previewTimer); previewTimer = setTimeout(renderPreview, 200); // debounced so the banner image isn't refetched per keystroke
  };
  const save = async (patch) => {
    if (patch) Object.assign(S.cfg, patch);
    try {
      const r = await api('PUT', '/api/giveaways/' + id, S.cfg);
      S.cfg = r.config; S.dirty = false;
      toast('Saved');
      draw();
    } catch (e) { toast(e.message, true); }
  };

  // --- input helpers (typing mutates state without re-rendering, so focus is kept) ---
  const field = (label, input, hint) => h('label', { class: 'field' }, h('span', {}, label), input, hint && h('small', {}, hint));
  const text = (obj, key, o = {}) => {
    const el = h(o.area ? 'textarea' : 'input', { type: o.area ? undefined : o.type || 'text', value: obj[key] ?? '', placeholder: o.ph, maxlength: o.max, rows: o.rows, min: o.min, max: o.maxN });
    el.addEventListener('input', () => { obj[key] = el.value; markDirty(); });
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
    el.addEventListener('change', () => { obj[key] = el.value; markDirty(); if (o.rerender) draw(); });
    return el;
  };
  const listEditor = (arr, render, make, addLabel, o = {}) => h('div', {},
    arr.map((item, i) => h('div', { class: 'item' },
      h('div', { class: 'item-head' }, h('span', {}, `${o.noun} ${i + 1}`),
        h('span', { class: 'row' },
          h('button', { class: 'btn icon small', title: 'Move up', 'aria-label': 'Move up', disabled: i === 0, onclick: () => { [arr[i - 1], arr[i]] = [arr[i], arr[i - 1]]; markDirty(); draw(); } }, '↑'),
          h('button', { class: 'btn icon small', title: 'Move down', 'aria-label': 'Move down', disabled: i === arr.length - 1, onclick: () => { [arr[i + 1], arr[i]] = [arr[i], arr[i + 1]]; markDirty(); draw(); } }, '↓'),
          !item.locked && h('button', { class: 'btn icon small danger', title: 'Remove', 'aria-label': 'Remove', onclick: () => { arr.splice(i, 1); markDirty(); draw(); } }, '✕'))),
      render(item))),
    h('p', { style: 'margin:16px 0 0' }, h('button', { class: 'btn', onclick: () => { arr.push(make()); markDirty(); draw(); } }, addLabel)));

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
    return h('div', { class: 'panel stack' },
      field('Giveaway name', text(c, 'name', { max: 120 })),
      h('div', { class: 'cols' },
        field('Prize', text(c, 'prize', { max: 200, ph: 'e.g. $50 Steam gift card' })),
        field('Number of winners', text(c, 'winnersCount', { type: 'number', min: 1, maxN: 100 }))),
      field('Description', text(c, 'description', { area: true, rows: 5, max: 4000 })),
      field('Banner image link', text(c, 'bannerUrl', { type: 'url', ph: 'https://…' }), 'Optional. Paste the web address of an image.'),
      h('div', { class: 'cols' }, field('Opens', startEl), field('Closes', endEl), field('Time zone', tz)),
      field('Rules and terms', text(c, 'rules', { area: true, rows: 4, max: 6000 }), 'Shown at the bottom of the public page.'),
      check(c, 'requireLogin', 'Visitors must sign in with Google to enter (one entry per Google account)'),
      check(c, 'showWinners', 'Show the winners on the public page after the giveaway ends (first name and last initial only)'),
      h('div', { class: 'row end' },
        h('button', { class: 'btn danger', onclick: async () => {
          if (!confirm('Delete this giveaway? Its Google Sheet moves to your Drive trash.')) return;
          try { await api('DELETE', '/api/giveaways/' + id); S.dirty = false; location.hash = '#/'; } catch (e) { toast(e.message, true); }
        } }, 'Delete giveaway')));
  };

  const tabForm = () => {
    const f = S.cfg.form;
    return h('div', { class: 'stack' },
      h('div', { class: 'panel stack' },
        h('div', { class: 'cols' }, field('Form heading', text(f, 'title', { max: 120 })), field('Button text', text(f, 'submitLabel', { max: 40 }))),
        field('Message after entering', text(f, 'successMessage', { max: 300 }))),
      h('div', { class: 'panel' },
        h('h2', {}, 'Form fields'),
        h('p', { class: 'muted' }, (S.cfg.requireLogin ? 'Name and email are always required. With Google sign-in on, the email comes from the visitor\'s Google account. ' : 'Name and email are always required. Repeated emails are rejected, ignoring Gmail dots and +tags. ') + 'Tick "Reject duplicates" on other short fields, like a Discord name, to block repeats.'),
        listEditor(f.fields, (fld) => h('div', { class: 'stack' },
          h('div', { class: 'cols' },
            field('Label', text(fld, 'label', { max: 120 })),
            field('Type', select(fld, 'type', FIELD_TYPES, { disabled: fld.locked, rerender: true }))),
          fld.type === 'select' && field('Options', (() => {
            const el = h('input', { type: 'text', value: (fld.options || []).join(', '), placeholder: 'Option A, Option B' });
            el.addEventListener('input', () => { fld.options = el.value.split(',').map((s) => s.trim()).filter(Boolean); markDirty(); });
            return el;
          })(), 'Separate options with commas.'),
          check(fld, 'required', 'Required', fld.locked),
          ['text', 'url', 'email'].includes(fld.type) && check(fld, 'unique', 'Reject duplicates of this field', fld.id === 'email')),
        () => ({ id: rid(), label: 'New field', type: 'text', required: false, options: [] }), 'Add field', { noun: 'Field' })));
  };

  const tabMethods = () => h('div', { class: 'panel' },
    h('h2', {}, 'Ways to enter'),
    h('p', { class: 'muted' }, 'Everyone gets 1 ticket for filling in the form. Each way below adds bonus tickets. People tick what they did, and the app can\'t verify actions on other sites.'),
    listEditor(S.cfg.entryMethods, (m) => h('div', { class: 'stack' },
      h('div', { class: 'cols' }, field('Title', text(m, 'title', { max: 120, ph: 'Follow us on Twitter' })), field('Type', select(m, 'type', METHOD_TYPES))),
      h('div', { class: 'cols' }, field('Link (optional)', text(m, 'url', { type: 'url', ph: 'https://…' })), field('Bonus tickets', text(m, 'points', { type: 'number', min: 0, maxN: 100 }))),
      field('Short description', text(m, 'description', { max: 300 })),
      check(m, 'required', 'Required to enter')),
    () => ({ id: rid(), type: 'custom', title: 'New way to enter', description: '', url: '', points: 1, required: false }), 'Add a way to enter', { noun: 'Way' }));

  const tabSteps = () => h('div', { class: 'panel' },
    h('h2', {}, 'How it works'),
    h('p', { class: 'muted' }, 'Numbered steps shown to people on the public page.'),
    listEditor(S.cfg.steps, (s) => h('div', { class: 'stack' },
      field('Step title', text(s, 'title', { max: 120 })),
      field('Details', text(s, 'text', { area: true, rows: 2, max: 600 }))),
    () => ({ id: rid(), title: 'New step', text: '' }), 'Add step', { noun: 'Step' }));

  const tabEntries = () => {
    const tbody = h('tbody');
    const total = S.entries.reduce((s, e) => s + e.entries, 0);
    const fill = () => {
      const q = S.q.toLowerCase();
      const rows = S.entries.filter((e) => !q || e.name.toLowerCase().includes(q) || e.email.toLowerCase().includes(q));
      tbody.replaceChildren(...(rows.length
        ? rows.map((e) => h('tr', {}, h('td', {}, maskName(e.name)), h('td', {}, maskEmail(e.email)), h('td', {}, String(e.entries)), h('td', { class: 'nw' }, when(e.ts))))
        : [h('tr', {}, h('td', { colspan: 4, class: 'muted' }, S.entries.length ? 'Nobody matches that search.' : 'No entries yet. Share the link to get started.'))]));
    };
    const search = h('input', { type: 'text', placeholder: 'Search name or email', value: S.q, 'aria-label': 'Search participants', style: 'max-width:260px', disabled: hidePII }); // search off while hidden, or it could reveal who's listed
    search.addEventListener('input', () => { S.q = search.value; fill(); });
    fill();
    return h('div', { class: 'panel stack' },
      h('div', { class: 'stats' },
        h('div', { class: 'stat' }, h('b', {}, String(S.entries.length)), S.entries.length === 1 ? 'participant' : 'participants'),
        h('div', { class: 'stat' }, h('b', {}, String(total)), total === 1 ? 'ticket in total' : 'tickets in total')),
      h('div', { class: 'row' },
        h('button', { class: 'btn', onclick: async () => { try { const r = await api('GET', '/api/giveaways/' + id); S.entries = r.entries; S.winners = r.winners; draw(); } catch (e) { toast(e.message, true); } } }, 'Refresh'),
        h('a', { class: 'btn', href: `/api/giveaways/${id}/export.csv` }, 'Export CSV'),
        S.sheetUrl && h('a', { class: 'btn', href: S.sheetUrl, target: '_blank', rel: 'noopener' }, 'Open Google Sheet'),
        h('span', { style: 'flex:1' }), hideToggle(draw), search),
      h('div', { class: 'table-wrap' }, h('table', {}, h('thead', {}, h('tr', {}, ['Name', 'Email', 'Tickets', 'Entered'].map((t) => h('th', {}, t)))), tbody)));
  };

  const tabWinners = () => {
    const drawn = new Set(S.winners.map((w) => w.entryId));
    const eligible = S.entries.filter((e) => !drawn.has(e.id));
    const active = S.winners.filter((w) => w.status === 'active');
    const countEl = h('input', { type: 'number', min: 1, max: 100, value: String(S.cfg.winnersCount), style: 'width:90px', 'aria-label': 'Winners to draw' });
    const run = async (url, body, okMsg) => {
      try { const r = await api('POST', `/api/giveaways/${id}/${url}`, body); S.winners = r.winners; toast(okMsg); draw(); } catch (e) { toast(e.message, true); }
    };
    const early = phaseOf(S.cfg) === 'open';
    return h('div', { class: 'stack' },
      h('div', { class: 'panel stack' },
        h('div', { class: 'stats' },
          h('div', { class: 'stat' }, h('b', {}, String(eligible.length)), eligible.length === 1 ? 'person who can still be drawn' : 'people who can still be drawn'),
          h('div', { class: 'stat' }, h('b', {}, String(active.length)), active.length === 1 ? 'current winner' : 'current winners')),
        h('p', { class: 'muted', style: 'margin:0' }, 'The draw is random and weighted by each person\'s tickets. Anyone already drawn, including rerolled winners, can\'t be picked again.'),
        h('div', { class: 'row' },
          h('label', { class: 'row' }, 'Winners to draw', countEl),
          h('button', { class: 'btn primary', disabled: !eligible.length, onclick: () => {
            if (early && !confirm('The giveaway is still open. Draw anyway?')) return;
            run('draw', { count: parseInt(countEl.value, 10) || 1, force: early }, 'Winners drawn');
          } }, 'Draw winners'))),
      S.winners.length > 0 && h('div', { class: 'panel stack' },
        h('div', { class: 'row between' }, h('h2', { style: 'margin:0' }, 'Winners'),
          h('span', { class: 'row' }, hideToggle(draw),
            h('button', { class: 'btn small', disabled: !active.length, onclick: () => copyText(active.map((w) => w.email).join(', ')) }, 'Copy winner emails'))),
        h('div', { class: 'table-wrap' }, h('table', {},
          h('thead', {}, h('tr', {}, ['Name', 'Email', 'Status', 'Drawn', 'Note', ''].map((t) => h('th', {}, t)))),
          h('tbody', {}, S.winners.slice().reverse().map((w) => h('tr', {},
            h('td', {}, maskName(w.name)), h('td', {}, maskEmail(w.email)), h('td', {}, h('span', { class: 'pill ' + w.status }, cap(w.status))),
            h('td', { class: 'nw' }, when(w.ts)), h('td', { class: 'muted' }, w.note),
            h('td', {}, w.status === 'active' && h('button', { class: 'btn small', onclick: () => {
              if (confirm(`Reroll ${maskName(w.name)}? They'll be marked as rerolled and a new winner is drawn.`)) run('reroll', { winnerId: w.id }, 'Rerolled');
            } }, 'Reroll')))))))));
  };

  // --- layout ---
  function draw() {
    const c = S.cfg, ph = phaseOf(c), published = c.status !== 'draft';
    const link = location.origin + '/g/' + id;
    saveBtn = h('button', { class: 'btn primary', disabled: !S.dirty, onclick: () => save() }, S.dirty ? 'Save changes' : 'Saved');
    previewEl = h('div');
    renderPreview();
    const body = { details: tabDetails, form: tabForm, methods: tabMethods, steps: tabSteps, entries: tabEntries, winners: tabWinners }[S.tab]();
    mount(subbar, h('div', { class: 'editor-bar' }, h('div', { class: 'wrap bar' },
      h('a', { class: 'back', href: '#/', onclick: (e) => { if (S.dirty && !confirm('Leave without saving your changes?')) e.preventDefault(); } }, '← Giveaways'),
      h('h1', { class: 'bar-title' }, (titleEl = h('span', {}, c.name)), h('span', { class: 'pill ' + ph }, cap(ph))),
      h('div', { class: 'actions' },
        c.status === 'draft' && h('button', { class: 'btn', onclick: () => { if (confirm('Publish this giveaway? Anyone with the link can enter between the open and close times.')) save({ status: 'published' }); } }, 'Publish'),
        c.status === 'published' && h('button', { class: 'btn', onclick: () => save({ status: 'draft' }) }, 'Unpublish'),
        c.status === 'published' && h('button', { class: 'btn', onclick: () => { if (confirm('Close this giveaway now? Entries stop immediately.')) save({ status: 'closed' }); } }, 'Close now'),
        c.status === 'closed' && h('button', { class: 'btn', onclick: () => save({ status: 'published' }) }, 'Reopen'),
        saveBtn))));
    mount(app, h('div', { class: 'editor' },
      h('div', {},
        published && h('div', { class: 'share' },
          h('input', { type: 'text', readonly: true, value: link, 'aria-label': 'Public link', onfocus: (e) => e.target.select() }),
          h('button', { class: 'btn', onclick: () => copyText(link) }, 'Copy link'),
          h('a', { class: 'btn', href: link, target: '_blank', rel: 'noopener' }, 'Open page')),
        !published && h('p', { class: 'muted' }, 'This is a draft. Only you can see it until you publish.'),
        h('div', { class: 'tabs', role: 'tablist' }, TABS.map(([k, label]) =>
          h('button', { role: 'tab', 'aria-selected': String(S.tab === k), onclick: () => { S.tab = k; draw(); } }, label))),
        body),
      h('aside', { 'aria-label': 'Live preview' }, h('p', { class: 'muted' }, 'Live preview'), previewEl)));
  }
  draw();
  window.onbeforeunload = () => (S.dirty ? true : undefined);
  window.addEventListener('hashchange', () => { window.onbeforeunload = null; }, { once: true });
}

// ---------- router ----------
async function route() {
  drawTop();
  mount(subbar, );
  if (!me?.user) return loginView();
  const m = /^#\/g\/([\w-]+)/.exec(location.hash);
  try { await (m ? editorView(m[1]) : listView()); } catch (e) {
    if (e.status === 401) { me = { user: null, mock: me.mock }; drawTop(); loginView(); toast(e.message, true); return; }
    mount(app, h('section', { class: 'empty', style: 'margin-top:36px' }, h('p', { class: 'error' }, e.message), h('a', { href: '#/' }, 'Back to your giveaways')));
  }
}
window.addEventListener('hashchange', route);
api('GET', '/api/me').then((r) => { me = r; route(); }).catch(() => { me = { user: null }; route(); });
