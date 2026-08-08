// api/poll-mlb.ts — on-demand poller for BLUPRNT / THE BOARD (MLB moneylines).
//
// Called by the app the moment someone opens it (not a fixed-interval cron). It checks
// how old the data already sitting in Supabase is: if it's fresher than STALE_MS, it
// skips OddsPapi entirely and returns instantly (cost: 0 calls). If it's stale, it does
// one real refresh — 2 OddsPapi calls total (team names, then ALL bookmakers in a single
// combined odds call) — writes to Supabase, and returns. `?force=1` bypasses the
// freshness check (handy for manual testing).
//
// OddsPapi's /v4/odds-by-tournaments accepts a comma-separated `bookmakers` list and
// returns every requested book in one response — so all 7 books come back in ONE call,
// not one call per book. Verified against a live Pinnacle pull (2026-06-28):
//   - the moneyline market's bookmakerMarketId ends in "/moneyline"
//   - its two outcomes are tagged bookmakerOutcomeId "home" / "away"
//   - prices come back as priceAmerican (string) when oddsFormat=american
//   - exchange venues (kalshi/polymarket) carry a non-null exchangeMeta
//
// The odds feed gives only participant IDs, so team NAMES come from /v4/fixtures (one
// call, no bookmaker needed) joined by participant id.

import { createClient } from '@supabase/supabase-js';
import { computeBoard, findArbs, type Game, type VenueQuote } from '../lib/engine';

const BASE = 'https://api.oddspapi.io/v4';
const KEY = process.env.ODDSPAPI_KEY!;            // OddsPapi auth is a ?apiKey= query param
const MLB_TOURNAMENT_ID = 109;

// All 7 books pulled in a single combined call. Override via env (comma list) without
// redeploying code. NOTE: these are best-guess slugs — confirm exact spellings via GET /v4/bookmakers.
// A wrong slug just means that book is silently absent from the response, not a crash.
const BOOKMAKERS = (process.env.ODDSPAPI_BOOKMAKERS ||
  'pinnacle,draftkings,fanduel,betmgm,caesars,kalshi,polymarket')
  .split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);

// On-demand freshness window: skip the OddsPapi round-trip entirely if the newest quote
// already in Supabase is younger than this. Tunable via env; 5 min is the default.
const STALE_MS = Number(process.env.ODDSPAPI_STALE_MINUTES || 5) * 60 * 1000;

// The feed labels prices "home"/"away" but never says which participant is home.
// If the board ever shows teams reversed, flip this single flag.
const HOME_IS_PARTICIPANT1 = true;

// Write a row as long as >=1 venue parsed (so the board isn't empty if only one slug is
// right on the first deploy). Bump to 2 once you've confirmed several books flow, since
// locks/edges only mean anything cross-venue.
const MIN_VENUES = 1;

// Only keep games starting within this many hours (today + tomorrow), so the board is a
// real daily slate instead of the six-week dump OddsPapi returns. Tunable via env.
const WINDOW_HOURS = Number(process.env.MLB_WINDOW_HOURS || 48);

const supabase = createClient(process.env.SUPABASE_URL!, process.env.SUPABASE_SERVICE_KEY!);
const qs = (o: Record<string, string | number>) =>
  Object.entries(o).map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join('&');

// Kept for the (now rare) 429 retry — a single combined call rarely needs pacing, but a
// courteous backoff costs nothing.
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export const config = { maxDuration: 30 };

async function getJson(url: string, retries = 2): Promise<any> {
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(url);
    if (res.status === 429 && attempt < retries) {
      await sleep(2500 * (attempt + 1));   // 2.5s, then 5s
      continue;
    }
    if (!res.ok) throw new Error(`${res.status} ${await res.text()}`);
    return res.json();
  }
}

// ── 1. participant id -> team name (from /v4/fixtures; the odds feed has IDs only) ──
async function fetchTeamNames(): Promise<Map<number, string>> {
  const url = `${BASE}/fixtures?${qs({ tournamentId: MLB_TOURNAMENT_ID, apiKey: KEY })}`;
  const arr: any[] = await getJson(url);
  const names = new Map<number, string>();
  for (const fx of arr) {
    if (fx.participant1Id != null)
      names.set(fx.participant1Id, fx.participant1Name || fx.participant1Abbr || `#${fx.participant1Id}`);
    if (fx.participant2Id != null)
      names.set(fx.participant2Id, fx.participant2Name || fx.participant2Abbr || `#${fx.participant2Id}`);
  }
  return names;
}

// ── 2. Pull one outcome pair from a bookmaker's moneyline market ──
function american(player: any): number | null {
  const n = player ? Number(player.priceAmerican) : NaN;
  return Number.isFinite(n) ? n : null;
}
function pickPlayer(outcome: any): any | null {
  const players = Object.values<any>(outcome?.players || {});
  return players.find((p) => p.mainLine && p.active) || players.find((p) => p.active) || players[0] || null;
}

function readMoneyline(bm: any): { home: number; away: number; isExchange: boolean } | null {
  const markets = bm?.markets || {};
  // Canonical baseball moneyline is market "131"; fall back to any market whose
  // bookmakerMarketId path ends in /moneyline (covers books keyed differently).
  let mk: any = markets['131'];
  if (!mk || mk.marketActive === false) {
    mk = Object.values<any>(markets).find(
      (m) => m?.marketActive !== false &&
        typeof m?.bookmakerMarketId === 'string' && /\/moneyline$/i.test(m.bookmakerMarketId),
    );
  }
  if (!mk || !mk.outcomes) return null;

  let home: number | null = null, away: number | null = null, isExchange = false;
  for (const oc of Object.values<any>(mk.outcomes)) {
    const pl = pickPlayer(oc);
    if (!pl) continue;
    const price = american(pl);
    if (price == null) continue;
    if (pl.exchangeMeta) isExchange = true;
    const side = String(pl.bookmakerOutcomeId || '').toLowerCase();
    if (side === 'home') home = price;
    else if (side === 'away') away = price;
  }
  // Fallback for feeds that don't tag home/away: outcome key 131=home, 132=away.
  if (home == null) home = american(pickPlayer(mk.outcomes['131']));
  if (away == null) away = american(pickPlayer(mk.outcomes['132']));
  if (home == null || away == null) return null;
  return { home, away, isExchange };
}

// ── 3. One combined call for all books, then split per venue locally ──
async function fetchMlbGames(): Promise<{ games: Game[]; diag: string[] }> {
  const names = await fetchTeamNames();
  const games = new Map<string, Game>();
  const diag: string[] = [];   // TEMP: per-book status so we can see why a book is silent

  const url = `${BASE}/odds-by-tournaments?${qs({
    tournamentIds: MLB_TOURNAMENT_ID, bookmakers: BOOKMAKERS.join(','),
    oddsFormat: 'american', apiKey: KEY,
  })}`;
  let fixtures: any[] = [];
  try {
    fixtures = await getJson(url);
  } catch (e: any) {
    console.warn(`[poll-mlb] combined odds call failed: ${e.message}`);
    diag.push(`odds-by-tournaments: ERROR ${String(e.message).slice(0, 120)}`);
  }

  const perBook: Record<string, { withBook: number; mlOk: number }> = {};
  for (const book of BOOKMAKERS) perBook[book] = { withBook: 0, mlOk: 0 };

  for (const fx of fixtures) {
    if (!fx?.hasOdds || !fx.bookmakerOdds) continue;
    for (const book of BOOKMAKERS) {
      const bm = fx.bookmakerOdds[book];
      if (!bm || bm.suspended) continue;
      perBook[book].withBook++;
      const ml = readMoneyline(bm);
      if (!ml) continue;
      perBook[book].mlOk++;

      let g = games.get(fx.fixtureId);
      if (!g) {
        const p1 = names.get(fx.participant1Id) || `#${fx.participant1Id}`;
        const p2 = names.get(fx.participant2Id) || `#${fx.participant2Id}`;
        g = {
          id: fx.fixtureId,
          commence: fx.startTime,
          home: HOME_IS_PARTICIPANT1 ? p1 : p2,
          away: HOME_IS_PARTICIPANT1 ? p2 : p1,
          venues: [],
        };
        games.set(fx.fixtureId, g);
      }
      // All prices normalized to American, so the engine treats every venue as a 'book'.
      // (isExchange is retained for display badges but doesn't change the cost math here.)
      const q: VenueQuote = { key: book, type: 'book', homePrice: ml.home, awayPrice: ml.away };
      if (!g.venues.some((v) => v.key === book)) g.venues.push(q);
    }
  }
  for (const book of BOOKMAKERS) {
    diag.push(`${book}: ${fixtures.length} fixtures, ${perBook[book].withBook} carried book, ${perBook[book].mlOk} moneylines`);
  }

  const lo = Date.now() - 60 * 60 * 1000;                 // 1h ago (keep just-started games)
  const hi = Date.now() + WINDOW_HOURS * 60 * 60 * 1000;  // WINDOW_HOURS ahead
  const kept = [...games.values()].filter((g) => {
    if (g.venues.length < MIN_VENUES) return false;
    const t = Date.parse(g.commence);
    return Number.isFinite(t) && t >= lo && t <= hi;
  });
  diag.push(`window: kept ${kept.length} of ${games.size} games within ${WINDOW_HOURS}h`);
  return { games: kept, diag };
}

// ── 3b. On-demand freshness check — is Supabase's data young enough to skip OddsPapi? ──
async function newestQuoteAgeMs(): Promise<number | null> {
  const { data, error } = await supabase
    .from('mlb_quotes').select('updated_at').order('updated_at', { ascending: false }).limit(1);
  if (error || !data || !data.length) return null;   // no rows yet -> treat as stale
  return Date.now() - new Date(data[0].updated_at).getTime();
}

// ── 4. Compute board + write to Supabase ──
export default async function handler(req: any, res: any) {
  try {
    const force = req?.query?.force === '1' || req?.query?.force === 'true';
    if (!force) {
      const ageMs = await newestQuoteAgeMs();
      if (ageMs !== null && ageMs < STALE_MS) {
        console.log(`[poll-mlb] skipped — data is ${Math.round(ageMs / 1000)}s old (< ${STALE_MS / 1000}s)`);
        res.status(200).json({ ok: true, skipped: true, ageSeconds: Math.round(ageMs / 1000) });
        return;
      }
    }

    const { games, diag } = await fetchMlbGames();
    const board = games.map(computeBoard);
    const now = new Date().toISOString();

    await supabase.from('mlb_games').upsert(games.map((g) => ({
      id: g.id, commence: g.commence, away_team: g.away, home_team: g.home, updated_at: now,
    })));

    const quotes = games.flatMap((g) => g.venues.map((v) => ({
      game_id: g.id, venue: v.key, venue_type: v.type,
      away_price: v.awayPrice, home_price: v.homePrice, updated_at: now,
    })));
    if (quotes.length) await supabase.from('mlb_quotes').upsert(quotes);

    await supabase.from('mlb_board').upsert(board.map((r) => ({
      game_id: r.id, away_team: r.away, home_team: r.home, commence: r.commence,
      fair_away: r.fairAway, fair_home: r.fairHome, best_away: r.bestAway, best_home: r.bestHome,
      ev_away: r.evAway, ev_home: r.evHome, suspect: r.suspect, read: r.read, roi: r.roi,
      updated_at: now,
    })));

    const locks = findArbs(games).length;
    const venuesSeen = [...new Set(games.flatMap((g) => g.venues.map((v) => v.key)))];
    console.log(`[poll-mlb] games=${games.length} venues=${venuesSeen.join(',')} locks=${locks}`);
    res.status(200).json({ ok: true, skipped: false, games: games.length, venues: venuesSeen, locks, diag });
  } catch (e: any) {
    console.error('[poll-mlb]', e);
    res.status(500).json({ ok: false, error: e.message });
  }
}
