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

`POST /admin/refresh?phase=price` (or `market`, `investors`, `consensus`, `calendar`) runs one named phase immediately instead of
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

## Charts must not be stride-sampled

`downsample` buckets by min/max. It previously kept every Nth bar, which was
wrong in a way that reached the screen: at MAX the stride was 17, so **94% of
bars were discarded and any spike shorter than 17 sessions vanished**. Because
`allTimeHigh` and `fiftyTwoWeek` compute over the FULL series, the dashboard
could quote an all-time high that appeared nowhere on the all-time chart.

The stride also depended on the sliced length, so each window sampled a
different subset — the same calendar day appeared in 3Y but not 5Y, and the line
visibly changed shape when switching windows. That was reported as "prices are
inconsistent"; the prices were right, the sampling was not.

Measured on the live payload after the fix: the 1Y chart's minimum is now
exactly `performance.fiftyTwoWeek.low`, and MAX reaches 676.53 — the March 2009
low, which the stride sampler had been dropping.

## How the refresh works

Cron fires every 10 minutes and runs **one step** of a round-robin cycle:

```
market -> investors[0..1] -> investors[2..3] -> ... -> consensus -> calendar -> market
```

Which step is **derived from wall time**, not read from KV. `cursorAt()` is the
tick number modulo the cycle length, so each invocation works out its own
position with no state to load, save or drift. A delayed cron skips a slot
rather than replaying one, and every phase is idempotent, so nothing is lost.

That sharding is not premature optimisation. The free plan allows **50
subrequests per invocation** and a single-pass refresh costs ~200 — measured, not
guessed: the first deployed run completed 5 of 28 managers before every remaining
one failed with "Too many subrequests". KV reads and writes count against the
same budget as outbound fetches, which is why the CUSIP->ticker map is one entry
rather than one key per CUSIP, and why OpenFIGI calls are capped per manager
(Bridgewater alone holds 993 positions).

### The market refresh is split in two

`market` and `price` fetch the same prices; only `market` fetches macro.

A full `market` step costs ~14 subrequests, and **11 of them are FRED series
that cannot change within a trading day** — CPI is monthly, GDP quarterly,
Treasury yields daily. Paying for those every ten minutes to learn one new
price is the waste the split removes.

- **`price`** runs on **every tick while the US extended session is open**
  (04:00–20:00 ET, weekdays), reusing the stored `macro` verbatim. ~3
  operations. Worst-case staleness during market hours is therefore one cron
  interval.
- **`market`** keeps its rotation slot and refetches everything including FRED.

Everything price-derived is **recomputed**, not patched — the 52-week band,
drawdown, technicals and the assessment all move with price, and updating
`price` alone would leave the dashboard internally inconsistent.

`price` writes nothing when the price is unchanged, which is also why
`marketHours` models no holiday calendar: on a closed day it sees the same last
close and does nothing. A hand-maintained holiday list would be one more thing
to get wrong every year for no benefit.

Off-session ticks run the rotation. The overnight window is 8 hours = 48 ticks,
comfortably more than the 17-slot cycle, so every phase is reached at least
twice a night and weekends run it continuously.

Each step is independent and best-effort. A FRED outage must not blank the
superinvestor data; one malformed filing must not abort the other 27. Anything
that fails leaves the **previous** payload in KV, which beats serving nothing —
the refresh only ever writes on success. Nothing can wedge the cycle, because
the next step is whatever the clock says rather than something a failed run had
to record.

Two caches make repeat runs nearly free:

- **Filings** are keyed by accession and cached with no expiry. A 13F document is
  immutable once accepted, so it is parsed exactly once, ever.
- **CUSIP → ticker** is likewise permanent, held as one entry for the whole
  universe rather than one key per CUSIP.

### Writes are scarcer than reads

The free plan meters **1,000 KV writes a day against 100,000 reads**, a 100:1
ratio, and at a 15-minute cron anything written once per tick costs a fifth of
the daily write budget on its own. The first deployed version burned ~517
writes/day and tripped Cloudflare's 50% warning within a day. Where they went:

| | writes/day | |
|---|---|---|
| Cursor + refresh log, every tick | 222 | pure bookkeeping |
| Investor payloads, rewritten unchanged | 184 | 13Fs land 4x a year |
| Cold-start filings and ticker map | ~86 | one-off |
| Payloads that genuinely changed | ~25 | the actual work |

Three rules came out of that, and each is commented where it applies:

- **Never write to record that nothing happened.** The cursor is derived from
  the clock, and the refresh log is written only when a step changed something
  or failed — not as a heartbeat.
- **Spend a read to avoid a write.** `refreshInvestor` reads the stored
  accession first and returns early when the newest filing is the one already
  cached, which also skips the portfolio fetches and the OpenFIGI pass.
- **Batch related state into one key.** Already why the CUSIP→ticker map is a
  single entry.

Steady state is now ~40 writes/day off-session. Adding the 10-minute in-session
`price` refresh takes a trading day to **~115 writes**, still 12% of the budget:
96 price ticks, of which only the ones where the price actually moved write.

## Tests

```bash
npm test        # 170 tests
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
