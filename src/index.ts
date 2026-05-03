import * as fs from "fs";
import * as path from "path";

/**
 * Load environment variables from .env file
 * Works around dotenv issues with undefined values after config()
 */
function loadEnv(): void {
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

    if (!process.env[key]) {
      process.env[key] = value;
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
  ProfitMaximizerIdea,
  FidelityAlert,
  BalanceVerification,
} from "./lib/types";
import {
  parseDiscoverCSV,
  calculateBudgetPacing,
  getMockTransactions,
  getBudgetAlerts,
} from "./lib/budget";
import {
  getBatchQuotes,
  TICKERS,
  getMockQuotes,
  getMockHoldings,
  calculatePositions,
  generateRebalanceRecommendations,
  MOCK_TARGETS,
  MOCK_DRIFT_THRESHOLDS,
} from "./lib/market";
import {
  loadPortfolio,
  getHoldingsFromPortfolio,
  scanGmailForFidelityAlerts,
  verifyBalance,
  formatFidelityAlerts,
  formatBalanceVerification,
} from "./lib/fidelity";
import { scanSector, getMockSectorQuotes } from "./lib/profitMaximizer";
import { composeBrief, formatBriefAsWhatsApp, hasHighPriorityItems } from "./lib/brief";
import {
  scanGmailForDiscoverAlerts,
  getMockGmailTransactions,
  deduplicateTransactions,
  formatGmailTransactionsForBrief,
  GmailTransaction,
  gmailToTransaction,
} from "./lib/gmail";

// === Configuration ===

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
  useGmail: boolean;
}

const DEFAULT_CONFIG: Config = {
  useMockData: true,
  useGmail: false,
};

/**
 * Main daily brief generation.
 *
 * Output: Returns the full brief as a string. OpenClaw cron `delivery.announce`
 * picks up the run output and sends it to Telegram (telegram:5607383477) automatically.
 * No webhook or send flag needed.
 */
export async function generateDailyBrief(config: Config = DEFAULT_CONFIG): Promise<string> {
  console.log("[CAPITAL PILOT] Starting daily brief generation...");
  console.log(`[CONFIG] Mock data: ${config.useMockData}, Gmail: ${config.useGmail}`);

  let gmailTransactions: GmailTransaction[] = [];
  let fidelityAlerts: FidelityAlert[] = [];
  let balanceVerification: BalanceVerification[] = [];

  // Step 0.5: Gmail — Discover transaction alerts
  if (config.useGmail && GMAIL_USER && GMAIL_APP_PASSWORD) {
    console.log("\n[STEP 0.5] Scanning Gmail for Discover alerts...");
    try {
      gmailTransactions = await scanGmailForDiscoverAlerts(GMAIL_USER, GMAIL_APP_PASSWORD);
      console.log(`[GMAIL] Found ${gmailTransactions.length} Discover alert(s)`);
    } catch (error) {
      console.error("[GMAIL] Failed to scan Gmail:", error);
    }
  } else if (config.useMockData) {
    gmailTransactions = getMockGmailTransactions();
    console.log(`[GMAIL] Using ${gmailTransactions.length} mock Discover alert(s)`);
  }

  // Step 0.6: Gmail — Fidelity alerts (transfers, trade confirmations, balance)
  if (config.useGmail && GMAIL_USER && GMAIL_APP_PASSWORD) {
    console.log("\n[STEP 0.6] Scanning Gmail for Fidelity alerts...");
    try {
      fidelityAlerts = await scanGmailForFidelityAlerts(GMAIL_USER, GMAIL_APP_PASSWORD);
      console.log(`[FIDELITY] Found ${fidelityAlerts.length} Fidelity alert(s)`);
      for (const alert of fidelityAlerts) {
        console.log(`[FIDELITY]   - [${alert.type.toUpperCase()}] ${alert.subject}`);
      }

      // Trigger balance verification if Fidelity balance email found
      const balanceAlerts = fidelityAlerts.filter(a => a.type === "balance_alert" && a.balance);
      if (balanceAlerts.length > 0) {
        console.log("\n[STEP 0.6b] Running balance verification...");
        const portfolio = loadPortfolio();
        balanceVerification = await verifyBalance(balanceAlerts[0].balance!, portfolio, PORTFOLIO_TARGETS);
        console.log(`[FIDELITY] Balance check: diff=$${balanceVerification[0]?.difference.toFixed(2)}`);
      }
    } catch (error) {
      console.error("[FIDELITY] Failed to scan Gmail:", error);
    }
  }

  // Step 1: Budget Pacing (CSV + Gmail hybrid)
  console.log("\n[STEP 1] Processing budget pacing...");
  let transactions: Transaction[];
  let budgetPacing: BudgetPacingReport;

  if (config.useMockData) {
    console.log("[BUDGET] Using mock transactions");
    transactions = getMockTransactions();
    budgetPacing = calculateBudgetPacing(transactions, BUDGET_LIMITS, MONTHLY_NET_INCOME);
  } else {
    console.log(`[BUDGET] Parsing CSV from ${CSV_PATH}`);
    const csvTransactions = parseDiscoverCSV(CSV_PATH);
    transactions = deduplicateTransactions(csvTransactions, gmailTransactions);
    console.log(`[BUDGET] Combined ${transactions.length} transaction(s) (CSV + Gmail)`);
    budgetPacing = calculateBudgetPacing(transactions, BUDGET_LIMITS, MONTHLY_NET_INCOME);
  }

  console.log(`[BUDGET] Spent: $${budgetPacing.totalSpent.toFixed(0)} / $${budgetPacing.totalBudget.toFixed(0)}`);
  console.log(`[BUDGET] Savings rate: ${budgetPacing.savingsRate.toFixed(1)}%`);

  const budgetAlerts = getBudgetAlerts(budgetPacing);
  if (budgetAlerts.length > 0) {
    console.log("[BUDGET] Alerts:", budgetAlerts);
  }

  // Step 2: Market Data — live prices via Yahoo Finance (no API keys needed)
  console.log("\n[STEP 2] Fetching market data...");
  let quotes: Map<string, MarketData>;

  if (config.useMockData) {
    console.log("[MARKET] Using mock quotes");
    quotes = getMockQuotes();
  } else {
    console.log("[MARKET] Fetching live quotes from Yahoo Finance (batched NVDA, SMH, SCHG)...");
    quotes = await getBatchQuotes();
    console.log(`[MARKET] Batch complete — ${quotes.size}/${TICKERS.length} quotes populated`);
    for (const [ticker, quote] of quotes) {
      const sign = quote.changePercent > 0 ? "+" : "";
      console.log(`[MARKET] ${ticker}: $${quote.price.toFixed(2)} (${sign}${quote.changePercent.toFixed(2)}%)`);
    }
  }

  // Step 3: Portfolio Positions — from portfolio.json (manual share counts in live mode)
  console.log("\n[STEP 3] Calculating portfolio positions from portfolio.json...");
  let positions: Position[];

  if (config.useMockData) {
    positions = calculatePositions(quotes, getMockHoldings(), PORTFOLIO_TARGETS, DRIFT_THRESHOLDS);
  } else {
    positions = calculatePositions(quotes, getHoldingsFromPortfolio(), PORTFOLIO_TARGETS, DRIFT_THRESHOLDS);
  }

  for (const pos of positions) {
    const driftSign = pos.drift > 0 ? "+" : "";
    console.log(`[PORTFOLIO] ${pos.ticker}: $${pos.marketValue.toFixed(0)} | ${pos.weight.toFixed(1)}% | ${driftSign}${pos.drift.toFixed(1)}%`);
  }

  // Step 4: Rebalance Recommendations
  console.log("\n[STEP 4] Generating rebalance recommendations...");
  const recommendations = generateRebalanceRecommendations(positions);

  if (recommendations.length > 0) {
    console.log(`[RECOMMENDATIONS] ${recommendations.length} recommendation(s) generated`);
    for (const rec of recommendations) {
      console.log(`  - ${rec.action} ${rec.ticker}: ${rec.reason}`);
    }
  } else {
    console.log("[RECOMMENDATIONS] No rebalance needed — all positions within thresholds");
  }

  // Step 5: Profit Maximizer
  console.log("\n[STEP 5] Scanning sector for Profit Maximizer setups...");
  const sectorQuotes = config.useMockData ? getMockSectorQuotes() : new Map<string, MarketData>();
  const profitMaximizer = await scanSector(sectorQuotes);
  console.log(`[PROFIT MAX] Found ${profitMaximizer.length} setup(s)`);
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
    MONTHLY_NET_INCOME * 0.1
  );

  // Assemble final message (Discover + Fidelity + brief)
  const gmailSection = formatGmailTransactionsForBrief(gmailTransactions);
  const fidelitySection = formatFidelityAlerts(fidelityAlerts);
  const balanceSection = formatBalanceVerification(balanceVerification);
  const briefText = formatBriefAsWhatsApp(brief);

  const message = [gmailSection, fidelitySection, balanceSection, briefText]
    .filter(s => s.trim().length > 0)
    .join("\n");

  console.log("\n" + "═".repeat(40));
  console.log("[CAPITAL PILOT] Brief assembled — output delivered via OpenClaw cron announce");
  console.log(`[SUMMARY] Budget: ${budgetPacing.status} | Market: ${brief.marketSummary.overallSignal} | ` +
    `Actions: ${recommendations.length} | Discover: ${gmailTransactions.length} | Fidelity: ${fidelityAlerts.length}`);

  if (hasHighPriorityItems(brief)) {
    console.log("[ALERT] High-priority items detected — requires confirmation");
  }

  // Print brief to stdout so OpenClaw cron announce picks it up
  console.log("\n" + message);

  return message;
}

/**
 * Standalone CLI for testing
 *
 * Flags:
 *   --live        Use real data (CSV + live Yahoo Finance prices + Gmail scan)
 *   --mock        Use mock data (default)
 *   --no-gmail    Skip Gmail scan
 *
 * Output goes to stdout — OpenClaw cron handles Telegram delivery.
 */
async function main() {
  const args = process.argv.slice(2);
  const config: Config = {
    useMockData: !args.includes("--live"),
    useGmail: !args.includes("--no-gmail"),
  };

  await generateDailyBrief(config);
}

if (require.main === module) {
  main().catch(console.error);
}

export default generateDailyBrief;