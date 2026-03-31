---
description: Calculate exact P&L for events from actual platform data
arguments:
  - name: scope
    description: "kalshi URL, poly URL, or 'last N' for recent events"
---

Calculate P&L from ACTUAL platform data. Never estimate — use real fills and settlements.

## Method:

### Kalshi:
1. Get fills from `/portfolio/fills` filtered by ticker — gives actual fill price per share
2. Get settlement from `/portfolio/settlements` — gives actual payout
3. **KS P&L = settlement payout - SUM(fill_price × shares + fee) for all fills on this ticker**
4. Note: KS nets YES and NO internally. If you buy 5 YES + 5 NO, net position = 0.

### Polymarket:
1. Get activity from `data-api.polymarket.com/activity?user=FUNDER_ADDRESS` filtered by slug
2. Sum all TRADE entries as `spent`
3. Sum all REDEEM entries as `back`
4. **Poly P&L = back - spent**
5. Do NOT calculate win/loss per trade and also add redeems — that double counts.

### Matching KS ticker to Poly slug:
- KS ticker time = event END time (e.g., 0830 = 08:30 ET)
- Poly slug timestamp = event START time in UTC
- Convert: ET end time → UTC → subtract 900s → that's the Poly start timestamp
- Example: KS 0830 ET = 12:30 UTC. Start = 12:30 - 900 = 11:45 UTC = unix timestamp → poly slug

### Combined:
- NET = KS P&L + Poly P&L
- A properly hedged arb should have KS and Poly roughly opposite (one wins, one loses, net small positive)

### Per-coin summary:
- Group events by coin (BTC/ETH/SOL/XRP)
- Sum KS P&L and Poly P&L per coin
