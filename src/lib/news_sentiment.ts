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
const MINIMAX_API_KEY = process.env.MINIMAX_API_KEY ?? "";
const FINNHUB_BASE = "https://finnhub.io/api/v1";
const MINIMAX_BASE = "https://api.minimax.io/anthropic/v1/messages";

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
    // Finnhub company-news endpoint — fetch last 2 days
    const today = new Date();
    const to = today.toISOString().split("T")[0];
    const from = new Date(today.getTime() - 48 * 60 * 60 * 1000).toISOString().split("T")[0];
    const url = `${FINNHUB_BASE}/company-news?symbol=${ticker}&from=${from}&to=${to}&token=${FINNHUB_API_KEY}`;
    const response = await fetch(url, { signal: AbortSignal.timeout(30000) });

    if (!response.ok) {
      throw new Error(`Finnhub ${response.status}`);
    }

    const articles: FinnhubNewsItem[] = await response.json() as FinnhubNewsItem[];

    // Use the headline-match filter as a secondary relevance check
    const tickerUpper = ticker.toUpperCase();
    const relevant = articles
      .filter(a => a.headline && a.headline.toUpperCase().includes(tickerUpper))
      .slice(0, 10); // cap at 10 articles

    if (relevant.length === 0) {
      const neutral: SentimentCache = { score: 0, label: "neutral", headlines: [], fetchedAt: now };
      cache.set(ticker, neutral);
      return { score: 0, label: "neutral", headlines: [] };
    }

    // Compute sentiment: prefer Finnhub's built-in score, fall back to MiniMax AI
    const hasRealSentiment = relevant.some(a => a.sentiment != null && a.sentiment !== 0);
    let avgSentiment: number;
    if (hasRealSentiment) {
      avgSentiment = relevant.reduce((sum, a) => sum + (a.sentiment ?? 0), 0) / relevant.length;
    } else if (MINIMAX_API_KEY) {
      const aiResult = await computeSentimentViaAI(ticker, relevant.map(a => a.headline));
      if (aiResult !== null) {
        avgSentiment = aiResult;
      } else {
        // MiniMax failed — fall back to neutral
        avgSentiment = 0;
      }
    } else {
      // No MiniMax key — neutral
      avgSentiment = 0;
    }

    const score = Math.round(avgSentiment * 30);

    const label: SentimentCache["label"] =
      score > 5 ? "positive" :
      score < -5 ? "negative" :
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
 * Use MiniMax AI to compute sentiment scores for a batch of headlines.
 * Returns the average sentiment (-1 to +1), or null on failure.
 */
async function computeSentimentViaAI(ticker: string, headlines: string[]): Promise<number | null> {
  if (!MINIMAX_API_KEY || headlines.length === 0) return null;

  const prompt = `You are a financial news sentiment analyzer. For each headline below about ${ticker}, rate the sentiment on a scale from -1 (very bearish/negative) to +1 (very bullish/positive). Consider the full context and nuance of each headline — not just keywords.

Headlines:
${headlines.map((h, i) => `${i + 1}. ${h}`).join("\n")}

Return ONLY a valid JSON array of numbers, one per headline, in the same order. Example: [0.8, -0.3, 0.0]
Do not include any other text or explanation.`;

  try {
    const response = await fetch(MINIMAX_BASE, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${MINIMAX_API_KEY}`,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: "MiniMax-M2.7",
        max_tokens: 300,
        temperature: 0.1,  // low temperature for consistency
        system: "You are a precise financial sentiment analyzer. Respond only with valid JSON arrays.",
        messages: [{ role: "user", content: prompt }],
      }),
      signal: AbortSignal.timeout(20000),
    });

    if (!response.ok) {
      const text = await response.text().catch(() => "");
      console.warn(`[NEWS][AI] ${ticker}: MiniMax ${response.status} — ${text.substring(0, 100)}`);
      return null;
    }

    const data: any = await response.json();
    const content = data?.content ?? [];
    // Grab the LAST text block (after any thinking/prelude blocks)
    let textBlock: any = null;
    for (const b of content) {
      if (b.type === "text") textBlock = b;
    }

    // Extract JSON array from whichever block has it — flexible pattern
    const extractJSON = (raw: string): number[] | null => {
      // Strip markdown code fences first
      let cleaned = raw.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "");
      const m = cleaned.match(/\[\s*[\d.,\-]+(?:\s*,\s*[\d.,\-]+)*\s*\]/);
      if (!m) return null;
      try { return JSON.parse(m[0]) as number[]; } catch { return null; }
    };

    let scores: number[] | null = null;
    if (textBlock?.text) {
      scores = extractJSON(textBlock.text);
    }
    if (!scores) {
      // Try thinking block
      const thinkBlock = content.find((b: any) => b.type === "thinking");
      if (thinkBlock?.thinking) {
        scores = extractJSON(thinkBlock.thinking);
      }
    }
    if (!scores || scores.length === 0) {
      console.warn(`[NEWS][AI] ${ticker}: Could not parse sentiment JSON`);
      return null;
    }

    const avg = Math.max(-1, Math.min(1, scores.reduce((s, v) => s + v, 0) / scores.length));
    return avg;
  } catch (err) {
    console.warn(`[NEWS][AI] ${ticker}: MiniMax sentiment failed — ${err}`);
    return null;
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
