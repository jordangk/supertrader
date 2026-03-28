-- Arb trade log: tracks every execute (both legs)
CREATE TABLE IF NOT EXISTS arb_trades (
  id BIGSERIAL PRIMARY KEY,
  session_id UUID REFERENCES arb_sessions(id),
  ts TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  strategy TEXT NOT NULL,  -- 'A' or 'B'

  -- Kalshi leg
  kalshi_ticker TEXT,
  kalshi_side TEXT,         -- 'yes' or 'no'
  kalshi_limit_cents INT,
  kalshi_filled BOOLEAN,
  kalshi_fill_price NUMERIC,
  kalshi_shares INT,
  kalshi_order_id TEXT,
  kalshi_error TEXT,

  -- Poly leg
  poly_token_id TEXT,
  poly_side TEXT,            -- 'up' or 'down'
  poly_limit_price NUMERIC,
  poly_filled BOOLEAN,
  poly_fill_price NUMERIC,
  poly_shares INT,
  poly_order_id TEXT,
  poly_error TEXT,

  -- Summary
  both_filled BOOLEAN NOT NULL DEFAULT FALSE,
  total_cost NUMERIC,
  expected_payout NUMERIC,
  expected_profit NUMERIC
);

CREATE INDEX IF NOT EXISTS idx_arb_trades_session ON arb_trades(session_id, ts DESC);
