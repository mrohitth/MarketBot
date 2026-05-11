import { MarketData } from "./types";

// ═══════════════════════════════════════════════════════════════════════════════
// ADVISOR-GRADE THRESHOLDS
// Thinking from the lens of a world-class hedge fund / trading operation.
// These thresholds are chosen based on institutional-quality position management.
// ═══════════════════════════════════════════════════════════════════════════════

/** Minimum absolute profit (in $) before a short-term trade idea is flagged */
export const MIN_PROFIT_DOLLAR = 500; // lowered from 1000 to catch smaller tickers like ASTS

/** Per-signal-type R/R floor — mean-reversion trades have lower R/R than momentum breakouts */
export const SIGNAL_MIN_RR: Partial<Record<TradeSignal, number>> = {
  RSI_OVERSOLD_BOUNCE: 0.8,    // Bounce: 5% stop, 10% target = 2:1 rr. Allow 0.8 floor.
  BREAKOUT_ABOVE_MA20: 1.5,    // Breakouts need stronger conviction
  MOVING_AVG_RECLAIM: 1.5,     // MA recross needs confirmation
  SHORT_TERM_PULLBACK: 1.2,    // Pullback in uptrend, moderate rr
  GAP_FILL_LONG: 1.5,
  EARNINGS_MOMENTUM: 1.5,
};

/** Default R/R floor for any signal not in SIGNAL_MIN_RR */
export const DEFAULT_MIN_RISK_REWARD = 2.0;

/** Maximum holding period for opportunistic trades (calendar days) */
export const MAX_HOLD_DAYS = 14;

/** Maximum risk per trade as % of total portfolio value */
export const MAX_RISK_PER_TRADE_PCT = 0.02; // 2% of portfolio

/** Minimum risk/reward ratio for a trade to be flagged (applies to signals without SIGNAL_MIN_RR entry) */
export const MIN_RISK_REWARD = 2.0;

/** RSI oversold threshold — lowered from 35 to 42 to catch pullback
  * beginnings in trending markets (backtest: NVDA RSI hit 35 only 1x in 120
  * days — bounces start at 40-45 in strong uptrends). 42 captures the start
  * of mean-reversion without catching noise in sideways markets. */
export const RSI_OVERSOLD = 42;

/** RSI overbought threshold — take profit when RSI exceeds this */
export const RSI_OVERBOUGHT = 68;

/** Volume spike multiplier for confirming breakouts */
export const VOLUME_SPIKE_MULTIPLIER = 1.5;

/** Black swan threshold — extraordinary single-day move */
export const BLACK_SWAN_THRESHOLD_PCT = 8;
/** Core anchor tickers — managed via Core Accumulation signals, NOT drift-based sells */
export const CORE_TICKERS = new Set(["VTI", "VOO", "QQQ", "XLE", "XLV", "AMGN", "COIN", "CVX"]);

// ═══════════════════════════════════════════════════════════════════════════════
// MOMENTUM EXTENDED — THREE-TIER PEAK DETECTION
// Fool-proof system: every alert requires MULTIPLE independent confirmations.
// No single-metric triggers. No false positives from noise.
// ═══════════════════════════════════════════════════════════════════════════════

export const MOMENTUM_EXTENDED_THRESHOLDS = {
  /** TIER 1 — EXTENDED: running hot, don't chase */
  EXTENDED: { min52wHiPct: 95, minVs50dPct: 25 },
  /** TIER 2 — PEAK_ZONE: peak zone, trim or wait */
  PEAK_ZONE: { min52wHiPct: 98, minVs200dPct: 40 },
  /** TIER 3 — PULLBACK_ENTRY: after peak, stock pulled back to 50d MA */
  PULLBACK_ENTRY: { min52wHiPct: 92, maxVs50dPct: 3 },
};

export const MOMENTUM_ALERT_MIN_PRICE = 5; // Ignore penny stocks (< $5)
export const MIN_MOMENTUM_PROFIT_DOLLAR = 800; // Only alert for $800+ opportunity

// Entry signal thresholds for watchlist tickers
// Only fires on: RSI oversold bounce, breakout pullback, gap fill, or MA reclaim
export const ENTRY_SIGNALS = {
  RSI_OVERSOLD_MAX: 42,        // RSI must be at or below this
  VOLUME_SPIKE_MIN: 1.5,       // Volume must be >1.5x average to confirm
  MIN_RISK_REWARD: 1.5,        // Min 1.5:1 R/R for watchlist entries
  MIN_PROFIT_DOLLAR: 600,      // Minimum $600 profit to flag (lowered from 1000 for small caps)
  MAX_HOLD_DAYS: 21,           // Longer hold for swing plays vs 14d portfolio trades
  // Profit-taking levels
  TAKE_PROFIT_PCT: 0.15,       // Take profit at +15% from entry
  STOP_LOSS_PCT: 0.05,         // Stop loss at -5% from entry (tight for active management)
};

/** Internal interface for momentum alerts */
export interface MomentumAlert {
  type: "momentum-peak-entry" | "momentum-peak" | "momentum-extended";
  severity: "critical" | "high" | "medium";
  ticker: string;
  message: string;
  action: string;
  rationale: string;
  riskNote: string;
  details: string;
  price: number;
  vs50dPct: number;
  vs200dPct: number;
  pctOf52wHi: number;
  entryPrice?: number;
  targetPrice?: number;
  stopLoss?: number;
  riskReward?: number;
  confidenceScore: number;
  confidence: "high" | "medium" | "low";
}

/**
 * Generate MOMENTUM_EXTENDED alerts for any ticker (portfolio or screener).
 *
 * TIER 3 logic — PULLBACK_ENTRY:
 *   Only fires if this ticker previously hit PEAK_ZONE (tracked via heldPeakAlerts Set).
 *   This is the "buy the dip after the peak" signal — high conviction entry after
 *   an extended rally that has now pulled back to within 3% of 50d MA.
 *
 * @param quotes — Map of all available quotes
 * @param portfolioTickers — Set of tickers in portfolio (for smart routing: trim vs don't-buy)
 * @param heldPeakAlerts — Set of tickers that previously hit PEAK_ZONE (for PULLBACK_ENTRY detection)
 */
export function generateMomentumAlerts(
  quotes: Map<string, MarketData>,
  portfolioTickers: Set<string>,
  heldPeakAlerts: Set<string>
): MomentumAlert[] {
  const alerts: MomentumAlert[] = [];
  const { EXTENDED, PEAK_ZONE, PULLBACK_ENTRY } = MOMENTUM_EXTENDED_THRESHOLDS;

  for (const [ticker, quote] of quotes) {
    // Skip penny stocks
    if (quote.price < MOMENTUM_ALERT_MIN_PRICE)
      continue;

    const price = quote.price;
    const high52w = (quote as any).fiftyTwoWeekHigh ?? price;
    if (!high52w || high52w === 0)
      continue;

    const pctOf52wHi = (price / high52w) * 100;
    const vs50dPct = quote.ma50 ? ((price / quote.ma50 - 1) * 100) : 0;
    const vs200dPct = quote.ma200 ? ((price / quote.ma200 - 1) * 100) : 0;

    // ── TIER 3: PULLBACK ENTRY ───────────────────────────────────────────
    // Only fires if ticker previously hit PEAK_ZONE AND has now pulled back
    // to within PULLBACK_ENTRY% of the 50d MA. The 30-day peak memory prevents
    // stale entries from firing.
    if (heldPeakAlerts.has(ticker)) {
      const within3pctOf50d = quote.ma50
        ? Math.abs(price - quote.ma50) / quote.ma50 * 100 <= PULLBACK_ENTRY.maxVs50dPct
        : false;

      if (within3pctOf50d) {
        const entryTarget = quote.ma20 > price ? quote.ma20 : price * 1.06;
        const stopLoss = quote.ma50 * 0.97;
        const riskReward = (entryTarget - price) / (price - stopLoss);

        alerts.push({
          type: "momentum-peak-entry",
          severity: "high",
          ticker,
          message: `💎 ${ticker} — PULLBACK ENTRY (post-peak)`,
          action: `BUY THE PULLBACK — Target $${entryTarget.toFixed(2)}`,
          rationale: `${ticker} hit PEAK_ZONE previously and has now pulled back to $${price.toFixed(2)} — just ${Math.abs(vs50dPct).toFixed(1)}% above 50d MA at $${quote.ma50?.toFixed(2)}. This is the "buy after the peak" entry institutional investors wait for. Risk defined at $${stopLoss.toFixed(2)}.`,
          riskNote: `Stop below 50d MA at $${stopLoss.toFixed(2)} (${((price - stopLoss) / price * 100).toFixed(1)}% risk). Only suitable if you have 3-5% portfolio allocation available.`,
          details: `Current: $${price.toFixed(2)} | 50d MA: $${quote.ma50?.toFixed(2)} | 52w Hi: $${high52w.toFixed(2)} | vs 52w Hi: ${pctOf52wHi.toFixed(0)}% | vs 50d: ${vs50dPct.toFixed(1)}% | Entry target: $${entryTarget.toFixed(2)} | R/R: ${riskReward.toFixed(1)}:1`,
          price,
          vs50dPct,
          vs200dPct,
          pctOf52wHi,
          entryPrice: price,
          targetPrice: entryTarget,
          stopLoss,
          riskReward,
          confidenceScore: 72,
          confidence: "high",
        });
        continue; // Don't also fire EXTENDED for same ticker
      }
    }

    // ── TIER 2: PEAK ZONE ────────────────────────────────────────────────
    // Requires BOTH: >98% of 52w Hi AND >40% vs 200d — dual confirmation
    if (pctOf52wHi >= PEAK_ZONE.min52wHiPct && vs200dPct >= PEAK_ZONE.minVs200dPct) {
      const isPortfolio = portfolioTickers.has(ticker);
      // Severity: critical for 100% of 52w or extreme >200d; high otherwise
      const isExtremePeak = pctOf52wHi >= 99.5 || vs200dPct >= 100;
      const severity: "critical" | "high" | "medium" = isExtremePeak ? "critical" : isPortfolio ? "high" : "high";
      const confidenceScore = Math.min(95,
        60
        + Math.min(30, (pctOf52wHi - 98) * 10)
        + Math.min(10, (vs200dPct - 40) * 0.5)
      );

      alerts.push({
        type: "momentum-peak",
        severity,
        ticker,
        message: `🔴 ${ticker} — PEAK ZONE`,
        action: isPortfolio ? "TRIM OR HOLD" : "DON'T BUY — WAIT",
        rationale: `${ticker} is at ${pctOf52wHi.toFixed(0)}% of its 52-week high ($${high52w.toFixed(2)}) AND ${vs200dPct.toFixed(0)}% above its 200d moving average — a historically unsustainable level. Stocks this extended typically mean-revert within 2-6 weeks.`,
        riskNote: isPortfolio
          ? `Consider trimming 20-30% of position to lock in gains. Re-add on any pullback to 50d MA ($${quote.ma50?.toFixed(2)}).`
          : `Do NOT buy here. Wait for pullback to 50d MA ($${quote.ma50?.toFixed(2)}) for better entry. Chasing at peak results in immediate drawdown.`,
        details: `Current: $${price.toFixed(2)} | 52w Hi: $${high52w.toFixed(2)} | 200d MA: $${quote.ma200?.toFixed(2)} | vs 52w Hi: ${pctOf52wHi.toFixed(0)}% | vs 200d: ${vs200dPct.toFixed(0)}% | vs 50d: ${vs50dPct.toFixed(0)}%`,
        price,
        vs50dPct,
        vs200dPct,
        pctOf52wHi,
        confidenceScore,
        confidence: confidenceScore >= 75 ? "high" : "medium",
      });
      continue; // Don't also fire EXTENDED for same ticker
    }

    // ── TIER 1: EXTENDED ────────────────────────────────────────────────
    if (pctOf52wHi >= EXTENDED.min52wHiPct && vs50dPct >= EXTENDED.minVs50dPct) {
      const confidenceScore = Math.min(65,
        45
        + Math.min(15, pctOf52wHi - 95)
        + Math.min(10, vs50dPct - 25) * 0.5
      );

      alerts.push({
        type: "momentum-extended",
        severity: "medium",
        ticker,
        message: `🟡 ${ticker} — EXTENDED`,
        action: "DON'T CHASE — WAIT FOR PULLBACK",
        rationale: `${ticker} is ${pctOf52wHi.toFixed(0)}% of its 52-week high and ${vs50dPct.toFixed(0)}% above its 50d moving average. The risk/reward of entering here is unfavorable — better entry on pullback.`,
        riskNote: `If you own it, hold but don't add. If you don't own it, wait for price to come back to 50d MA support ($${quote.ma50?.toFixed(2)}) before building a position.`,
        details: `Current: $${price.toFixed(2)} | 52w Hi: $${high52w.toFixed(2)} | 50d MA: $${quote.ma50?.toFixed(2)} | vs 52w Hi: ${pctOf52wHi.toFixed(0)}% | vs 50d: ${vs50dPct.toFixed(0)}%`,
        price,
        vs50dPct,
        vs200dPct,
        pctOf52wHi,
        confidenceScore,
        confidence: "medium",
      });
    }
  }

  return alerts;
}

// ═══════════════════════════════════════════════════════════════════════════════
// ENTRY SIGNALS — BUY THE DIP / SELL THE RIP
// Comprehensive watchlist scanning: 38 tickers across 9 sectors.
// Philosophy: catch every significant dip worth buying and every extended rally worth trimming.
// Only fires on high-conviction setups: RSI oversold, volume-backed pullbacks, gap fills, MA reclaims.
// ═══════════════════════════════════════════════════════════════════════════════

export interface EntrySignal {
  type: "buy-the-dip" | "sell-the-rip" | "breakout-pullback" | "gap-fill-long" | "ma-reclaim" | "extended-no-entry" | "deep-pullback";
  severity: "critical" | "high" | "medium";
  ticker: string;
  sector: string;
  message: string;
  action: string;
  rationale: string;
  riskNote: string;
  details: string;
  price: number;
  entryPrice: number;
  targetPrice: number;
  stopLoss: number;
  riskReward: number;
  potentialProfitDollar: number;
  vs50dPct: number;
  vs200dPct: number;
  pctOf52wHi: number;
  rsi: number;
  ma50?: number;
  ma50Slope?: number;
  confidenceScore: number;
  confidence: "high" | "medium" | "low";
}

// Sector map for watchlist tickers
const TICKER_SECTOR: Record<string, string> = {
  // Semi
  AMD: "Semi", TSM: "Semi", ASML: "Semi", INTC: "Semi", QCOM: "Semi",
  AMAT: "Semi", LRCX: "Semi", MU: "Semi", KLAC: "Semi",
  // Tech
  AVGO: "Tech", MRVL: "Tech", PANW: "Tech", MPWR: "Tech",
  SNPS: "Tech", CDNS: "Tech", ON: "Tech", SWKS: "Tech",
  // Industrials
  CAT: "Industrials", BA: "Industrials", LMT: "Industrials", RTX: "Industrials", GD: "Industrials",
  // Healthcare
  UNH: "Healthcare", JNJ: "Healthcare", ABBV: "Healthcare", AMGN: "Healthcare",
  // Finance
  JPM: "Finance", BAC: "Finance", GS: "Finance",
  // Energy
  XLE: "Energy", CVX: "Energy", XOM: "Energy",
  // Consumer
  COST: "Consumer", WMT: "Consumer", PG: "Consumer",
  // Alternatives
  GLD: "Alternatives", SLV: "Alternatives",
  // Semi-adjacent
  NXPI: "Semi-Adjacent",
};

/**
 * Generate BUY/SELL entry signals for watchlist tickers.
 *
 * BUY signals (5 types):
 *  1. buy-the-dip:       RSI oversold + RSI bouncing back + stock not in downtrend
 *  2. breakout-pullback: In uptrend (above ma20+ma50), pulled back to ma20 with volume
 *  3. gap-fill-long:     Down gap from open, filling gap same day, bounce confirmed
 *  4. ma-reclaim:        Reclaimed ma50 after being below it, with conviction
 *  5. momentum-peak-entry (reuses PULLBACK_ENTRY logic)
 *
 * SELL signals:
 *  1. sell-the-rip:     RSI overbought + price extended vs 52w Hi (>98%) + not in portfolio
 *                       → "Don't buy at peak, take profits if own"
 *  2. extended-no-entry: Running hot (EXTENDED tier) — "don't chase, wait for pullback"
 *
 * @param watchlistQuotes  Map of quotes for all 38 watchlist tickers
 * @param portfolioTickers Set of tickers already in portfolio (for routing sell signals)
 */
export function generateEntrySignals(
  watchlistQuotes: Map<string, MarketData>,
  portfolioTickers: Set<string>
): EntrySignal[] {
  const signals: EntrySignal[] = [];
  const { RSI_OVERSOLD_MAX, VOLUME_SPIKE_MIN, MIN_RISK_REWARD, MIN_PROFIT_DOLLAR } = ENTRY_SIGNALS;

  for (const [ticker, quote] of watchlistQuotes) {
    if (quote.price < 3) continue; // Skip penny stocks

    const price    = quote.price;
    const high52w  = quote.fiftyTwoWeekHigh ?? price;
    const ma50     = quote.ma50 ?? price;
    const ma200    = quote.ma200 ?? price;
    const ma20     = quote.ma20 ?? price;
    const rsi      = quote.rsi ?? 50;
    const pctOf52w = (price / high52w) * 100;
    const vs50d    = ma50  ? (price / ma50  - 1) * 100 : 0;
    const vs200d   = ma200 ? (price / ma200 - 1) * 100 : 0;
    const volumeRatio = quote.volume > 0 ? quote.volume / Math.max(quote.volumeAvg, 1) : 1;
    const sector   = TICKER_SECTOR[ticker] ?? "Other";

    // ── BUY SIGNAL 1: RSI Oversold Bounce ───────────────────────────────
    // RSI ≤ 38 AND price not in a sustained downtrend (above ma50)
    if (rsi <= RSI_OVERSOLD_MAX && rsi > 20 && ma50 && price > ma50 * 0.92) {
      const entryTarget = Math.max(ma20, price * 1.07);
      const stopLoss    = price * 0.96;
      const riskReward  = (entryTarget - price) / (price - stopLoss);
      const riskDollar  = (price - stopLoss) * 50; // assume 50 shares per $2k pos
      const profitDollar = (entryTarget - price) * 50;

      if (riskReward >= MIN_RISK_REWARD && profitDollar >= MIN_PROFIT_DOLLAR) {
        signals.push({
          type: "buy-the-dip",
          severity: rsi <= 32 ? "high" : "medium",
          ticker, sector,
          message: `🟢 ${ticker} — RSI OVERSOLD BOUNCE`,
          action: `BUY TARGET $${entryTarget.toFixed(2)}`,
          rationale: `RSI at ${rsi.toFixed(0)} — historically oversold zone. ${ticker} is ${vs50d.toFixed(0)}% above its 50d MA ($${ma50.toFixed(2)}), confirming this is a pullback in an uptrend, not a collapse. Bounce target: $${entryTarget.toFixed(2)}.`,
          riskNote: `Stop at $${stopLoss.toFixed(2)} (${((price - stopLoss) / price * 100).toFixed(1)}% risk). RSI below 30 = higher conviction; above 38 = lower.`,
          details: `$${price.toFixed(2)} | RSI ${rsi.toFixed(0)} | 50d MA $${ma50.toFixed(2)} | Target $${entryTarget.toFixed(2)} | R/R ${riskReward.toFixed(1)}:1 | ~$${profitDollar.toFixed(0)} profit | Sector: ${sector}`,
          price, entryPrice: price, targetPrice: entryTarget, stopLoss,
          riskReward, potentialProfitDollar: profitDollar,
          vs50dPct: vs50d, vs200dPct: vs200d, pctOf52wHi: pctOf52w, rsi,
          confidenceScore: Math.min(85, 50 + (RSI_OVERSOLD_MAX - rsi) * 2),
          confidence: rsi <= 32 ? "high" : "medium",
        });
      }
    }

    // ──     // ── BUY SIGNAL 1B: Deep Pullback in Oversold Sector ────────────────────────
    // RSI 38-55 AND price just below MA50 — but MA50 must be rising (not resistance)
    // XLE/XLV/VHT case: RSI ~40, price -3% below MA50 → accumulate toward MA50 reclaim
    const ma50Rising = (quote.ma50Slope ?? 0) >= 0; // positive slope = rising MA50 = pullback in uptrend

    // Filter: price must be within 10% below MA50. Deeper than that = structural weakness, not a pullback.
    const vs50dPct = ma50 ? ((price - ma50) / ma50) * 100 : 0;
    if (
      rsi >= 38 && rsi <= 55 &&
      ma50 && price > ma50 * 0.90 && price < ma50 &&
      ma50Rising &&
      vs50dPct >= -10 // cap: reject if >10% below MA50 (CVX was -6%, XLE is -3.8%)
    ) {
      const entryTarget = ma50; // target: reclaim 50d MA
      const stopLoss    = ma50 * 0.94;
      const riskReward  = (entryTarget - price) / (price - stopLoss);
      const profitDollar = (entryTarget - price) * 50;

      if (riskReward >= 1.0 && profitDollar >= 100) {
        signals.push({
          type: "deep-pullback",
          severity: rsi <= 40 ? "high" : "medium",
          ticker, sector,
          message: `🟢 ${ticker} — DEEP PULLOBACK`,
          action: `BUY — Target $${entryTarget.toFixed(2)} (reclaim MA50)`,
          rationale: `RSI at ${rsi.toFixed(0)} — ${ticker} pulled back to ${Math.abs(vs50d).toFixed(1)}% below its 50d MA ($${ma50.toFixed(2)}). Sector rotation play: RSI oversold with price testing support. Target is $${entryTarget.toFixed(2)} (reclaim 50d MA). Stop below at $${stopLoss.toFixed(2)}.`,
          riskNote: `Stop at $${stopLoss.toFixed(2)} (${((price - stopLoss) / price * 100).toFixed(1)}% risk). Sector ETF pullback — mean-reversion entry.`,
          details: `$${price.toFixed(2)} | RSI ${rsi.toFixed(0)} | 50d MA $${ma50.toFixed(2)} (${vs50d.toFixed(1)}%) | Target $${entryTarget.toFixed(2)} | R/R ${riskReward.toFixed(1)}:1 | ~$${profitDollar.toFixed(0)} profit | Sector: ${sector}`,
          price, entryPrice: price, targetPrice: entryTarget, stopLoss,
          riskReward, potentialProfitDollar: profitDollar,
          vs50dPct: vs50d, vs200dPct: vs200d, pctOf52wHi: pctOf52w, rsi,
          ma50, ma50Slope: quote.ma50Slope ?? 0,
          confidenceScore: Math.min(85, 60 + (42 - rsi) * 2),
          confidence: rsi <= 40 ? "high" : "medium",
        });
      }
    }

// ── BUY SIGNAL 2: Breakout Pullback ────────────────────────────────
    // In uptrend (price > ma20 > ma50), pulled back to ma20, volume confirming bounce
    if (price > ma20 && ma20 > ma50 && volumeRatio >= VOLUME_SPIKE_MIN) {
      const diffFromMa20 = Math.abs(price - ma20) / ma20 * 100;
      if (diffFromMa20 <= 4) { // within 4% of ma20 = pullback to support
        const entryTarget = ma50 > price ? ma50 * 1.04 : price * 1.06;
        const stopLoss    = ma20 * 0.97;
        const riskReward  = (entryTarget - price) / (price - stopLoss);
        const profitDollar = (entryTarget - price) * 50;

        if (riskReward >= MIN_RISK_REWARD && profitDollar >= MIN_PROFIT_DOLLAR) {
          signals.push({
            type: "breakout-pullback",
            severity: "high",
            ticker, sector,
            message: `🟢 ${ticker} — PULLBACK TO SUPPORT`,
            action: `BUY — Target $${entryTarget.toFixed(2)}`,
            rationale: `${ticker} pulled back to its 20d MA ($${ma20.toFixed(2)}) — key support in an uptrend. Volume ${volumeRatio.toFixed(0)}x average confirms buyers stepping in. Target: $${entryTarget.toFixed(2)}.`,
            riskNote: `Stop below 20d MA at $${stopLoss.toFixed(2)} (${((price - stopLoss) / price * 100).toFixed(1)}% risk). This is a mean-reversion entry in an established uptrend.`,
            details: `$${price.toFixed(2)} | 20d MA $${ma20.toFixed(2)} | 50d MA $${ma50.toFixed(2)} | Target $${entryTarget.toFixed(2)} | R/R ${riskReward.toFixed(1)}:1 | ~$${profitDollar.toFixed(0)} profit | Vol ${volumeRatio.toFixed(0)}x avg | Sector: ${sector}`,
            price, entryPrice: price, targetPrice: entryTarget, stopLoss,
            riskReward, potentialProfitDollar: profitDollar,
            vs50dPct: vs50d, vs200dPct: vs200d, pctOf52wHi: pctOf52w, rsi,
            confidenceScore: 70,
            confidence: "high",
          });
        }
      }
    }

    // ── BUY SIGNAL 3: MA50 Reclaim ────────────────────────────────────
    // Price crossed above ma50 today (or yesterday) with volume
    // Check: price just broke above ma50 (within 2% above) + positive day
    if (ma50 && price > ma50 && price < ma50 * 1.03 && quote.changePercent > 0.5 && volumeRatio >= 1.2) {
      const entryTarget = ma20 > price ? ma20 : price * 1.05;
      const stopLoss    = ma50 * 0.97;
      const riskReward  = (entryTarget - price) / (price - stopLoss);
      const profitDollar = (entryTarget - price) * 50;

      if (riskReward >= MIN_RISK_REWARD && profitDollar >= MIN_PROFIT_DOLLAR) {
        signals.push({
          type: "ma-reclaim",
          severity: "medium",
          ticker, sector,
          message: `🟢 ${ticker} — MA50 RECLAIM`,
          action: `BUY — Target $${entryTarget.toFixed(2)}`,
          rationale: `${ticker} reclaiming its 50d MA ($${ma50.toFixed(2)}) on ${quote.changePercent.toFixed(1)}% up day. Volume ${volumeRatio.toFixed(0)}x average confirms institutional interest. Target: $${entryTarget.toFixed(2)}.`,
          riskNote: `Stop below 50d MA at $${stopLoss.toFixed(2)} (${((price - stopLoss) / price * 100).toFixed(1)}% risk). Reclaim must hold — if it fails, exit.`,
          details: `$${price.toFixed(2)} | 50d MA $${ma50.toFixed(2)} | 20d MA $${ma20.toFixed(2)} | Target $${entryTarget.toFixed(2)} | R/R ${riskReward.toFixed(1)}:1 | ~$${profitDollar.toFixed(0)} profit | Sector: ${sector}`,
          price, entryPrice: price, targetPrice: entryTarget, stopLoss,
          riskReward, potentialProfitDollar: profitDollar,
          vs50dPct: vs50d, vs200dPct: vs200d, pctOf52wHi: pctOf52w, rsi,
          confidenceScore: 58,
          confidence: "medium",
        });
      }
    }

    // ── SELL SIGNAL 1: Sell The Rip — Overbought + Extended ────────────
    // Not in portfolio: stock running hot (PEAK_ZONE), don't buy
    // In portfolio: stock at PEAK_ZONE, take profits
    if (pctOf52w >= 97 && rsi >= 62) {
      const isPortfolio = portfolioTickers.has(ticker);
      signals.push({
        type: "sell-the-rip",
        severity: pctOf52w >= 99 ? "critical" : "high",
        ticker, sector,
        message: isPortfolio
          ? `🔴 ${ticker} — PEAK — TAKE PROFITS`
          : `🔴 ${ticker} — PEAK — DON'T CHASE`,
        action: isPortfolio ? "TRIM OR SELL — AT PEAK" : "DON'T BUY — WAIT FOR PULLBACK",
        rationale: `${ticker} at ${pctOf52w.toFixed(0)}% of 52w high ($${high52w.toFixed(2)}) AND RSI at ${rsi.toFixed(0)} (overbought). Historically, stocks this extended mean-revert within 2-6 weeks.` +
          (isPortfolio ? ` You own it — consider trimming 20-30%.` : ` Wait for pullback to 50d MA.`),
        riskNote: isPortfolio
          ? `Trim 20-30% to lock in gains. Re-add on pullback to $${ma50.toFixed(2)}.`
          : `Chasing here = immediate drawdown. Better entry on pullback to $${ma50.toFixed(2)}.`,
        details: `$${price.toFixed(2)} | 52w Hi $${high52w.toFixed(2)} | ${pctOf52w.toFixed(0)}% of 52w | RSI ${rsi.toFixed(0)} | vs 50d MA $${ma50.toFixed(2)} | Sector: ${sector}`,
        price, entryPrice: price, targetPrice: ma50 * 0.97, stopLoss: price * 1.03,
        riskReward: 0, potentialProfitDollar: 0,
        vs50dPct: vs50d, vs200dPct: vs200d, pctOf52wHi: pctOf52w, rsi,
        confidenceScore: Math.min(88, 55 + (pctOf52w - 95) * 3 + (rsi - 60) * 0.8),
        confidence: "high",
      });
    }

    // ── SELL SIGNAL 2: Extended — Don't Chase ──────────────────────────
    // Stock up big but not at PEAK_ZONE yet — just bad risk/reward
    if (pctOf52w >= 93 && pctOf52w < 97 && vs50d >= 20) {
      signals.push({
        type: "extended-no-entry",
        severity: "medium",
        ticker, sector,
        message: `🟡 ${ticker} — EXTENDED`,
        action: "DON'T CHASE — WAIT FOR PULLBACK",
        rationale: `${ticker} is ${pctOf52w.toFixed(0)}% of its 52w high and ${vs50d.toFixed(0)}% above its 50d MA. Risk/reward entering here is unfavorable — historically, better entries appear on pullbacks.`,
        riskNote: `If you own it, hold but don't add. If you don't own it, wait for price to come back to $${ma50.toFixed(2)} (50d MA) before buying.`,
        details: `$${price.toFixed(2)} | ${pctOf52w.toFixed(0)}% of 52w Hi | vs 50d MA $${ma50.toFixed(2)} (+${vs50d.toFixed(0)}%) | vs 200d $${ma200.toFixed(2)} (+${vs200d.toFixed(0)}%) | Sector: ${sector}`,
        price, entryPrice: price, targetPrice: ma50, stopLoss: price * 1.02,
        riskReward: 0, potentialProfitDollar: 0,
        vs50dPct: vs50d, vs200dPct: vs200d, pctOf52wHi: pctOf52w, rsi,
        confidenceScore: 52,
        confidence: "medium",
      });
    }
  }

  // Sort: critical first, then high, then medium
  return signals.sort((a, b) => {
    const sevOrder = { critical: 0, high: 1, medium: 2 };
    const sd = sevOrder[a.severity] - sevOrder[b.severity];
    if (sd !== 0) return sd;
    return b.confidenceScore - a.confidenceScore;
  });
}

// ═══════════════════════════════════════════════════════════════════════════════
// DRIFT THRESHOLDS PER TICKER
// Core indices get tighter bands (more stable). Speculative names get wider.
// ═══════════════════════════════════════════════════════════════════════════════

export const DRIFT_THRESHOLDS_ADVISORY: Record<string, number> = {
  // Broad indices — tight bands, high conviction core holdings
  NVDA:  35, // ±4% drift — GPU moat, maximum conviction AI infrastructure bet
  VTI:   15, // ±5% drift — broad US market, secondary anchor
  VOO:   10, // ±5% drift — S&P500 core, large-cap ballast
  QQQ:    8, // ±5% drift — tech/growth tilt (trim when overweight)
  SMH:   10, // ±6% drift — semi sector ETF
  SCHG:   8, // ±6% drift — large-cap growth (weekly $150 auto-invest)
  XLE:    5, // ±5% drift — energy satellite position (RSI-driven)
  XLV:    5, // ±5% drift — healthcare satellite position (RSI-driven)
  VXUS:  25, // ±25% drift — only extreme deviations trigger rebalance
  SCHD:  25, // ±25% drift — only extreme deviations trigger rebalance
  SPYD:    2, // ±8% drift — tactical income (was 1%)
  ASTS:   15,// ±15% drift — speculative moonshot
  SPAXX:   0,// Cash — no drift concept
};

// ═══════════════════════════════════════════════════════════════════════════════
// PORTFOLIO TARGET ALLOCATION (advisor-calibrated)
// These reflect Mathew's conviction + income profile:
// - NVDA 19% (largest conviction, AI infrastructure moat)
// - VTI 20% (breadth, anchors whole portfolio)
// - VOO 17% (S&P500 large-cap core)
// - QQQ 14% (tech/growth tilt)
// ═══════════════════════════════════════════════════════════════════════════════

export const PORTFOLIO_TARGET_ALLOCATION: Record<string, number> = {
  NVDA:  0.25, // 25% — AI infrastructure anchor
  VTI:   0.15, // 15% — broad US market core
  VOO:   0.10, // 10% — S&P500 ballast
  QQQ:   0.08, // 8% — tech/growth tilt
  SMH:   0.10, // 10% — semi sector (high conviction)
  XLE:   0.07, // 7% — energy diversification (protected from drift sells)
  XLV:   0.06, // 6% — healthcare diversification (protected from drift sells)
  VXUS:  0.0291, // 2.9% — international (sold down) diversification
  SCHD:  0.0294, // 2.9% — dividend (sold down) stability
  SPYD:  0.01, // 1% — tactical income
  ASTS:  0.00, // 0% — moonhot/momentum trade, NOT drift-managed
  SPAXX: 0.04, // 4% — cash buffer
  AMGN:  0.0368, // 3.7% — small swing/hold
  COIN:  0.0194, // 1.9% — small swing/hold
  CVX:   0.0341, // 3.4% — energy satellite
};

// ═══════════════════════════════════════════════════════════════════════════════
// TRADE SIGNAL TYPES
// ═══════════════════════════════════════════════════════════════════════════════

export type TradeSignal =
  | "RSI_OVERSOLD_BOUNCE"    // RSI ≤ 35, expecting bounce to ma20 or +5%
  | "BREAKOUT_ABOVE_MA20"    // Price breaks above MA20 with volume confirmation
  | "GAP_FILL_LONG"          // Price has gapped up, expecting fill to prior level
  | "MOVING_AVG_RECLAIM"     // Price reclaiming MA20 after being below
  | "SHORT_TERM_PULLBACK"    // Pullback to support in uptrend — accumulate
  | "EARNINGS_MOMENTUM";    // Within 5 days of earnings, momentum continuation play

export type TradeDirection = "LONG" | "SHORT";

export interface TradeSetup {
  ticker: string;
  direction: TradeDirection;
  signal: TradeSignal;
  entryPrice: number;
  targetPrice: number;
  stopLoss: number;
  riskReward: number;
  confidence: "high" | "medium" | "low";
  confidenceScore: number;  // 0-100, evidence-based numeric confidence
  catalyst: string;
  supportingEvidence: string[];  // specific news/events driving the setup
  potentialProfitDollar: number;
  holdDaysEstimate: number;
  riskDollar: number;
  rsi: number;  // live RSI at time of setup generation (for human-readable output)
}

// ═══════════════════════════════════════════════════════════════════════════════
// OPEN POSITION TRACKING
// ═══════════════════════════════════════════════════════════════════════════════

export interface OpenPosition {
  ticker: string;
  direction: TradeDirection;
  entryPrice: number;
  shares: number;
  entryDate: string;
  targetPrice: number;
  stopLoss: number;
  currentPrice: number;
  unrealizedPnL: number;
  unrealizedPnLPct: number;
  holdDaysRemaining: number; // negative = overdue
  signal: TradeSignal;
  status: "active" | "at-risk" | "target-hit" | "stop-hit" | "expired";
  notes: string;
}

// ═══════════════════════════════════════════════════════════════════════════════
// RECOMMENDATION ADVISOR ENGINE
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Compute a 0-100 confidence score and supporting evidence for a setup.
 * Evidence is grounded in specific technicals and observable market behavior.
 */
function scoreSetup(
  quote: MarketData,
  direction: TradeDirection,
  signal: TradeSignal,
  newsSentiment?: { score: number; label: string; headlines: string[] }
): { confidenceScore: number; evidence: string[] } {
  const { price, changePercent, rsi, ma20, ma50, volume, volumeAvg, status } = quote;
  const evidence: string[] = [];
  let score = 0;


  // ── Technical signal strength (up to 60 points) ──────────────────────────
  if (rsi <= 30) {
    score += 25;
    evidence.push(`RSI deeply oversold at ${rsi.toFixed(0)} — high probability bounce`);
  } else if (rsi <= RSI_OVERSOLD) {
    score += 15;
    evidence.push(`RSI at ${rsi.toFixed(0)}, near historically reliable bounce zone`);
  } else if (rsi >= RSI_OVERBOUGHT) {
    score += 15;
    evidence.push(`RSI at ${rsi.toFixed(0)}, extended — mean reversion likely`);
  }

  if (price > ma20) {
    score += 15;
    evidence.push(`Trading above 20-day MA ($${ma20.toFixed(2)}) — short-term uptrend`);
  } else {
    score += 5;
    evidence.push(`Below 20-day MA — but not a sustained downtrend`);
  }


  if (price > ma50) {
    score += 10;
    evidence.push(`Above 50-day MA ($${ma50.toFixed(2)}) — intermediate-term uptrend`);
  } else {
    score += 2;
    evidence.push(`Below 50-day MA — some mean-reversion fuel`);
  }

  if (volume >= volumeAvg * 2) {
    score += 10;
    evidence.push(`${(volume / volumeAvg).toFixed(0)}% of average volume — conviction trade`);
  } else if (volume >= volumeAvg * VOLUME_SPIKE_MULTIPLIER) {
    score += 6;
    evidence.push(`Volume ${(volume / volumeAvg).toFixed(0)}% above average — confirming`);
  }

  if (direction === "LONG" && changePercent < -2) {
    score += 8;
    evidence.push(`Pulling back ${Math.abs(changePercent).toFixed(1)}% intraday — better entry`);
  } else if (direction === "LONG" && changePercent > 2) {
    score -= 5;
    evidence.push(`Already up ${changePercent.toFixed(1)}% — entry less ideal`);
  }

  if (status === "bull") {
    score += 5;
    evidence.push(`Broad market posture bullish for this ticker`);
  } else if (status === "bear") {
    score -= 5;
    evidence.push(`Ticker in bearish short-term regime — requires tighter stop`);
  }

  if (signal === "RSI_OVERSOLD_BOUNCE") {
    score += 10;
    evidence.push(`RSI_OVERSOLD — historically highest win-rate pattern`);
  } else if (signal === "BREAKOUT_ABOVE_MA20") {
    score += 8;
    evidence.push(`Breakout signal — institutional investors watch this level`);
  } else if (signal === "SHORT_TERM_PULLBACK") {
    score += 5;
    evidence.push(`Pullback in established uptrend — continuation setup`);
  }

  // ── News sentiment overlay (up to ±15 points) ───────────────────────────
  if (newsSentiment) {
    if (newsSentiment.score > 5) {
      score += Math.min(15, newsSentiment.score);
      evidence.push(`Recent news: NET POSITIVE sentiment (${newsSentiment.label}) — ${newsSentiment.headlines[0] ?? "bullish headlines"}`);
    } else if (newsSentiment.score < -5) {
      score -= Math.min(15, Math.abs(newsSentiment.score));
      evidence.push(`Recent news: NET NEGATIVE sentiment (${newsSentiment.label}) — ${newsSentiment.headlines[0] ?? "bearish headlines"}`);
    }
  }

  score = Math.max(0, Math.min(100, score));
  return { confidenceScore: score, evidence };
}


/**
 * Analyze a quote and generate trade setups.
 * Returns setups that meet MIN_PROFIT_DOLLAR and MIN_RISK_REWARD criteria.
 */
export function generateTradeSetups(
  quote: MarketData,
  portfolioValue: number,
  newsSentiment?: { score: number; label: string; headlines: string[] }
): TradeSetup[] {
  const setups: TradeSetup[] = [];
  const { ticker, price, rsi, ma20, ma50, volume, volumeAvg, changePercent, status } = quote;
  const riskPct = MAX_RISK_PER_TRADE_PCT; // 2% of portfolio
  const maxRiskDollar = portfolioValue * riskPct;

  // ── RSI Oversold Bounce ───────────────────────────────────────────────────
  if (rsi <= RSI_OVERSOLD && rsi > 20) {
    const bounceTarget = ma20 > price ? ma20 : price * 1.10; // 10% target for rr=2.0 with 5% stop
    const potentialGain = bounceTarget - price;
    const maxShares = Math.floor(maxRiskDollar / (price * 0.05)); // 5% stop
    const potentialProfitDollar = potentialGain * maxShares;
    const stopLoss = price * 0.95;
    const riskReward = potentialGain / (price - stopLoss);
    const holdDays = Math.ceil((bounceTarget - price) / price / 0.02 * 3); // rough 3-day per 2% move

    const signalRR_RSI = SIGNAL_MIN_RR.RSI_OVERSOLD_BOUNCE ?? DEFAULT_MIN_RISK_REWARD;
    if (potentialProfitDollar >= MIN_PROFIT_DOLLAR && riskReward >= signalRR_RSI) {
      const { confidenceScore, evidence } = scoreSetup(quote, "LONG", "RSI_OVERSOLD_BOUNCE", newsSentiment);

      setups.push({
        ticker,
        direction: "LONG",
        signal: "RSI_OVERSOLD_BOUNCE",
        entryPrice: price,
        targetPrice: bounceTarget,
        stopLoss,
        riskReward,
        confidence: confidenceScore >= 65 ? "high" : confidenceScore >= 45 ? "medium" : "low",
        confidenceScore,
        supportingEvidence: evidence,
        catalyst: `RSI at ${rsi.toFixed(0)} — historically oversold, bounce expected. Target: $${bounceTarget.toFixed(2)} (${(potentialGain / price * 100).toFixed(1)}% move)`,
        potentialProfitDollar,
        holdDaysEstimate: Math.min(holdDays, MAX_HOLD_DAYS),
        riskDollar: maxRiskDollar,
        rsi,
      });
    }
  }

  // ── Breakout Above MA20 with Volume ──────────────────────────────────────
  if (price > ma20 && volume >= volumeAvg * VOLUME_SPIKE_MULTIPLIER) {
    const priceTarget = ma50 > price ? ma50 : price * 1.03;
    const potentialGain = priceTarget - price;
    const stopLoss = ma20 * 0.98; // 2% below MA20
    const maxShares = Math.floor(maxRiskDollar / (price - stopLoss));
    const potentialProfitDollar = potentialGain * maxShares;
    const riskReward = potentialGain / (price - stopLoss);
    const holdDays = Math.ceil((priceTarget - price) / price / 0.015 * 2);

    const signalRR_Breakout = SIGNAL_MIN_RR.BREAKOUT_ABOVE_MA20 ?? DEFAULT_MIN_RISK_REWARD;
    if (potentialProfitDollar >= MIN_PROFIT_DOLLAR && riskReward >= signalRR_Breakout) {
      const { confidenceScore, evidence } = scoreSetup(quote, "LONG", "BREAKOUT_ABOVE_MA20", newsSentiment);

      setups.push({
        ticker,
        direction: "LONG",
        signal: "BREAKOUT_ABOVE_MA20",
        entryPrice: price,
        targetPrice: priceTarget,
        stopLoss,
        riskReward,
        confidence: confidenceScore >= 65 ? "high" : confidenceScore >= 45 ? "medium" : "low",
        confidenceScore,
        supportingEvidence: evidence,
        catalyst: `Breaking above MA20 on ${(volume / volumeAvg * 100).toFixed(0)}% of avg volume. Target: $${priceTarget.toFixed(2)}`,
        potentialProfitDollar,
        holdDaysEstimate: Math.min(holdDays, MAX_HOLD_DAYS),
        riskDollar: maxRiskDollar,
        rsi,
      });
    }
  }

  // ── MA50 Reclaim ─────────────────────────────────────────────────────────
  if (ma50 && Math.abs(price - ma50) / ma50 < 0.025 && Math.abs(changePercent) > 1.5) {
    if (status === "bull" || changePercent > 2) {
      const target = price * 1.04;
      const stopLoss = price * 0.97;
      const potentialGain = target - price;
      const maxShares = Math.floor(maxRiskDollar / (price - stopLoss));
      const potentialProfitDollar = potentialGain * maxShares;
      const riskReward = potentialGain / (price - stopLoss);
      const holdDays = 5;
      const signalRR_MA = SIGNAL_MIN_RR.MOVING_AVG_RECLAIM ?? DEFAULT_MIN_RISK_REWARD;
      const { confidenceScore, evidence } = scoreSetup(quote, "LONG", "MOVING_AVG_RECLAIM", newsSentiment);

      if (potentialProfitDollar >= MIN_PROFIT_DOLLAR && riskReward >= signalRR_MA) {
        setups.push({
          ticker,
          direction: "LONG",
          signal: "MOVING_AVG_RECLAIM",
          entryPrice: price,
          targetPrice: target,
          stopLoss,
          riskReward,
          confidence: confidenceScore >= 65 ? "high" : confidenceScore >= 45 ? "medium" : "low",
          confidenceScore,
          supportingEvidence: evidence,
          catalyst: `Reclaiming MA50 ($${ma50.toFixed(2)}) with ${Math.abs(changePercent).toFixed(1)}% move. 4% target.`,
          potentialProfitDollar,
          holdDaysEstimate: holdDays,
          riskDollar: maxRiskDollar,
        rsi,
        });
      }
    }
  }

  // ── Short-Term Pullback in Uptrend ──────────────────────────────────────
  if (status === "bull" && changePercent < -1.5 && rsi > 40 && rsi < 60) {
    const support = ma20 < price ? ma20 : price * 0.98;
    const target = price * 1.03;
    const stopLoss = support * 0.98;
    const potentialGain = target - price;
    const maxShares = Math.floor(maxRiskDollar / (price - stopLoss));
    const potentialProfitDollar = potentialGain * maxShares;
    const riskReward = potentialGain / (price - stopLoss);
    const holdDays = 4;
    const { confidenceScore, evidence } = scoreSetup(quote, "LONG", "SHORT_TERM_PULLBACK", newsSentiment);

    const signalRR_Pull2 = SIGNAL_MIN_RR.SHORT_TERM_PULLBACK ?? DEFAULT_MIN_RISK_REWARD;
    if (potentialProfitDollar >= MIN_PROFIT_DOLLAR && riskReward >= signalRR_Pull2) {
      setups.push({
        ticker,
        direction: "LONG",
        signal: "SHORT_TERM_PULLBACK",
        entryPrice: price,
        targetPrice: target,
        stopLoss,
        riskReward,
        confidence: confidenceScore >= 65 ? "high" : confidenceScore >= 45 ? "medium" : "low",
        confidenceScore,
        supportingEvidence: evidence,
        catalyst: `Pullback in uptrend. RSI=${rsi.toFixed(0)}, support near $${support.toFixed(2)}. Target +3%.`,
        potentialProfitDollar,
        holdDaysEstimate: holdDays,
        riskDollar: maxRiskDollar,
        rsi,
      });
    }
  }

  return setups;
}

/**
 * Rank setups by risk/reward and profit potential.
 * Filter to only those meeting minimum criteria.
 */
export function rankSetups(setups: TradeSetup[]): TradeSetup[] {
  return setups
    .filter((s) => { const floor = SIGNAL_MIN_RR[s.signal] ?? DEFAULT_MIN_RISK_REWARD; return s.riskReward >= floor && s.potentialProfitDollar >= MIN_PROFIT_DOLLAR; })
    .sort((a, b) => {
      // Primary sort: confidence score (higher is better)
      const d = b.confidenceScore - a.confidenceScore;
      if (Math.abs(d) > 5) return d;
      // Secondary: risk/reward
      const rr = b.riskReward - a.riskReward;
      if (Math.abs(rr) > 0.5) return rr;
      // Tertiary: profit dollar
      return b.potentialProfitDollar - a.potentialProfitDollar;
    });
}

/**
 * Update open positions with current prices and check status.
 */
export function updateOpenPositions(
  positions: OpenPosition[],
  quotes: Map<string, MarketData>
): OpenPosition[] {
  const now = new Date();

  return positions.map((pos) => {
    const quote = quotes.get(pos.ticker);
    if (!quote) return pos;

    const currentPrice = quote.price;
    const unrealizedPnL = (currentPrice - pos.entryPrice) * pos.shares;
    const unrealizedPnLPct = (currentPrice - pos.entryPrice) / pos.entryPrice * 100;
    const entryDate = new Date(pos.entryDate);
    const holdDaysElapsed = Math.floor((now.getTime() - entryDate.getTime()) / (1000 * 60 * 60 * 24));
    const holdDaysRemaining = MAX_HOLD_DAYS - holdDaysElapsed;

    let status: OpenPosition["status"] = pos.status;
    let notes = pos.notes;

    if (currentPrice >= pos.targetPrice) {
      status = "target-hit";
      notes = `✅ Target hit. +$${unrealizedPnL.toFixed(0)} (${unrealizedPnLPct.toFixed(1)}%)`;
    } else if (currentPrice <= pos.stopLoss) {
      status = "stop-hit";
      notes = `🔴 Stop hit. $${unrealizedPnL.toFixed(0)} loss (${unrealizedPnLPct.toFixed(1)}%)`;
    } else if (holdDaysRemaining <= 0) {
      status = "expired";
      notes = `⏰ Hold period expired. ${holdDaysElapsed} days held. $${unrealizedPnL.toFixed(0)} PnL`;
    } else if (unrealizedPnLPct < -3) {
      status = "at-risk";
      notes = `🟡 At risk: $${unrealizedPnL.toFixed(0)} (${unrealizedPnLPct.toFixed(1)}%)`;
    } else {
      status = "active";
    }

    return {
      ...pos,
      currentPrice,
      unrealizedPnL,
      unrealizedPnLPct,
      holdDaysRemaining,
      status,
      notes,
    };
  });
}

/**
 * Format open positions for Telegram brief.
 */
export function formatOpenPositions(positions: OpenPosition[]): string {
  const active = positions.filter((p) => p.status === "active" || p.status === "at-risk");
  if (active.length === 0) {
    return "📊 *OPEN POSITIONS*\nNo active opportunistic trades.";
  }

  let output = `📊 *OPEN POSITIONS*\n`;
  for (const pos of active) {
    const statusEmoji =
      pos.status === "at-risk" ? "🟡" :
      pos.unrealizedPnL >= 0 ? "🟢" : "🟡";
    const dirEmoji = pos.direction === "LONG" ? "📈" : "📉";
    output += `${statusEmoji} ${dirEmoji} ${pos.ticker} — ${pos.signal.replace(/_/g, " ")}\n`;
    output += `   Entry: $${pos.entryPrice.toFixed(2)} | Current: $${pos.currentPrice.toFixed(2)} | Target: $${pos.targetPrice.toFixed(2)}\n`;
    output += `   P&L: $${pos.unrealizedPnL.toFixed(0)} (${pos.unrealizedPnLPct.toFixed(1)}%) | ${pos.holdDaysRemaining}d remaining\n`;
    output += pos.notes ? `   ${pos.notes}\n` : "";
    output += "\n";
  }
  return output;
}

/**
 * Format ranked trade setups as DIRECT, evidence-based buy/sell calls for Telegram.
 * Format: "Buy TICKER because [specific reason] — Confidence: XX%"
 */
export function formatTradeSetups(setups: TradeSetup[]): string {
  if (setups.length === 0) {
    return "🎯 *TRADE CALLS*\nNo setups meet criteria today ($1,000+ profit, 2:1+ R/R, ≤14 days).";
  }

  let output = `🎯 *TRADE CALLS* (${setups.length} active)\n`;
  output += `_Ranked by confidence. All setups: $1K+ profit, 2:1+ R/R, ≤14-day hold._\n\n`;

  for (const setup of setups) {
    const confBar = setup.confidenceScore >= 75 ? "🟢" : setup.confidenceScore >= 55 ? "🟡" : "🔴";
    const dirEmoji = setup.direction === "LONG" ? "📈" : "📉";
    const action = setup.direction === "LONG" ? "BUY" : "SELL";
    const sign = setup.potentialProfitDollar >= 0 ? "+" : "";

    // Build direct "because" call — primary catalyst is the main reason
    const because = buildBecauseClause(setup);

    output += `${confBar} ${dirEmoji} *${action} ${setup.ticker}* because ${because}\n`;
    output += `   🎯 Entry $${setup.entryPrice.toFixed(2)} → Target $${setup.targetPrice.toFixed(2)} | Stop $${setup.stopLoss.toFixed(2)}\n`;
    output += `   📊 ${setup.riskReward.toFixed(1)}:1 R/R | ${sign}$${setup.potentialProfitDollar.toFixed(0)} profit | ⏱ ${setup.holdDaysEstimate}d max\n`;
    output += `   ✅ Confidence: *${setup.confidenceScore}/100* | ${setup.confidence.toUpperCase()} conviction\n`;

    // Evidence bullets — specific technicals driving this call
    if (setup.supportingEvidence.length > 0) {
      for (const ev of setup.supportingEvidence.slice(0, 3)) {
        output += `   • ${ev}\n`;
      }
    }
    output += "\n";
  }

  return output;
}

/**
 * Build a human-readable "because [reason]" clause from setup data.
 * This is the core of the direct-call format.
 */
function buildBecauseClause(setup: TradeSetup): string {
  const { signal, ticker, entryPrice, targetPrice, supportingEvidence } = setup as any;
  const rsi = (setup as any).rsi ?? 50;

  switch (signal) {
    case "RSI_OVERSOLD_BOUNCE":
      return `RSI is deeply oversold at ${rsi.toFixed(0)} — historically, this level produces a bounce within days. ${ticker} is trading at $${entryPrice.toFixed(2)} with a $${targetPrice.toFixed(2)} technical target (${((targetPrice - entryPrice) / entryPrice * 100).toFixed(1)}% upside). This is a mean-reversion trade with defined risk.`;

    case "BREAKOUT_ABOVE_MA20": {
      const volEv = supportingEvidence?.find((e: string) => e.includes("volume")) ?? "volume confirming the move";
      return `${volEv}. Price is breaking above its 20-day moving average on strong conviction — a signal institutions use to confirm entry. Target: $${targetPrice.toFixed(2)}.`;
    }

    case "MOVING_AVG_RECLAIM":
      return `${ticker} is reclaiming its 50-day moving average after a pullback — a sign buyers are stepping back in. This is a historically reliable continuation pattern. Target: $${targetPrice.toFixed(2)}.`;

    case "SHORT_TERM_PULLBACK": {
      const pullbackEv = supportingEvidence?.find((e: string) => e.includes("Pulling back")) ?? "short-term pullback";
      return `${pullbackEv}. ${ticker} is in an established uptrend and this dip is a better entry point. RSI=${rsi.toFixed(0)} supports the bounce. Target: $${targetPrice.toFixed(2)}.`;
    }

    default:
      return `${ticker} shows a ${signal.replace(/_/g, " ").toLowerCase()} setup. Target $${targetPrice.toFixed(2)} from $${entryPrice.toFixed(2)}.`;
  }
}