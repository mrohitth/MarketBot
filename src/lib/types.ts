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
  volume: number;
  volumeAvg: number;
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
  scheduledActions: {
    type: string;
    description: string;
    requiresConfirmation: boolean;
  }[];
}

// === Configuration Types ===

export interface PortfolioTargets {
  VTI: number; NVDA: number; VOO: number; QQQ: number;
  SMH: number; SCHG: number; VXUS: number; SCHD: number;
  SPYD: number; ASTS: number; CASH: number;
}

export interface DriftThresholds {
  VTI: number; NVDA: number; VOO: number; QQQ: number;
  SMH: number; SCHG: number; VXUS: number; SCHD: number;
  SPYD: number; ASTS: number;
}

// === Tickers ===

export const PORTFOLIO_TICKERS = ["VTI", "NVDA", "VOO", "QQQ", "SMH", "SCHG", "VXUS", "SCHD", "SPYD", "ASTS"] as const;
export const MACRO_TICKERS = ["SPY", "QQQ", "DXY", "TLT", "GLD"] as const;
export const SECTOR_TICKERS = [
  "AMD", "TSM", "ASML", "INTC", "QCOM", "AMAT", "LRCX", "MU", "SOXX", "SMH",
  "AVGO", "MRVL", "PANW", "MPWR", "CDNS", "SNPS", "ON", "LSCC", "ENTG", "SWKS",
] as const;

export const TICKERS = PORTFOLIO_TICKERS;

export const PORTFOLIO_TARGETS: PortfolioTargets = {
  VTI: 0.20, NVDA: 0.20, VOO: 0.18, QQQ: 0.14, SMH: 0.10, SCHG: 0.08,
  VXUS: 0.06, SCHD: 0.05, SPYD: 0.01, ASTS: 0.01, CASH: 0.07,
};

export const DRIFT_THRESHOLDS: DriftThresholds = {
  VTI: 7, NVDA: 7, VOO: 7, QQQ: 7, SMH: 7, SCHG: 5, VXUS: 7, SCHD: 5, SPYD: 5, ASTS: 10,
};

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
    SPYD: PortfolioEntry; ASTS: PortfolioEntry;
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
  savingsRateTarget: number;
}
