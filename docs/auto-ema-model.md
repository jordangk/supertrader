# Auto-EMA Strategy Model

Two-step scalp on Polymarket BTC Up/Down: buy winning side on EMA divergence, hedge on MACD convergence. Designed to trade only when conviction is high.

---

## State Machine

```
[IDLE] ──(trigger)──> [PENDING] ──(fill)──> [ENTERED] ──(hedge)──> [IDLE]
   │                       │                      │
   │                       └──(abort/timeout)────>│
   │                                              │
   └──────────────── (stop loss / MACD exit) ─────┘
```

| Phase   | Description |
|---------|-------------|
| IDLE    | No position, watching for trigger |
| PENDING | Entry order placed, polling for fill |
| ENTERED | Long winning side, waiting for hedge signal |

---

## Inputs

| Symbol | Source | Description |
|--------|--------|-------------|
| `btcStart` | Event open | BTC price at event start |
| `btcCurrent` | Binance stream | Live BTC price (tick-level) |
| `delta` | `btcCurrent - btcStart` | BTC move since event start ($) |
| `upPrice`, `downPrice` | CLOB | Polymarket Up/Down ask prices |
| `liveState.*` | WebSocket | Event metadata, tokens |

---

## MACD / EMA Computation

### Fast (tick-level, ~300ms)
- **E12**: EMA of `delta`, α = 2/13  
- **E26**: EMA of `delta`, α = 2/27  
- **Gap**: `E12 - E26`  
- **Signal**: EMA of gap, α = 2/10  
- **fHistogram**: `gap - signal`  

### Slow (2s candles, for entry)
- Same formula, sampled every 2 seconds  
- **gap**, **histogram**: used for trigger  
- **crossTime**: when gap crosses zero (new trend)

---

## Entry Conditions (tick-level cross)

| Condition | Formula | Purpose |
|-----------|---------|---------|
| Fast cross | `fPrevHistogram` and `fHistogram` cross zero, `|fHist| ≥ 0.15` | Enter the moment we see cross |
| Gap agree | `|gap| ≥ 0.3` | Slow gap confirms direction |
| Price range | `priceMin ≤ winningPrice ≤ priceMax` | Avoid extremes |
| Episode | Gap crossed zero since `lastHedgeTime` | One trade per trend |
| Spread | `entryPrice + oppAsk < 97¢` | ≥3¢ locked profit possible |

---

## Entry Execution

1. Buy winning side at `marketAsk + 1¢` (GTC)
2. Poll fill every 3s, up to 5 attempts
3. If not filled and trend weakens → cancel, retry at new price or abort
4. On fill → phase = ENTERED, start hedge watch

---

## Hedge Triggers

| Trigger | Condition | Action |
|---------|-----------|--------|
| **-3¢ stop loss** | Entry-side price dropped ≥3¢ from entry | Cancel TP limit, hedge at market |
| **+5¢ take profit** | GTC limit at `0.95 - entryPrice` placed immediately on fill; fills when opp side dips | Resting order, no lag |

---

## Hedge Execution

1. Buy opposite side at `marketAsk + 1¢` (GTC)
2. **Skip** if `100 - (entryPrice + hedgePrice) < -5¢` (max 5¢ loss allowed to close)
3. On fill → phase = IDLE, `lastHedgeTime` = now
4. No cooldown before next entry (if gap crossed zero)

---

## Parameters

| Param | Default | Range | Description |
|-------|---------|-------|-------------|
| `gapOpenThreshold` | 7 | 1–50 | Min EMA gap ($) to trigger |
| `priceMin` | 30 | 1–99 | Min winning side (¢) |
| `priceMax` | 75 | 1–99 | Max winning side (¢) |
| `maxHedgeWaitMs` | 30000 | 5–120s | Timeout before abort |
| `cooldownMs` | 0 | 0–300s | Min time between cycles (0 = none) |
| `shares` | 5 | — | Fixed size per leg |

---

## Mathematical Summary

**Entry (Up):**
```
fPrevHist ≤ 0 ∧ fHist > 0 ∧ fHist ≥ 0.15
→ BUY Up @ ask+1¢
```

**Exit (Up entry):**
```
stop_loss: upPrice ≤ entryPrice − 0.03  → cancel TP limit, hedge at market
take_profit: GTC limit BUY Down @ 0.95−entryPrice placed on fill  → no lag when opp dips
```

---

## No-Trade Zone

- First **15s** of event (prices stabilize)
- Last **45s** of event (resolution risk)

---

## API

- `GET /api/auto-ema` — current state
- `POST /api/auto-ema` — enable/disable, set params  
  `{ enabled, gapOpenThreshold, priceMin, priceMax, maxHedgeWaitMs, cooldownMs }`
