import * as fs from "fs";
import * as path from "path";

function loadEnv(): void {
  const basePath = process.cwd();
  const envPath = path.join(basePath, ".env");
  if (!fs.existsSync(envPath)) {
    console.warn("[ENV] .env file not found at:", envPath);
    return;
  }
  const content = fs.readFileSync(envPath, "utf8");
  for (const line of content.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq === -1) continue;
    const key = trimmed.substring(0, eq).trim();
    const value = trimmed.substring(eq + 1).trim();
    if (!process.env[key]) process.env[key] = value;
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
  getHoldingsFromPortfolio,
  loadPortfolio,
  scanGmailForFidelityAlerts,
  verifyBalance,
  formatFidelityAlerts,
  formatBalanceVerification,
} from "./lib/fidelity";
import {
  getBatchQuotes,
  getMacroQuotes,
  getSectorQuotes,
  getMockQuotes,
  getMockHoldings,
  calculatePositions,
  generateRebalanceRecommendations,
  formatMarketSummary,
  formatPositionsForBrief,
} from "./lib/market";
import { PORTFOLIO_TARGET_ALLOCATION } from "./lib/recommendations";
import { composeBrief, formatBriefAsTelegram, hasHighPriorityItems } from "./lib/brief";
import {
  scanGmailForDiscoverAlerts,
  getMockGmailTransactions,
  formatGmailTransactionsForBrief,
  GmailTransaction,
  gmailToTransaction,
} from "./lib/gmail";
import {
  calculateBudgetPacing,
  getMockTransactions,
  getBudgetAlerts,
} from "./lib/budget";
import {
  generateTradeSetups,
  rankSetups,
  updateOpenPositions,
  formatTradeSetups,
  formatOpenPositions,
  OpenPosition,
  TradeSetup,
} from "./lib/recommendations";
import { scanSector, getMockSectorQuotes } from "./lib/profitMaximizer";

const GMAIL_USER = process.env.GMAIL_USER || "";
const GMAIL_APP_PASSWORD = process.env.GMAIL_APP_PASSWORD || "";
const CSV_PATH = process.env.DISCOVER_CSV_PATH || path.join(__dirname, "../data/discover-transactions.csv");
const MONTHLY_NET_INCOME = parseInt(process.env.MONTHLY_NET_INCOME || "5917");

const BUDGET_LIMITS: BudgetLimits = {
  dining: 600,
  transportation: 300,
  subscriptions: 100,
  discretionary: 400,
  // Weekly auto-debit to Fidelity: SCHG $150 + NVDA $50 + SMH $50 + VTI $50 = $300/week → $1,300/month
  fidelity: 1300,
  rent: 1000,
  savingsRateTarget: 30,
};

interface Config {
  useMockData: boolean;
  useGmail: boolean;
}

const DEFAULT_CONFIG: Config = {
  useMockData: false,
  useGmail: true,
};

export async function generateDailyBrief(config: Config = DEFAULT_CONFIG): Promise<string> {
  console.log("[CAPITAL PILOT] Starting daily brief generation...");
  console.log(`[CONFIG] Mock data: ${config.useMockData}, Gmail: ${config.useGmail}`);

  // Step 0.5: Gmail — Discover transactions
  let gmailTransactions: GmailTransaction[] = [];
  let fidelityAlerts: FidelityAlert[] = [];
  let balanceVerification: BalanceVerification[] = [];

  if (config.useGmail && GMAIL_USER && GMAIL_APP_PASSWORD) {
    try {
      gmailTransactions = await scanGmailForDiscoverAlerts(GMAIL_USER, GMAIL_APP_PASSWORD);
      console.log(`[GMAIL] Found ${gmailTransactions.length} Discover alert(s)`);
    } catch (error) {
      console.error("[GMAIL] Failed:", error);
    }
    try {
      fidelityAlerts = await scanGmailForFidelityAlerts(GMAIL_USER, GMAIL_APP_PASSWORD);
      console.log(`[FIDELITY] Found ${fidelityAlerts.length} alert(s)`);
      const balanceAlerts = fidelityAlerts.filter(a => a.type === "balance_alert" && a.balance);
      if (balanceAlerts.length > 0) {
        const portfolio = loadPortfolio();
        balanceVerification = await verifyBalance(balanceAlerts[0].balance!, portfolio, portfolio.targetAllocation);
        console.log(`[FIDELITY] Balance check: diff=$${balanceVerification[0]?.difference.toFixed(2)}`);
      }
    } catch (error) {
      console.error("[FIDELITY] Failed:", error);
    }
  } else if (config.useMockData) {
    gmailTransactions = getMockGmailTransactions();
  }

  // Step 1: Budget Pacing
  console.log("\n[STEP 1] Processing budget pacing...");
  let transactions: Transaction[];
  let budgetPacing: BudgetPacingReport;

  if (config.useMockData) {
    transactions = getMockTransactions();
    budgetPacing = calculateBudgetPacing(transactions, BUDGET_LIMITS, MONTHLY_NET_INCOME);
  } else {
    // Gmail-only — all Discover email alerts included (pending Uber pre-auths are real
    // charges that will be deduplicated when their confirmed version arrives)
    transactions = gmailTransactions.map((g) => gmailToTransaction(g));
    budgetPacing = calculateBudgetPacing(transactions, BUDGET_LIMITS, MONTHLY_NET_INCOME);
    console.log(`[BUDGET] ${transactions.length} Gmail transaction(s)`);
  }
  console.log(`[BUDGET] Spent: $${budgetPacing.totalSpent.toFixed(0)} / $${budgetPacing.totalBudget.toFixed(0)} | Rate: ${budgetPacing.savingsRate.toFixed(1)}%`);

  // Step 2: Market Data — portfolio quotes (live, all 10 tickers)
  console.log("\n[STEP 2] Fetching market data...");
  let quotes: Map<string, MarketData>;

  if (config.useMockData) {
    quotes = getMockQuotes();
  } else {
    quotes = await getBatchQuotes();
    console.log(`[MARKET] Portfolio quotes: ${quotes.size} tickers populated`);
    for (const [ticker, quote] of quotes) {
      const sign = quote.changePercent > 0 ? "+" : "";
      console.log(`  ${ticker}: $${quote.price.toFixed(2)} (${sign}${quote.changePercent.toFixed(2)}%)`);
    }
  }

  // Step 2b: Macro context (SPY, QQQ, DXY, TLT, GLD)
  let macroQuotes: Map<string, MarketData> = new Map();
  if (!config.useMockData) {
    console.log("\n[STEP 2b] Fetching macro context...");
    macroQuotes = await getMacroQuotes();
    console.log(`[MACRO] ${macroQuotes.size} macro tickers fetched`);
    for (const [ticker, quote] of macroQuotes) {
      const sign = quote.changePercent > 0 ? "+" : "";
      console.log(`  ${ticker}: $${quote.price.toFixed(2)} (${sign}${quote.changePercent.toFixed(2)}%)`);
    }
  }

  // Step 3: Portfolio Positions — all 10 holdings from portfolio.json
  console.log("\n[STEP 3] Calculating portfolio positions...");
  let positions: Position[];

  if (config.useMockData) {
    positions = calculatePositions(quotes, getMockHoldings());
  } else {
    const holdings = getHoldingsFromPortfolio();
    positions = calculatePositions(quotes, holdings);
  }

  for (const pos of positions) {
    const sign = pos.drift > 0 ? "+" : "";
    console.log(`[PORTFOLIO] ${pos.ticker}: $${pos.marketValue.toFixed(0)} (${pos.weight.toFixed(1)}%) | ${sign}${pos.drift.toFixed(1)}%`);
  }

  // Step 4: Rebalance Recommendations
  console.log("\n[STEP 4] Generating rebalance recommendations...");
  const recommendations = generateRebalanceRecommendations(positions);
  if (recommendations.length > 0) {
    console.log(`[RECOMMENDATIONS] ${recommendations.length} generated`);
    for (const rec of recommendations) console.log(`  ${rec.action} ${rec.ticker}: ${rec.reason}`);
  } else {
    console.log("[RECOMMENDATIONS] No rebalance needed");
  }

  // Step 5: Profit Maximizer — live sector sweep
  console.log("\n[STEP 5] Scanning sector for Profit Maximizer setups...");
  let sectorQuotes: Map<string, MarketData>;
  if (config.useMockData) {
    sectorQuotes = getMockSectorQuotes();
  } else {
    sectorQuotes = await getSectorQuotes();
    console.log(`[SECTOR] Fetched quotes for ${sectorQuotes.size} sector tickers`);
  }

  const profitMaximizer = await scanSector(sectorQuotes);
  console.log(`[PROFIT MAX] Found ${profitMaximizer.length} setup(s)`);
  for (const idea of profitMaximizer) {
    console.log(`  ${idea.ticker}: ${idea.setup} (R/R: ${idea.riskReward.toFixed(1)})`);
  }

  // Step 5b: Advisor-Grade Trade Setups (new recommendations engine)
  console.log("\n[STEP 5b] Generating trade setups via advisor engine...");
  const portfolioValue = Array.from(quotes.values()).reduce(
    (sum, q) => {
      const pos = positions.find((p) => p.ticker === q.ticker);
      return sum + (pos?.marketValue ?? 0);
    },
    0
  ) || 45648.95; // fallback to real portfolio value from screenshot

  const allQuotes = new Map([...quotes, ...sectorQuotes]);
  const allSetups: TradeSetup[] = [];
  for (const [, quote] of allQuotes) {
    const setups = generateTradeSetups(quote, portfolioValue);
    allSetups.push(...setups);
  }
  const rankedSetups = rankSetups(allSetups).slice(0, 5);
  console.log(`[SETUPS] ${rankedSetups.length} trade setups meet advisor criteria`);
  for (const s of rankedSetups) {
    console.log(`  ${s.ticker}: ${s.signal} | $${s.potentialProfitDollar.toFixed(0)} profit | R/R ${s.riskReward.toFixed(1)}:1 | ${s.holdDaysEstimate}d`);
  }

  // Load and update open positions
  const openPositions = updateOpenPositions([], quotes); // starts empty, fills as positions are opened

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

  const gmailSection = formatGmailTransactionsForBrief(gmailTransactions);
  const fidelitySection = formatFidelityAlerts(fidelityAlerts);
  const balanceSection = formatBalanceVerification(balanceVerification);
  const briefText = formatBriefAsTelegram(brief);

  const message = [gmailSection, fidelitySection, balanceSection, briefText]
    .filter(s => s.trim().length > 0)
    .join("\n");

  // Append advisor-grade trade setups and open positions
  const setupsText = formatTradeSetups(rankedSetups);
  const openPosText = formatOpenPositions(openPositions);
  const finalMessage = [message, setupsText, openPosText].filter(s => s.trim().length > 0).join("\n\n");

  console.log("\n" + "═".repeat(40));
  console.log("[CAPITAL PILOT] Brief assembled");
  console.log(`[SUMMARY] Budget: ${budgetPacing.status} | Market: ${brief.marketSummary.overallSignal} | Actions: ${recommendations.length}`);

  if (hasHighPriorityItems(brief)) {
    console.log("[ALERT] High-priority items — requires confirmation");
  }

  // Print to stdout — OpenClaw cron announce picks this up
  console.log("\n" + finalMessage);

  return finalMessage;
}

async function main() {
  const args = process.argv.slice(2);
  const config: Config = {
    useMockData: args.includes("--mock"),
    useGmail: !args.includes("--no-gmail"),
  };
  await generateDailyBrief(config);
}

if (require.main === module) {
  main().catch(console.error);
}

export default generateDailyBrief;
