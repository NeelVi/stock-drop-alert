// Vercel serverless function — the full price-drop check, meant to be pinged
// every ~15 min by a free external cron (e.g. cron-job.org). It self-gates by
// market hours, so pinging it around the clock is fine (off-hours = no-op).
//
// Mirrors monitor.py: read watchlist + device tokens from Supabase, fetch
// quotes from Yahoo, refresh ATH/CAGR/chart once a day, two-tier alerts, send
// FCM, and dedupe per day. Requires env vars: SUPABASE_URL, SUPABASE_ANON_KEY,
// FIREBASE_SERVICE_ACCOUNT (service-account JSON), and optional CHECK_KEY.

const admin = require("firebase-admin");

const SB_URL = process.env.SUPABASE_URL;
const SB_KEY = process.env.SUPABASE_ANON_KEY;
const CHECK_KEY = process.env.CHECK_KEY;
const DEFAULT_THRESHOLD = 3;

const round = (n, d) => { const f = 10 ** d; return Math.round(n * f) / f; };

function messaging() {
  if (!admin.apps.length) {
    admin.initializeApp({ credential: admin.credential.cert(JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT)) });
  }
  return admin.messaging();
}

// --- Supabase REST ---
const sbHeaders = (extra) => ({ apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}`, "Content-Type": "application/json", ...(extra || {}) });
async function sbGet(q) {
  const r = await fetch(`${SB_URL}/rest/v1/${q}`, { headers: sbHeaders() });
  if (!r.ok) throw new Error("supabase get " + r.status);
  return r.json();
}
async function sbPatch(id, body) {
  await fetch(`${SB_URL}/rest/v1/watchlist?id=eq.${encodeURIComponent(id)}`, {
    method: "PATCH", headers: sbHeaders({ Prefer: "return=minimal" }), body: JSON.stringify(body),
  });
}
// Small key/value store for global (non-per-stock) state, e.g. market-alert dedup.
async function getState(key) {
  const r = await sbGet(`app_state?key=eq.${encodeURIComponent(key)}&select=value`);
  return r[0]?.value ?? null;
}
async function setState(key, value) {
  await fetch(`${SB_URL}/rest/v1/app_state`, {
    method: "POST", headers: sbHeaders({ Prefer: "resolution=merge-duplicates,return=minimal" }),
    body: JSON.stringify({ key, value }),
  });
}

// --- Yahoo ---
async function yahoo(path) {
  const r = await fetch("https://query1.finance.yahoo.com" + path, { headers: { "User-Agent": "Mozilla/5.0" } });
  if (!r.ok) throw new Error("yahoo " + r.status);
  return r.json();
}
async function fetchDaily(symbol) {
  const d = await yahoo(`/v8/finance/chart/${encodeURIComponent(symbol)}?range=5d&interval=1d`);
  const r = d.chart?.result?.[0];
  if (!r) return null;
  const m = r.meta || {};
  const cl = (r.indicators?.quote?.[0]?.close || []).filter((x) => x != null);
  const last = m.regularMarketPrice ?? cl[cl.length - 1];
  const prev = cl.length >= 2 ? cl[cl.length - 2] : last;
  if (last == null) return null;
  return { last, prev, currency: m.currency || "", type: m.instrumentType || null };
}
async function fetchMonthly(symbol) {
  try {
    const d = await yahoo(`/v8/finance/chart/${encodeURIComponent(symbol)}?range=10y&interval=1mo`);
    const r = d.chart?.result?.[0];
    const ts = r?.timestamp || [];
    const mc = r?.indicators?.quote?.[0]?.close || [];
    const pts = [];
    for (let i = 0; i < ts.length; i++) {
      if (mc[i] != null) {
        const dt = new Date(ts[i] * 1000);
        pts.push({ t: `${dt.getUTCFullYear()}-${String(dt.getUTCMonth() + 1).padStart(2, "0")}`, c: round(mc[i], 4) });
      }
    }
    if (!pts.length) return null;
    const cs = pts.map((p) => p.c);
    const series = pts.slice(-120);
    const a = series[0], b = series[series.length - 1];
    const years = (new Date(b.t + "-01") - new Date(a.t + "-01")) / (365.25 * 24 * 3600 * 1000);
    const cagr = years > 0 && a.c > 0 ? round((Math.pow(b.c / a.c, 1 / years) - 1) * 100, 2) : null;
    return { ath: round(Math.max(...cs), 4), cagr, history: series };
  } catch (_) { return null; }
}

// --- Market hours (mirror of monitor.py is_market_open) ---
const EX = {
  ".NS": ["Asia/Kolkata", [9, 15], [15, 30]], ".BO": ["Asia/Kolkata", [9, 15], [15, 30]],
  ".L": ["Europe/London", [8, 0], [16, 30]], ".DE": ["Europe/Berlin", [9, 0], [17, 30]],
  ".PA": ["Europe/Paris", [9, 0], [17, 30]], ".TO": ["America/Toronto", [9, 30], [16, 0]],
  ".HK": ["Asia/Hong_Kong", [9, 30], [16, 0]], ".T": ["Asia/Tokyo", [9, 0], [15, 0]],
  ".AX": ["Australia/Sydney", [10, 0], [16, 0]], ".SI": ["Asia/Singapore", [9, 0], [17, 0]],
};
const US = ["America/New_York", [9, 30], [16, 0]];
function isMarketOpen(symbol, assetType) {
  const at = (assetType || "").toUpperCase();
  if (at === "") return true;
  if (at === "MUTUALFUND" || at === "INDEX") return true;
  const s = symbol.toUpperCase();
  if (s.endsWith("=X")) return true;
  let spec = US;
  for (const suf in EX) if (s.endsWith(suf)) { spec = EX[suf]; break; }
  const [tz, [oh, om], [ch, cm]] = spec;
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-US", { timeZone: tz, weekday: "short", hour: "2-digit", minute: "2-digit", hour12: false })
      .formatToParts(new Date()).map((p) => [p.type, p.value])
  );
  if (parts.weekday === "Sat" || parts.weekday === "Sun") return false;
  let hh = parseInt(parts.hour, 10); if (hh === 24) hh = 0;
  const cur = hh * 60 + parseInt(parts.minute, 10);
  return cur >= oh * 60 + om && cur <= ch * 60 + cm;
}

// --- Two-tier decision (mirror of monitor.py decide_alert) ---
function decideAlert(change, threshold, strong, dipDone, strongDone) {
  const hitStrong = strong != null && change <= -Math.abs(strong);
  if (hitStrong && !strongDone) return "strong";
  if (change <= -Math.abs(threshold) && !hitStrong && !dipDone) return "dip";
  return null;
}

module.exports = async (req, res) => {
  try {
    if (CHECK_KEY && req.query.key !== CHECK_KEY) return res.status(403).json({ error: "forbidden" });
    if (!SB_URL || !SB_KEY) return res.status(500).json({ error: "supabase env not configured" });

    // Diagnostic: ?test=1 sends a test push and returns the full FCM result.
    if (req.query.test === "1") {
      const toks = (await sbGet("devices?select=token")).map((d) => d.token).filter(Boolean);
      if (!toks.length) return res.status(200).json({ error: "no devices registered" });
      const r = await messaging().sendEachForMulticast({
        tokens: toks,
        notification: { title: "Test ✅", body: "Push from the Vercel check endpoint." },
        webpush: { notification: { title: "Test ✅", body: "Push from the Vercel check endpoint.", icon: "icon-192.png" } },
      });
      return res.status(200).json({
        successCount: r.successCount, failureCount: r.failureCount,
        responses: r.responses.map((x) => ({ success: x.success, code: x.error?.code || null, message: x.error?.message || null })),
      });
    }

    const [wl, devs] = await Promise.all([sbGet("watchlist?select=*"), sbGet("devices?select=token")]);
    const tokens = devs.map((d) => d.token).filter(Boolean);
    const today = new Date().toISOString().slice(0, 10);
    const results = [];

    await Promise.all(wl.map(async (item) => {
      try {
        if (!isMarketOpen(item.symbol, item.asset_type)) { results.push({ s: item.symbol, skipped: true }); return; }
        const q = await fetchDaily(item.symbol);
        if (!q) { results.push({ s: item.symbol, err: "no quote" }); return; }
        const change = q.prev ? ((q.last - q.prev) / q.prev) * 100 : 0;
        const patch = { last_price: round(q.last, 4), last_pct: round(change, 2), currency: q.currency, updated_at: new Date().toISOString() };
        if (q.type && !item.asset_type) patch.asset_type = q.type;

        // once-a-day ATH / CAGR / chart refresh
        let ath = item.ath;
        if (item.history_date !== today || item.history == null || ath == null) {
          const e = await fetchMonthly(item.symbol);
          patch.history_date = today;
          if (e) {
            if (e.history?.length) patch.history = e.history;
            if (e.cagr != null) patch.cagr = e.cagr;
            if (e.ath != null) ath = ath == null ? e.ath : Math.max(ath, e.ath);
          }
        }
        if (ath == null) patch.ath_pct = null;
        else if (q.last >= ath) { ath = round(q.last, 4); patch.ath = ath; patch.ath_pct = 0; }
        else { patch.ath = round(ath, 4); patch.ath_pct = round((q.last / ath - 1) * 100, 2); }

        // two-tier alert
        const threshold = item.threshold_pct != null ? item.threshold_pct : DEFAULT_THRESHOLD;
        const strong = item.threshold2_pct != null ? item.threshold2_pct : null;
        const kind = decideAlert(change, threshold, strong, item.last_alert_date === today, item.last_alert2_date === today);
        if (kind && tokens.length) {
          const label = item.name || item.symbol;
          const cur = q.currency ? " " + q.currency : "";
          let title, body, fields;
          if (kind === "strong") {
            title = `🔻 ${label} down ${Math.abs(change).toFixed(1)}% — big dip`;
            body = `${label} at ${q.last.toFixed(2)}${cur} (${change.toFixed(2)}% vs prev close). Strong buy-the-dip level.`;
            fields = ["last_alert2_date", "last_alert_date"];
          } else {
            title = `${label} down ${Math.abs(change).toFixed(1)}%`;
            body = `${label} at ${q.last.toFixed(2)}${cur} (${change.toFixed(2)}% vs prev close).`;
            fields = ["last_alert_date"];
          }
          const sent = await messaging().sendEachForMulticast({
            tokens, notification: { title, body },
            webpush: { notification: { title, body, icon: "icon-192.png" } },
          });
          for (const f of fields) patch[f] = today;
          patch.last_alert_pct = round(change, 2);
          results.push({ s: item.symbol, alert: kind, change: round(change, 2), sent: sent.successCount, failed: sent.failureCount });
        } else {
          results.push({ s: item.symbol, change: round(change, 2) });
        }
        await sbPatch(item.id, patch);
      } catch (e) {
        results.push({ s: item.symbol, err: String(e.message || e) });
      }
    }));

    // --- Market-wide "buying opportunity" alert ---
    // Fires (once/day) on a broad selloff: either a large share of names checked
    // are down together (breadth), OR a benchmark index is down hard. ?dry=1 skips.
    const MKT_DROP = 3, MKT_MIN_DOWN = 3, MKT_MIN_CHECKED = 4, MKT_FRACTION = 0.4, INDEX_DROP = 2.5;
    const changes = results.filter((r) => typeof r.change === "number");
    const downBig = changes.filter((r) => r.change <= -MKT_DROP).sort((a, b) => a.change - b.change);
    const breadth = changes.length >= MKT_MIN_CHECKED && downBig.length >= MKT_MIN_DOWN
      && downBig.length / changes.length >= MKT_FRACTION;

    // Benchmark index: S&P 500 during US hours, Nifty 50 during NSE hours.
    let index = null;
    try {
      const benches = [];
      if (isMarketOpen("AAPL", "EQUITY")) benches.push(["^GSPC", "S&P 500"]);
      if (isMarketOpen("RELIANCE.NS", "EQUITY")) benches.push(["^NSEI", "Nifty 50"]);
      for (const [sym, label] of benches) {
        const q = await fetchDaily(sym);
        if (!q) continue;
        const chg = q.prev ? ((q.last - q.prev) / q.prev) * 100 : 0;
        if (chg <= -INDEX_DROP) { index = { label, chg: round(chg, 2) }; break; }
      }
    } catch (_) {}

    const hit = breadth || !!index;
    const market = { checked: changes.length, downBig: downBig.length, breadth, index, hit, sent: false };
    if (hit && tokens.length && req.query.dry !== "1") {
      let stateOk = true, alreadyToday = false;
      try { alreadyToday = (await getState("market_alert_date")) === today; }
      catch (_) { stateOk = false; }  // app_state table not created yet — skip safely
      if (stateOk && !alreadyToday) {
        const top = downBig.slice(0, 5).map((r) => `${r.s} ${r.change.toFixed(1)}%`).join(", ");
        const title = "🟢 Buying opportunity — broad market dip";
        const body = (index ? `${index.label} down ${Math.abs(index.chg)}%. ` : "")
          + (downBig.length ? `${downBig.length} of ${changes.length} tracked names down${top ? ` (${top}).` : "."}` : "Broad market weakness.");
        const s = await messaging().sendEachForMulticast({
          tokens, notification: { title, body },
          webpush: { notification: { title, body, icon: "icon-192.png" } },
        });
        try { await setState("market_alert_date", today); } catch (_) {}
        market.sent = s.successCount; market.failed = s.failureCount;
      } else {
        market.dedup = alreadyToday; market.stateOk = stateOk;
      }
    }

    return res.status(200).json({ ok: true, checked: wl.length, devices: tokens.length, market, results });
  } catch (e) {
    return res.status(500).json({ error: String(e.message || e) });
  }
};
