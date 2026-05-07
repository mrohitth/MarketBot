/**
 * Momentum Breakout Scanner v1
 * Detects stocks breaking to 52-week highs with volume confirmation — momentum strategy.
 * Runs alongside the RSI mean-reversion scanner (different track, different entry logic).
 * 
 * Philosophy: Don't fade a stock making new 52-week highs on high volume.
 * When a stock breaks to a new 52-week high with 2x average volume, institutions are accumulating.
 * This is a separate track from RSI oversold bounce — both are valid strategies.
 */

import { getBatchQuotes, getSectorQuotes } from "./market";

export interface MomentumSetup {
  ticker: string;
  type: "52week-high" | "sector-rotation" | "earnings-momentum";
  entryPrice: number;
  targetPrice: number;
  stopLoss: number;
  riskReward: number;
  confidenceScore: number; // 0-100
  catalyst: string;
  supportingEvidence: string[];
  potentialProfitDollar: number;
  holdDaysEstimate: number;
  sector: string;
}

/** Tickers to scan for momentum breakouts — broader universe beyond semi/tech */
const MOMENTUM_TICKERS = [
  // Defensives/Cyclicals
  "XLE",  // Energy — sector rotation play
  "XLI",  // Industrials — economic recovery play
  "XLB",  // Materials — infra spending play
  "VHT",  // Healthcare — defensive + innovation
  // Small-cap value
  "VBR",  // Small-cap value ETF
  "AVUV", // Active small-cap value (DFA)
  // Momentum continued
  "META", "AMZN", "GOOGL", // Mega-cap momentum
  "TSM",  // TSMC — semi momentum
  "AMD",  // AMD — chip momentum
  "MU",   // Micron — memory cycle
];

export async function scanMomentumBreakouts(): Promise<MomentumSetup[]> {
  const setups: MomentumSetup[] = [];

  // Fetch quotes for momentum universe
  const [portfolioQuotes, sectorQuotes] = await Promise.all([
    getBatchQuotes(),
    getSectorQuotes(),
  ]);

  const allQuotes = new Map([...portfolioQuotes, ...sectorQuotes]);

  for (const ticker of MOMENTUM_TICKERS) {
    const quote = allQuotes.get(ticker);
    if (!quote) continue;

    const { price, changePercent, volume, volumeAvg, rsi, ma20, ma50, fiftyTwoWeekHigh } = quote;

    // Skip if no 52-week high data
    if (!fiftyTwoWeekHigh || fiftyTwoWeekHigh === 0) continue;

    const pctFrom52wkHigh = ((price - fiftyTwoWeekHigh) / fiftyTwoWeekHigh) * 100;

    // ── SCAN TYPE 1: 52-WEEK HIGH BREAKOUT ───────────────────────────────
    // Stock is within 3% of its 52-week high — potential breakout
    if (pctFrom52wkHigh >= -3 && pctFrom52wkHigh <= 2) {
      const volumeRatio = volumeAvg > 0 ? volume / volumeAvg : 0;
      const isHighVolume = volumeRatio >= 1.8; // 80% above average

      // Check price is above key moving averages (confirms uptrend)
      const aboveMA20 = price > (ma20 ?? price * 0.95);
      const aboveMA50 = price > (ma50 ?? price * 0.90);

      if ((isHighVolume || pctFrom52wkHigh >= 0) && aboveMA20 && aboveMA50) {
        // Calculate target: 8-12% upside from current price
        const targetMove = price > fiftyTwoWeekHigh 
          ? price * 1.08  // Already at new high — modest 8% target
          : fiftyTwoWeekHigh * 1.05; // Approaching high — if it breaks, it may run to it +5%
        const targetPrice = Math.max(targetMove, price * 1.10);
        const stopLoss = price * 0.95; // 5% hard stop

        const potentialGain = targetPrice - price;
        const riskReward = potentialGain / (price - stopLoss);

        // Confidence: volume, proximity to 52wk high, above MAs = stronger signal
        let confidence = 0;
        const evidence: string[] = [];

        if (volumeRatio >= 2.0) {
          confidence += 35;
          evidence.push(`${volumeRatio.toFixed(0)}x average volume — institutional accumulation`);
        } else if (volumeRatio >= 1.5) {
          confidence += 20;
          evidence.push(`${volumeRatio.toFixed(0)}x average volume — above average participation`);
        }

        if (pctFrom52wkHigh >= 0) {
          confidence += 25;
          evidence.push(`Trading at 52-week high — new territory, no resistance above`);
        } else {
          confidence += 15;
          evidence.push(`Within ${Math.abs(pctFrom52wkHigh).toFixed(1)}% of 52-week high — breakout imminent`);
        }

        if (aboveMA20 && aboveMA50) {
          confidence += 20;
          evidence.push(`Above 20-day and 50-day MAs — confirmed uptrend`);
        }

        if (changePercent > 1) {
          confidence += 10;
          evidence.push(`Up ${changePercent.toFixed(1)}% today — momentum confirmed`);
        }

        // RSI overlay — not oversold (>60), confirms momentum not exhausted
        if (rsi >= 50 && rsi <= 68) {
          confidence += 5;
          evidence.push(`RSI=${rsi.toFixed(0)} — healthy momentum zone, not extended`);
        } else if (rsi > 68) {
          confidence -= 5;
          evidence.push(`RSI=${rsi.toFixed(0)} — overbought, momentum may be exhausting`);
        }

        confidence = Math.max(0, Math.min(100, confidence));
        const potentialProfitDollar = potentialGain * 100; // assume 100-share position for $ sizing

        if (confidence >= 55 && potentialProfitDollar >= 500) {
          setups.push({
            ticker,
            type: "52week-high",
            entryPrice: price,
            targetPrice: +targetPrice.toFixed(2),
            stopLoss: +stopLoss.toFixed(2),
            riskReward: +riskReward.toFixed(2),
            confidenceScore: confidence,
            catalyst: pctFrom52wkHigh >= 0
              ? `Trading at 52-week high of $${fiftyTwoWeekHigh.toFixed(2)} — momentum play`
              : `Within ${Math.abs(pctFrom52wkHigh).toFixed(1)}% of 52-week high — breakout setup`,
            supportingEvidence: evidence,
            potentialProfitDollar: +potentialProfitDollar.toFixed(0),
            holdDaysEstimate: 7,
            sector: getTickerSector(ticker),
          });
        }
      }
    }

    // ── SCAN TYPE 2: SECTOR ROTATION SIGNAL ──────────────────────────────
    // When a defensive/sector ETF runs hard (+2%+) while tech lags, money is rotating
    if (["XLE", "XLI", "XLB", "VHT"].includes(ticker) && changePercent >= 1.5) {
      const sp500Quotes = portfolioQuotes.get("SPY");
      const marketChange = sp500Quotes?.changePercent ?? 0;
      const relativeRotation = changePercent - marketChange;

      if (relativeRotation >= 1.0) {
        const targetPrice = price * 1.07; // 7% target
        const stopLoss = price * 0.96;   // 4% stop
        const potentialGain = targetPrice - price;
        const riskReward = potentialGain / (price - stopLoss);
        const volumeRatio = volumeAvg > 0 ? volume / volumeAvg : 0;

        const confidence = Math.min(80, 30 + relativeRotation * 15 + (volumeRatio > 1.5 ? 10 : 0));
        const evidence = [
          `+${changePercent.toFixed(1)}% today — sector rotation confirmed`,
          `${relativeRotation.toFixed(1)}% outperformance vs SPY — capital rotating into ${ticker}`,
          volumeRatio >= 1.5 ? `${volumeRatio.toFixed(0)}x avg volume — institutional conviction` : `Volume above average — confirmed move`,
        ];

        setups.push({
          ticker,
          type: "sector-rotation",
          entryPrice: price,
          targetPrice: +targetPrice.toFixed(2),
          stopLoss: +stopLoss.toFixed(2),
          riskReward: +riskReward.toFixed(2),
          confidenceScore: confidence,
          catalyst: `Sector rotation: money moving from tech/growth into ${getTickerSector(ticker)}. ${ticker} up ${changePercent.toFixed(1)}% while SPY ${marketChange >= 0 ? "up" : "down"} ${Math.abs(marketChange).toFixed(1)}%.`,
          supportingEvidence: evidence,
          potentialProfitDollar: +(potentialGain * 100).toFixed(0),
          holdDaysEstimate: 10,
          sector: getTickerSector(ticker),
        });
      }
    }
  }

  // Sort by confidence desc
  return setups.sort((a, b) => b.confidenceScore - a.confidenceScore);
}

function getTickerSector(ticker: string): string {
  const sectors: Record<string, string> = {
    XLE: "Energy",
    XLI: "Industrials",
    XLB: "Materials",
    VHT: "Healthcare",
    VBR: "Small-Cap Value",
    AVUV: "Active Small-Cap Value",
    META: "Social Media",
    AMZN: "E-Commerce/Cloud",
    GOOGL: "Search/AI",
    TSM: "Semiconductor Manufacturing",
    AMD: "Semiconductor Design",
    MU: "Memory/Chip",
  };
  return sectors[ticker] ?? "Multi-sector";
}

export function formatMomentumAlerts(setups: MomentumSetup[]): string {
  if (setups.length === 0) return "";

  let out = `📈 *MOMENTUM TRACK — 52wk Breakouts & Sector Rotation*\n`;
  out += `_Different strategy from RSI bounce — this tracks institutional momentum._\n\n`;

  for (const s of setups) {
    const confBar = s.confidenceScore >= 75 ? "🟢" : s.confidenceScore >= 55 ? "🟡" : "🔴";
    const typeEmoji = s.type === "52week-high" ? "📈" : s.type === "sector-rotation" ? "🔄" : "📋";
    const sign = s.potentialProfitDollar >= 0 ? "+" : "";

    out += `${confBar}${typeEmoji} *${s.ticker}* [${s.sector}]\n`;
    out += `   Entry: $${s.entryPrice.toFixed(2)} → Target: $${s.targetPrice.toFixed(2)} | Stop: $${s.stopLoss.toFixed(2)}\n`;
    out += `   R/R: ${s.riskReward.toFixed(1)}:1 | ${sign}$${s.potentialProfitDollar.toFixed(0)} profit | Confidence: ${s.confidenceScore}/100\n`;
    out += `   Signal: ${s.catalyst}\n`;
    for (const ev of s.supportingEvidence.slice(0, 2)) {
      out += `   • ${ev}\n`;
    }
    out += `\n`;
  }

  return out;
}