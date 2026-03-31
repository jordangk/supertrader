---
description: Calculate exact P&L for a specific event from actual platform data
arguments:
  - name: kalshi_trades
    description: "Paste Kalshi trade history (e.g., 'Bought No 66.60¢ 5 $3.33 $0.08')"
  - name: poly_trades
    description: "Paste Poly trade history (e.g., 'Bought 5.00 Up at 25¢ ($1.25)')"
  - name: result
    description: "Which side won: up/yes or down/no"
---

Calculate exact P&L from the user's pasted trade data.

## How to calculate:

### Kalshi:
For each trade:
- If the trade's side matches the winning result → payout = shares × $1
- If not → payout = $0
- P&L per trade = payout - cost - fees

Sum all KS trades for KS net.

### Polymarket:
For each trade:
- If the trade's side matches the winning result → payout = shares × $1
- If not → payout = $0
- P&L per trade = payout - cost

Sum all Poly trades for Poly net.

### Combined:
Total = KS net + Poly net

### Format output as:
```
=== KALSHI (result: NO/DOWN won) ===
NO  5sh @ 66.60¢  cost $3.33  → won $5.00  = +$1.67
YES 5sh @ 77.40¢  cost $3.87  → lost $0    = -$3.87
KS net: $X.XX

=== POLY (result: DOWN won) ===
DOWN 5sh @ 30¢  cost $1.50  → won $5.00  = +$3.50
UP   5sh @ 43¢  cost $2.15  → lost $0    = -$2.15
Poly net: $X.XX

=== COMBINED: $X.XX ===
```

Note: On Kalshi YES = UP, NO = DOWN. On Poly Up = YES, Down = NO.
