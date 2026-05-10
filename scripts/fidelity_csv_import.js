#!/usr/bin/env node
/**
 * fidelity_csv_import.js
 * ─────────────────────
 * Parse a Fidelity positions CSV and update portfolio.json.
 *
 * Run: node scripts/fidelity_csv_import.js path/to/fidelity_positions.csv
 *
 * Fidelity CSV columns this script maps:
 *   Symbol          → ticker
 *   Quantity        → shares
 *   Average Cost    → avgCost
 *   Last Price      → currentPrice
 *   Market Value    → marketValue
 */
const fs   = require("fs");
const path = require("path");

const CSV_PATH  = process.argv[2];
const JSON_PATH = path.resolve(__dirname, "../data/portfolio.json");

if (!CSV_PATH) {
  console.error("Usage: node scripts/fidelity_csv_import.js <fidelity_positions.csv>");
  process.exit(1);
}
if (!fs.existsSync(CSV_PATH)) {
  console.error(`[IMPORT] CSV not found: ${CSV_PATH}`);
  process.exit(1);
}

// ── Parse ───────────────────────────────────────────────────────────────────
const lines = fs.readFileSync(CSV_PATH, "utf8").split("\n").filter(l => l.trim());
if (lines.length < 2) {
  console.error("[IMPORT] CSV is empty or header-only");
  process.exit(1);
}

// Header row — Fidelity uses: Symbol, Description, Quantity, Average Cost,
//                  Last Price, Last Price Change, Market Value, Day Change,
//                  Day Change %, % of Account, ...
const header = lines[0].split(",").map(h => h.trim().replace(/^"|"$/g, ""));

const symIdx    = header.findIndex(h => /symbol/i.test(h));
const qtyIdx    = header.findIndex(h => /quantity|shares/i.test(h));
const costIdx   = header.findIndex(h => /average cost|cost basis/i.test(h));
const priceIdx  = header.findIndex(h => /last price|current price|price/i.test(h));
const mvIdx     = header.findIndex(h => /market value|market value/i.test(h));

console.log(`[IMPORT] Column indices — Symbol:${symIdx} Qty:${qtyIdx} AvgCost:${costIdx} Price:${priceIdx} MktVal:${mvIdx}`);

if (symIdx < 0 || qtyIdx < 0) {
  console.error("[IMPORT] Could not find required columns (Symbol, Quantity). Check CSV header.");
  process.exit(1);
}

// ── Build position map ──────────────────────────────────────────────────────
const SKIP = new Set(["CASH", "SPAXX", "MONEY", "PENDING"]);
const newPositions = {};

for (let i = 1; i < lines.length; i++) {
  const cols = lines[i].split(",").map(c => c.trim().replace(/^"|"$/g, ""));
  const ticker = (cols[symIdx] || "").toUpperCase().trim();

  if (!ticker || SKIP.has(ticker) || ticker.includes("TOTAL")) continue;

  const shares      = parseFloat((cols[qtyIdx]    || "").replace(/[,$"]/g, "")) || 0;
  const avgCost     = parseFloat((cols[costIdx]   || "").replace(/[,$"]/g, "")) || 0;
  const currentPrice= parseFloat((cols[priceIdx] || "").replace(/[,$"]/g, "")) || 0;
  const marketValue = parseFloat((cols[mvIdx]     || "").replace(/[,$"]/g, "")) || 0;

  if (!shares) continue;

  newPositions[ticker] = {
    shares,
    avgCost:     +avgCost.toFixed(2),
    currentPrice:+currentPrice.toFixed(2),
    marketValue: +marketValue.toFixed(2),
  };
  console.log(`[IMPORT] ${ticker}: shares=${shares}, avgCost=$${avgCost}, currentPrice=$${currentPrice}`);
}

console.log(`[IMPORT] ${Object.keys(newPositions).length} positions imported`);

// ── Load existing portfolio.json ────────────────────────────────────────────
let portfolio;
try {
  portfolio = JSON.parse(fs.readFileSync(JSON_PATH, "utf8"));
} catch {
  console.warn("[IMPORT] portfolio.json not found — creating new");
  portfolio = { positions: {}, targetAllocation: {} };
}

// ── Merge — live prices from CSV override; keep avgCost if CSV has it ────────
for (const [ticker, entry] of Object.entries(newPositions)) {
  const existing = portfolio.positions[ticker] || {};
  portfolio.positions[ticker] = {
    shares:      entry.shares,
    avgCost:     entry.avgCost     || existing.avgCost     || 0,
    currentPrice:entry.currentPrice|| existing.currentPrice|| 0,
    marketValue: entry.marketValue|| existing.marketValue || 0,
  };
}

portfolio.lastUpdated = new Date().toISOString().split("T")[0];
portfolio.totalValue  = Object.values(portfolio.positions)
  .reduce((sum, p) => sum + (p.marketValue || 0), 0);

// ── Save ────────────────────────────────────────────────────────────────────────
fs.writeFileSync(JSON_PATH, JSON.stringify(portfolio, null, 2));
console.log(`[IMPORT] portfolio.json updated — ${portfolio.totalValue.toFixed(2)} total`);
console.log(`[IMPORT] Run 'cd /home/mathew/MarketBot && npm run build' to compile, then commit:`);
console.log(`       git add data/portfolio.json && git commit -m "update: portfolio positions from Fidelity CSV"`);
