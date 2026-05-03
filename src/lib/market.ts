import { MarketData, Position, PortfolioTargets, DriftThresholds, TradeRecommendation } from "./types";

const TICKERS = ["NVDA", "SMH", "SCHG"] as const;
export { TICKERS };
const LAST_KNOWN_PRICES_PATH = "./data/last-known-prices.json";

// === Yahoo Finance Integration ===

import * as fs from "fs";
import * as path from "path";

interface LastKnownPrices {
  [ticker: string]: { price: number; date: string };
}

/**
 * Load last-known prices from fallback file
 */
export function loadLastKnownPrices(): LastKnownPrices {
  const filePath = path.resolve(LAST_KNOWN_PRICES_PATH);
  if (!fs.existsSync(filePath)) return {};
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch {
    return {};
  }
}

/**
 * Save last-known prices to fallback file
 */
export function saveLastKnownPrices(prices: LastKnownPrices): void {
  const filePath = path.resolve(LAST_KNOWN_PRICES_PATH);
  fs.writeFileSync(filePath, JSON.stringify(prices, null, 2));
  console.log(`[MARKET] Saved last-known prices to ${filePath}`);
}

/**
 * Fetch quotes for all tickers in a single batch using Yahoo Finance
 * Retries once on failure, then falls back to last-known prices
 */
export async function getBatchQuotes(): Promise<Map<string, MarketData>> {
  const quotes = new Map<string, MarketData>();
  const lastKnown = loadLastKnownPrices();
  const errors: string[] = [];

  // Attempt 1: Live fetch via Yahoo Finance
  for (const ticker of TICKERS) {
    const quote = await fetchWithRetry(ticker);
    if (quote) {
      quotes.set(ticker, quote);
    } else {
      errors.push(ticker);
    }
  }

  // Attempt 2: Retry failed tickers once
  if (errors.length > 0) {
    console.log(`[MARKET] Retrying ${errors.length} failed ticker(s): ${errors.join(", ")}`);
    const retryErrors: string[] = [];
    for (const ticker of errors) {
      const quote = await fetchWithRetry(ticker);
      if (quote) {
        quotes.set(ticker, quote);
      } else {
        retryErrors.push(ticker);
      }
    }

    // Fallback: Last-known prices for any remaining failures
    if (retryErrors.length > 0) {
      console.warn(`[MARKET] Falling back to last-known prices for: ${retryErrors.join(", ")}`);
      for (const ticker of retryErrors) {
        const lkp = lastKnown[ticker];
        if (lkp) {
          console.warn(`[MARKET] ${ticker}: using last known price $${lkp.price.toFixed(2)} from ${lkp.date}`);
          quotes.set(ticker, {
            ticker,
            price: lkp.price,
            previousClose: lkp.price,
            change: 0,
            changePercent: 0,
            rsi: 50,
            ma20: lkp.price,
            ma50: lkp.price,
            volume: 0,
            volumeAvg: 0,
            status: "neutral",
            signals: ["fallback_ price"],
          });
        } else {
          console.error(`[MARKET] No last-known price for ${ticker} — cannot populate`);
        }
      }
    }
  }

  // Persist current prices as new last-known
  const toSave: LastKnownPrices = {};
  for (const [ticker, quote] of quotes) {
    toSave[ticker] = { price: quote.price, date: new Date().toISOString().split("T")[0] };
  }
  saveLastKnownPrices(toSave);

  return quotes;
}

/**
 * Single fetch with one retry on failure (returns null on persistent failure)
 */
async function fetchWithRetry(ticker: string, attempt = 1): Promise<MarketData | null> {
  try {
    const mod = await import("yahoo-finance2");
    const YF = (mod as any).default ?? mod;
    const yahooFinance = new YF({ suppressNotices: ["yahooSurvey"] });
    if (typeof yahooFinance.quote !== "function") {
      console.error(`[MARKET] yahoo-finance2.quote not available`);
      return null;
    }

    const result = await yahooFinance.quote(ticker);
    if (!result || typeof result.regularMarketPrice !== "number") {
      console.warn(`[MARKET] ${ticker}: no valid quote result (attempt ${attempt})`);
      return attempt < 2 ? new Promise(r => setTimeout(() => r(fetchWithRetry(ticker, 2)), 1000)) : null;
    }

    const price = result.regularMarketPrice;
    const prevClose = result.regularMarketPreviousClose ?? price;
    const change = result.regularMarketChange ?? 0;
    const changePercent = result.regularMarketChangePercent ?? 0;
    const volume = result.regularMarketVolume ?? 0;
    const volumeAvg = result.averageDailyVolume10Week ?? volume;

    let status: "bull" | "bear" | "neutral" = "neutral";
    if (changePercent > 1) status = "bull";
    else if (changePercent < -1) status = "bear";

    return {
      ticker,
      price,
      previousClose: prevClose,
      change,
      changePercent,
      rsi: 50, // Yahoo Finance does not provide RSI; can be extended
      ma20: result.fiftyDayAverage ?? price,
      ma50: result.twoHundredDayAverage ?? price,
      volume,
      volumeAvg,
      status,
      signals: [],
    };
  } catch (error) {
    console.error(`[MARKET] ${ticker}: fetch failed (attempt ${attempt}):`, error);
    return attempt < 2
      ? new Promise(r => setTimeout(() => r(fetchWithRetry(ticker, 2)), 1000))
      : null;
  }
}

// === Alpha Vantage (retained for RSI — deprecated for price feeds) ===

const ALPHA_VANTAGE_BASE = "https://www.alphavantage.co/query";
const GLOBAL_QUOTE_ENDPOINT = "GLOBAL_QUOTE";
const RSI_ENDPOINT = "RSI";

/**
 * Fetch real-time quote from Alpha Vantage (deprecated — use getBatchQuotes)
 * @deprecated
 */
export async function getQuote(symbol: string, apiKey: string): Promise<MarketData | null> {
  const url = `${ALPHA_VANTAGE_BASE}?function=${GLOBAL_QUOTE_ENDPOINT}&symbol=${symbol}&apikey=${apiKey}`;

  try {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);

    const data = await res.json() as {
      "Global Quote": {
        "05. price": string;
        "08. previous close": string;
        "09. change": string;
        "10. change percent": string;
        "06. volume": string;
      };
    };
    const quote = data["Global Quote"];

    if (!quote || !quote["05. price"]) {
      console.warn(`[MARKET] No quote data for ${symbol}`);
      return null;
    }

    const price = parseFloat(quote["05. price"]);
    const prevClose = parseFloat(quote["08. previous close"]);
    const change = parseFloat(quote["09. change"]);
    const changePercent = parseFloat(quote["10. change percent"].replace("%", ""));

    return {
      ticker: symbol,
      price,
      previousClose: prevClose,
      change,
      changePercent,
      rsi: 50,
      ma20: price,
      ma50: price,
      volume: parseInt(quote["06. volume"]),
      volumeAvg: parseInt(quote["06. volume"]),
      status: changePercent > 1 ? "bull" : changePercent < -1 ? "bear" : "neutral",
      signals: [],
    };
  } catch (error) {
    console.error(`[MARKET] Failed to fetch ${symbol}:`, error);
    return null;
  }
}

/**
 * Get RSI for a symbol (14-day default)
 */
export async function getRSI(symbol: string, apiKey: string, interval: string = "daily", timePeriod: number = 14): Promise<number | null> {
  const url = `${ALPHA_VANTAGE_BASE}?function=${RSI_ENDPOINT}&symbol=${symbol}&interval=${interval}&time_period=${timePeriod}&series_type=close&apikey=${apiKey}`;

  try {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);

    const data = await res.json() as {
      "Technical Analysis: RSI": { data: Array<{ date: string; RSI: string }> };
    };
    const rsiData = data["Technical Analysis: RSI"];

    if (!rsiData || !rsiData["data"] || rsiData["data"].length === 0) {
      return null;
    }

    const latest = rsiData["data"][0];
    return parseFloat(latest["RSI"]);
  } catch (error) {
    console.error(`[MARKET] Failed to fetch RSI for ${symbol}:`, error);
    return null;
  }
}

// === Portfolio Calculations ===

/**
 * Calculate current portfolio positions with drift
 */
export function calculatePositions(
  quotes: Map<string, MarketData>,
  holdings: Map<string, number>, // shares
  targets: PortfolioTargets,
  thresholds: DriftThresholds
): Position[] {
  const positions: Position[] = [];
  let totalValue = 0;

  for (const [ticker, shares] of holdings) {
    const quote = quotes.get(ticker);
    if (!quote) continue;
    totalValue += quote.price * shares;
  }

  const cashPosition = 85000 * 0.1;
  totalValue += cashPosition;

  for (const [ticker, shares] of holdings) {
    const quote = quotes.get(ticker);
    if (!quote) continue;

    const marketValue = quote.price * shares;
    const targetKey = ticker as keyof PortfolioTargets;
    const targetWeight = targets[targetKey] || 0.1;
    const currentWeight = marketValue / totalValue;
    const drift = ((currentWeight - targetWeight) / targetWeight) * 100;

    let status: "on-target" | "drifted" | "black-swan" = "on-target";
    const thresholdKey = ticker as keyof DriftThresholds;
    const driftThreshold = thresholds[thresholdKey] || 5;

    if (Math.abs(quote.changePercent) > 8) {
      status = "black-swan";
    } else if (Math.abs(drift) > driftThreshold) {
      status = "drifted";
    }

    positions.push({
      ticker,
      shares,
      avgCost: 0,
      currentPrice: quote.price,
      marketValue,
      dayChange: quote.change * shares,
      dayChangePercent: quote.changePercent,
      weight: currentWeight * 100,
      targetWeight: targetWeight * 100,
      drift,
      status,
    });
  }

  return positions;
}

/**
 * Generate trade recommendations based on drift
 */
export function generateRebalanceRecommendations(positions: Position[]): TradeRecommendation[] {
  const recommendations: TradeRecommendation[] = [];

  for (const pos of positions) {
    if (pos.status === "drifted") {
      const action = pos.drift > 0 ? "SELL" : "BUY";
      const sharesToMove = Math.floor(Math.abs(pos.drift) * 0.5);

      recommendations.push({
        action,
        ticker: pos.ticker,
        shares: sharesToMove,
        reason: `${pos.ticker} drifted ${pos.drift.toFixed(1)}% from target (${pos.targetWeight.toFixed(0)}%)`,
        confidence: "medium",
        requiresConfirmation: false,
        type: "rebalance",
      });
    }

    if (pos.status === "black-swan") {
      recommendations.push({
        action: "HOLD",
        ticker: pos.ticker,
        dollarAmount: Math.abs(pos.dayChange),
        reason: `Black swan event: ${pos.ticker} ${pos.dayChangePercent.toFixed(1)}%. Confirm before action.`,
        confidence: "high",
        requiresConfirmation: true,
        type: "black-swan",
      });
    }
  }

  return recommendations;
}

/**
 * Format market summary for WhatsApp
 */
export function formatMarketSummary(quotes: Map<string, MarketData>): { text: string; biggestMover: { ticker: string; change: number } } {
  let output = `📈 *MARKET SUMMARY*\n`;

  let biggestMover = { ticker: "", change: 0 };

  for (const ticker of TICKERS) {
    const quote = quotes.get(ticker);
    if (!quote) {
      output += `${ticker}: N/A\n`;
      continue;
    }

    const emoji = quote.changePercent > 2 ? "🟢" : quote.changePercent < -2 ? "🔴" : "🟡";
    output += `${emoji} ${ticker}: $${quote.price.toFixed(2)} (${quote.changePercent > 0 ? "+" : ""}${quote.changePercent.toFixed(2)}%)\n`;

    if (Math.abs(quote.changePercent) > Math.abs(biggestMover.change)) {
      biggestMover = { ticker, change: quote.changePercent };
    }
  }

  return { text: output, biggestMover };
}

/**
 * Format positions for WhatsApp
 */
export function formatPositionsForBrief(positions: Position[]): string {
  let output = `💼 *PORTFOLIO*\n`;

  for (const pos of positions) {
    const driftEmoji = pos.drift > 2 ? "📈" : pos.drift < -2 ? "📉" : "➖";
    const statusEmoji = pos.status === "black-swan" ? "⚠️" : pos.status === "drifted" ? "🔄" : "✅";

    output += `${statusEmoji} ${pos.ticker}: $${pos.marketValue.toFixed(0)} (${pos.weight.toFixed(1)}%) ${driftEmoji} ${pos.drift > 0 ? "+" : ""}${pos.drift.toFixed(1)}% | $${pos.currentPrice.toFixed(2)}\n`;
  }

  return output;
}

// === Mock Data for Testing ===

export function getMockQuotes(): Map<string, MarketData> {
  const quotes = new Map<string, MarketData>();

  quotes.set("NVDA", {
    ticker: "NVDA",
    price: 120.50,
    previousClose: 127.00,
    change: -6.50,
    changePercent: -5.12,
    rsi: 55,
    ma20: 125.00,
    ma50: 120.00,
    volume: 45000000,
    volumeAvg: 40000000,
    status: "bear",
    signals: ["below_ma20", "high_volume"],
  });

  quotes.set("SMH", {
    ticker: "SMH",
    price: 178.25,
    previousClose: 183.50,
    change: -5.25,
    changePercent: -2.86,
    rsi: 48,
    ma20: 182.00,
    ma50: 180.00,
    volume: 8500000,
    volumeAvg: 9000000,
    status: "neutral",
    signals: ["below_ma50"],
  });

  quotes.set("SCHG", {
    ticker: "SCHG",
    price: 94.80,
    previousClose: 94.50,
    change: 0.30,
    changePercent: 0.32,
    rsi: 58,
    ma20: 93.50,
    ma50: 92.00,
    volume: 3200000,
    volumeAvg: 3000000,
    status: "bull",
    signals: ["above_ma20", "above_ma50"],
  });

  return quotes;
}

export function getMockHoldings(): Map<string, number> {
  const holdings = new Map<string, number>();
  holdings.set("NVDA", 100);
  holdings.set("SMH", 75);
  holdings.set("SCHG", 50);
  return holdings;
}

export const MOCK_TARGETS: PortfolioTargets = {
  NVDA: 0.40,
  SMH: 0.30,
  SCHG: 0.20,
  CASH: 0.10,
};

export const MOCK_DRIFT_THRESHOLDS: DriftThresholds = {
  NVDA: 7,
  SMH: 7,
  SCHG: 5,
};
