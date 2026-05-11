// === Core Types ===

export interface Transaction {
  date: string;
  description: string;
  amount: number;
  category: string;
  merchant?: string;
}

export interface BudgetCategory {
  name: string;
  limit: number;
  alertThreshold: number;
  spent: number;
  remaining: number;
  percentUsed: number;
  status: "ok" | "warning" | "exceeded";
}

export interface BudgetPacingReport {
  month: string;
  totalBudget: number;
  totalSpent: number;
  categories: BudgetCategory[];
  savingsRate: number;
  status: "on-track" | "over-budget" | "under-budget";
}

export interface Position {
  ticker: string;
  shares: number;
  avgCost: number;
  currentPrice: number;
  marketValue: number;
  dayChange: number;
  dayChangePercent: number;
  weight: number;
  targetWeight: number;
  drift: number;
  status: "on-target" | "drifted" | "black-swan";
  rsi?: number;
}

export interface MarketData {
  ticker: string;
  price: number;
  previousClose: number;
  change: number;
  changePercent: number;
  rsi: number;
  ma20: number;
  ma50: number;
  ma50Slope?: number; // 5-day % change in MA50 — positive = rising, negative = falling
  ma200?: number; // 200-day moving average — used for MOMENTUM_EXTENDED peak detection
  volume: number;
  volumeAvg: number;
  fiftyTwoWeekHigh?: number; // 52-week high — used for PEAK_ZONE detection
  status: "bull" | "bear" | "neutral";
  signals: string[];
}

export interface TradeRecommendation {
  action: "BUY" | "SELL" | "HOLD";
  ticker: string;
  shares?: number;
  dollarAmount?: number;
  reason: string;
  confidence: "high" | "medium" | "low";
  requiresConfirmation: boolean;
  type: "rebalance" | "profit-maximizer" | "black-swan";
}

export interface ProfitMaximizerIdea {
  ticker: string;
  setup: string;
  entryPrice: number;
  targetPrice: number;
  stopLoss: number;
  riskReward: number;
  confidence: "high" | "medium" | "low";
  catalyst: string;
}

export interface BriefSection {
  title: string;
  content: string;
  priority: "high" | "medium" | "low";
  requiresAction: boolean;
  actionText?: string;
}

export interface MorningBrief {
  date: string;
  liquidity: {
    cashAvailable: number;
    cashTarget: number;
    status: "surplus" | "deficit" | "balanced";
  };
  budgetPacing: BudgetPacingReport;
  marketSummary: {
    overnightShift: string;
    biggestMover: { ticker: string; change: number };
    overallSignal: "bull" | "bear" | "neutral";
  };
  portfolioPositions: Position[];
  recommendations: TradeRecommendation[];
  profitMaximizer: ProfitMaximizerIdea[];
  swingPool?: {
    cashAvailable: number;
    positions: any[];
    realizedPnL: number;
  };
  coreAccumulation?: {
    ticker: string;
    action: string;
    reason: string;
  }[];
  investorOutput?: {
    buffettLensed: any[];
    grahamLensed: any[];
    rejected: any[];
  };
  scheduledActions: {
    type: string;
    description: string;
    requiresConfirmation: boolean;
  }[];
}

// === Portfolio & Drift Config (loaded from recommendations.ts — single source of truth) ===

export interface PortfolioTargets {
  VTI: number; NVDA: number; VOO: number; QQQ: number;
  SMH: number; SCHG: number; VXUS: number; SCHD: number;
  SPYD: number; ASTS: number; SPAXX: number;
}

export interface DriftThresholds {
  VTI: number; NVDA: number; VOO: number; QQQ: number;
  SMH: number; SCHG: number; VXUS: number; SCHD: number;
  SPYD: number; ASTS: number; SPAXX: number;
}

// === Fidelity Types ===

export interface PortfolioEntry {
  shares: number;
  note?: string;
}

export interface PortfolioStatic {
  lastUpdated: string;
  note: string;
  positions: {
    VTI: PortfolioEntry; NVDA: PortfolioEntry; VOO: PortfolioEntry; QQQ: PortfolioEntry;
    SMH: PortfolioEntry; SCHG: PortfolioEntry; VXUS: PortfolioEntry; SCHD: PortfolioEntry;
    SPYD: PortfolioEntry; ASTS: PortfolioEntry; SPAXX: PortfolioEntry;
  };
  targetAllocation: PortfolioTargets;
}

export interface FidelityAlert {
  type: "transfer" | "trade_confirmation" | "balance_alert";
  subject: string;
  date: string;
  amount?: number;
  balance?: number;
  ticker?: string;
  shares?: number;
  action?: "BUY" | "SELL";
  rawSnippet: string;
}

export interface BalanceVerification {
  ticker: string;
  agentValue: number;
  fidelityValue: number;
  difference: number;
  withinThreshold: boolean;
}

export interface BudgetLimits {
  dining: number;
  transportation: number;
  subscriptions: number;
  discretionary: number;
  /** Weekly auto-debit to Fidelity brokerage: SCHG $150 + NVDA $50 + SMH $50 + VTI $50 = $300/week */
  fidelity: number;
  /** Fixed monthly rent (excluded from pacing category display, included in savings rate calc) */
  rent: number;
  savingsRateTarget: number;
}

// === Ticker Scopes ===

export const PORTFOLIO_TICKERS = ["VTI", "NVDA", "VOO", "QQQ", "SMH", "XLE", "XLV", "AMGN", "CVX", "COIN", "VXUS", "SCHD", "ASTS", "SPAXX"] as const;
export const MACRO_TICKERS = ["SPY", "QQQ", "DXY", "TLT", "GLD"] as const;

/**
 * WATCHLIST_TICKERS — 42 stocks across 9 sectors for entry/exit scanning.
 * Philosophy: scan a wide field so we catch every dip worth buying and every peak worth selling.
 * - Each sector: 2-9 tickers — enough to find the BEST entry, not just ANY entry
 * - Only actionable tickers: RSI oversold bounces, breakout pullsback to MA, gap fills
 * - No penny stocks (<$5), no illiquid tickers
 *
 * Category breakdown:
 *   Semi (9):   AMD, TSM, ASML, INTC, QCOM, AMAT, LRCX, MU, KLAC
 *   Tech (8):   AVGO, MRVL, PANW, MPWR, SNPS, CDNS, ON, SWKS
 *   Industrials (5): CAT, BA, LMT, RTX, GD
 *   Healthcare (4): UNH, JNJ, ABBV, AMGN
 *   Finance (3): JPM, BAC, GS
 *   Energy (3): XLE, CVX, XOM
 *   Cons/Retail (3): COST, WMT, PG
 *   Alternatives (2): GLD, SLV
 *   Semi-adjacent (1): NXPI
 */
export const WATCHLIST_TICKERS = [
  // Semi — 9 tickers (core of AI infrastructure theme)
  "AMD", "TSM", "ASML", "INTC", "QCOM", "AMAT", "LRCX", "MU", "KLAC", "COIN",
  // Tech — 8 tickers (picks-and-shovels + enterprise)
  "AVGO", "MRVL", "PANW", "MPWR", "SNPS", "CDNS", "ON", "SWKS",
  // Industrials — 5 tickers (defense + infrastructure capex)
  "CAT", "BA", "LMT", "RTX", "GD",
  // Healthcare — 4 tickers (stable growth + dividends)
  "UNH", "JNJ", "ABBV", "AMGN",
  // Finance — 3 tickers (buffett-lensed value)
  "JPM", "BAC", "GS",
  // Energy — 3 tickers (reflation play + dividends)
  "XLE", "CVX", "XOM",
  // Consumer — 3 tickers (stable dividends + growth)
  "COST", "WMT", "PG",
  // Alternatives — 2 tickers (gold + silver hedge)
  "GLD", "SLV",
  // Semi-adjacent — 1 ticker
  "NXPI",
  // Portfolio satellite ETFs — sector rotation plays (XLE/XLV already held, VHT/XLB for sector entry)
  "XLE", "XLV", "VHT", "XLB",
] as const;

export const SECTOR_TICKERS = [
  "AMD", "TSM", "ASML", "INTC", "QCOM", "AMAT", "LRCX", "MU", "SOXX", "SMH",
  "AVGO", "MRVL", "PANW", "MPWR", "CDNS", "SNPS", "ON", "LSCC", "ENTG", "SWKS",
  "XLE", "XLI", "XLB", "VHT", "VBR", "AVUV",
] as const;

export const TICKERS = [...PORTFOLIO_TICKERS] as string[];

/**
 * EXPENSE RATIOS — annual fee as decimal percentage for each ETF/fund.
 * Only applies to ETFs. Individual stocks (NVDA, AMGN, ASTS) = 0.
 * Thresholds: <0.10% = cheap, 0.10-0.20% = acceptable, >0.20% = flag for review.
 * Context matters: SMH at 0.35% is worth it if semi thesis delivers alpha.
 */
export const EXPENSE_RATIOS: Record<string, number> = {
  // Portfolio ETFs
  "VTI": 0.0003,   // Vanguard Total Stock Market
  "VOO": 0.0003,   // Vanguard S&P 500
  "QQQ": 0.0020,   // Invesco QQQ
  "SCHG": 0.0004,  // Schwab US Large-Cap Growth
  "SMH": 0.0035,   // VanEck Semiconductor
  "XLE": 0.0009,   // Energy Select Sector SPDR
  "XLV": 0.0009,   // Health Care Select Sector SPDR
  "VXUS": 0.0004,  // Vanguard Total International Stock
  "SCHD": 0.0006,  // Schwab US Dividend Equity
  "SPYD": 0.0007,  // SPDR Portfolio High Yield
  "SPAXX": 0.0042, // Fidelity Government Money Market (7-day yield, not ER — approximates as opportunity cost)
  // Macro ETFs
  "SPY": 0.000945, // SPDR S&P 500
  "TLT": 0.0015,   // iShares 20+ Year Treasury
  "GLD": 0.0040,   // SPDR Gold
  // Sector scan ETFs
  "SOXX": 0.0035,  // iShares Semiconductor
  "XLI": 0.0009,   // Industrial Select Sector
  "XLB": 0.0009,   // Materials Select Sector
  "VHT": 0.0009,   // Vanguard Health Care
  "VBR": 0.0007,   // Vanguard Small-Cap Value
  "AVUV": 0.0025,  // Avantis US Small Cap Value
};

/** Max acceptable ER before flagging (0.20%) */
export const ER_FLAG_THRESHOLD = 0.0020;

/** Compute annual fee drag in dollars for a given position */
export function computeFeeDrag(marketValue: number, ticker: string): { annualFee: number; er: number; flagged: boolean } {
  const er = EXPENSE_RATIOS[ticker] ?? 0;
  const annualFee = marketValue * er;
  return {
    annualFee: Math.round(annualFee * 100) / 100,
    er,
    flagged: er > ER_FLAG_THRESHOLD && er > 0,
  };
}
