-- Venue-sourced P&L per arb session (Kalshi fills + Polymarket data-api trades, with settlement).
-- Run once in Postgres (e.g. Supabase SQL editor).

ALTER TABLE arb_sessions ADD COLUMN IF NOT EXISTS venue_pnl_kalshi NUMERIC;
ALTER TABLE arb_sessions ADD COLUMN IF NOT EXISTS venue_pnl_polymarket NUMERIC;
ALTER TABLE arb_sessions ADD COLUMN IF NOT EXISTS venue_pnl_total NUMERIC;
ALTER TABLE arb_sessions ADD COLUMN IF NOT EXISTS venue_pnl_status TEXT;
ALTER TABLE arb_sessions ADD COLUMN IF NOT EXISTS venue_pnl_detail JSONB;
ALTER TABLE arb_sessions ADD COLUMN IF NOT EXISTS venue_pnl_computed_at TIMESTAMPTZ;
