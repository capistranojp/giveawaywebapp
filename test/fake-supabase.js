// Minimal PostgREST stand-in for the `kv` table, so the Supabase code path can be tested without an account.
// Usage: node test/fake-supabase.js  (listens on :4000)
const http = require('http');
const db = new Map();
http.createServer((req, res) => {
  const u = new URL(req.url, 'http://x');
  const bad = req.headers.apikey !== 'k' || req.headers.authorization !== 'Bearer k' || u.pathname !== '/rest/v1/kv';
  let body = '';
  req.on('data', (c) => (body += c));
  req.on('end', () => {
    if (bad) { res.writeHead(401).end('bad auth/path'); return; }
    const k = (u.searchParams.get('key') || '').replace(/^eq\./, '');
    if (req.method === 'GET') return res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(db.has(k) ? [{ value: db.get(k) }] : []));
    if (req.method === 'POST') { const r = JSON.parse(body); db.set(r.key, r.value); return res.writeHead(201).end(); }
    if (req.method === 'DELETE') { db.delete(k); return res.writeHead(204).end(); }
    res.writeHead(405).end();
  });
}).listen(4000, () => console.log('fake supabase on :4000'));
