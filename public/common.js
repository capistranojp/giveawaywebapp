// Shared helpers for the dashboard and the public page.
function h(tag, props, ...kids) {
  const el = document.createElement(tag);
  let value;
  for (const [k, v] of Object.entries(props || {})) {
    if (k === 'class') el.className = v;
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (k === 'value') value = v;
    else if (k === 'checked' || k === 'disabled' || k === 'readonly' || k === 'required') { if (v) el.setAttribute(k, ''); }
    else if (v !== false && v != null) el.setAttribute(k, v);
  }
  for (const kid of kids.flat(Infinity)) {
    if (kid == null || kid === false) continue;
    el.append(kid.nodeType ? kid : document.createTextNode(kid));
  }
  if (value !== undefined) el.value = value;
  if (props && 'checked' in props) el.checked = !!props.checked;
  return el;
}

// Replace an element's children, skipping null/false/'' (plain replaceChildren would print them as text).
function mount(el, ...kids) {
  el.replaceChildren(...kids.flat(Infinity).filter((k) => k != null && k !== false && k !== ''));
}

async function api(method, url, body) {
  const r = await fetch(url, {
    method,
    headers: { 'content-type': 'application/json', 'x-gh': '1' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  let d = {};
  try { d = await r.json(); } catch { /* non-JSON body */ }
  if (!r.ok) throw Object.assign(new Error(d.error || r.statusText), { status: r.status });
  return d;
}

// ----- time zone helpers: <input type=datetime-local> shows wall-clock time in the giveaway's time zone -----
function wallParts(ms, tz) {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-US', {
    timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit',
  }).formatToParts(new Date(ms)).map((x) => [x.type, x.value]));
  return p;
}
function utcToZoned(iso, tz) {
  const p = wallParts(Date.parse(iso), tz);
  return `${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}`;
}
function zonedToUtc(local, tz) {
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/.exec(local || '');
  if (!m) return null;
  const guess = Date.UTC(+m[1], m[2] - 1, +m[3], +m[4], +m[5]);
  const asWall = (ms) => { const p = wallParts(ms, tz); return Date.UTC(+p.year, p.month - 1, +p.day, +p.hour, +p.minute, +p.second); };
  let utc = guess - (asWall(guess) - guess);
  utc = guess - (asWall(utc) - utc); // second pass handles DST boundaries
  return new Date(utc).toISOString();
}
function fmtDate(iso, tz) {
  // dateStyle/timeStyle can't be combined with timeZoneName, so spell the fields out
  return new Intl.DateTimeFormat('en', { year: 'numeric', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', timeZone: tz, timeZoneName: 'short' }).format(new Date(iso));
}
function phaseOf(cfg, now = Date.now()) {
  if (cfg.status === 'draft') return 'draft';
  if (cfg.status === 'closed') return 'ended';
  if (now < Date.parse(cfg.start)) return 'upcoming';
  if (now >= Date.parse(cfg.end)) return 'ended';
  return 'open';
}
function toast(msg, bad) {
  document.querySelectorAll('.toast').forEach((x) => x.remove()); // one at a time, so messages never stack
  const t = h('div', { class: 'toast' + (bad ? ' bad' : ''), role: 'status' }, msg);
  document.body.append(t);
  setTimeout(() => t.remove(), bad ? 6000 : 2800);
}
function copyText(text) {
  return navigator.clipboard.writeText(text).then(() => toast('Copied'), () => toast('Copy failed', true));
}
