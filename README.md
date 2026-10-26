# Giveaway Host

A web app for running giveaways. Hosts sign in with Google; every giveaway is stored in the host's own Google Drive as a Google Sheet, and participants enter through a public link (no account needed).

## What it does

**Host dashboard** (sign in with Google)
- Editable giveaway name, prize, description, banner image and rules
- Editable **start and end date/time** with a time zone picker, plus an optional **stop accepting entries** date (close entries early, then draw before the giveaway ends)
- Editable **entry form**: heading, button text, success message, and your own fields (short text, long text, dropdown, checkbox, link). Name and email are always required.
- **Ways to enter**: titled entry methods (follow, subscribe, join, visit, share, comment, custom) with an optional link, bonus entries and a "required" flag
- **Steps**: numbered "how it works" list shown on the public page
- **Participants** tab with search, CSV export and a link to the Google Sheet
- **Winners** tab: weighted random draw, **reroll** any winner, full history (rerolled winners can never be drawn again)
- One entry per person: visitors sign in with Google to enter (on by default, switchable per giveaway), and each Google account can enter once. Their email comes from the account, so it can't be faked.
- Duplicate checks: repeats are rejected, not recorded. Emails ignore Gmail dots and +tags, and any short field (like a Discord name) can be marked "Reject duplicates", ignoring case, spaces and punctuation.
- **Maximum entries** (optional): entries close by themselves when the number is reached
- **Disqualify** an entry from the Participants tab (kept in the Sheet, marked, never drawn, can be restored). Current winners must be rerolled first.
- **Duplicate giveaway**: copies settings, form, ways to enter and steps into a new draft, with the dates moved to start now
- Draft / Published / Closed states, plus an optional public winner announcement (first name + last initial)
- A live ticket preview next to the editor, so you see the public page change as you type
- Privacy policy and terms pages at `/privacy` and `/terms` (needed for Google's consent screen)

**Public page** at `/g/<giveaway id>`: banner, countdown, steps, ways to enter with a live "your entries" counter, entry form, rules.

**Storage** (Google Drive folder `Giveaway Host`, one Sheet per giveaway):
- `Config` tab: the giveaway settings (managed by the app)
- `Entries` tab: the participant list
- `Winners` tab: every draw and reroll

## Run it without Google first

```bash
npm install
npm run mock      # http://localhost:3000, in-memory, "Continue as dev host"
npm test          # end-to-end smoke test against the mock store
```

## Connect real Google

1. Go to <https://console.cloud.google.com/> and create a project.
2. **APIs & Services > Library**: enable **Google Sheets API** and **Google Drive API**.
3. **APIs & Services > OAuth consent screen**: choose External, fill in the app name and your email. Add the scopes `openid`, `email`, `profile` and `.../auth/drive.file`. While the app is in *Testing*, add the Google accounts of your hosts under **Test users**.
4. **Credentials > Create credentials > OAuth client ID > Web application**. Under *Authorized redirect URIs* add `http://localhost:3000/auth/callback` (and your production URL + `/auth/callback` when you deploy).
5. Copy `.env.example` to `.env` and fill in:
   ```
   GOOGLE_CLIENT_ID=...
   GOOGLE_CLIENT_SECRET=...
   BASE_URL=http://localhost:3000
   SESSION_SECRET=<long random string>
   TOKEN_KEY=<another long random string>
   ```
   Generate secrets with `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`.
6. `npm start` and open <http://localhost:3000>.

Visitors who enter a giveaway sign in through the same OAuth client and the same redirect URI, but they only grant `openid`, `email` and `profile`. Because anyone must be able to sign in, **publish the app** (OAuth consent screen > Publish app): in Testing mode only the test users you list could enter.

The app only requests the `drive.file` scope for hosts, so it can touch **only the files it created**, never the rest of your Drive. That scope is non-sensitive, so you can publish the OAuth consent screen without Google's verification review.

## How accounts work

- Signing in with Google creates the host account. The Google refresh token is stored **encrypted** (AES-256-GCM, key from `TOKEN_KEY`) in a key/value table (Supabase when configured, otherwise `data/kv.json`) so the server can write entries to the host's Sheet when participants submit the form.
- The same table maps giveaway id to host. If the index is ever lost, it rebuilds itself the next time the host opens their giveaway list.
- If a host revokes access, they get a "sign in again" message.

## Things to know

- **Honor system for bonus entries.** The app cannot check whether someone really followed you somewhere. Required methods must be ticked, and the link must be opened before the box unlocks, but that is a courtesy, not proof.
- **One entry per person** is enforced per Google account, so it stops casual repeats but not someone who creates new Google accounts. No website can truly identify a single PC without blocking households and schools. Matching is exact after simplifying (no typo guessing). Other protections: a hidden honeypot field and 10 entries/minute per IP (`ENTRY_RATE_LIMIT` to change).
- If you delete rows from the `Entries` sheet by hand, restart the server (or save the giveaway once) so the duplicate list is rebuilt.
- **Google quotas.** Sheets allows about 60 reads and 60 writes per minute per user. Public config reads are cached for 15 seconds and the duplicate check is held in memory, so normal traffic is fine, but a viral giveaway (many entries per second) could hit the write limit.
- **Don't edit the `Config` tab by hand.** Use the app. Editing `Entries` and `Winners` in Sheets is fine, but keep the header row and column order.
- Time zones: dates are stored in UTC and shown in the giveaway's chosen zone.
- Drawing while a giveaway is still open asks for confirmation.

## Deploying for free (Render + Supabase)

Render's free web service runs this app as-is, but its disk is wiped on every restart, so host accounts and tokens must live in Supabase. Free Render services sleep after 15 minutes idle (about a minute to wake); a free uptime pinger hitting your URL every ~10 minutes avoids that and fits inside the 750 free hours/month for one service.

1. **Supabase:** create a free project, open the SQL editor and run:
   ```sql
   create table kv (key text primary key, value jsonb not null);
   alter table kv enable row level security;  -- no policies: only the service key can read it
   ```
   Then copy the project URL and the `service_role` key (Project Settings > API). Keep that key server-side only.
2. **Render:** push this folder to a GitHub repo, then New > Web Service. Build command `npm install`, start command `npm start`. Add environment variables:
   `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `SESSION_SECRET`, `TOKEN_KEY`, `SUPABASE_URL`, `SUPABASE_SERVICE_KEY`, `CONTACT_EMAIL`, `NODE_ENV=production`, and `BASE_URL=https://<your-service>.onrender.com`.
3. **Google Cloud:** add `https://<your-service>.onrender.com/auth/callback` to the OAuth client's authorized redirect URIs. Then in Google Auth Platform > Branding set the home page to your site URL, the privacy policy to `<your URL>/privacy` and the terms to `<your URL>/terms`, and publish the app under Audience.

   The `/privacy` and `/terms` pages are plain-language templates written to match what this app does, with your `CONTACT_EMAIL` filled in. They are not legal advice. Read them and adjust the files in `legal/` for your situation, especially if you run giveaways with prizes of real value.
4. **Keep it awake (optional):** the repo includes `.github/workflows/keepalive.yml`, which pings `/healthz` every 10 minutes. In the GitHub repo go to Settings > Secrets and variables > Actions > Variables and add `APP_URL` = your Render URL. GitHub sometimes delays scheduled runs, so the app may still nap occasionally.
5. Keep `TOKEN_KEY` stable. Changing it makes stored tokens unreadable and every host must sign in again.

Any other Node 18+ host works the same way. Without the two Supabase variables the app falls back to a local `data/kv.json` file, which is fine on your own machine or a VPS with a persistent disk.

## Layout

```
server.js              Express app: auth, host API, public API
src/googleStore.js     Google Sheets + Drive storage
src/mockStore.js       in-memory store for `npm run mock`
src/hosts.js           host accounts + encrypted tokens + giveaway index (Supabase or JSON file)
src/config.js          defaults, validation, public view
src/draw.js            weighted random picker
legal/                 privacy and terms pages ({{CONTACT}} is filled from CONTACT_EMAIL)
public/                dashboard (index.html, app.js) and public page (giveaway.html, giveaway.js)
test/smoke.js          end-to-end test (add test/fake-supabase.js to exercise the Supabase path)
```

## Credits

Fonts are self-hosted under the SIL Open Font License: [Unbounded](https://github.com/googlefonts/unbounded) and [Figtree](https://github.com/erikdkennedy/figtree). Licenses are in `public/fonts/`.
