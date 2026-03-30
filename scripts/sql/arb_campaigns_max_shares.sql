-- Add configurable max shares cap for auto campaigns.
ALTER TABLE arb_campaigns
ADD COLUMN IF NOT EXISTS max_shares INT NOT NULL DEFAULT 50;

ALTER TABLE arb_campaigns
ALTER COLUMN max_shares SET DEFAULT 50;
