-- BLUPRNT — MLB live pipeline schema (run in Supabase SQL editor)

-- Current slate of games
create table if not exists mlb_games (
  id         text primary key,           -- canonical id, e.g. mlb-2026-06-18-TEX-HOU
  commence   timestamptz not null,
  away_team  text not null,
  home_team  text not null,
  status     text default 'scheduled',
  updated_at timestamptz default now()
);

-- Optional: raw per-venue quotes (kept for history / debugging; one row per venue per game)
create table if not exists mlb_quotes (
  game_id    text references mlb_games(id) on delete cascade,
  venue      text not null,
  venue_type text not null check (venue_type in ('exchange','book')),
  away_price numeric not null,
  home_price numeric not null,
  updated_at timestamptz default now(),
  primary key (game_id, venue)
);

-- Computed board snapshot — THIS is what the app reads to render THE BOARD.
create table if not exists mlb_board (
  game_id    text primary key references mlb_games(id) on delete cascade,
  away_team  text,
  home_team  text,
  commence   timestamptz,
  fair_away  numeric,
  fair_home  numeric,
  best_away  jsonb,    -- { key, price, cost }
  best_home  jsonb,    -- { key, price, cost }
  ev_away    numeric,
  ev_home    numeric,
  suspect    text[],   -- venue keys excluded from consensus
  read       text,     -- 'lock' | 'suspect' | 'edge' | 'efficient'
  roi        numeric,  -- present only when read = 'lock'
  updated_at timestamptz default now()
);

-- The board + games are non-sensitive, so allow public (anon) reads.
-- Writes happen only from the poller using the service_role key (which bypasses RLS).
alter table mlb_games enable row level security;
alter table mlb_board enable row level security;
create policy "public read games" on mlb_games for select using (true);
create policy "public read board" on mlb_board for select using (true);
