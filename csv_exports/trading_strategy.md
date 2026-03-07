# K9 Copy-Trading System

## Overview
We mirror **2%** of k9's Polymarket trading volume on BTC 5-minute up/down events using **FAK (Fill and Kill)** orders.

## Flow

### 1. Detect k9's trades
- WebSocket + on-chain watcher monitors k9's wallet for `OrderFilled` events on Polymarket CTF exchange
- Each fill decoded into: outcome (Up/Down), side (buy/sell), shares, USDC size, event slug

### 2. Accumulate into buffer
- Each k9 trade's shares multiplied by **2%** and added to a per-outcome buffer
- Buffer: `{ Up: { buy: X, sell: Y }, Down: { buy: X, sell: Y } }`
- Trades grouped by second — net direction computed (k9 buys 100 + sells 50 = net +50 buy)

### 3. Flush every 1 second
- Every 1s, buffer checked per outcome + side
- If `shares x livePrice >= $1.00` (FAK minimum), fire the order
- Shares rounded to 2 decimal places

### 4. Execute BUY
- Fetch **ASK price** from CLOB (crosses spread for immediate fill)
- `createMarketOrder` with USDC amount directly
- Posted as **FAK** — fills instantly or killed, no resting order

### 5. Execute SELL
- Check actual token balance held
- Cap sell shares at what we hold
- Fetch **BID price** from CLOB, nudge up 1 tick
- `createMarketOrder` with share amount, posted as FAK

### 6. Retry on failure
- **"No orders found to match"** — shares back into buffer, retried next 1s flush
- **Bad price (0 or 1)** — shares back into buffer (near event boundaries)
- **Other errors** — logged, shares lost

## Parameters

| Param | Value |
|-------|-------|
| Copy rate | 2% of k9's volume |
| Order type | FAK (Fill and Kill) |
| Min order | $1.00 USDC |
| Flush interval | 1 second |
| Price source | CLOB ask (buys) / bid (sells) |
| Queue | Sequential (avoids nonce collisions) |

## Known Issues

| Issue | Detail |
|-------|--------|
| Sells mostly fail | k9 sweeps book before our FAK arrives — "no orders found to match" |
| Cheap side slow | k9 buys Up at 5-15c, our 2% rarely hits $1 minimum |
| Timing lag | k9 fill -> detect -> buffer -> flush -> execute = multi-second delay, liquidity gone |
| No position tracking | No net position awareness, no smart exit strategy |

## Performance — Last 15 Events (March 6, 2026)

| Event | Winner | K9 P&L | US P&L | K9 Trades | US Trades |
|-------|--------|--------|--------|-----------|-----------|
| 5m-1772819100 | Up | +$164.53 | +$0.26 | 354 | 1 |
| 5m-1772817300 | Up | +$427.37 | -$2.25 | 752 | 4 |
| 5m-1772817000 | Down | +$868.02 | +$4.66 | 224 | 20 |
| 5m-1772816700 | Down | +$499.94 | +$4.27 | 177 | 17 |
| 5m-1772813700 | Up | -$187.85 | -$52.99 | 321 | 35 |
| 5m-1772813400 | Down | -$47.62 | -$2.33 | 380 | 31 |
| 5m-1772813100 | Down | +$109.36 | -$6.52 | 128 | 13 |
| 5m-1772812800 | Up | +$74.35 | +$8.33 | 277 | 41 |
| **5m-1772812500** | **Up** | **+$611.58** | **-$62.15** | 670 | 39 |
| 5m-1772812200 | Down | +$189.05 | -$1.55 | 1066 | 35 |
| 5m-1772811900 | Down | +$484.44 | +$11.36 | 296 | 23 |
| 5m-1772811600 | Down | +$1,932.82 | +$24.82 | 499 | 54 |
| 5m-1772811300 | Up | -$111.96 | -$39.14 | 571 | 35 |
| 5m-1772811000 | Down | +$70.41 | +$23.19 | 757 | 41 |

**Totals**: K9 = +$5,083 | US = -$89 across 15 events

### Biggest Divergences (k9 profit, we lost)
- **5m-1772812500**: k9 +$612, us -$62 (gap: $674)
- **5m-1772812200**: k9 +$189, us -$1.55 (gap: $191)
- **5m-1772813100**: k9 +$109, us -$6.52 (gap: $116)
