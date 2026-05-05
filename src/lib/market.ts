import { MarketData, Position, PortfolioTargets, DriftThresholds, TradeRecommendation, TICKERS, MACRO_TICKERS, SECTOR_TICKERS } from "./types";

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
    const rsi = 50;
    const ma20 = result.fiftyDayAverage ?? price;
    const ma50 = result.twoHundredDayAverage ?? price;

    let status: "bull" | "bear" | "neutral" = "neutral";
    if (changePercent > 1) status = "bull";
    else if (changePercent < -1) status = "bear";

    const signals: string[] = [];
    if (price > ma20) signals.push("above_ma20");
    if (price < ma20) signals.push("below_ma20");
    if (price > ma50) signals.push("above_ma50");
    if (price < ma50) signals.push("below_ma50");
    if (volume > volumeAvg * 1.5) signals.push("volume_spike");
    if (rsi < 30) signals.push("rsi_oversold");
    else if (rsi > 70) signals.push("rsi_overbought");

    return {
      ticker,
      price,
      previousClose: prevClose,
      change,
      changePercent,
      rsi,
      ma20,
      ma50,
      volume,
      volumeAvg,
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
  holdings: Map<string, number>,
  targets: PortfolioTargets,
  thresholds: DriftThresholds
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
    const targetKey = ticker as keyof PortfolioTargets;
    const targetWeight = targets[targetKey] || 0.05;
    const currentWeight = marketValue / totalValue;
    const drift = targetWeight > 0 ? ((currentWeight - targetWeight) / targetWeight) * 100 : 0;

    const thresholdKey = ticker as keyof DriftThresholds;
    const driftThreshold = thresholds[thresholdKey] || 5;

    let status: "on-target" | "drifted" | "black-swan" = "on-target";
    if (Math.abs(quote.changePercent) > 8) status = "black-swan";
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
    });
  }

  return positions;
}

export function generateRebalanceRecommendations(positions: Position[]): TradeRecommendation[] {
  const recommendations: TradeRecommendation[] = [];

  for (const pos of positions) {
    if (pos.status === "drifted") {
      const action = pos.drift > 0 ? "SELL" : "BUY";
      const sharesToMove = Math.floor(Math.abs(pos.drift) * 0.5);
      recommendations.push({
        action,
        ticker: pos.ticker,
        shares: sharesToMove > 0 ? sharesToMove : undefined,
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
        reason: `Black swan: ${pos.ticker} ${pos.dayChangePercent.toFixed(1)}%. Confirm before action.`,
        confidence: "high",
        requiresConfirmation: true,
        type: "black-swan",
      });
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
    output += `${statusEmoji} ${pos.ticker}: $${pos.marketValue.toFixed(0)} (${pos.weight.toFixed(1)}%) 📉 ${driftSign}${pos.drift.toFixed(1)}% | $${pos.currentPrice.toFixed(2)}\n`;
  }

  return output;
}

// === Mock Data ===

export function getMockQuotes(): Map<string, MarketData> {
  const quotes = new Map<string, MarketData>();
  const tickers: Array<[string, MarketData]> = [
    ["VTI", { ticker: "VTI", price: 260.00, previousClose: 257.00, change: 3.00, changePercent: 1.17, rsi: 55, ma20: 258.00, ma50: 255.00, volume: 3000000, volumeAvg: 2800000, status: "bull", signals: ["above_ma20"] }],
    ["NVDA", { ticker: "NVDA", price: 198.45, previousClose: 202.00, change: -3.55, changePercent: -1.76, rsi: 52, ma20: 205.00, ma50: 210.00, volume: 42000000, volumeAvg: 40000000, status: "bear", signals: ["below_ma20", "below_ma50"] }],
    ["VOO", { ticker: "VOO", price: 450.00, previousClose: 447.00, change: 3.00, changePercent: 0.67, rsi: 58, ma20: 448.00, ma50: 445.00, volume: 3000000, volumeAvg: 3200000, status: "neutral", signals: ["above_ma20"] }],
    ["QQQ", { ticker: "QQQ", price: 674.15, previousClose: 670.00, change: 4.15, changePercent: 0.62, rsi: 60, ma20: 668.00, ma50: 660.00, volume: 45000000, volumeAvg: 42000000, status: "bull", signals: ["above_ma20"] }],
    ["SMH", { ticker: "SMH", price: 522.69, previousClose: 515.00, change: 7.69, changePercent: 1.49, rsi: 58, ma20: 520.00, ma50: 515.00, volume: 8500000, volumeAvg: 9000000, status: "bull", signals: ["above_ma20"] }],
    ["SCHG", { ticker: "SCHG", price: 33.14, previousClose: 32.90, change: 0.24, changePercent: 0.73, rsi: 56, ma20: 33.00, ma50: 32.50, volume: 3200000, volumeAvg: 3000000, status: "bull", signals: ["above_ma20"] }],
    ["VXUS", { ticker: "VXUS", price: 82.97, previousClose: 82.00, change: 0.97, changePercent: 1.18, rsi: 54, ma20: 82.00, ma50: 81.00, volume: 4500000, volumeAvg: 4200000, status: "bull", signals: ["above_ma20"] }],
    ["SCHD", { ticker: "SCHD", price: 31.86, previousClose: 31.50, change: 0.36, changePercent: 1.14, rsi: 57, ma20: 31.50, ma50: 31.00, volume: 5200000, volumeAvg: 5000000, status: "bull", signals: ["above_ma20"] }],
    ["SPYD", { ticker: "SPYD", price: 45.00, previousClose: 44.50, change: 0.50, changePercent: 1.12, rsi: 53, ma20: 44.80, ma50: 44.20, volume: 400000, volumeAvg: 380000, status: "bull", signals: ["above_ma20"] }],
    ["ASTS", { ticker: "ASTS", price: 10.00, previousClose: 11.00, change: -1.00, changePercent: -9.09, rsi: 38, ma20: 11.50, ma50: 12.00, volume: 1500000, volumeAvg: 1200000, status: "bear", signals: ["below_ma20", "rsi_oversold"] }],
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
