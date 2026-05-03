// === Core Types ===

export interface Transaction {
  date: string;           // YYYY-MM-DD
  description: string;
  amount: number;         // Negative for purchases, positive for income
  category: string;       // "Dining", "Housing", "Discretionary", etc.
  merchant?: string;
}

export interface BudgetCategory {
  name: string;
  limit: number;          // Monthly limit
  alertThreshold: number; // 0.8 = 80%
  spent: number;
  remaining: number;
  percentUsed: number;
  status: "ok" | "warning" | "exceeded";
}

export interface BudgetPacingReport {
  month: string;          // "2026-05"
  totalBudget: number;
  totalSpent: number;
  categories: BudgetCategory[];
  savingsRate: number;    // Percentage of income saved
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
  weight: number;         // Portfolio percentage
  targetWeight: number;    // Target allocation
  drift: number;          // Deviation from target (%)
  status: "on-target" | "drifted" | "black-swan";
}

export interface MarketData {
  ticker: string;
  price: number;
  previousClose: number;
  change: number;
  changePercent: number;
  rsi: number;           // 14-day RSI
  ma20: number;           // 20-day moving average
  ma50: number;           // 50-day moving average
  volume: number;
  volumeAvg: number;
  status: "bull" | "bear" | "neutral";
  signals: string[];      // ["above_ma20", "rsi_overbought", etc.]
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
  setup: string;         // "RSI oversold", "Breaking MA20 with volume"
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
  date: string;           // Today's date
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

// === API Response Types ===

export interface AlphaVantageQuoteResponse {
  "Global Quote": {
    "01. symbol": string;
    "02. open": string;
    "03. high": string;
    "04. low": string;
    "05. price": string;
    "06. volume": string;
    "07. latest trading day": string;
    "08. previous close": string;
    "09. change": string;
    "10. change percent": string;
  };
}

export interface AlphaVantageRSIResponse {
  "Technical Analysis: RSI": {
    "data": Array<{
      "date": string;
      "RSI": string;
    }>;
  };
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
    NVDA: PortfolioEntry;
    SMH: PortfolioEntry;
    SCHG: PortfolioEntry;
  };
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

// === Configuration Types ===

export interface BudgetLimits {
  dining: number;
  housing: number;
  discretionary: number;
  savingsRateTarget: number;
}

export interface PortfolioTargets {
  NVDA: number;
  SMH: number;
  SCHG: number;
  CASH: number;
}

export interface DriftThresholds {
  NVDA: number;
  SMH: number;
  SCHG: number;
}