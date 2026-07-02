// Vercel serverless function — fetch one symbol from Yahoo and upsert it into
// Supabase, so a newly-added ticker populates immediately instead of waiting
// for the next monitor run. Best-effort: if it fails, the Python monitor will
// still enrich the row on its next run.
//
// Uses the SAME "last two daily closes" method as monitor.py so the daily %
// stays consistent between the two paths.

const SB_URL = process.env.SUPABASE_URL;
const SB_KEY = process.env.SUPABASE_ANON_KEY;

const round = (n, d) => { const f = 10 ** d; return Math.round(n * f) / f; };

async function yahoo(path) {
  const r = await fetch("https://query1.finance.yahoo.com" + path, {
    headers: { "User-Agent": "Mozilla/5.0" },
  });
  if (!r.ok) throw new Error("yahoo " + r.status);
  return r.json();
}

module.exports = async (req, res) => {
  try {
    const symbol = String(req.query.symbol || "").trim().toUpperCase();
    const id = String(req.query.id || symbol.replace(/[\/#?\[\]^]/g, "_")).trim();
    if (!symbol) return res.status(400).json({ error: "symbol required" });
    if (!SB_URL || !SB_KEY) return res.status(500).json({ error: "supabase env not configured" });

    // Daily closes -> last, prev, daily %
    const daily = await yahoo(`/v8/finance/chart/${encodeURIComponent(symbol)}?range=5d&interval=1d`);
    const dres = daily.chart?.result?.[0];
    if (!dres) return res.status(404).json({ error: "no data for " + symbol });
    const meta = dres.meta || {};
    const closes = (dres.indicators?.quote?.[0]?.close || []).filter((x) => x != null);
    const last = meta.regularMarketPrice ?? closes[closes.length - 1];
    const prev = closes.length >= 2 ? closes[closes.length - 2] : last;
    if (last == null) return res.status(404).json({ error: "no price for " + symbol });

    const today = new Date().toISOString().slice(0, 10);
    const patch = {
      last_price: round(last, 4),
      last_pct: prev ? round(((last - prev) / prev) * 100, 2) : 0,
      currency: meta.currency || "",
      asset_type: meta.instrumentType || null,
      updated_at: new Date().toISOString(),
      history_date: today,
    };

    // Monthly history -> ATH, CAGR, chart (best-effort)
    try {
      const monthly = await yahoo(`/v8/finance/chart/${encodeURIComponent(symbol)}?range=10y&interval=1mo`);
      const mres = monthly.chart?.result?.[0];
      const ts = mres?.timestamp || [];
      const mc = mres?.indicators?.quote?.[0]?.close || [];
      const pts = [];
      for (let i = 0; i < ts.length; i++) {
        if (mc[i] != null) {
          const dt = new Date(ts[i] * 1000);
          pts.push({ t: `${dt.getUTCFullYear()}-${String(dt.getUTCMonth() + 1).padStart(2, "0")}`, c: round(mc[i], 4) });
        }
      }
      if (pts.length) {
        const cs = pts.map((p) => p.c);
        const ath = Math.max(...cs, last);
        patch.ath = round(ath, 4);
        patch.ath_pct = last >= ath ? 0 : round((last / ath - 1) * 100, 2);
        const series = pts.slice(-120);
        patch.history = series;
        const a = series[0], b = series[series.length - 1];
        const years = (new Date(b.t + "-01") - new Date(a.t + "-01")) / (365.25 * 24 * 3600 * 1000);
        if (years > 0 && a.c > 0) patch.cagr = round((Math.pow(b.c / a.c, 1 / years) - 1) * 100, 2);
      }
    } catch (_) { /* history is optional; monitor will fill it in */ }

    const up = await fetch(`${SB_URL}/rest/v1/watchlist?id=eq.${encodeURIComponent(id)}`, {
      method: "PATCH",
      headers: {
        apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}`,
        "Content-Type": "application/json", Prefer: "return=minimal",
      },
      body: JSON.stringify(patch),
    });
    if (!up.ok) return res.status(502).json({ error: "supabase write " + up.status });

    return res.status(200).json({ ok: true, symbol, last: patch.last_price, pct: patch.last_pct });
  } catch (e) {
    return res.status(500).json({ error: String(e.message || e) });
  }
};
