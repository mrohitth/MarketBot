/**
 * Market Discovery Engine — Tag-Along Logic + Volume/Momentum Screen + Warm Bench
 *
 * THREE capabilities:
 *   1. TAG-ALONG:  Parse Finnhub headlines for known tickers (e.g., NVDA) paired
 *                  with unknown tickers (e.g., NOK). Fetch technical data on strangers.
 *   2. UNUSUAL VOLUME SCREEN: Scan broad-market tickers for abnormal volume + momentum.
 *   3. WARM BENCH: Persisted queue at data/discovery-queue.json — review + promote.
 *
 * Integration: called from opportunity_scanner.ts as a parallel phase.
 */

import * as fs from "fs";
import * as path from "path";
import https from "https";
import { MarketData, WATCHLIST_TICKERS, PORTFOLIO_TICKERS } from "./types";

// Lazy-loaded yahoo-finance2 instance (only created when needed)
let _yf: any = null;
async function getYahooFinance() {
  if (!_yf) {
    const mod = await import("yahoo-finance2");
    const YF = (mod as any).default ?? mod;
    _yf = new YF({ suppressNotices: ["yahooSurvey"] });
  }
  return _yf;
}

// ═══════════════════════════════════════════════════════════════════════════════
// CONFIGURATION
// ═══════════════════════════════════════════════════════════════════════════════

const DISCOVERY_QUEUE_FILE = "./data/discovery-queue.json";
const VOLUME_GATE_FILE = "./data/discovery-volume-gate.txt";  // Contains last volume screen timestamp
const FINNHUB_TOKEN = process.env.FINNHUB_API_KEY || "d7udjm1r01qnv95n7mi0d7udjm1r01qnv95n7mig";
const FINNHUB_NEWS_URL = `https://finnhub.io/api/v1/news?category=general&token=${FINNHUB_TOKEN}`;

/** Tickers the system already tracks — don't "discover" these */
const KNOWN_TICKERS = new Set([
  ...PORTFOLIO_TICKERS,
  ...WATCHLIST_TICKERS,
  "SPY", "DXY", "TLT", "GLD", "SLV",  // macro
]);

/** Broad-market tickers for unusual volume screen (one per sector + liquid caps) */
const BROAD_SCREEN_TICKERS = [
  // Sector ETFs
  "XLK", "XLC", "XLY", "XLI", "XLV", "XLF", "XLE", "XLB", "XLU", "XLRE", "XLP",
  // Liquid large-caps per sector (companies not in WATCHLIST)
  "AAPL", "MSFT", "GOOGL", "META", "AMZN", "TSLA",
  // Telecom / 5G
  "NOK", "ERIC", "VZ", "T", "TMUS",
  // Biotech (outside AMGN)
  "GILD", "REGN", "VRTX", "BIIB",
  // Defense (outside LMT/RTX)
  "NOC", "LHX",
  // Energy refinement (outside CVX/XOM)
  "MPC", "PSX", "COP", "EOG",
  // Consumer discretionary
  "HD", "LOW", "MCD", "NKE", "SBUX", "DIS",
  // Fintech
  "SQ", "COIN", "PYPL", "F",
  // REITs
  "PLD", "AMT", "EQIX",
  // Infrastructure
  "DE", "GE", "HON", "MMM", "EMR", "CARR",
  // Utilities
  "NEE", "DUK", "SO", "AEP",
  // Materials
  "FCX", "NEM", "LIN", "SHW", "ECL",
  // Transport / logistics
  "UPS", "FDX", "UNP", "CSX",
  // Software (semi-adjacent)
  "CRM", "ORCL", "ADBE", "NOW", "IBM",
] as const;

/** Maximum age of a discovery before it auto-expires (days) */
const DISCOVERY_MAX_AGE_DAYS = 30;

/** Volume spike multiplier threshold */
const VOLUME_SPIKE_THRESHOLD = 2.0;

/** Minimum price to consider for discovery */
const MIN_PRICE = 5;

// ═══════════════════════════════════════════════════════════════════════════════
// TYPES
// ═══════════════════════════════════════════════════════════════════════════════

export type DiscoverySource = "tag-along" | "volume-surge" | "momentum-runner";

export interface DiscoveryEntry {
  ticker: string;
  discoveredAt: string;       // ISO timestamp
  source: DiscoverySource;
  catalyst?: string;          // e.g., "Partnered with NVDA"
  price: number;
  rsi: number;
  ma50: number;
  ma200: number;
  volume: number;
  volumeAvg: number;
  pctOf52wHi: number;        // 0-100
  vs50dPct: number;          // % above/below MA50
  signal: "BUY" | "SELL" | "HOLD";  // computed decision signal
  status: "new" | "reviewed" | "promoted" | "dismissed";
  notes?: string;
  headlinePreview?: string;   // what triggered it
}

export interface DiscoveryQueue {
  entries: DiscoveryEntry[];
  lastUpdated: string;
}

export interface DiscoveryResult {
  tagAlong: DiscoveryEntry[];
  volumeSurges: DiscoveryEntry[];
  momentumRunners: DiscoveryEntry[];
}

// ═══════════════════════════════════════════════════════════════════════════════
// NEWS FETCHING
// ═══════════════════════════════════════════════════════════════════════════════

/** Finnhub news item shape */
interface FinnhubItem {
  category: string;
  datetime: number;
  headline: string;
  id: number;
  related: string;
  summary: string;
  source: string;
  url: string;
}

/** Yahoo Finance news item shape */
interface YahooNewsItem {
  title: string;
  summary?: string;
  link?: string;
  publisher?: string;
  providerPublishTime?: number;
}

/**
 * Fetch news from Finnhub + Yahoo Finance, merge, deduplicate.
 * Finnhub provides structured headlines (wider coverage), Yahoo provides
 * finance-specific news. Together they catch more tag-along opportunities.
 */
async function fetchNews(): Promise<{ headline: string; summary: string; datetime: number }[]> {
  const seen = new Set<string>();
  const results: { headline: string; summary: string; datetime: number }[] = [];

  // ── Source 1: Finnhub ───────────────────────────────────────────────
  try {
    const data = await new Promise<string>((resolve, reject) => {
      const req = https.get(FINNHUB_NEWS_URL, (res) => {
        let d = "";
        res.on("data", (c: string) => d += c);
        res.on("end", () => resolve(d));
      });
      req.on("error", reject);
      req.setTimeout(8000, () => { req.destroy(); resolve(""); });
    });
    if (data) {
      const parsed = JSON.parse(data);
      if (Array.isArray(parsed)) {
        for (const item of parsed as FinnhubItem[]) {
          const headline = item.headline?.trim() ?? "";
          if (!headline || seen.has(headline)) continue;
          seen.add(headline);
          results.push({
            headline,
            summary: (item.summary ?? "").trim(),
            datetime: item.datetime ?? Math.floor(Date.now() / 1000),
          });
          if (results.length >= 30) break;
        }
        console.log(`[DISCOVERY] Finnhub: ${parsed.length} headlines, ${results.length} kept`);
      }
    }
  } catch (err) {
    console.warn(`[DISCOVERY] Finnhub fetch failed: ${(err as Error).message}`);
  }

  // ── Source 2: Yahoo Finance (complementary, no API key) ─────────────
  if (results.length < 30) {
    try {
      const yf = await getYahooFinance();
      const queries = ["stock market", "markets today", "tech stocks"];
      for (const query of queries) {
        if (results.length >= 30) break;
        const res = await yf.search(query, { newsCount: 10 });
        const newsItems: YahooNewsItem[] = (res as any).news ?? [];
        for (const item of newsItems) {
          if (results.length >= 30) break;
          const headline = item.title?.trim() ?? "";
          if (!headline || seen.has(headline)) continue;
          seen.add(headline);
          results.push({
            headline,
            summary: item.summary?.trim() ?? "",
            datetime: item.providerPublishTime ?? Math.floor(Date.now() / 1000),
          });
        }
      }
      console.log(`[DISCOVERY] Yahoo: ${results.length} total headlines (across all queries)`);
    } catch (err) {
      console.warn(`[DISCOVERY] Yahoo Finance news fetch failed: ${(err as Error).message}`);
    }
  }

  console.log(`[DISCOVERY] Total: ${results.length} unique headlines (Finnhub + Yahoo)`);
  return results;
}

// ═══════════════════════════════════════════════════════════════════════════════
// TICKER EXTRACTION FROM TEXT
// ═══════════════════════════════════════════════════════════════════════════════

/** Common English words that look like tickers but aren't */
const FALSE_TICKERS = new Set([
  "THE", "FOR", "AND", "WITH", "FROM", "THAT", "THIS", "ARE", "WAS", "WERE",
  "HAS", "HAVE", "BEEN", "MORE", "MOST", "SOME", "WHAT", "WHEN", "WHERE",
  "WHICH", "WHO", "HOW", "ALL", "ANY", "EACH", "ITS", "YOUR", "THEY", "THEM",
  "THAN", "THEN", "NOW", "NEW", "OLD", "BIG", "GET", "SET", "TOP", "LOW",
  "HIGH", "BEST", "GOOD", "MUCH", "JUST", "ALSO", "INTO", "OVER", "SUCH",
  "VERY", "WILL", "CAN", "MAY", "HAD", "BUT", "NOT", "ONE", "TWO", "FIRST",
  "LAST", "NEXT", "WEEK", "YEAR", "MONTH", "DAY", "TIME", "BACK", "ONLY",
  "FULL", "SALE", "DEAL", "CASH", "FREE", "WORK", "PART", "LONG", "SAFE",
  "HARD", "SOFT", "UP", "DOWN", "OPEN", "CLOSE", "CELL", "NET", "GROWTH",
  "STOCK", "MARKET", "BOND", "RATE", "DEBT", "LOSS", "GAIN", "RISK",
  "BANK", "FUND", "CALL", "PUT", "BUY", "SELL", "HOLD", "DIV", "EPS",
  "CEO", "CFO", "CTO", "COO", "IPO", "SPAC", "AI", "IT", "GO", "NO", "ON",
  "AT", "TO", "BE", "BY", "OR", "DO", "SO", "IF", "AS", "UP", "OK", "US",
]);

const KNOWN_FALSE_TICKERS = new Set([
  "APPLE", "TESLA", "GOOGLE", "AMAZON", "MICROSOFT", "META", "NVIDIA",
  "ALPHABET", "META", "INTEL", "AMD", "QUALCOMM", "BROADCOM", "MICRON",
  "APPLIED", "AUTO", "TECHNOLOGY", "ENERGY", "HEALTH", "FINANCE",
  "CAPITAL", "INDUSTRIAL", "INTERNATIONAL", "ELECTRIC", "AMERICAN",
  "SOUTHERN", "UNITED", "NEXT", "EVER", "CORE", "FIRST", "SERVICES",
  "SOLUTIONS", "GENERAL", "ELECTRONICS", "COMMUNICATIONS",
]);

function extractPotentialTickers(text: string): string[] {
  // Find all-caps tokens that are 1-5 characters
  const words = text.split(/[\s,.;:!?()"']+/);
  const candidates = words.filter(w => /^[A-Z][A-Z0-9]{0,4}$/.test(w));
  return candidates.filter(c =>
    !FALSE_TICKERS.has(c) &&
    !KNOWN_FALSE_TICKERS.has(c) &&
    !/^\d/.test(c)  // exclude pure numbers
  );
}

// ═══════════════════════════════════════════════════════════════════════════════
// TAG-ALONG LOGIC
// ═══════════════════════════════════════════════════════════════════════════════

interface TagAlongCandidate {
  ticker: string;
  catalyst: string;
  headline: string;
}

function findTagAlongs(news: { headline: string; summary: string; datetime: number }[]): TagAlongCandidate[] {
  // Pool all known ticker set
  const found: TagAlongCandidate[] = [];
  const seen = new Set<string>(); // avoid duplicate (ticker, headline) combos

  for (const item of news) {
    const combined = `${item.headline} ${item.summary}`;
    const allTickers = extractPotentialTickers(combined);

    // Check if any known ticker appears in this headline
    const knownMentions = allTickers.filter(t => KNOWN_TICKERS.has(t));
    if (knownMentions.length === 0) continue;

    // Find unknown tickers co-occurring with known ones
    const unknowns = allTickers.filter(t => !KNOWN_TICKERS.has(t));
    for (const unknown of unknowns) {
      const key = `${unknown}:${item.headline.slice(0, 60)}`;
      if (seen.has(key)) continue;
      seen.add(key);

      // Construct a readable catalyst
      const knownStr = knownMentions.join("/");
      found.push({
        ticker: unknown,
        catalyst: `Mentioned with ${knownStr}`,
        headline: item.headline,
      });
    }
  }

  return found;
}

// ═══════════════════════════════════════════════════════════════════════════════
// YAHOO FINANCE HELPERS
// ═══════════════════════════════════════════════════════════════════════════════

async function fetchDiscoveryQuote(ticker: string): Promise<{
  price: number; rsi: number; ma50: number; ma200: number;
  volume: number; volumeAvg: number; fiftyTwoWeekHigh: number; changePct: number;
} | null> {
  try {
    const yf = await getYahooFinance();
    const result = await yf.quote(ticker);

    if (!result || typeof result.regularMarketPrice !== "number") return null;

    const price = result.regularMarketPrice;
    if (price < MIN_PRICE) return null; // skip penny stocks

    // Try chart for RSI
    let rsi = 50;
    try {
      const now = new Date();
      const threeMonthsAgo = new Date(now.getTime() - 100 * 24 * 60 * 60 * 1000);
      const chart = await yf.chart(ticker, {
        period1: threeMonthsAgo.toISOString().split("T")[0],
        period2: now.toISOString().split("T")[0],
        interval: "1d",
      });
      const closes = (chart?.quotes ?? [])
        .map((q: any) => q.close)
        .filter((c: any): c is number => c !== null && !isNaN(c));
      if (closes.length >= 15) {
        rsi = computeRSI(closes);
      }
    } catch { /* non-fatal */ }

    return {
      price,
      rsi,
      ma50: result.fiftyDayAverage ?? price,
      ma200: result.twoHundredDayAverage ?? price,
      volume: result.regularMarketVolume ?? 0,
      volumeAvg: result.averageDailyVolume10Week ?? 0,
      fiftyTwoWeekHigh: result.fiftyTwoWeekHigh ?? price,
      changePct: result.regularMarketChangePercent ?? 0,
    };
  } catch {
    return null;
  }
}

function computeRSI(prices: number[], period = 14): number {
  if (prices.length < period + 1) return 50;
  let avgGain = 0, avgLoss = 0;
  for (let i = 1; i <= period; i++) {
    const d = prices[i] - prices[i - 1];
    avgGain += d > 0 ? d : 0;
    avgLoss += d < 0 ? Math.abs(d) : 0;
  }
  avgGain /= period;
  avgLoss /= period;
  for (let i = period; i < prices.length - 1; i++) {
    const gain = prices[i + 1] - prices[i];
    avgGain = (avgGain * (period - 1) + (gain > 0 ? gain : 0)) / period;
    avgLoss = (avgLoss * (period - 1) + (gain < 0 ? Math.abs(gain) : 0)) / period;
  }
  if (avgLoss === 0) return 100;
  const rs = avgGain / avgLoss;
  return Math.round((100 - 100 / (1 + rs)) * 100) / 100;
}

// ═══════════════════════════════════════════════════════════════════════════════
// VOLUME / MOMENTUM SCREEN
// ═══════════════════════════════════════════════════════════════════════════════

async function screenUnusualActivity(): Promise<{
  volumeSurges: Array<{ ticker: string; volumeRatio: number; changePct: number; price: number; rsi: number }>;
  momentumRunners: Array<{ ticker: string; changePct: number; price: number; rsi: number; vs50dPct: number; pctOf52wHi: number }>;
}> {
  const volumeSurges: Array<any> = [];
  const momentumRunners: Array<any> = [];

  // Batched fetch — limited to avoid rate limits
  const batch = BROAD_SCREEN_TICKERS.slice(0, 40);
  const results = await Promise.allSettled(batch.map(t => fetchDiscoveryQuote(t)));

  for (let i = 0; i < batch.length; i++) {
    const ticker = batch[i];
    const r = results[i];
    if (r.status !== "fulfilled" || !r.value) continue;

    const q = r.value;

    // Volume surge: current volume >= 2x average
    if (q.volumeAvg > 0 && q.volume > 0 && (q.volume / q.volumeAvg) >= VOLUME_SPIKE_THRESHOLD) {
      // Skip if it's already in our known set (WATCHLIST covers it)
      if (!KNOWN_TICKERS.has(ticker)) {
        volumeSurges.push({
          ticker,
          volumeRatio: +(q.volume / q.volumeAvg).toFixed(2),
          changePct: q.changePct,
          price: q.price,
          rsi: q.rsi,
        });
      }
    }

    // Momentum runner: price moved >4% in a day
    if (Math.abs(q.changePct) >= 4) {
      const vs50dPct = ((q.price / q.ma50) - 1) * 100;
      const pctOf52wHi = q.fiftyTwoWeekHigh ? (q.price / q.fiftyTwoWeekHigh) * 100 : 100;
      momentumRunners.push({
        ticker,
        changePct: q.changePct,
        price: q.price,
        rsi: q.rsi,
        vs50dPct: +vs50dPct.toFixed(1),
        pctOf52wHi: +pctOf52wHi.toFixed(1),
      });
    }
  }

  return { volumeSurges, momentumRunners };
}

// ═══════════════════════════════════════════════════════════════════════════════
// DISCOVERY QUEUE (WARM BENCH)
// ═══════════════════════════════════════════════════════════════════════════════

function loadQueue(): DiscoveryQueue {
  const filePath = path.resolve(DISCOVERY_QUEUE_FILE);
  if (!fs.existsSync(filePath)) {
    return { entries: [], lastUpdated: new Date().toISOString() };
  }
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch {
    return { entries: [], lastUpdated: new Date().toISOString() };
  }
}

function saveQueue(queue: DiscoveryQueue): void {
  const filePath = path.resolve(DISCOVERY_QUEUE_FILE);
  fs.writeFileSync(filePath, JSON.stringify(queue, null, 2));
  console.log(`[DISCOVERY] Queue saved: ${queue.entries.length} entries`);
}

function addToQueue(
  ticker: string,
  source: DiscoverySource,
  catalyst: string | undefined,
  headlinePreview: string | undefined,
  techData: DiscoveryEntry["price"] extends number ? any : any
): void {
  const queue = loadQueue();

  // Don't add duplicates
  const existing = queue.entries.find(e => e.ticker === ticker && e.status !== "dismissed");
  if (existing) {
    // Update timestamp and re-score but keep the original discovery
    existing.discoveredAt = new Date().toISOString();
    if (catalyst) existing.catalyst = catalyst;
    if (headlinePreview) existing.headlinePreview = headlinePreview;
    if (techData) {
      existing.price = techData.price;
      existing.rsi = techData.rsi;
      existing.volume = techData.volume;
      existing.volumeAvg = techData.volumeAvg;
      existing.pctOf52wHi = techData.fiftyTwoWeekHigh
        ? +((techData.price / techData.fiftyTwoWeekHigh) * 100).toFixed(1)
        : 100;
    }
    existing.notes = `Reconfirmed: ${new Date().toLocaleDateString()}`;
    existing.status = "new"; // bump it back to new
    saveQueue(queue);
    return;
  }

  queue.entries.push({
    ticker,
    discoveredAt: new Date().toISOString(),
    source,
    catalyst,
    price: techData?.price ?? 0,
    rsi: techData?.rsi ?? 50,
    ma50: techData?.ma50 ?? 0,
    ma200: techData?.ma200 ?? 0,
    volume: techData?.volume ?? 0,
    volumeAvg: techData?.volumeAvg ?? 0,
    pctOf52wHi: techData?.fiftyTwoWeekHigh
      ? +((techData.price / techData.fiftyTwoWeekHigh) * 100).toFixed(1)
      : 100,
    vs50dPct: techData?.ma50
      ? +(((techData.price / techData.ma50) - 1) * 100).toFixed(1)
      : 0,
    signal: computeSignal({
      ticker, source,
      price: techData?.price ?? 0,
      rsi: techData?.rsi ?? 50,
      ma50: techData?.ma50 ?? 0, ma200: techData?.ma200 ?? 0,
      volume: techData?.volume ?? 0, volumeAvg: techData?.volumeAvg ?? 0,
      pctOf52wHi: techData?.fiftyTwoWeekHigh
        ? +((techData.price / techData.fiftyTwoWeekHigh) * 100).toFixed(1) : 100,
      vs50dPct: techData?.ma50
        ? +(((techData.price / techData.ma50) - 1) * 100).toFixed(1) : 0,
      status: "new",
    } as DiscoveryEntry),
    status: "new",
    headlinePreview: headlinePreview?.slice(0, 200) ?? undefined,
  });

  // Prune old entries
  const cutoff = Date.now() - DISCOVERY_MAX_AGE_DAYS * 24 * 60 * 60 * 1000;
  queue.entries = queue.entries.filter(e =>
    e.status === "promoted" || new Date(e.discoveredAt).getTime() > cutoff
  );

  saveQueue(queue);
}

// ═══════════════════════════════════════════════════════════════════════════════
// MAIN DISCOVERY ENTRY POINT
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Run the full Market Discovery pipeline:
 * 1. Tag-Along: Parse news for known+unknown ticker co-occurrences
 * 2. Volume Screen: Check ~40 broad-market tickers for unusual activity
 *
 * The volume screen is gated to run at most once every 4 hours to respect
 * Yahoo Finance rate limits. Tag-along (news-based) runs every call.
 *
 * Adds discoveries to the queue. Returns a summary for the opportunity scanner.
 */
/** Time gate for the volume screen — max once per 4 hours */
function checkVolumeGate(): boolean {
  const FOUR_HOURS = 4 * 60 * 60 * 1000;
  const filePath = path.resolve(VOLUME_GATE_FILE);
  if (!fs.existsSync(filePath)) return true; // no gate file = never ran, allow
  try {
    const lastMs = parseInt(fs.readFileSync(filePath, "utf8").trim(), 10);
    const sinceLast = Date.now() - lastMs;
    if (sinceLast < FOUR_HOURS) {
      console.log(`[DISCOVERY] Volume screen gated — ${Math.round(sinceLast / 60000)}m ago (need 240m)`);
      return false;
    }
    return true;
  } catch {
    return true; // corrupt file, allow
  }
}

function updateVolumeGate(): void {
  fs.writeFileSync(path.resolve(VOLUME_GATE_FILE), String(Date.now()));
  console.log("[DISCOVERY] Volume gate timestamp updated");
}

export async function runDiscovery(skipVolumeScreen = false): Promise<DiscoveryResult> {
  // ── Volume screen gate: max once per 4 hours ────────────────────────
  if (!skipVolumeScreen) {
    skipVolumeScreen = !checkVolumeGate(); // gate says no → skip
  }
  const result: DiscoveryResult = {
    tagAlong: [],
    volumeSurges: [],
    momentumRunners: [],
  };

  // ── Phase 1: Tag-Along (news-based) ────────────────────────────────────
  console.log("[DISCOVERY] Fetching news for tag-along analysis...");
  const news = await fetchNews();
  if (news.length === 0) {
    console.log("[DISCOVERY] No news fetched — skipping tag-along phase");
  } else {
    const tagAlongs = findTagAlongs(news);
    console.log(`[DISCOVERY] Found ${tagAlongs.length} tag-along candidates from ${news.length} headlines`);

    // Fetch technical data for each candidate
    for (const ta of tagAlongs.slice(0, 10)) {
      const techData = await fetchDiscoveryQuote(ta.ticker);
      if (!techData) continue;

      addToQueue(ta.ticker, "tag-along", ta.catalyst, ta.headline, techData);

      result.tagAlong.push({
        ticker: ta.ticker,
        discoveredAt: new Date().toISOString(),
        source: "tag-along",
        catalyst: ta.catalyst,
        price: techData.price,
        rsi: techData.rsi,
        ma50: techData.ma50,
        ma200: techData.ma200,
        volume: techData.volume,
        volumeAvg: techData.volumeAvg,
        pctOf52wHi: techData.fiftyTwoWeekHigh
          ? +((techData.price / techData.fiftyTwoWeekHigh) * 100).toFixed(1)
          : 100,
        vs50dPct: techData.ma50
          ? +(((techData.price / techData.ma50) - 1) * 100).toFixed(1)
          : 0,
        signal: computeSignal({
          ticker: ta.ticker,
          source: "tag-along",
          price: techData.price,
          rsi: techData.rsi,
          ma50: techData.ma50,
          ma200: techData.ma200,
          volume: techData.volume,
          volumeAvg: techData.volumeAvg,
          pctOf52wHi: techData.fiftyTwoWeekHigh ? +((techData.price / techData.fiftyTwoWeekHigh) * 100).toFixed(1) : 100,
          vs50dPct: techData.ma50 ? +(((techData.price / techData.ma50) - 1) * 100).toFixed(1) : 0,
          status: "new",
        } as DiscoveryEntry),
        status: "new",
        headlinePreview: ta.headline.slice(0, 200),
      });
    }
  }

  // ── Phase 2: Unusual Volume Screen ─────────────────────────────────────
  // Only runs when not gated (costs ~40 Yahoo Finance requests)
  const didVolumeScreen = !skipVolumeScreen;
  if (skipVolumeScreen) {
    console.log("[DISCOVERY] Volume/momentum screen skipped (gated or forced-skip)");
  } else {
    console.log("[DISCOVERY] Scanning broad market for unusual volume/momentum...");
  }
  const screen = skipVolumeScreen ? { volumeSurges: [], momentumRunners: [] } : await screenUnusualActivity();

  if (didVolumeScreen) {
    updateVolumeGate(); // persist timestamp so gate blocks for 4h
  }

  for (const vs of screen.volumeSurges) {
    const techData = await fetchDiscoveryQuote(vs.ticker);
    addToQueue(vs.ticker, "volume-surge", `Volume ${vs.volumeRatio}x avg (${vs.changePct >= 0 ? "+" : ""}${vs.changePct.toFixed(2)}%)`, undefined, techData || vs);
    result.volumeSurges.push({
      ticker: vs.ticker,
      discoveredAt: new Date().toISOString(),
      source: "volume-surge",
      catalyst: `Volume ${vs.volumeRatio}x avg — ${vs.changePct >= 0 ? "up" : "down"} ${Math.abs(vs.changePct).toFixed(1)}%`,
      price: techData?.price ?? vs.price,
      rsi: techData?.rsi ?? vs.rsi,
      ma50: techData?.ma50 ?? 0,
      ma200: techData?.ma200 ?? 0,
      volume: techData?.volume ?? 0,
      volumeAvg: techData?.volumeAvg ?? 0,
      pctOf52wHi: techData?.fiftyTwoWeekHigh
        ? +((vs.price / techData.fiftyTwoWeekHigh) * 100).toFixed(1)
        : 100,
      vs50dPct: techData?.ma50
        ? +(((vs.price / techData.ma50) - 1) * 100).toFixed(1)
        : 0,
      signal: computeSignal({
        ticker: vs.ticker, source: "volume-surge",
        price: techData?.price ?? vs.price,
        rsi: techData?.rsi ?? vs.rsi,
        ma50: techData?.ma50 ?? 0, ma200: techData?.ma200 ?? 0,
        volume: techData?.volume ?? 0, volumeAvg: techData?.volumeAvg ?? 0,
        pctOf52wHi: techData?.fiftyTwoWeekHigh
          ? +((vs.price / techData.fiftyTwoWeekHigh) * 100).toFixed(1) : 100,
        vs50dPct: techData?.ma50
          ? +(((vs.price / techData.ma50) - 1) * 100).toFixed(1) : 0,
        status: "new",
      } as DiscoveryEntry),
      status: "new",
    });
  }

  for (const mr of screen.momentumRunners) {
    const techData = await fetchDiscoveryQuote(mr.ticker);
    addToQueue(mr.ticker, "momentum-runner",
      `${mr.changePct >= 0 ? "Up" : "Down"} ${Math.abs(mr.changePct).toFixed(1)}% — momentum runner`,
      undefined, techData || mr);
    result.momentumRunners.push({
      ticker: mr.ticker,
      discoveredAt: new Date().toISOString(),
      source: "momentum-runner",
      catalyst: `${mr.changePct >= 0 ? "Up" : "Down"} ${Math.abs(mr.changePct).toFixed(1)}%`,
      price: techData?.price ?? mr.price,
      rsi: techData?.rsi ?? mr.rsi,
      ma50: techData?.ma50 ?? 0,
      ma200: techData?.ma200 ?? 0,
      volume: techData?.volume ?? 0,
      volumeAvg: techData?.volumeAvg ?? 0,
      pctOf52wHi: mr.pctOf52wHi,
      vs50dPct: mr.vs50dPct,
      signal: computeSignal({
        ticker: mr.ticker, source: "momentum-runner",
        price: techData?.price ?? mr.price,
        rsi: techData?.rsi ?? mr.rsi,
        ma50: techData?.ma50 ?? 0, ma200: techData?.ma200 ?? 0,
        volume: techData?.volume ?? 0, volumeAvg: techData?.volumeAvg ?? 0,
        pctOf52wHi: mr.pctOf52wHi,
        vs50dPct: mr.vs50dPct,
        status: "new",
      } as DiscoveryEntry),
      status: "new",
    });
  }

  console.log(`[DISCOVERY] Scan complete: ${result.tagAlong.length} tag-along, ${result.volumeSurges.length} volume surges, ${result.momentumRunners.length} momentum runners`);

  return result;
}

// ═══════════════════════════════════════════════════════════════════════════════
// DISCOVERY SUMMARY FOR SCANNER OUTPUT
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Get a human-readable summary of the current discovery queue for the scanner output.
 * Only shows "new" status entries. Sorted by: momentum-runner > volume-surge > tag-along.
 */
/**
 * Compute a BUY / SELL / HOLD signal for a discovery entry.
 * Logic:
 *   BUY  — RSI < 55 (not overbought) + price within 30% of 52w low OR
 *           RSI in 40-55 sweet spot + dip vs 50d MA
 *   SELL — RSI > 68 (overbought) AND price > 95% of 52w high (extended)
 *   HOLD — everything else (neutral zone)
 */
function computeSignal(entry: DiscoveryEntry): "BUY" | "SELL" | "HOLD" {
  // SELL: overbought + extended = avoid
  if (entry.rsi > 68 && entry.pctOf52wHi > 90) return "SELL";
  // BUY: RSI in oversold-to-neutral range (40-55) + not extremely extended
  if (entry.rsi >= 40 && entry.rsi < 68 && entry.pctOf52wHi < 95) {
    // Confirm momentum isn't already exhausted
    if (entry.vs50dPct < 25) return "BUY";
  }
  // BUY: RSI < 40 (oversold) + reasonable entry point
  if (entry.rsi < 40 && entry.pctOf52wHi < 95) return "BUY";
  return "HOLD";
}

/** Compute a discovery confidence score 0-100 */

/**
 * Backfill signal field for any queue entries that were persisted before
 * the signal field existed. Mutates entries in place.
 */
function patchMissingSignals(entries: DiscoveryEntry[]): DiscoveryEntry[] {
  return entries.map(e => {
    if ((e as any).signal) return e;
    return { ...e, signal: computeSignal(e) };
  });
}

function computeDiscoveryConfidence(entry: DiscoveryEntry): number {
  let score = 50;
  if (entry.source === "volume-surge") {
    const volRatio = entry.volumeAvg > 0 ? entry.volume / entry.volumeAvg : 0;
    score += Math.min(20, volRatio * 5);
    if (entry.rsi <= 42) score += 12;
    else if (entry.rsi >= 68) score -= 8;
  }
  if (entry.source === "momentum-runner") {
    if (entry.catalyst?.startsWith("Up")) {
      if (entry.rsi < 42) score += 5;
      else if (entry.rsi < 60) score += 12;
      else score += 5;
    } else {
      if (entry.rsi < 42) score += 15;
      else score += 5;
    }
  }
  if (entry.source === "tag-along") {
    if (entry.vs50dPct < -5) score += 14;
    else if (entry.vs50dPct > 25) score -= 10;
    if (entry.rsi <= 42) score += 10;
    else if (entry.rsi >= 68) score -= 8;
  }
  if (entry.rsi <= 35) score += 8;
  if (entry.pctOf52wHi < 50) score += 5;
  if (entry.pctOf52wHi > 95) score -= 5;
  return Math.max(0, Math.min(100, Math.round(score)));
}
function confidenceBar(score: number): string {
  const n = Math.min(100, Math.max(0, score));
  const filled = Math.round(n / 10);
  const bar = "█".repeat(filled) + "░".repeat(10 - filled);
  return `[${bar}] ${Math.round(n)}/100`;
}
/**
 * Get a human-readable summary of the current discovery queue for the scanner output.
 * Only shows "new" status entries. Sorted by: momentum-runner > volume-surge > tag-along.
 */
export function formatDiscoverySummary(): string {
  const queue = loadQueue();
  // Backfill signal for any entries that predate the signal field
  queue.entries = patchMissingSignals(queue.entries);
  const newEntries = queue.entries.filter(e => e.status === "new")
    .sort((a, b) => {
      const order = { "tag-along": 0, "volume-surge": 1, "momentum-runner": 2 };
      return (order[a.source] ?? 9) - (order[b.source] ?? 9);
    });

  if (newEntries.length === 0) return "";

  const timestamp = new Date().toLocaleString("en-US", {
    month: "short", day: "numeric", hour: "numeric", minute: "2-digit",
  });

  let output = `
🔍 *MARKET DISCOVERY* — ${timestamp}
`;
  output += `_News tag-along + volume/momentum screen | Warm Bench queue_

`;

  for (const entry of newEntries.slice(0, 8)) {
    const icon = entry.source === "volume-surge" ? "📊" :
                 entry.source === "momentum-runner" ? "🚀" : "🔗";
    const dir = entry.vs50dPct > 20 ? "Extended" : entry.vs50dPct < -10 ? "Dip" : "Neutral";
    const rsiLabel = entry.rsi <= 40 ? "Oversold" : entry.rsi <= 55 ? "Neutral" : entry.rsi <= 68 ? "Elevated" : "Overbought";
    const conf = computeDiscoveryConfidence(entry);
    const bar = confidenceBar(conf);
    const signalBadge = entry.signal === "BUY" ? "🟢 BUY" : entry.signal === "SELL" ? "🔴 SELL" : "🟡 HOLD";
    const pricePos = entry.pctOf52wHi > 95 ? "Near 52w high" : entry.pctOf52wHi < 50 ? "Near 52w low" : `${entry.pctOf52wHi.toFixed(0)}% of 52w`;
    output += `${icon} *${entry.ticker}* ${signalBadge} | RSI ${entry.rsi.toFixed(0)} (${rsiLabel}) | ${pricePos}   ${bar}\n`;
    output += `   Price: $${entry.price.toFixed(2)} | vs MA50: ${entry.vs50dPct >= 0 ? "+" : ""}${entry.vs50dPct.toFixed(1)}%\n`;
    if (entry.catalyst) output += `   📰 ${entry.catalyst}
`;
    if (entry.headlinePreview) output += `   “${entry.headlinePreview.slice(0, 100)}”
`;
    output += `
`;
  }

  if (newEntries.length > 8) {
    output += `_+${newEntries.length - 8} more in queue_ — check data/discovery-queue.json

`;
  }

  output += `_Reply DISCOVER /ticker to promote, DISMISS /ticker to remove._
`;
  return output;
}

/**
 * Promote a ticker from the discovery queue to active consideration.
 * Marks as "promoted" so the scanner stops surfacing it.
 */
export function promoteTicker(ticker: string): boolean {
  const queue = loadQueue();
  const entry = queue.entries.find(e => e.ticker.toUpperCase() === ticker.toUpperCase() && e.status !== "dismissed");
  if (!entry) {
    console.log(`[DISCOVERY] Ticker ${ticker} not found in queue`);
    return false;
  }
  entry.status = "promoted";
  saveQueue(queue);
  console.log(`[DISCOVERY] ${ticker} promoted from queue`);
  return true;
}

/**
 * Dismiss a ticker from the discovery queue.
 */
export function dismissTicker(ticker: string): boolean {
  const queue = loadQueue();
  const entry = queue.entries.find(e => e.ticker.toUpperCase() === ticker.toUpperCase());
  if (!entry) return false;
  entry.status = "dismissed";
  saveQueue(queue);
  console.log(`[DISCOVERY] ${ticker} dismissed from queue`);
  return true;
}

/**
 * Get the count of new (unreviewed) discovery entries.
 */
export function getNewDiscoveryCount(): number {
  const queue = loadQueue();
  return queue.entries.filter(e => e.status === "new").length;
}
