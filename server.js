require('dotenv').config();
const express = require('express');
const cookieSession = require('cookie-session');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const hosts = require('./src/hosts');
const { pick } = require('./src/draw');
const { defaultConfig, sanitizeConfig, phase, publicView } = require('./src/config');

const MOCK = process.env.MOCK_MODE === '1' || process.argv.includes('--mock');
const store = MOCK ? require('./src/mockStore') : require('./src/googleStore');
if (!MOCK && (!process.env.GOOGLE_CLIENT_ID || !process.env.GOOGLE_CLIENT_SECRET)) {
  console.error('Missing GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET. Copy .env.example to .env, or run `npm run mock` to try the app without Google.');
  process.exit(1);
}
if (!process.env.SESSION_SECRET && !MOCK) console.warn('SESSION_SECRET is not set; using an insecure development default.');

const app = express();
app.set('trust proxy', 1);
app.use(express.json({ limit: '200kb' }));
app.use(cookieSession({
  name: 'gh',
  keys: [process.env.SESSION_SECRET || 'dev-only-secret'],
  maxAge: 14 * 864e5,
  sameSite: 'lax',
  httpOnly: true,
  secure: process.env.NODE_ENV === 'production',
}));

// CSRF guard: every state-changing request must carry a custom header, which cross-site forms cannot send.
app.use((req, res, next) => {
  if (req.method !== 'GET' && req.method !== 'HEAD' && req.get('x-gh') !== '1') return res.status(403).json({ error: 'Forbidden' });
  next();
});

const wrap = (fn) => (req, res) => fn(req, res).catch((e) => {
  const msg = String(e?.message || e);
  const authFail = e?.code === 401 || /invalid_grant|unauthorized_client|no stored Google token/i.test(msg);
  if (!e.status) console.error(e);
  res.status(authFail ? 401 : e.status || 500).json({
    error: authFail ? 'Google access expired. Please sign out and sign in again.' : e.status ? msg : 'Something went wrong talking to Google. Try again.',
  });
});
const fail = (status, message) => Object.assign(new Error(message), { status });

// ---------- auth ----------
app.get('/auth/google', wrap(async (req, res) => {
  if (MOCK) {
    await hosts.upsertHost('dev', { id: 'dev', name: 'Dev Host', email: 'dev@example.com' });
    req.session.hostId = 'dev';
    return res.redirect('/');
  }
  const state = crypto.randomBytes(16).toString('hex');
  req.session.state = state;
  req.session.flow = null;
  res.redirect(store.authUrl(state));
}));

app.get('/auth/callback', wrap(async (req, res) => {
  if (!req.query.code || !req.session.state || req.query.state !== req.session.state) throw fail(400, 'Invalid sign-in attempt');
  const { profile, refreshToken } = await store.exchange(req.query.code);
  if (!profile.id) throw fail(400, 'Google did not return an account id');
  const guestFor = req.session.flow?.guestFor;
  if (guestFor) { // someone signing in to enter a giveaway, not a host
    if (!profile.email || profile.verified === false) throw fail(400, 'Your Google account needs a verified email address to enter.');
    req.session.guest = { id: profile.id, name: profile.name || '', email: profile.email, picture: profile.picture || '' };
    req.session.state = null; req.session.flow = null;
    return res.redirect('/g/' + guestFor);
  }
  if (!refreshToken && !(await hosts.getProfile(profile.id))) throw fail(400, 'Google did not grant offline access. Remove the app at myaccount.google.com/permissions and try again.');
  await hosts.upsertHost(profile.id, profile, refreshToken);
  req.session = { hostId: profile.id };
  res.redirect('/');
}));

app.get('/auth/enter/:id', (req, res) => {
  const id = req.params.id;
  if (!/^[\w-]{1,60}$/.test(id)) return res.status(400).json({ error: 'Invalid giveaway' });
  if (MOCK) { // ?as=Name signs in as a made-up person, so the one-entry-per-account rules can be tried locally
    const as = String(req.query.as || 'Guest').slice(0, 30);
    req.session.guest = { id: 'mock-' + as.toLowerCase(), name: as, email: as.toLowerCase().replace(/\W+/g, '') + '@x.com', picture: '' };
    return res.redirect('/g/' + id);
  }
  const state = crypto.randomBytes(16).toString('hex');
  req.session.state = state;
  req.session.flow = { guestFor: id };
  res.redirect(store.guestAuthUrl(state));
});

app.post('/auth/logout', (req, res) => { req.session = null; res.json({ ok: true }); });

const requireHost = (req, res, next) =>
  req.session?.hostId ? next() : res.status(401).json({ error: 'Not signed in' });

app.get('/api/me', wrap(async (req, res) => {
  const p = req.session?.hostId && (await hosts.getProfile(req.session.hostId));
  res.json({ user: p ? { name: p.name, email: p.email, picture: p.picture } : null, mock: MOCK });
}));

// ---------- host API ----------
const owned = async (req) => {
  const id = req.params.id;
  if ((await hosts.indexGet(id)) !== req.session.hostId) throw fail(404, 'Giveaway not found');
  return id;
};
const cfgCache = new Map(); // public config cache, 15s TTL, keeps Sheets quota safe under traffic
const seenCache = new Map(); // per giveaway: who has already entered, for duplicate checks
const locks = new Map();
const bust = (id) => { cfgCache.delete(id); seenCache.delete(id); };

// Duplicate detection. Values are simplified first, so trivial edits (case, spaces, punctuation,
// Gmail dots and +tags) don't slip past. Loaded once per giveaway from the Sheet, then kept in memory.
// shortcut: exact-after-simplifying matches only, no fuzzy/typo matching (it flags real people); single server instance only.
const norm = (v) => String(v ?? '').toLowerCase().normalize('NFKC').replace(/[^\p{L}\p{N}]+/gu, '');
const normEmail = (e) => {
  let [u, d = ''] = String(e).toLowerCase().trim().split('@');
  if (d === 'googlemail.com') d = 'gmail.com';
  if (d === 'gmail.com') u = u.split('+')[0].replace(/\./g, '');
  return u + '@' + d;
};
const dupFields = (cfg) => cfg.form.fields.filter((f) => f.id === 'email' || f.unique);
const dupKey = (f, v) => (f.id === 'email' ? normEmail(v) : norm(v));
const rawVal = (e, fid) => (fid === 'email' ? e.email : fid === 'name' ? e.name : e.answers?.[fid]);
function remember(seen, cfg, e) {
  if (e.answers?._gid) seen.gids.add(e.answers._gid);
  for (const f of dupFields(cfg)) { const v = rawVal(e, f.id); if (v) seen.vals.get(f.id)?.add(dupKey(f, v)); }
}
async function seenFor(id, hostId, cfg) {
  let seen = seenCache.get(id);
  if (!seen) {
    seen = { gids: new Set(), vals: new Map(dupFields(cfg).map((f) => [f.id, new Set()])) };
    for (const e of await store.getEntries(hostId, id)) remember(seen, cfg, e);
    seenCache.set(id, seen);
  }
  return seen;
}

app.get('/api/giveaways', requireHost, wrap(async (req, res) => {
  const list = await store.listGiveaways(req.session.hostId);
  await Promise.all(list.map((g) => hosts.indexSet(g.id, req.session.hostId))); // rebuilds index if data/ was lost
  res.json(list);
}));

app.post('/api/giveaways', requireHost, wrap(async (req, res) => {
  const cfg = sanitizeConfig({ ...defaultConfig(), ...(req.body?.name ? { name: req.body.name } : {}), timezone: req.body?.timezone });
  const id = await store.createGiveaway(req.session.hostId, cfg);
  await hosts.indexSet(id, req.session.hostId);
  res.json({ id });
}));

const sheetUrl = (id) => (MOCK ? null : `https://docs.google.com/spreadsheets/d/${id}`);

app.get('/api/giveaways/:id', requireHost, wrap(async (req, res) => {
  const id = await owned(req), h = req.session.hostId;
  const [config, entries, winners] = await Promise.all([store.getConfig(h, id), store.getEntries(h, id), store.getWinners(h, id)]);
  res.json({ id, config, entries, winners, phase: phase(config), sheetUrl: sheetUrl(id) });
}));

app.put('/api/giveaways/:id', requireHost, wrap(async (req, res) => {
  const id = await owned(req), h = req.session.hostId;
  const prev = await store.getConfig(h, id);
  let cfg;
  try { cfg = sanitizeConfig(req.body, prev); } catch (e) { throw fail(400, e.message); }
  await store.saveConfig(h, id, cfg);
  bust(id);
  res.json({ config: cfg, phase: phase(cfg) });
}));

app.delete('/api/giveaways/:id', requireHost, wrap(async (req, res) => {
  const id = await owned(req);
  await store.trash(req.session.hostId, id);
  await hosts.indexDel(id);
  bust(id);
  res.json({ ok: true });
}));

const newId = () => crypto.randomBytes(5).toString('hex');
const winnerRow = (e, drawId, note = '') => ({
  id: newId(), ts: new Date().toISOString(), entryId: e.id, name: e.name, email: e.email, status: 'active', drawId, note,
});

app.post('/api/giveaways/:id/draw', requireHost, wrap(async (req, res) => {
  const id = await owned(req), h = req.session.hostId;
  const cfg = await store.getConfig(h, id);
  if (phase(cfg) === 'open' && !req.body?.force) throw fail(409, 'The giveaway is still open. Confirm to draw early.');
  const count = Math.min(100, Math.max(1, parseInt(req.body?.count, 10) || cfg.winnersCount));
  const [entries, winners] = await Promise.all([store.getEntries(h, id), store.getWinners(h, id)]);
  const picked = pick(entries, count, new Set(winners.map((w) => w.entryId)));
  if (!picked.length) throw fail(409, entries.length ? 'No eligible entries left. Everyone has already been drawn.' : 'There are no entries yet.');
  const drawId = newId();
  await store.appendWinners(h, id, picked.map((e) => winnerRow(e, drawId)));
  res.json({ winners: await store.getWinners(h, id), drawn: picked.length });
}));

app.post('/api/giveaways/:id/reroll', requireHost, wrap(async (req, res) => {
  const id = await owned(req), h = req.session.hostId;
  const [entries, winners] = await Promise.all([store.getEntries(h, id), store.getWinners(h, id)]);
  const old = winners.find((w) => w.id === req.body?.winnerId && w.status === 'active');
  if (!old) throw fail(404, 'Active winner not found');
  const [next] = pick(entries, 1, new Set(winners.map((w) => w.entryId)));
  if (!next) throw fail(409, 'No eligible entries left to reroll into.');
  await store.setWinnerStatus(h, id, old, 'rerolled');
  await store.appendWinners(h, id, [winnerRow(next, newId(), `Replaces ${old.name} (${old.id})`)]);
  res.json({ winners: await store.getWinners(h, id) });
}));

const csvCell = (v) => {
  let s = String(v ?? '');
  if (/^[=+\-@\t\r]/.test(s)) s = "'" + s; // neutralise spreadsheet formula injection
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

app.get('/api/giveaways/:id/export.csv', requireHost, wrap(async (req, res) => {
  const id = await owned(req), h = req.session.hostId;
  const [cfg, entries] = await Promise.all([store.getConfig(h, id), store.getEntries(h, id)]);
  const extra = cfg.form.fields.filter((f) => !f.locked);
  const methodTitle = Object.fromEntries(cfg.entryMethods.map((m) => [m.id, m.title]));
  const rows = [['Entry ID', 'Timestamp', 'Name', 'Email', 'Total entries', 'Completed methods', ...extra.map((f) => f.label)]];
  for (const e of entries) {
    rows.push([e.id, e.ts, e.name, e.email, e.entries, e.methods.map((m) => methodTitle[m] || m).join('; '),
      ...extra.map((f) => (typeof e.answers[f.id] === 'boolean' ? (e.answers[f.id] ? 'Yes' : 'No') : e.answers[f.id] ?? ''))]);
  }
  res.type('text/csv').attachment(`${cfg.name.replace(/[^\w-]+/g, '_')}-entries.csv`).send(rows.map((r) => r.map(csvCell).join(',')).join('\n'));
}));

// ---------- public API (no account needed to enter) ----------
async function publicCfg(id) {
  const hit = cfgCache.get(id);
  if (hit && Date.now() - hit.t < 15000) return hit;
  const hostId = await hosts.indexGet(id);
  if (!hostId) throw fail(404, 'Giveaway not found');
  const cfg = await store.getConfig(hostId, id);
  const v = { t: Date.now(), cfg, hostId };
  cfgCache.set(id, v);
  return v;
}

app.get('/api/public/:id', wrap(async (req, res) => {
  const { cfg, hostId } = await publicCfg(req.params.id);
  if (cfg.status === 'draft') throw fail(404, 'This giveaway is not published yet.');
  const winners = phase(cfg) === 'ended' && cfg.showWinners ? await store.getWinners(hostId, req.params.id) : [];
  const view = publicView(cfg, winners), g = req.session?.guest;
  view.guest = g ? { name: g.name, email: g.email, picture: g.picture } : null;
  res.set('Cache-Control', 'no-store').json(view);
}));

app.post('/api/public/signout', (req, res) => { if (req.session) req.session.guest = null; res.json({ ok: true }); });

const hits = new Map();
const limited = (ip) => {
  const now = Date.now();
  const arr = (hits.get(ip) || []).filter((t) => now - t < 60000);
  arr.push(now);
  hits.set(ip, arr);
  return arr.length > (parseInt(process.env.ENTRY_RATE_LIMIT, 10) || 10);
};
setInterval(() => hits.clear(), 10 * 60000).unref();

app.post('/api/public/:id/enter', wrap(async (req, res) => {
  const id = req.params.id;
  if (limited(req.ip)) throw fail(429, 'Too many attempts. Wait a minute and try again.');
  const { cfg, hostId } = await publicCfg(id);
  const ph = phase(cfg);
  if (ph !== 'open') throw fail(409, ph === 'upcoming' ? 'This giveaway has not started yet.' : ph === 'ended' ? 'This giveaway has ended.' : 'This giveaway is not open.');
  if (req.body?.hp) return res.json({ ok: true, entries: 1, message: cfg.form.successMessage }); // honeypot: pretend success to bots

  const needLogin = cfg.requireLogin !== false, guest = req.session?.guest;
  if (needLogin && !guest) throw fail(401, 'Sign in with Google to enter.');
  const raw = { ...(req.body?.answers || {}) }, answers = {};
  if (needLogin) { raw.email = guest.email; raw.name = String(raw.name ?? '').trim() || guest.name; } // the email comes from Google, never the form
  for (const f of cfg.form.fields) {
    let v = raw[f.id];
    if (f.type === 'checkbox') v = v === true;
    else v = String(v ?? '').trim().slice(0, f.type === 'textarea' ? 1000 : 200);
    if (f.required && (f.type === 'checkbox' ? !v : !v)) throw fail(400, `"${f.label}" is required`);
    if (v && f.type === 'email' && !/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(v)) throw fail(400, 'Enter a valid email address');
    if (v && f.type === 'url' && !/^https?:\/\/\S+$/i.test(v)) throw fail(400, `"${f.label}" must be a link starting with http(s)://`);
    if (v && f.type === 'select' && !f.options.includes(v)) throw fail(400, `Choose a valid option for "${f.label}"`);
    answers[f.id] = v;
  }

  const done = new Set(Array.isArray(req.body?.methods) ? req.body.methods : []);
  const methods = cfg.entryMethods.filter((m) => done.has(m.id));
  const missing = cfg.entryMethods.find((m) => m.required && !done.has(m.id));
  if (missing) throw fail(400, `Please complete "${missing.title}"`);
  const total = 1 + methods.reduce((s, m) => s + m.points, 0);

  // serialise per giveaway so two simultaneous submits can't both pass the duplicate check
  const prev = locks.get(id) || Promise.resolve();
  const run = prev.then(async () => {
    const seen = await seenFor(id, hostId, cfg);
    if (guest && seen.gids.has(guest.id)) throw fail(409, 'This Google account has already entered.');
    for (const f of dupFields(cfg)) {
      const v = answers[f.id];
      if (v && seen.vals.get(f.id)?.has(dupKey(f, v))) throw fail(409, f.id === 'email' ? 'This email has already entered.' : `"${f.label}" has already been used to enter.`);
    }
    const entry = {
      id: newId(), ts: new Date().toISOString(), name: answers.name, email: answers.email,
      entries: total, methods: methods.map((m) => m.id),
      answers: { ...Object.fromEntries(Object.entries(answers).filter(([k]) => k !== 'name' && k !== 'email')), ...(guest ? { _gid: guest.id } : {}) },
    };
    await store.appendEntry(hostId, id, entry);
    remember(seen, cfg, entry);
    return entry;
  });
  locks.set(id, run.catch(() => {}));
  const entry = await run;
  res.json({ ok: true, entries: entry.entries, entryId: entry.id, message: cfg.form.successMessage });
}));

// ---------- pages ----------
// Legal pages live outside public/ so {{CONTACT}} is always filled in (CONTACT_EMAIL env var).
const esc = (s) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
const contact = process.env.CONTACT_EMAIL
  ? `<a href="mailto:${esc(process.env.CONTACT_EMAIL)}">${esc(process.env.CONTACT_EMAIL)}</a>`
  : 'the person who runs this site';
for (const name of ['privacy', 'terms']) {
  const html = fs.readFileSync(path.join(__dirname, 'legal', name + '.html'), 'utf8').replaceAll('{{CONTACT}}', contact);
  app.get('/' + name, (req, res) => res.type('html').send(html));
}
app.use(express.static(path.join(__dirname, 'public')));
app.get('/g/:id', (req, res) => res.sendFile(path.join(__dirname, 'public', 'giveaway.html')));

const port = process.env.PORT || 3000;
app.listen(port, () => console.log(`Giveaway Host running on http://localhost:${port}${MOCK ? ' (MOCK MODE: in-memory, no Google)' : ''}`));
