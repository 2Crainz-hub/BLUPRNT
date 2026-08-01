// engine.ts — BLUPRNT devig + cross-venue arbitrage engine for MLB moneylines.
// Ported from the validated prototype logic. Pure functions, no I/O — feed-agnostic.

export type VenueType = 'exchange' | 'book';

export interface VenueQuote {
  key: string;        // 'kalshi' | 'polymarket' | 'draftkings' | 'fanduel' | 'pinnacle' ...
  type: VenueType;    // exchange = price in cents (0–100); book = American odds
  awayPrice: number;  // exchange: cents (e.g. 52);  book: American (e.g. -120, +110)
  homePrice: number;
}

export interface Game {
  id: string;         // canonical id, e.g. 'mlb-2026-06-18-TEX-HOU'
  commence: string;   // ISO timestamp
  away: string;
  home: string;
  venues: VenueQuote[];
}

const amToDecimal = (a: number) => (a > 0 ? 1 + a / 100 : 1 + 100 / Math.abs(a));

// Dollars staked to return $1 on a side at a venue.
export function cost(v: VenueQuote, side: 'away' | 'home'): number {
  const p = side === 'away' ? v.awayPrice : v.homePrice;
  return v.type === 'exchange' ? p / 100 : 1 / amToDecimal(p);
}

const SUSPECT_THRESHOLD = 0.08; // a venue's fair prob this far from consensus = flagged

export interface Analysis {
  fairAway: number;
  fairHome: number;
  suspect: string[];  // venue keys excluded from consensus
}

// Devig each two-sided venue, take the MEDIAN consensus, flag outliers as suspect.
export function analyze(g: Game): Analysis {
  const rows = g.venues.map(v => {
    const ca = cost(v, 'away'), ch = cost(v, 'home'), t = ca + ch;
    return { key: v.key, awFair: ca / t }; // vig-free implied prob for away
  });
  const sorted = rows.map(r => r.awFair).sort((a, b) => a - b);
  const med = sorted[Math.floor(sorted.length / 2)];
  const suspect = rows.filter(r => Math.abs(r.awFair - med) > SUSPECT_THRESHOLD).map(r => r.key);
  const clean = rows.filter(r => !suspect.includes(r.key));
  const fairAway = clean.reduce((s, r) => s + r.awFair, 0) / Math.max(clean.length, 1);
  return { fairAway, fairHome: 1 - fairAway, suspect };
}

export interface Best { key: string; price: number; cost: number; }

// Cheapest price for a side, EXCLUDING suspect venues.
export function best(g: Game, side: 'away' | 'home', suspect: string[]): Best {
  let b: Best | null = null;
  for (const v of g.venues) {
    if (suspect.includes(v.key)) continue;
    const c = cost(v, side);
    const price = side === 'away' ? v.awayPrice : v.homePrice;
    if (!b || c < b.cost) b = { key: v.key, price, cost: c };
  }
  return b as Best;
}

export interface Arb { game: Game; away: Best; home: Best; stakeSum: number; roi: number; }

// Risk-free arbs: best away cost + best home cost < $1 (suspect venues excluded).
export function findArbs(games: Game[]): Arb[] {
  return games.map(g => {
    const a = analyze(g);
    const away = best(g, 'away', a.suspect);
    const home = best(g, 'home', a.suspect);
    const stakeSum = away.cost + home.cost;
    return { game: g, away, home, stakeSum, roi: (1 - stakeSum) / stakeSum };
  }).filter(x => x.stakeSum < 1).sort((x, y) => y.roi - x.roi);
}

export interface BoardRow {
  id: string; away: string; home: string; commence: string;
  fairAway: number; fairHome: number;
  bestAway: Best; bestHome: Best;
  evAway: number; evHome: number;
  suspect: string[];
  read: 'lock' | 'suspect' | 'edge' | 'efficient';
  roi: number | null;
}

// One computed row per game — this is what the app renders.
export function computeBoard(g: Game): BoardRow {
  const a = analyze(g);
  const bestAway = best(g, 'away', a.suspect);
  const bestHome = best(g, 'home', a.suspect);
  const stakeSum = bestAway.cost + bestHome.cost;
  const arb = stakeSum < 1;
  const evAway = (a.fairAway / bestAway.cost - 1) * 100;
  const evHome = (a.fairHome / bestHome.cost - 1) * 100;
  let read: BoardRow['read'];
  if (arb) read = 'lock';
  else if (a.suspect.length) read = 'suspect';
  else if (Math.max(evAway, evHome) > 1.2) read = 'edge';
  else read = 'efficient';
  return {
    id: g.id, away: g.away, home: g.home, commence: g.commence,
    fairAway: a.fairAway, fairHome: a.fairHome, bestAway, bestHome,
    evAway, evHome, suspect: a.suspect, read, roi: arb ? (1 - stakeSum) / stakeSum : null,
  };
}

// Split a budget across an arb's two legs for guaranteed profit.
export function stakeSplit(arb: Arb, budget: number) {
  return {
    awayStake: budget * arb.away.cost / arb.stakeSum,
    homeStake: budget * arb.home.cost / arb.stakeSum,
    profit: budget * (1 / arb.stakeSum - 1),
  };
}
