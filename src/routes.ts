import { SUPERINVESTORS } from './domain/superinvestors';
import type { Env } from './env';
import { KEYS, readCache, type Cached } from './lib/kv';
import { API_BASE_URLS } from './config';
import { privacyPolicyResponse } from './privacy';
import { PHASES, refreshAll, refreshStep, type Phase } from './refresh';
import { TRADINGVIEW_HEADERS } from './sources/economicCalendar';

/**
 * Read-only API. Every handler is a KV lookup — no upstream calls, no parsing,
 * no computation. If a route ever needs to fetch something, that work belongs
 * in the cron job instead.
 */

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type,Authorization',
};

/**
 * Browsers may cache briefly; the CDN holds longer. Data only changes when the
 * cron runs, so a stale minute at the edge costs nothing and absorbs bursts.
 */
const CACHE_CONTROL = 'public, max-age=60, s-maxage=900';

function json(body: unknown, status = 200, extra: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', ...CORS, ...extra },
  });
}

/** Serve a cached payload, or 503 when the cron hasn't populated it yet. */
function serve<T>(hit: Cached<T> | null, what: string): Response {
  if (!hit) {
    return json(
      { error: `${what} not built yet`, hint: 'POST /admin/refresh or wait for the cron' },
      503,
    );
  }
  return json({ ...hit.data, builtAt: hit.builtAt }, 200, { 'Cache-Control': CACHE_CONTROL });
}

export async function handleRequest(request: Request, env: Env, ctx: ExecutionContext) {
  const url = new URL(request.url);
  const path = url.pathname.replace(/\/+$/, '') || '/';

  if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });

  // --- public pages ---
  // HTML, not JSON, and deliberately above the API routes: Google Play requires
  // a policy URL that a reviewer can open in a browser without credentials.
  if (path === '/privacy') return privacyPolicyResponse();

  // --- meta ---
  if (path === '/' || path === '/health') {
    const log = await readCache<unknown>(env, KEYS.refreshLog);
    return json({
      service: 'finocus-be',
      ok: true,
      lastRefresh: log?.data ?? null,
      routes: [
        'GET /privacy',
        'GET /v1/market',
        'GET /v1/investors',
        'GET /v1/investors/:id',
        'GET /v1/consensus',
        'GET /v1/calendar',
        'GET /debug/egress',
        'POST /admin/refresh',
      ],
    });
  }

  // --- data ---
  if (path === '/v1/market') {
    return serve(await readCache(env, KEYS.market), 'market');
  }

  if (path === '/v1/investors') {
    // The roster is static, so this needs no cron and never 503s. Filing dates
    // are merged in from each cached payload so the list can show data age.
    const index = await readCache<Record<string, { periodOfReport: string; filingDate: string }>>(
      env,
      KEYS.investorIndex,
    );
    return json(
      {
        investors: SUPERINVESTORS.map((s) => ({ ...s, latest: index?.data?.[s.id] ?? null })),
        builtAt: index?.builtAt ?? null,
      },
      200,
      { 'Cache-Control': CACHE_CONTROL },
    );
  }

  const investorMatch = /^\/v1\/investors\/([A-Za-z0-9-]+)$/.exec(path);
  if (investorMatch) {
    const id = investorMatch[1];
    if (!SUPERINVESTORS.some((s) => s.id === id)) {
      return json({ error: `unknown investor "${id}"` }, 404);
    }
    return serve(await readCache(env, KEYS.investor(id)), `investor ${id}`);
  }

  if (path === '/v1/consensus') {
    return serve(await readCache(env, KEYS.consensus), 'consensus');
  }

  if (path === '/v1/calendar') {
    return serve(await readCache(env, KEYS.calendar), 'calendar');
  }

  // --- diagnostics ---
  if (path === '/debug/egress') return await egressCheck(env);
  if (path === '/debug/price-sources') return await priceSourceCheck(env);

  // --- admin ---
  if (path === '/admin/refresh' && request.method === 'POST') {
    if (env.ADMIN_TOKEN) {
      const auth = request.headers.get('Authorization');
      if (auth !== `Bearer ${env.ADMIN_TOKEN}`) return json({ error: 'unauthorized' }, 401);
    }
    // ?full=1 runs every phase in one go. That blows the free plan's
    // subrequest budget, so it is for local dev and backfills only; on the
    // deployed Worker the default (one step) is the correct choice.
    //
    // ?phase=<name> runs that phase now instead of waiting up to a full cycle
    // for it to come round — needed after a deploy that changes one payload's
    // shape. Passed straight into refreshStep so there is still exactly one
    // code path that knows how to run a step.
    const full = url.searchParams.get('full') === '1';
    const requested = url.searchParams.get('phase') as Phase | null;
    const phase = requested && PHASES.includes(requested) ? requested : null;

    ctx.waitUntil(
      (full ? refreshAll(env) : refreshStep(env, Date.now(), phase ?? undefined)).then(
        () => undefined,
      ),
    );
    return json(
      {
        started: true,
        mode: full ? 'full' : (phase ?? 'step'),
        note: 'running in background; poll /health',
      },
      202,
    );
  }

  return json({ error: 'not found', path }, 404);
}

/**
 * Does Cloudflare's egress actually reach these hosts?
 *
 * This exists because the answer is genuinely uncertain and cheap to get wrong:
 * Stooq already serves an anti-bot challenge to server-side fetches, and Yahoo
 * is known to treat datacenter IPs differently from residential ones. Run this
 * against a REAL edge (`wrangler dev --remote` or a deploy) — local `wrangler
 * dev` fetches from your laptop's IP and will happily tell you everything works.
 */
async function egressCheck(env: Env): Promise<Response> {
  const targets: Array<[string, string, RequestInit?]> = [
    ['yahoo', `${API_BASE_URLS.yahoo}/v8/finance/chart/%5EGSPC?range=5d&interval=1d`],
    ['stooq', `${API_BASE_URLS.stooq}/q/d/l/?s=%5Espx&i=d`],
    ['sec', `${API_BASE_URLS.secData}/submissions/CIK0001067983.json`, {
      // Deliberately not `secUserAgent(env)`, which throws: an unset secret
      // should show up here as SEC's own 403 rather than take out the probe
      // that exists to diagnose it.
      headers: { 'User-Agent': env.SEC_USER_AGENT?.trim() || '(SEC_USER_AGENT unset)' },
    }],
    ['openfigi', `${API_BASE_URLS.openFigi}/mapping`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify([{ idType: 'ID_CUSIP', idValue: '037833100' }]),
    }],
  ];

  const results = await Promise.all(
    targets.map(async ([name, url, init]) => {
      const t0 = Date.now();
      try {
        const res = await fetch(url, init);
        const body = await res.text();
        return {
          name,
          status: res.status,
          ms: Date.now() - t0,
          bytes: body.length,
          // A 200 that's actually a bot challenge is the failure mode to catch,
          // so a sample of the body matters more than the status code.
          sample: body.slice(0, 120).replace(/\s+/g, ' '),
        };
      } catch (e) {
        return { name, status: 0, ms: Date.now() - t0, error: String(e) };
      }
    }),
  );

  return json({ note: 'run via --remote or a deploy; local dev uses your own IP', results });
}

/**
 * Which price sources actually work from Cloudflare's egress?
 *
 * Yahoo blocks it outright (429 in ~60ms — a blanket datacenter-IP reject, not a
 * throttle that recovers), and Stooq answers with a JS challenge. This probe
 * exists to find a replacement empirically instead of guessing, and to prove any
 * candidate returns real numbers rather than a plausible-looking error page.
 */
async function priceSourceCheck(env: Env): Promise<Response> {
  const BROWSER_UA =
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36';

  const candidates: Array<[string, string, RequestInit?]> = [
    ['yahoo-query2', 'https://query2.finance.yahoo.com/v8/finance/chart/%5EGSPC?range=1mo&interval=1d'],
    ['yahoo-browser-ua', 'https://query1.finance.yahoo.com/v8/finance/chart/%5EGSPC?range=1mo&interval=1d', {
      headers: { 'User-Agent': BROWSER_UA, Accept: 'application/json' },
    }],
    ['stooq-browser-ua', 'https://stooq.com/q/d/l/?s=%5Espx&i=d', {
      headers: { 'User-Agent': BROWSER_UA, Referer: 'https://stooq.com/' },
    }],
    ['stooq-pl', 'https://stooq.pl/q/d/l/?s=%5Espx&i=d', { headers: { 'User-Agent': BROWSER_UA } }],
    ['fred-sp500', `https://api.stlouisfed.org/fred/series/observations?series_id=SP500&api_key=${env.FRED_API_KEY}&file_type=json&sort_order=desc&limit=5`],
    ['alphavantage-demo', 'https://www.alphavantage.co/query?function=TIME_SERIES_DAILY&symbol=SPY&outputsize=compact&apikey=demo'],
    ['nasdaq-earnings', 'https://api.nasdaq.com/api/calendar/earnings?date=2026-08-05', {
      headers: { 'User-Agent': BROWSER_UA, Accept: 'application/json' },
    }],
    ['nasdaq-earnings-noua', 'https://api.nasdaq.com/api/calendar/earnings?date=2026-08-05'],
    // Both variants on purpose: the calendar 403s without Origin/Referer, so
    // seeing the pair side by side says whether the endpoint is down or has
    // merely tightened what it accepts.
    ['tradingview-calendar', `${API_BASE_URLS.tradingViewCalendar}/events?from=2026-08-02T00:00:00.000Z&to=2026-08-04T00:00:00.000Z&countries=US`, {
      headers: TRADINGVIEW_HEADERS,
    }],
    ['tradingview-calendar-noorigin', `${API_BASE_URLS.tradingViewCalendar}/events?from=2026-08-02T00:00:00.000Z&to=2026-08-04T00:00:00.000Z&countries=US`],
  ];

  const results = await Promise.all(
    candidates.map(async ([name, url, init]) => {
      const t0 = Date.now();
      try {
        const res = await fetch(url, init);
        const body = await res.text();
        return {
          name,
          status: res.status,
          ms: Date.now() - t0,
          bytes: body.length,
          // Status 200 proves nothing here — Stooq's bot wall is a 200.
          sample: body.slice(0, 150).replace(/\s+/g, ' '),
        };
      } catch (e) {
        return { name, status: 0, ms: Date.now() - t0, error: String(e).slice(0, 160) };
      }
    }),
  );

  return json({ results });
}
