# How the Whale Does Simultaneous BUY + SELL (Flip)

## Is the Flip "Profitable"?

A flip (sell Up + buy Down) is **not** locking in profit at fill time. It's a **directional bet**:
- He pays net $1.54 more than he receives ($4.07 − $2.53) → increasing bearish exposure
- Profit (or loss) is realized only when the event resolves (Up or Down wins)

"Profitable" execution means getting **good prices** (e.g. buying below ask, selling above bid), not locking in arbitrage.

## What You're Seeing

The whale executes **both legs at once** in a single transaction:
- **SELL 11.0 Up** at 23¢ → $2.53
- **BUY 5.5 Down** at 74¢ → $4.03
- **Total notional:** $6.56

This is a "flip" — exiting Up exposure, entering Down exposure atomically.

## How He Does It

### 1. Polymarket Batch Orders

Polymarket's CLOB supports **postOrders** (plural) — submit up to **15 orders** in one API request. Orders are processed in parallel.

```
POST /orders
[
  { order: signedSellUpOrder, orderType: "FOK" },
  { order: signedBuyDownOrder, orderType: "FOK" }
]
```

When both are marketable (liquidity exists at those prices), they match immediately. The CLOB batches settlement → **one on-chain tx** with multiple `OrderFilled` events.

### 2. Single Transaction, Multiple Fills

The CTF Exchange's `matchOrders` function can execute multiple maker–taker matches in **one transaction**. Our whale watcher buffers all `OrderFilled` logs by `txHash` and saves them together — that's why you see both legs in one row.

### 3. Strategy: Opportunistic Flip

- He monitors BTC (or the event) for a directional signal.
- When he wants to flip from Up → Down, he submits both orders in one batch:
  - **SELL** his Up position (or part of it) at the current bid
  - **BUY** Down at the current ask (or a limit below)
- Both fill in the same tx — no gap risk, no "I sold but couldn't buy."

### 4. The 11:5.5 Ratio

- 11 Up ≈ 2× 5.5 Down in shares.
- Dollar-wise: 11×23¢ = $2.53 out, 5.5×74¢ = $4.03 in — net increase in position size, more bearish.
- He likely sizes based on: target exposure, available liquidity, and the Up+Down price (e.g. 97¢).

## What We Added

**`POST /api/whale-flip`** — Batch SELL Up + BUY Down in one request.

```json
{ "sellUp": 11, "buyDown": 5.5 }
```

- Uses `postOrders` to submit both legs in parallel
- FAK order type so they fill what's available
- Checks balance before selling
- Prices: sell at best bid - 1¢, buy at best ask + 1¢ (aggressive fill)

## Timestamps

We now use **block timestamp** (on-chain) instead of when we received the log. Each fill includes `blockNumber` and `logIndex` — you can verify on Polygonscan. Fills in the same tx share the same block and timestamp; `logIndex` gives fill order.

## Further Ideas

1. **Conditional execution** — Only flip when BTC moves X in one direction.
2. **Limit both legs** — Place sell at bid, buy at ask-2¢ to capture spread.
