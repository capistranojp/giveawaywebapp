// End-to-end smoke test against the mock store. Run: npm test
const { spawn } = require('child_process');
const assert = require('assert');
const os = require('os');
const fs = require('fs');
const path = require('path');

const PORT = 3999, B = `http://localhost:${PORT}`;
const data = fs.mkdtempSync(path.join(os.tmpdir(), 'gh-'));
const srv = spawn('node', [path.join(__dirname, '..', 'server.js'), '--mock'], { env: { ...process.env, PORT, DATA_DIR: data, ENTRY_RATE_LIMIT: '1000', CONTACT_EMAIL: 'help@example.com' }, stdio: 'inherit' });
let cookie = '';

async function req(method, url, body, opts = {}) {
  const r = await fetch(B + url, {
    method, redirect: 'manual',
    headers: { 'content-type': 'application/json', ...(opts.noCsrf ? {} : { 'x-gh': '1' }), ...(opts.anon ? {} : { cookie }) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const sc = r.headers.getSetCookie?.() || [];
  if (sc.length && !opts.anon) cookie = sc.map((c) => c.split(';')[0]).join('; ');
  const ct = r.headers.get('content-type') || '';
  return { status: r.status, body: ct.includes('json') ? await r.json() : await r.text(), headers: r.headers };
}

(async () => {
  for (let i = 0; i < 50; i++) { try { await fetch(B + '/api/me'); break; } catch { await new Promise((r) => setTimeout(r, 100)); } }

  // auth
  assert.equal((await req('GET', '/api/giveaways', undefined, { anon: true })).status, 401, 'list requires sign-in');
  await req('GET', '/auth/google');
  assert.equal((await req('GET', '/api/me')).body.user.email, 'dev@example.com');
  assert.equal((await req('POST', '/api/giveaways', {}, { noCsrf: true })).status, 403, 'CSRF header enforced');

  // create + edit
  const { id } = (await req('POST', '/api/giveaways', {})).body;
  let g = (await req('GET', '/api/giveaways/' + id)).body;
  assert.equal(g.phase, 'draft');
  const cfg = g.config;
  cfg.name = 'Test <b>Giveaway</b>';
  cfg.timezone = 'Asia/Manila';
  cfg.start = new Date(Date.now() - 3600e3).toISOString();
  cfg.end = new Date(Date.now() + 3600e3).toISOString();
  cfg.status = 'published';
  cfg.winnersCount = 2;
  cfg.entryMethods = [
    { id: 'tw', type: 'follow', title: 'Follow', url: 'javascript:alert(1)', points: 3, required: false },
    { id: 'req', type: 'visit', title: 'Visit', url: 'https://example.com', points: 1, required: true },
  ];
  cfg.form.fields.push({ id: 'plat', label: 'Platform', type: 'select', required: true, options: ['PC', 'Console'] });
  let put = await req('PUT', '/api/giveaways/' + id, cfg);
  assert.equal(put.status, 200);
  assert.equal(put.body.config.entryMethods[0].url, '', 'non-http links are stripped');
  assert.equal(put.body.phase, 'open');
  const bad = await req('PUT', '/api/giveaways/' + id, { ...cfg, end: cfg.start });
  assert.equal(bad.status, 400, 'end must be after start');
  const noEmail = { ...cfg, form: { ...cfg.form, fields: cfg.form.fields.filter((f) => f.id !== 'email') } };
  assert.ok((await req('PUT', '/api/giveaways/' + id, noEmail)).body.config.form.fields.some((f) => f.id === 'email'), 'email field cannot be removed');

  // public page + entries
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
  // concurrent duplicates: only one may pass
  const race = await Promise.all([1, 2, 3].map(() => enter('Race')));
  assert.equal(race.filter((r) => r.status === 200).length, 1, 'concurrent duplicate entries serialised');

  // host sees entries
  g = (await req('GET', '/api/giveaways/' + id)).body;
  assert.equal(g.entries.length, 5);
  const csv = await req('GET', `/api/giveaways/${id}/export.csv`);
  assert.ok(csv.body.split('\n').length === 6 && csv.body.includes('alice@x.com'));

  // draw + reroll
  const early = await req('POST', `/api/giveaways/${id}/draw`, { count: 2 });
  assert.equal(early.status, 409, 'drawing while open needs force');
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
  await req('POST', `/api/giveaways/${id}/draw`, { count: 5, force: true });
  assert.equal((await req('POST', `/api/giveaways/${id}/draw`, { count: 1, force: true })).status, 409, 'no eligible entries left');

  // closing, winners announcement
  await req('PUT', '/api/giveaways/' + id, { ...put.body.config, status: 'closed', showWinners: true });
  assert.equal((await enter('Late')).status, 409, 'closed giveaway rejects entries');
  await new Promise((r) => setTimeout(r, 16000)); // public config cache TTL is 15s
  const closed = await req('GET', '/api/public/' + id, undefined, { anon: true });
  assert.equal(closed.body.phase, 'ended');
  assert.ok(closed.body.winners.length > 0 && closed.body.winners.every((n) => /^\w+( \w\.)?$/.test(n)), 'masked winners shown');

  // ownership
  const other = await req('GET', '/api/giveaways/' + id, undefined, { anon: true });
  assert.equal(other.status, 401);
  assert.equal((await req('GET', '/api/public/nope', undefined, { anon: true })).status, 404);

  // delete
  assert.equal((await req('DELETE', '/api/giveaways/' + id)).status, 200);
  assert.equal((await req('GET', '/api/giveaways/' + id)).status, 404);

  // legal pages
  for (const p of ['privacy', 'terms']) {
    const r = await req('GET', '/' + p, undefined, { anon: true });
    assert.equal(r.status, 200);
    assert.ok(r.body.includes('mailto:help@example.com') && !r.body.includes('{{CONTACT}}'), p + ' page fills in the contact email');
  }

  // static pages
  assert.ok((await req('GET', '/g/' + id, undefined, { anon: true })).body.includes('giveaway.js'));
  console.log('\nAll smoke checks passed');
})().then(() => { srv.kill(); process.exit(0); }).catch((e) => { console.error('\nFAILED:', e.message); srv.kill(); process.exit(1); });
