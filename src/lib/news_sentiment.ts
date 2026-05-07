/**
 * News Sentiment Fetcher — pulls recent headlines from Finnhub (free tier)
 * and computes a -30 to +30 sentiment score per ticker.
 * Falls back gracefully if API is unavailable.
 */

// Simple in-memory cache: ticker -> { score, fetchedAt, articles }
interface SentimentCache {
  score: number;       // -30 to +30
  label: "positive" | "negative" | "neutral" | "mixed";
  headlines: string[];
  fetchedAt: number;    // Date.now()
}

const cache = new Map<string, SentimentCache>();
const CACHE_TTL_MS = 30 * 60 * 1000; // 30 minutes

const FINNHUB_API_KEY = process.env.FINNHUB_API_KEY ?? "";
const FINNHUB_BASE = "https://finnhub.io/api/v1";

interface FinnhubNewsItem {
  id: number;
  headline: string;
  sentiment: number;     // -1 to +1
  source: string;
}

/**
 * Fetch recent news sentiment for a ticker.
 * Returns a sentiment score from -30 (very bearish) to +30 (very bullish).
 * Cached for 30 minutes to avoid hammering the API.
 */
export async function fetchNewsSentiment(ticker: string): Promise<{
  score: number;       // -30 to +30
  label: "positive" | "negative" | "neutral" | "mixed";
  headlines: string[];
}> {
  const now = Date.now();
  const cached = cache.get(ticker);

  if (cached && now - cached.fetchedAt < CACHE_TTL_MS) {
    return { score: cached.score, label: cached.label, headlines: cached.headlines };
  }

  if (!FINNHUB_API_KEY) {
    // No API key — return neutral rather than failing
    return { score: 0, label: "neutral", headlines: [] };
  }

  try {
    // Finnhub company news — last 24 hours, category=forex | crypto | merger
    const url = `${FINNHUB_BASE}/news?category=general&token=${FINNHUB_API_KEY}`;
    const response = await fetch(url, { signal: AbortSignal.timeout(5000) });

    if (!response.ok) {
      throw new Error(`Finnhub ${response.status}`);
    }

    const articles: FinnhubNewsItem[] = await response.json() as FinnhubNewsItem[];

    // Filter to articles mentioning this ticker in the headline
    const tickerUpper = ticker.toUpperCase();
    const relevant = articles
      .filter(a => a.headline.toUpperCase().includes(tickerUpper))
      .slice(0, 10); // cap at 10 articles

    if (relevant.length === 0) {
      const neutral: SentimentCache = { score: 0, label: "neutral", headlines: [], fetchedAt: now };
      cache.set(ticker, neutral);
      return { score: 0, label: "neutral", headlines: [] };
    }

    // Average sentiment: -1 to +1 → scale to -30 to +30
    const avgSentiment = relevant.reduce((sum, a) => sum + (a.sentiment ?? 0), 0) / relevant.length;
    const score = Math.round(avgSentiment * 30);

    const label: SentimentCache["label"] =
      score > 10 ? "positive" :
      score < -10 ? "negative" :
      "neutral";

    const headlines = relevant.slice(0, 3).map(a => a.headline);

    const entry: SentimentCache = { score, label, headlines, fetchedAt: now };
    cache.set(ticker, entry);

    return { score, label, headlines };
  } catch (err) {
    console.warn(`[NEWS] ${ticker}: sentiment fetch failed — ${err}. Falling back to neutral.`);
    return { score: 0, label: "neutral", headlines: [] };
  }
}

/**
 * Batch-fetch news sentiment for multiple tickers concurrently.
 * Parallel requests, shared cache.
 */
export async function batchFetchNewsSentiment(
  tickers: string[]
): Promise<Map<string, { score: number; label: string; headlines: string[] }>> {
  const results = new Map<string, { score: number; label: string; headlines: string[] }>();

  await Promise.all(
    tickers.map(async (ticker) => {
      const result = await fetchNewsSentiment(ticker);
      results.set(ticker, result);
    })
  );

  return results;
}
