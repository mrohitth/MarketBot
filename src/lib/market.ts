import { MarketData, Position, PortfolioTargets, DriftThresholds, AlphaVantageQuoteResponse, TradeRecommendation } from "./types";

const ALPHA_VANTAGE_BASE = "https://www.alphavantage.co/query";
const GLOBAL_QUOTE_ENDPOINT = "GLOBAL_QUOTE";
const RSI_ENDPOINT = "RSI";

/**
 * Fetch real-time quote from Alpha Vantage
 */
export async function getQuote(symbol: string, apiKey: string): Promise<MarketData | null> {
  const url = `${ALPHA_VANTAGE_BASE}?function=${GLOBAL_QUOTE_ENDPOINT}&symbol=${symbol}&apikey=${apiKey}`;
  
  try {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    
    const data = await res.json() as AlphaVantageQuoteResponse;
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
      rsi: 50, // Will be populated by getRSI()
      ma20: price, // Placeholder until we calculate from historical
      ma50: price,
      volume: parseInt(quote["06. volume"]),
      volumeAvg: parseInt(quote["06. volume"]), // Placeholder
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
    
    const data = await res.json() as { "Technical Analysis: RSI": { data: Array<{ date: string; RSI: string }> } };
    const rsiData = data["Technical Analysis: RSI"];
    
    if (!rsiData || !rsiData["data"] || rsiData["data"].length === 0) {
      return null;
    }

    // Get most recent RSI value
    const latest = rsiData["data"][0];
    return parseFloat(latest["RSI"]);
  } catch (error) {
    console.error(`[MARKET] Failed to fetch RSI for ${symbol}:`, error);
    return null;
  }
}

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

  // First pass: calculate total portfolio value
  for (const [ticker, shares] of holdings) {
    const quote = quotes.get(ticker);
    if (!quote) continue;
    totalValue += quote.price * shares;
  }

  // Add cash position
  const cashPosition = 85000 * 0.1; // Placeholder 10% cash
  totalValue += cashPosition;

  // Second pass: calculate weights and drift
  for (const [ticker, shares] of holdings) {
    const quote = quotes.get(ticker);
    if (!quote) continue;

    const marketValue = quote.price * shares;
    const targetKey = ticker as keyof PortfolioTargets;
    const targetWeight = targets[targetKey] || 0.1; // 10% default
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
      avgCost: 0, // Would come from positions.csv
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
      const sharesToMove = Math.floor(Math.abs(pos.drift) * 0.5); // Move half the drift

      recommendations.push({
        action,
        ticker: pos.ticker,
        shares: sharesToMove,
        reason: `${pos.ticker} drifted ${pos.drift.toFixed(1)}% from target (${pos.targetWeight.toFixed(0)}%)`,
        confidence: "medium",
        requiresConfirmation: false, // Drift doesn't need confirmation
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
  const tickers = ["NVDA", "SMH", "SCHG"];
  let output = `📈 *MARKET SUMMARY*\n`;
  
  let biggestMover = { ticker: "", change: 0 };
  
  for (const ticker of tickers) {
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
    price: 120.50, // Down ~5% from ~127
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
    price: 178.25, // Down ~3%
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
    price: 94.80, // Flat
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
  holdings.set("NVDA", 100);  // ~40% of portfolio
  holdings.set("SMH", 75);    // ~30%
  holdings.set("SCHG", 50);    // ~20%
  return holdings;
}

export const MOCK_TARGETS: PortfolioTargets = {
  NVDA: 0.40,
  SMH: 0.30,
  SCHG: 0.20,
  CASH: 0.10,
};

export const MOCK_DRIFT_THRESHOLDS: DriftThresholds = {
  NVDA: 7, // 7% drift triggers rebalance
  SMH: 7,
  SCHG: 5,
};