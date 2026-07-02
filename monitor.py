#!/usr/bin/env python3
"""
Stock / Mutual-Fund drop alerter.

Checks a watchlist of tickers (global, via Yahoo Finance) and sends a
Firebase Cloud Messaging (FCM) push notification when an instrument is
down by more than its configured percentage versus the previous close.

The watchlist and device tokens live in Supabase (free Postgres) so you can
manage them from the web/phone app. If Supabase isn't set up yet, it falls
back to the "watchlist" / "fcm_tokens" in config.json.

  Data  = Supabase   (read watchlist + tokens, write live prices back)
  Push  = Firebase Cloud Messaging (send the notification)
  Price = Yahoo Finance

Usage:
    python monitor.py            # run continuously, checking every N minutes
    python monitor.py --once     # run a single check and exit (for Task Scheduler / cron)
    python monitor.py --list     # print current prices / % change, no alerts
"""

import argparse
import datetime as dt
import json
import os
import sys
import time

import requests

# Print UTF-8 (emoji, arrows, dashes) without crashing on the Windows console.
for _stream in (sys.stdout, sys.stderr):
    try:
        _stream.reconfigure(encoding="utf-8")
    except Exception:
        pass

BASE = os.path.dirname(os.path.abspath(__file__))
CONFIG_FILE = os.path.join(BASE, "config.json")
STATE_FILE = os.path.join(BASE, "state.json")


# --------------------------------------------------------------------------- #
# Config / state helpers
# --------------------------------------------------------------------------- #
def load_config():
    if not os.path.exists(CONFIG_FILE):
        sys.exit(f"Config file not found: {CONFIG_FILE}")
    with open(CONFIG_FILE, "r", encoding="utf-8") as f:
        return json.load(f)


def load_state():
    if os.path.exists(STATE_FILE):
        try:
            with open(STATE_FILE, "r", encoding="utf-8") as f:
                return json.load(f)
        except (json.JSONDecodeError, OSError):
            return {}
    return {}


def save_state(state):
    with open(STATE_FILE, "w", encoding="utf-8") as f:
        json.dump(state, f, indent=2)


def today_str():
    return dt.date.today().isoformat()


# --------------------------------------------------------------------------- #
# Supabase (data store) — REST via the public anon key
# --------------------------------------------------------------------------- #
def sb_config(config):
    """
    Return (base_url, anon_key) if Supabase is configured, else (None, None).
    Environment variables (used by the GitHub Actions cloud runner) win over
    config.json.
    """
    sb = config.get("supabase", {})
    url = (os.environ.get("SUPABASE_URL") or sb.get("url") or "").rstrip("/")
    key = os.environ.get("SUPABASE_ANON_KEY") or sb.get("anon_key") or ""
    if url and key and "YOUR" not in url and "YOUR" not in key:
        return url, key
    return None, None


def sb_headers(key, extra=None):
    h = {
        "apikey": key,
        "Authorization": f"Bearer {key}",
        "Content-Type": "application/json",
    }
    if extra:
        h.update(extra)
    return h


def get_watchlist(config):
    """
    Return (items, sb) where sb is (url, key) or None.
    Firestore-free: reads from Supabase, falls back to config.json.
    """
    url, key = sb_config(config)
    if url:
        try:
            r = requests.get(
                f"{url}/rest/v1/watchlist?select=*",
                headers=sb_headers(key), timeout=20,
            )
            r.raise_for_status()
            items = r.json()
            if items:
                return items, (url, key)
            # reachable but empty -> seed from config.json below
        except Exception as e:
            print(f"  [warn] Supabase watchlist read failed: {e}")
    return config.get("watchlist", []), None


def get_tokens(config, sb):
    tokens = list(config.get("fcm_tokens", []))
    if sb:
        url, key = sb
        try:
            r = requests.get(
                f"{url}/rest/v1/devices?select=token",
                headers=sb_headers(key), timeout=20,
            )
            r.raise_for_status()
            for row in r.json():
                t = row.get("token")
                if t and t not in tokens:
                    tokens.append(t)
        except Exception as e:
            print(f"  [warn] Supabase devices read failed: {e}")
    return tokens


def sb_patch(sb, row_id, body):
    url, key = sb
    try:
        requests.patch(
            f"{url}/rest/v1/watchlist?id=eq.{row_id}",
            headers=sb_headers(key, {"Prefer": "return=minimal"}),
            json=body, timeout=20,
        )
    except Exception as e:
        print(f"    [warn] Supabase update failed: {e}")


def write_price(sb, row_id, last, change, currency):
    sb_patch(sb, row_id, {
        "last_price": round(last, 4),
        "last_pct": round(change, 2),
        "currency": currency,
        "updated_at": dt.datetime.now(dt.timezone.utc).isoformat(),
    })


def mark_alerted(sb, row_id, today, change):
    sb_patch(sb, row_id, {"last_alert_date": today, "last_alert_pct": round(change, 2)})


# --------------------------------------------------------------------------- #
# Price fetching (Yahoo Finance)
# --------------------------------------------------------------------------- #
def get_quote(symbol):
    """Return (last_price, previous_close, currency) or None on failure."""
    import yfinance as yf

    tkr = yf.Ticker(symbol)
    last = prev = None
    currency = ""

    try:
        fi = tkr.fast_info
        last = fi.get("last_price")
        prev = fi.get("previous_close")
        currency = fi.get("currency") or ""
    except Exception:
        pass

    if not last or not prev:
        try:
            hist = tkr.history(period="5d", auto_adjust=False)
            if len(hist) >= 2:
                last = float(hist["Close"].iloc[-1])
                prev = float(hist["Close"].iloc[-2])
            elif len(hist) == 1:
                last = float(hist["Close"].iloc[-1])
                prev = last
        except Exception:
            return None

    if not last or not prev:
        return None
    return float(last), float(prev), currency


def pct_change(last, prev):
    return (last - prev) / prev * 100.0 if prev else 0.0


# --------------------------------------------------------------------------- #
# Firebase Cloud Messaging (push only)
# --------------------------------------------------------------------------- #
_fcm_ready = False


def init_fcm(config):
    global _fcm_ready
    if _fcm_ready:
        return True

    try:
        import firebase_admin
        from firebase_admin import credentials

        cred = None
        # Cloud runner: the whole service-account JSON in an env var.
        sa_json = os.environ.get("FIREBASE_SERVICE_ACCOUNT")
        if sa_json:
            try:
                cred = credentials.Certificate(json.loads(sa_json))
            except Exception as e:
                print(f"  [warn] FIREBASE_SERVICE_ACCOUNT is not valid JSON: {e}")

        # Local: a service-account file on disk.
        if cred is None:
            sa_file = config.get("firebase", {}).get("service_account_file", "serviceAccountKey.json")
            if not os.path.isabs(sa_file):
                sa_file = os.path.join(BASE, sa_file)
            if not os.path.exists(sa_file):
                return False
            cred = credentials.Certificate(sa_file)

        if not firebase_admin._apps:
            firebase_admin.initialize_app(cred)
        _fcm_ready = True
        return True
    except Exception as e:
        print(f"  [warn] Could not initialise Firebase (FCM): {e}")
        return False


def send_push(config, tokens, title, body):
    """Send a push to every token. Returns number delivered."""
    if not init_fcm(config):
        print(f"  [would notify] {title} — {body}")
        return 0
    if not tokens:
        print("  [warn] No device tokens yet — open the app and tap 'Enable notifications'.")
        print(f"  [would notify] {title} — {body}")
        return 0

    from firebase_admin import messaging

    message = messaging.MulticastMessage(
        notification=messaging.Notification(title=title, body=body),
        tokens=tokens,
        webpush=messaging.WebpushConfig(
            notification=messaging.WebpushNotification(
                title=title, body=body, icon="icon-192.png"
            )
        ),
    )
    try:
        resp = messaging.send_each_for_multicast(message)
        if resp.failure_count:
            for idx, r in enumerate(resp.responses):
                if not r.success:
                    print(f"  [warn] token #{idx} failed: {r.exception}")
        return resp.success_count
    except Exception as e:
        print(f"  [error] FCM send failed: {e}")
        return 0


# --------------------------------------------------------------------------- #
# Core check
# --------------------------------------------------------------------------- #
def check_once(config, state, alert=True):
    default_threshold = float(config.get("default_drop_threshold_pct", 3.0))
    watchlist, sb = get_watchlist(config)
    tokens = get_tokens(config, sb) if alert else []
    today = today_str()

    src = "Supabase" if sb else "config.json"
    print(f"[{dt.datetime.now():%Y-%m-%d %H:%M:%S}] Checking {len(watchlist)} instrument(s) "
          f"(from {src})...")

    for item in watchlist:
        symbol = item["symbol"]
        threshold = float(item.get("threshold_pct") or default_threshold)
        label = item.get("name") or symbol

        quote = get_quote(symbol)
        if quote is None:
            print(f"  {label:<24} : could not fetch price")
            continue

        last, prev, currency = quote
        change = pct_change(last, prev)
        cur = f" {currency}" if currency else ""
        arrow = "v" if change < 0 else "^"
        print(f"  {label:<24} : {last:.2f}{cur}  {arrow} {change:+.2f}%  (thr -{threshold:.1f}%)")

        if sb and item.get("id"):
            write_price(sb, item["id"], last, change, currency)

        if not alert:
            continue

        if change <= -threshold:
            # one alert per symbol per day; state lives in Supabase (survives
            # ephemeral cloud runs) or state.json for local-only runs.
            use_sb = bool(sb and item.get("id"))
            already = (item.get("last_alert_date") == today) if use_sb \
                else (state.get(symbol, {}).get("last_alert_date") == today)
            if already:
                continue

            title = f"{label} down {abs(change):.1f}%"
            body = f"{label} is at {last:.2f}{cur} ({change:+.2f}% vs previous close)."
            delivered = send_push(config, tokens, title, body)
            print(f"    -> ALERT sent to {delivered} device(s)")

            if use_sb:
                mark_alerted(sb, item["id"], today, change)
            else:
                state[symbol] = {"last_alert_date": today, "last_pct": round(change, 2)}
                save_state(state)


# --------------------------------------------------------------------------- #
# Test push
# --------------------------------------------------------------------------- #
def send_test(config):
    url, key = sb_config(config)
    sb = (url, key) if url else None
    tokens = get_tokens(config, sb)
    print(f"Registered devices: {len(tokens)}")
    if not tokens:
        print("No devices yet — open the app and tap 'Enable notifications' first.")
    delivered = send_push(
        config, tokens,
        "Test alert ✅",
        "Your stock drop alerts are working! You'll get pushes like this on a drop.",
    )
    print(f"Delivered to {delivered} device(s).")


# --------------------------------------------------------------------------- #
# Entry point
# --------------------------------------------------------------------------- #
def main():
    parser = argparse.ArgumentParser(description="Stock / mutual-fund drop alerter")
    parser.add_argument("--once", action="store_true", help="run a single check and exit")
    parser.add_argument("--list", action="store_true", help="print quotes only, no alerts")
    parser.add_argument("--test", action="store_true", help="send a test push to all devices and exit")
    args = parser.parse_args()

    config = load_config()
    state = load_state()

    if args.test:
        send_test(config)
        return
    if args.list:
        check_once(config, state, alert=False)
        return
    if args.once:
        check_once(config, state, alert=True)
        return

    interval = int(config.get("check_interval_minutes", 15)) * 60
    print(f"Starting monitor. Checking every {interval // 60} min. Ctrl+C to stop.")
    while True:
        try:
            check_once(config, state, alert=True)
        except Exception as e:
            print(f"  [error] check failed: {e}")
        time.sleep(interval)


if __name__ == "__main__":
    main()
