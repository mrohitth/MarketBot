# MarketBot Portfolio Context — Mathew R. Thomson
# Last updated: 2026-05-03
# Source: Fidelity email extraction + USER.md profile

## Portfolio Positions (from Fidelity trade confirmations)

### Core Holdings (from USER.md investment profile)

| Ticker | Name | Shares | Avg Cost | Current Price | Market Value | Conviction | Notes |
|--------|------|--------|----------|---------------|--------------|------------|-------|
| **NVDA** | NVIDIA Corporation | ? | ~$203 | $198.45 | ? | Very High | 3 trades confirmed Apr 2026: $211.38, $199.57, $198.38. GPU moat, AI infrastructure bet. |
| **SMH** | VanEck Semiconductor ETF | ? | ~$494 | $509.82 | ? | High | 1 trade confirmed Apr 2026: $494.42. Diversified semi exposure. |
| **SCHG** | Schwab US Large-Cap Growth ETF | ? | ~$30 | $33.14 | ? | Moderate | 5 trades confirmed Apr 2026. Portfolio ballast. |

### Discovered Holdings (from Fidelity emails — not in original USER.md)

| Ticker | Name | Shares | Avg Cost | Current Price | Market Value | Notes |
|--------|------|--------|----------|---------------|--------------|-------|
| **QQQ** | Invesco QQQ Trust | ? | ~$597 | $674.15 | ? | 4 trades confirmed Apr 2026. Tech/growth tilt. |
| **SCHD** | Schwab US Dividend Equity ETF | ? | ~$31 | $31.86 | ? | 5 trades confirmed Apr 2026. Dividend income. |
| **VXUS** | Vanguard Total International Stock ETF | ? | ~$78 | $82.97 | ? | 5 trades confirmed Apr 2026. International diversification. |
| **VOOG** | Vanguard S&P 500 Growth ETF | ? | ~$425 | $78.46 | ? | 2 trades confirmed Apr 2026. Growth tilt within S&P 500. |

> **Note on share counts:** Fidelity trade confirmation emails show price per share but NOT share count or dollar amount. Share count must be entered manually or sourced from Fidelity account dashboard.

## Portfolio Targets (from USER.md)

Current target allocation:
- **NVDA:** Very High — concentrated AI chip leader position
- **SMH:** High — diversified semiconductor sector exposure  
- **SCHG:** Moderate — portfolio ballast / broad US growth

Discovered additional holdings (QQQ, SCHD, VXUS, VOOG) suggest a more diversified core-satellite strategy than originally documented.

### Target Weights (from OPERATING.md)
- NVDA: 40%
- SMH: 30%
- SCHG: 20%
- CASH: 10%

## Account Information
- **Brokerage:** Fidelity Investments (Account XXXXX8015)
- **Email notifications:** Fidelity.Investments@mail.fidelity.com
- **Transfer status:** "We are working on your transfer request" (Apr 30, 2026 email)

## Known Trade Activity (April 2026)

Confirmed buy orders on or around April 8, 2026 (multiple ETF purchases suggest systematic/DCA investing):

| Ticker | Trades | Avg Price | Date |
|--------|--------|-----------|------|
| NVDA | 3 | ~$203 | Apr 8 |
| QQQ | 4 | ~$597 | Apr 8 |
| SCHG | 5 | ~$30 | Apr 8 |
| SCHD | 5 | ~$31 | Apr 8 |
| VXUS | 5 | ~$78 | Apr 8 |
| VOOG | 2 | ~$425 | Apr 8 |
| SMH | 1 | $494.42 | Apr 8 |

## Budget Context (from .env)
- Monthly net income: $8,500
- Portfolio total: $850,000
- Cash target: ~$85,000 (10% of portfolio)

## Savings Rate
- Target savings rate: ~40-50% of monthly income
- Investment contributions tracked via Discover CSV + Fidelity ETF purchases

## Growth History (Estimated from Email Trail)

**April 2026:** Active investing phase begins with multiple ETF purchases. Total portfolio ~$850K.
- Strategy appears to be systematic DCA into growth ETFs + NVDA conviction position
- Also holds international (VXUS), dividend (SCHD), and growth (VOOG, QQQ) for diversification

**Unknown timeline:** Portfolio likely grew from smaller base through consistent investing + market appreciation.

## Action Items
1. [ ] Enter actual share counts for all positions (from Fidelity account)
2. [ ] Verify NVDA average cost ($203 from 3 trades at $198-$211)
3. [ ] Check if any SMH shares were purchased outside April 8 window
4. [ ] Update USER.md investment profile to include QQQ, SCHD, VXUS, VOOG
5. [ ] Set up Portfolio Health tracking in KATZEN for all 7 positions