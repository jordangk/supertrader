-- Pre-market snipe configuration + runtime state
CREATE TABLE IF NOT EXISTS arb_snipes (
  id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  created_at timestamptz DEFAULT now(),
  asset text NOT NULL,            -- btc, eth, sol, xrp, hype
  side text NOT NULL,             -- up or down
  limit_price numeric NOT NULL,   -- e.g. 0.47
  shares int NOT NULL,            -- e.g. 50
  active boolean DEFAULT true,
  -- Runtime state
  current_slot int,               -- current poly slot timestamp
  poly_order_id text,
  poly_filled int DEFAULT 0,
  kalshi_filled int DEFAULT 0,
  kalshi_order_id text,
  last_result text,               -- 'pending', 'filled', 'cancelled', 'hedged'
  last_run_at timestamptz
);
