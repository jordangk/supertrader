-- Run in Supabase SQL editor (or any Postgres) before using Arb Lab.
-- Stores second-by-second price samples and arbitrage flags.

CREATE TABLE IF NOT EXISTS arb_sessions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  ended_at TIMESTAMPTZ,
  label TEXT,
  external_url TEXT NOT NULL,
  external_selector TEXT,
  polymarket_slug TEXT NOT NULL,
  fee_threshold NUMERIC NOT NULL DEFAULT 0.02
);

CREATE TABLE IF NOT EXISTS arb_ticks (
  id BIGSERIAL PRIMARY KEY,
  session_id UUID NOT NULL REFERENCES arb_sessions(id) ON DELETE CASCADE,
  ts TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  unix_s BIGINT NOT NULL,
  external_price NUMERIC,
  external_no_price NUMERIC,
  poly_up NUMERIC,
  poly_down NUMERIC,
  poly_pair_cost NUMERIC,
  cross_cost NUMERIC,
  cross_edge NUMERIC,
  is_arbitrage BOOLEAN NOT NULL DEFAULT FALSE,
  error_external TEXT,
  error_poly TEXT
);

CREATE INDEX IF NOT EXISTS idx_arb_ticks_session_unix ON arb_ticks(session_id, unix_s DESC);
CREATE INDEX IF NOT EXISTS idx_arb_sessions_created ON arb_sessions(created_at DESC);
