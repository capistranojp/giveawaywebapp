// In-memory stand-in for googleStore, used with `npm run mock` to try the app without Google credentials.
// Data is lost on restart.
const crypto = require('crypto');

const db = new Map(); // id -> {hostId, cfg, entries, winners, modified}

exports.authUrl = () => '/auth/google';
exports.exchange = async () => { throw new Error('Mock mode has no Google exchange'); };

exports.createGiveaway = async (hostId, cfg) => {
  const id = 'mock' + crypto.randomBytes(5).toString('hex');
  db.set(id, { hostId, cfg, entries: [], winners: [], modified: new Date().toISOString() });
  return id;
};
const get = (hostId, id) => {
  const g = db.get(id);
  if (!g || g.hostId !== hostId) throw new Error('Not found');
  return g;
};
exports.listGiveaways = async (hostId) =>
  [...db].filter(([, g]) => g.hostId === hostId).map(([id, g]) => ({
    id, name: g.cfg.name, status: g.cfg.status, start: g.cfg.start, end: g.cfg.end, modified: g.modified, sheetUrl: null,
  })).sort((a, b) => b.modified.localeCompare(a.modified));
exports.getConfig = async (h, id) => structuredClone(get(h, id).cfg);
exports.saveConfig = async (h, id, cfg) => { const g = get(h, id); g.cfg = cfg; g.modified = new Date().toISOString(); };
exports.getEntries = async (h, id) => structuredClone(get(h, id).entries);
exports.appendEntry = async (h, id, e) => { get(h, id).entries.push(structuredClone(e)); };
exports.getWinners = async (h, id) => structuredClone(get(h, id).winners);
exports.appendWinners = async (h, id, list) => {
  const g = get(h, id);
  for (const w of list) g.winners.push({ ...w, row: g.winners.length + 2 });
};
exports.setWinnerStatus = async (h, id, w, status) => { get(h, id).winners.find((x) => x.id === w.id).status = status; };
exports.trash = async (h, id) => { get(h, id); db.delete(id); };
