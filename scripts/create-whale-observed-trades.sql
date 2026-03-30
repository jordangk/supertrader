-- Create whale_observed_trades table (same schema as k9_observed_trades)
-- Run this in Supabase SQL editor to enable whale holdings for 15m events

CREATE TABLE IF NOT EXISTS whale_observed_trades (
  id BIGSERIAL PRIMARY KEY,
  slug TEXT NOT NULL,
  outcome TEXT NOT NULL,
  price NUMERIC,
  shares NUMERIC NOT NULL,
  usdc_size NUMERIC,
  tx_hash TEXT,
  trade_timestamp BIGINT,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_whale_observed_slug ON whale_observed_trades(slug);
CREATE INDEX IF NOT EXISTS idx_whale_observed_ts ON whale_observed_trades(trade_timestamp);
