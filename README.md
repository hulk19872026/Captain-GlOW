# Pirate Golf Guest Wi-Fi Portal (UniFi UDR7 + Railway)

Guests join your open guest Wi-Fi → get the pirate-golf splash page → enter **name, email, phone** → the app saves them to a **Railway Postgres** database and tells your UDR7 to let that device online.

```
Phone ──joins Guest SSID──▶ UDR7 ──redirects──▶ this app on Railway
                                                     │ saves name/email/phone → Railway Postgres
UDR7 ◀──"authorize this MAC"── api.ui.com cloud connector ◀──┘
```

Requires UniFi Network **9.1 or newer** on the UDR7 (for the official API key + guest-authorize API).

---

## 1. Put the code on GitHub
1. Create a **private** repo on GitHub (e.g. `pirate-golf-portal`).
2. Upload everything in this folder (`server.js`, `package.json`, `public/`, `README.md`, `.gitignore`).

> GitHub holds the **code**, not the guest data. Don't put emails/phone numbers in a repo — that's what the Railway database is for.

## 2. Deploy on Railway
1. railway.com → **New Project → Deploy from GitHub repo** → pick the repo.
2. In the same project: **+ New → Database → PostgreSQL**.
3. Open your app service → **Variables** → add:

| Variable | Value |
|---|---|
| `DATABASE_URL` | `${{Postgres.DATABASE_URL}}` (Railway reference variable) |
| `UNIFI_BASE_URL` | `https://api.ui.com/v1/connector/consoles/<YOUR_CONSOLE_ID>` |
| `UNIFI_API_KEY` | Site Manager API key (step 3) |
| `ADMIN_PASSWORD` | a long password for downloading the list |
| `BUSINESS_NAME` | `Captain Glow` (shown on the sign-in page) |
| `SESSION_MINUTES` | `120` (guests are kicked off after this many minutes; optional) |
| `REAUTH_AFTER_DISCONNECT_MINUTES` | `5` (a guest gone this long sees the portal again when they return; `0` disables; optional) |
| `SUCCESS_URL` | your website, shown after connecting (optional) |
| `RATE_LIMIT_DOWN_KBPS` / `RATE_LIMIT_UP_KBPS` | optional speed caps, e.g. `20000` / `5000` |

4. **Settings → Networking → Generate Domain**. You'll get something like `pirate-golf-portal.up.railway.app`. Visit `https://<that-domain>/health` — it should say `{"ok":true}`.

## 3. Get your UniFi API key + console ID
1. Sign in at **unifi.ui.com** (Site Manager).
2. **Settings → API Keys → Create API Key** → copy it into `UNIFI_API_KEY`.
3. Your **console ID** is shown for the UDR7 in Site Manager (also in the URL when you open the console). Put it into `UNIFI_BASE_URL`.

The app talks to your UDR7 through Ubiquiti's cloud connector, so you do **not** need to port-forward anything. (`UNIFI_SITE_ID` is auto-detected; only set it if you have multiple sites.)

## 4. Configure the guest network on the UDR7
In the UniFi Network app:
1. **Settings → WiFi → Create New** → name it e.g. `Pirate Golf Guest`, security **Open**, network = a dedicated guest network/VLAN (zone **Hotspot**), turn on **Client Device Isolation**.
2. **Settings → Hotspot (Insights → Hotspot Manager on some versions) → Landing Page / Portal**:
   - Authentication: **External Portal Server**
   - Portal address: your Railway domain, e.g. `pirate-golf-portal.up.railway.app`
   - **Turn OFF** "HTTPS redirection" / "Secure portal" (common cause of a blank splash page).
3. **Pre-Authorization Allowances** (walled garden) — add:
   - `pirate-golf-portal.up.railway.app` (your Railway domain)
   - If your version only accepts IPs, run `nslookup <your-domain>` and add those IPs.
4. Make sure the guest SSID has the Hotspot portal enabled.

Test with your phone: forget your normal Wi-Fi, join the guest SSID, the pirate page should pop up. Fill it in → "You're connected!".

## 5. Getting the list for campaigns
- **Download CSV:** open `https://<your-domain>/admin/export.csv`, username `admin`, password = `ADMIN_PASSWORD`. One row per email (latest visit), with whether they opted in to email and/or SMS. Import straight into Mailchimp, Klaviyo, Constant Contact, etc.
- **Or directly:** Railway → Postgres → **Data** tab → `guests` table.

### Opt-in matters
The form has separate, unchecked boxes for email marketing and text marketing. Only send campaigns to people who ticked them — US law (CAN-SPAM for email, TCPA for texts) requires consent and an unsubscribe option, and TCPA fines for unwanted marketing texts are steep. The `marketing_email` / `marketing_sms` columns tell you who's in. Also add a short privacy note / Wi-Fi terms page if you have a website and link it via `SUCCESS_URL` or the form.

## Customizing
- Background art: `public/background.svg` (swap in any image and update `portal.css`).
- Colors/fonts: `public/portal.css`.
- Wording: `formPage()` in `server.js`.

## Troubleshooting
| Symptom | Fix |
|---|---|
| No splash page pops up | Railway domain missing from Pre-Authorization Allowances; HTTPS redirect still on |
| `fetch failed` in Railway logs | Open `https://<your-domain>/admin/unifi-check` (user `admin`, password `ADMIN_PASSWORD`) — it shows the exact URL being called and the underlying reason (`ENOTFOUND` = typo in `UNIFI_BASE_URL`, `ECONNREFUSED`/timeout = pointing at a LAN IP like `192.168.1.1`, which Railway can't reach — use the `api.ui.com` connector URL) |
| "Network hiccupped" after submitting | Check Railway **Logs** for `Authorize failed`. 401 = wrong API key; 404 = wrong console ID; make sure UniFi Network ≥ 9.1 |
| "Could not detect your device" | The page was opened without UniFi's `?id=` parameter — reconnect to the guest Wi-Fi rather than opening the URL directly |
| Want to run on your LAN instead | Set `UNIFI_BASE_URL=https://192.168.1.1`, create the key in **Network → Settings → Control Plane → Integrations**, and set `UNIFI_INSECURE_TLS=true` |
