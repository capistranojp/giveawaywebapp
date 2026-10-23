const crypto = require('crypto');

// Weighted random pick without replacement. Each entry's weight is its `entries` count (min 1).
// Uses crypto.randomInt so picks are unbiased and not predictable.
function pick(entries, n, excludeEntryIds = new Set()) {
  const pool = entries.filter((e) => !excludeEntryIds.has(e.id)).map((e) => ({ e, w: Math.max(1, e.entries | 0) }));
  const out = [];
  while (out.length < n && pool.length) {
    const total = pool.reduce((s, x) => s + x.w, 0);
    let r = crypto.randomInt(total);
    const idx = pool.findIndex((x) => (r -= x.w) < 0);
    out.push(pool[idx].e);
    pool.splice(idx, 1);
  }
  return out;
}

module.exports = { pick };
