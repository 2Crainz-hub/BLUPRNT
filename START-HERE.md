# BLUPRNT — deploy-ready project

This folder IS your Vercel project. Nothing to rearrange.

    index.html        ->  your home page        (/)
    app.html          ->  the app               (/app)
    api/poll-mlb.ts   ->  the MLB poller        (/api/poll-mlb)
    lib/engine.ts     ->  devig / arb engine
    package.json      ->  installs the Supabase client
    vercel.json       ->  routing + the poll cron
    schema.sql        ->  already run in Supabase (kept for reference)
    SETUP.md          ->  full runbook

## The only 4 things you set in Vercel (Project → Settings → Environment Variables)

    ODDSPAPI_KEY          = your rotated OddsPapi key
    SUPABASE_URL          = https://qedwppnqudszajljyujd.supabase.co
    SUPABASE_SERVICE_KEY  = your Supabase service_role key
    ODDSPAPI_BOOKMAKERS   = pinnacle,draftkings,fanduel,betmgm,caesars,kalshi,polymarket

## After it deploys
Open  https://YOUR-SITE.vercel.app/api/poll-mlb  once in your browser.
It returns { ok, games, venues:[...], locks }.
Send Claude that `venues` list — that's the signal to wire the app to live data.

Heads-up: this is a Board-first MVP. Login is not real auth yet, and WAVE/TAIL/TrueLine
are still demos. See SETUP.md and ask Claude before treating it as a full launch.
