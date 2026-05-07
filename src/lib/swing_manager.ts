import { TradeSetup } from "./recommendations";
import * as fs from "fs";
import * as path from "path";

// ═══════════════════════════════════════════════════════════════════════════════
// SWING CAPITAL MANAGER
// Manages satellite swing trades separately from core long-term holdings.
// Philosophy: core portfolio is VTI/VOO/QQQ (untouched). New capital (weekly $300
// auto-invest + any swing profits) is deployed into swing positions. Proceeds
// from swing exits go back into core holdings (VTI/VOO/QQQ) or fresh swings.
// ═══════════════════════════════════════════════════════════════════════════════

/** Max concurrent swing positions at any time */
export const MAX_CONCURRENT_SWINGS = 2;

/** Max capital deployed per swing */
export const MAX_SWING_SIZE_DOLLARS = 3000;

/** Hard stop loss on any swing */
export const SWING_STOP_PCT = 0.05; // 5% stop

/** Target exit — take profit when RSI hits this */
export const SWING_TAKE_PROFIT_RSI = 68;

/** Target gain % for swing exit */
export const SWING_TARGET_GAIN_PCT = 0.10; // 10% target

/** Max hold days per swing */
export const SWING_MAX_HOLD_DAYS = 14;

/** Core accumulation trigger — buy VOO/VTI when RSI > 60 and market is bull */
export const CORE_ACCUMULATION_RSI = 60;

export interface SwingPosition {
  ticker: string;
  shares: number;
  entryPrice: number;
  entryDate: string;
  targetPrice: number;
  stopLoss: number;
  signal: string;
  confidenceScore: number;
  riskReward: number;
  notes: string;
}

export interface SwingState {
  capital: number;
  positions: SwingPosition[];
  realizedPnL: number;
  lastUpdated: string;
}

const SWING_STATE_FILE = path.join(__dirname, "../../data/swing_state.json");

export function loadSwingState(): SwingState {
  if (fs.existsSync(SWING_STATE_FILE)) {
    const raw = fs.readFileSync(SWING_STATE_FILE, "utf8");
    return JSON.parse(raw);
  }
  return { capital: 0, positions: [], realizedPnL: 0, lastUpdated: new Date().toISOString() };
}

function saveSwingState(state: SwingState): void {
  fs.writeFileSync(SWING_STATE_FILE, JSON.stringify(state, null, 2));
}

/** Add new weekly capital to swing pool */
export function addSwingCapital(amount: number): void {
  const state = loadSwingState();
  state.capital += amount;
  state.lastUpdated = new Date().toISOString();
  saveSwingState(state);
  console.log(`[SWING] +$${amount.toFixed(2)} added to swing pool. Pool total: $${state.capital.toFixed(2)}`);
}

/** Check if a setup is a valid swing candidate */
export function isSwingCandidate(setup: TradeSetup): boolean {
  const state = loadSwingState();
  if (state.positions.length >= MAX_CONCURRENT_SWINGS) {
    console.log(`[SWING] Max concurrent swings (${MAX_CONCURRENT_SWINGS}) reached — skipping ${setup.ticker}`);
    return false;
  }
  if (setup.confidenceScore < 60) {
    console.log(`[SWING] ${setup.ticker} confidence ${setup.confidenceScore} < 60 — insufficient conviction`);
    return false;
  }
  if (setup.signal === "EARNINGS_MOMENTUM") {
    console.log(`[SWING] ${setup.ticker} is an earnings momentum play — not a swing candidate`);
    return false;
  }
  return true;
}

/** Size a swing position — returns shares to buy */
export function sizeSwingPosition(setup: TradeSetup): number {
  const state = loadSwingState();
  const available = Math.min(state.capital, MAX_SWING_SIZE_DOLLARS);
  // Risk no more than 2% of estimated portfolio value per swing
  const maxRiskDollar = 600; // ~2% of $30K swing pool reference
  const dollarRisk = setup.entryPrice - setup.stopLoss;
  if (dollarRisk <= 0) return 0;
  return Math.floor(Math.min(available / setup.entryPrice, maxRiskDollar / dollarRisk));
}

/** Open a swing position from a setup */
export function openSwingPosition(setup: TradeSetup, shares: number): void {
  const state = loadSwingState();
  const cost = shares * setup.entryPrice;
  if (cost > state.capital) {
    console.log(`[SWING] Insufficient capital: $${cost.toFixed(2)} needed, $${state.capital.toFixed(2)} available`);
    return;
  }
  const position: SwingPosition = {
    ticker: setup.ticker,
    shares,
    entryPrice: setup.entryPrice,
    entryDate: new Date().toISOString(),
    targetPrice: setup.targetPrice,
    stopLoss: setup.stopLoss,
    signal: setup.signal,
    confidenceScore: setup.confidenceScore,
    riskReward: setup.riskReward,
    notes: `Swing entry: ${setup.signal}`,
  };
  state.capital -= cost;
  state.positions.push(position);
  state.lastUpdated = new Date().toISOString();
  saveSwingState(state);
  console.log(`[SWING] Opened ${setup.ticker} swing: ${shares} shares @ $${setup.entryPrice.toFixed(2)} | Cost: $${cost.toFixed(2)} | Remaining capital: $${state.capital.toFixed(2)}`);
}

/** Check swing positions against live prices — update status */
export function checkSwingPositions(quotes: Map<string, { price: number; rsi: number }>): {
  closed: SwingPosition[];
  updated: SwingPosition[];
  atRisk: SwingPosition[];
} {
  const state = loadSwingState();
  const now = new Date();
  const closed: SwingPosition[] = [];
  const updated: SwingPosition[] = [];
  const atRisk: SwingPosition[] = [];

  state.positions = state.positions.filter((pos) => {
    const quote = quotes.get(pos.ticker);
    if (!quote) return true; // keep if no live quote

    const currentPrice = quote.price;
    const entryDate = new Date(pos.entryDate);
    const holdDays = Math.floor((now.getTime() - entryDate.getTime()) / (1000 * 60 * 60 * 24));
    const pnl = (currentPrice - pos.entryPrice) * pos.shares;
    const pnlPct = (currentPrice - pos.entryPrice) / pos.entryPrice;

    // Take profit: price hit target OR RSI overbought
    if (currentPrice >= pos.targetPrice || quote.rsi >= SWING_TAKE_PROFIT_RSI) {
      const proceeds = currentPrice * pos.shares;
      state.capital += proceeds;
      state.realizedPnL += pnl;
      closed.push({ ...pos, notes: `✅ Target hit: +$${pnl.toFixed(0)} (${(pnlPct * 100).toFixed(1)}%) in ${holdDays}d` });
      console.log(`[SWING] ${pos.ticker} closed at $${currentPrice.toFixed(2)}: +$${pnl.toFixed(0)}`);
      return false;
    }

    // Stop loss hit
    if (currentPrice <= pos.stopLoss) {
      const proceeds = currentPrice * pos.shares;
      state.capital += proceeds;
      state.realizedPnL += pnl;
      closed.push({ ...pos, notes: `🔴 Stop hit: $${pnl.toFixed(0)} (${(pnlPct * 100).toFixed(1)}%) in ${holdDays}d` });
      console.log(`[SWING] ${pos.ticker} stopped out at $${currentPrice.toFixed(2)}: $${pnl.toFixed(0)}`);
      return false;
    }

    // Hold period expired
    if (holdDays >= SWING_MAX_HOLD_DAYS) {
      const proceeds = currentPrice * pos.shares;
      state.capital += proceeds;
      state.realizedPnL += pnl;
      closed.push({ ...pos, notes: `⏰ Expired: $${pnl.toFixed(0)} (${(pnlPct * 100).toFixed(1)}%) in ${holdDays}d` });
      console.log(`[SWING] ${pos.ticker} hold period expired: $${pnl.toFixed(0)}`);
      return false;
    }

    // At risk — down more than 3%
    if (pnlPct < -0.03) {
      atRisk.push({ ...pos, notes: `🟡 At risk: $${pnl.toFixed(0)} (${(pnlPct * 100).toFixed(1)}%) — ${holdDays}d elapsed` });
    } else {
      updated.push({ ...pos, notes: `🟢 Active: $${pnl.toFixed(0)} (${(pnlPct * 100).toFixed(1)}%) — ${holdDays}d elapsed` });
    }

    return true; // keep position open
  });

  state.lastUpdated = now.toISOString();
  saveSwingState(state);
  return { closed, updated, atRisk };
}

/** Check if core holdings (VOO/VTI/QQQ) are in accumulation zone */
export function checkCoreAccumulation(quotes: Map<string, { price: number; rsi: number; changePercent: number }>): {
  ticker: string;
  action: string;
  reason: string;
}[] {
  const coreTickers = ["VOO", "VTI", "QQQ"];
  const signals: { ticker: string; action: string; reason: string }[] = [];

  for (const ticker of coreTickers) {
    const quote = quotes.get(ticker);
    if (!quote) continue;

    // Accumulate when RSI > 60 and price is in uptrend
    if (quote.rsi > CORE_ACCUMULATION_RSI && quote.changePercent > 0) {
      signals.push({
        ticker,
        action: "ACCUMULATE",
        reason: `RSI=${quote.rsi.toFixed(0)} (above ${CORE_ACCUMULATION_RSI} accumulation zone), price trending up +${quote.changePercent.toFixed(1)}% today. Add to core position on this pullback.`,
      });
    }

    // Strong accumulation signal — RSI in 55-65 range is ideal entry
    if (quote.rsi >= 55 && quote.rsi <= 65 && quote.changePercent > 0.5) {
      signals.push({
        ticker,
        action: "ACCUMULATE",
        reason: `Ideal accumulation zone: RSI=${quote.rsi.toFixed(0)} in 55-65 range, +${quote.changePercent.toFixed(1)}% today. Historical data shows buying VOO/VTI in this RSI band produces best risk-adjusted returns.`,
      });
    }

    // Defer buying — market overextended (RSI > 75 = extended)
    if (quote.rsi > 75) {
      signals.push({
        ticker,
        action: "DEFER",
        reason: `RSI=${quote.rsi.toFixed(0)} — extended rally. Defer new VOO/VTI/QQQ purchases until RSI pulls back below 70. Re-enter on next pullback to RSI 55-65.`,
      });
    }
  }

  return signals;
}

/** Format swing state for brief output */
export function formatSwingState(): string {
  const state = loadSwingState();
  let out = `📊 *SWING POOL*\n`;
  out += `Available capital: $${state.capital.toFixed(2)}\n`;
  out += `Realized P&L: ${state.realizedPnL >= 0 ? "+" : ""}$${state.realizedPnL.toFixed(2)}\n`;
  out += `Active swings: ${state.positions.length}/${MAX_CONCURRENT_SWINGS}\n\n`;

  for (const pos of state.positions) {
    out += `📈 ${pos.ticker} | ${pos.signal}\n`;
    out += `   Entry: $${pos.entryPrice.toFixed(2)} | Target: $${pos.targetPrice.toFixed(2)} | Stop: $${pos.stopLoss.toFixed(2)}\n`;
    out += `   ${pos.notes}\n\n`;
  }

  return out;
}

/** Format core accumulation signals for brief output */
export function formatCoreAccumulation(signals: { ticker: string; action: string; reason: string }[]): string {
  if (signals.length === 0) return "";

  let out = `🏦 *CORE ACCUMULATION*\n`;
  for (const s of signals) {
    const emoji = s.action === "DEFER" ? "⏸" : "✅";
    out += `${emoji} *${s.action} ${s.ticker}*\n   ${s.reason}\n\n`;
  }
  return out;
}

/** Cash proceeds from closed swings — log where they go */
export function logSwingProceeds(pnl: number, destination: "VOO" | "VTI" | "QQQ" | "cash"): void {
  console.log(`[SWING] $${pnl >= 0 ? "+" : ""}${pnl.toFixed(2)} realized. Destination: ${destination}`);
  // In a full implementation this would trigger a standing order or notify Mathew
}