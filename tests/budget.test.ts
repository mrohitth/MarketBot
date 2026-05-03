import { 
  getMockTransactions, 
  calculateBudgetPacing, 
  getBudgetAlerts,
  parseDiscoverCSV 
} from "../src/lib/budget";
import { BudgetLimits } from "../src/lib/types";
import * as path from "path";

const BUDGET_LIMITS: BudgetLimits = {
  dining: 600,
  housing: 2800,
  discretionary: 500,
  savingsRateTarget: 30,
};

describe("Budget Pacing with Dummy Data", () => {
  
  test("Mock transactions should parse correctly", () => {
    const transactions = getMockTransactions();
    
    expect(transactions.length).toBeGreaterThan(0);
    
    // Check income transaction
    const income = transactions.find((t) => t.amount > 0 && t.category === "Income");
    expect(income).toBeDefined();
    expect(income!.amount).toBe(4250); // bi-weekly payroll
    
    // Check dining transactions
    const diningTxns = transactions.filter((t) => t.category === "Dining");
    expect(diningTxns.length).toBeGreaterThan(0);
    
    // Check housing transactions (Zelle to Rohan)
    const housingTxns = transactions.filter((t) => t.category === "Housing");
    expect(housingTxns.length).toBe(2); // Two Zelle payments
  });

  test("Budget pacing calculates correctly", () => {
    const transactions = getMockTransactions();
    const report = calculateBudgetPacing(transactions, BUDGET_LIMITS, 8500);
    
    // Total budget = 600 + 2800 + 500 = 3900
    expect(report.totalBudget).toBe(3900);
    
    // Total spent should include all spending categories
    expect(report.totalSpent).toBeGreaterThan(3000);
    
    // Categories should be populated
    expect(report.categories.length).toBe(3);
    
    // Dining should have warnings (already over 80% of $600)
    const dining = report.categories.find((c) => c.name === "Dining");
    expect(dining).toBeDefined();
    expect(dining!.percentUsed).toBeGreaterThan(80);
    expect(dining!.status).toBe("warning");
    
    // Housing should be fine
    const housing = report.categories.find((c) => c.name === "Housing");
    expect(housing).toBeDefined();
    expect(housing!.status).toBe("ok"); // $2800 limit, ~$2800 spent
  });

  test("Budget alerts generated for exceeded categories", () => {
    const transactions = getMockTransactions();
    const report = calculateBudgetPacing(transactions, BUDGET_LIMITS, 8500);
    const alerts = getBudgetAlerts(report);
    
    // Should have at least one alert (Dining over 80%)
    expect(alerts.length).toBeGreaterThan(0);
    
    // Check for dining warning
    const diningAlert = alerts.find((a) => a.includes("Dining"));
    expect(diningAlert).toBeDefined();
  });

  test("Savings rate calculated correctly", () => {
    const transactions = getMockTransactions();
    const report = calculateBudgetPacing(transactions, BUDGET_LIMITS, 8500);
    
    // With $8500 income and ~$3100 spent, savings rate should be positive
    expect(report.savingsRate).toBeGreaterThan(30); // Should be above 30% target
  });

});

describe("CSV Parsing", () => {
  
  test("Should return empty array for non-existent file", () => {
    const txns = parseDiscoverCSV("/tmp/nonexistent.csv");
    expect(txns).toEqual([]);
  });

});

describe("Budget Categories", () => {
  
  test("Dining limit is $600 as specified", () => {
    expect(BUDGET_LIMITS.dining).toBe(600);
  });

  test("Housing limit is $2800 as specified", () => {
    expect(BUDGET_LIMITS.housing).toBe(2800);
  });

  test("Discretionary limit is $500 as specified", () => {
    expect(BUDGET_LIMITS.discretionary).toBe(500);
  });

});