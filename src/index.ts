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
import { applyInvestorFilters, formatPersonaOutput } from "./lib/investor_filter";
import { runResearchPipeline, discoverOpportunities, formatTickerResearch, formatOpportunities } from "./lib/research_pipeline";
import { batchFetchNewsSentiment } from "./lib/news_sentiment";

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

  // Pre-fetch news sentiment for all tickers in parallel (30-min cache)
  const allTickers = [...quotes.keys(), ...sectorQuotes.keys()];
  let newsSentiments = new Map<string, { score: number; label: string; headlines: string[] }>();
  if (!config.useMockData) {
    try {
      newsSentiments = await batchFetchNewsSentiment(allTickers);
      console.log(`[NEWS] Fetched sentiment for ${newsSentiments.size} tickers`);
      for (const [ticker, sentiment] of newsSentiments) {
        if (sentiment.label !== "neutral") {
          console.log(`  ${ticker}: ${sentiment.label} (score ${sentiment.score})`);
        }
      }
    } catch (err) {
      console.warn("[NEWS] Sentiment fetch failed, proceeding without news data:", err);
    }
  }

  const allQuotes = new Map([...quotes, ...sectorQuotes]);
  const allSetups: TradeSetup[] = [];
  for (const [, quote] of allQuotes) {
    const newsForTicker = newsSentiments.get(quote.ticker);
    const setups = generateTradeSetups(quote, portfolioValue, newsForTicker);
    allSetups.push(...setups);
  }
  const rankedSetups = rankSetups(allSetups).slice(0, 5);
  console.log(`[SETUPS] ${rankedSetups.length} trade setups meet advisor criteria`);
  for (const s of rankedSetups) {
    console.log(`  ${s.ticker}: ${s.signal} | $${s.potentialProfitDollar.toFixed(0)} profit | R/R ${s.riskReward.toFixed(1)}:1 | ${s.holdDaysEstimate}d`);
  }

  // Step 5c: Apply investor persona lenses (Buffett + Graham)
  console.log("\n[STEP 5c] Applying Buffett + Graham investor filters...");
  const investorOutput = applyInvestorFilters(rankedSetups, portfolioValue);
  console.log(`[INVESTOR_FILTER] Buffett: ${investorOutput.buffettLensed.length} passed | Graham: ${investorOutput.grahamLensed.length} passed | Rejected: ${investorOutput.rejected.length}`);

  // Step 5d: Run comprehensive research pipeline on all portfolio tickers
  console.log("\n[STEP 5d] Running multi-factor research pipeline...");
  const portfolioResearch: ReturnType<typeof runResearchPipeline>[] = [];
  const sectorETFChanges = Object.fromEntries([...quotes].map(([t, q]) => [t, q.changePercent]));
  const macroChanges = Object.fromEntries([...macroQuotes].map(([t, q]) => [t, q.changePercent]));
  for (const [ticker, quote] of quotes) {
    const finnhub = newsSentiments.get(ticker) ?? null;
    const research = runResearchPipeline({
      ticker,
      price: quote.price,
      changePercent: quote.changePercent,
      rsi: quote.rsi,
      ma20: quote.ma20,
      ma50: quote.ma50,
      volume: quote.volume,
      volumeAvg: quote.volumeAvg,
      finnhubSentiment: finnhub,
      sectorETFChanges,
      macroChanges,
      isInPortfolio: true,
    });
    portfolioResearch.push(research);
  }
  console.log(`[RESEARCH] Analyzed ${portfolioResearch.length} tickers via 4 signal layers`);
  for (const r of portfolioResearch) {
    console.log(`  ${r.ticker}: composite=${r.compositeScore.toFixed(1)} verdict=${r.verdict}`);
  }

  // Step 5e: New opportunity discovery — mega-cap/semi tickers NOT in portfolio
  console.log("\n[STEP 5e] Scanning new opportunities outside portfolio...");
  const candidatePool = [
    "META", "AMZN", "GOOGL", "MSFT",
    "TSM", "AMD", "AVGO", "MRVL", "AMAT", "LRCX", "KLAC", "SNPS", "CDNS", "PANW",
  ];
  const newOpportunities = await discoverOpportunities(
    candidatePool,
    sectorETFChanges,
    macroChanges,
    newsSentiments,
    (t: string) => positions.some(p => p.ticker === t)
  );
  console.log(`[DISCOVERY] Found ${newOpportunities.length} new opportunities`);
  for (const opp of newOpportunities.slice(0, 3)) {
    console.log(`  ${opp.ticker}: ${opp.category} score=${opp.score.toFixed(1)} — ${opp.thesis.slice(0, 80)}...`);
  }

  const openPositions = updateOpenPositions([], quotes); // starts empty, fills as positions are opened

  const { loadSwingState, checkSwingPositions, checkCoreAccumulation } = await import("./lib/swing_manager");
  const swingState = loadSwingState();
  console.log(`[SWING] Pool: $${swingState.capital.toFixed(2)} | Active: ${swingState.positions.length} | Realized P&L: $${swingState.realizedPnL.toFixed(2)}`);

  // Check existing swing positions against live prices
  const swingCheck = checkSwingPositions(new Map([...quotes].map(([t, q]) => [t, { price: q.price, rsi: q.rsi }])));
  if (swingCheck.closed.length > 0) {
    console.log(`[SWING] Closed ${swingCheck.closed.length} position(s):`, swingCheck.closed.map((p: any) => `${p.ticker} ${p.notes}`));
  }
  if (swingCheck.atRisk.length > 0) {
    console.log(`[SWING] At risk:`, swingCheck.atRisk.map((p: any) => `${p.ticker} ${p.notes}`));
  }

  // Core accumulation signals
  const coreAccumSignals = checkCoreAccumulation(new Map([...quotes].map(([t, q]) => [t, { price: q.price, rsi: q.rsi, changePercent: q.changePercent }])));
  if (coreAccumSignals.length > 0) {
    console.log(`[CORE] ${coreAccumSignals.length} accumulation signal(s):`, coreAccumSignals.map((s: any) => `${s.ticker} ${s.action}`));
  }

  // Step 6: Compose Brief
  console.log("\n[STEP 6] Composing morning brief...");
  const brief = composeBrief(
    budgetPacing,
    quotes,
    positions,
    recommendations,
    profitMaximizer,
    swingState.capital,
    rankedSetups.slice(0, 3),
    swingState,
    coreAccumSignals,
    investorOutput,
    MONTHLY_NET_INCOME * 0.1
  );

  const gmailSection = formatGmailTransactionsForBrief(gmailTransactions);
  const fidelitySection = formatFidelityAlerts(fidelityAlerts);
  const balanceSection = formatBalanceVerification(balanceVerification);
  const briefText = formatBriefAsTelegram(brief);

  const message = [gmailSection, fidelitySection, balanceSection, briefText]
    .filter(s => s.trim().length > 0)
    .join("\n");

  // Append research pipeline, opportunities, and open positions to final message
  const buffettText = formatPersonaOutput(investorOutput, "buffett");
  const grahamText = formatPersonaOutput(investorOutput, "graham");

  // Format portfolio research as one-line verdict summaries
  const researchSummary = portfolioResearch
    .map(r => {
      const emoji = r.verdict === "BUY" ? "🟢" : r.verdict === "WATCH" ? "🟡" : "🔴";
      return `${emoji} ${r.ticker}: ${r.compositeScore >= 0 ? "+" : ""}${r.compositeScore.toFixed(1)} ${r.verdict}`;
    })
    .join(" | ");
  const researchSection = `📊 *PORTFOLIO RESEARCH* (multi-factor)
${researchSummary}`;

  // Format new opportunities
  const oppText = formatOpportunities(newOpportunities);

  const openPosText = formatOpenPositions([]); // swing positions tracked separately
  const finalMessage = [message, buffettText, grahamText, researchSection, oppText, openPosText]
    .filter(s => s.trim().length > 0)
    .join("\n\n");

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
