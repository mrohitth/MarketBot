/**
 * research_pipeline.ts  - Comprehensive multi-factor research scanner.
 *
 * Inspired by virattt/ai-hedge-fund's multi-analyst architecture, but implemented
 * as a pure algorithmic pipeline (no LLM inference at runtime) that feeds into
 * the existing advisor engine.
 *
 * Research dimensions (each is a "signal layer"):
 *   1. TECHNICAL      - RSI, MACD, Bollinger Bands, support/resistance, volume
 *   2. FUNDAMENTAL    - P/E, EPS growth, revenue growth, profit margins, forward guidance
 *   3. SENTIMENT      - Finnhub headlines, analyst consensus, price target vs current
 *   4. OPTIONS FLOW   - Put/call ratio, unusual call volume, ITM strikes, short interest proxy
 *   5. RELATIVE STRENGTH  - Sector rotation, mega-cap tech vs SPY, bond yields vs equities
 *   6. MACRO REGIME   - DXY, TLT, gold, credit spreads  - cross-asset confirmation
 *
 * Each dimension produces a score (-20 to +20) that gets combined into a final
 * composite conviction score. Strongest signals bubble to the top.
 */

import { MarketData } from "./types";

// ── RSI Helper (re-exported from market.ts) ───────────────────────────────────

export function computeRSI(closes: number[], period = 14): number[] {
  const rsi: number[] = [];
  if (closes.length < period + 1) return closes.map(() => 50);
  let avgGain = 0, avgLoss = 0;
  for (let i = 1; i <= period; i++) {
    const ch = closes[i] - closes[i - 1];
    if (ch > 0) avgGain += ch; else avgLoss += Math.abs(ch);
  }
  avgGain /= period; avgLoss /= period;
  for (let i = 0; i < period; i++) rsi.push(50);
  for (let i = period; i < closes.length; i++) {
    if (avgLoss === 0) { rsi.push(100); }
    else {
      const rs = avgGain / avgLoss;
      rsi.push(100 - 100 / (1 + rs));
    }
    const nc = closes[i + 1] - closes[i];
    avgGain = (avgGain * (period - 1) + (nc > 0 ? nc : 0)) / period;
    avgLoss = (avgLoss * (period - 1) + (nc < 0 ? Math.abs(nc) : 0)) / period;
  }
  return rsi;
}

export function computeSMA(arr: number[], period: number): number[] {
  const sma: number[] = [];
  for (let i = 0; i < arr.length; i++) {
    if (i < period - 1) { sma.push(arr[i]); continue; }
    sma.push(arr.slice(i - period + 1, i + 1).reduce((a, b) => a + b, 0) / period);
  }
  return sma;
}

// ── Types ─────────────────────────────────────────────────────────────────────

export interface ResearchSignal {
  dimension: "TECHNICAL" | "FUNDAMENTAL" | "SENTIMENT" | "OPTIONS" | "RELATIVE_STRENGTH" | "MACRO";
  score: number;        // -20 to +20
  evidence: string[];  // human-readable signals that drove this score
  weight: number;      // 1-3 (higher = more weight in composite)
}

export interface TickerResearch {
  ticker: string;
  price: number;
  changePercent: number;
  compositeScore: number;          // weighted sum of all signals, -100 to +100
  signals: ResearchSignal[];
  verdict: "BUY" | "WATCH" | "AVOID";
  verdictReason: string;
  /** Raw live data for display */
  rsi: number;
  sectorRSI?: number;    // relative strength vs sector
  analystTarget?: number;
  analystRating?: string;
  optionsSentiment?: number;  // put/call ratio proxy
  shortProxy?: number;       // vol/avgVol ratio proxy
  macroRegime?: "risk-on" | "risk-off" | "mixed";
}

export interface OpportunityDiscovery {
  ticker: string;
  category: "momentum" | "value" | "sector-rotation" | "breakout" | "oversold-bounce";
  score: number;
  thesis: string;
  riskFactors: string[];
  positionSize: "small" | "medium" | "large";
  holdHorizon: "intraday" | "swing" | "core";
}

// ── Signal Scorers ───────────────────────────────────────────────────────────

/**
 * Technical signal layer: RSI zone, trend strength, volume, Bollinger Band position.
 */
export function scoreTechnical(
  rsi: number,
  price: number,
  ma20: number,
  ma50: number,
  volume: number,
  volumeAvg: number,
  changePercent: number
): ResearchSignal {
  const evidence: string[] = [];
  let score = 0;
  const weight = 3; // Technical has highest weight  - directly actionable

  // RSI zone
  if (rsi <= 30) {
    score += 20; evidence.push(`RSI deeply oversold (${rsi.toFixed(1)})  - bounce probability high`);
  } else if (rsi <= 42) {
    score += 13; evidence.push(`RSI oversold zone (${rsi.toFixed(1)})  - mean-reversion setup`);
  } else if (rsi <= 50) {
    score += 5; evidence.push(`RSI below 50 (${rsi.toFixed(1)})  - bearish regime, caution`);
  } else if (rsi >= 70) {
    score -= 15; evidence.push(`RSI overbought (${rsi.toFixed(1)})  - pullback risk elevated`);
  } else if (rsi >= 60) {
    score -= 5; evidence.push(`RSI above 60 (${rsi.toFixed(1)})  - extended but still bullish`);
  }

  // Trend alignment
  if (price > ma20 && price > ma50) {
    score += 8; evidence.push(`Golden setup: price > MA20 ($${ma20.toFixed(2)}) > MA50 ($${ma50.toFixed(2)})`);
  } else if (price > ma20) {
    score += 4; evidence.push(`Above 20-day MA  - short-term uptrend`);
  } else if (price > ma50) {
    score += 2; evidence.push(`Below MA20 but above MA50  - intermediate uptrend intact`);
  } else {
    score -= 8; evidence.push(`Below both MA20 and MA50  - downtrend, avoid long`);
  }

  // Volume confirmation
  const volRatio = volumeAvg > 0 ? volume / volumeAvg : 1;
  if (volRatio >= 2.0) {
    score += 6; evidence.push(`Volume ${(volRatio * 100).toFixed(0)}% of average  - institutional conviction`);
  } else if (volRatio >= 1.5) {
    score += 3; evidence.push(`Volume ${(volRatio * 100).toFixed(0)}% of average  - confirming move`);
  }

  // Intraday pullback in uptrend = better entry
  if (changePercent < -2 && price > ma20) {
    score += 5; evidence.push(`${Math.abs(changePercent).toFixed(1)}% dip with uptrend intact  - better entry`);
  } else if (changePercent < -3 && price > ma50) {
    score += 3; evidence.push(`${Math.abs(changePercent).toFixed(1)}% intraday drop  - oversold bounce candidate`);
  }

  return { dimension: "TECHNICAL", score: Math.max(-20, Math.min(20, score)), evidence, weight };
}

/**
 * Options flow signal layer  - proxies put/call ratio and unusual volume.
 * Falls back to vol/avgVol as short interest proxy when options data unavailable.
 */
export function scoreOptionsFlow(
  ticker: string,
  optionsData: { calls?: any[]; puts?: any[] } | null,
  volume: number,
  volumeAvg: number
): ResearchSignal {
  const evidence: string[] = [];
  let score = 0;
  const weight = 2;

  if (optionsData != null && (optionsData.calls?.length ?? 0) > 0) {
    // Put/Call ratio analysis
    const calls = (optionsData?.calls ?? []).slice(0, 10);
    const puts = optionsData.puts?.slice(0, 10) ?? [];
    const callVol = calls.reduce((s, c) => s + (c.volume ?? 0), 0);
    const putVol = puts.reduce((s, p) => s + (p.volume ?? 0), 0);
    const pcRatio = putVol > 0 ? callVol / putVol : 1;

    // Bullish signal: more call volume than put volume (call buyers = optimism)
    if (pcRatio >= 1.5) {
      score += 10; evidence.push(`P/C ratio ${pcRatio.toFixed(2)}  - bullish options flow (call volume dominant)`);
    } else if (pcRatio >= 1.0) {
      score += 3; evidence.push(`P/C ratio ${pcRatio.toFixed(2)}  - balanced/slightly bullish`);
    } else if (pcRatio < 0.6) {
      score -= 10; evidence.push(`P/C ratio ${pcRatio.toFixed(2)}  - bearish options structure`);
    }

    // ITM calls = bullish positioning
    const itmCalls = calls.filter(c => {
      const spot = calls[0]?.lastPrice ?? 0;
      return (c.strike ?? 0) < spot * 1.05; // within 5% above spot = aggressive bullish
    });
    if (itmCalls.length >= 3) {
      score += 5; evidence.push(`${itmCalls.length} ITM/near-ITM calls  - smart money positioning`);
    }

    // Unusual call activity (high open interest + volume)
    const hotCalls = calls.filter(c => (c.volume ?? 0) > 500 && (c.openInterest ?? 0) > 1000);
    if (hotCalls.length >= 2) {
      score += 3; evidence.push(`${hotCalls.length} high-oi call contracts  - bullish institutional positioning`);
    }
  } else {
    // Fallback: vol/avgVol as short squeeze / distress proxy
    const volRatio = volumeAvg > 0 ? volume / volumeAvg : 1;
    if (volRatio >= 3.0) {
      score -= 8; evidence.push(`Volume ${volRatio.toFixed(1)}x avg  - possible short squeeze or news event`);
    } else if (volRatio <= 0.4) {
      score -= 3; evidence.push(`Volume only ${(volRatio*100).toFixed(0)}% of avg  - no institutional interest`);
    }
  }

  return { dimension: "OPTIONS", score: Math.max(-20, Math.min(20, score)), evidence, weight };
}

/**
 * Relative strength vs sector and mega-cap benchmark.
 * Cross-asset confirmation for regime-aware positioning.
 */
export function scoreRelativeStrength(
  tickerChange: number,
  sectorETFChanges: Record<string, number>,
  macroChanges: Record<string, number>,
  tickerIsInPortfolio: boolean
): ResearchSignal {
  const evidence: string[] = [];
  let score = 0;
  const weight = 2;

  // Find best/worst sector today
  const sortedSectors = Object.entries(sectorETFChanges).sort((a, b) => b[1] - a[1]);
  const bestSector = sortedSectors[0];
  const worstSector = sortedSectors[sortedSectors.length - 1];

  // Relative to best sector
  const sectorRSI = tickerChange - bestSector[1];
  if (sectorRSI > 2) {
    score += 10; evidence.push(`Outperforming best sector (${bestSector[0]}) by ${sectorRSI.toFixed(1)}%  - leadership confirmed`);
  } else if (sectorRSI > 0) {
    score += 4; evidence.push(`Outperforming sector average by ${sectorRSI.toFixed(1)}%`);
  } else if (sectorRSI < -3) {
    score -= 8; evidence.push(`Lagging sector by ${Math.abs(sectorRSI).toFixed(1)}%  - leadership failing`);
  }

  // Macro cross-asset confirmation
  const spyChange = sectorETFChanges["SPY"] ?? 0;
  const vsSpy = tickerChange - spyChange;
  if (vsSpy > 3) {
    score += 8; evidence.push(`Outperforming SPY by ${vsSpy.toFixed(1)}%  - strong alpha`);
  } else if (vsSpy > 1) {
    score += 3; evidence.push(`Outperforming SPY by ${vsSpy.toFixed(1)}%`);
  } else if (vsSpy < -3) {
    score -= 6; evidence.push(`Underperforming SPY by ${Math.abs(vsSpy).toFixed(1)}%  - weak`);
  }

  // Risk-off macro check: TLT and GLD behavior
  const tltChange = macroChanges["TLT"] ?? 0;
  const gldChange = macroChanges["GLD"] ?? 0;
  if (tltChange > 0.5 && gldChange > 0.3) {
    score -= 5; evidence.push(`Risk-off regime: TLT +${tltChange.toFixed(1)}%, GLD +${gldChange.toFixed(1)}%  - defensive posture`);
  } else if (tltChange < -1 && tickerChange > 1) {
    // Risk-on confirmation: rates selling off + equities rallying
    score += 4; evidence.push(`Risk-on: TLT ${tltChange.toFixed(1)}%,${tickerChange > 0 ? ' equities up  - risk-on confirmed' : ' risky assets down'}`);
  }

  // Portfolio tickers get a small boost (we own them for reasons)
  if (tickerIsInPortfolio && score > 0) {
    score += 2; evidence.push(`In portfolio  - existing conviction provides baseline support`);
  }

  return { dimension: "RELATIVE_STRENGTH", score: Math.max(-20, Math.min(20, score)), evidence, weight };
}

/**
 * Analyst sentiment: consensus rating, price target vs current price, # of analysts.
 * Uses Finnhub data if available, otherwise degrades gracefully.
 */
export function scoreAnalystSentiment(
  finnhubData: { score: number; label: string; headlines: string[] } | null,
  analystTargetPrice: number | null | undefined,
  analystCount: number | null | undefined,
  price: number,
  earningsGrowth: number | null | undefined,
  revenueGrowth: number | null | undefined
): ResearchSignal {
  const evidence: string[] = [];
  let score = 0;
  const weight = 2;

  // News sentiment from Finnhub
  if (finnhubData && finnhubData.headlines.length > 0) {
    if (finnhubData.score > 10) {
      score += 10; evidence.push(`Bullish news (score ${finnhubData.score}): ${finnhubData.headlines[0].slice(0, 80)}`);
    } else if (finnhubData.score > 5) {
      score += 5; evidence.push(`Mildly bullish news (score ${finnhubData.score})`);
    } else if (finnhubData.score < -10) {
      score -= 10; evidence.push(`Bearish news (score ${finnhubData.score}): ${finnhubData.headlines[0].slice(0, 80)}`);
    } else if (finnhubData.score < -5) {
      score -= 5; evidence.push(`Mildly bearish news (score ${finnhubData.score})`);
    }
  }

  // Price target vs current (upside potential)
  if (analystTargetPrice && analystTargetPrice > price) {
    const upside = ((analystTargetPrice - price) / price) * 100;
    if (upside >= 20) {
      score += 10; evidence.push(`Analyst target $${analystTargetPrice.toFixed(2)} = ${upside.toFixed(0)}% upside`);
    } else if (upside >= 10) {
      score += 6; evidence.push(`Analyst target $${analystTargetPrice.toFixed(2)} = ${upside.toFixed(0)}% upside`);
    } else if (upside >= 5) {
      score += 2; evidence.push(`Analyst target $${analystTargetPrice.toFixed(2)} = ${upside.toFixed(0)}% upside`);
    } else if (analystTargetPrice < price) {
      score -= 6; evidence.push(`Analyst target $${analystTargetPrice.toFixed(2)} below current  - potential downside`);
    }
  }

  // Analyst count = conviction signal
  if (analystCount && analystCount >= 20) {
    score += 4; evidence.push(`${analystCount} analysts covering  - high conviction signal`);
  } else if (analystCount && analystCount >= 10) {
    score += 2; evidence.push(`${analystCount} analysts covering`);
  }

  // Earnings growth
  if (earningsGrowth !== null && earningsGrowth !== undefined) {
    if (earningsGrowth > 0.5) {
      score += 6; evidence.push(`Earnings growth +${(earningsGrowth * 100).toFixed(0)}%  - strong fundamental momentum`);
    } else if (earningsGrowth > 0.2) {
      score += 3; evidence.push(`Earnings growth +${(earningsGrowth * 100).toFixed(0)}%`);
    } else if (earningsGrowth < -0.2) {
      score -= 6; evidence.push(`Earnings declining ${(earningsGrowth * 100).toFixed(0)}%  - fundamental concern`);
    }
  }

  // Revenue growth
  if (revenueGrowth !== null && revenueGrowth !== undefined) {
    if (revenueGrowth > 0.3) {
      score += 4; evidence.push(`Revenue growth +${(revenueGrowth * 100).toFixed(0)}%  - accelerating top line`);
    } else if (revenueGrowth > 0.1) {
      score += 1; evidence.push(`Revenue growth +${(revenueGrowth * 100).toFixed(0)}%`);
    }
  }

  return { dimension: "SENTIMENT", score: Math.max(-20, Math.min(20, score)), evidence, weight };
}

// ── Core Research Pipeline ────────────────────────────────────────────────────

export interface ResearchPipelineInput {
  ticker: string;
  price: number;
  changePercent: number;
  rsi: number;
  ma20: number;
  ma50: number;
  volume: number;
  volumeAvg: number;
  optionsData?: { calls?: any[]; puts?: any[] } | null;
  finnhubSentiment?: { score: number; label: string; headlines: string[] } | null;
  analystTargetPrice?: number | null;
  analystCount?: number | null;
  earningsGrowth?: number | null;
  revenueGrowth?: number | null;
  sectorETFChanges?: Record<string, number>;
  macroChanges?: Record<string, number>;
  isInPortfolio?: boolean;
}

export function runResearchPipeline(input: ResearchPipelineInput): TickerResearch {
  const {
    ticker, price, changePercent, rsi, ma20, ma50, volume, volumeAvg,
    optionsData, finnhubSentiment, analystTargetPrice, analystCount,
    earningsGrowth, revenueGrowth, sectorETFChanges, macroChanges, isInPortfolio
  } = input;

  const signals: ResearchSignal[] = [];

  // Layer 1: Technical
  signals.push(scoreTechnical(rsi, price, ma20, ma50, volume, volumeAvg, changePercent));

  // Layer 2: Options flow
  signals.push(scoreOptionsFlow(ticker, optionsData ?? null, volume, volumeAvg));

  // Layer 3: Relative strength
  signals.push(scoreRelativeStrength(
    changePercent,
    sectorETFChanges ?? {},
    macroChanges ?? {},
    isInPortfolio ?? false
  ));

  // Layer 4: Analyst/sentiment
  signals.push(scoreAnalystSentiment(
    finnhubSentiment ?? null,
    analystTargetPrice ?? undefined,
    analystCount ?? undefined,
    price,
    earningsGrowth ?? undefined,
    revenueGrowth ?? undefined
  ));

  // Compute weighted composite
  const totalWeight = signals.reduce((s, sig) => s + sig.weight, 0);
  const compositeScore = signals.reduce((s, sig) => s + (sig.score * sig.weight / totalWeight), 0);

  // Verdict
  let verdict: "BUY" | "WATCH" | "AVOID";
  let verdictReason: string;

  if (compositeScore >= 8) {
    verdict = "BUY";
    verdictReason = `Composite score ${compositeScore.toFixed(1)}/100  - strong multi-signal confirmation`;
  } else if (compositeScore >= 3) {
    verdict = "WATCH";
    verdictReason = `Composite score ${compositeScore.toFixed(1)}/100  - some signals positive, waiting for more confirmation`;
  } else {
    verdict = "AVOID";
    verdictReason = `Composite score ${compositeScore.toFixed(1)}/100  - multiple headwinds or neutral signals`;
  }

  // Check for strong opposing signals (e.g., technically oversold but macro risk-off = AVOID)
  const techSignal = signals.find(s => s.dimension === "TECHNICAL");
  const macroSignal = signals.find(s => s.dimension === "MACRO");
  if ((techSignal?.score ?? 0) > 10 && (macroSignal?.score ?? 0) < -5) {
    verdict = "AVOID";
    verdictReason = "Technical setup strong but macro risk-off  - skip signal";
  }

  return {
    ticker,
    price,
    changePercent,
    compositeScore,
    signals,
    verdict,
    verdictReason,
    rsi,
    shortProxy: volumeAvg > 0 ? volume / volumeAvg : 1,
  };
}

// ── New Opportunity Discovery ────────────────────────────────────────────────

/**
 * Screen a list of tickers and return ranked new opportunities.
 * Used to find new tickers NOT in the current portfolio that deserve consideration.
 */
export async function discoverOpportunities(
  candidateTickers: string[],
  sectorETFChanges: Record<string, number>,
  macroChanges: Record<string, number>,
  finnhubBatch: Map<string, { score: number; label: string; headlines: string[] }>,
  isInPortfolio: (t: string) => boolean
): Promise<OpportunityDiscovery[]> {
  // Lazy import to avoid circular deps  - yahoo-finance2 is ESM-only
  const yf = await import("yahoo-finance2").then(m => (m as any).default ?? m);
  const yahooFinance = new yf({ suppressNotices: ["yahooSurvey"] });

  const opportunities: OpportunityDiscovery[] = [];

  for (const ticker of candidateTickers) {
    try {
      // Fetch chart data (3mo daily) + quote
      const [chartResult, quoteResult] = await Promise.all([
        yahooFinance.chart(ticker, {
          period1: new Date(Date.now() - 90 * 24 * 60 * 60 * 1000).toISOString().split("T")[0],
          period2: new Date().toISOString().split("T")[0],
          interval: "1d",
        }),
        yahooFinance.quote(ticker),
      ]);

      const quotes = chartResult?.quotes ?? [];
      if (quotes.length < 30) continue;

      const closes = quotes.map((q: any) => q.close).filter((c: any): c is number => c != null);
      if (closes.length < 30) continue;

      const rsiValues = computeRSI(closes);
      const rsi = rsiValues[rsiValues.length - 1];
      const sma20 = computeSMA(closes, 20);
      const sma50 = computeSMA(closes, 50);
      const ma20 = sma20[sma20.length - 1];
      const ma50 = sma50[sma50.length - 1];
      const price = closes[closes.length - 1];
      const prevClose = closes[closes.length - 2];
      const changePct = prevClose > 0 ? ((price - prevClose) / prevClose) * 100 : 0;
      const volAvg = quotes.slice(-20).reduce((s: number, q: any) => s + (q.volume ?? 0), 0) / 20;
      const vol = quotes[quotes.length - 1].volume ?? 0;
      const sentiment = finnhubBatch.get(ticker);

      // Build research input
      const research = runResearchPipeline({
        ticker,
        price,
        changePercent: changePct,
        rsi,
        ma20,
        ma50,
        volume: vol,
        volumeAvg: volAvg,
        optionsData: null,
        finnhubSentiment: sentiment ?? null,
        sectorETFChanges,
        macroChanges,
        isInPortfolio: isInPortfolio(ticker),
      });

      // Skip if verdict is AVOID or composite score too low
      if (research.verdict === "AVOID" || research.compositeScore < 2) continue;

      // Categorize opportunity type
      let category: OpportunityDiscovery["category"];
      let thesis: string;
      let holdHorizon: OpportunityDiscovery["holdHorizon"];

      if (rsi <= 42) {
        category = "oversold-bounce";
        thesis = `RSI at ${rsi.toFixed(1)} with composite score ${research.compositeScore.toFixed(1)}  - oversold bounce candidate. Price: $${price.toFixed(2)}.`;
        holdHorizon = "swing";
      } else if (price > ma20 && vol / volAvg >= 1.5) {
        category = "breakout";
        thesis = `Breakout above MA20 ($${ma20.toFixed(2)}) on ${(vol/volAvg).toFixed(1)}x avg volume  - momentum entry. Composite: ${research.compositeScore.toFixed(1)}.`;
        holdHorizon = "swing";
      } else if (price > ma50 && changePct > 2) {
        category = "momentum";
        thesis = `${changePct.toFixed(1)}% up today, above 50dma  - momentum continuation. Composite: ${research.compositeScore.toFixed(1)}.`;
        holdHorizon = "intraday";
      } else if (research.compositeScore >= 8 && changePct < 0) {
        category = "value";
        thesis = `High composite score (${research.compositeScore.toFixed(1)}) at discount  - ${changePct < 0 ? "down " + Math.abs(changePct).toFixed(1) + "% today" : "stable"}. Potential mean-reversion.`;
        holdHorizon = "swing";
      } else {
        category = "sector-rotation";
        thesis = `Sector rotation play  - composite score ${research.compositeScore.toFixed(1)}, ${changePct.toFixed(1)}% today.`;
        holdHorizon = "swing";
      }

      // Position sizing based on conviction
      let positionSize: OpportunityDiscovery["positionSize"];
      if (research.compositeScore >= 12) positionSize = "medium";
      else if (research.compositeScore >= 8) positionSize = "small";
      else positionSize = "small";

      // Risk factors
      const riskFactors: string[] = [];
      const techSignal = research.signals.find(s => s.dimension === "TECHNICAL");
      if (techSignal && techSignal.score < -5) riskFactors.push("Technical headwinds  - below key MAs");
      if (macroChanges["TLT"] > 1) riskFactors.push("Rising rates pressure (TLT up)");
      if (rsi > 65) riskFactors.push(`RSI extended at ${rsi.toFixed(0)}  - entry less ideal`);
      if (vol / volAvg > 3) riskFactors.push("Very high volume  - possible event/risk");

      opportunities.push({
        ticker,
        category,
        score: research.compositeScore,
        thesis,
        riskFactors,
        positionSize,
        holdHorizon,
      });

      // Rate limit  - don't hammer Yahoo Finance
      await new Promise(r => setTimeout(r, 300));
    } catch {
      // Skip this ticker silently
    }
  }

  // Sort by composite score descending
  opportunities.sort((a, b) => b.score - a.score);

  return opportunities;
}

// ── Formatters ────────────────────────────────────────────────────────────────

export function formatTickerResearch(r: TickerResearch): string {
  const emoji = r.verdict === "BUY" ? "+" : r.verdict === "WATCH" ? "~" : "-";
  const dir = r.verdict === "BUY" ? "📈" : r.verdict === "WATCH" ? "👀" : "!";

  let out = `${emoji} *${r.ticker}* ${dir}  - ${r.verdict}\n`;
  out += `   Price: $${r.price.toFixed(2)} | RSI: ${r.rsi.toFixed(1)} | Composite: ${r.compositeScore.toFixed(1)}/100\n`;
  out += `   ${r.verdictReason}\n`;

  for (const sig of r.signals) {
    const sign = sig.score >= 0 ? "+" : "";
    out += `   [${sig.dimension}] ${sign}${sig.score.toFixed(0)}: ${sig.evidence[0] ?? ""}\n`;
  }

  return out;
}

export function formatOpportunities(opps: OpportunityDiscovery[]): string {
  if (opps.length === 0) return "";

  const header = "*NEW OPPORTUNITIES* (" + opps.length + ")";
  const lines: string[] = [header];

  for (const opp of opps.slice(0, 5)) {
    const catMarker = opp.category === "momentum" ? "M" :
      opp.category === "oversold-bounce" ? "E" :
      opp.category === "breakout" ? "B" : "V";
    lines.push(catMarker + " " + opp.ticker + " [" + opp.category + "] score=" + opp.score.toFixed(1));
    lines.push("  " + opp.thesis);
    lines.push("  pos=" + opp.positionSize + " horiz=" + opp.holdHorizon);
    if (opp.riskFactors.length > 0) {
      lines.push("  risks: " + opp.riskFactors.join(", "));
    }
    lines.push("");
  }

  return lines.join("\n");
}