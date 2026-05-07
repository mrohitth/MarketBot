import * as fs from "fs";
import * as path from "path";
import { Transaction, BudgetCategory, BudgetPacingReport, BudgetLimits } from "./types";

const DATA_DIR = path.join(__dirname, "../../data");

/**
 * Parse Discover CSV export into Transaction array
 * CSV format: Date,Description,Amount,Category
 */
export function parseDiscoverCSV(csvPath: string): Transaction[] {
  if (!fs.existsSync(csvPath)) {
    console.warn(`[BUDGET] CSV not found: ${csvPath}`);
    return [];
  }

  const content = fs.readFileSync(csvPath, "utf-8");
  const lines = content.split("\n").filter((l) => l.trim());

  if (lines.length < 2) {
    console.warn("[BUDGET] CSV empty or only header");
    return [];
  }

  const transactions: Transaction[] = [];

  // Skip header row
  for (let i = 1; i < lines.length; i++) {
    const parts = lines[i].split(",").map((p) => p.trim().replace(/^"|"$/g, ""));

    if (parts.length < 4) continue;

    const [date, description, amountStr, category] = parts;
    const amount = parseFloat(amountStr.replace("$", "").replace(",", ""));

    if (isNaN(amount)) continue;

    transactions.push({
      date,
      description,
      amount,
      category: mapCategoryFromDescription(description),
      merchant: extractMerchant(description),
    });
  }

  return transactions;
}

/**
 * Map a bank/CSV description string to a standardized category.
 * Order matters — first match wins.
 */
function mapCategoryFromDescription(raw: string): string {
  const lower = raw.toLowerCase();

  // ── Income ──────────────────────────────────────────────────────────────────
  if (
    lower.includes("income") ||
    lower.includes("deposit") ||
    lower.includes("payroll") ||
    lower.includes("salary") ||
    lower.includes("employer")
  ) {
    return "Income";
  }

  // ── Dining ─────────────────────────────────────────────────────────────────
  // Includes: restaurants, fast food, coffee shops, delivery, TST* restaurant prefix
  const diningKeywords = [
    "uber eats", "doordash", "grubhub", "chipotle", "starbucks",
    "trader", "restaurant", "pizza", "food", "pita",
    "mcdonald", "chick-fil-a", "wing", "dunkin", "coffee",
    "eat", "dining",
  ];
  const isDining =
    diningKeywords.some((kw) => lower.includes(kw)) ||
    /\btst\*/i.test(raw); // TST* = restaurant prefix in Discover format
  if (isDining) return "Dining";

  // ── Transportation ───────────────────────────────────────────────────────────
  if (
    (lower.includes("uber") && (lower.includes("trip") || lower.includes("ride") || lower.includes("pending") || lower.includes("ubr"))) ||
    lower.includes("lyft") ||
    lower.includes("parking") ||
    lower.includes("metro") ||
    lower.includes("gas") ||
    lower.includes("shell") ||
    lower.includes("exxon") ||
    lower.includes("bp ") ||
    lower.includes("transport") ||
    lower.includes("travel")
  ) {
    return "Transportation";
  }

  // ── Subscriptions ───────────────────────────────────────────────────────────
  if (
    lower.includes("netflix") ||
    lower.includes("spotify") ||
    lower.includes("hulu") ||
    lower.includes("disney") ||
    lower.includes("subscription") ||
    lower.includes("apple music") ||
    lower.includes("youtube premium") ||
    lower.includes("nfl+") ||
    lower.includes("paramount") ||
    lower.includes("peacock")
  ) {
    return "Subscriptions";
  }

  // ── Discretionary ───────────────────────────────────────────────────────────
  if (
    lower.includes("amazon") ||
    lower.includes("target") ||
    lower.includes("shop") ||
    lower.includes("walgreens") ||
    lower.includes("cvs") ||
    lower.includes("costco") ||
    lower.includes("bjs") ||
    lower.includes("discretionary") ||
    lower.includes("shopping")
  ) {
    return "Discretionary";
  }

  // ── Zelle / Venmo ───────────────────────────────────────────────────────────
  // These are fixed transfers (e.g. rent to roommate) — tracked as Other,
  // excluded from savings rate calculation
  if (lower.includes("zelle") || lower.includes("venmo")) {
    return "Other";
  }

  return "Other";
}

/**
 * Extract merchant name from bank description string.
 */
function extractMerchant(description: string): string {
  const match = description.match(/^(.+?)\s+(?:Card|Port|Payment)/);
  if (match) return match[1].trim();
  const parts = description.split(/\s+/);
  return parts.slice(0, 3).join(" ");
}

/**
 * Calculate budget pacing for the current month.
 *
 * Income: 2x $2958.71 = $5917.42/month (pay twice monthly)
 * Rent: $1000/month fixed constant — always counted in full each month.
 * Variable categories: Dining, Transportation, Subscriptions, Discretionary.
 */
export function calculateBudgetPacing(
  transactions: Transaction[],
  limits: BudgetLimits,
  monthlyIncome: number = 5917.42
): BudgetPacingReport {
  const now = new Date();
  const monthStr = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;

  const monthTxns = transactions.filter((t) => t.date.startsWith(monthStr));

  const spent = {
    dining: 0,
    transportation: 0,
    subscriptions: 0,
    discretionary: 0,
    other: 0,
  };

  for (const txn of monthTxns) {
    if (txn.amount > 0) continue;
    const absAmount = Math.abs(txn.amount);
    switch (txn.category) {
      case "Dining":         spent.dining         += absAmount; break;
      case "Transportation": spent.transportation += absAmount; break;
      case "Subscriptions":  spent.subscriptions  += absAmount; break;
      case "Discretionary":  spent.discretionary  += absAmount; break;
      default:              spent.other           += absAmount;
    }
  }

  const totalBudget =
    limits.dining + limits.transportation + limits.subscriptions + limits.discretionary + limits.rent;
  // Rent is fixed — always counted at full limit regardless of transaction list
  const totalSpent =
    spent.dining + spent.transportation + spent.subscriptions + spent.discretionary + limits.rent;

  const totalIncome =
    monthTxns.filter((t) => t.amount > 0).reduce((s, t) => s + t.amount, 0) || monthlyIncome;
  const netSaved = totalIncome - totalSpent;
  const savingsRate = (netSaved / totalIncome) * 100;

  const categories: BudgetCategory[] = [
    buildCategory("Housing (Rent)", limits.rent, limits.rent),
    buildCategory("Dining",         limits.dining,         spent.dining),
    buildCategory("Transportation", limits.transportation, spent.transportation),
    buildCategory("Subscriptions",   limits.subscriptions,  spent.subscriptions),
    buildCategory("Discretionary",  limits.discretionary,  spent.discretionary),
  ];

  return {
    month: monthStr,
    totalBudget,
    totalSpent,
    categories,
    savingsRate,
    status: totalSpent > totalBudget ? "over-budget" : "under-budget",
  };
}

function buildCategory(
  name: string,
  limit: number,
  spent: number
): BudgetCategory {
  if (limit <= 0) {
    return { name, limit, alertThreshold: 0.8, spent, remaining: 0, percentUsed: 0, status: "ok" };
  }
  const percentUsed = (spent / limit) * 100;
  let status: "ok" | "warning" | "exceeded" = "ok";
  if (percentUsed > 100) status = "exceeded";
  else if (percentUsed >= 80) status = "warning";

  return {
    name,
    limit,
    alertThreshold: 0.8,
    spent,
    remaining: Math.max(0, limit - spent),
    percentUsed,
    status,
  };
}

/**
 * Format budget pacing as readable text for Telegram
 */
export function formatBudgetPacingForBrief(report: BudgetPacingReport): string {
  let output = `📊 *BUDGET PACING*\n`;
  output += `Month: ${report.month} | Spent: $${report.totalSpent.toFixed(0)} / $${report.totalBudget.toFixed(0)}\n\n`;

  for (const cat of report.categories) {
    const emoji = cat.status === "exceeded" ? "🔴" : cat.status === "warning" ? "🟡" : "🟢";
    const bar = generateProgressBar(cat.percentUsed);
    output += `${emoji} ${cat.name}: $${cat.spent.toFixed(0)} / $${cat.limit.toFixed(0)} ${bar}\n`;
  }

  output += `\n💰 Savings Rate: ${report.savingsRate.toFixed(1)}%`;
  if (report.savingsRate < 30) {
    output += ` (target: >30%)`;
  }

  return output;
}

function generateProgressBar(percent: number, length: number = 10): string {
  const filled = Math.min(100, percent) / 10;
  const bar = "█".repeat(Math.floor(filled)) + "░".repeat(length - Math.floor(filled));
  return `[${bar}] ${percent.toFixed(0)}%`;
}

/**
 * Check for budget alerts
 */
export function getBudgetAlerts(report: BudgetPacingReport): string[] {
  const alerts: string[] = [];

  for (const cat of report.categories) {
    if (cat.status === "exceeded") {
      alerts.push(`⚠️ ${cat.name} EXCEEDED: $${(cat.spent - cat.limit).toFixed(0)} over limit`);
    } else if (cat.status === "warning") {
      alerts.push(`🟡 ${cat.name} at ${cat.percentUsed.toFixed(0)}% — $${cat.remaining.toFixed(0)} remaining`);
    }
  }

  if (report.savingsRate < 30) {
    alerts.push(`⚠️ Savings rate ${report.savingsRate.toFixed(1)}% below target (>30%)`);
  }

  return alerts;
}

// === Mock Data ===

export function getMockTransactions(): Transaction[] {
  return [
    { date: "2026-05-01", description: "UBER EATS PIZZA",        amount: -45.00,  category: "Dining",        merchant: "Uber Eats" },
    { date: "2026-05-01", description: "STARBUCKS COFFEE",      amount: -8.50,   category: "Dining",        merchant: "Starbucks" },
    { date: "2026-05-01", description: "PAYROLL DEPOSIT",       amount: 2958.71, category: "Income",        merchant: "Employer" },
    { date: "2026-05-03", description: "UBER TRIP",             amount: -12.50,  category: "Transportation", merchant: "Uber" },
    { date: "2026-05-03", description: "AMAZON PRIME",          amount: -35.00,  category: "Discretionary", merchant: "Amazon" },
    { date: "2026-05-04", description: "CHIPOTLE",              amount: -18.75,  category: "Dining",        merchant: "Chipotle" },
    { date: "2026-05-05", description: "TARGET SHOPPING",       amount: -125.00, category: "Discretionary", merchant: "Target" },
    { date: "2026-05-05", description: "SPOTIFY",               amount: -12.99,  category: "Subscriptions", merchant: "Spotify" },
    { date: "2026-05-05", description: "PAYROLL DEPOSIT",       amount: 2958.71, category: "Income",        merchant: "Employer" },
    { date: "2026-05-07", description: "TRADER JOES GROCERIES",  amount: -95.00,  category: "Dining",        merchant: "Trader Joes" },
    { date: "2026-05-07", description: "DOORDASH DELIVERY",    amount: -42.00,  category: "Dining",        merchant: "DoorDash" },
  ];
}
