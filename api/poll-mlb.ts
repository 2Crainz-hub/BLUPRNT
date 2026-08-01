// api/poll-mlb.ts — scheduled poller for BLUPRNT / THE BOARD (MLB moneylines).
import { createClient } from '@supabase/supabase-js';
import { computeBoard, findArbs, type Game, type VenueQuote } from '../lib/engine';

const BASE = 'https://api.oddspapi.io/v4';
const KEY = process.env.ODDSPAPI_KEY!;
const MLB_TOURNAMENT_ID = 109;

const BOOKMAKERS = (process.env.ODDSPAPI_BOOKMAKERS ||
  'pinnacle,draftkings,fanduel,betmgm,caesars,kalshi,polymarket')
  .split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);

const HOME_IS_PARTICIPANT1 = true;
const MIN_VENUES = 1;

const supabase = createClient(process.env.SUPABASE_URL!, process.env.SUPABASE_SERVICE_KEY!);
const qs = (o: Record<string, string | number>) =>
  Object.entries(o).map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join('&');

async function getJson(url: string): Promise<any> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${res.status} ${await res.text()}`);
  return res.json();
}

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
  if (home == null) home = american(pickPlayer(mk.outcomes['131']));
  if (away == null) away = american(pickPlayer(mk.outcomes['132']));
  if (home == null || away == null) return null;
  return { home, away, isExchange };
}

async function fetchMlbGames(): Promise<{ games: Game[]; diag: string[] }> {
  const names = await fetchTeamNames();
  const games = new Map<string, Game>();
  const diag: string[] = [];

  for (const book of BOOKMAKERS) {
    const url = `${BASE}/odds-by-tournaments?${qs({
      tournamentIds: MLB_TOURNAMENT_ID, bookmaker: book, oddsFormat: 'american', apiKey: KEY,
    })}`;
    let fixtures: any[];
    try {
      fixtures = await getJson(url);
    } catch (e: any) {
      console.warn(`[poll-mlb] skip "${book}": ${e.message}`);
      diag.push(`${book}: ERROR ${String(e.message).slice(0, 90)}`);
      continue;
    }

    let withBook = 0, mlOk = 0;
    for (const fx of fixtures) {
      if (!fx?.hasOdds || !fx.bookmakerOdds) continue;
      const bm = fx.bookmakerOdds[book];
      if (!bm || bm.suspended) continue;
      withBook++;
      const ml = readMoneyline(bm);
      if (!ml) continue;
      mlOk++;

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
      const q: VenueQuote = { key: book, type: 'book', homePrice: ml.home, awayPrice: ml.away };
      if (!g.venues.some((v) => v.key === book)) g.venues.push(q);
    }
    diag.push(`${book}: ${fixtures.length} fixtures, ${withBook} carried book, ${mlOk} moneylines`);
  }

  return { games: [...games.values()].filter((g) => g.venues.length >= MIN_VENUES), diag };
}

export default async function handler(_req: any, res: any) {
  try {
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
    res.status(200).json({ ok: true, games: games.length, venues: venuesSeen, locks, diag });
  } catch (e: any) {
    console.error('[poll-mlb]', e);
    res.status(500).json({ ok: false, error: e.message });
  }
}
