// Pirate Golf guest Wi-Fi portal for UniFi (UDR7) external portal server.
// Collects name / email / phone, stores them in Postgres, then authorizes the
// guest device through the UniFi Network Integration API.
import express from 'express';
import pg from 'pg';
import { Agent, fetch } from 'undici';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const {
  PORT = 3000,
  DATABASE_URL,
  // Cloud connector (recommended when this app runs on Railway):
  //   https://api.ui.com/v1/connector/consoles/<YOUR_CONSOLE_ID>
  // Local (if the app runs on your LAN):  https://192.168.1.1
  UNIFI_BASE_URL,
  UNIFI_API_KEY,
  UNIFI_SITE_ID,               // optional — auto-detected if blank
  UNIFI_INSECURE_TLS = 'false', // 'true' only for local self-signed console certs
  SESSION_MINUTES = '480',      // how long a guest stays authorized
  RATE_LIMIT_DOWN_KBPS,         // optional bandwidth caps
  RATE_LIMIT_UP_KBPS,
  ADMIN_PASSWORD,               // protects /admin/export.csv
  BUSINESS_NAME = 'Pirate Golf',
  SUCCESS_URL                   // optional landing page after connecting
} = process.env;

// ---------- Database ----------
const pool = DATABASE_URL
  ? new pg.Pool({
      connectionString: DATABASE_URL,
      ssl: /localhost|127\.0\.0\.1|\.railway\.internal/.test(DATABASE_URL) ? false : { rejectUnauthorized: false }
    })
  : null;

async function initDb() {
  if (!pool) { console.warn('DATABASE_URL not set — sign-ups will NOT be saved.'); return; }
  await pool.query(`
    CREATE TABLE IF NOT EXISTS guests (
      id              SERIAL PRIMARY KEY,
      name            TEXT NOT NULL,
      email           TEXT NOT NULL,
      phone           TEXT NOT NULL,
      marketing_email BOOLEAN NOT NULL DEFAULT FALSE,
      marketing_sms   BOOLEAN NOT NULL DEFAULT FALSE,
      client_mac      TEXT,
      ap_mac          TEXT,
      ssid            TEXT,
      user_agent      TEXT,
      created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS guests_email_idx ON guests (lower(email));
  `);
}

// ---------- UniFi API ----------
// Use undici's own fetch together with its Agent: handing an npm-undici Agent to
// Node's built-in fetch breaks when the bundled undici version differs.
const dispatcher = UNIFI_INSECURE_TLS === 'true' ? new Agent({ connect: { rejectUnauthorized: false } }) : undefined;
// Tolerate common copy/paste variants: missing scheme, trailing slash, or the
// full ".../proxy/network/integration/v1" path already included.
const baseUrl = (() => {
  let u = (UNIFI_BASE_URL || '').trim().replace(/\/+$/, '').replace(/\/proxy\/network(\/integration(\/v1)?)?$/, '');
  if (u && !/^https?:\/\//i.test(u)) u = 'https://' + u;
  return u;
})();
const apiRoot = () => `${baseUrl}/proxy/network/integration/v1`;
let cachedSiteId = UNIFI_SITE_ID || null;

async function unifi(method, p, body) {
  if (!baseUrl || !UNIFI_API_KEY) throw new Error('UNIFI_BASE_URL and UNIFI_API_KEY must be set');
  let res;
  try {
    res = await fetch(apiRoot() + p, {
      method,
      headers: { 'X-API-KEY': UNIFI_API_KEY.trim(), Accept: 'application/json', ...(body ? { 'Content-Type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined,
      dispatcher,
      signal: AbortSignal.timeout(15000)
    });
  } catch (e) {
    // "fetch failed" hides the real reason (DNS, TLS, refused, timeout) in e.cause.
    const c = e.cause;
    const why = c ? `${c.code || c.name || ''} ${c.message || ''}`.trim() : e.name === 'TimeoutError' ? 'timed out after 15s' : '';
    throw new Error(`UniFi ${method} ${apiRoot() + p} -> ${e.message}${why ? ` (${why})` : ''}`);
  }
  const text = await res.text();
  if (!res.ok) throw new Error(`UniFi ${method} ${p} -> ${res.status}: ${text.slice(0, 300)}`);
  return text ? JSON.parse(text) : {};
}
const list = (r) => (Array.isArray(r) ? r : r?.data || []);

async function siteId() {
  if (cachedSiteId) return cachedSiteId;
  const sites = list(await unifi('GET', '/sites'));
  if (!sites.length) throw new Error('No UniFi sites returned');
  cachedSiteId = sites[0].id;
  return cachedSiteId;
}

async function authorizeGuest(mac) {
  const sid = await siteId();
  const filter = encodeURIComponent(`macAddress.eq('${mac.toLowerCase()}')`);
  const clients = list(await unifi('GET', `/sites/${sid}/clients?filter=${filter}`));
  const client = clients.find((c) => (c.macAddress || '').toLowerCase() === mac.toLowerCase()) || clients[0];
  if (!client) throw new Error(`Client ${mac} not found on site`);
  const body = { action: 'AUTHORIZE_GUEST_ACCESS', timeLimitMinutes: Number(SESSION_MINUTES) };
  if (RATE_LIMIT_DOWN_KBPS) body.rxRateLimitKbps = Number(RATE_LIMIT_DOWN_KBPS);
  if (RATE_LIMIT_UP_KBPS) body.txRateLimitKbps = Number(RATE_LIMIT_UP_KBPS);
  await unifi('POST', `/sites/${sid}/clients/${client.id}/actions`, body);
}

// ---------- Helpers ----------
const esc = (s = '') => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const MAC_RE = /^([0-9a-f]{2}[:-]){5}[0-9a-f]{2}$/i;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
const cleanPhone = (p) => String(p || '').replace(/[^\d+]/g, '');
const safeRedirect = (u) => (/^https?:\/\//i.test(u || '') ? u : 'https://www.google.com');

function page({ title, body }) {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)}</title><link rel="stylesheet" href="/static/portal.css"></head>
<body><main class="card">${body}</main></body></html>`;
}

function formPage(q, error = '', values = {}) {
  const hidden = ['id', 'ap', 'ssid', 'url', 't'].map((k) => `<input type="hidden" name="${k}" value="${esc(q[k] || '')}">`).join('');
  return page({
    title: `${BUSINESS_NAME} Guest Wi-Fi`,
    body: `
      <div class="badge">⛳ ☠️</div>
      <h1>Ahoy! Welcome aboard</h1>
      <p class="sub">Free Wi-Fi at ${esc(BUSINESS_NAME)} — just tell us who ye be.</p>
      ${error ? `<p class="error">${esc(error)}</p>` : ''}
      <form method="post" action="/connect" novalidate>
        ${hidden}
        <label>Full name<input name="name" autocomplete="name" required maxlength="100" value="${esc(values.name)}"></label>
        <label>Email<input name="email" type="email" autocomplete="email" required maxlength="200" value="${esc(values.email)}"></label>
        <label>Mobile phone<input name="phone" type="tel" autocomplete="tel" required maxlength="25" value="${esc(values.phone)}"></label>
        <label class="check"><input type="checkbox" name="marketing_email" value="1" ${values.marketing_email ? 'checked' : ''}> Send me deals &amp; event news by email</label>
        <label class="check"><input type="checkbox" name="marketing_sms" value="1" ${values.marketing_sms ? 'checked' : ''}> Send me offers by text message (msg &amp; data rates may apply; reply STOP to opt out)</label>
        <label class="check"><input type="checkbox" name="terms" value="1" required> I agree to the Wi-Fi terms of use</label>
        <button type="submit">Set sail &amp; connect</button>
      </form>`
  });
}

// ---------- App ----------
const app = express();
app.set('trust proxy', true);
app.use(express.urlencoded({ extended: false, limit: '10kb' }));
app.use('/static', express.static(path.join(__dirname, 'public'), { maxAge: '1d' }));

app.get('/health', (_req, res) => res.json({ ok: true }));

// Connectivity check for the UniFi API: https://<app>/admin/unifi-check (user: admin, password: ADMIN_PASSWORD)
const isAdmin = (req) => {
  const [user, pass] = Buffer.from((req.get('authorization') || '').replace(/^Basic /, ''), 'base64').toString().split(':');
  return Boolean(ADMIN_PASSWORD) && user === 'admin' && pass === ADMIN_PASSWORD;
};
app.get('/admin/unifi-check', async (req, res) => {
  if (!isAdmin(req)) return res.set('WWW-Authenticate', 'Basic realm="admin"').status(401).send('Unauthorized');
  try {
    const sites = list(await unifi('GET', '/sites'));
    res.json({ ok: true, apiRoot: apiRoot(), sites: sites.map((s) => ({ id: s.id, name: s.name })) });
  } catch (e) {
    res.status(502).json({ ok: false, apiRoot: apiRoot(), error: e.message });
  }
});

// UniFi redirects guests to <portal>/guest/s/<site>/?id=<mac>&ap=...&url=...&ssid=...
app.get(['/', '/guest/s/:site', '/guest/s/:site/'], (req, res) => res.send(formPage(req.query)));

app.post('/connect', async (req, res) => {
  const b = req.body;
  const values = { name: (b.name || '').trim(), email: (b.email || '').trim().toLowerCase(), phone: cleanPhone(b.phone),
    marketing_email: b.marketing_email === '1', marketing_sms: b.marketing_sms === '1' };

  if (values.name.length < 2) return res.status(400).send(formPage(b, 'Please enter your name.', values));
  if (!EMAIL_RE.test(values.email)) return res.status(400).send(formPage(b, 'Please enter a valid email.', values));
  if (values.phone.replace(/\D/g, '').length < 7) return res.status(400).send(formPage(b, 'Please enter a valid phone number.', values));
  if (b.terms !== '1') return res.status(400).send(formPage(b, 'Please accept the terms of use.', values));

  const mac = MAC_RE.test(b.id || '') ? b.id.replace(/-/g, ':').toLowerCase() : null;

  try {
    if (pool) {
      await pool.query(
        `INSERT INTO guests (name,email,phone,marketing_email,marketing_sms,client_mac,ap_mac,ssid,user_agent)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
        [values.name, values.email, values.phone, values.marketing_email, values.marketing_sms,
         mac, (b.ap || '').slice(0, 32), (b.ssid || '').slice(0, 64), (req.get('user-agent') || '').slice(0, 300)]
      );
    }
  } catch (e) { console.error('DB insert failed:', e.message); }

  if (!mac) return res.status(400).send(formPage(b, 'We could not detect your device. Please reconnect to the Wi-Fi and try again.', values));

  try {
    await authorizeGuest(mac);
  } catch (e) {
    console.error('Authorize failed:', e.message);
    return res.status(502).send(formPage(b, 'Arr, the network hiccupped. Please try again in a moment.', values));
  }

  const dest = safeRedirect(SUCCESS_URL || b.url);
  res.send(page({
    title: "You're connected",
    body: `<div class="badge">🏴‍☠️</div><h1>You're connected!</h1>
      <p class="sub">Enjoy the Wi-Fi, ${esc(values.name.split(' ')[0])}. Hit 'em straight!</p>
      <p><a class="button" href="${esc(dest)}">Continue</a></p>
      <script>setTimeout(function(){location.href=${JSON.stringify(dest)}},4000)</script>`
  }));
});

// CSV export for campaigns: https://<app>/admin/export.csv  (user: admin, password: ADMIN_PASSWORD)
app.get('/admin/export.csv', async (req, res) => {
  if (!isAdmin(req)) return res.set('WWW-Authenticate', 'Basic realm="admin"').status(401).send('Unauthorized');
  if (!pool) return res.status(500).send('No database configured');
  const { rows } = await pool.query(
    `SELECT DISTINCT ON (lower(email)) name,email,phone,marketing_email,marketing_sms,created_at
       FROM guests ORDER BY lower(email), created_at DESC`);
  const csvCell = (v) => { let s = String(v ?? ''); if (/^[=+\-@]/.test(s)) s = "'" + s; return `"${s.replace(/"/g, '""')}"`; };
  const csv = ['name,email,phone,marketing_email,marketing_sms,first_seen']
    .concat(rows.map((r) => [r.name, r.email, r.phone, r.marketing_email, r.marketing_sms, r.created_at.toISOString()].map(csvCell).join(',')))
    .join('\n');
  res.set({ 'Content-Type': 'text/csv', 'Content-Disposition': 'attachment; filename="guests.csv"' }).send(csv);
});

initDb()
  .catch((e) => console.error('DB init failed:', e.message))
  .finally(() => app.listen(PORT, () => console.log(`Portal listening on :${PORT}`)));
