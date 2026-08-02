import { API_BASE_URLS } from '../config';
import { getJson, getText } from '../lib/http';

/**
 * SEC EDGAR Form 13F-HR — institutional holdings for the superinvestor screens.
 *
 * Free, official and keyless. Three hops per filing:
 *   1. data.sec.gov/submissions/CIK##########.json  → list of 13F-HR filings
 *   2. Archives/edgar/data/{cik}/{accession}/index.json → find the info table
 *   3. that XML                                     → the holdings themselves
 *
 * The two SEC hosts do NOT behave alike on CORS: `data.sec.gov` sends
 * `access-control-allow-origin: *`, but `www.sec.gov` — which serves steps 2 and
 * 3, the filing documents themselves — sends no CORS headers at all. All of it
 * goes through the dev proxy on web; see services/webProxy.ts.
 *
 * WHAT 13F IS NOT — this drives how the UI must label the data:
 *   • Quarterly, due 45 days after quarter end, so it is 45–135 days STALE.
 *   • Long US-listed equities, ADRs and some options ONLY. No shorts, no cash,
 *     no bonds, no foreign-listed shares. Berkshire's cash pile is invisible.
 * Present it as "holdings as of <periodOfReport>", never "current portfolio".
 */

/**
 * SEC asks automated clients to identify themselves; browsers send their own.
 *
 * The contact string is threaded in as a parameter rather than imported,
 * because it lives in a Worker secret now — see `secUserAgent` in config.ts.
 */
const secHeaders = (userAgent: string) => ({ 'User-Agent': userAgent });

/** A 13F filing's identity, before its holdings are fetched. */
export interface Filing {
  /** Dashed accession number, e.g. "0001193125-26-226661". */
  accession: string;
  /** Quarter the holdings are as of, "YYYY-MM-DD". */
  periodOfReport: string;
  /** Date the filing hit EDGAR, "YYYY-MM-DD". */
  filingDate: string;
  /** "13F-HR" or "13F-HR/A" (an amendment). */
  form: string;
}

/** One `<infoTable>` row, exactly as filed. Multiple rows may share a CUSIP. */
export interface RawHolding {
  issuer: string;
  cusip: string;
  titleOfClass: string;
  /** Market value in US dollars (see `valueScale` for the pre-2023 caveat). */
  value: number;
  /** Share count, or principal amount when `sharesType` is "PRN". */
  shares: number;
  sharesType: string;
  /** Set only for option positions. */
  putCall?: string;
}

/** A position after same-CUSIP rows have been combined. */
export interface Holding {
  cusip: string;
  issuer: string;
  value: number;
  shares: number;
  /** Share of the reported portfolio, 0-100. */
  weightPct: number;
  /** Present for option positions; common stock leaves it undefined. */
  putCall?: string;
  /** Resolved lazily via OpenFIGI; undefined when unmappable. */
  ticker?: string;
}

/** A single quarter's reported portfolio. */
export interface Portfolio {
  cik: string;
  periodOfReport: string;
  filingDate: string;
  /** Sum of all reported position values, in USD. */
  totalValue: number;
  /** Descending by value. */
  holdings: Holding[];
  /** Rows before CUSIP aggregation — kept for the "N rows → M positions" note. */
  rowCount: number;
}

export type ChangeKind = 'new' | 'exit' | 'add' | 'trim' | 'hold';

/** One position's quarter-over-quarter move. */
export interface HoldingChange {
  cusip: string;
  issuer: string;
  kind: ChangeKind;
  sharesBefore: number;
  sharesAfter: number;
  /** Percent change in share count; undefined for new positions (divide by 0). */
  sharesDeltaPct?: number;
  /** Current value in USD (0 for exits). */
  value: number;
  weightPct: number;
  putCall?: string;
}

/** Everything the investor detail screen needs. */
export interface InvestorHoldings {
  current: Portfolio;
  previous?: Portfolio;
  changes: HoldingChange[];
}

// ---------------------------------------------------------------------------
// Pure parsing / aggregation
// ---------------------------------------------------------------------------

/** Zero-pad a CIK to the 10 digits the submissions endpoint expects. */
export function padCik(cik: string): string {
  return cik.replace(/\D/g, '').padStart(10, '0');
}

/** Accession number without dashes — the Archives directory name. */
export function accessionPath(accession: string): string {
  return accession.replace(/-/g, '');
}

/**
 * Reported values are in whole DOLLARS for periods from Q4 2022 onward, and in
 * THOUSANDS before that — the SEC changed the requirement with the 2022 Form 13F
 * amendments. Most third-party parsing code still assumes thousands and is
 * therefore off by 1000x on current filings.
 */
export function valueScale(periodOfReport: string): number {
  return periodOfReport >= '2022-12-31' ? 1 : 1000;
}

interface SubmissionsJson {
  name?: string;
  filings?: {
    recent?: {
      accessionNumber?: string[];
      filingDate?: string[];
      reportDate?: string[];
      form?: string[];
    };
  };
}

/**
 * Pull 13F-HR filings out of a submissions document, newest first.
 *
 * Amendments (13F-HR/A) are included: a restated quarter should win over the
 * original, and because EDGAR lists newest first, deduping by period keeps it.
 */
export function parseFilings(json: unknown): Filing[] {
  const recent = (json as SubmissionsJson)?.filings?.recent;
  if (!recent?.form) return [];

  const { form, accessionNumber = [], filingDate = [], reportDate = [] } = recent;
  const out: Filing[] = [];
  for (let i = 0; i < form.length; i++) {
    if (!form[i]?.startsWith('13F-HR')) continue;
    const period = reportDate[i];
    const accession = accessionNumber[i];
    if (!period || !accession) continue;
    out.push({
      accession,
      periodOfReport: period,
      filingDate: filingDate[i] ?? '',
      form: form[i],
    });
  }

  out.sort((a, b) => b.periodOfReport.localeCompare(a.periodOfReport));
  // Keep one filing per quarter — the first seen, which is the amendment when
  // one exists (EDGAR orders newest-filed first within a period).
  const seen = new Set<string>();
  return out.filter((f) => {
    if (seen.has(f.periodOfReport)) return false;
    seen.add(f.periodOfReport);
    return true;
  });
}

/** Match a tag with or without a namespace prefix — filers use both. */
function tagValue(block: string, tag: string): string | undefined {
  const re = new RegExp(`<(?:[\\w.-]+:)?${tag}\\b[^>]*>([\\s\\S]*?)</(?:[\\w.-]+:)?${tag}>`, 'i');
  return re.exec(block)?.[1]?.trim();
}

function decodeEntities(s: string): string {
  return s
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&');
}

function toNumber(s: string | undefined): number {
  const n = Number((s ?? '').replace(/[,\s$]/g, ''));
  return Number.isFinite(n) ? n : 0;
}

/**
 * Parse an information table XML into raw rows.
 *
 * Hand-rolled rather than DOM-based: React Native has no DOMParser, and these
 * documents are flat, machine-generated and small. Namespace prefixes vary by
 * filing agent, hence the optional-prefix matching in `tagValue`.
 */
export function parseInformationTable(xml: string, periodOfReport = ''): RawHolding[] {
  const scale = valueScale(periodOfReport);
  const blocks = xml.match(/<(?:[\w.-]+:)?infoTable\b[^>]*>[\s\S]*?<\/(?:[\w.-]+:)?infoTable>/gi);
  if (!blocks) return [];

  const out: RawHolding[] = [];
  for (const block of blocks) {
    const cusip = tagValue(block, 'cusip')?.toUpperCase();
    if (!cusip) continue;
    out.push({
      issuer: decodeEntities(tagValue(block, 'nameOfIssuer') ?? ''),
      cusip,
      titleOfClass: decodeEntities(tagValue(block, 'titleOfClass') ?? ''),
      value: toNumber(tagValue(block, 'value')) * scale,
      shares: toNumber(tagValue(block, 'sshPrnamt')),
      sharesType: tagValue(block, 'sshPrnamtType') ?? 'SH',
      putCall: tagValue(block, 'putCall') || undefined,
    });
  }
  return out;
}

/**
 * Combine rows into positions.
 *
 * Filers split one holding across several rows — one per `otherManager` with
 * discretion over it. Berkshire's Q1 2026 filing is 90 rows for 29 positions;
 * summing naively without this step triples several holdings.
 *
 * Options are keyed separately from common stock: a put on a name you also own
 * outright is a different position, not more of the same one.
 */
export function aggregateHoldings(rows: RawHolding[]): {
  holdings: Holding[];
  totalValue: number;
} {
  const byKey = new Map<string, Holding>();
  for (const r of rows) {
    const key = `${r.cusip}|${r.putCall ?? ''}`;
    const existing = byKey.get(key);
    if (existing) {
      existing.value += r.value;
      existing.shares += r.shares;
    } else {
      byKey.set(key, {
        cusip: r.cusip,
        issuer: r.issuer,
        value: r.value,
        shares: r.shares,
        weightPct: 0,
        putCall: r.putCall,
      });
    }
  }

  const holdings = [...byKey.values()].sort((a, b) => b.value - a.value);
  const totalValue = holdings.reduce((sum, h) => sum + h.value, 0);
  if (totalValue > 0) {
    for (const h of holdings) h.weightPct = (h.value / totalValue) * 100;
  }
  return { holdings, totalValue };
}

/** Threshold below which a share-count change is noise (rounding, splits). */
const MATERIAL_DELTA_PCT = 0.5;

/**
 * Classify every position across two quarters: new buys, exits, adds and trims.
 * Exits carry the previous quarter's share count with `sharesAfter` 0, so they
 * can be listed alongside the rest.
 */
export function diffPortfolios(current: Portfolio, previous?: Portfolio): HoldingChange[] {
  if (!previous) return [];

  const key = (h: Holding) => `${h.cusip}|${h.putCall ?? ''}`;
  const before = new Map(previous.holdings.map((h) => [key(h), h]));
  const changes: HoldingChange[] = [];

  for (const h of current.holdings) {
    const prior = before.get(key(h));
    const sharesBefore = prior?.shares ?? 0;
    let kind: ChangeKind;
    let deltaPct: number | undefined;

    if (!prior) {
      kind = 'new';
    } else {
      deltaPct = sharesBefore === 0 ? undefined : ((h.shares - sharesBefore) / sharesBefore) * 100;
      if (deltaPct == null || Math.abs(deltaPct) < MATERIAL_DELTA_PCT) kind = 'hold';
      else kind = deltaPct > 0 ? 'add' : 'trim';
    }

    changes.push({
      cusip: h.cusip,
      issuer: h.issuer,
      kind,
      sharesBefore,
      sharesAfter: h.shares,
      sharesDeltaPct: deltaPct,
      value: h.value,
      weightPct: h.weightPct,
      putCall: h.putCall,
    });
  }

  const nowHeld = new Set(current.holdings.map(key));
  for (const h of previous.holdings) {
    if (nowHeld.has(key(h))) continue;
    changes.push({
      cusip: h.cusip,
      issuer: h.issuer,
      kind: 'exit',
      sharesBefore: h.shares,
      sharesAfter: 0,
      sharesDeltaPct: -100,
      value: 0,
      weightPct: 0,
      putCall: h.putCall,
    });
  }

  // Most consequential first: new buys and exits, then the largest adds/trims.
  const rank: Record<ChangeKind, number> = { new: 0, exit: 1, add: 2, trim: 3, hold: 4 };
  return changes.sort(
    (a, b) =>
      rank[a.kind] - rank[b.kind] ||
      b.value - a.value ||
      Math.abs(b.sharesDeltaPct ?? 0) - Math.abs(a.sharesDeltaPct ?? 0),
  );
}

// ---------------------------------------------------------------------------
// Network
// ---------------------------------------------------------------------------

/** All 13F filings a manager has on file, newest quarter first. */
export async function fetchFilings(cik: string, userAgent: string): Promise<Filing[]> {
  const url = `${API_BASE_URLS.secData}/submissions/CIK${padCik(cik)}.json`;
  return parseFilings(await getJson<unknown>(url, { headers: secHeaders(userAgent) }));
}

interface DirectoryJson {
  directory?: { item?: Array<{ name?: string }> };
}

/**
 * Locate the information table inside a filing directory.
 *
 * There is no reliable metadata for this: the file is named arbitrarily
 * ("53405.xml" in Berkshire's case) and `index.json` reports every entry's type
 * as "text.gif". So: take the XML that is neither the cover page nor an
 * XSL-rendered copy of it.
 */
export function pickInformationTable(json: unknown): string | undefined {
  const items = (json as DirectoryJson)?.directory?.item ?? [];
  return items
    .map((i) => i.name ?? '')
    .find(
      (name) =>
        name.toLowerCase().endsWith('.xml') &&
        !name.toLowerCase().includes('primary_doc') &&
        !name.toLowerCase().includes('xsl'),
    );
}

/** Fetch and parse one filing into a portfolio. */
export async function fetchPortfolio(
  cik: string,
  filing: Filing,
  userAgent: string,
): Promise<Portfolio> {
  const dir = `${API_BASE_URLS.secArchives}/edgar/data/${padCik(cik).replace(/^0+/, '')}/${accessionPath(filing.accession)}`;
  const index = await getJson<unknown>(`${dir}/index.json`, {
    headers: secHeaders(userAgent),
  });
  const file = pickInformationTable(index);
  if (!file) {
    throw new Error(`No information table in filing ${filing.accession}`);
  }

  const xml = await getText(`${dir}/${file}`, { headers: secHeaders(userAgent) });
  const rows = parseInformationTable(xml, filing.periodOfReport);
  const { holdings, totalValue } = aggregateHoldings(rows);

  return {
    cik,
    periodOfReport: filing.periodOfReport,
    filingDate: filing.filingDate,
    totalValue,
    holdings,
    rowCount: rows.length,
  };
}

/**
 * The latest quarter plus the one before it, with the diff between them.
 *
 * The previous quarter is best-effort: a manager's first-ever filing has none,
 * and one failing fetch shouldn't cost us the current holdings.
 */
export async function fetchInvestorHoldings(
  cik: string,
  userAgent: string,
): Promise<InvestorHoldings> {
  const filings = await fetchFilings(cik, userAgent);
  if (filings.length === 0) {
    throw new Error(`No 13F filings found for CIK ${cik}`);
  }

  const current = await fetchPortfolio(cik, filings[0], userAgent);
  let previous: Portfolio | undefined;
  if (filings[1]) {
    try {
      previous = await fetchPortfolio(cik, filings[1], userAgent);
    } catch {
      previous = undefined;
    }
  }

  return { current, previous, changes: diffPortfolios(current, previous) };
}
