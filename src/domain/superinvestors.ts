/**
 * Curated roster of managers whose 13F filings are worth following.
 *
 * Every CIK here was resolved from EDGAR's company search and then verified by
 * fetching its submissions feed — a name lookup alone is not enough, because
 * several famous firms have multiple CIKs where the obvious one is a dormant
 * shell. Baupost, Viking, Icahn, ValueAct and Polen all resolve first to
 * entities that stopped filing between 2002 and 2011. Every entry below was
 * confirmed to have filed a 13F for 2026-03-31 (Scion excepted, see its note).
 *
 * `manager` is a label for who the firm is known for, not a claim about who
 * currently picks the stocks — several of these founders have handed over
 * day-to-day management.
 */
export interface Superinvestor {
  /** Stable slug used for navigation params. */
  id: string;
  /** SEC Central Index Key. */
  cik: string;
  /** Firm name, roughly as EDGAR has it. */
  firm: string;
  /** The investor the firm is associated with. */
  manager: string;
  /** One line on the approach, for the list screen. */
  style: string;
  /** Set when the manager has stopped filing; surfaced in the UI. */
  note?: string;
}

export const SUPERINVESTORS: Superinvestor[] = [
  {
    id: 'berkshire',
    cik: '1067983',
    firm: 'Berkshire Hathaway',
    manager: 'Warren Buffett',
    style: 'Concentrated quality compounders held for decades',
  },
  {
    id: 'baupost',
    cik: '1061768',
    firm: 'Baupost Group',
    manager: 'Seth Klarman',
    style: 'Deep value and distressed, often heavy in cash',
  },
  {
    id: 'pershing-square',
    cik: '1336528',
    firm: 'Pershing Square',
    manager: 'Bill Ackman',
    style: 'Very concentrated activist positions',
  },
  {
    id: 'himalaya',
    cik: '1709323',
    firm: 'Himalaya Capital',
    manager: 'Li Lu',
    style: "Buffett-style concentration, Munger's chosen manager",
  },
  {
    id: 'appaloosa',
    cik: '1656456',
    firm: 'Appaloosa',
    manager: 'David Tepper',
    style: 'Opportunistic macro and distressed equity',
  },
  {
    id: 'duquesne',
    cik: '1536411',
    firm: 'Duquesne Family Office',
    manager: 'Stanley Druckenmiller',
    style: 'Top-down macro expressed through equities',
  },
  {
    id: 'third-point',
    cik: '1040273',
    firm: 'Third Point',
    manager: 'Daniel Loeb',
    style: 'Event-driven and activist',
  },
  {
    id: 'abrams',
    cik: '1358706',
    firm: 'Abrams Capital',
    manager: 'David Abrams',
    style: 'Concentrated value, very low turnover',
  },
  {
    id: 'akre',
    cik: '1112520',
    firm: 'Akre Capital',
    manager: 'Chuck Akre',
    style: 'High-return compounders, buy and hold',
  },
  {
    id: 'valueact',
    cik: '1418814',
    firm: 'ValueAct Holdings',
    manager: 'Mason Morfit',
    style: 'Constructive activism from board seats',
  },
  {
    id: 'tiger-global',
    cik: '1167483',
    firm: 'Tiger Global',
    manager: 'Chase Coleman',
    style: 'Growth and technology, public and private',
  },
  {
    id: 'lone-pine',
    cik: '1061165',
    firm: 'Lone Pine Capital',
    manager: 'Stephen Mandel',
    style: 'Long/short growth equity, a Tiger cub',
  },
  {
    id: 'viking-global',
    cik: '1103804',
    firm: 'Viking Global',
    manager: 'Andreas Halvorsen',
    style: 'Fundamental long/short, a Tiger cub',
  },
  {
    id: 'bridgewater',
    cik: '1350694',
    firm: 'Bridgewater Associates',
    manager: 'Ray Dalio',
    style: 'Systematic macro; 13F is mostly index ETFs',
  },
  {
    id: 'markel',
    cik: '1096343',
    firm: 'Markel Group',
    manager: 'Tom Gayner',
    style: 'Insurance float invested like a mini-Berkshire',
  },
  {
    id: 'southeastern',
    cik: '807985',
    firm: 'Southeastern Asset Management',
    manager: 'Mason Hawkins',
    style: 'Concentrated value at a discount to appraisal',
  },
  {
    id: 'harris-associates',
    cik: '813917',
    firm: 'Harris Associates (Oakmark)',
    manager: 'Bill Nygren',
    style: 'Classic US large-cap value',
  },
  {
    id: 'first-eagle',
    cik: '1325447',
    firm: 'First Eagle Investment Management',
    manager: 'Matthew McLennan',
    style: 'Global value with a gold hedge',
  },
  {
    id: 'tweedy-browne',
    cik: '732905',
    firm: 'Tweedy, Browne',
    manager: 'Tweedy, Browne Company',
    style: "Graham-lineage value; Buffett's old brokers",
  },
  {
    id: 'polen',
    cik: '1034524',
    firm: 'Polen Capital Management',
    manager: 'Dan Davidowitz',
    style: 'Concentrated high-quality growth',
  },
  {
    id: 'gardner-russo',
    cik: '860643',
    firm: 'Gardner Russo & Quinn',
    manager: 'Tom Russo',
    style: 'Global consumer brands, "capacity to suffer"',
  },
  {
    id: 'dalal-street',
    cik: '1549575',
    firm: 'Dalal Street',
    manager: 'Mohnish Pabrai',
    style: 'Cloned value bets, extreme concentration',
  },
  {
    id: 'giverny',
    cik: '1641864',
    firm: 'Giverny Capital',
    manager: 'François Rochon',
    style: 'Quality growth held for the long term',
  },
  {
    id: 'altarock',
    cik: '1631014',
    firm: 'AltaRock Partners',
    manager: 'Mark Massey',
    style: 'Extremely concentrated, near-zero turnover',
  },
  {
    id: 'triple-frond',
    cik: '1454502',
    firm: 'Triple Frond Partners',
    manager: 'Kaushik Vardharajan',
    style: 'Small, concentrated long-only book',
  },
  {
    id: 'wedgewood',
    cik: '859804',
    firm: 'Wedgewood Partners',
    manager: 'David Rolfe',
    style: 'Focused growth, roughly 20 holdings',
  },
  {
    id: 'chou',
    cik: '1389403',
    firm: 'Chou Associates Management',
    manager: 'Francis Chou',
    style: 'Contrarian deep value',
  },
  {
    id: 'scion',
    cik: '1649339',
    firm: 'Scion Asset Management',
    manager: 'Michael Burry',
    style: 'Contrarian, high-turnover, frequent options',
    note: 'Deregistered in late 2025 — last filing is Q3 2025.',
  },
];

export function findSuperinvestor(id: string): Superinvestor | undefined {
  return SUPERINVESTORS.find((s) => s.id === id);
}
