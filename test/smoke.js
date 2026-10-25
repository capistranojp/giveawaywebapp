// End-to-end smoke test against the mock store. Run: npm test
const { spawn } = require('child_process');
const assert = require('assert');
const os = require('os');
const fs = require('fs');
const path = require('path');

const PORT = 3999, B = `http://localhost:${PORT}`;
const data = fs.mkdtempSync(path.join(os.tmpdir(), 'gh-'));
const srv = spawn('node', [path.join(__dirname, '..', 'server.js'), '--mock'], { env: { ...process.env, PORT, DATA_DIR: data, ENTRY_RATE_LIMIT: '1000', CONTACT_EMAIL: 'help@example.com' }, stdio: 'inherit' });
const host = { c: '' }; // cookie jars: one for the host, one per simulated visitor

async function req(method, url, body, opts = {}) {
  const jar = opts.jar || (opts.anon ? { c: '' } : host);
  const r = await fetch(B + url, {
    method, redirect: 'manual',
    headers: { 'content-type': 'application/json', ...(opts.noCsrf ? {} : { 'x-gh': '1' }), cookie: jar.c },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const sc = r.headers.getSetCookie?.() || [];
  if (sc.length) jar.c = sc.map((c) => c.split(';')[0]).join('; ');
  const ct = r.headers.get('content-type') || '';
  return { status: r.status, body: ct.includes('json') ? await r.json() : await r.text(), headers: r.headers };
}
// signs a made-up person in (mock mode), returns their cookie jar
const signIn = async (id, who) => { const jar = { c: '' }; assert.equal((await req('GET', `/auth/enter/${id}?as=${who}`, undefined, { jar })).status, 302); return jar; };
const openDates = () => ({ start: new Date(Date.now() - 3600e3).toISOString(), end: new Date(Date.now() + 3600e3).toISOString() });

(async () => {
  for (let i = 0; i < 50; i++) { try { await fetch(B + '/api/me'); break; } catch { await new Promise((r) => setTimeout(r, 100)); } }

  // ---------- host auth ----------
  assert.equal((await req('GET', '/api/giveaways', undefined, { anon: true })).status, 401, 'list requires sign-in');
  await req('GET', '/auth/google');
  assert.equal((await req('GET', '/api/me')).body.user.email, 'dev@example.com');
  assert.equal((await req('POST', '/api/giveaways', {}, { noCsrf: true })).status, 403, 'CSRF header enforced');

  // ---------- giveaway A: visitors type their own email (sign-in switched off) ----------
  const { id } = (await req('POST', '/api/giveaways', {})).body;
  let g = (await req('GET', '/api/giveaways/' + id)).body;
  assert.equal(g.phase, 'draft');
  assert.equal(g.config.requireLogin, true, 'sign-in is on by default');
  assert.equal(g.config.form.fields.find((f) => f.id === 'email').unique, true);
  const cfg = g.config;
  cfg.name = 'Test <b>Giveaway</b>';
  cfg.timezone = 'Asia/Manila';
  Object.assign(cfg, openDates());
  cfg.status = 'published';
  cfg.winnersCount = 2;
  cfg.requireLogin = false;
  cfg.entryMethods = [
    { id: 'tw', type: 'follow', title: 'Follow', url: 'javascript:alert(1)', points: 3, required: false },
    { id: 'req', type: 'visit', title: 'Visit', url: 'https://example.com', points: 1, required: true },
  ];
  cfg.form.fields.push(
    { id: 'plat', label: 'Platform', type: 'select', required: true, options: ['PC', 'Console'] },
    { id: 'handle', label: 'Discord name', type: 'text', required: false, unique: true, options: [] },
    { id: 'note', label: 'Note', type: 'textarea', required: false, unique: true, options: [] },
  );
  let put = await req('PUT', '/api/giveaways/' + id, cfg);
  assert.equal(put.status, 200);
  assert.equal(put.body.config.requireLogin, false);
  assert.equal(put.body.config.entryMethods[0].url, '', 'non-http links are stripped');
  assert.equal(put.body.phase, 'open');
  const fl = put.body.config.form.fields;
  assert.equal(fl.find((f) => f.id === 'handle').unique, true);
  assert.equal(fl.find((f) => f.id === 'note').unique, false, 'unique only applies to short fields');
  assert.equal(fl.find((f) => f.id === 'name').unique, false);
  assert.equal((await req('PUT', '/api/giveaways/' + id, { ...cfg, end: cfg.start })).status, 400, 'end must be after start');
  const noEmail = { ...cfg, form: { ...cfg.form, fields: cfg.form.fields.filter((f) => f.id !== 'email') } };
  assert.ok((await req('PUT', '/api/giveaways/' + id, noEmail)).body.config.form.fields.some((f) => f.id === 'email'), 'email field cannot be removed');

  const pub = await req('GET', '/api/public/' + id, undefined, { anon: true });
  assert.equal(pub.body.phase, 'open');
  assert.ok(!('status' in pub.body) && !('winnersCount' in pub.body), 'public view hides host fields');
  const enter = (n, extra = {}) => req('POST', `/api/public/${id}/enter`, {
    answers: { name: n, email: `${n.toLowerCase()}@x.com`, agree: true, plat: 'PC', ...extra.answers }, methods: extra.methods ?? ['req', 'tw'],
  }, { anon: true });
  const a = await enter('Alice');
  assert.equal(a.status, 200); assert.equal(a.body.entries, 1 + 3 + 1);
  assert.equal((await enter('Alice')).status, 409, 'duplicate email rejected');
  assert.equal((await enter('Bob', { methods: ['tw'] })).status, 400, 'required method enforced');
  assert.equal((await enter('Bob', { answers: { plat: 'Switch' } })).status, 400, 'select options validated');
  assert.equal((await enter('Bob', { answers: { agree: false } })).status, 400, 'required checkbox enforced');
  assert.equal((await enter('Bob', { answers: { email: 'nope' } })).status, 400, 'email validated');
  for (const n of ['Bob', 'Cara', 'Dan']) assert.equal((await enter(n, { methods: ['req'] })).status, 200);
  const race = await Promise.all([1, 2, 3].map(() => enter('Race')));
  assert.equal(race.filter((r) => r.status === 200).length, 1, 'concurrent duplicate entries serialised');

  // near-duplicates are caught: Gmail dots/+tags, googlemail.com, punctuation and case
  assert.equal((await enter('Gina', { answers: { email: 'g.ina+promo@gmail.com' } })).status, 200);
  assert.equal((await enter('Gina2', { answers: { email: 'GINA@googlemail.com' } })).status, 409, 'Gmail variants are one person');
  assert.equal((await enter('Hank', { answers: { handle: 'Cool_Guy' } })).status, 200);
  const dupHandle = await enter('Ivy', { answers: { handle: 'cool guy' } });
  assert.equal(dupHandle.status, 409, 'repeated unique field rejected');
  assert.ok(dupHandle.body.error.includes('Discord name'), 'message names the field');
  assert.equal((await enter('Jo', { answers: { handle: '' } })).status, 200, 'an empty unique field is not a duplicate');
  assert.equal((await enter('Kim', { answers: { handle: '' } })).status, 200);
  assert.equal((await enter('Lee', { answers: { note: 'same text' } })).status, 200);
  assert.equal((await enter('Max', { answers: { note: 'same text' } })).status, 200, 'long text fields are never unique');

  g = (await req('GET', '/api/giveaways/' + id)).body;
  assert.equal(g.entries.length, 11, 'rejected duplicates are not recorded');
  const csv = await req('GET', `/api/giveaways/${id}/export.csv`);
  assert.ok(csv.body.split('\n').length === 12 && csv.body.includes('alice@x.com'));
  assert.ok(!csv.body.includes('_gid'));

  // draw + reroll
  assert.equal((await req('POST', `/api/giveaways/${id}/draw`, { count: 2 })).status, 409, 'drawing while open needs force');
  const d = await req('POST', `/api/giveaways/${id}/draw`, { count: 2, force: true });
  assert.equal(d.body.winners.length, 2);
  const w0 = d.body.winners[0];
  const rr = await req('POST', `/api/giveaways/${id}/reroll`, { winnerId: w0.id });
  assert.equal(rr.status, 200);
  const ws = rr.body.winners;
  assert.equal(ws.length, 3);
  assert.equal(ws.find((w) => w.id === w0.id).status, 'rerolled');
  assert.equal(new Set(ws.map((w) => w.entryId)).size, 3, 'rerolled winner never re-drawn');
  assert.equal(ws.filter((w) => w.status === 'active').length, 2);
  await req('POST', `/api/giveaways/${id}/draw`, { count: 50, force: true });
  assert.equal((await req('POST', `/api/giveaways/${id}/draw`, { count: 1, force: true })).status, 409, 'no eligible entries left');

  // closing, winners announcement
  await req('PUT', '/api/giveaways/' + id, { ...put.body.config, status: 'closed', showWinners: true });
  assert.equal((await enter('Late')).status, 409, 'closed giveaway rejects entries');
  await new Promise((r) => setTimeout(r, 16000)); // public config cache TTL is 15s
  const closed = await req('GET', '/api/public/' + id, undefined, { anon: true });
  assert.equal(closed.body.phase, 'ended');
  assert.ok(closed.body.winners.length > 0 && closed.body.winners.every((n) => /^\w+( \w\.)?$/.test(n)), 'masked winners shown');

  // ownership
  assert.equal((await req('GET', '/api/giveaways/' + id, undefined, { anon: true })).status, 401);
  assert.equal((await req('GET', '/api/public/nope', undefined, { anon: true })).status, 404);

  // ---------- giveaway B: visitors must sign in with Google ----------
  const idB = (await req('POST', '/api/giveaways', {})).body.id;
  const cfgB = (await req('GET', '/api/giveaways/' + idB)).body.config;
  assert.equal(cfgB.requireLogin, true);
  Object.assign(cfgB, { name: 'Signed in', status: 'published', ...openDates() });
  assert.equal((await req('PUT', '/api/giveaways/' + idB, cfgB)).status, 200);
  const enterB = (jar, answers = {}) => req('POST', `/api/public/${idB}/enter`, { answers: { agree: true, ...answers }, methods: [] }, { jar });

  assert.equal((await enterB({ c: '' }, { name: 'X', email: 'x@x.com' })).status, 401, 'cannot enter without signing in');
  let pubB = await req('GET', '/api/public/' + idB, undefined, { anon: true });
  assert.equal(pubB.body.requireLogin, true); assert.equal(pubB.body.guest, null);
  const nora = await signIn(idB, 'Nora');
  pubB = await req('GET', '/api/public/' + idB, undefined, { jar: nora });
  assert.equal(pubB.body.guest.email, 'nora@x.com');
  assert.equal((await enterB(nora, { name: '', email: 'someone-else@x.com' })).status, 200);
  const eB = (await req('GET', '/api/giveaways/' + idB)).body.entries;
  assert.equal(eB.length, 1);
  assert.equal(eB[0].email, 'nora@x.com', 'email comes from the Google account, not the form');
  assert.equal(eB[0].name, 'Nora', 'name defaults to the Google name');
  assert.equal((await enterB(await signIn(idB, 'Nora'))).status, 409, 'one entry per Google account, even from a new browser');
  assert.equal((await enterB(await signIn(idB, 'Omar'), { name: 'Nora' })).status, 200, 'a different account may share a name');
  await req('POST', '/api/public/signout', {}, { jar: nora });
  assert.equal((await req('GET', '/api/public/' + idB, undefined, { jar: nora })).body.guest, null, 'signing out clears the visitor');
  assert.equal((await enterB(nora)).status, 401);
  assert.equal((await req('GET', '/auth/enter/bad%20id', undefined, { anon: true })).status, 400, 'bad giveaway id rejected');

  // ---------- legal pages ----------
  for (const p of ['privacy', 'terms']) {
    const r = await req('GET', '/' + p, undefined, { anon: true });
    assert.equal(r.status, 200);
    assert.ok(r.body.includes('mailto:help@example.com') && !r.body.includes('{{CONTACT}}'), p + ' page fills in the contact email');
  }

  // delete + static pages
  assert.equal((await req('DELETE', '/api/giveaways/' + id)).status, 200);
  assert.equal((await req('GET', '/api/giveaways/' + id)).status, 404);
  assert.ok((await req('GET', '/g/' + id, undefined, { anon: true })).body.includes('giveaway.js'));
  console.log('\nAll smoke checks passed');
})().then(() => { srv.kill(); process.exit(0); }).catch((e) => { console.error('\nFAILED:', e.message); srv.kill(); process.exit(1); });
