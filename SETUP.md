# BLUPRNT — MLB Live Data Pipeline (MVP)

**What it does:** on each run, pulls MLB moneylines from OddsPapi (one call **per book**),
merges every book per game, runs the devig + arbitrage engine, and writes a board snapshot
to Supabase. Your app reads `mlb_board` and renders THE BOARD — no mock data.

```
OddsPapi (1 call/book) -> merge per game -> engine (devig/arb) -> Supabase (mlb_board) -> app
```

> **Verified 2026-06-28** against a live Pinnacle pull: the parser reads real moneylines
> (home/away tags + American prices), joins team names from `/v4/fixtures`, and the engine
> correctly devigs, flags edges, and finds risk-free arbs. Both `.ts` files type-check clean
> under `--strict`.

---

## 1. Your part — only you can do these (~10 min)

1. **OddsPapi key.** You have it. **Rotate it** if it was ever pasted in plaintext, then keep
   the new one only in Vercel env vars (below) — never in the code.
2. **Confirm bookmaker slugs.** Hit `GET /v4/bookmakers?apiKey=YOUR_KEY` once and check the
   exact spellings for the books you want (`pinnacle`, `draftkings`, `fanduel`, `kalshi`,
   `polymarket`, …). A wrong slug isn't fatal — that book is just skipped — but right slugs =
   more venues = more edges.
3. **Supabase project.** Already created; schema already run. From **Settings → API**, copy
   your **Project URL** and **service_role** key for the env vars below.

## 2. Environment variables (Vercel → Project → Settings → Environment Variables)

| Name | Value |
|---|---|
| `ODDSPAPI_KEY` | your **rotated** OddsPapi key |
| `SUPABASE_URL` | `https://qedwppnqudszajljyujd.supabase.co` |
| `SUPABASE_SERVICE_KEY` | the **service_role** key (server only — never expose in the browser) |
| `ODDSPAPI_BOOKMAKERS` | *(optional)* comma list, e.g. `pinnacle,draftkings,fanduel,kalshi,polymarket`. Omit to use the built-in default. |

## 3. Two flags you may need to flip (top of `api/poll-mlb.ts`)

- **`HOME_IS_PARTICIPANT1 = true`** — the feed labels prices "home"/"away" but never says which
  participant is home. If THE BOARD shows a game with the teams swapped, change this to `false`.
  That's the only fix needed; everything else is internally consistent either way.
- **`MIN_VENUES = 1`** — set to `1` for the first deploy so the board shows data even if only
  one book's slug is right. Once several books are flowing, bump to `2` (locks/edges only mean
  something cross-venue).

## 4. Deploy the poller

- Put `lib/engine.ts` and `api/poll-mlb.ts` in your project. Install the client:
  `npm i @supabase/supabase-js`.
- **First run is the real test.** Hit `/api/poll-mlb` once manually and read the JSON it
  returns: `{ ok, games, venues:[...], locks }`. The `venues` array tells you exactly which
  book slugs worked — fix any missing ones in `ODDSPAPI_BOOKMAKERS`.
- **Then schedule it.** Vercel Cron on the free Hobby plan only runs **once per day**, so for a
  ~2-minute cadence pick one:
  - **Vercel Pro** cron (add the block below to `vercel.json`), or
  - **Supabase scheduled Edge Function** (pg_cron) — same logic, no Vercel Pro, or
  - an **external trigger** (e.g. cron-job.org) hitting `/api/poll-mlb` every 2 min.

  ```json
  { "crons": [{ "path": "/api/poll-mlb", "schedule": "*/2 * * * *" }] }
  ```

## 5. Cost (now per-book)

Requests = **games × books × polls**. MLB-only moneyline, ~15 games, every 2 min during game
windows, with e.g. 5 books ≈ **low-hundreds of requests per poll → roughly a few hundred $/mo
at the high end**; far less if you (a) poll only during game windows and (b) keep the book list
tight. Start with 2–3 books (pinnacle + one sharp exchange + one retail) and widen once it pays.

## Next, once data is flowing

Point the app at `mlb_board` (a single Supabase read, using the **anon/public** key — not
service_role) so THE BOARD shows live numbers instead of the mock slate. That's the step where
the app moves onto your real React/Supabase stack.
