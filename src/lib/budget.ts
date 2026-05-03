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
      category: mapCategory(category),
      merchant: extractMerchant(description),
    });
  }

  return transactions;
}

/**
 * Map raw category names from CSV to standardized categories
 */
function mapCategory(raw: string): string {
  const lower = raw.toLowerCase();
  
  if (lower.includes("dining") || lower.includes("restaurant") || lower.includes("food") || lower.includes("coffee") || lower.includes("uber eats") || lower.includes("doordash")) {
    return "Dining";
  }
  if (lower.includes("housing") || lower.includes("rent") || lower.includes("mortgage") || lower.includes("zelle") || lower.includes("rohan")) {
    return "Housing";
  }
  if (lower.includes("discretionary") || lower.includes("shopping") || lower.includes("amazon") || lower.includes(" Target") || lower.includes("entertainment")) {
    return "Discretionary";
  }
  if (lower.includes("income") || lower.includes("deposit") || lower.includes("payroll") || lower.includes("salary")) {
    return "Income";
  }
  
  return "Other";
}

/**
 * Extract merchant name from description
 */
function extractMerchant(description: string): string {
  // Common patterns in bank descriptions
  const match = description.match(/^(.+?)\s+(?:Card|Port|Payment)/);
  if (match) return match[1].trim();
  
  const parts = description.split(/\s+/);
  return parts.slice(0, 3).join(" ");
}

/**
 * Calculate budget pacing for the current month
 */
export function calculateBudgetPacing(
  transactions: Transaction[],
  limits: BudgetLimits,
  monthlyIncome: number = 8500 // Default placeholder until Mathew confirms
): BudgetPacingReport {
  const now = new Date();
  const monthStr = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;
  
  // Filter to current month transactions
  const monthTxns = transactions.filter((t) => t.date.startsWith(monthStr));
  
  // Sum spending by category
  const spent = {
    dining: 0,
    housing: 0,
    discretionary: 0,
    other: 0,
  };

  for (const txn of monthTxns) {
    if (txn.amount > 0) continue; // Skip income/credits
    const absAmount = Math.abs(txn.amount);
    switch (txn.category) {
      case "Dining": spent.dining += absAmount; break;
      case "Housing": spent.housing += absAmount; break;
      case "Discretionary": spent.discretionary += absAmount; break;
      default: spent.other += absAmount;
    }
  }

  const totalBudget = limits.dining + limits.housing + limits.discretionary;
  const totalSpent = spent.dining + spent.housing + spent.discretionary + spent.other;

  // Calculate savings rate
  const totalIncome = monthTxns.filter((t) => t.amount > 0).reduce((s, t) => s + t.amount, 0) || monthlyIncome;
  const netSaved = totalIncome - totalSpent;
  const savingsRate = (netSaved / totalIncome) * 100;

  // Build category statuses
  const categories: BudgetCategory[] = [
    buildCategory("Dining", limits.dining, spent.dining),
    buildCategory("Housing", limits.housing, spent.housing),
    buildCategory("Discretionary", limits.discretionary, spent.discretionary),
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

function buildCategory(name: string, limit: number, spent: number): BudgetCategory {
  const percentUsed = (spent / limit) * 100;
  let status: "ok" | "warning" | "exceeded" = "ok";
  if (percentUsed >= 100) status = "exceeded";
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
 * Format budget pacing as readable text for WhatsApp
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

/**
 * Generate ASCII progress bar
 */
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

// === Mock Data for Testing ===

export function getMockTransactions(): Transaction[] {
  return [
    { date: "2026-05-01", description: "UBER EATS PIZZA", amount: -45.00, category: "Dining", merchant: "Uber Eats" },
    { date: "2026-05-01", description: "STARBUCKS COFFEE", amount: -8.50, category: "Dining", merchant: "Starbucks" },
    { date: "2026-05-02", description: "ZELLE TO ROHAN DATLA", amount: -1400.00, category: "Housing", merchant: "Rohan" },
    { date: "2026-05-03", description: "AMAZON PRIME", amount: -35.00, category: "Discretionary", merchant: "Amazon" },
    { date: "2026-05-03", description: "PAYROLL DEPOSIT", amount: 4250.00, category: "Income", merchant: "Employer" },
    { date: "2026-05-04", description: "CHIPOTLE", amount: -18.75, category: "Dining", merchant: "Chipotle" },
    { date: "2026-05-05", description: "TARGET SHOPPING", amount: -125.00, category: "Discretionary", merchant: "Target" },
    { date: "2026-05-06", description: "ZELLE TO ROHAN DATLA", amount: -1400.00, category: "Housing", merchant: "Rohan" },
    { date: "2026-05-07", description: "TRADER JOES GROCERIES", amount: -95.00, category: "Dining", merchant: "Trader Joes" },
    { date: "2026-05-07", description: "DOORDASH DELIVERY", amount: -42.00, category: "Dining", merchant: "DoorDash" },
    { date: "2026-05-08", description: "SPOTIFY SUBSCRIPTION", amount: -12.99, category: "Discretionary", merchant: "Spotify" },
    { date: "2026-05-08", description: "PAYROLL DEPOSIT", amount: 4250.00, category: "Income", merchant: "Employer" },
  ];
}