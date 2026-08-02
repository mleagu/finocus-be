# finocus-be

Cloudflare Worker API for [Finocus](../finocus). It pulls market and 13F data on a
schedule, computes everything up front, and serves the finished JSON from KV.

**No computation happens on the request path.** Every route is a single KV read.
That split is deliberate: scheduled invocations get far more CPU headroom than
request invocations, and parsing 28 managers' 13F XML per request would be both
slow and liable to hit the limit.

## Routes

| Route | What it returns |
|---|---|
| `GET /health` | Service status plus the last refresh report |
| `GET /v1/market` | S&P 500 stats, assessment, macro snapshot, price history |
| `GET /v1/investors` | The 28-manager roster |
| `GET /v1/investors/:id` | One manager's holdings + quarter-over-quarter changes |
| `GET /v1/consensus` | Cross-investor: most widely held, most bought, most sold |
| `GET /v1/calendar` | Week ahead: global economic releases + largest earnings per day |
| `GET /debug/egress` | Whether Cloudflare's IPs can reach each upstream |
| `POST /admin/refresh` | Trigger a refresh out of band (bearer `ADMIN_TOKEN`) |

`POST /admin/refresh?phase=calendar` runs one named phase immediately instead of
waiting for the cursor to come round — useful after a deploy that changes one
payload's shape. `?full=1` runs every phase, which exceeds the subrequest budget
on the deployed Worker and is for local dev only.

Every payload carries `builtAt` so the client can show data age.
Routes 503 until the first refresh has populated KV.

## Setup

```bash
npm install
npx wrangler login

# 1. Create the KV namespace and paste the printed id into wrangler.jsonc
npx wrangler kv namespace create CACHE

# 2. Set secrets (never committed)
npx wrangler secret put FRED_API_KEY
npx wrangler secret put ADMIN_TOKEN
npx wrangler secret put SEC_USER_AGENT   # "Your Project you@example.com"

# 3. Deploy
npm run deploy
```

For local work, copy `.dev.vars.example` to `.dev.vars` (gitignored) and run
`npm run dev`. Local mode simulates KV, so the placeholder namespace id is fine.

## Verify egress before trusting it

```bash
npm run dev:remote      # runs on a real edge, not your laptop
curl localhost:8787/debug/egress
```

This matters. Plain `npm run dev` fetches from **your** IP and will happily
report that everything works. Only `--remote` (or a deploy) answers the question
that actually matters: whether Cloudflare's egress IPs are accepted.

Known upstream behaviour, all observed directly:

- **Stooq** serves a JS anti-bot challenge to server-side fetches. It fails, and
  `fetchSp500History` falls through to Yahoo by design.
- **Yahoo rejects the Workers runtime's default User-Agent with a 429.** This is
  not a rate limit despite the status code: it is refused in ~60ms, and the same
  request with a browser User-Agent returns real data from the same IP. Verified
  from a deployed Worker. `YAHOO_HEADERS` in `sources/yahoo.ts` is load-bearing —
  without it the entire price pipeline is dead on Cloudflare.
- **SEC** 403s an empty User-Agent and blocks anything advertising `HeadlessChrome`.
  `SEC_USER_AGENT` is load-bearing here in a way it never was in the app, where
  browsers forbid setting the header at all. It is a **secret**, not a constant,
  because it is a personal contact address — but it must still be a real one, so
  it cannot be blanked or faked to satisfy a linter. An unset value throws with
  the fix in the message rather than letting every SEC request 403 anonymously;
  `secUserAgent()` in `config.ts` is the single place that decides this. The
  `/debug/egress` probe deliberately does NOT throw, so it can still report
  SEC's own response when the secret is missing.
- **OpenFIGI** is 25 requests/minute unauthenticated. The CUSIP->ticker map is
  cached as a single KV entry and never expires, so only genuinely new securities
  ever reach it.
- **The economic calendar 403s without `Origin` and `Referer`.** TradingView's
  calendar endpoint is the one its own widget calls; the identical URL is 403
  bare and 200 with the pair — confirmed from the Worker's own egress.
  `/debug/price-sources` probes both variants side by side so a future break is
  distinguishable from a tightened policy. Undocumented and able to change
  without notice, same class of dependency as the Yahoo chart feed.
- **The calendar no longer uses FRED.** FRED is the Fed's own database, so it is
  US-only, publishes dates but never times (release times had to be hardcoded per
  agency), and carries no forecasts. It also listed release 101 (FOMC) on EVERY
  calendar day when queried with `include_release_dates_with_no_data=true` — 61
  dates in a 61-day window — which forced a hand-transcribed FOMC table. All
  three problems went away with the switch; rate decisions now arrive as ordinary
  high-importance events. FRED still backs the macro snapshot.
- **Economic events are sent flat, not grouped into days.** Each carries a UTC
  instant, and which day that falls on depends on the reader: 23:00 UTC is
  tonight in London and tomorrow in Tokyo. Grouping server-side would bake the
  Worker's timezone into the payload. The window is over-fetched by one day
  either side so the client's local edges are complete.
- **Low importance is 70% of the feed** — bill auctions, balance-sheet lines,
  regional Fed speeches, ~28 events a day. It is dropped; high and medium leave
  ~8 a day across 18 countries.
- **Nasdaq's earnings endpoint writes negatives in accounting parentheses** —
  `($1.93)` is -1.93, and roughly a third of a typical day's rows are negative.
  `parseFloat` alone silently turns losses into profits.
- **Nasdaq takes ~2s per request.** Eight sequential days overran the `waitUntil`
  budget and the write was cancelled with no error surfaced anywhere; the days
  are fetched concurrently for that reason, not for elegance.

## How the refresh works

Cron fires every 15 minutes and advances **one step** of a round-robin cycle:

```
market -> investors[0..1] -> investors[2..3] -> ... -> consensus -> calendar -> market
```

That sharding is not premature optimisation. The free plan allows **50
subrequests per invocation** and a single-pass refresh costs ~200 — measured, not
guessed: the first deployed run completed 5 of 28 managers before every remaining
one failed with "Too many subrequests". KV reads and writes count against the
same budget as outbound fetches, which is why the CUSIP->ticker map is one entry
rather than one key per CUSIP, and why OpenFIGI calls are capped per manager
(Bridgewater alone holds 993 positions).

A full cycle is ~16 steps, so roughly 4 hours: prices refresh ~6x/day, and
investor steps outside the four filing windows a year are almost entirely cache
hits.

Each step is independent and best-effort. A FRED outage must not blank the
superinvestor data; one malformed filing must not abort the other 27. Anything
that fails leaves the **previous** payload in KV, which beats serving nothing —
the refresh only ever writes on success. A failing step still advances the
cursor, so one bad phase cannot wedge the cycle and starve the others.

Two caches make repeat runs nearly free:

- **Filings** are keyed by accession and cached with no expiry. A 13F document is
  immutable once accepted, so it is parsed exactly once, ever.
- **CUSIP → ticker** is likewise permanent, held as one entry for the whole
  universe rather than one key per CUSIP.

## Tests

```bash
npm test        # 106 tests
npm run typecheck
```

To drive a full cycle by hand against the real KV without waiting on the cron:

```bash
npm run dev:remote
for i in $(seq 1 17); do
  curl -s -X POST localhost:8788/admin/refresh \
    -H 'Authorization: Bearer <your ADMIN_TOKEN from .dev.vars>' >/dev/null
  sleep 8
done
```

The parsing and stats suites are ported from the app unchanged, including the
fixture of real Berkshire 13F XML. `consensus.test.ts` covers the logic that only
exists here.

## Data caveats worth preserving in any client

Form 13F covers long US-listed equities, ADRs and some options only — no cash,
bonds, shorts or foreign listings. Filings are due 45 days after quarter end, so
holdings are 45–135 days stale. Label them "as of `periodOfReport`", never
"current portfolio".
