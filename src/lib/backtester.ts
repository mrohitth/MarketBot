/**
 * backtester.ts — Validate the advisor engine against historical price data.
 *
 * Replays generateTradeSetups() logic on historical bars and reports:
 * - Win rate (% of setups that hit target before stop or expiry)
 * - Average R/R on winners vs losers
 * - % of setups that hit target, stopped out, or expired
 * - Average hold days to target / stop
 * - Per-ticker breakdown + aggregate summary
 *
 * Run manually: npx ts-node src/lib/backtester.ts
 * Default range: last 90 trading days (configurable via CLI)
 */

import { generateTradeSetups, TradeSetup } from "./recommendations";
import { MarketData } from "./types";

// ── Config ────────────────────────────────────────────────────────────────────

const DEFAULT_DAYS = 90;
const DEFAULT_PORTFOLIO_VALUE = 43758; // matches current portfolio
const MAX_HOLD_DAYS = 14;

// ── Types ─────────────────────────────────────────────────────────────────────

interface BacktestResult {
  ticker: string;
  totalSetups: number;
  winners: number;
  losers: number;
  expired: number;
  avgHoldDays: number;
  avgRiskReward: number;
  winRate: number;
  avgWinnerRR: number;
  avgLoserRR: number;
}

interface SetupTrade {
  setup: TradeSetup;
  entryDate: string;
  entryPrice: number;
  exitDate?: string;
  exitPrice?: number;
  exitReason?: "target" | "stop" | "expired";
  realizedRR?: number;
  realizedProfitDollar?: number;
  holdDays: number;
}

// ── Data Fetching ─────────────────────────────────────────────────────────────

interface DailyBar {
  date: string;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  ticker?: string; // set by caller when building history
}

interface TickerHistory {
  ticker: string;
  bars: DailyBar[];
}

/**
 * Fetch historical daily bars for a ticker using yahoo-finance2 chart API.
 * Returns array of {date, open, high, low, close, volume}.
 */
async function fetchHistory(
  ticker: string,
  endDate: Date,
  days: number
): Promise<DailyBar[]> {
  const startDate = new Date(endDate.getTime() - days * 24 * 60 * 60 * 1000);
  const period1 = Math.floor(startDate.getTime() / 1000);
  const period2 = Math.floor(endDate.getTime() / 1000);

  try {
    const mod = await import("yahoo-finance2");
    const YF = (mod as any).default ?? mod;
    const yf = new YF({ suppressNotices: ["yahooSurvey"] });

    const result = await yf.chart(ticker, {
      period1,
      period2,
      interval: "1d",
    });

    const quotes = result?.quotes ?? [];
    return quotes
      .map((q: { date?: number; open?: number; high?: number; low?: number; close?: number; volume?: number }) => ({
        date: new Date((q.date ?? 0) * 1000).toISOString().split("T")[0],
        open: q.open ?? 0,
        high: q.high ?? 0,
        low: q.low ?? 0,
        close: q.close ?? 0,
        volume: q.volume ?? 0,
      }))
      .filter((b: DailyBar) => b.close > 0)
      .sort((a: DailyBar, b: DailyBar) => a.date.localeCompare(b.date));
  } catch (err) {
    console.error(`[BACKTEST] ${ticker}: failed to fetch history — ${err}`);
    return [];
  }
}

/**
 * Compute a rolling 20-day SMA from closing prices.
 */
function computeSMA(closes: number[], period: number): number[] {
  const sma: number[] = [];
  for (let i = 0; i < closes.length; i++) {
    if (i < period - 1) {
      sma.push(closes[i]); // placeholder — will be overwritten
      continue;
    }
    const slice = closes.slice(i - period + 1, i + 1);
    sma.push(slice.reduce((a, b) => a + b, 0) / period);
  }
  return sma;
}

/**
 * Compute Wilder's RSI from a close array.
 */
function computeRSI(closes: number[], period = 14): number[] {
  const rsi: number[] = [];
  if (closes.length < period + 1) {
    return closes.map(() => 50);
  }

  // First average: simple mean of first period changes
  let avgGain = 0;
  let avgLoss = 0;
  for (let i = 1; i <= period; i++) {
    const change = closes[i] - closes[i - 1];
    if (change > 0) avgGain += change;
    else avgLoss += Math.abs(change);
  }
  avgGain /= period;
  avgLoss /= period;

  for (let i = 0; i < period; i++) {
    rsi.push(50); // warm-up period
  }

  for (let i = period; i < closes.length; i++) {
    if (avgLoss === 0) {
      rsi.push(100);
    } else {
      const rs = avgGain / avgLoss;
      rsi.push(100 - 100 / (1 + rs));
    }
    // Wilder smoothing: update avgGain/loss for next bar
    const nextChange = closes[i + 1] - closes[i];
    const gain = nextChange > 0 ? nextChange : 0;
    const loss = nextChange < 0 ? Math.abs(nextChange) : 0;
    avgGain = (avgGain * (period - 1) + gain) / period;
    avgLoss = (avgLoss * (period - 1) + loss) / period;
  }

  return rsi;
}

/**
 * Convert raw daily bars into a MarketData-like quote for a given bar,
 * using rolling SMA/RSI computed from preceding bars.
 */
function buildQuote(
  bar: DailyBar,
  closes: number[],
  barIndex: number,
  ticker: string
): MarketData {
  const rsiValues = computeRSI(closes.slice(0, barIndex + 1));
  const rsi = rsiValues[rsiValues.length - 1];

  const sma20Values = computeSMA(closes.slice(0, barIndex + 1), 20);
  const ma20 = sma20Values[sma20Values.length - 1];

  const sma50Values = computeSMA(closes.slice(0, barIndex + 1), 50);
  const ma50 = sma50Values[sma50Values.length - 1];

  // Volume: compare to prior 20-day avg volume
  const priorVols = closes.slice(0, barIndex + 1).map((_, i) =>
    barIndex >= 20 ? (bar.volume / (i + 1)) * 20 : bar.volume
  );
  const volAvg = priorVols.length > 5
    ? priorVols.slice(-5).reduce((a, b) => a + b, 0) / 5
    : bar.volume;

  const changePct =
    barIndex > 0
      ? ((bar.close - closes[barIndex - 1]) / closes[barIndex - 1]) * 100
      : 0;

  return {
    ticker: (bar as any).ticker ?? ticker,
    price: bar.close,
    previousClose: barIndex > 0 ? closes[barIndex - 1] : bar.close,
    change: bar.close - (barIndex > 0 ? closes[barIndex - 1] : bar.close),
    changePercent: changePct,
    rsi,
    ma20: isNaN(ma20) ? bar.close : ma20,
    ma50: isNaN(ma50) ? bar.close : ma50,
    volume: bar.volume,
    volumeAvg: volAvg,
    status: changePct > 1 ? "bull" : changePct < -1 ? "bear" : "neutral",
    signals: [],
  };
}

// ── Core Backtest Engine ───────────────────────────────────────────────────────

async function runBacktest(tickers: string[], days: number) {
  console.log(`\n📊 BACKTEST — ${days} trading days | Tickers: ${tickers.join(", ")}`);
  console.log("═".repeat(60));

  const endDate = new Date();
  const results: BacktestResult[] = [];
  const allTrades: SetupTrade[] = [];

  for (const ticker of tickers) {
    const bars = await fetchHistory(ticker, endDate, days);
    if (bars.length < 60) {
      console.warn(`[BACKTEST] ${ticker}: only ${bars.length} bars — skipping (need 60+ for SMA50 warmup)`);
      continue;
    }

    // Tag bars with ticker for quote building
    for (const bar of bars) {
      (bar as any).ticker = ticker;
    }

    const closes = bars.map(b => b.close);
    const trades: SetupTrade[] = [];

    // Walk the bars, simulating the advisor at each point
    // Start at day 55 so SMA50 and RSI14 are warmed up
    for (let i = 55; i < bars.length - 1; i++) {
      const bar = bars[i];
      const quote = buildQuote(bar, closes, i, ticker);
      (quote as any).ticker = ticker;

      // Generate setups using same engine as live — no changes
      const setups = generateTradeSetups(quote, DEFAULT_PORTFOLIO_VALUE);

      for (const setup of setups) {
        if (setup.direction !== "LONG") continue; // only Long for now

        // Simulate entry: buy at next day's open
        const entryBar = bars[i + 1];
        const entryPrice = entryBar.open;
        const entryDate = entryBar.date;
        if (entryPrice === 0) continue;

        // Walk forward up to MAX_HOLD_DAYS looking for target or stop
        let exitDate: string | undefined;
        let exitPrice: number | undefined;
        let exitReason: "target" | "stop" | "expired" | undefined;

        for (let d = 1; d <= MAX_HOLD_DAYS && i + 1 + d < bars.length; d++) {
          const testBar = bars[i + 1 + d];

          // Stop hit
          if (testBar.low <= setup.stopLoss) {
            exitDate = testBar.date;
            exitPrice = setup.stopLoss;
            exitReason = "stop";
            break;
          }

          // Target hit
          if (testBar.high >= setup.targetPrice) {
            exitDate = testBar.date;
            exitPrice = setup.targetPrice;
            exitReason = "target";
            break;
          }
        }

        if (!exitDate) {
          // Expired — exit at last allowed bar close
          const lastBar = bars[Math.min(i + 1 + MAX_HOLD_DAYS, bars.length - 1)];
          exitDate = lastBar.date;
          exitPrice = lastBar.close;
          exitReason = "expired";
        }

        const realizedRR =
          (exitPrice! - entryPrice) / (entryPrice - setup.stopLoss);
        const realizedProfitDollar =
          (exitPrice! - entryPrice) * (DEFAULT_PORTFOLIO_VALUE * 0.02 / (entryPrice - setup.stopLoss));

        trades.push({
          setup,
          entryDate,
          entryPrice,
          exitDate,
          exitPrice,
          exitReason,
          realizedRR,
          realizedProfitDollar,
          holdDays: Math.round(
            (new Date(exitDate!).getTime() - new Date(entryDate).getTime()) /
              (24 * 60 * 60 * 1000)
          ),
        });
      }
    }

    allTrades.push(...trades);

    const winners = trades.filter(t => t.exitReason === "target").length;
    const losers = trades.filter(t => t.exitReason === "stop").length;
    const expired = trades.filter(t => t.exitReason === "expired").length;
    const total = trades.length || 1;

    const winnerRRs = trades
      .filter(t => t.exitReason === "target")
      .map(t => t.realizedRR ?? 0);
    const loserRRs = trades
      .filter(t => t.exitReason === "stop")
      .map(t => t.realizedRR ?? 0);

    results.push({
      ticker,
      totalSetups: trades.length,
      winners,
      losers,
      expired,
      avgHoldDays:
        trades.length > 0
          ? trades.reduce((s, t) => s + t.holdDays, 0) / trades.length
          : 0,
      avgRiskReward:
        trades.length > 0
          ? trades.reduce((s, t) => s + (t.realizedRR ?? 0), 0) / trades.length
          : 0,
      winRate: winners / total,
      avgWinnerRR:
        winnerRRs.length > 0 ? winnerRRs.reduce((a, b) => a + b, 0) / winnerRRs.length : 0,
      avgLoserRR:
        loserRRs.length > 0 ? loserRRs.reduce((a, b) => a + b, 0) : 0,
    });
  }

  // ── Per-Ticker Report ─────────────────────────────────────────────────────
  console.log("\n📈 PER-TICKER RESULTS");
  console.log("-".repeat(60));

  for (const r of results) {
    const wr = r.winRate;
    const wrEmoji = wr >= 0.65 ? "🟢" : wr >= 0.45 ? "🟡" : "🔴";
    console.log(
      `${wrEmoji} ${r.ticker.padEnd(6)} | ${r.totalSetups.toString().padStart(3)} setups | ` +
        `W: ${r.winners.toString().padStart(2)} L: ${r.losers.toString().padStart(2)} E: ${r.expired.toString().padStart(2)} | ` +
        `WR: ${(wr * 100).toFixed(0)}% | Avg R/R: ${r.avgRiskReward.toFixed(2)} | ` +
        `Avg Hold: ${r.avgHoldDays.toFixed(1)}d`
    );
  }

  // ── Aggregate Summary ─────────────────────────────────────────────────────
  const totalTrades = results.reduce((s, r) => s + r.totalSetups, 0);
  const totalWinners = results.reduce((s, r) => s + r.winners, 0);
  const totalLosers = results.reduce((s, r) => s + r.losers, 0);
  const totalExpired = results.reduce((s, r) => s + r.expired, 0);

  const allWinnerRRs = allTrades
    .filter(t => t.exitReason === "target")
    .map(t => t.realizedRR ?? 0)
    .filter(r => r > 0);
  const allLoserRRs = allTrades
    .filter(t => t.exitReason === "stop")
    .map(t => t.realizedRR ?? 0)
    .filter(r => r < 0);

  const aggregateWinRate = totalTrades > 0 ? totalWinners / totalTrades : 0;
  const avgAllRR =
    allTrades.length > 0
      ? allTrades.reduce((s, t) => s + (t.realizedRR ?? 0), 0) / allTrades.length
      : 0;
  const avgWinnerRR =
    allWinnerRRs.length > 0
      ? allWinnerRRs.reduce((a, b) => a + b, 0) / allWinnerRRs.length
      : 0;
  const avgLoserRR =
    allLoserRRs.length > 0
      ? allLoserRRs.reduce((a, b) => a + b, 0) / allLoserRRs.length
      : 0;

  console.log("\n📊 AGGREGATE SUMMARY");
  console.log("═".repeat(60));
  console.log(
    `   Total Setups:     ${totalTrades.toString().padStart(4)} | ` +
      `Winners: ${totalWinners.toString().padStart(3)} | ` +
      `Losers: ${totalLosers.toString().padStart(3)} | ` +
      `Expired: ${totalExpired.toString().padStart(3)}`
  );
  console.log(
    `   Win Rate:         ${(aggregateWinRate * 100).toFixed(1)}% | ` +
      `Avg R/R: ${avgAllRR.toFixed(2)} | ` +
      `Avg Winner R/R: +${avgWinnerRR.toFixed(2)} | ` +
      `Avg Loser R/R: ${avgLoserRR.toFixed(2)}`
  );

  // Signal-type breakdown
  const bySignal: Record<string, { total: number; winners: number; losers: number }> = {};
  for (const t of allTrades) {
    const sig = t.setup.signal;
    if (!bySignal[sig]) bySignal[sig] = { total: 0, winners: 0, losers: 0 };
    bySignal[sig].total++;
    if (t.exitReason === "target") bySignal[sig].winners++;
    else if (t.exitReason === "stop") bySignal[sig].losers++;
  }

  console.log("\n🎯 SIGNAL-TYPE BREAKDOWN");
  console.log("-".repeat(60));
  for (const [sig, data] of Object.entries(bySignal).sort((a, b) => b[1].total - a[1].total)) {
    const wr = data.total > 0 ? data.winners / data.total : 0;
    const wrEmoji = wr >= 0.65 ? "🟢" : wr >= 0.45 ? "🟡" : "🔴";
    console.log(
      `${wrEmoji} ${sig.padEnd(25)} | n=${data.total.toString().padStart(3)} | ` +
        `W: ${data.winners.toString().padStart(3)} L: ${data.losers.toString().padStart(3)} | ` +
        `WR: ${(wr * 100).toFixed(0)}%`
    );
  }

  // Verdict
  console.log("\n🏁 VERDICT");
  console.log("═".repeat(60));
  if (aggregateWinRate >= 0.55 && avgAllRR >= 1.5) {
    console.log("✅ ADVISOR ENGINE IS VALID — win rate and R/R both meet thresholds");
    console.log(`   Recommendation: keep current rules, they have historical edge.`);
  } else if (aggregateWinRate < 0.40) {
    console.log("🔴 ADVISOR ENGINE NEEDS TUNING — win rate below 40%, rules are too loose");
    console.log(`   Recommendation: tighten RSI_OVERSOLD threshold, require volume confirmation.`);
  } else {
    console.log("🟡 ADVISOR ENGINE MIXED — has edge but R/R or win rate below target");
    console.log(`   Recommendation: review expired setups — too many setups not hitting target/stop within 14 days.`);
  }

  console.log(`\n📅 Backtest period: last ${days} trading days | Portfolio假设: $${DEFAULT_PORTFOLIO_VALUE.toLocaleString()}`);
  console.log(`⏱ Run at: ${new Date().toISOString()}`);
}

// ── CLI ────────────────────────────────────────────────────────────────────────

const args = process.argv.slice(2);
const daysArg = args.find(a => a.startsWith("--days="));
const tickersArg = args.find(a => a.startsWith("--tickers="));
const days = daysArg ? parseInt(daysArg.split("=")[1]) : DEFAULT_DAYS;

const DEFAULT_TICKERS = [
  "VTI", "NVDA", "VOO", "QQQ", "SMH",
  "SCHG", "VXUS", "SCHD", "SPYD", "ASTS",
];
const tickers = tickersArg
  ? tickersArg.split("=")[1].split(",")
  : DEFAULT_TICKERS;

runBacktest(tickers, days).catch(err => {
  console.error("[BACKTEST] Fatal error:", err);
  process.exit(1);
});