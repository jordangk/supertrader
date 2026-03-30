-- Add market rate columns to whale_observed_trades (at time of trade)
-- Run in Supabase SQL editor after create-whale-observed-trades.sql

ALTER TABLE whale_observed_trades
  ADD COLUMN IF NOT EXISTS market_up NUMERIC,
  ADD COLUMN IF NOT EXISTS market_down NUMERIC;
