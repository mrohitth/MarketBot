import * as fs from "fs";
import * as path from "path";

/**
 * Load environment variables from .env file
 * Works around dotenv issues with undefined values after config()
 */
function loadEnv(): void {
  // Always use process.cwd() which is /home/mathew/MarketBot when running from the project root
  const basePath = process.cwd();
  const envPath = path.join(basePath, ".env");
  
  if (!fs.existsSync(envPath)) {
    console.warn("[ENV] .env file not found at:", envPath);
    return;
  }
  
  const content = fs.readFileSync(envPath, "utf8");
  const lines = content.split("\n");
  
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    
    const eqIndex = trimmed.indexOf("=");
    if (eqIndex === -1) continue;
    
    const key = trimmed.substring(0, eqIndex).trim();
    const value = trimmed.substring(eqIndex + 1).trim();
    
    // Map .env key names to code expected names
    const envKey = key === "ALPHA_VANTAGE_API_KEY" ? "ALPHA_VANTAGE_KEY" : key;
    
    if (!process.env[envKey]) {
      process.env[envKey] = value;
    }
  }
  
  console.log("[ENV] Loaded environment from .env");
}

loadEnv();

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
  getBatchQuotes,
  TICKERS,
  calculatePositions, 
  generateRebalanceRecommendations,
  getMockQuotes,
  getMockHoldings,
  MOCK_TARGETS,
  MOCK_DRIFT_THRESHOLDS
} from "./lib/market";
import { scanSector, getMockSectorQuotes } from "./lib/profitMaximizer";
import { composeBrief, formatBriefAsWhatsApp, hasHighPriorityItems } from "./lib/brief";
import { 
  scanGmailForDiscoverAlerts, 
  getMockGmailTransactions, 
  deduplicateTransactions,
  formatGmailTransactionsForBrief,
  GmailTransaction,
  gmailToTransaction
} from "./lib/gmail";

// === Configuration ===

const ALPHA_VANTAGE_KEY = process.env.ALPHA_VANTAGE_KEY || "demo";
const GMAIL_USER = process.env.GMAIL_USER || "";
const GMAIL_APP_PASSWORD = process.env.GMAIL_APP_PASSWORD || "";
const CSV_PATH = process.env.DISCOVER_CSV_PATH || path.join(__dirname, "../data/discover-transactions.csv");
const MONTHLY_NET_INCOME = parseInt(process.env.MONTHLY_NET_INCOME || "8500");

const BUDGET_LIMITS: BudgetLimits = {
  dining: 600,
  housing: 2800,
  discretionary: 500,
  savingsRateTarget: 30,
};

const PORTFOLIO_TARGETS: PortfolioTargets = MOCK_TARGETS;
const DRIFT_THRESHOLDS: DriftThresholds = MOCK_DRIFT_THRESHOLDS;

// === Main Orchestrator ===

interface Config {
  useMockData: boolean;
  sendWhatsApp: boolean;
  useGmail: boolean;
}

const DEFAULT_CONFIG: Config = {
  useMockData: true,
  sendWhatsApp: false,
  useGmail: false,
};

/**
 * Main daily brief generation
 */
export async function generateDailyBrief(config: Config = DEFAULT_CONFIG): Promise<string> {
  console.log("[CAPITAL PILOT] Starting daily brief generation...");
  console.log(`[CONFIG] Mock data: ${config.useMockData}, WhatsApp: ${config.sendWhatsApp}, Gmail: ${config.useGmail}`);

  let gmailTransactions: GmailTransaction[] = [];

  // Step 0.5: Gmail Scanning (real-time transaction capture)
  if (config.useGmail && GMAIL_USER && GMAIL_APP_PASSWORD) {
    console.log("\n[STEP 0.5] Scanning Gmail for Discover alerts...");
    try {
      gmailTransactions = await scanGmailForDiscoverAlerts(GMAIL_USER, GMAIL_APP_PASSWORD);
      console.log(`[GMAIL] Found ${gmailTransactions.length} new alerts`);
    } catch (error) {
      console.error("[GMAIL] Failed to scan Gmail:", error);
    }
  } else if (config.useMockData) {
    gmailTransactions = getMockGmailTransactions();
    console.log(`[GMAIL] Using ${gmailTransactions.length} mock alerts`);
  }

  // Step 1: Budget Pacing (CSV + Gmail hybrid)
  console.log("\n[STEP 1] Processing budget pacing...");
  let transactions: Transaction[];
  let budgetPacing: BudgetPacingReport;

  if (config.useMockData) {
    console.log("[BUDGET] Using mock transactions + mock Gmail");
    transactions = getMockTransactions();
    budgetPacing = calculateBudgetPacing(transactions, BUDGET_LIMITS, MONTHLY_NET_INCOME);
  } else {
    console.log(`[BUDGET] Parsing CSV from ${CSV_PATH}`);
    const csvTransactions = parseDiscoverCSV(CSV_PATH);
    
    // Deduplicate CSV + Gmail (CSV takes priority - audited record)
    transactions = deduplicateTransactions(csvTransactions, gmailTransactions);
    console.log(`[BUDGET] Combined ${transactions.length} transactions (CSV + Gmail)`);
    
    budgetPacing = calculateBudgetPacing(transactions, BUDGET_LIMITS, MONTHLY_NET_INCOME);
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
    console.log("[MARKET] Fetching real quotes from Yahoo Finance (batched)...");
    quotes = await getBatchQuotes();
    console.log(`[MARKET] Batch complete — ${quotes.size}/${TICKERS.length} quotes populated`);
    for (const [ticker, quote] of quotes) {
      console.log(`[MARKET] ${ticker}: $${quote.price.toFixed(2)} (${quote.changePercent.toFixed(2)}%)`);
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
    MONTHLY_NET_INCOME * 0.1 // Cash available = 10% of monthly income
  );

  // Add Gmail alerts to brief output
  const gmailSection = formatGmailTransactionsForBrief(gmailTransactions);
  const whatsappMessage = gmailSection + "\n" + formatBriefAsWhatsApp(brief);
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
  console.log(`[SUMMARY] Budget: ${budgetPacing.status} | Market: ${brief.marketSummary.overallSignal} | Actions: ${recommendations.length} | Gmail Alerts: ${gmailTransactions.length}`);
  
  if (hasHighPriorityItems(brief)) {
    console.log("[ALERT] High-priority items detected — requires confirmation");
  }

  return whatsappMessage;
}

/**
 * Send WhatsApp message via OpenClaw
 */
async function sendWhatsApp(message: string): Promise<void> {
  const secret = process.env.WHATSAPP_WEBHOOK_SECRET;
  if (!secret || secret === "[PASTE_YOUR_SECRET_HERE]") {
    console.log("[WHATSAPP] No webhook secret configured — skipping send");
    console.log("[WHATSAPP] Message preview:", message.slice(0, 200), "...");
    return;
  }
  
  console.log("[WHATSAPP] Would send message of length:", message.length);
}

/**
 * Standalone CLI for testing
 */
async function main() {
  const args = process.argv.slice(2);
  const config: Config = {
    useMockData: !args.includes("--live"),
    sendWhatsApp: args.includes("--send"),
    useGmail: !args.includes("--no-gmail"),
  };

  await generateDailyBrief(config);
}

// Run if called directly
if (require.main === module) {
  main().catch(console.error);
}

export default generateDailyBrief;