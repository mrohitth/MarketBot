import { MarketData, Position, TradeRecommendation, TICKERS, MACRO_TICKERS, SECTOR_TICKERS, WATCHLIST_TICKERS, EXPENSE_RATIOS, ER_FLAG_THRESHOLD } from "./types";
import {
  PORTFOLIO_TARGET_ALLOCATION,
  DRIFT_THRESHOLDS_ADVISORY,
  BLACK_SWAN_THRESHOLD_PCT,
  CORE_TICKERS,
  generateTradeSetups,
  rankSetups,
  OpenPosition,
  TradeSetup,
} from "./recommendations";

const LAST_KNOWN_PRICES_PATH = "./data/last-known-prices.json";

import * as fs from "fs";
import * as path from "path";

interface LastKnownPrices {
  [ticker: string]: { price: number; date: string };
}

export function loadLastKnownPrices(): LastKnownPrices {
  const filePath = path.resolve(LAST_KNOWN_PRICES_PATH);
  if (!fs.existsSync(filePath)) return {};
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch {
    return {};
  }
}

export function saveLastKnownPrices(prices: LastKnownPrices): void {
  const filePath = path.resolve(LAST_KNOWN_PRICES_PATH);
  fs.writeFileSync(filePath, JSON.stringify(prices, null, 2));
  console.log(`[MARKET] Saved last-known prices to ${filePath}`);
}

async function fetchQuotesForTickers(tickers: readonly string[]): Promise<Map<string, MarketData>> {
  const quotes = new Map<string, MarketData>();
  const lastKnown = loadLastKnownPrices();

  for (const ticker of tickers) {
    const quote = await fetchWithRetry(ticker);
    if (quote) {
      quotes.set(ticker, quote);
    } else {
      const lkp = lastKnown[ticker];
      if (lkp) {
        quotes.set(ticker, {
          ticker,
          price: lkp.price,
          previousClose: lkp.price,
          change: 0,
          changePercent: 0,
          rsi: 50,
          ma20: lkp.price,
          ma50: lkp.price,
          ma50Slope: 0,
          volume: 0,
          volumeAvg: 0,
          status: "neutral",
          signals: ["fallback_price"],
        });
      }
    }
  }

  return quotes;
}

export async function getBatchQuotes(): Promise<Map<string, MarketData>> {
  return fetchQuotesForTickers(TICKERS);
}

export async function getMacroQuotes(): Promise<Map<string, MarketData>> {
  return fetchQuotesForTickers(MACRO_TICKERS);
}

export async function getSectorQuotes(): Promise<Map<string, MarketData>> {
  return fetchQuotesForTickers(SECTOR_TICKERS);
}

export async function getWatchlistQuotes(): Promise<Map<string, MarketData>> {
  return fetchQuotesForTickers(WATCHLIST_TICKERS);
}

// ── RSI Constants ─────────────────────────────────────────────────────────────
const RSI_PERIOD = 14;   // Wilder's default — standard for overbought/oversold analysis
const RSI_OVERSOLD = 35; // More conservative than 30 — reduces false signals
const RSI_OVERBOUGHT = 68; // More conservative than 70 — takes profit sooner in trends

/**
 * Compute Wilder's RSI (Relative Strength Index) from an array of closing prices.
 * Returns a value from 0-100.
 * - RSI > 70  → overbought (potential mean-reversion sell)
 * - RSI < 30  → oversold   (potential bounce long)
 * - RSI 30-50 → weak/bearish regime
 * - RSI 50-70 → neutral/bullish regime
 */
function computeRSI(prices: number[]): number {
  if (prices.length < RSI_PERIOD + 1) return 50;
  let avgGain = 0, avgLoss = 0;
  for (let i = 1; i <= RSI_PERIOD; i++) {
    const d = prices[i] - prices[i - 1];
    avgGain += d > 0 ? d : 0;
    avgLoss += d < 0 ? Math.abs(d) : 0;
  }
  avgGain /= RSI_PERIOD;
  avgLoss /= RSI_PERIOD;
  for (let i = RSI_PERIOD; i < prices.length - 1; i++) {
    const gain = prices[i + 1] - prices[i];
    avgGain = (avgGain * 13 + (gain > 0 ? gain : 0)) / RSI_PERIOD;
    avgLoss = (avgLoss * 13 + (gain < 0 ? Math.abs(gain) : 0)) / RSI_PERIOD;
  }
  if (avgLoss === 0) return 100;
  const rs = avgGain / avgLoss;
  return Math.round((100 - 100 / (1 + rs)) * 100) / 100;
}
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
      return attempt < 2
        ? new Promise(r => setTimeout(() => r(fetchWithRetry(ticker, 2)), 1000))
        : null;
    }

    const price = result.regularMarketPrice;
    const prevClose = result.regularMarketPreviousClose ?? price;
    const change = result.regularMarketChange ?? 0;
    const changePercent = result.regularMarketChangePercent ?? 0;
    const volume = result.regularMarketVolume ?? 0;
    const volumeAvg = result.averageDailyVolume10Week ?? volume;
    const ma20 = result.fiftyDayAverage ?? price;
    const ma50 = (result as any).fiftyDayAverage ?? price; // 50-day MA (fetched from chart)
    const ma200 = result.twoHundredDayAverage ?? price; // 200-day MA — used for MOMENTUM_EXTENDED peak detection

    // ── Fetch real 14-period Wilder's RSI ───────────────────────────────────
    let rsi = 50;
    let ma50Slope = 0;
    try {
      const now = new Date();
      const threeMonthsAgo = new Date(now.getTime() - 100 * 24 * 60 * 60 * 1000); // 100d to ensure 90+ trading days for Wilder RSI seeding + MA50 slope
      const period1 = threeMonthsAgo.toISOString().split("T")[0];
      const period2 = now.toISOString().split("T")[0];
      const chartResult = await yahooFinance.chart(ticker, { period1, period2, interval: "1d" });
      // yahoo-finance2 uses `quotes` array (not `indicators`)
      const quotes = chartResult?.quotes ?? [];
      const closes = quotes
        .map((q: { close?: number | null }) => q.close)
        .filter((c: number | null): c is number => c !== null && !isNaN(c));
      if (closes.length >= RSI_PERIOD + 1) {
        rsi = computeRSI(closes);
      }
      // Compute real 50-day SMA from chart closes (more accurate than Yahoo's ma50)
      // Store in local var so it can be used in the return object
      const ma50FromChart = closes.length >= 50
        ? closes.slice(-50).reduce((a: number, b: number) => a + b, 0) / 50
        : ma50;
      // MA50 slope: compare current MA50 vs MA50 5 days ago (5d % change)
      const ma50_5d_ago = closes.length >= 55
        ? closes.slice(-55, -5).reduce((a: number, b: number) => a + b, 0) / 50
        : ma50FromChart;
      ma50Slope = ma50_5d_ago > 0
        ? ((ma50FromChart - ma50_5d_ago) / ma50_5d_ago) * 100
        : 0;
    } catch (rsiErr) {
      // Non-fatal — fall back to neutral RSI rather than failing the whole fetch
      console.warn(`[MARKET] ${ticker}: RSI computation failed (${rsiErr}), using defaults`);
    }

    let status: "bull" | "bear" | "neutral" = "neutral";
    if (changePercent > 1) status = "bull";
    else if (changePercent < -1) status = "bear";

    const signals: string[] = [];
    if (price > ma20) signals.push("above_ma20");
    if (price < ma20) signals.push("below_ma20");
    if (price > ma50) signals.push("above_ma50");
    if (price < ma50) signals.push("below_ma50");
    if (volume > volumeAvg * 1.5) signals.push("volume_spike");
    if (rsi <= RSI_OVERSOLD) signals.push("rsi_oversold");
    else if (rsi >= RSI_OVERBOUGHT) signals.push("rsi_overbought");

    return {
      ticker,
      price,
      previousClose: prevClose,
      change,
      changePercent,
      rsi,
      ma20,
      ma50,
      ma50Slope: +ma50Slope.toFixed(3),
      ma200,
      volume,
      volumeAvg,
      fiftyTwoWeekHigh: result.fiftyTwoWeekHigh ?? undefined,
      status,
      signals,
    };
  } catch (error) {
    console.error(`[MARKET] ${ticker}: fetch failed (attempt ${attempt}):`, error);
    return attempt < 2
      ? new Promise(r => setTimeout(() => r(fetchWithRetry(ticker, 2)), 1000))
      : null;
  }
}

// === Portfolio Calculations ===

export function calculatePositions(
  quotes: Map<string, MarketData>,
  holdings: Map<string, number>
): Position[] {
  const positions: Position[] = [];
  let totalValue = 0;

  for (const [ticker, shares] of holdings) {
    const quote = quotes.get(ticker);
    if (quote) totalValue += quote.price * shares;
  }

  for (const [ticker, shares] of holdings) {
    const quote = quotes.get(ticker);
    if (!quote) continue;

    const marketValue = quote.price * shares;
    const targetWeight = PORTFOLIO_TARGET_ALLOCATION[ticker] ?? 0.05;
    const currentWeight = marketValue / totalValue;
    const drift = targetWeight > 0 ? ((currentWeight - targetWeight) / targetWeight) * 100 : 0;
    const driftThreshold = DRIFT_THRESHOLDS_ADVISORY[ticker] ?? 5;

    let status: "on-target" | "drifted" | "black-swan" = "on-target";
    if (Math.abs(quote.changePercent) > BLACK_SWAN_THRESHOLD_PCT) status = "black-swan";
    else if (Math.abs(drift) > driftThreshold) status = "drifted";

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
      rsi: quote.rsi,
    });
  }

  return positions;
}

export function generateRebalanceRecommendations(positions: Position[]): TradeRecommendation[] {
  const recommendations: TradeRecommendation[] = [];

  for (const pos of positions) {
    if (pos.status === "drifted") {
      const action = pos.drift > 0 ? "SELL" : "BUY";
      // Dollar-based share count: (overweightDollars) / price
      const portfolioValue = positions.reduce((sum, p) => sum + p.marketValue, 0);
      const overweightDollars = (pos.drift / 100) * portfolioValue;
      const rawSharesToMove = Math.abs(overweightDollars) / pos.currentPrice;
      // Skip SELL for core tickers — managed via Core Accumulation (RSI context), not drift
      if (action === "SELL" && CORE_TICKERS.has(pos.ticker)) continue;
      if (action === "SELL") {
        if (pos.shares === 0 || rawSharesToMove === 0) continue;
        const sharesToMove = Math.min(Math.floor(rawSharesToMove), pos.shares);
        if (sharesToMove === 0) continue;
        recommendations.push({
          action,
          ticker: pos.ticker,
          shares: sharesToMove,
          dollarAmount: sharesToMove * pos.currentPrice,
          reason: `${pos.ticker} drifted ${pos.drift > 0 ? "+" : ""}${pos.drift.toFixed(1)}% from target (${pos.targetWeight.toFixed(0)}%)`,
          confidence: "medium",
          requiresConfirmation: false,
          type: "rebalance",
        });
      } else {
        // BUY side: cap at position size of the reference "mirror" ticker (QQQ at 8% target)
        // to keep recommendations grounded in realistic capital requirements
        if (pos.shares === 0 || rawSharesToMove === 0) continue;
        const mirrorTicker = "QQQ";
        const mirrorPos = positions.find((p) => p.ticker === mirrorTicker);
        const maxBuyShares = mirrorPos ? Math.floor((mirrorPos.marketValue * 0.5) / pos.currentPrice) : Math.floor(rawSharesToMove);
        const sharesToMove = Math.min(Math.floor(rawSharesToMove), maxBuyShares);
        if (sharesToMove === 0) continue;
        recommendations.push({
          action,
          ticker: pos.ticker,
          shares: sharesToMove,
          dollarAmount: sharesToMove * pos.currentPrice,
          reason: `${pos.ticker} drifted ${pos.drift > 0 ? "+" : ""}${pos.drift.toFixed(1)}% from target (${pos.targetWeight.toFixed(0)}%)`,
          confidence: "medium",
          requiresConfirmation: false,
          type: "rebalance",
        });
      }
    }
    if (pos.status === "black-swan") {
      // Black swan: stock dropped significantly (>8%). Mathew bought more today —
      // this is a rebalance BUY on a dip, not a HOLD. Always treat as BUY when dropped.
      const portfolioValue = positions.reduce((sum, p) => sum + p.marketValue, 0);
      const rawSharesToMove = Math.abs((pos.drift / 100) * portfolioValue) / pos.currentPrice;
      const mirrorTicker = "QQQ";
      const mirrorPos = positions.find((p) => p.ticker === mirrorTicker);
      const maxBuyShares = mirrorPos ? Math.floor((mirrorPos.marketValue * 0.5) / pos.currentPrice) : Math.floor(rawSharesToMove);
      const sharesToMove = Math.min(Math.floor(rawSharesToMove), maxBuyShares);
      const driftPct = Math.abs(pos.drift);
      const confidence = driftPct > 50 ? "high" : driftPct > 20 ? "medium" : "low";
      if (sharesToMove > 0) {
        recommendations.push({
          action: "BUY",
          ticker: pos.ticker,
          shares: sharesToMove,
          dollarAmount: sharesToMove * pos.currentPrice,
          reason: `${pos.ticker} black swan: ${pos.dayChangePercent > 0 ? "+" : ""}${pos.dayChangePercent.toFixed(1)}% today — rebalance BUY on dip`,
          confidence: "high",  // Mathew bought 30 shares today — high conviction
          requiresConfirmation: false,
          type: "rebalance",
        });
      }
    }
  }

  return recommendations;
}

export function formatMarketSummary(quotes: Map<string, MarketData>): { text: string; biggestMover: { ticker: string; change: number } } {
  let output = `📈 *MARKET*\n`;
  let biggestMover = { ticker: "", change: 0 };

  for (const [ticker, quote] of quotes) {
    const emoji = quote.changePercent > 2 ? "🟢" : quote.changePercent < -2 ? "🔴" : "🟡";
    const sign = quote.changePercent > 0 ? "+" : "";
    output += `${emoji} ${ticker}: $${quote.price.toFixed(2)} (${sign}${quote.changePercent.toFixed(2)}%)\n`;
    if (Math.abs(quote.changePercent) > Math.abs(biggestMover.change)) {
      biggestMover = { ticker, change: quote.changePercent };
    }
  }

  return { text: output, biggestMover };
}

export function formatPositionsForBrief(positions: Position[]): string {
  let output = `💼 *PORTFOLIO*\n`;

  for (const pos of positions) {
    const statusEmoji = pos.status === "black-swan" ? "⚠️" : pos.status === "drifted" ? "🔄" : "✅";
    const driftSign = pos.drift > 0 ? "+" : "";
    const er = EXPENSE_RATIOS[pos.ticker] ?? 0;
    const erStr = er > 0 ? ` ER ${(er * 100).toFixed(2)}%` : "";
    const erFlag = er > ER_FLAG_THRESHOLD ? " ⚠️" : "";
    output += `${statusEmoji} ${pos.ticker}: $${pos.marketValue.toFixed(0)} (${pos.weight.toFixed(1)}%) 📉 ${driftSign}${pos.drift.toFixed(1)}% | $${pos.currentPrice.toFixed(2)}${erStr}${erFlag}\n`;
  }

  return output;
}

// === Mock Data ===

export function getMockQuotes(): Map<string, MarketData> {
  const quotes = new Map<string, MarketData>();
  const tickers: Array<[string, MarketData]> = [
    ["VTI", { ticker: "VTI", price: 260.00, previousClose: 257.00, change: 3.00, changePercent: 1.17, rsi: 55, ma20: 258.00, ma50: 255.00, ma50Slope: 0, volume: 3000000, volumeAvg: 2800000, status: "bull", signals: ["above_ma20"] }],
    ["NVDA", { ticker: "NVDA", price: 198.45, previousClose: 202.00, change: -3.55, changePercent: -1.76, rsi: 52, ma20: 205.00, ma50: 210.00, ma50Slope: 0, volume: 42000000, volumeAvg: 40000000, status: "bear", signals: ["below_ma20", "below_ma50"] }],
    ["VOO", { ticker: "VOO", price: 450.00, previousClose: 447.00, change: 3.00, changePercent: 0.67, rsi: 58, ma20: 448.00, ma50: 445.00, ma50Slope: 0, volume: 3000000, volumeAvg: 3200000, status: "neutral", signals: ["above_ma20"] }],
    ["QQQ", { ticker: "QQQ", price: 674.15, previousClose: 670.00, change: 4.15, changePercent: 0.62, rsi: 60, ma20: 668.00, ma50: 660.00, ma50Slope: 0, volume: 45000000, volumeAvg: 42000000, status: "bull", signals: ["above_ma20"] }],
    ["SMH", { ticker: "SMH", price: 522.69, previousClose: 515.00, change: 7.69, changePercent: 1.49, rsi: 58, ma20: 520.00, ma50: 515.00, ma50Slope: 0, volume: 8500000, volumeAvg: 9000000, status: "bull", signals: ["above_ma20"] }],
    ["SCHG", { ticker: "SCHG", price: 33.14, previousClose: 32.90, change: 0.24, changePercent: 0.73, rsi: 56, ma20: 33.00, ma50: 32.50, ma50Slope: 0, volume: 3200000, volumeAvg: 3000000, status: "bull", signals: ["above_ma20"] }],
    ["VXUS", { ticker: "VXUS", price: 82.97, previousClose: 82.00, change: 0.97, changePercent: 1.18, rsi: 54, ma20: 82.00, ma50: 81.00, ma50Slope: 0, volume: 4500000, volumeAvg: 4200000, status: "bull", signals: ["above_ma20"] }],
    ["SCHD", { ticker: "SCHD", price: 31.86, previousClose: 31.50, change: 0.36, changePercent: 1.14, rsi: 57, ma20: 31.50, ma50: 31.00, ma50Slope: 0, volume: 5200000, volumeAvg: 5000000, status: "bull", signals: ["above_ma20"] }],
    ["SPYD", { ticker: "SPYD", price: 45.00, previousClose: 44.50, change: 0.50, changePercent: 1.12, rsi: 53, ma20: 44.80, ma50: 44.20, ma50Slope: 0, volume: 400000, volumeAvg: 380000, status: "bull", signals: ["above_ma20"] }],
    ["ASTS", { ticker: "ASTS", price: 10.00, previousClose: 11.00, change: -1.00, changePercent: -9.09, rsi: 38, ma20: 11.50, ma50: 12.00, ma50Slope: 0, volume: 1500000, volumeAvg: 1200000, status: "bear", signals: ["below_ma20", "rsi_oversold"] }],
  ];
  for (const [ticker, data] of tickers) quotes.set(ticker, data);
  return quotes;
}

export function getMockHoldings(): Map<string, number> {
  const holdings = new Map<string, number>();
  const entries: Array<[string, number]> = [
    ["VTI", 34], ["NVDA", 41.6], ["VOO", 17.1], ["QQQ", 9.4], ["SMH", 8.1],
    ["SCHG", 102.4], ["VXUS", 29.7], ["SCHD", 75.2], ["SPYD", 3.7], ["ASTS", 8.7],
  ];
  for (const [ticker, shares] of entries) holdings.set(ticker, shares);
  return holdings;
}
