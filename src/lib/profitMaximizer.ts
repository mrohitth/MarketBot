import { ProfitMaximizerIdea, MarketData } from "./types";

/**
 * Semi/Tech sector tickers to scan for Profit Maximizer
 * Focused on high-probability setups near NVDA/SMH ecosystem
 */
const SECTOR_TICKERS = [
  "AMD",    // Competitor to NVDA
  "TSM",    // TSMC - chip manufacturer
  "ASML",   // Chip equipment maker
  "INTC",   // Intel - possible turnaround play
  "QCOM",   // Qualcomm - mobile chip
  "AMAT",   // Applied Materials - chip equipment
  "LRCX",   // Lam Research - chip equipment
  "MU",     // Micron - memory
  "SOXX",   // SOXX ETF - semiconductor index
  "SMH",    // Already in portfolio, but check for setup
];

/**
 * Check for high-probability RSI oversold bounce setup
 */
function checkRSIOversold(quote: MarketData): ProfitMaximizerIdea | null {
  if (quote.rsi >= 30 && quote.rsi <= 45) {
    // Oversold bounce zone
    const potentialGain = quote.ma20 > quote.price ? ((quote.ma20 - quote.price) / quote.price) * 100 : 5;
    
    return {
      ticker: quote.ticker,
      setup: "RSI Oversold Bounce",
      entryPrice: quote.price,
      targetPrice: quote.price * (1 + potentialGain / 100),
      stopLoss: quote.price * 0.95, // 5% stop
      riskReward: potentialGain / 5, // Risk 5% to make potentialGain
      confidence: quote.rsi < 35 ? "high" : "medium",
      catalyst: `RSI at ${quote.rsi.toFixed(1)} — historically leads to bounce`,
    };
  }
  return null;
}

/**
 * Check for breakout setup (breaking MA20 with volume)
 */
function checkBreakout(quote: MarketData): ProfitMaximizerIdea | null {
  if (quote.price > quote.ma20 && quote.volume > quote.volumeAvg * 1.5) {
    const potentialGain = ((quote.ma50 - quote.price) / quote.price) * 100;
    
    return {
      ticker: quote.ticker,
      setup: "Breaking MA20 with Volume",
      entryPrice: quote.price,
      targetPrice: quote.ma50,
      stopLoss: quote.ma20 * 0.97, // 3% stop below MA20
      riskReward: potentialGain / 3,
      confidence: quote.volume > quote.volumeAvg * 2 ? "high" : "medium",
      catalyst: `${quote.volume.toLocaleString()} shares — ${((quote.volume / quote.volumeAvg) * 100).toFixed(0)}% of avg volume`,
    };
  }
  return null;
}

/**
 * Main sector scanner — returns top 3 setups
 */
export async function scanSector(quotes: Map<string, MarketData>): Promise<ProfitMaximizerIdea[]> {
  const ideas: ProfitMaximizerIdea[] = [];

  for (const [ticker, quote] of quotes) {
    if (ticker === "NVDA" || ticker === "SCHG") continue; // Skip core holdings

    // Check for RSI oversold
    const rsiIdea = checkRSIOversold(quote);
    if (rsiIdea) {
      ideas.push(rsiIdea);
      continue; // Only one setup per ticker
    }

    // Check for breakout
    const breakoutIdea = checkBreakout(quote);
    if (breakoutIdea) {
      ideas.push(breakoutIdea);
    }
  }

  // Sort by confidence and risk/reward, take top 3
  return ideas
    .sort((a, b) => {
      const confidenceOrder = { high: 0, medium: 1, low: 2 };
      const confDiff = confidenceOrder[a.confidence] - confidenceOrder[b.confidence];
      if (confDiff !== 0) return confDiff;
      return b.riskReward - a.riskReward;
    })
    .slice(0, 3);
}

/**
 * Format Profit Maximizer ideas for WhatsApp
 */
export function formatProfitMaximizerForBrief(ideas: ProfitMaximizerIdea[]): string {
  if (ideas.length === 0) {
    return `🚀 *PROFIT MAXIMIZER*\nNo high-probability setups today.`;
  }

  let output = `🚀 *PROFIT MAXIMIZER*\n`;
  output += `Top ${ideas.length} sector setups:\n\n`;

  for (const idea of ideas) {
    const confEmoji = idea.confidence === "high" ? "🟢" : "🟡";
    const rr = idea.riskReward.toFixed(1);
    
    output += `${confEmoji} *${idea.ticker}* — ${idea.setup}\n`;
    output += `   Entry: $${idea.entryPrice.toFixed(2)} | Target: $${idea.targetPrice.toFixed(2)} | Stop: $${idea.stopLoss.toFixed(2)}\n`;
    output += `   R/R: ${rr}:1 | ${idea.catalyst}\n\n`;
  }

  output += `\n_All setups flagged for decision — no auto-execution._`;
  
  return output;
}

// === Mock Data for Testing ===

export function getMockSectorQuotes(): Map<string, MarketData> {
  const quotes = new Map<string, MarketData>();

  // AMD: RSI oversold, potential bounce
  quotes.set("AMD", {
    ticker: "AMD",
    price: 165.50,
    previousClose: 168.00,
    change: -2.50,
    changePercent: -1.49,
    rsi: 32, // Oversold
    ma20: 172.00,
    ma50: 175.00,
    volume: 55000000,
    volumeAvg: 45000000,
    status: "bear",
    signals: ["rsi_oversold", "below_ma20"],
  });

  // TSM: Breaking MA20 with volume
  quotes.set("TSM", {
    ticker: "TSM",
    price: 148.75,
    previousClose: 145.00,
    change: 3.75,
    changePercent: 2.59,
    rsi: 58,
    ma20: 147.50,
    ma50: 150.00,
    volume: 25000000,
    volumeAvg: 18000000,
    status: "bull",
    signals: ["above_ma20", "volume_spike"],
  });

  // ASML: Just neutral, no setup
  quotes.set("ASML", {
    ticker: "ASML",
    price: 890.00,
    previousClose: 885.00,
    change: 5.00,
    changePercent: 0.56,
    rsi: 55,
    ma20: 880.00,
    ma50: 870.00,
    volume: 800000,
    volumeAvg: 900000,
    status: "neutral",
    signals: ["above_ma20", "above_ma50"],
  });

  // SOXX: Breaking out
  quotes.set("SOXX", {
    ticker: "SOXX",
    price: 215.60,
    previousClose: 208.00,
    change: 7.60,
    changePercent: 3.65,
    rsi: 62,
    ma20: 210.00,
    ma50: 205.00,
    volume: 4500000,
    volumeAvg: 2800000,
    status: "bull",
    signals: ["breakout_ma20", "volume_spike"],
  });

  return quotes;
}