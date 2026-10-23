const crypto = require('crypto');

const rid = () => crypto.randomBytes(4).toString('hex');
const str = (v, max) => String(v ?? '').trim().slice(0, max);
const sid = (v, seen) => {
  let id = /^[A-Za-z0-9_-]{1,24}$/.test(v || '') ? v : rid();
  while (seen.has(id)) id = rid();
  seen.add(id);
  return id;
};
const url = (v) => {
  const s = str(v, 500);
  return /^https?:\/\//i.test(s) ? s : '';
};

const FIELD_TYPES = ['text', 'textarea', 'select', 'checkbox', 'url', 'email'];
const METHOD_TYPES = ['follow', 'subscribe', 'join', 'visit', 'share', 'comment', 'custom'];
const STATUSES = ['draft', 'published', 'closed'];

function defaultConfig() {
  const start = new Date(Math.ceil(Date.now() / 3600e3) * 3600e3);
  const end = new Date(+start + 7 * 864e5);
  return {
    name: 'My Giveaway',
    description: '',
    prize: '',
    bannerUrl: '',
    rules: '',
    status: 'draft',
    start: start.toISOString(),
    end: end.toISOString(),
    timezone: 'UTC',
    winnersCount: 1,
    showWinners: false,
    steps: [
      { id: rid(), title: 'Pick your ways to enter', text: 'Complete as many as you like. Each one earns bonus entries.' },
      { id: rid(), title: 'Fill in the form', text: 'Tell us who to contact if you win.' },
      { id: rid(), title: 'Wait for the draw', text: 'Winners are picked at random after the giveaway ends.' },
    ],
    entryMethods: [
      { id: rid(), type: 'follow', title: 'Follow us', description: '', url: '', points: 1, required: false },
    ],
    form: {
      title: 'Enter the giveaway',
      submitLabel: 'Enter now',
      successMessage: "You're in! Good luck.",
      fields: [
        { id: 'name', label: 'Your name', type: 'text', required: true, locked: true, options: [] },
        { id: 'email', label: 'Email address', type: 'email', required: true, locked: true, options: [] },
        { id: 'agree', label: 'I agree to the giveaway rules', type: 'checkbox', required: true, options: [] },
      ],
    },
  };
}

// Validates and normalises host-supplied config. Throws Error(message) on bad input.
function sanitizeConfig(input, prev) {
  const i = input || {};
  const c = {};
  c.name = str(i.name, 120) || 'Untitled giveaway';
  c.description = str(i.description, 4000);
  c.prize = str(i.prize, 200);
  c.bannerUrl = url(i.bannerUrl);
  c.rules = str(i.rules, 6000);
  c.status = STATUSES.includes(i.status) ? i.status : prev?.status || 'draft';
  try { new Intl.DateTimeFormat('en', { timeZone: i.timezone }); c.timezone = i.timezone; } catch { c.timezone = prev?.timezone || 'UTC'; }
  const s = new Date(i.start), e = new Date(i.end);
  if (isNaN(s) || isNaN(e)) throw new Error('Start and end must be valid dates');
  if (e <= s) throw new Error('End must be after start');
  c.start = s.toISOString();
  c.end = e.toISOString();
  c.winnersCount = Math.min(100, Math.max(1, parseInt(i.winnersCount, 10) || 1));
  c.showWinners = !!i.showWinners;

  let seen = new Set();
  c.steps = (Array.isArray(i.steps) ? i.steps : []).slice(0, 20).map((x) => ({
    id: sid(x.id, seen), title: str(x.title, 120), text: str(x.text, 600),
  })).filter((x) => x.title || x.text);

  seen = new Set();
  c.entryMethods = (Array.isArray(i.entryMethods) ? i.entryMethods : []).slice(0, 20).map((x) => ({
    id: sid(x.id, seen),
    type: METHOD_TYPES.includes(x.type) ? x.type : 'custom',
    title: str(x.title, 120) || 'Untitled method',
    description: str(x.description, 300),
    url: url(x.url),
    points: Math.min(100, Math.max(0, parseInt(x.points, 10) || 0)),
    required: !!x.required,
  }));

  const f = i.form || {};
  seen = new Set();
  let fields = (Array.isArray(f.fields) ? f.fields : []).slice(0, 25).map((x) => ({
    id: sid(x.id, seen),
    label: str(x.label, 120) || 'Untitled field',
    type: FIELD_TYPES.includes(x.type) ? x.type : 'text',
    required: !!x.required,
    locked: x.id === 'name' || x.id === 'email',
    options: (Array.isArray(x.options) ? x.options : []).map((o) => str(o, 80)).filter(Boolean).slice(0, 30),
  }));
  // name + email are required for contacting winners and de-duplicating entries
  for (const [id, label, type] of [['name', 'Your name', 'text'], ['email', 'Email address', 'email']]) {
    let fld = fields.find((x) => x.id === id);
    if (!fld) { fld = { id, label, type, required: true, locked: true, options: [] }; fields.unshift(fld); }
    fld.type = type; fld.required = true; fld.locked = true;
  }
  c.form = {
    title: str(f.title, 120) || 'Enter the giveaway',
    submitLabel: str(f.submitLabel, 40) || 'Enter now',
    successMessage: str(f.successMessage, 300) || "You're in! Good luck.",
    fields,
  };
  return c;
}

function phase(cfg, now = Date.now()) {
  if (cfg.status === 'draft') return 'draft';
  if (cfg.status === 'closed') return 'ended';
  if (now < Date.parse(cfg.start)) return 'upcoming';
  if (now >= Date.parse(cfg.end)) return 'ended';
  return 'open';
}

const maskName = (n) => {
  const p = String(n || '').trim().split(/\s+/);
  return p.length > 1 ? `${p[0]} ${p[p.length - 1][0]}.` : p[0] || 'Winner';
};

function publicView(cfg, winners) {
  const ph = phase(cfg);
  const out = {
    name: cfg.name, description: cfg.description, prize: cfg.prize, bannerUrl: cfg.bannerUrl,
    rules: cfg.rules, start: cfg.start, end: cfg.end, timezone: cfg.timezone,
    steps: cfg.steps, entryMethods: cfg.entryMethods, form: cfg.form,
    phase: ph, serverNow: Date.now(),
  };
  if (ph === 'ended' && cfg.showWinners) {
    out.winners = winners.filter((w) => w.status === 'active').map((w) => maskName(w.name));
  }
  return out;
}

module.exports = { defaultConfig, sanitizeConfig, phase, publicView, rid };
