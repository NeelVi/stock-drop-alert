# 📉 Stock / Mutual-Fund Drop Alerts

Get a **push notification** (via Firebase Cloud Messaging) whenever a stock,
ETF, or mutual fund on your watchlist drops more than a set percentage
**versus its previous close**. Works with global tickers via Yahoo Finance.

**You manage your watchlist from the app itself** — add/remove stocks and set
per-stock drop thresholds on your phone. The list lives in **Supabase** (free
Postgres, no credit card); the PC monitor reads it, checks prices, sends the
push, and writes live prices back so the app shows them.

Three free services, each doing one job:

| Service | Job | Cost |
|---|---|---|
| **Supabase** | store the watchlist + device tokens | free, no card |
| **Firebase Cloud Messaging** | deliver the push notification | free, no card |
| **Vercel** | host the installable web app | free |
| **GitHub Actions** | run the price check every 15 min (so your PC needn't be on) | free |
| **Yahoo Finance** | price data (via `yfinance`) | free |

```
stock-drop-alert/
├── monitor.py          # the price checker + notifier (runs in the cloud or on your PC)
├── config.json         # settings + Supabase keys + a fallback watchlist
├── supabase-schema.sql # run once in Supabase to create the tables
├── requirements.txt
├── serviceAccountKey.json   # (you add this) Firebase admin credentials — SECRET
├── state.json          # local-only dedup memory (cloud runs use Supabase instead)
├── .github/workflows/monitor.yml  # runs the check every 15 min on GitHub Actions
└── web/                     # the installable phone app (PWA) — deployed to Vercel
    ├── index.html               # the app: manage watchlist + enable push
    ├── manifest.json            # makes it installable ("Add to Home Screen")
    ├── firebase-messaging-sw.js # background push receiver / service worker
    ├── firebase-config.js       # (you fill in) Firebase WEB config (public)
    ├── supabase-config.js       # (you fill in) Supabase URL + anon key (public)
    ├── vercel.json              # Vercel headers (service-worker caching/scope)
    └── icon-*.png               # app icons
```

---

## 1. Install Python deps

```powershell
cd "E:\Neel\Cool Projects\stock-drop-alert"
python -m venv .venv
.\.venv\Scripts\Activate.ps1
pip install -r requirements.txt
```

## 2. Try it with no Firebase (sanity check)

This just prints live quotes and % change — no notifications, no credentials needed:

```powershell
python monitor.py --list
```

This uses the fallback list in `config.json` (once Supabase is set up you'll
manage stocks from the app instead). Symbols follow Yahoo Finance format:
- US stocks/ETFs: `AAPL`, `MSFT`, `VOO`
- India (NSE): `RELIANCE.NS`, `TCS.NS`   •   BSE: `500325.BO`
- London: `VOD.L`   •   US mutual funds like `VFINX`
- Find any symbol at https://finance.yahoo.com — the text in the URL is the ticker.

---

## 3. Set up Firebase (push delivery only — free, no card)

Firebase is used **only to deliver the push**. It needs two sets of credentials:
one for the *sender* (this script) and one for the *receiver* (your browser).

### a. Create the project
1. Go to https://console.firebase.google.com → **Add project** (any name).
2. **Build → Cloud Messaging** — it's enabled by default. (You do **not** need
   Firestore — that's the part that now asks for a card, and we use Supabase instead.)

### b. Sender credentials → `serviceAccountKey.json`
1. **Project settings** (gear icon) → **Service accounts** tab.
2. Click **Generate new private key** → downloads a JSON file.
3. Save it in this folder as **`serviceAccountKey.json`**.

### c. Receiver credentials → `web/firebase-config.js`
1. **Project settings → General → Your apps →** click the **Web** icon (`</>`),
   register an app. Copy the `firebaseConfig` object it shows you.
2. **Project settings → Cloud Messaging → Web Push certificates →**
   **Generate key pair**. Copy the key string.
3. Open `web/firebase-config.js` and paste both in (config object + `vapidKey`).

---

## 4. Set up Supabase (the watchlist store — free, no card)

1. Go to https://supabase.com → sign in with GitHub → **New project**
   (no credit card required). Pick any name/region and set a database password.
2. When it's ready, open **SQL Editor → New query**, paste the entire contents of
   [`supabase-schema.sql`](supabase-schema.sql), and click **Run**. This creates
   the `watchlist` and `devices` tables and their access rules.
3. **Project Settings → API** and copy two values:
   - **Project URL**  → e.g. `https://abcd1234.supabase.co`
   - **Project API keys → `anon` `public`** (the long one labeled *anon*)
4. Paste both into **two** places:
   - `web/supabase-config.js` (`supabaseUrl`, `supabaseAnonKey`) — used by the app
   - `config.json` under `"supabase"` (`url`, `anon_key`) — used by the monitor

> The anon key is designed to live in client code — it's public. Access is
> limited to those two tables by the rules in `supabase-schema.sql`. Anyone with
> your app URL could edit your watchlist; fine for personal use, and you can add
> Supabase Auth later to lock it down.
>
> Free-tier projects pause after ~1 week idle — but the monitor polls regularly,
> which keeps it awake.

---

## 5. Put the app online with Vercel (so your phone can install it)

Installing a PWA on a phone needs an **HTTPS** URL. We host the static app on
Vercel (free, automatic HTTPS). Deploy **from the `web/` folder** so only the
app ships — not `monitor.py`.

```powershell
cd "E:\Neel\Cool Projects\stock-drop-alert\web"
npx vercel            # first run: log in + create the project (accept defaults)
npx vercel --prod     # publish — prints your https://<name>.vercel.app URL
```

That URL is your app. Re-run `npx vercel --prod` whenever you change files in `web/`.
There's nothing else to deploy — Supabase and Firebase are already live in the cloud.

> **Notes**
> - `web/firebase-config.js` and `web/supabase-config.js` must ship with the app.
>   They hold only *public* client config (safe to expose) — the CLI deploy above
>   includes them. If you instead connect a **Git repo** to Vercel, un-ignore both
>   so they're committed. (The real secret, `serviceAccountKey.json`, stays on
>   your PC only and is never deployed.)
> - FCM and Supabase both work from any domain — no special hosting needed.
> - Quick local test (desktop only): `python -m http.server 8000 --directory web`
>   then open `http://localhost:8000`. A phone can't install from `localhost` —
>   use the Vercel URL for the phone.

## 6. Install the app & use it

1. On your phone, open the hosted URL in **Chrome (Android)** or **Safari (iOS 16.4+)**.
2. Tap **📲 Install app** (or browser menu → *Add to Home Screen* / *Install app*).
3. Open the installed app, tap **🔔 Enable notifications**, allow the prompt.
   The app registers its own push token in Supabase — **no copy-paste needed.**
4. In **Add a stock / fund**, type a Yahoo ticker (e.g. `AAPL`, `RELIANCE.NS`,
   `VFINX`), an optional drop %, and tap **Add**. It appears in **My watchlist**.
5. Adjust a stock's threshold inline, or tap **✕** to remove it. Once the
   monitor runs, each row shows the latest price and % change.

You can install on multiple devices — each one registers itself and all get the
alerts.

> **iOS note:** notifications only work *after* the app is added to the home
> screen (iOS won't push to a plain Safari tab). Android/desktop Chrome work
> either way, but installing gives you the standalone app + lock-screen alerts.

---

## 7. Run the monitor

You get **at most one alert per instrument per day** so a slow-bleeding stock
won't spam you (that "already alerted" flag is stored in Supabase, so it works
even across cloud runs).

### Option A — Vercel endpoint + free cron pinger (recommended) ☁️

The most reliable free way to get true ~15-min checks. A serverless endpoint
`/api/check` runs the whole monitor (quotes, ATH refresh, two-tier alerts, FCM,
per-day dedup) and **self-gates by market hours**, so it's safe to ping around
the clock. A free external cron service pings it every 15 minutes.

1. It deploys automatically with the app (`npx vercel --prod`). It needs these
   Vercel env vars (**Project → Settings → Environment Variables**, Production):
   `SUPABASE_URL`, `SUPABASE_ANON_KEY`, `FIREBASE_SERVICE_ACCOUNT` (the whole
   service-account JSON), and `CHECK_KEY` (any random string).
2. Sign up at **cron-job.org** (free, no card). Create a cron job:
   - URL: `https://YOUR-APP.vercel.app/api/check?key=YOUR_CHECK_KEY`
   - Schedule: every 15 minutes.
3. Done — it runs 24/7 and only acts during market hours. `?key=` keeps randoms
   from triggering it.

> Why not rely on GitHub's schedule: GitHub throttles scheduled workflows heavily
> on free/public repos — a `*/15` cron often runs only every 1–2 hours, which
> misses intraday dips. Option B is kept as a coarse backup.

### Option B — GitHub Actions (coarse backup) ☁️

Also runs in the cloud, but on GitHub's throttled schedule (often ~every 1–2h,
not 15 min). Fine as redundancy; not your primary signal.

1. Put this project in a **GitHub repo** and push it:
   ```powershell
   cd "E:\Neel\Cool Projects\stock-drop-alert"
   git init && git add . && git commit -m "Stock drop alerts"
   gh repo create stock-drop-alert --private --source=. --push
   ```
   (A **public** repo gives unlimited Actions minutes; a **private** repo has
   ~2000 free min/month — plenty at 15-min checks. Your secrets are stored
   encrypted either way, never in the code.)
2. Add your secrets: repo **Settings → Secrets and variables → Actions → New
   repository secret**. Add three:
   - `SUPABASE_URL` — your Supabase project URL
   - `SUPABASE_ANON_KEY` — your Supabase anon key
   - `FIREBASE_SERVICE_ACCOUNT` — paste the **entire contents** of
     `serviceAccountKey.json`
3. Go to the **Actions** tab → **Stock drop monitor** → **Run workflow** to test
   it now, then it runs automatically on the schedule.

The schedule lives in [`.github/workflows/monitor.yml`](.github/workflows/monitor.yml)
(edit the `cron:` line to change frequency).

> GitHub disables scheduled workflows after ~60 days with no repo activity — just
> push a commit occasionally, or re-enable it from the Actions tab.

### Option C — On your PC (manual / testing)

```powershell
python monitor.py            # continuous, checks every check_interval_minutes
python monitor.py --once     # a single check (for Windows Task Scheduler)
python monitor.py --list     # print quotes only, no alerts (sanity check)
python monitor.py --test     # send a test push to every registered device, then exit
```

Use `--test` after saving `serviceAccountKey.json` and tapping **Enable
notifications** in the app — it confirms notifications actually arrive without
waiting for a real price drop.

To run it in the background on Windows: **Task Scheduler → Create Basic Task →**
trigger Daily, repeat every 15 min → action *Start a program*:
- Program: `E:\Neel\Cool Projects\stock-drop-alert\.venv\Scripts\python.exe`
- Arguments: `monitor.py --once`  •  Start in: the project folder

---

## Notes & limits
- Yahoo Finance is unofficial/free; occasional gaps or rate-limits can happen.
  The script skips a symbol it can't fetch and moves on.
- Mutual fund NAVs usually update once per day after market close, so a fund's
  "% vs previous close" only changes daily — expect at most one check to matter.
- The only real secret is `serviceAccountKey.json` (it can send pushes as your
  project) — it's in `.gitignore` and stays on your PC. The `firebase-config.js`
  and `supabase-config.js` values are public client config by design.
- Data lives in Supabase; Firestore is **not** used (that's the part that now
  requires a credit card).
- **Market-hours gating** (`"market_hours_only": true` in `config.json`): during
  alert runs, a symbol is skipped when its exchange is closed — decided per symbol
  by its Yahoo suffix (`.NS`, `.L`, …), weekday, and regular hours. Crypto (`-USD`)
  and FX (`=X`) are treated as 24/7; unknown exchanges are always checked. Set it
  to `false` to check around the clock. (`--list` always shows every symbol.)
