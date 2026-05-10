import { ProfitMaximizerIdea, MarketData, SECTOR_TICKERS } from "./types";

/**
 * Check for RSI oversold bounce setup (RSI 30-45)
 */
function checkRSIOversold(quote: MarketData): ProfitMaximizerIdea | null {
  if (quote.rsi >= 30 && quote.rsi <= 45) {
    const potentialGain = quote.ma20 > quote.price ? ((quote.ma20 - quote.price) / quote.price) * 100 : 5;
    return {
      ticker: quote.ticker,
      setup: "RSI Oversold Bounce",
      entryPrice: quote.price,
      targetPrice: quote.price * (1 + potentialGain / 100),
      stopLoss: quote.price * 0.95,
      riskReward: potentialGain / 5,
      confidence: quote.rsi < 35 ? "high" : "medium",
      catalyst: `RSI at ${quote.rsi.toFixed(1)} — historically leads to bounce`,
    };
  }
  return null;
}

/**
 * Check for breakout setup (price > MA20 with volume confirmation)
 */
function checkBreakout(quote: MarketData): ProfitMaximizerIdea | null {
  if (quote.price > quote.ma20 && quote.volume > quote.volumeAvg * 1.5) {
    const potentialGain = quote.ma50 > quote.price ? ((quote.ma50 - quote.price) / quote.price) * 100 : 3;
    return {
      ticker: quote.ticker,
      setup: "Breaking MA20 with Volume",
      entryPrice: quote.price,
      targetPrice: quote.ma50 || quote.price * 1.03,
      stopLoss: quote.ma20 * 0.97,
      riskReward: potentialGain / 3,
      confidence: quote.volume > quote.volumeAvg * 2 ? "high" : "medium",
      catalyst: `${(quote.volume / quote.volumeAvg * 100).toFixed(0)}% of avg volume`,
    };
  }
  return null;
}

/**
 * Check for MA50 pullback setup (reclaiming 50-day MA after being below)
 */
function checkMA50Reclaim(quote: MarketData): ProfitMaximizerIdea | null {
  const priceChangedSignificantly = Math.abs(quote.changePercent) > 2;
  const nearMA50 = quote.ma50 && Math.abs(quote.price - quote.ma50) / quote.ma50 < 0.03;
  if (priceChangedSignificantly && nearMA50 && quote.status === "bull") {
    return {
      ticker: quote.ticker,
      setup: "MA50 Reclaim",
      entryPrice: quote.price,
      targetPrice: quote.ma50 * 1.05,
      stopLoss: quote.price * 0.97,
      riskReward: 3,
      confidence: "medium",
      catalyst: `Reclaimed ${((quote.volume / quote.volumeAvg) * 100).toFixed(0)}% avg volume today`,
    };
  }
  return null;
}

/**
 * Scan sector for all setups from live quotes
 * Now works with real market data (not mock) via getSectorQuotes()
 */
export async function scanSector(liveQuotes: Map<string, MarketData>): Promise<ProfitMaximizerIdea[]> {
  const ideas: ProfitMaximizerIdea[] = [];

  for (const [ticker, quote] of liveQuotes) {
    // RSI oversold bounce
    const rsiIdea = checkRSIOversold(quote);
    if (rsiIdea) { ideas.push(rsiIdea); continue; }

    // Breakout with volume
    const breakoutIdea = checkBreakout(quote);
    if (breakoutIdea) { ideas.push(breakoutIdea); continue; }

    // MA50 reclaim
    const ma50Idea = checkMA50Reclaim(quote);
    if (ma50Idea) { ideas.push(ma50Idea); }
  }

  return ideas
    .sort((a, b) => {
      const conf = { high: 0, medium: 1, low: 2 };
      const d = conf[a.confidence] - conf[b.confidence];
      return d !== 0 ? d : b.riskReward - a.riskReward;
    })
    .slice(0, 5);
}

export function formatProfitMaximizerForBrief(ideas: ProfitMaximizerIdea[]): string {
  if (ideas.length === 0) {
    return `🚀 *PROFIT MAXIMIZER*\nNo high-probability setups today.`;
  }

  let output = `🚀 *PROFIT MAXIMIZER*\n`;
  output += `Top ${ideas.length} sector setups:\n\n`;

  for (const idea of ideas) {
    const confEmoji = idea.confidence === "high" ? "🟢" : "🟡";
    output += `${confEmoji} *${idea.ticker}* — ${idea.setup}\n`;
    output += `   Entry: $${idea.entryPrice.toFixed(2)} | Target: $${idea.targetPrice.toFixed(2)} | Stop: $${idea.stopLoss.toFixed(2)}\n`;
    output += `   R/R: ${idea.riskReward.toFixed(1)}:1 | ${idea.catalyst}\n\n`;
  }

  output += `_All setups flagged for decision — no auto-execution._`;
  return output;
}

// === Mock Data ===

export function getMockSectorQuotes(): Map<string, MarketData> {
  const quotes = new Map<string, MarketData>();
  const data: Array<[string, MarketData]> = [
    ["AMD", { ticker: "AMD", price: 165.50, previousClose: 168.00, change: -2.50, changePercent: -1.49, rsi: 32, ma20: 172.00, ma50: 175.00, ma50Slope: 0, volume: 55000000, volumeAvg: 45000000, status: "bear", signals: ["rsi_oversold", "below_ma20"] }],
    ["TSM", { ticker: "TSM", price: 148.75, previousClose: 145.00, change: 3.75, changePercent: 2.59, rsi: 58, ma20: 147.50, ma50: 150.00, ma50Slope: 0, volume: 25000000, volumeAvg: 18000000, status: "bull", signals: ["above_ma20", "volume_spike"] }],
    ["ASML", { ticker: "ASML", price: 890.00, previousClose: 885.00, change: 5.00, changePercent: 0.56, rsi: 55, ma20: 880.00, ma50: 870.00, ma50Slope: 0, volume: 800000, volumeAvg: 900000, status: "neutral", signals: ["above_ma20"] }],
    ["SOXX", { ticker: "SOXX", price: 215.60, previousClose: 208.00, change: 7.60, changePercent: 3.65, rsi: 62, ma20: 210.00, ma50: 205.00, ma50Slope: 0, volume: 4500000, volumeAvg: 2800000, status: "bull", signals: ["breakout_ma20", "volume_spike"] }],
    ["AVGO", { ticker: "AVGO", price: 1450.00, previousClose: 1440.00, change: 10.00, changePercent: 0.69, rsi: 58, ma20: 1440.00, ma50: 1420.00, ma50Slope: 0, volume: 2000000, volumeAvg: 2100000, status: "bull", signals: ["above_ma20"] }],
    ["MU", { ticker: "MU", price: 95.50, previousClose: 93.00, change: 2.50, changePercent: 2.69, rsi: 48, ma20: 94.00, ma50: 96.00, ma50Slope: 0, volume: 18000000, volumeAvg: 15000000, status: "bull", signals: ["above_ma20", "volume_spike"] }],
  ];
  for (const [t, d] of data) quotes.set(t, d);
  return quotes;
}
