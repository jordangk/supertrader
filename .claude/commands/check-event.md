---
description: Check P&L for a specific event on both Kalshi and Polymarket
arguments:
  - name: kalshi_ticker
    description: "Kalshi ticker (e.g., KXBTC15M-26MAR302345-45) or partial (e.g., 302345)"
  - name: poly_slug
    description: "Polymarket slug (e.g., sol-updown-15m-1774928700) or full URL"
---

Check the P&L for a specific event across both platforms. Get the Kalshi ticker and Poly slug from the user's arguments.

1. Query Kalshi `/portfolio/orders?ticker={ticker}&status=executed` for all fills on this event
2. Query Kalshi `/portfolio/settlements` for payout on this event
3. Query Polymarket `data-api.polymarket.com/activity?user=0x175ba0a98ea74525cc7490975bacbb0a1ac3099e` and filter by the slug
4. Show a clear table:

For Kalshi: each order (side, shares, avg price, cost, fees)
For Poly: each trade (side, shares, price, cost)
Then totals: KS spent, KS payout, KS P&L, Poly spent, Poly back, Poly P&L, COMBINED

Extract the ticker from partial input:
- If just numbers like "302345", try KXBTC15M-26MAR{input}-45 and KXSOL15M-26MAR{input}-45 etc
- If a URL, extract the ticker/slug from it
- The poly slug can be extracted from a polymarket.com URL

Always show the RAW data from the APIs, don't use our DB.
