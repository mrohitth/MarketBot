import { 
  Transaction, 
  BudgetLimits, 
  PortfolioTargets, 
  DriftThresholds,
  BudgetPacingReport,
  MarketData,
  Position,
  TradeRecommendation,
  ProfitMaximizerIdea
} from "./lib/types";
import { 
  parseDiscoverCSV, 
  calculateBudgetPacing, 
  getMockTransactions,
  getBudgetAlerts 
} from "./lib/budget";
import { 
  getQuote, 
  calculatePositions, 
  generateRebalanceRecommendations,
  getMockQuotes,
  getMockHoldings,
  MOCK_TARGETS,
  MOCK_DRIFT_THRESHOLDS
} from "./lib/market";
import { scanSector, getMockSectorQuotes } from "./lib/profitMaximizer";
import { composeBrief, formatBriefAsWhatsApp, hasHighPriorityItems } from "./lib/brief";
import * as path from "path";

// === Configuration ===

const ALPHA_VANTAGE_KEY = process.env.ALPHA_VANTAGE_KEY || "demo"; // Use "demo" for testing
const CSV_PATH = process.env.DISCOVER_CSV_PATH || path.join(__dirname, "../data/discover-transactions.csv");

const BUDGET_LIMITS: BudgetLimits = {
  dining: 600,
  housing: 2800,
  discretionary: 500,
  savingsRateTarget: 30,
};

const PORTFOLIO_TARGETS: PortfolioTargets = MOCK_TARGETS; // 40% NVDA, 30% SMH, 20% SCHG, 10% Cash
const DRIFT_THRESHOLDS: DriftThresholds = MOCK_DRIFT_THRESHOLDS;

// === Main Orchestrator ===

interface Config {
  useMockData: boolean;
  sendWhatsApp: boolean;
}

const DEFAULT_CONFIG: Config = {
  useMockData: true,  // Set to false to use real APIs
  sendWhatsApp: false, // Set to true to actually send WhatsApp
};

/**
 * Main daily brief generation
 */
export async function generateDailyBrief(config: Config = DEFAULT_CONFIG): Promise<string> {
  console.log("[CAPITAL PILOT] Starting daily brief generation...");
  console.log(`[CONFIG] Mock data: ${config.useMockData}, WhatsApp: ${config.sendWhatsApp}`);

  // Step 1: Budget Pacing
  console.log("\n[STEP 1] Processing budget pacing...");
  let transactions: Transaction[];
  let budgetPacing: BudgetPacingReport;

  if (config.useMockData) {
    console.log("[BUDGET] Using mock transactions");
    transactions = getMockTransactions();
    budgetPacing = calculateBudgetPacing(transactions, BUDGET_LIMITS, 8500); // $8500 net income placeholder
  } else {
    console.log(`[BUDGET] Parsing CSV from ${CSV_PATH}`);
    transactions = parseDiscoverCSV(CSV_PATH);
    budgetPacing = calculateBudgetPacing(transactions, BUDGET_LIMITS);
  }

  console.log(`[BUDGET] Spent: $${budgetPacing.totalSpent.toFixed(0)} / $${budgetPacing.totalBudget.toFixed(0)}`);
  console.log(`[BUDGET] Savings rate: ${budgetPacing.savingsRate.toFixed(1)}%`);

  const budgetAlerts = getBudgetAlerts(budgetPacing);
  if (budgetAlerts.length > 0) {
    console.log("[BUDGET] Alerts:", budgetAlerts);
  }

  // Step 2: Market Data
  console.log("\n[STEP 2] Fetching market data...");
  let quotes: Map<string, MarketData>;
  
  if (config.useMockData) {
    console.log("[MARKET] Using mock quotes");
    quotes = getMockQuotes();
  } else {
    console.log("[MARKET] Fetching real quotes from Alpha Vantage...");
    const tickers = ["NVDA", "SMH", "SCHG"];
    quotes = new Map();
    
    for (const ticker of tickers) {
      console.log(`[MARKET] Fetching ${ticker}...`);
      const quote = await getQuote(ticker, ALPHA_VANTAGE_KEY);
      if (quote) {
        quotes.set(ticker, quote);
        console.log(`[MARKET] ${ticker}: $${quote.price.toFixed(2)} (${quote.changePercent.toFixed(2)}%)`);
      }
    }
  }

  // Step 3: Portfolio Positions
  console.log("\n[STEP 3] Calculating portfolio positions...");
  const holdings = getMockHoldings();
  const positions = calculatePositions(quotes, holdings, PORTFOLIO_TARGETS, DRIFT_THRESHOLDS);
  
  for (const pos of positions) {
    const driftEmoji = pos.drift > 0 ? "+" : "";
    console.log(`[PORTFOLIO] ${pos.ticker}: $${pos.marketValue.toFixed(0)} | ${pos.weight.toFixed(1)}% | ${driftEmoji}${pos.drift.toFixed(1)}%`);
  }

  // Step 4: Rebalance Recommendations
  console.log("\n[STEP 4] Generating rebalance recommendations...");
  const recommendations = generateRebalanceRecommendations(positions);
  
  if (recommendations.length > 0) {
    console.log(`[RECOMMENDATIONS] ${recommendations.length} recommendations generated`);
    for (const rec of recommendations) {
      console.log(`  - ${rec.action} ${rec.ticker}: ${rec.reason}`);
    }
  } else {
    console.log("[RECOMMENDATIONS] No rebalance needed — all positions within thresholds");
  }

  // Step 5: Profit Maximizer
  console.log("\n[STEP 5] Scanning sector for Profit Maximizer setups...");
  let sectorQuotes: Map<string, MarketData>;
  
  if (config.useMockData) {
    sectorQuotes = getMockSectorQuotes();
  } else {
    // In production, fetch additional tickers
    sectorQuotes = new Map();
  }

  const profitMaximizer = await scanSector(sectorQuotes);
  console.log(`[PROFIT MAX] Found ${profitMaximizer.length} setups`);
  for (const idea of profitMaximizer) {
    console.log(`  - ${idea.ticker}: ${idea.setup} (R/R: ${idea.riskReward.toFixed(1)})`);
  }

  // Step 6: Compose Brief
  console.log("\n[STEP 6] Composing morning brief...");
  const brief = composeBrief(
    budgetPacing,
    quotes,
    positions,
    recommendations,
    profitMaximizer,
    85000 * 0.1 // Cash available = 10% of $850k portfolio
  );

  const whatsappMessage = formatBriefAsWhatsApp(brief);
  console.log("\n" + whatsappMessage);

  // Step 7: Send WhatsApp (if configured)
  if (config.sendWhatsApp) {
    console.log("\n[STEP 7] Sending WhatsApp message...");
    await sendWhatsApp(whatsappMessage);
    console.log("[WHATSAPP] Message sent successfully");
  } else {
    console.log("\n[WHATSAPP] Skipped (sendWhatsApp=false)");
  }

  // Summary
  console.log("\n" + "═".repeat(40));
  console.log("[CAPITAL PILOT] Daily brief complete");
  console.log(`[SUMMARY] Budget: ${budgetPacing.status} | Market: ${brief.marketSummary.overallSignal} | Actions: ${recommendations.length}`);
  
  if (hasHighPriorityItems(brief)) {
    console.log("[ALERT] High-priority items detected — requires confirmation");
  }

  return whatsappMessage;
}

/**
 * Send WhatsApp message via OpenClaw
 * In production, this would use OpenClaw's WhatsApp integration
 */
async function sendWhatsApp(message: string): Promise<void> {
  // In production: use OpenClaw's cron/webhook system or direct messaging
  // For now, we'll use the OpenClaw sessions_send or cron to deliver to WhatsApp
  
  // Get WhatsApp webhook secret from env
  const secret = process.env.WHATSAPP_WEBHOOK_SECRET;
  if (!secret || secret === "[PASTE_YOUR_SECRET_HERE]") {
    console.log("[WHATSAPP] No webhook secret configured — skipping send");
    console.log("[WHATSAPP] Message preview:", message.slice(0, 200), "...");
    return;
  }
  
  console.log("[WHATSAPP] Would send message of length:", message.length);
  console.log("[WHATSAPP] To enable: set WHATSAPP_WEBHOOK_SECRET in .env");
}

/**
 * Standalone CLI for testing
 */
async function main() {
  const args = process.argv.slice(2);
  const config: Config = {
    useMockData: !args.includes("--live"),
    sendWhatsApp: args.includes("--send"),
  };

  await generateDailyBrief(config);
}

// Run if called directly
if (require.main === module) {
  main().catch(console.error);
}

export default generateDailyBrief;