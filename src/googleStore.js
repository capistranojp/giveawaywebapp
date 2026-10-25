// Storage on the host's own Google account:
//   Drive folder "Giveaway Host" -> one Google Sheet per giveaway
//   Sheet tabs: Config (JSON in B1), Entries (participant list), Winners (draw + reroll history)
// Scope is drive.file, so the app can only touch files it created itself.
const { google } = require('googleapis');
const hosts = require('./hosts');

const SCOPES = ['openid', 'email', 'profile', 'https://www.googleapis.com/auth/drive.file'];
const ENTRY_HEAD = ['Entry ID', 'Timestamp', 'Name', 'Email', 'Total entries', 'Completed methods (JSON)', 'Answers (JSON)'];
const WIN_HEAD = ['Winner ID', 'Timestamp', 'Entry ID', 'Name', 'Email', 'Status', 'Draw ID', 'Note'];

const oauth = () => new google.auth.OAuth2(
  process.env.GOOGLE_CLIENT_ID,
  process.env.GOOGLE_CLIENT_SECRET,
  process.env.GOOGLE_REDIRECT_URI || `${process.env.BASE_URL || 'http://localhost:3000'}/auth/callback`,
);

exports.authUrl = (state) => oauth().generateAuthUrl({
  access_type: 'offline', prompt: 'consent', scope: SCOPES, state, include_granted_scopes: true,
});

// People entering a giveaway only need to prove who they are: no Drive access, no refresh token.
exports.guestAuthUrl = (state) => oauth().generateAuthUrl({ scope: ['openid', 'email', 'profile'], state, prompt: 'select_account' });

exports.exchange = async (code) => {
  const c = oauth();
  const { tokens } = await c.getToken(code);
  c.setCredentials(tokens);
  const { data } = await google.oauth2({ version: 'v2', auth: c }).userinfo.get();
  return {
    profile: { id: data.id, name: data.name, email: data.email, picture: data.picture, verified: data.verified_email },
    refreshToken: tokens.refresh_token,
  };
};

const clients = new Map();
async function cl(hostId) {
  if (!clients.has(hostId)) {
    const auth = oauth();
    auth.setCredentials({ refresh_token: await hosts.getRefresh(hostId) });
    clients.set(hostId, { sheets: google.sheets({ version: 'v4', auth }), drive: google.drive({ version: 'v3', auth }) });
  }
  return clients.get(hostId);
}

const folders = new Map();
async function folderId(hostId) {
  if (folders.has(hostId)) return folders.get(hostId);
  const { drive } = await cl(hostId);
  const q = "mimeType='application/vnd.google-apps.folder' and name='Giveaway Host' and trashed=false";
  const { data } = await drive.files.list({ q, fields: 'files(id)', pageSize: 1 });
  let id = data.files?.[0]?.id;
  if (!id) {
    id = (await drive.files.create({
      requestBody: { name: 'Giveaway Host', mimeType: 'application/vnd.google-apps.folder' }, fields: 'id',
    })).data.id;
  }
  folders.set(hostId, id);
  return id;
}

// Drive appProperties values are limited to 124 bytes combined with the key, so keep them short.
const props = (cfg) => ({
  gha: '1', gname: cfg.name.slice(0, 40), gstatus: cfg.status, gstart: cfg.start, gend: cfg.end,
});
const fileName = (cfg) => `Giveaway: ${cfg.name}`.slice(0, 120);

exports.createGiveaway = async (hostId, cfg) => {
  const { sheets, drive } = await cl(hostId);
  const parent = await folderId(hostId);
  const { data } = await sheets.spreadsheets.create({
    requestBody: {
      properties: { title: fileName(cfg) },
      sheets: ['Config', 'Entries', 'Winners'].map((title) => ({ properties: { title } })),
    },
  });
  const id = data.spreadsheetId;
  await drive.files.update({
    fileId: id, addParents: parent, removeParents: 'root', requestBody: { appProperties: props(cfg) }, fields: 'id',
  });
  await sheets.spreadsheets.values.batchUpdate({
    spreadsheetId: id,
    requestBody: {
      valueInputOption: 'RAW',
      data: [
        { range: 'Config!A1:B1', values: [['Config (managed by Giveaway Host, edit in the app)', JSON.stringify(cfg)]] },
        { range: 'Entries!A1:G1', values: [ENTRY_HEAD] },
        { range: 'Winners!A1:H1', values: [WIN_HEAD] },
      ],
    },
  });
  return id;
};

exports.listGiveaways = async (hostId) => {
  const { drive } = await cl(hostId);
  const { data } = await drive.files.list({
    q: "appProperties has { key='gha' and value='1' } and trashed=false",
    orderBy: 'modifiedTime desc', pageSize: 100,
    fields: 'files(id,modifiedTime,appProperties)',
  });
  return (data.files || []).map((f) => ({
    id: f.id, name: f.appProperties.gname, status: f.appProperties.gstatus,
    start: f.appProperties.gstart, end: f.appProperties.gend, modified: f.modifiedTime,
    sheetUrl: `https://docs.google.com/spreadsheets/d/${f.id}`,
  }));
};

exports.getConfig = async (hostId, id) => {
  const { sheets } = await cl(hostId);
  const { data } = await sheets.spreadsheets.values.get({ spreadsheetId: id, range: 'Config!B1' });
  return JSON.parse(data.values[0][0]);
};

exports.saveConfig = async (hostId, id, cfg) => {
  const { sheets, drive } = await cl(hostId);
  await sheets.spreadsheets.values.update({
    spreadsheetId: id, range: 'Config!B1', valueInputOption: 'RAW', requestBody: { values: [[JSON.stringify(cfg)]] },
  });
  await drive.files.update({ fileId: id, requestBody: { name: fileName(cfg), appProperties: props(cfg) }, fields: 'id' });
};

const parseJSON = (s, d) => { try { return JSON.parse(s); } catch { return d; } };

exports.getEntries = async (hostId, id) => {
  const { sheets } = await cl(hostId);
  const { data } = await sheets.spreadsheets.values.get({ spreadsheetId: id, range: 'Entries!A2:G' });
  return (data.values || []).map((r) => ({
    id: r[0], ts: r[1], name: r[2], email: r[3], entries: parseInt(r[4], 10) || 1,
    methods: parseJSON(r[5], []), answers: parseJSON(r[6], {}),
  }));
};

exports.appendEntry = async (hostId, id, e) => {
  const { sheets } = await cl(hostId);
  await sheets.spreadsheets.values.append({
    spreadsheetId: id, range: 'Entries!A:G', valueInputOption: 'RAW', insertDataOption: 'INSERT_ROWS',
    requestBody: { values: [[e.id, e.ts, e.name, e.email, e.entries, JSON.stringify(e.methods), JSON.stringify(e.answers)]] },
  });
};

exports.getWinners = async (hostId, id) => {
  const { sheets } = await cl(hostId);
  const { data } = await sheets.spreadsheets.values.get({ spreadsheetId: id, range: 'Winners!A2:H' });
  return (data.values || []).map((r, i) => ({
    row: i + 2, id: r[0], ts: r[1], entryId: r[2], name: r[3], email: r[4], status: r[5], drawId: r[6], note: r[7] || '',
  }));
};

exports.appendWinners = async (hostId, id, list) => {
  const { sheets } = await cl(hostId);
  await sheets.spreadsheets.values.append({
    spreadsheetId: id, range: 'Winners!A:H', valueInputOption: 'RAW', insertDataOption: 'INSERT_ROWS',
    requestBody: { values: list.map((w) => [w.id, w.ts, w.entryId, w.name, w.email, w.status, w.drawId, w.note || '']) },
  });
};

exports.setWinnerStatus = async (hostId, id, winner, status) => {
  const { sheets } = await cl(hostId);
  await sheets.spreadsheets.values.update({
    spreadsheetId: id, range: `Winners!F${winner.row}`, valueInputOption: 'RAW', requestBody: { values: [[status]] },
  });
};

exports.trash = async (hostId, id) => {
  await (await cl(hostId)).drive.files.update({ fileId: id, requestBody: { trashed: true }, fields: 'id' });
};
