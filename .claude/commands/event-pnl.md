---
description: Calculate exact P&L for events from actual platform data
arguments:
  - name: scope
    description: "kalshi URL, poly URL, or 'last N' for recent events"
---

Calculate P&L from ACTUAL platform data. Never estimate — use real fills.

## Method:

### Kalshi:
1. Get fills from `/portfolio/fills` filtered by ticker
2. For each fill: side, shares, fill_price, fee
3. Check market result from `/markets/{ticker}` → result = 'yes' or 'no'
4. For each fill:
   - If fill side matches result → that fill WON: payout = shares × $1
   - If fill side doesn't match → that fill LOST: payout = $0
   - Fill P&L = payout - (shares × fill_price) - fee
5. **KS P&L = SUM of all fill P&Ls**
6. DO NOT use settlement API revenue — it returns net which is confusing when you have both YES and NO
7. YES = UP, NO = DOWN. If result is 'no', NO shares win $1 each, YES shares lose.

### Polymarket:
1. Get activity from `data-api.polymarket.com/activity?user=FUNDER_ADDRESS` filtered by slug
2. Sum all TRADE entries as `spent`
3. Sum all REDEEM entries as `back`
4. **Poly P&L = back - spent**
5. Do NOT calculate win/loss per trade and also add redeems — that double counts.

### Matching KS ticker to Poly slug:
- KS ticker time = event END time (e.g., 0830 = 08:30 ET)
- Poly slug timestamp = event START time in UTC
- Convert: ET end time → UTC (+4h EDT) → subtract 900s → round to 900 → that's the Poly slug timestamp
- Example: KS 0830 ET = 12:30 UTC. Start = 12:30 - 900 = 11:45 UTC = unix timestamp → poly slug

### Example:
```
=== KALSHI (Result: DOWN/NO won) ===
NO  5sh @ 72¢  cost $3.68  → WON $5  = +$1.32
YES 5sh @ 47¢  cost $2.44  → LOST    = -$2.44
KS P&L: +$1.32 - $2.44 = -$1.12

=== POLY ===
Spent: $17.65  Back: $14.42
Poly P&L: $14.42 - $17.65 = -$3.23

=== NET: -$1.12 + -$3.23 = -$4.35 ===
```

### Per-coin summary:
- Group events by coin (BTC/ETH/SOL/XRP)
- Sum KS P&L and Poly P&L per coin
