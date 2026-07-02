-- Run this once in the Supabase dashboard -> SQL Editor -> New query -> Run.
-- Creates the two tables the app uses and opens them to the public anon key.

create table if not exists watchlist (
  id              text primary key,    -- sanitized symbol, e.g. RELIANCE.NS
  symbol          text not null,
  name            text,
  threshold_pct   numeric,             -- null = use the app/monitor default
  last_price      numeric,             -- written back by monitor.py
  last_pct        numeric,
  currency        text,
  updated_at      timestamptz,
  last_alert_date text,                -- YYYY-MM-DD of the last alert (dedup)
  last_alert_pct  numeric,
  created_at      timestamptz default now()
);

-- If you created the table before these columns existed, add them:
alter table watchlist add column if not exists last_alert_date text;
alter table watchlist add column if not exists last_alert_pct  numeric;

create table if not exists devices (
  token      text primary key,         -- FCM push token from the browser
  ua         text,
  created_at timestamptz default now()
);

-- Realtime so the app updates instantly when prices/watchlist change.
alter publication supabase_realtime add table watchlist;

-- Row Level Security -----------------------------------------------------------
alter table watchlist enable row level security;
alter table devices   enable row level security;

-- Personal app: allow the anon (public) key full access to just these tables.
--   WARNING: anyone who has your app's URL could read/edit these two tables.
--   That's usually fine for a private stock watchlist. To lock it down, add
--   Supabase Auth and replace `true` with `auth.uid() is not null`.
create policy "anon all watchlist" on watchlist
  for all to anon using (true) with check (true);
create policy "anon all devices" on devices
  for all to anon using (true) with check (true);
