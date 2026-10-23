// Host accounts (profile + encrypted Google refresh token) and the giveawayId -> hostId index.
// One key/value table: Supabase when SUPABASE_URL + SUPABASE_SERVICE_KEY are set (survives restarts on free hosts),
// otherwise a local JSON file. shortcut: file mode is single-instance only, use Supabase when deploying.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const { SUPABASE_URL: URL_, SUPABASE_SERVICE_KEY: KEY } = process.env;
const DIR = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
const FILE = path.join(DIR, 'kv.json');

let get, set, del;
if (URL_ && KEY) {
  const sb = async (method, qs, body) => {
    const r = await fetch(`${URL_}/rest/v1/kv${qs}`, {
      method, body,
      headers: { apikey: KEY, authorization: `Bearer ${KEY}`, 'content-type': 'application/json', prefer: 'resolution=merge-duplicates' },
    });
    if (!r.ok) throw new Error(`Supabase ${method} failed: ${r.status} ${await r.text()}`);
    return method === 'GET' ? r.json() : null;
  };
  const q = (k) => `?key=eq.${encodeURIComponent(k)}`;
  get = async (k) => (await sb('GET', q(k) + '&select=value'))[0]?.value;
  set = (k, value) => sb('POST', '?on_conflict=key', JSON.stringify({ key: k, value }));
  del = (k) => sb('DELETE', q(k));
} else {
  fs.mkdirSync(DIR, { recursive: true });
  const read = () => { try { return JSON.parse(fs.readFileSync(FILE, 'utf8')); } catch { return {}; } };
  const write = (d) => { fs.writeFileSync(FILE + '.tmp', JSON.stringify(d)); fs.renameSync(FILE + '.tmp', FILE); };
  get = async (k) => read()[k];
  set = async (k, v) => write({ ...read(), [k]: v });
  del = async (k) => { const d = read(); delete d[k]; write(d); };
}

const key = () => crypto.createHash('sha256').update(process.env.TOKEN_KEY || process.env.SESSION_SECRET || 'dev-only-key').digest();
const enc = (t) => {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', key(), iv);
  const b = Buffer.concat([c.update(t, 'utf8'), c.final()]);
  return [iv, c.getAuthTag(), b].map((x) => x.toString('base64')).join('.');
};
const dec = (s) => {
  const [iv, tag, b] = s.split('.').map((x) => Buffer.from(x, 'base64'));
  const d = crypto.createDecipheriv('aes-256-gcm', key(), iv);
  d.setAuthTag(tag);
  return Buffer.concat([d.update(b), d.final()]).toString('utf8');
};

exports.upsertHost = async (id, profile, refreshToken) => {
  const prev = (await get('host:' + id)) || {};
  await set('host:' + id, { ...prev, profile, ...(refreshToken ? { refresh: enc(refreshToken) } : {}) });
};
exports.getProfile = async (id) => (await get('host:' + id))?.profile || null;
exports.getRefresh = async (id) => {
  const r = (await get('host:' + id))?.refresh;
  if (!r) throw new Error('Host has no stored Google token, please sign in again');
  return dec(r);
};
const idx = new Map(); // read-through cache; the index only changes on create/delete
exports.indexSet = async (gid, hostId) => {
  if (idx.get(gid) === hostId) return;
  await set('idx:' + gid, hostId);
  idx.set(gid, hostId);
};
exports.indexGet = async (gid) => {
  if (!idx.has(gid)) { const v = await get('idx:' + gid); if (!v) return null; idx.set(gid, v); }
  return idx.get(gid);
};
exports.indexDel = async (gid) => { await del('idx:' + gid); idx.delete(gid); };
