# Capital Pilot — Operating Instructions

_Last updated: 2026-05-05 by Kitty_

---

## Environment Setup

Copy `.env.example` to `.env` and fill in:

```
MONTHLY_NET_INCOME=8500
PORTFOLIO_TOTAL=43757.84
GMAIL_USER=mathew.rohit.thomson@gmail.com
GMAIL_APP_PASSWORD=[GMAIL_APP_PASSWORD_FOR_IMAP]
# Telegram delivery handled automatically by OpenClaw cron announce
DISCOVER_CSV_PATH=./data/discover-transactions.csv
```

**Gmail App Password:** Create at Google Account → Security → 2-Step Verification → App Passwords. Required for IMAP access to scan Fidelity trade confirmation emails.

---

## Data Sources

| Source | What it provides |
|--------|-----------------|
| Yahoo Finance (yahoo-finance2) | Live prices for all portfolio + sector + macro tickers |
| Gmail/IMAP | Discover transaction alerts, Fidelity trade confirmations |
| Discover CSV | Weekly transaction download from Discover.com |
| `data/portfolio.json` | Static share counts (manually updated from Fidelity) |

**No Alpha Vantage key required** — Yahoo Finance is used directly.

---

## Portfolio Baseline (from Fidelity — 2026-05-03)

| Ticker | Shares | Avg Cost | Tgt Wt |
|--------|--------|----------|--------|
| VTI | 34 | ~$231 | 20% |
| NVDA | 41.6 | ~$203 | 20% |
| VOO | 17.1 | ~$403 | 18% |
| QQQ | 9.4 | ~$597 | 14% |
| SMH | 8.1 | ~$494 | 10% |
| SCHG | 102.4 | ~$30 | 8% |
| VXUS | 29.7 | ~$73 | 6% |
| SCHD | 75.2 | ~$29 | 5% |
| SPYD | 3.7 | ~$41 | 1% |
| ASTS | 8.7 | ~$11 | 1% |

**Brokerage account:** Fidelity Investments (Account XXXXX8015)

---

## Ticker Coverage

| Tier | Tickers | Purpose |
|------|---------|---------|
| Portfolio | VTI, NVDA, VOO, QQQ, SMH, SCHG, VXUS, SCHD, SPYD, ASTS | All 10 holdings — drift + rebalance |
| Macro | SPY, QQQ, DXY, TLT, GLD | Market context — trend, dollar, rates, gold |
| Sector | AMD, TSM, ASML, INTC, QCOM, AMAT, LRCX, MU, SOXX, SMH, AVGO, MRVL, PANW, MPWR, CDNS, SNPS, ON, LSCC, ENTG, SWKS | Profit Maximizer scanner (20 semi/tech stocks) |

---

## Weekly Discover CSV Upload

Mathew exports Discover transactions weekly. To import:

1. Download Discover CSV from Discover.com → Account → Spending → Export CSV
2. Save file to: `MarketBot/data/discover-transactions.csv`
3. Filename must be `discover-transactions.csv`

**Format expected:**
```
Date,Description,Amount,Category
2026-05-01,UBER EATS PIZZA,-45.00,Dining
```

---

## Running the Brief

**Mock data (development):**
```bash
node dist/index.js --mock
```

**Live data (production):**
```bash
node dist/index.js --live        # Full data: portfolio + macro + sector
```

**Portfolio only (skip macro/sector):**
```bash
node dist/index.js --live --no-sector
```

**Schedule:** 8:00 AM EST daily via OpenClaw cron with `delivery.mode: "announce"` → Telegram

---

## Black Swan Rule (>8% Drop)

When any position drops >8% in a day:

1. **Detection:** `src/lib/market.ts` — `status = "black-swan"` when `|changePercent| > 8`
2. **Status:** Position marked as `black-swan` instead of `drifted`
3. **Confirmation Required:** Brief includes `⚠️ REQUIRES [CONFIRMED] REPLY`
4. **Execution:** Only after Mathew replies `[CONFIRMED]`

---

## Cron Job Architecture

The daily brief runs as an `agentTurn` with `delivery.mode: "announce"` so output reaches Telegram:

```json
{
  "name": "Capital Pilot Daily",
  "schedule": { "kind": "cron", "expr": "0 8 * * *", "tz": "America/New_York" },
  "payload": { "kind": "agentTurn", "message": "Run MarketBot: node dist/index.js --live" },
  "delivery": { "mode": "announce", "channel": "telegram", "to": "5607383477" },
  "sessionTarget": "isolated"
}
```

**Why `systemEvent` is wrong:** A `systemEvent` runs a shell command — stdout goes to the execution log, not Telegram. Only `agentTurn` with `announce` delivers the formatted brief.

---

## Key Files Reference

| File | Purpose |
|------|---------|
| `src/index.ts` | Main orchestrator — generateDailyBrief() |
| `src/lib/types.ts` | All interfaces + ticker constants (PORTFOLIO_TICKERS, MACRO_TICKERS, SECTOR_TICKERS) |
| `src/lib/market.ts` | Yahoo Finance fetcher — getBatchQuotes(), getMacroQuotes(), getSectorQuotes() |
| `src/lib/profitMaximizer.ts` | Sector scanner — scanSector() |
| `src/lib/budget.ts` | CSV parsing, budget pacing |
| `src/lib/fidelity.ts` | Gmail/Fidelity email scanner |
| `src/lib/brief.ts` | Telegram message formatter |
| `data/portfolio.json` | Static portfolio positions (manually updated) |
| `data/discover-transactions.csv` | Weekly Discover CSV upload |
| `OPERATING.md` | This file |

---

## Troubleshooting

**"No new Discover alerts":** Normal when no new Discover charges that week. Checks 25K+ messages on first run.

**"0 alert(s) Fidelity":** Normal — Fidelity emails are scanned for balance updates and trade confirmations.

**Profit Maximizer shows "No high-probability setups":** Normal when no sector stocks meet RSI 30-45, breakout, or MA50 reclaim criteria. Not an error.

**Sector fetch returns fewer than 20 tickers:** Some tickers may fail Yahoo Finance and fall back to last-known prices. Check `data/last-known-prices.json` for persisted prices.

---

_Last updated: 2026-05-05 — Expanded to all 10 portfolio tickers, macro context (SPY/QQQ/DXY/TLT/GLD), sector sweep (20 semi/tech stocks), Yahoo Finance (not Alpha Vantage)._