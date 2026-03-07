import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import { WebSocketServer, WebSocket } from 'ws';
import { createClient } from '@supabase/supabase-js';
import { createServer } from 'http';
import { ClobClient } from '@polymarket/clob-client';
import { Wallet } from '@ethersproject/wallet';
import { JsonRpcProvider } from '@ethersproject/providers';
import { Contract } from '@ethersproject/contracts';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { execFile } from 'child_process';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const K9_COPY_STATE_FILE = path.join(__dirname, '.k9-copy-state.json');

const app = express();
const server = createServer(app);
const wss = new WebSocketServer({ server });

app.use(cors());
app.use(express.json());

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);

// ── Polymarket CLOB Client (poly project pattern: sig-type 2, funder) ─────
const CHAIN_ID = 137; // Polygon mainnet
// SignatureType: 0 = EOA, 1 = POLY_PROXY (Magic), 2 = POLY_GNOSIS_SAFE (browser wallet / poly project)
const SIGNATURE_TYPE = 2; // POLY_GNOSIS_SAFE
const FUNDER_ADDRESS = process.env.FUNDER_ADDRESS;
let clobClient = null;

async function initClobClient() {
  try {
    const wallet = new Wallet(process.env.PRIVATE_KEY);
    console.log('[CLOB] Wallet address:', wallet.address);
    console.log('[CLOB] Signature type:', SIGNATURE_TYPE, '(POLY_GNOSIS_SAFE), funder:', FUNDER_ADDRESS);

    // Derive API credentials (try derive first, fall back to create)
    const tempClient = new ClobClient(
      'https://clob.polymarket.com',
      CHAIN_ID,
      wallet,
    );
    let creds;
    try {
      creds = await tempClient.deriveApiKey();
      console.log('[CLOB] API key derived:', creds.key);
    } catch (e1) {
      console.log('[CLOB] deriveApiKey failed, trying createApiKey...');
      try {
        creds = await tempClient.createApiKey();
        console.log('[CLOB] API key created:', creds.key);
      } catch (e2) {
        console.log('[CLOB] createApiKey also failed, trying createOrDeriveApiKey...');
        creds = await tempClient.createOrDeriveApiKey();
        console.log('[CLOB] API key via createOrDerive:', creds.key);
      }
    }

    // poly project pattern: --sig-type 2 --funder <FUNDER_ADDRESS>
    clobClient = new ClobClient(
      'https://clob.polymarket.com',
      CHAIN_ID,
      wallet,
      creds,
      SIGNATURE_TYPE,
      FUNDER_ADDRESS || undefined,
    );
    console.log('[CLOB] Client ready');
  } catch (e) {
    console.error('[CLOB] Failed to init client:', e.message);
  }
}

// ── USDC Allowance Check (funder = Safe that holds USDC) ──────────────────
const POLYGON_RPC = 'https://polygon-mainnet.g.alchemy.com/v2/8kruQGYamUT6J4Ib0aMfw';
const USDC_ADDRESS = '0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174';
const CTF_EXCHANGE = '0x4bFb41d5B3570DeFd03C39a9A4D8dE6Bd8B8982E';
const MAX_UINT256 = '0xffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff';
const USDC_ABI = [
  'function allowance(address owner, address spender) view returns (uint256)',
  'function approve(address spender, uint256 amount) returns (bool)',
];

async function ensureAllowance() {
  try {
    const ownerAddress = FUNDER_ADDRESS || process.env.PROXY_WALLET;
    if (!ownerAddress) return;

    const provider = new JsonRpcProvider(POLYGON_RPC);
    const usdc = new Contract(USDC_ADDRESS, USDC_ABI, provider);
    const allowance = await usdc.allowance(ownerAddress, CTF_EXCHANGE);
    console.log('[ALLOWANCE] USDC allowance for CTF Exchange:', allowance.toString(), '(funder:', ownerAddress + ')');

    const enoughThreshold = '1000000000000'; // 1M USDC (6 decimals)
    if (allowance.lt(enoughThreshold)) {
      console.warn('[ALLOWANCE] Insufficient allowance. Approve USDC for CTF Exchange at polymarket.com before trading.');
    } else {
      console.log('[ALLOWANCE] OK');
    }
  } catch (e) {
    console.error('[ALLOWANCE] Failed:', e.message);
  }
}

// ── State ──────────────────────────────────────────────────────────────────
let activeEvent = null;
const SPLIT_STATE_FILE = new URL('./split-state.json', import.meta.url).pathname;
function loadSplitState() {
  try { return JSON.parse(fs.readFileSync(SPLIT_STATE_FILE, 'utf8')); } catch { return {}; }
}
function saveSplitState(slot) {
  try { fs.writeFileSync(SPLIT_STATE_FILE, JSON.stringify({ lastSplitSlot: slot, ts: Date.now() })); } catch {}
}
let lastSplitSlot = loadSplitState().lastSplitSlot || 0; // persisted across restarts
let liveState = {
  upPrice: null,
  downPrice: null,
  upStartPrice: null,
  downStartPrice: null,
  btcStart: null,
  btcCurrent: null,
  eventSlug: null,
  eventTitle: null,
  tokenUp: null,
  tokenDown: null,
  binanceBtc: null,
};

// Extract numeric ID from slug for DB (bigint column)
function eventDbId() {
  const slug = liveState.eventSlug || '';
  const match = slug.match(/(\d{10,})/);
  return match ? parseInt(match[1]) : null;
}

// ══════════════════════════════════════════════════════════════════════════
// ── K9 Copy-Trading (1% mirror) ─────────────────────────────────────────
// ══════════════════════════════════════════════════════════════════════════
let k9Copy = {
  enabled: false,
  targetSlug: null,       // null = copy ALL k9 events, or specific slug
  eventTime: '1h',        // LOCKED to 1h — only copy hourly BTC events
  pct: 0.02,              // 2% of k9's volume
  batchMode: 'min5',      // 'min5' = 5 units min (Polymarket min) | 'cum50' = batch to 50 units
  orderType: 'FAK',       // 'FAK' = Fill and Kill (immediate) | 'GTC' = Good Till Cancel (resting)
  minShares: 5,           // Polymarket minimum order size
  pending: false,         // lock to prevent nonce collision
  queue: [],              // queued orders while one is in-flight
  buffer: {},             // { 'Up': { buy: 0, sell: 0 }, 'Down': { buy: 0, sell: 0 } }
  tokenIds: {},           // { 'Up': tokenId, 'Down': tokenId } — resolved for target event
  stats: { buys: 0, sells: 0, usdcSpent: 0, usdcReceived: 0, skipped: 0 },
  log: [],                // last 50 copy-trade actions
};

function resetCopyBuffer() {
  k9Copy.buffer = {}; // keyed by "Outcome:slug"
}
resetCopyBuffer();

// Persist copy state to Supabase so it survives restarts — defaults OFF
async function saveK9CopyState() {
  try {
    const { error } = await supabase.from('strategy_settings').upsert({
      strategy: 'k9_copy',
      enabled: k9Copy.enabled,
      value: Math.round(k9Copy.pct * 100), // store pct as integer (2 = 2%)
      updated_at: new Date().toISOString(),
    }, { onConflict: 'strategy' });
    if (error) console.error('[k9-copy] DB save error:', error.message);
    else console.log(`[k9-copy] State saved to DB — enabled: ${k9Copy.enabled}, pct: ${k9Copy.pct * 100}%`);
  } catch (e) { console.error('[k9-copy] Failed to save state:', e.message); }
}

// Restore copy state from Supabase on startup — defaults OFF unless DB says enabled
async function loadK9CopyState() {
  try {
    const { data, error } = await supabase.from('strategy_settings')
      .select('enabled, value')
      .eq('strategy', 'k9_copy')
      .single();
    if (error || !data) {
      console.log('[k9-copy] No DB state found — starting DISABLED');
      return;
    }
    if (data.enabled) {
      k9Copy.enabled = true;
      k9Copy.eventTime = '1h'; // LOCKED — only hourly
      k9Copy.pct = data.value ? data.value / 100 : 0.02;
      k9Copy.orderType = 'FAK';
      resetCopyBuffer();
      console.log(`[k9-copy] RESTORED from DB — enabled: true, pct: ${k9Copy.pct * 100}%, order: ${k9Copy.orderType}`);
    } else {
      console.log('[k9-copy] DB state: DISABLED — not starting copy');
    }
  } catch (e) { console.error('[k9-copy] Failed to load state:', e.message); }
}

// Resolve token IDs for the target event (1h events need lookup)
async function resolveCopyTokens(slug) {
  try {
    const r = await fetch(`https://gamma-api.polymarket.com/events?slug=${slug}`);
    const data = await r.json();
    if (!data?.length) return false;
    const m = data[0].markets?.[0];
    if (!m) return false;
    const tids = JSON.parse(m.clobTokenIds || '[]');
    const outcomes = JSON.parse(m.outcomes || '["Up","Down"]');
    k9Copy.tokenIds = {};
    tids.forEach((tid, i) => { k9Copy.tokenIds[outcomes[i]] = tid; });
    console.log(`[k9-copy] Resolved tokens for ${slug}: Up=${tids[0]?.slice(0,20)}..., Down=${tids[1]?.slice(0,20)}...`);
    return true;
  } catch (e) {
    console.error('[k9-copy] Token resolve error:', e.message);
    return false;
  }
}

// Get current market price for a token
async function getCopyPrice(tokenId, orderSide) {
  // For BUY orders: fetch ASK price (side=sell) so we cross the spread
  // For SELL orders: fetch BID price (side=buy) so we hit bids
  const bookSide = orderSide === 'buy' ? 'sell' : 'buy';
  try {
    const res = await fetch(`https://clob.polymarket.com/price?token_id=${tokenId}&side=${bookSide}`);
    const data = await res.json();
    return data.price ? parseFloat(data.price) : null;
  } catch { return null; }
}

// Accumulate k9 trades grouped by second, then flush per-outcome net direction
// Only fires when grouped notional >= $0.01 and accumulated shares >= 5
function accumulateCopyTrades(trades) {
  if (!k9Copy.enabled) return;

  // Group by second (trades in same batch are same second)
  const byOutcome = {};
  for (const t of trades) {
    if (k9Copy.targetSlug && t.slug !== k9Copy.targetSlug) continue;
    if (k9Copy.eventTime) {
      const is5m = t.slug.includes('-5m-');
      const is15m = t.slug.includes('-15m-');
      const is1h = !is5m && !is15m && t.slug.startsWith('bitcoin-up-or-down');
      if (k9Copy.eventTime === '5m' && !is5m) continue;
      if (k9Copy.eventTime === '15m' && !is15m) continue;
      if (k9Copy.eventTime === '1h' && !is1h) continue;
    }
    const side = t.side || 'buy';
    const outcome = t.outcome;
    const key = `${outcome}:${t.slug}`;
    if (!byOutcome[key]) byOutcome[key] = { shares: 0, usdc: 0, slug: t.slug, outcome };
    if (side === 'buy') {
      byOutcome[key].shares += t.shares;
      byOutcome[key].usdc += t.usdcSize;
    } else {
      byOutcome[key].shares -= t.shares;
      byOutcome[key].usdc -= t.usdcSize;
    }
  }

  // For each outcome with net movement, accumulate into buffer (keyed by outcome:slug)
  for (const [key, agg] of Object.entries(byOutcome)) {
    const notional = Math.abs(agg.usdc) * k9Copy.pct;
    if (notional < 0.01) continue; // skip if grouped notional < $0.01

    const copyShares = Math.abs(agg.shares) * k9Copy.pct;
    const side = agg.shares > 0 ? 'buy' : 'sell';

    const bufKey = `${agg.outcome}:${agg.slug}`;
    if (!k9Copy.buffer[bufKey]) k9Copy.buffer[bufKey] = { buy: 0, sell: 0, slug: agg.slug, outcome: agg.outcome, firstSeen: Date.now() };
    k9Copy.buffer[bufKey][side] += copyShares;
    k9Copy.buffer[bufKey].firstSeen = Date.now(); // reset timer on every new trade

    // Buffer accumulates — flushed every 1s by the interval below
  }
}

const BUFFER_MAX_AGE_MS = 30_000; // drop unmatched orders after 30s (event will have moved)

// Flush buffer every 1 second — fire when ≥$1 worth (FAK minimum)
setInterval(() => {
  if (!k9Copy.enabled) return;
  const now = Date.now();
  for (const [bufKey, buf] of Object.entries(k9Copy.buffer)) {
    const outcome = buf.outcome || bufKey.split(':')[0];
    const slug    = buf.slug    || liveState.eventSlug || '';

    // Drop stale buffer entries — 5min for 1h events, 30s for others
    const is1hEvent = slug.startsWith('bitcoin-up-or-down') && !slug.includes('-5m-') && !slug.includes('-15m-');
    const maxAge = is1hEvent ? 300_000 : BUFFER_MAX_AGE_MS; // 5 min vs 30s
    if (buf.firstSeen && (now - buf.firstSeen) > maxAge) {
      const dropped = (buf.buy + buf.sell).toFixed(2);
      console.log(`[k9-copy] Buffer expired — dropping ${dropped}sh on ${slug} (${outcome}, >${maxAge/1000}s old)`);
      delete k9Copy.buffer[bufKey];
      continue;
    }

    // Drop buffer entries for hourly events that have already closed
    // Hourly slugs: bitcoin-up-or-down-{month}-{day}-{hour}{am/pm}-et
    if (slug.startsWith('bitcoin-up-or-down') && !slug.includes('-5m-') && !slug.includes('-15m-')) {
      const isActiveLiveSlug = Object.values(k9TokenMap || {}).some(v => v.slug === slug);
      if (!isActiveLiveSlug) {
        const dropped = (buf.buy + buf.sell).toFixed(2);
        console.log(`[k9-copy] Hourly market closed — dropping ${dropped}sh on ${slug} (${outcome})`);
        delete k9Copy.buffer[bufKey];
        continue;
      }
    }

    for (const side of ['buy', 'sell']) {
      if (buf[side] > 0) {
        const livePrice = (outcome === 'Up')
          ? parseFloat(liveState.yesPrice || 0.5)
          : parseFloat(liveState.noPrice || 0.5);
        const shares = Math.floor(buf[side] * 100) / 100; // 2dp
        const estUsdc = Number((shares * livePrice).toFixed(2));
        if (shares >= 0.01 && estUsdc >= 1.0) {
          buf[side] -= shares;
          enqueueCopyOrder(outcome, side, shares, k9Copy.targetSlug || slug);
        }
      }
    }
  }
}, 1000);

// Queue a copy order (sequential to avoid nonce collisions)
function enqueueCopyOrder(outcome, side, shares, slug) {
  k9Copy.queue.push({ outcome, side, shares, slug, ts: Date.now() });
  processCopyQueue();
}

async function processCopyQueue() {
  if (k9Copy.pending || !k9Copy.queue.length) return;
  k9Copy.pending = true;

  const order = k9Copy.queue.shift();
  try {
    await executeCopyOrder(order);
  } catch (e) {
    console.error(`[k9-copy] Order error: ${e.message}`);
    const logEntry = { ts: Date.now(), ...order, error: e.message };
    k9Copy.log.push(logEntry);
    if (k9Copy.log.length > 50) k9Copy.log.shift();
  }

  k9Copy.pending = false;
  if (k9Copy.queue.length) setTimeout(processCopyQueue, 100);
}

async function executeCopyOrder({ outcome, side, shares, slug }) {
  if (!clobClient) { console.error('[k9-copy] CLOB client not ready'); return; }

  // Resolve tokenId — prefer k9Copy.tokenIds (for 1h events), fall back to k9TokenMap
  let tokenId = k9Copy.tokenIds[outcome];
  if (!tokenId) {
    // Try to find in k9TokenMap
    for (const [tid, info] of Object.entries(k9TokenMap)) {
      if (info.slug === slug && info.outcome === outcome) { tokenId = tid; break; }
    }
  }
  if (!tokenId) { console.error(`[k9-copy] No tokenId for ${outcome} on ${slug}`); return; }

  // Get market price — ask for buys, bid for sells
  let price = await getCopyPrice(tokenId, side);
  if (!price || price <= 0 || price >= 1) {
    // Put shares back in buffer for retry — price may recover
    const retryKey = `${outcome}:${slug}`;
    if (!k9Copy.buffer[retryKey]) k9Copy.buffer[retryKey] = { buy: 0, sell: 0, slug, outcome, firstSeen: Date.now() };
    k9Copy.buffer[retryKey][side] += shares;
    console.log(`[k9-copy] Bad price ${price} for ${outcome} ${side} — ${shares.toFixed(2)}sh back to buffer`);
    return;
  }

  const tickSize = '0.01';
  const tick = parseFloat(tickSize);

  if (side === 'buy') {
    const buyPrice = Math.min(Number((Math.round((price + 0.04) / tick) * tick).toFixed(2)), 0.99);
    // Use createMarketOrder — pass USDC amount directly (avoids 2dp mismatch)
    const sizeUsd = Number((shares * buyPrice).toFixed(2));
    if (sizeUsd < 1.0) { k9Copy.stats.skipped++; return; }

    console.log(`[k9-copy] BUY ${outcome} ~${shares.toFixed(2)}sh @ ${buyPrice} FAK ($${sizeUsd.toFixed(2)}) [${slug}]`);
    try {
      const signed = await clobClient.createMarketOrder(
        { tokenID: tokenId, price: buyPrice, amount: sizeUsd, side: 'BUY' },
        { tickSize, negRisk: false }
      );
      const result = await clobClient.postOrder(signed, 'FAK');
      const orderId = result?.orderID || result?.orderIds?.[0];
      const apiErr = result?.error || result?.errorMsg;
      const httpStatus = result?.status;

      // Detect failed orders (400, error field, or no orderId)
      if (apiErr || (httpStatus && httpStatus >= 400) || (!orderId && !result?.success)) {
        const errMsg = apiErr || `HTTP ${httpStatus}` || 'No orderID returned';
        const isNoMatch = String(errMsg).includes('no orders found to match');
        if (isNoMatch) {
          // Put shares back in buffer for retry on next flush — keep slug so it retries on the correct market
          const retryKey = `${outcome}:${slug}`;
          if (!k9Copy.buffer[retryKey]) k9Copy.buffer[retryKey] = { buy: 0, sell: 0, slug, outcome, firstSeen: Date.now() };
          k9Copy.buffer[retryKey].buy += shares;
          console.log(`[k9-copy] BUY no match — ${shares.toFixed(2)}sh back to buffer (retry next flush)`);
        } else {
          console.error(`[k9-copy] BUY rejected: ${errMsg} (full: ${JSON.stringify(result)})`);
        }
        k9Copy.stats.errors = (k9Copy.stats.errors || 0) + 1;
        const logEntry = { ts: Date.now(), side: 'buy', outcome, shares, price: buyPrice, usdc: sizeUsd, error: String(errMsg), status: httpStatus };
        k9Copy.log.push(logEntry);
        if (k9Copy.log.length > 100) k9Copy.log.shift();
        broadcast({ type: 'k9_copy', action: 'error', ...logEntry });
        return;
      }

      console.log(`[k9-copy] BUY ${k9Copy.orderType}: ${orderId}`);
      k9Copy.stats.buys++;
      k9Copy.stats.usdcSpent += sizeUsd;
      const logEntry = { ts: Date.now(), side: 'buy', outcome, shares, price: buyPrice, usdc: sizeUsd, orderId, status: 'ok' };
      k9Copy.log.push(logEntry);
      if (k9Copy.log.length > 100) k9Copy.log.shift();
      broadcast({ type: 'k9_copy', action: 'buy', ...logEntry });
    } catch (e) {
      const errMsg = e.message || String(e);
      console.error(`[k9-copy] BUY error: ${errMsg}`);
      k9Copy.stats.errors = (k9Copy.stats.errors || 0) + 1;
      const logEntry = { ts: Date.now(), side: 'buy', outcome, shares, price: buyPrice, usdc: sizeUsd, error: errMsg };
      k9Copy.log.push(logEntry);
      if (k9Copy.log.length > 100) k9Copy.log.shift();
      broadcast({ type: 'k9_copy', action: 'error', ...logEntry });
    }

  } else {
    const sellPrice = Math.max(Number((Math.round((price - 0.04) / tick) * tick).toFixed(2)), 0.01);

    // Check how many we actually hold
    try {
      const bal = await clobClient.getBalanceAllowance({ asset_type: 'CONDITIONAL', token_id: tokenId });
      const held = parseFloat(bal?.balance || '0') / 1e6;
      if (held < 0.01) {
        console.log(`[k9-copy] SELL skip ${outcome}: hold ${held.toFixed(2)}`);
        k9Copy.stats.skipped++;
        return;
      }
      shares = Math.min(shares, held);
    } catch (e) {
      console.error(`[k9-copy] Balance check error: ${e.message}`);
    }

    shares = Math.floor(shares * 100) / 100; // 2dp
    const sellUsdc = Number((shares * sellPrice).toFixed(2));
    if (sellUsdc < 1.0 || shares < 0.01) { k9Copy.stats.skipped++; return; }

    console.log(`[k9-copy] SELL ${outcome} ${shares.toFixed(2)}sh @ ${sellPrice} FAK ($${sellUsdc.toFixed(2)}) [${slug}]`);
    try {
      // Use createMarketOrder for sells too — pass shares as amount
      const signed = await clobClient.createMarketOrder(
        { tokenID: tokenId, price: sellPrice, amount: shares, side: 'SELL' },
        { tickSize, negRisk: false }
      );
      const result = await clobClient.postOrder(signed, 'FAK');
      const orderId = result?.orderID || result?.orderIds?.[0];
      const apiErr = result?.error || result?.errorMsg;
      const httpStatus = result?.status;

      if (apiErr || (httpStatus && httpStatus >= 400) || (!orderId && !result?.success)) {
        const errMsg = apiErr || `HTTP ${httpStatus}` || 'No orderID returned';
        const isNoMatch = String(errMsg).includes('no orders found to match');
        if (isNoMatch) {
          // Put shares back in buffer for retry on next flush — keep slug so it retries on the correct market
          const retryKey = `${outcome}:${slug}`;
          if (!k9Copy.buffer[retryKey]) k9Copy.buffer[retryKey] = { buy: 0, sell: 0, slug, outcome, firstSeen: Date.now() };
          k9Copy.buffer[retryKey].sell += shares;
          console.log(`[k9-copy] SELL no match — ${shares.toFixed(2)}sh back to buffer (retry next flush)`);
        } else {
          console.error(`[k9-copy] SELL rejected: ${errMsg} (full: ${JSON.stringify(result)})`);
        }
        k9Copy.stats.errors = (k9Copy.stats.errors || 0) + 1;
        const logEntry = { ts: Date.now(), side: 'sell', outcome, shares, price: sellPrice, error: String(errMsg), status: httpStatus };
        k9Copy.log.push(logEntry);
        if (k9Copy.log.length > 100) k9Copy.log.shift();
        broadcast({ type: 'k9_copy', action: 'error', ...logEntry });
        return;
      }

      console.log(`[k9-copy] SELL ${k9Copy.orderType}: ${orderId}`);
      k9Copy.stats.sells++;
      k9Copy.stats.usdcReceived += shares * sellPrice;
      const logEntry = { ts: Date.now(), side: 'sell', outcome, shares, price: sellPrice, orderId, status: 'ok' };
      k9Copy.log.push(logEntry);
      if (k9Copy.log.length > 100) k9Copy.log.shift();
      broadcast({ type: 'k9_copy', action: 'sell', ...logEntry });
    } catch (e) {
      const errMsg = e.message || String(e);
      console.error(`[k9-copy] SELL error: ${errMsg}`);
      k9Copy.stats.errors = (k9Copy.stats.errors || 0) + 1;
      const logEntry = { ts: Date.now(), side: 'sell', outcome, shares, price: sellPrice, error: errMsg };
      k9Copy.log.push(logEntry);
      if (k9Copy.log.length > 100) k9Copy.log.shift();
      broadcast({ type: 'k9_copy', action: 'error', ...logEntry });
    }
  }
}

// ── Fetch current mid-market price from CLOB REST ────────────────────────
async function fetchClobPrice(tokenId) {
  try {
    const res = await fetch(`https://clob.polymarket.com/price?token_id=${tokenId}&side=buy`);
    const data = await res.json();
    return data.price ? parseFloat(data.price) : null;
  } catch (e) {
    console.error('[CLOB REST] price fetch error:', e.message);
    return null;
  }
}

async function fetchClobBook(tokenId) {
  try {
    const res = await fetch(`https://clob.polymarket.com/book?token_id=${tokenId}`);
    const data = await res.json();
    const bestBid = data.bids?.[0]?.price;
    const bestAsk = data.asks?.[0]?.price;
    if (bestBid && bestAsk) return (parseFloat(bestBid) + parseFloat(bestAsk)) / 2;
    if (bestBid) return parseFloat(bestBid);
    if (bestAsk) return parseFloat(bestAsk);
    return null;
  } catch (e) {
    console.error('[CLOB REST] book fetch error:', e.message);
    return null;
  }
}

async function fetchInitialPrices() {
  if (!liveState.tokenUp || !liveState.tokenDown) return;
  const [upPrice, downPrice] = await Promise.all([
    fetchClobPrice(liveState.tokenUp),
    fetchClobPrice(liveState.tokenDown),
  ]);
  console.log('[CLOB REST] initial prices — up:', upPrice, 'down:', downPrice);
  if (upPrice != null) liveState.upPrice = upPrice;
  if (downPrice != null) liveState.downPrice = downPrice;
  // Capture start prices (first prices we see for this event)
  if (liveState.upStartPrice == null && upPrice != null) liveState.upStartPrice = upPrice;
  if (liveState.downStartPrice == null && downPrice != null) liveState.downStartPrice = downPrice;
  broadcast({ type: 'prices', ...liveState });
}

// ── Broadcast to all frontend clients ─────────────────────────────────────
function broadcast(data) {
  const msg = JSON.stringify(data);
  wss.clients.forEach(c => { if (c.readyState === WebSocket.OPEN) c.send(msg); });
}

// Track when WS last gave us a real price update
let lastWsPrice = 0;

// ── Fetch active 5m BTC event from Polymarket ─────────────────────────────
async function fetchActiveEvent() {
  try {
    // Find current 5m BTC event by timestamp
    const now = Math.floor(Date.now() / 1000);
    // Round down to nearest 5 min
    const slot = Math.floor(now / 300) * 300;
    const slug = `btc-updown-5m-${slot}`;

    const res = await fetch(`https://gamma-api.polymarket.com/events?slug=${slug}`);
    const data = await res.json();
    const event = Array.isArray(data) ? data[0] : data;
    if (!event) return null;

    const market = event.markets?.[0];
    if (!market) return null;

    const tokenIds = typeof market.clobTokenIds === 'string'
      ? JSON.parse(market.clobTokenIds)
      : market.clobTokenIds;

    const conditionId = market.conditionId ?? market.condition_id;

    // min_incentive_size & max_incentive_spread from Gamma Markets API (per liquidity-rewards docs)
    const minIncentiveSize = market.rewardsMinSize ?? market.min_incentive_size ?? null;
    const maxIncentiveSpread = market.rewardsMaxSpread ?? market.max_incentive_spread ?? null;

    // Reward allocations for epoch from CLOB API
    let rewardsConfig = [];
    if (conditionId && clobClient) {
      try {
        const raw = await clobClient.getRawRewardsForMarket(conditionId);
        const arr = Array.isArray(raw) ? raw : (raw?.data ? (Array.isArray(raw.data) ? raw.data : [raw.data]) : []);
        const m = arr[0] || arr;
        if (m?.rewards_config) rewardsConfig = Array.isArray(m.rewards_config) ? m.rewards_config : [m.rewards_config];
      } catch (e) {
        console.error('[EVENT] rewards fetch:', e.message);
      }
    }

    console.log('[EVENT] Market flags:', {
      negRisk: market.negRisk,
      enableNegRisk: event.enableNegRisk,
      tickSize: market.orderPriceMinTickSize,
      minIncentiveSize, maxIncentiveSpread, rewardsConfigCount: rewardsConfig.length,
    });

    return {
      slug: event.slug,
      title: event.title,
      startDate: event.startDate,
      endDate: event.endDate,
      tokenUp: tokenIds[0],   // index 0 = Up
      tokenDown: tokenIds[1], // index 1 = Down
      marketId: market.id,
      conditionId: conditionId || null,
      tickSize: market.orderPriceMinTickSize || '0.01',
      negRisk: !!market.negRisk,
      min_incentive_size: minIncentiveSize,
      max_incentive_spread: maxIncentiveSpread,
      rewards_config: rewardsConfig,
    };
  } catch (e) {
    console.error('fetchActiveEvent error:', e.message);
    return null;
  }
}

// ── Polymarket CLOB WebSocket for live prices ──────────────────────────────
let clobWs = null;

function connectClobStream(tokenIds) {
  if (clobWs) clobWs.close();

  clobWs = new WebSocket('wss://ws-subscriptions-clob.polymarket.com/ws/market');

  clobWs.on('open', () => {
    console.log('[CLOB WS] connected');
    clobWs.send(JSON.stringify({
      assets_ids: tokenIds,
      type: 'market',
    }));
  });

  clobWs.on('message', (raw) => {
    try {
      const msgs = JSON.parse(raw);
      const arr = Array.isArray(msgs) ? msgs : [msgs];
      let changed = false;
      for (const msg of arr) {
        let price = null;
        let assetId = msg.asset_id || msg.market;

        // Only use trade-based prices, NOT book snapshots (which reset to 50¢ on thin books)
        if (msg.event_type === 'price_change' || msg.type === 'price_change') {
          price = parseFloat(msg.price);
        } else if (msg.event_type === 'last_trade_price' || msg.type === 'last_trade_price') {
          price = parseFloat(msg.price);
        }
        // Skip book messages — they cause flashing with stale mid-market on thin 5m events

        if (price != null && !isNaN(price) && price > 0 && price < 1) {
          if (assetId === liveState.tokenUp) {
            liveState.upPrice = price;
            if (liveState.upStartPrice == null) liveState.upStartPrice = price;
            changed = true;
          } else if (assetId === liveState.tokenDown) {
            liveState.downPrice = price;
            if (liveState.downStartPrice == null) liveState.downStartPrice = price;
            changed = true;
          }
        }
      }
      if (changed) {
        lastWsPrice = Date.now();
        broadcast({ type: 'prices', ...liveState });
      }
    } catch {}
  });

  clobWs.on('close', () => {
    console.log('[CLOB WS] disconnected, reconnecting in 3s...');
    setTimeout(() => { if (liveState.tokenUp) connectClobStream([liveState.tokenUp, liveState.tokenDown]); }, 3000);
  });

  clobWs.on('error', (e) => console.error('[CLOB WS] error:', e.message));
}

// ── Binance BTC/USDT real-time price ─────────────────────────────────────
let binanceWs = null;
let binanceRetryDelay = 3000;

function connectBinanceStream() {
  if (binanceWs) binanceWs.close();
  binanceWs = new WebSocket('wss://stream.binance.com:9443/ws/btcusdt@trade');
  binanceWs.on('open', () => {
    binanceRetryDelay = 3000;
    console.log('[BINANCE] connected to BTC/USDT trade stream');
  });
  binanceWs.on('message', (raw) => {
    try {
      const msg = JSON.parse(raw);
      if (msg.p) {
        const newPrice = parseFloat(msg.p);
        const changed = newPrice !== liveState.binanceBtc;
        liveState.binanceBtc = newPrice;
        broadcast({ type: 'binance_btc', price: newPrice });
        // if (changed) pushSnapshot(); // paused
      }
    } catch {}
  });
  binanceWs.on('close', () => {
    console.log(`[BINANCE] disconnected, reconnecting in ${binanceRetryDelay / 1000}s...`);
    setTimeout(connectBinanceStream, binanceRetryDelay);
    binanceRetryDelay = Math.min(binanceRetryDelay * 2, 30000);
  });
  binanceWs.on('error', (e) => console.error('[BINANCE] error:', e.message));
}

// ── BTC price from Polymarket RTDS (Chainlink feed) ──────────────────────
let btcWs = null;
let btcRetryDelay = 3000;

function connectBtcStream() {
  if (btcWs) btcWs.close();
  btcWs = new WebSocket('wss://ws-live-data.polymarket.com');
  btcWs.on('open', () => {
    btcRetryDelay = 3000; // Reset backoff on successful connect
    console.log('[BTC RTDS] connected to Polymarket Chainlink feed');
    btcWs.send(JSON.stringify({
      action: 'subscribe',
      subscriptions: [{
        topic: 'crypto_prices_chainlink',
        type: '*',
        filters: '{"symbol":"btc/usd"}',
      }],
    }));
  });
  btcWs.on('message', (raw) => {
    try {
      const msg = JSON.parse(raw);
      if (msg.topic === 'crypto_prices_chainlink' && msg.payload?.value) {
        liveState.btcCurrent = parseFloat(msg.payload.value);
        if (liveState.btcStart == null) liveState.btcStart = liveState.btcCurrent;
        broadcast({ type: 'btc', current: liveState.btcCurrent, start: liveState.btcStart });
      }
    } catch {}
  });
  btcWs.on('close', () => {
    console.log(`[BTC RTDS] disconnected, reconnecting in ${btcRetryDelay / 1000}s...`);
    setTimeout(connectBtcStream, btcRetryDelay);
    btcRetryDelay = Math.min(btcRetryDelay * 2, 30000); // Exponential backoff, max 30s
  });
  btcWs.on('error', (e) => console.error('[BTC RTDS] error:', e.message));
}

// ── Refresh event on the 5-min boundary ──────────────────────────────────
let eventTimer = null;

let manualEventOverride = false; // when true, skip auto-refresh to preserve user's manual selection

// ── CTF Split/Merge: Python scripts via Safe wallet execTransaction ────────
const SPLIT_SCRIPT = path.join(__dirname, 'scripts', 'split-position.py');
const MERGE_SCRIPT = path.join(__dirname, 'scripts', 'merge-positions.py');

let autoSplit = { enabled: true, amount: 50 }; // $50 USDC → 50 Up + 50 Down = 100 shares total

function runPythonScript(scriptPath, args) {
  return new Promise((resolve, reject) => {
    execFile('python3', [scriptPath, ...args], {
      timeout: 180_000, // 3 min max (approve + split can take time)
      env: { ...process.env, POLYGON_RPC_URL: POLYGON_RPC },
    }, (err, stdout, stderr) => {
      if (stderr) console.error(`[PYTHON] stderr: ${stderr}`);
      if (err) {
        // Try to parse JSON error from stdout
        try {
          const result = JSON.parse(stdout);
          return reject(new Error(result.error || err.message));
        } catch (_) {}
        return reject(err);
      }
      try {
        const result = JSON.parse(stdout);
        if (!result.success) return reject(new Error(result.error || 'Script failed'));
        resolve(result);
      } catch (e) {
        reject(new Error(`Failed to parse script output: ${stdout}`));
      }
    });
  });
}

async function executeSplit(amountUsd) {
  if (!activeEvent?.conditionId) throw new Error('No conditionId for active event');

  const safeAddr = FUNDER_ADDRESS;
  if (!safeAddr) throw new Error('FUNDER_ADDRESS not set');
  const privateKey = process.env.PRIVATE_KEY;
  if (!privateKey) throw new Error('PRIVATE_KEY not set');

  console.log(`[SPLIT] Splitting $${amountUsd} USDC → ${amountUsd} Up + ${amountUsd} Down on ${activeEvent.slug}`);
  console.log(`[SPLIT] conditionId=${activeEvent.conditionId}, safe=${safeAddr?.slice(0, 10)}...`);

  const result = await runPythonScript(SPLIT_SCRIPT, [
    privateKey, safeAddr, activeEvent.conditionId, String(amountUsd),
  ]);

  console.log(`[SPLIT] Done! tx=${result.tx_hash}`);

  // Record in DB — use activeEvent.slug (NOT liveState) so pre-split records under upcoming event
  const slugForDb = activeEvent.slug || liveState.eventSlug;
  const match = String(slugForDb).match(/(\d{10,})/);
  const eventIdForDb = match ? parseInt(match[1]) : eventDbId();

  // Mark this slot as split — persisted to disk so PM2 restarts don't re-split
  lastSplitSlot = eventIdForDb;
  saveSplitState(eventIdForDb);

  const now = new Date().toISOString();
  for (const dir of ['up', 'down']) {
    await supabase.from('polymarket_trades').insert({
      purchase_time: now,
      polymarket_event_id: eventIdForDb,
      minute: Math.floor(eventIdForDb / 60), // minute bucket (epoch seconds → minutes)
      direction: dir,
      purchase_price: 0.50,
      purchase_amount: amountUsd * 0.5,
      shares: amountUsd,
      order_status: 'filled',
      order_type: 'live',
      btc_price_at_purchase: liveState.btcCurrent,
      notes: JSON.stringify({ type: 'ctf-split', txHash: result.tx_hash, amount: amountUsd }),
    }).then(({ error }) => {
      if (error) console.error(`[SPLIT] DB insert ${dir} error:`, error.message);
    });
  }

  broadcast({ type: 'split', slug: activeEvent.slug, amount: amountUsd, txHash: result.tx_hash });

  return {
    txHash: result.tx_hash,
    amount: amountUsd,
    upShares: amountUsd,
    downShares: amountUsd,
  };
}

async function executeMerge(amountUsd) {
  if (!activeEvent?.conditionId) throw new Error('No conditionId for active event');

  const safeAddr = FUNDER_ADDRESS;
  if (!safeAddr) throw new Error('FUNDER_ADDRESS not set');
  const privateKey = process.env.PRIVATE_KEY;
  if (!privateKey) throw new Error('PRIVATE_KEY not set');

  console.log(`[MERGE] Merging ${amountUsd} pairs → $${amountUsd} USDC on ${activeEvent.slug}`);
  console.log(`[MERGE] conditionId=${activeEvent.conditionId}, safe=${safeAddr}`);

  const result = await runPythonScript(MERGE_SCRIPT, [
    privateKey, safeAddr, activeEvent.conditionId, String(amountUsd),
  ]);

  console.log(`[MERGE] Done! tx=${result.tx_hash}`);

  broadcast({ type: 'merge', slug: activeEvent.slug, amount: amountUsd, txHash: result.tx_hash });

  return { txHash: result.tx_hash, amount: amountUsd };
}

let preSplitTimer = null;

function scheduleNextEvent() {
  if (eventTimer) clearTimeout(eventTimer);
  if (preSplitTimer) clearTimeout(preSplitTimer);

  const now = Date.now();
  const nowSecs = Math.floor(now / 1000);
  const nextSlot = (Math.floor(nowSecs / 300) + 1) * 300;

  // If locked to 1h only, skip 5m splits — schedule hourly splits instead
  if (!autoSplit.enabled || !k9Copy.enabled || k9Copy.eventTime === '1h') {
    const delay = (nextSlot * 1000) - now + 2000;
    eventTimer = setTimeout(refreshEvent, delay);
    // Schedule hourly pre-split if in 1h mode
    if (k9Copy.eventTime === '1h' && autoSplit.enabled && k9Copy.enabled) {
      scheduleHourlySplit();
    }
    return;
  }

  // Pre-split: 15s BEFORE the next 5m boundary — retry every 2s until event is available
  const PRE_SPLIT_START_SECONDS = 15;
  const PRE_SPLIT_RETRY_MS = 2000;
  const preSplitStartDelay = (nextSlot * 1000) - now - (PRE_SPLIT_START_SECONDS * 1000);

  const runPreSplit = async () => {
    const upcomingSlug = `btc-updown-5m-${nextSlot}`;
    for (let attempt = 1; attempt <= 10; attempt++) {
      try {
        console.log(`[PRE-SPLIT] Attempt ${attempt}: fetching ${upcomingSlug}`);
        const r = await fetch(`https://gamma-api.polymarket.com/events?slug=${upcomingSlug}`);
        const data = await r.json();
        const ev = Array.isArray(data) ? data[0] : data;
        const cid = ev?.markets?.[0]?.conditionId;
        if (cid) {
          console.log(`[PRE-SPLIT] Found conditionId=${cid}, splitting $${autoSplit.amount}...`);
          const prevConditionId = activeEvent?.conditionId;
          const prevSlug = activeEvent?.slug;
          if (activeEvent) activeEvent.conditionId = cid;
          else activeEvent = { conditionId: cid, slug: upcomingSlug };
          activeEvent.slug = upcomingSlug;
          const result = await executeSplit(autoSplit.amount);
          console.log(`[PRE-SPLIT] Success: $${result.amount} → ${result.upShares} Up + ${result.downShares} Down, tx=${result.txHash}`);
          // Credit memory so low-stock monitor starts fresh knowing we have shares
          inMemoryShares = { up: result.amount, down: result.amount };
          // lastSplitSlot is set inside executeSplit — fallback will skip this slot
          if (prevSlug && prevSlug !== upcomingSlug) {
            activeEvent.conditionId = prevConditionId;
            activeEvent.slug = prevSlug;
          }
          return;
        }
      } catch (e) {
        console.error(`[PRE-SPLIT] Attempt ${attempt} failed:`, e.message);
      }
      const msToBoundary = (nextSlot * 1000) - Date.now();
      if (msToBoundary < 2000) break; // too close, let fallback handle
      await new Promise(r => setTimeout(r, PRE_SPLIT_RETRY_MS));
    }
    console.log(`[PRE-SPLIT] Event ${upcomingSlug} not available or split failed — fallback will try after refresh`);
  };

  // Pre-split always runs when enabled (even with manual override — split is for copy-trading)
  if (autoSplit.enabled) {
    if (preSplitStartDelay > 0) {
      preSplitTimer = setTimeout(runPreSplit, preSplitStartDelay);
      console.log(`[EVENT] Pre-split in ${Math.round(preSplitStartDelay / 1000)}s, refresh in ${Math.round((nextSlot * 1000 - now + 2000) / 1000)}s${manualEventOverride ? ' (manual override)' : ''}`);
    } else if (preSplitStartDelay > -PRE_SPLIT_START_SECONDS * 1000) {
      console.log(`[EVENT] Within ${PRE_SPLIT_START_SECONDS}s of boundary, pre-split now`);
      runPreSplit();
    }
  }

  // Main refresh: boundary + 2s (always schedule next)
  const delay = (nextSlot * 1000) - now + 2000;
  eventTimer = setTimeout(async () => {
    if (!manualEventOverride) {
      await refreshEvent();
    } else {
      // Manual override: don't switch UI, but still run split for the new event if needed
      const upcomingSlug = `btc-updown-5m-${nextSlot}`;
      const { data: rows } = await supabase.from('polymarket_trades').select('notes').eq('polymarket_event_id', nextSlot);
      const ctfCount = (rows || []).filter(r => { try { return r.notes && JSON.parse(r.notes).type === 'ctf-split'; } catch { return false; } }).length;
      if (autoSplit.enabled && ctfCount < 2 && k9Copy.eventTime !== '1h') {
        try {
          const r = await fetch(`https://gamma-api.polymarket.com/events?slug=${upcomingSlug}`);
          const j = await r.json();
          const ev = Array.isArray(j) ? j[0] : j;
          const cid = ev?.markets?.[0]?.conditionId;
          if (cid) {
            console.log(`[AUTO-SPLIT] Manual override: splitting for ${upcomingSlug}...`);
            const prevCid = activeEvent?.conditionId;
            const prevSlug = activeEvent?.slug;
            if (activeEvent) activeEvent.conditionId = cid;
            else activeEvent = { conditionId: cid, slug: upcomingSlug };
            activeEvent.slug = upcomingSlug;
            const result = await executeSplit(autoSplit.amount);
            console.log(`[AUTO-SPLIT] Success: $${result.amount} → ${result.upShares} Up + ${result.downShares} Down, tx=${result.txHash}`);
            if (prevSlug) { activeEvent.conditionId = prevCid; activeEvent.slug = prevSlug; }
          }
        } catch (e) {
          console.error('[AUTO-SPLIT] Manual-override split failed:', e.message);
        }
      }
    }
    scheduleNextEvent();
  }, delay);
}

// ── Hourly event split scheduling ─────────────────────────────────────────
let hourlySplitTimer = null;
let hourlyActiveEvent = null; // { slug, conditionId } for the current 1h event we're trading

function getNextHourlyBoundary() {
  // Next hour boundary in ET
  const now = new Date();
  const next = new Date(now);
  next.setMinutes(0, 0, 0);
  next.setHours(next.getHours() + 1);
  return next.getTime();
}

function getUpcomingHourlySlug() {
  const MONTHS = ['january','february','march','april','may','june','july','august','september','october','november','december'];
  const fmt = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', hour: 'numeric', hour12: true, day: 'numeric', month: 'numeric', year: 'numeric' });
  const nextHour = new Date(getNextHourlyBoundary());
  const parts = {};
  fmt.formatToParts(nextHour).forEach(p => { parts[p.type] = p.value; });
  const month = MONTHS[parseInt(parts.month) - 1];
  const day = parseInt(parts.day);
  const hour = parseInt(parts.hour);
  const ampm = parts.dayPeriod?.toLowerCase() || (nextHour.getUTCHours() >= 12 ? 'pm' : 'am');
  return `bitcoin-up-or-down-${month}-${day}-${hour}${ampm}-et`;
}

function getCurrentHourlySlug() {
  const MONTHS = ['january','february','march','april','may','june','july','august','september','october','november','december'];
  const fmt = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', hour: 'numeric', hour12: true, day: 'numeric', month: 'numeric', year: 'numeric' });
  const now = new Date();
  const parts = {};
  fmt.formatToParts(now).forEach(p => { parts[p.type] = p.value; });
  const month = MONTHS[parseInt(parts.month) - 1];
  const day = parseInt(parts.day);
  const hour = parseInt(parts.hour);
  const ampm = parts.dayPeriod?.toLowerCase() || (now.getUTCHours() >= 12 ? 'pm' : 'am');
  return `bitcoin-up-or-down-${month}-${day}-${hour}${ampm}-et`;
}

async function resolveHourlyEvent(slug) {
  try {
    const r = await fetch(`https://gamma-api.polymarket.com/events?slug=${slug}`);
    const data = await r.json();
    const ev = Array.isArray(data) ? data[0] : data;
    const cid = ev?.markets?.[0]?.conditionId;
    if (cid) return { slug, conditionId: cid };
  } catch (e) {
    console.error(`[1H-SPLIT] Failed to resolve ${slug}:`, e.message);
  }
  return null;
}

async function splitForHourlyEvent(slug) {
  const resolved = await resolveHourlyEvent(slug);
  if (!resolved) { console.log(`[1H-SPLIT] Could not resolve ${slug}`); return; }

  // Temporarily swap activeEvent to do the split
  const prevCid = activeEvent?.conditionId;
  const prevSlug = activeEvent?.slug;
  if (activeEvent) {
    activeEvent.conditionId = resolved.conditionId;
    activeEvent.slug = resolved.slug;
  } else {
    // activeEvent doesn't exist yet
    return;
  }

  try {
    console.log(`[1H-SPLIT] Splitting $${autoSplit.amount} for ${slug}...`);
    const result = await executeSplit(autoSplit.amount);
    console.log(`[1H-SPLIT] Success: $${result.amount} → ${result.upShares} Up + ${result.downShares} Down, tx=${result.txHash}`);
    hourlyActiveEvent = resolved;
  } catch (e) {
    console.error(`[1H-SPLIT] Failed:`, e.message);
  }

  // Restore activeEvent
  if (prevSlug) {
    activeEvent.conditionId = prevCid;
    activeEvent.slug = prevSlug;
  }
}

function scheduleHourlySplit() {
  if (hourlySplitTimer) clearTimeout(hourlySplitTimer);

  const nextBoundary = getNextHourlyBoundary();
  const now = Date.now();
  const PRE_SPLIT_SECS = 5;
  const delay = nextBoundary - now - (PRE_SPLIT_SECS * 1000);

  if (delay > 0) {
    console.log(`[1H-SPLIT] Pre-split for next hourly in ${Math.round(delay / 1000)}s`);
    hourlySplitTimer = setTimeout(async () => {
      const slug = getUpcomingHourlySlug();
      // Retry up to 5 times
      for (let i = 1; i <= 5; i++) {
        try {
          await splitForHourlyEvent(slug);
          break;
        } catch (e) {
          console.error(`[1H-SPLIT] Attempt ${i} failed:`, e.message);
          if (i < 5) await new Promise(r => setTimeout(r, 2000));
        }
      }
      // Schedule the next hourly split
      setTimeout(scheduleHourlySplit, 10000);
    }, delay);
  } else {
    // Already past the boundary, schedule for next hour
    const nextDelay = nextBoundary + 3600000 - now - (PRE_SPLIT_SECS * 1000);
    console.log(`[1H-SPLIT] Missed this boundary, next hourly pre-split in ${Math.round(nextDelay / 1000)}s`);
    hourlySplitTimer = setTimeout(scheduleHourlySplit, Math.max(nextDelay, 5000));
  }

  // Also resolve the current hourly event for low-stock monitoring
  (async () => {
    const currentSlug = getCurrentHourlySlug();
    const resolved = await resolveHourlyEvent(currentSlug);
    if (resolved) {
      hourlyActiveEvent = resolved;
      console.log(`[1H-SPLIT] Tracking current hourly: ${currentSlug}`);
    }
  })();
}

async function saveEventAnalysis(oldSlug) {
  if (!oldSlug || !oldSlug.startsWith('btc-updown-5m-')) return;
  try {
    // Paginate to fetch ALL snapshots
    let allData = [];
    let offset = 0;
    const PAGE = 1000;
    while (true) {
      const { data, error } = await supabase
        .from('polymarket_15m_snapshots')
        .select('observed_at, btc_price, coin_price, up_cost, down_cost')
        .eq('event_slug', oldSlug)
        .order('observed_at', { ascending: true })
        .range(offset, offset + PAGE - 1);
      if (error || !data?.length) break;
      allData = allData.concat(data);
      if (data.length < PAGE) break;
      offset += PAGE;
    }
    if (!allData.length) return;
    const rows = [];
    for (let i = 0; i < allData.length; i++) {
      const s = allData[i];
      const prev = i > 0 ? allData[i - 1] : null;
      rows.push({
        event_name: oldSlug,
        time: s.observed_at,
        poly_btc_chg: prev && s.btc_price && prev.btc_price ? +(s.btc_price - prev.btc_price).toFixed(2) : null,
        binance_chg: prev && s.coin_price && prev.coin_price ? +(s.coin_price - prev.coin_price).toFixed(2) : null,
        delta: s.btc_price && s.coin_price ? +(s.btc_price - s.coin_price).toFixed(2) : null,
        up_chg: prev && s.up_cost != null && prev.up_cost != null ? +((s.up_cost - prev.up_cost) * 100).toFixed(1) : null,
        down_chg: prev && s.down_cost != null && prev.down_cost != null ? +((s.down_cost - prev.down_cost) * 100).toFixed(1) : null,
      });
    }
    // Batch insert (chunk if > 1000 rows for Supabase limits)
    for (let i = 0; i < rows.length; i += 1000) {
      const chunk = rows.slice(i, i + 1000);
      const { error: insertErr } = await supabase.from('price_change_analysis').insert(chunk);
      if (insertErr) console.error('[ANALYSIS] insert error:', insertErr.message);
    }
    console.log(`[ANALYSIS] saved ${rows.length} rows for ${oldSlug}`);
  } catch (e) {
    console.error('[ANALYSIS] error:', e.message);
  }
}

async function refreshEvent() {
  const event = await fetchActiveEvent();
  if (event && event.slug !== liveState.eventSlug) {
    // Save analysis for the old event before switching
    if (liveState.eventSlug) saveEventAnalysis(liveState.eventSlug);
    // Reset in-memory shares for new event — but keep them if pre-split already ran for this slot
    const newEventSlot = parseInt(String(event.slug).match(/(\d{10,})/)?.[1] || 0);
    if (lastSplitSlot !== newEventSlot) {
      inMemoryShares = { up: 0, down: 0 };
    }
    console.log('[EVENT] new active event:', event.slug);
    liveState.eventSlug = event.slug;
    liveState.eventTitle = event.title;
    liveState.tokenUp = event.tokenUp;
    liveState.tokenDown = event.tokenDown;
    liveState.upPrice = null;
    liveState.downPrice = null;
    liveState.upStartPrice = null;
    liveState.downStartPrice = null;
    // Capture current BTC as the start price for this event, then reset so next tick re-captures
    liveState.btcStart = liveState.btcCurrent;
    activeEvent = event;
    broadcast({ type: 'event', event });
    // Fetch initial prices via REST immediately
    await fetchInitialPrices();
    // Then connect WS for live streaming
    if (event.tokenUp && event.tokenDown) {
      connectClobStream([event.tokenUp, event.tokenDown]);
    }
    // Auto-split fallback: split if pre-split didn't already handle this slot
    const slotMatch = event.slug?.match(/(\d{10,})/);
    const eventSlot = slotMatch ? parseInt(slotMatch[1]) : 0;

    let shouldSplit = autoSplit.enabled && k9Copy.enabled && event.conditionId && k9Copy.eventTime !== '1h';
    if (shouldSplit && lastSplitSlot === eventSlot) {
      console.log(`[AUTO-SPLIT] Skipped — already split slot ${eventSlot}`);
      shouldSplit = false;
    }

    if (shouldSplit) {
      console.log('[AUTO-SPLIT] Splitting now (pre-split missed or unverified)...');
      try {
        const result = await executeSplit(autoSplit.amount);
        console.log(`[AUTO-SPLIT] Success: $${result.amount} → ${result.upShares} Up + ${result.downShares} Down, tx=${result.txHash}`);
        // Credit in-memory shares so low-stock monitor won't immediately re-split
        inMemoryShares.up += result.amount;
        inMemoryShares.down += result.amount;
      } catch (e) {
        console.error('[AUTO-SPLIT] Failed:', e.message);
      }
    }

    // Start low-stock monitor for this event
    startLowStockMonitor();
  }
}

// ── Price poll every 500ms via REST ──────────────────────────────────────
let pricePollInterval = null;
let pricePollInFlight = false;
function startPricePoll() {
  if (pricePollInterval) clearInterval(pricePollInterval);
  pricePollInterval = setInterval(async () => {
    if (!liveState.tokenUp || !liveState.tokenDown) return;
    if (pricePollInFlight) return; // skip if previous request still pending
    pricePollInFlight = true;
    try {
      const [upPrice, downPrice] = await Promise.all([
        fetchClobPrice(liveState.tokenUp),
        fetchClobPrice(liveState.tokenDown),
      ]);
      let changed = false;
      if (upPrice != null && upPrice !== liveState.upPrice) { liveState.upPrice = upPrice; changed = true; }
      if (downPrice != null && downPrice !== liveState.downPrice) { liveState.downPrice = downPrice; changed = true; }
      if (liveState.upStartPrice == null && upPrice != null) liveState.upStartPrice = upPrice;
      if (liveState.downStartPrice == null && downPrice != null) liveState.downStartPrice = downPrice;
      if (changed) broadcast({ type: 'prices', ...liveState });
    } finally {
      pricePollInFlight = false;
    }
  }, 500);
}

// ── Low-stock monitor: if either side drops below 10 shares, top up with $50 ─
const LOW_STOCK_THRESHOLD = 10;
const LOW_STOCK_SPLIT = 50;
let lowStockInterval = null;
let inMemoryShares = { up: 0, down: 0 }; // updated on every split so DB failures don't cause loops

function startLowStockMonitor() {
  if (lowStockInterval) clearInterval(lowStockInterval);
  // inMemoryShares is reset at the top of refreshEvent — don't reset here or we wipe auto-split credits
  let splitting = false;
  lowStockInterval = setInterval(async () => {
    if (!autoSplit.enabled || !k9Copy.enabled || !activeEvent?.conditionId || splitting) return;
    // For 1h mode, check hourly event holdings instead of 5m
    if (k9Copy.eventTime === '1h') {
      if (!hourlyActiveEvent?.conditionId) return;
      // Swap activeEvent temporarily to check hourly holdings
      const prevCid = activeEvent.conditionId;
      const prevSlug = activeEvent.slug;
      activeEvent.conditionId = hourlyActiveEvent.conditionId;
      activeEvent.slug = hourlyActiveEvent.slug;
      try {
        const holdings = await fetchHoldings();
        const up = holdings.up.shares + inMemoryShares.up;
        const down = holdings.down.shares + inMemoryShares.down;
        if (up < LOW_STOCK_THRESHOLD || down < LOW_STOCK_THRESHOLD) {
          splitting = true;
          console.log(`[1H-LOW-STOCK] up=${up.toFixed(1)}, down=${down.toFixed(1)} — topping up $${LOW_STOCK_SPLIT} on ${hourlyActiveEvent.slug}`);
          inMemoryShares.up += LOW_STOCK_SPLIT;
          inMemoryShares.down += LOW_STOCK_SPLIT;
          const result = await executeSplit(LOW_STOCK_SPLIT);
          console.log(`[1H-LOW-STOCK] Split done: tx=${result.txHash}`);
          splitting = false;
        }
      } catch (e) {
        splitting = false;
        console.error('[1H-LOW-STOCK] Error:', e.message);
      } finally {
        activeEvent.conditionId = prevCid;
        activeEvent.slug = prevSlug;
      }
      return;
    }
    // In 1h mode, NEVER split on 5m events — the 1h path above handles it
    if (k9Copy.eventTime === '1h') return;
    try {
      const holdings = await fetchHoldings();
      // Combine DB holdings with in-memory splits done this event
      const up = holdings.up.shares + inMemoryShares.up;
      const down = holdings.down.shares + inMemoryShares.down;
      if (up < LOW_STOCK_THRESHOLD || down < LOW_STOCK_THRESHOLD) {
        splitting = true;
        console.log(`[LOW-STOCK] up=${up.toFixed(1)}, down=${down.toFixed(1)} — topping up $${LOW_STOCK_SPLIT}`);
        // Credit memory immediately so next tick sees updated shares
        inMemoryShares.up += LOW_STOCK_SPLIT;
        inMemoryShares.down += LOW_STOCK_SPLIT;
        const result = await executeSplit(LOW_STOCK_SPLIT);
        console.log(`[LOW-STOCK] Split done: tx=${result.txHash}`);
        splitting = false;
      }
    } catch (e) {
      splitting = false;
      console.error('[LOW-STOCK] Error:', e.message);
    }
  }, 5_000); // check every 5s
}

// ── Helper: fetch holdings for current event ────────────────────────────────
async function fetchHoldings() {
  const { data: existingOrders } = await supabase
    .from('polymarket_trades')
    .select('direction, shares, purchase_amount')
    .in('order_type', ['supertrader', 'paper', 'live'])
    .eq('polymarket_event_id', eventDbId())
    .neq('order_status', 'resolved');

  const holdings = { up: { shares: 0, cost: 0 }, down: { shares: 0, cost: 0 } };
  for (const o of (existingOrders || [])) {
    const s = o.direction;
    if (holdings[s]) {
      holdings[s].shares += parseFloat(o.shares || 0);
      holdings[s].cost += parseFloat(o.purchase_amount || 0);
    }
  }
  holdings.up.value = liveState.upPrice ? holdings.up.shares * liveState.upPrice : null;
  holdings.down.value = liveState.downPrice ? holdings.down.shares * liveState.downPrice : null;
  return holdings;
}

// ── Buy order (LIVE — GTC limit order via CLOB) ─────────────────────────────
app.post('/api/buy', async (req, res) => {
  const { side, amount } = req.body;

  if (!activeEvent) return res.status(400).json({ error: 'No active event' });
  if (!['up', 'down'].includes(side)) return res.status(400).json({ error: 'Invalid side' });
  if (!clobClient) return res.status(500).json({ error: 'CLOB client not ready' });

  const price = side === 'up' ? liveState.upPrice : liveState.downPrice;
  const tokenId = side === 'up' ? liveState.tokenUp : liveState.tokenDown;

  if (!price) return res.status(400).json({ error: 'No price available' });
  if (!tokenId) return res.status(400).json({ error: 'No token ID' });

  const tickSize = activeEvent.tickSize || '0.01';
  const tick = parseFloat(tickSize);
  // Buy at current price (rounds to tick)
  const buyPrice = Math.min(Math.round(price / tick) * tick, 0.99);
  // Polymarket BUY orders: size = dollar amount to spend (not shares)
  const sizeUsd = Math.round(amount * 100) / 100;
  if (sizeUsd < 1) return res.status(400).json({ error: 'Amount too small (min $1)' });

  const endDate = activeEvent.endDate ? new Date(activeEvent.endDate) : null;
  const timeLeftSecs = endDate ? Math.max(0, Math.floor((endDate - Date.now()) / 1000)) : null;

  try {
    console.log(`[BUY] Placing GTC limit BUY $${sizeUsd} ${side.toUpperCase()} @ ${buyPrice} (tick=${tickSize})`);

    const signedOrder = await clobClient.createOrder({
      tokenID: tokenId,
      price: buyPrice,
      size: sizeUsd,
      side: 'BUY',
    }, { tickSize, negRisk: activeEvent.negRisk || false });

    const result = await clobClient.postOrder(signedOrder, 'GTC');
    console.log('[BUY] Order posted:', result?.orderID || result);

    // Estimated shares = amount/price (actual fill may vary slightly)
    const estimatedShares = sizeUsd / buyPrice;

    // Record to DB
    const tradeData = {
      polymarket_event_id: eventDbId(),
      direction: side,
      purchase_price: buyPrice,
      purchase_amount: sizeUsd,
      purchase_time: new Date().toISOString(),
      btc_price_at_purchase: liveState.btcCurrent,
      order_type: 'live',
      order_status: result?.orderID ? 'open' : 'failed',
      polymarket_order_id: result?.orderID || `live-${Date.now()}`,
      shares: Math.round(estimatedShares * 100) / 100,
      notes: JSON.stringify({
        tokenId,
        eventTitle: liveState.eventTitle,
        upPriceAtBuy: liveState.upPrice,
        downPriceAtBuy: liveState.downPrice,
        timeLeftSecs,
        orderType: 'GTC',
      }),
    };

    const { data: trade, error: dbErr } = await supabase
      .from('polymarket_trades').insert(tradeData).select().single();
    if (dbErr) console.error('[BUY] DB error:', dbErr);

    const holdings = await fetchHoldings();

    res.json({
      success: true,
      error: null,
      trade: trade || tradeData,
      order: { orderID: result?.orderID },
      price: buyPrice,
      shares: Math.round(estimatedShares * 100) / 100,
      snapshot: {
        upPrice: liveState.upPrice, downPrice: liveState.downPrice,
        btcPrice: liveState.btcCurrent, timeLeftSecs, holdings,
      },
    });
  } catch (e) {
    const errMsg = e?.message ?? e?.errorMsg ?? String(e);
    console.error('[BUY] Error:', errMsg);
    if (!res.headersSent) {
      res.status(500).json({ success: false, error: errMsg });
    }
  }
});

// ── Sell order (LIVE — GTC limit order via CLOB) ─────────────────────────────
app.post('/api/sell', async (req, res) => {
  const { side, shares } = req.body;

  if (!activeEvent) return res.status(400).json({ error: 'No active event' });
  if (!['up', 'down'].includes(side)) return res.status(400).json({ error: 'Invalid side' });
  if (!clobClient) return res.status(500).json({ error: 'CLOB client not ready' });

  const price = side === 'up' ? liveState.upPrice : liveState.downPrice;
  const tokenId = side === 'up' ? liveState.tokenUp : liveState.tokenDown;

  if (!price) return res.status(400).json({ error: 'No price available' });
  if (!tokenId) return res.status(400).json({ error: 'No token ID' });

  const tickSize = activeEvent.tickSize || '0.01';
  const tick = parseFloat(tickSize);
  // Sell at current price (rounds to tick)
  const sellPrice = Math.max(Math.round(price / tick) * tick, 0.01);
  const roundedShares = Math.round(parseFloat(shares) * 100) / 100;
  if (roundedShares < 1) return res.status(400).json({ error: 'Size too small' });

  try {
    console.log(`[SELL] Placing GTC limit SELL ${roundedShares} ${side.toUpperCase()} @ ${sellPrice} (tick=${tickSize})`);

    const signedOrder = await clobClient.createOrder({
      tokenID: tokenId,
      price: sellPrice,
      size: roundedShares,
      side: 'SELL',
    }, { tickSize, negRisk: activeEvent.negRisk || false });

    const result = await clobClient.postOrder(signedOrder, 'GTC');
    console.log('[SELL] Order posted:', result?.orderID || result);

    // Record to DB
    const tradeData = {
      polymarket_event_id: eventDbId(),
      direction: side,
      purchase_price: sellPrice,
      purchase_amount: -(roundedShares * sellPrice),
      purchase_time: new Date().toISOString(),
      btc_price_at_purchase: liveState.btcCurrent,
      order_type: 'live',
      order_status: result?.orderID ? 'open' : 'failed',
      polymarket_order_id: result?.orderID || `live-${Date.now()}`,
      shares: -roundedShares,
      notes: JSON.stringify({
        tokenId,
        eventTitle: liveState.eventTitle,
        side: 'SELL',
        orderType: 'GTC',
      }),
    };

    const { data: trade, error: dbErr } = await supabase
      .from('polymarket_trades').insert(tradeData).select().single();
    if (dbErr) console.error('[SELL] DB error:', dbErr);

    const holdings = await fetchHoldings();

    res.json({
      success: true,
      error: null,
      trade: trade || tradeData,
      order: { orderID: result?.orderID },
      price: sellPrice,
      shares: roundedShares,
      snapshot: {
        upPrice: liveState.upPrice, downPrice: liveState.downPrice,
        btcPrice: liveState.btcCurrent, holdings,
      },
    });
  } catch (e) {
    console.error('[SELL] Error:', e.message);
    res.status(500).json({ success: false, error: e.message });
  }
});

// ── Sell All (limit sell at price - 1¢, all holdings) ────────────────────────
app.post('/api/sell-all', async (req, res) => {
  const { side, tokenId: reqTokenId } = req.body;
  if (!activeEvent) return res.status(400).json({ success: false, error: 'No active event' });
  if (!['up', 'down'].includes(side)) return res.status(400).json({ success: false, error: 'Invalid side' });
  if (!clobClient) return res.status(500).json({ success: false, error: 'CLOB client not ready' });

  const tokenId = reqTokenId || (side === 'up' ? liveState.tokenUp : liveState.tokenDown);
  const price = side === 'up' ? liveState.upPrice : liveState.downPrice;
  if (!tokenId) return res.status(400).json({ success: false, error: 'No token ID' });
  if (!price) return res.status(400).json({ success: false, error: 'No price available' });

  try {
    const bal = await clobClient.getBalanceAllowance({ asset_type: 'CONDITIONAL', token_id: tokenId });
    const availableRaw = parseFloat(bal?.balance ?? bal?.data?.balance ?? '0') / 1e6;
    const available = Math.max(0, Math.round(availableRaw * 10000) / 10000);
    if (available < 0.01) return res.status(400).json({ success: false, error: `Only ${available.toFixed(4)} shares — need at least 0.01` });

    const tickSize = activeEvent.tickSize || '0.01';
    const tick = parseFloat(tickSize);
    const sellPrice = Math.max(Math.round((price - 0.01) / tick) * tick, 0.01);

    console.log(`[SELL-ALL] ${side.toUpperCase()} SELL ${available}@${sellPrice}`);
    const signedOrder = await clobClient.createOrder({
      tokenID: tokenId, price: sellPrice, size: available, side: 'SELL',
    }, { tickSize, negRisk: activeEvent.negRisk || false });
    const result = await clobClient.postOrder(signedOrder, 'GTC');
    console.log('[SELL-ALL] Order posted:', result?.orderID || result);

    const tradeData = {
      polymarket_event_id: eventDbId(), direction: side,
      purchase_price: sellPrice, purchase_amount: -(available * sellPrice),
      purchase_time: new Date().toISOString(), btc_price_at_purchase: liveState.btcCurrent,
      order_type: 'live', order_status: result?.orderID ? 'open' : 'failed',
      polymarket_order_id: result?.orderID || `sell-all-${Date.now()}`,
      shares: -available, notes: JSON.stringify({ type: 'sell-all', tokenId, orderType: 'GTC' }),
    };
    const { error: dbErr } = await supabase.from('polymarket_trades').insert(tradeData);
    if (dbErr) console.error('[SELL-ALL] DB error:', dbErr);

    res.json({ success: true, price: sellPrice, shares: available, order: { orderID: result?.orderID } });
  } catch (e) {
    console.error('[SELL-ALL] Error:', e.message);
    res.status(500).json({ success: false, error: e.message });
  }
});

// ── CTF Split (convert USDC → Up + Down tokens) ──────────────────────────────
app.post('/api/split', async (req, res) => {
  const amount = parseFloat(req.body.amount) || autoSplit.amount;
  if (!activeEvent) return res.status(400).json({ error: 'No active event' });
  if (!activeEvent.conditionId) return res.status(400).json({ error: 'No conditionId for this event' });

  try {
    const result = await executeSplit(amount);
    res.json({ success: true, ...result });
  } catch (e) {
    console.error('[SPLIT] Error:', e.message);
    res.status(500).json({ success: false, error: e.message });
  }
});

app.get('/api/auto-split', (req, res) => {
  res.json(autoSplit);
});

// Next-split status: when will pre-split fire, is everything ready?
app.get('/api/split-status', (req, res) => {
  const now = Date.now();
  const nowSecs = Math.floor(now / 1000);
  const nextSlot = (Math.floor(nowSecs / 300) + 1) * 300;
  const preSplitStartDelay = (nextSlot * 1000) - now - (15 * 1000);
  const refreshDelay = (nextSlot * 1000) - now + 2000;
  const upcomingSlug = `btc-updown-5m-${nextSlot}`;
  const nextSlotTime = new Date(nextSlot * 1000).toISOString();
  const hasFunder = !!FUNDER_ADDRESS;
  const hasKey = !!process.env.PRIVATE_KEY;
  const scriptOk = fs.existsSync(SPLIT_SCRIPT);
  res.json({
    autoSplit: autoSplit.enabled,
    amount: autoSplit.amount,
    manualOverride: manualEventOverride,
    nextSlot,
    upcomingSlug,
    nextSlotTime,
    preSplitInSec: preSplitStartDelay > 0 ? Math.round(preSplitStartDelay / 1000) : 0,
    refreshInSec: Math.round(refreshDelay / 1000),
    ready: hasFunder && hasKey && scriptOk,
    checks: { hasFunder, hasKey, scriptOk },
  });
});

app.post('/api/auto-split', (req, res) => {
  if (req.body.enabled !== undefined) autoSplit.enabled = !!req.body.enabled;
  if (req.body.amount !== undefined) autoSplit.amount = parseFloat(req.body.amount) || 150;
  console.log(`[AUTO-SPLIT] ${autoSplit.enabled ? 'ENABLED' : 'DISABLED'}, amount=$${autoSplit.amount}`);
  res.json(autoSplit);
});

// Check if we split for a given event (from polymarket_trades with type: ctf-split)
app.get('/api/split-check/:slug', async (req, res) => {
  const slug = req.params.slug;
  const match = slug?.match(/(\d{10,})/);
  const eventId = match ? parseInt(match[1]) : null;
  if (!eventId) return res.json({ slug, split: false, error: 'Invalid slug' });
  const { data } = await supabase
    .from('polymarket_trades')
    .select('id, direction, shares, purchase_amount, purchase_time, notes')
    .eq('polymarket_event_id', eventId)
    .limit(10);
  const splits = (data || []).filter(r => {
    try {
      const n = r.notes ? JSON.parse(r.notes) : {};
      return n.type === 'ctf-split';
    } catch { return false; }
  });
  const split = splits.length >= 2; // up + down
  const amount = splits[0] ? (JSON.parse(splits[0].notes || '{}').amount ?? null) : null;
  res.json({ slug, eventId, split, amount, records: splits.length });
});

app.post('/api/merge', async (req, res) => {
  const amount = parseFloat(req.body.amount) || 0;
  if (!amount) return res.status(400).json({ error: 'amount required' });
  if (!activeEvent) return res.status(400).json({ error: 'No active event' });
  if (!activeEvent.conditionId) return res.status(400).json({ error: 'No conditionId for this event' });

  try {
    const result = await executeMerge(amount);
    res.json({ success: true, ...result });
  } catch (e) {
    console.error('[MERGE] Error:', e.message);
    res.status(500).json({ success: false, error: e.message });
  }
});

// ── Buy Both (buy 10 UP + 10 DOWN at current price, GTC limits) ────────────────
app.post('/api/buy-both', async (req, res) => {
  if (!activeEvent) return res.status(400).json({ error: 'No active event' });
  if (!clobClient) return res.status(500).json({ error: 'CLOB client not ready' });
  if (!liveState.upPrice || !liveState.downPrice) return res.status(400).json({ error: 'No prices' });
  if (!liveState.tokenUp || !liveState.tokenDown) return res.status(400).json({ error: 'No tokens' });

  const tickSize = activeEvent.tickSize || '0.01';
  const tick = parseFloat(tickSize);
  const negRisk = activeEvent.negRisk || false;
  const shares = 10;
  const upBuyPrice = Math.max(Math.round(liveState.upPrice / tick) * tick, 0.01);
  const downBuyPrice = Math.max(Math.round(liveState.downPrice / tick) * tick, 0.01);
  const upSizeUsd = Math.round(shares * upBuyPrice * 100) / 100;
  const downSizeUsd = Math.round(shares * downBuyPrice * 100) / 100;
  const totalNeeded = upSizeUsd + downSizeUsd;
  const reserveBuffer = Math.max(1.0, Math.round(totalNeeded * 0.1 * 100) / 100);
  const requiredWithBuffer = totalNeeded + reserveBuffer;

  try {
    // Check USDC balance before placing (need enough for both)
    const usdcBal = await clobClient.getBalanceAllowance({ asset_type: 'COLLATERAL' });
    const usdcAvailable = parseFloat(usdcBal?.balance || '0') / 1e6;
    if (usdcAvailable < requiredWithBuffer) {
      return res.status(400).json({
        success: false,
        error: `Insufficient USDC: need $${requiredWithBuffer.toFixed(2)} incl. buffer (UP $${upSizeUsd.toFixed(2)} + DOWN $${downSizeUsd.toFixed(2)}), have $${usdcAvailable.toFixed(2)}`,
      });
    }

    const now = new Date().toISOString();
    const base = { purchase_time: now, btc_price_at_purchase: liveState.btcCurrent, order_type: 'live' };

    let upResult = null, downResult = null, upError = null, downError = null;

    function errMsg(e) {
      return e?.message ?? e?.error ?? e?.data?.message ?? e?.response?.data?.message ?? String(e);
    }

    async function placeBuyLeg(direction, tokenID, price, sizeUsd) {
      try {
        const order = await clobClient.createOrder({ tokenID, price, size: sizeUsd, side: 'BUY' }, { tickSize, negRisk });
        const result = await clobClient.postOrder(order, 'GTC');
        const orderID = result?.orderID ?? result?.order_id;
        const error = result?.error || (!orderID ? 'No orderID returned' : null);
        if (orderID) {
          const { error: dbErr } = await supabase.from('polymarket_trades').insert({
            ...base,
            polymarket_event_id: eventDbId(),
            direction,
            purchase_price: price,
            purchase_amount: sizeUsd,
            order_status: 'open',
            polymarket_order_id: orderID,
            shares,
            notes: JSON.stringify({ type: 'buy-both', tokenId: tokenID, orderType: 'GTC' }),
          });
          if (dbErr) console.error(`[BUY-BOTH] DB ${direction} insert error:`, dbErr.message || dbErr);
        }
        console.log(`[BUY-BOTH] ${direction.toUpperCase()} buy:`, orderID || error || result);
        return { result: orderID ? { ...result, orderID } : result, error };
      } catch (e) {
        const error = errMsg(e);
        console.error(`[BUY-BOTH] ${direction.toUpperCase()} buy failed:`, error);
        return { result: null, error };
      }
    }

    // Submit both legs concurrently
    const [upLeg, downLeg] = await Promise.all([
      placeBuyLeg('up', liveState.tokenUp, upBuyPrice, upSizeUsd),
      placeBuyLeg('down', liveState.tokenDown, downBuyPrice, downSizeUsd),
    ]);

    upResult = upLeg.result;
    upError = upLeg.error;
    downResult = downLeg.result;
    downError = downLeg.error;

    const upOk = !!upResult?.orderID;
    const downOk = !!downResult?.orderID;

    // Enforce both-or-none for Buy Both
    if (upOk !== downOk) {
      try {
        const orphanId = upOk ? upResult.orderID : downResult.orderID;
        const cancelRes = await clobClient.cancelOrders([orphanId]);
        if (cancelRes?.not_canceled?.length) {
          try { await clobClient.cancelOrder({ orderID: orphanId }); } catch {}
        }
        console.log('[BUY-BOTH] Rolled back orphan leg:', orphanId);
      } catch (cancelErr) {
        console.error('[BUY-BOTH] Rollback cancel failed:', cancelErr?.message ?? cancelErr);
      }
    }

    const finalUpOk = upOk && downOk;
    const finalDownOk = upOk && downOk;
    res.json({
      success: finalUpOk && finalDownOk,
      up: { price: upBuyPrice, shares, orderID: upResult?.orderID, ok: finalUpOk, error: upError || (upOk && !downOk ? 'Cancelled: other leg failed' : null) },
      down: { price: downBuyPrice, shares, orderID: downResult?.orderID, ok: finalDownOk, error: downError || (downOk && !upOk ? 'Cancelled: other leg failed' : null) },
      message: finalUpOk && finalDownOk ? 'Both placed' : 'Both failed (rolled back partial fill)',
    });
  } catch (e) {
    const errMsg = e?.message ?? String(e);
    console.error('[BUY-BOTH] Error:', errMsg);
    res.status(500).json({ success: false, error: errMsg });
  }
});

// ── Buy Then Sell Both: buy 10 each at current price, when filled place sell at p+1¢ ──
app.post('/api/buy-then-sell-both', async (req, res) => {
  if (!activeEvent) return res.status(400).json({ error: 'No active event' });
  if (!clobClient) return res.status(500).json({ error: 'CLOB client not ready' });
  if (!liveState.upPrice || !liveState.downPrice) return res.status(400).json({ error: 'No prices' });
  if (!liveState.tokenUp || !liveState.tokenDown) return res.status(400).json({ error: 'No tokens' });

  const tickSize = activeEvent.tickSize || '0.01';
  const tick = parseFloat(tickSize);
  const negRisk = activeEvent.negRisk || false;
  const shares = 10;
  const upBuyPrice = Math.max(Math.round(liveState.upPrice / tick) * tick, 0.01);
  const downBuyPrice = Math.max(Math.round(liveState.downPrice / tick) * tick, 0.01);
  const upSizeUsd = Math.round(shares * upBuyPrice * 100) / 100;
  const downSizeUsd = Math.round(shares * downBuyPrice * 100) / 100;
  const totalNeeded = upSizeUsd + downSizeUsd;
  const reserveBuffer = Math.max(1.0, Math.round(totalNeeded * 0.1 * 100) / 100);
  const requiredWithBuffer = totalNeeded + reserveBuffer;

  try {
    const usdcBal = await clobClient.getBalanceAllowance({ asset_type: 'COLLATERAL' });
    const usdcAvailable = parseFloat(usdcBal?.balance || '0') / 1e6;
    if (usdcAvailable < requiredWithBuffer) {
      return res.status(400).json({
        success: false,
        error: `Insufficient USDC: need $${totalNeeded.toFixed(2)}, have $${usdcAvailable.toFixed(2)}`,
      });
    }

    console.log(`[BUY-THEN-SELL] Placing buys: UP $${upSizeUsd}@${upBuyPrice} + DOWN $${downSizeUsd}@${downBuyPrice}`);
    let upOrderId = null, downOrderId = null, upError = null, downError = null;

    function errMsg(e) {
      return e?.message ?? e?.error ?? e?.data?.message ?? e?.response?.data?.message ?? String(e);
    }
    try {
      const upOrder = await clobClient.createOrder({ tokenID: liveState.tokenUp, price: upBuyPrice, size: upSizeUsd, side: 'BUY' }, { tickSize, negRisk });
      const upResult = await clobClient.postOrder(upOrder, 'GTC');
      upOrderId = upResult?.orderID ?? upResult?.order_id;
      if (upResult?.error) upError = upResult.error;
      else if (!upOrderId) upError = 'No orderID returned';
      if (upOrderId) {
        const now = new Date().toISOString();
        const base = { purchase_time: now, btc_price_at_purchase: liveState.btcCurrent, order_type: 'live' };
        const { error: upDbErr } = await supabase.from('polymarket_trades').insert({ ...base, polymarket_event_id: eventDbId(), direction: 'up', purchase_price: upBuyPrice, purchase_amount: upSizeUsd, order_status: 'open', polymarket_order_id: upOrderId, shares, notes: JSON.stringify({ type: 'buy-then-sell', tokenId: liveState.tokenUp, orderType: 'GTC' }) });
        if (upDbErr) console.error('[BUY-THEN-SELL] DB up insert error:', upDbErr.message || upDbErr);
      }
      console.log('[BUY-THEN-SELL] Up buy:', upOrderId ? 'OK' : upError);
    } catch (e) {
      upError = errMsg(e);
      console.error('[BUY-THEN-SELL] Up buy failed:', upError);
    }
    await new Promise(r => setTimeout(r, 150));

    try {
      const downOrder = await clobClient.createOrder({ tokenID: liveState.tokenDown, price: downBuyPrice, size: downSizeUsd, side: 'BUY' }, { tickSize, negRisk });
      const downResult = await clobClient.postOrder(downOrder, 'GTC');
      downOrderId = downResult?.orderID ?? downResult?.order_id;
      if (downResult?.error) downError = downResult.error;
      else if (!downOrderId) downError = 'No orderID returned';
      if (downOrderId) {
        const now = new Date().toISOString();
        const base = { purchase_time: now, btc_price_at_purchase: liveState.btcCurrent, order_type: 'live' };
        const { error: downDbErr } = await supabase.from('polymarket_trades').insert({ ...base, polymarket_event_id: eventDbId(), direction: 'down', purchase_price: downBuyPrice, purchase_amount: downSizeUsd, order_status: 'open', polymarket_order_id: downOrderId, shares, notes: JSON.stringify({ type: 'buy-then-sell', tokenId: liveState.tokenDown, orderType: 'GTC' }) });
        if (downDbErr) console.error('[BUY-THEN-SELL] DB down insert error:', downDbErr.message || downDbErr);
      }
    } catch (e) {
      downError = e?.message ?? String(e);
      console.error('[BUY-THEN-SELL] Down buy failed:', downError);
    }

    const bothOk = !!upOrderId && !!downOrderId;
    res.json({
      success: bothOk,
      upOrderId, downOrderId,
      up: { ok: !!upOrderId, error: upError },
      down: { ok: !!downOrderId, error: downError },
      message: bothOk ? 'Buys placed. Sells when filled.' : (upOrderId ? 'Only UP placed; DOWN failed.' : downOrderId ? 'Only DOWN placed; UP failed.' : 'Both failed.'),
    });

    const wantUpSell = !!upOrderId || !upError;
    const wantDownSell = !!downOrderId || !downError;

    // Background: poll balances; place limit sells when fills appear
    const snapTokenUp = liveState.tokenUp;
    const snapTokenDown = liveState.tokenDown;
    const snapTick = tick;
    const snapTickSize = tickSize;
    const snapNegRisk = negRisk;
    const snapEventSlug = liveState.eventSlug || activeEvent?.slug || '';
    const upSellPrice = Math.min(Math.round((upBuyPrice + 0.02) / snapTick) * snapTick, 0.99);
    const downSellPrice = Math.min(Math.round((downBuyPrice + 0.02) / snapTick) * snapTick, 0.99);

    (async () => {
      const maxWaitMs = 4 * 60 * 1000;
      const pollMs = 1000;
      const start = Date.now();
      let upSellPlaced = false;
      let downSellPlaced = false;
      const snapDbId = (() => { const m = snapEventSlug.match(/(\d{10,})/); return m ? parseInt(m[1], 10) : null; })();

      while (Date.now() - start < maxWaitMs) {
        await new Promise(r => setTimeout(r, pollMs));
        try {
          const [upBal, downBal] = await Promise.all([
            clobClient.getBalanceAllowance({ asset_type: 'CONDITIONAL', token_id: snapTokenUp }),
            clobClient.getBalanceAllowance({ asset_type: 'CONDITIONAL', token_id: snapTokenDown }),
          ]);
          const parseBal = (b) => Math.max(0, Math.round((parseFloat(b?.balance ?? b?.data?.balance ?? '0') / 1e6) * 10000) / 10000);
          const upAvailable = parseBal(upBal);
          const downAvailable = parseBal(downBal);

          if (!upSellPlaced && upAvailable >= 0.01) {
            try {
              const upSellOrder = await clobClient.createOrder({ tokenID: snapTokenUp, price: upSellPrice, size: upAvailable, side: 'SELL' }, { tickSize: snapTickSize, negRisk: snapNegRisk });
              const upSellResult = await clobClient.postOrder(upSellOrder, 'GTC');
              const upOid = upSellResult?.orderID ?? upSellResult?.order_id;
              if (upOid) {
                await supabase.from('polymarket_trades').insert({
                  purchase_time: new Date().toISOString(),
                  btc_price_at_purchase: liveState.btcCurrent,
                  order_type: 'live',
                  polymarket_event_id: snapDbId,
                  direction: 'up',
                  purchase_price: upSellPrice,
                  purchase_amount: -(upAvailable * upSellPrice),
                  order_status: 'open',
                  polymarket_order_id: upOid,
                  shares: -upAvailable,
                  notes: JSON.stringify({ type: 'buy-then-sell-sell', tokenId: snapTokenUp }),
                });
                upSellPlaced = true;
                console.log('[BUY-THEN-SELL] UP sell placed:', upOid, 'qty=', upAvailable);
                broadcast({ type: 'refresh' });
              } else {
                console.error('[BUY-THEN-SELL] UP sell failed:', upSellResult?.error || 'No orderID');
              }
            } catch (e) {
              console.error('[BUY-THEN-SELL] UP sell error:', e?.message ?? e);
            }
          }

          if (!downSellPlaced && downAvailable >= 0.01) {
            try {
              const downSellOrder = await clobClient.createOrder({ tokenID: snapTokenDown, price: downSellPrice, size: downAvailable, side: 'SELL' }, { tickSize: snapTickSize, negRisk: snapNegRisk });
              const downSellResult = await clobClient.postOrder(downSellOrder, 'GTC');
              const downOid = downSellResult?.orderID ?? downSellResult?.order_id;
              if (downOid) {
                await supabase.from('polymarket_trades').insert({
                  purchase_time: new Date().toISOString(),
                  btc_price_at_purchase: liveState.btcCurrent,
                  order_type: 'live',
                  polymarket_event_id: snapDbId,
                  direction: 'down',
                  purchase_price: downSellPrice,
                  purchase_amount: -(downAvailable * downSellPrice),
                  order_status: 'open',
                  polymarket_order_id: downOid,
                  shares: -downAvailable,
                  notes: JSON.stringify({ type: 'buy-then-sell-sell', tokenId: snapTokenDown }),
                });
                downSellPlaced = true;
                console.log('[BUY-THEN-SELL] DOWN sell placed:', downOid, 'qty=', downAvailable);
                broadcast({ type: 'refresh' });
              } else {
                console.error('[BUY-THEN-SELL] DOWN sell failed:', downSellResult?.error || 'No orderID');
              }
            } catch (e) {
              console.error('[BUY-THEN-SELL] DOWN sell error:', e?.message ?? e);
            }
          }

          const upDone = !wantUpSell || upSellPlaced;
          const downDone = !wantDownSell || downSellPlaced;
          if (upDone && downDone) {
            console.log('[BUY-THEN-SELL] Sell workflow complete.');
            break;
          }
        } catch (e) {
          console.error('[BUY-THEN-SELL] Poll error:', e?.message ?? e);
        }
      }

      if (Date.now() - start >= maxWaitMs) {
        console.log('[BUY-THEN-SELL] Timeout waiting for fill balances to place sells');
      }
    })();
  } catch (e) {
    console.error('[BUY-THEN-SELL] Error:', e.message);
    res.status(500).json({ success: false, error: e.message });
  }
});

// ── Sell Both (sell 10 UP + 10 DOWN at price + 1¢, GTC limits) ──────────────
app.post('/api/sell-both', async (req, res) => {
  if (!activeEvent) return res.status(400).json({ error: 'No active event' });
  if (!clobClient) return res.status(500).json({ error: 'CLOB client not ready' });
  if (!liveState.upPrice || !liveState.downPrice) return res.status(400).json({ error: 'No prices' });
  if (!liveState.tokenUp || !liveState.tokenDown) return res.status(400).json({ error: 'No tokens' });

  const tickSize = activeEvent.tickSize || '0.01';
  const tick = parseFloat(tickSize);
  const negRisk = activeEvent.negRisk || false;
  const shares = 10;
  const upSellPrice = Math.min(Math.round((liveState.upPrice + 0.01) / tick) * tick, 0.99);
  const downSellPrice = Math.min(Math.round((liveState.downPrice + 0.01) / tick) * tick, 0.99);

  res.json({ success: true, up: { price: upSellPrice, shares }, down: { price: downSellPrice, shares } });

  (async () => {
    try {
      console.log(`[SELL-BOTH] UP SELL ${shares}@${upSellPrice} + DOWN SELL ${shares}@${downSellPrice}`);
      const now = new Date().toISOString();
      const base = { purchase_time: now, btc_price_at_purchase: liveState.btcCurrent, order_type: 'live' };

      const upOrder = await clobClient.createOrder({ tokenID: liveState.tokenUp, price: upSellPrice, size: shares, side: 'SELL' }, { tickSize, negRisk });
      const upResult = await clobClient.postOrder(upOrder, 'GTC');
      console.log('[SELL-BOTH] Up sell:', upResult?.orderID || upResult);
      supabase.from('polymarket_trades').insert({ ...base, polymarket_event_id: eventDbId(), direction: 'up', purchase_price: upSellPrice, purchase_amount: -(shares * upSellPrice), order_status: upResult?.orderID ? 'open' : 'failed', polymarket_order_id: upResult?.orderID || `sell-both-up-${Date.now()}`, shares: -shares, notes: JSON.stringify({ type: 'sell-both', tokenId: liveState.tokenUp, orderType: 'GTC' }) }).then(r => { if (r.error) console.error('[SELL-BOTH] DB error:', r.error.message); });

      const downOrder = await clobClient.createOrder({ tokenID: liveState.tokenDown, price: downSellPrice, size: shares, side: 'SELL' }, { tickSize, negRisk });
      const downResult = await clobClient.postOrder(downOrder, 'GTC');
      console.log('[SELL-BOTH] Down sell:', downResult?.orderID || downResult);
      supabase.from('polymarket_trades').insert({ ...base, polymarket_event_id: eventDbId(), direction: 'down', purchase_price: downSellPrice, purchase_amount: -(shares * downSellPrice), order_status: downResult?.orderID ? 'open' : 'failed', polymarket_order_id: downResult?.orderID || `sell-both-down-${Date.now()}`, shares: -shares, notes: JSON.stringify({ type: 'sell-both', tokenId: liveState.tokenDown, orderType: 'GTC' }) }).then(r => { if (r.error) console.error('[SELL-BOTH] DB error:', r.error.message); });
    } catch (e) {
      console.error('[SELL-BOTH] Error:', e.message);
    }
  })();
});

// ── Rewards Buy (limit buy at price + 1¢, 50 shares, GTC — rests on book) ───
app.post('/api/rewards-buy', async (req, res) => {
  const { side } = req.body;
  if (!activeEvent) return res.status(400).json({ error: 'No active event' });
  if (!['up', 'down'].includes(side)) return res.status(400).json({ error: 'Invalid side' });
  if (!clobClient) return res.status(500).json({ error: 'CLOB client not ready' });

  const price = side === 'up' ? liveState.upPrice : liveState.downPrice;
  const tokenId = side === 'up' ? liveState.tokenUp : liveState.tokenDown;
  if (!price) return res.status(400).json({ error: 'No price available' });
  if (!tokenId) return res.status(400).json({ error: 'No token ID' });

  const tickSize = activeEvent.tickSize || '0.01';
  const tick = parseFloat(tickSize);
  const buyPrice = Math.min(Math.round((price + 0.01) / tick) * tick, 0.99);
  const shares = 50;

  try {
    console.log(`[REWARDS-BUY] ${side.toUpperCase()} ${shares} @ ${buyPrice} (price ${price} + 1¢)`);
    const signedOrder = await clobClient.createOrder({
      tokenID: tokenId, price: buyPrice, size: shares, side: 'BUY',
    }, { tickSize, negRisk: activeEvent.negRisk || false });
    const result = await clobClient.postOrder(signedOrder, 'GTC');
    console.log('[REWARDS-BUY] Order posted:', result?.orderID || result);

    const tradeData = {
      polymarket_event_id: eventDbId(), direction: side,
      purchase_price: buyPrice, purchase_amount: shares * buyPrice,
      purchase_time: new Date().toISOString(), btc_price_at_purchase: liveState.btcCurrent,
      order_type: 'live', order_status: result?.orderID ? 'open' : 'failed',
      polymarket_order_id: result?.orderID || `rewards-buy-${Date.now()}`,
      shares, notes: JSON.stringify({ type: 'rewards-buy', tokenId, orderType: 'GTC' }),
    };
    const { data: trade, error: dbErr } = await supabase
      .from('polymarket_trades').insert(tradeData).select().single();
    if (dbErr) console.error('[REWARDS-BUY] DB error:', dbErr);

    res.json({ success: true, trade: trade || tradeData, order: { orderID: result?.orderID }, price: buyPrice, shares });
  } catch (e) {
    console.error('[REWARDS-BUY] Error:', e.message);
    res.status(500).json({ success: false, error: e.message });
  }
});

// ── Rewards Sell (limit sell at price - 1¢, 50 shares, GTC — rests on book) ─
app.post('/api/rewards-sell', async (req, res) => {
  const { side } = req.body;
  if (!activeEvent) return res.status(400).json({ error: 'No active event' });
  if (!['up', 'down'].includes(side)) return res.status(400).json({ error: 'Invalid side' });
  if (!clobClient) return res.status(500).json({ error: 'CLOB client not ready' });

  const price = side === 'up' ? liveState.upPrice : liveState.downPrice;
  const tokenId = side === 'up' ? liveState.tokenUp : liveState.tokenDown;
  if (!price) return res.status(400).json({ error: 'No price available' });
  if (!tokenId) return res.status(400).json({ error: 'No token ID' });

  const tickSize = activeEvent.tickSize || '0.01';
  const tick = parseFloat(tickSize);
  const sellPrice = Math.max(Math.round((price - 0.01) / tick) * tick, 0.01);

  // Check token balance before selling
  try {
    const bal = await clobClient.getBalanceAllowance({ asset_type: 'CONDITIONAL', token_id: tokenId });
    const available = parseFloat(bal?.balance || '0') / 1e6;
    if (available < 1) return res.status(400).json({ error: `No ${side.toUpperCase()} tokens to sell (balance: ${available.toFixed(2)})` });
    var shares = Math.min(50, Math.floor(available));
    console.log(`[REWARDS-SELL] Balance: ${available.toFixed(2)}, selling ${shares}`);
  } catch (e) {
    var shares = 50;
    console.log('[REWARDS-SELL] Balance check failed, trying 50:', e.message);
  }

  try {
    console.log(`[REWARDS-SELL] ${side.toUpperCase()} ${shares} @ ${sellPrice} (price ${price} - 1¢)`);
    const signedOrder = await clobClient.createOrder({
      tokenID: tokenId, price: sellPrice, size: shares, side: 'SELL',
    }, { tickSize, negRisk: activeEvent.negRisk || false });
    const result = await clobClient.postOrder(signedOrder, 'GTC');
    console.log('[REWARDS-SELL] Order posted:', result?.orderID || result);

    const tradeData = {
      polymarket_event_id: eventDbId(), direction: side,
      purchase_price: sellPrice, purchase_amount: -(shares * sellPrice),
      purchase_time: new Date().toISOString(), btc_price_at_purchase: liveState.btcCurrent,
      order_type: 'live', order_status: result?.orderID ? 'open' : 'failed',
      polymarket_order_id: result?.orderID || `rewards-sell-${Date.now()}`,
      shares: -shares, notes: JSON.stringify({ type: 'rewards-sell', tokenId, orderType: 'GTC' }),
    };
    const { data: trade, error: dbErr } = await supabase
      .from('polymarket_trades').insert(tradeData).select().single();
    if (dbErr) console.error('[REWARDS-SELL] DB error:', dbErr);

    res.json({ success: true, trade: trade || tradeData, order: { orderID: result?.orderID }, price: sellPrice, shares });
  } catch (e) {
    console.error('[REWARDS-SELL] Error:', e.message);
    res.status(500).json({ success: false, error: e.message });
  }
});

// ── Super Rewards (buy at price+1¢ + sell at price-1¢, both 50 shares GTC) ──
app.post('/api/super-rewards', async (req, res) => {
  const { side } = req.body;
  if (!activeEvent) return res.status(400).json({ error: 'No active event' });
  if (!['up', 'down'].includes(side)) return res.status(400).json({ error: 'Invalid side' });
  if (!clobClient) return res.status(500).json({ error: 'CLOB client not ready' });

  const price = side === 'up' ? liveState.upPrice : liveState.downPrice;
  const tokenId = side === 'up' ? liveState.tokenUp : liveState.tokenDown;
  if (!price) return res.status(400).json({ error: 'No price available' });
  if (!tokenId) return res.status(400).json({ error: 'No token ID' });

  const tickSize = activeEvent.tickSize || '0.01';
  const tick = parseFloat(tickSize);
  const buyPrice = Math.max(Math.round(price / tick) * tick, 0.01);
  const shares = 50;

  try {
    console.log(`[SUPER-REWARDS] ${side.toUpperCase()} BUY ${shares}@${buyPrice} (limit 0¢)`);
    const negRisk = activeEvent.negRisk || false;
    const buyOrder = await clobClient.createOrder({ tokenID: tokenId, price: buyPrice, size: shares, side: 'BUY' }, { tickSize, negRisk });
    const buyResult = await clobClient.postOrder(buyOrder, 'GTC');
    console.log('[SUPER-REWARDS] Buy:', buyResult?.orderID || buyResult);

    const now = new Date().toISOString();
    const { error: dbErr } = await supabase.from('polymarket_trades').insert({
      polymarket_event_id: eventDbId(), direction: side,
      purchase_price: buyPrice, purchase_amount: shares * buyPrice,
      purchase_time: now, btc_price_at_purchase: liveState.btcCurrent,
      order_type: 'live', order_status: buyResult?.orderID ? 'open' : 'failed',
      polymarket_order_id: buyResult?.orderID || `super-buy-${Date.now()}`,
      shares, notes: JSON.stringify({ type: 'super-rewards-buy', tokenId, orderType: 'GTC' }),
    });
    if (dbErr) console.error('[SUPER-REWARDS] DB error:', dbErr);

    res.json({ success: true, price: buyPrice, shares, order: { orderID: buyResult?.orderID } });
  } catch (e) {
    console.error('[SUPER-REWARDS] Error:', e.message);
    res.status(500).json({ success: false, error: e.message });
  }
});

// ── Super Sell (limit sell 50 at price + 1¢, GTC) ───────────────────────────
app.post('/api/super-sell', async (req, res) => {
  const { side } = req.body;
  if (!activeEvent) return res.status(400).json({ error: 'No active event' });
  if (!['up', 'down'].includes(side)) return res.status(400).json({ error: 'Invalid side' });
  if (!clobClient) return res.status(500).json({ error: 'CLOB client not ready' });

  const price = side === 'up' ? liveState.upPrice : liveState.downPrice;
  const tokenId = side === 'up' ? liveState.tokenUp : liveState.tokenDown;
  if (!price) return res.status(400).json({ error: 'No price available' });
  if (!tokenId) return res.status(400).json({ error: 'No token ID' });

  const tickSize = activeEvent.tickSize || '0.01';
  const tick = parseFloat(tickSize);
  const sellPrice = Math.min(Math.round((price + 0.01) / tick) * tick, 0.99);
  const shares = 50;

  try {
    console.log(`[SUPER-SELL] ${side.toUpperCase()} SELL ${shares}@${sellPrice} (limit +1¢)`);
    const negRisk = activeEvent.negRisk || false;
    const sellOrder = await clobClient.createOrder({ tokenID: tokenId, price: sellPrice, size: shares, side: 'SELL' }, { tickSize, negRisk });
    const sellResult = await clobClient.postOrder(sellOrder, 'GTC');
    console.log('[SUPER-SELL] Sell:', sellResult?.orderID || sellResult);

    const now = new Date().toISOString();
    const { error: dbErr } = await supabase.from('polymarket_trades').insert({
      polymarket_event_id: eventDbId(), direction: side,
      purchase_price: sellPrice, purchase_amount: -(shares * sellPrice),
      purchase_time: now, btc_price_at_purchase: liveState.btcCurrent,
      order_type: 'live', order_status: sellResult?.orderID ? 'open' : 'failed',
      polymarket_order_id: sellResult?.orderID || `super-sell-${Date.now()}`,
      shares: -shares, notes: JSON.stringify({ type: 'super-sell', tokenId, orderType: 'GTC' }),
    });
    if (dbErr) console.error('[SUPER-SELL] DB error:', dbErr);

    res.json({ success: true, price: sellPrice, shares, order: { orderID: sellResult?.orderID } });
  } catch (e) {
    console.error('[SUPER-SELL] Error:', e.message);
    res.status(500).json({ success: false, error: e.message });
  }
});

// ── Cancel order ─────────────────────────────────────────────────────────────
app.post('/api/cancel', async (req, res) => {
  const { orderID } = req.body;
  if (!clobClient) return res.status(500).json({ error: 'CLOB client not ready' });
  if (!orderID) return res.status(400).json({ error: 'No orderID' });

  try {
    const result = await clobClient.cancelOrder({ orderID });
    console.log('[CANCEL] Cancelled:', orderID);
    await supabase.from('polymarket_trades')
      .update({ order_status: 'cancelled' })
      .eq('polymarket_order_id', orderID);
    res.json({ success: true, result });
  } catch (e) {
    console.error('[CANCEL] Error:', e.message);
    res.status(500).json({ success: false, error: e.message });
  }
});

// ── K9 Copy-Trading endpoints ────────────────────────────────────────────────
app.post('/api/k9-copy/start', async (req, res) => {
  const { slug, pct, eventTime, batchMode, orderType } = req.body || {};
  k9Copy.pct = pct || 0.02;
  k9Copy.targetSlug = slug || null;
  k9Copy.eventTime = '1h'; // LOCKED — only hourly events
  k9Copy.batchMode = (batchMode === 'cum50' ? 'cum50' : 'min5');
  k9Copy.orderType = (orderType === 'GTC' ? 'GTC' : 'FAK');
  resetCopyBuffer();
  k9Copy.stats = { buys: 0, sells: 0, usdcSpent: 0, usdcReceived: 0, skipped: 0 };
  k9Copy.log = [];

  // Resolve token IDs if targeting a specific event
  if (slug) {
    const ok = await resolveCopyTokens(slug);
    if (!ok) return res.status(400).json({ error: `Could not resolve tokens for ${slug}` });
  }

  k9Copy.enabled = true;
  saveK9CopyState();
  console.log(`[k9-copy] ENABLED — target: ${slug || 'ALL'}, eventTime: ${k9Copy.eventTime || 'all'}, pct: ${k9Copy.pct * 100}%, order: ${k9Copy.orderType}`);
  res.json({ success: true, k9Copy: { enabled: true, targetSlug: k9Copy.targetSlug, eventTime: k9Copy.eventTime, pct: k9Copy.pct, batchMode: k9Copy.batchMode, orderType: k9Copy.orderType } });
});

app.post('/api/k9-copy/stop', (req, res) => {
  k9Copy.enabled = false;
  saveK9CopyState();
  console.log(`[k9-copy] DISABLED — stats: ${JSON.stringify(k9Copy.stats)}`);
  res.json({ success: true, stats: k9Copy.stats, log: k9Copy.log });
});

// Reset stuck pending state (if an order hung and blocked the queue)
app.post('/api/k9-copy/reset-stuck', (req, res) => {
  const wasPending = k9Copy.pending;
  k9Copy.pending = false;
  console.log(`[k9-copy] Reset stuck — was pending: ${wasPending}, queue: ${k9Copy.queue.length}`);
  if (k9Copy.queue.length) setTimeout(processCopyQueue, 100);
  res.json({ success: true, wasPending, queueLength: k9Copy.queue.length });
});

app.get('/api/k9-copy/status', async (req, res) => {
  // Merge session stats with today's DB totals so restarts don't zero out the counter
  let dbStats = { buys: 0, sells: 0 };
  try {
    const todayUtc = new Date().toISOString().slice(0, 10); // "YYYY-MM-DD"
    const { data } = await supabase
      .from('polymarket_trades')
      .select('direction, order_type')
      .gte('purchase_time', `${todayUtc}T00:00:00Z`)
      .in('order_type', ['copy-buy', 'copy-sell', 'live']);
    if (data) {
      dbStats.buys  = data.filter(r => r.order_type !== 'copy-sell').length;
      dbStats.sells = data.filter(r => r.order_type === 'copy-sell').length;
    }
  } catch {}

  res.json({
    enabled: k9Copy.enabled,
    targetSlug: k9Copy.targetSlug,
    eventTime: k9Copy.eventTime,
    pct: k9Copy.pct,
    batchMode: k9Copy.batchMode,
    orderType: k9Copy.orderType,
    buffer: k9Copy.buffer,
    stats: {
      buys:         dbStats.buys  + (k9Copy.stats.buys  || 0),
      sells:        dbStats.sells + (k9Copy.stats.sells || 0),
      errors:       k9Copy.stats.errors   || 0,
      skipped:      k9Copy.stats.skipped  || 0,
      usdcSpent:    k9Copy.stats.usdcSpent    || 0,
      usdcReceived: k9Copy.stats.usdcReceived || 0,
    },
    queueLength: k9Copy.queue.length,
    pending: k9Copy.pending,
    log: k9Copy.log,
  });
});

// ── Cancel all open orders ───────────────────────────────────────────────────
app.post('/api/cancel-all', async (req, res) => {
  if (!clobClient) return res.status(500).json({ error: 'CLOB client not ready' });
  try {
    const result = await clobClient.cancelAll();
    console.log('[CANCEL-ALL] Cancelled all open orders');
    res.json({ success: true, result });
  } catch (e) {
    console.error('[CANCEL-ALL] Error:', e.message);
    res.status(500).json({ success: false, error: e.message });
  }
});

// ── Open orders ──────────────────────────────────────────────────────────────
app.get('/api/open-orders', async (req, res) => {
  if (!clobClient) return res.status(500).json({ error: 'CLOB client not ready' });
  try {
    const raw = await clobClient.getOpenOrders();
    const orders = Array.isArray(raw) ? raw : (raw?.data ?? raw?.orders ?? []);
    res.json({ orders });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── Liquidity rewards (Polymarket maker rewards, per https://docs.polymarket.com/market-makers/liquidity-rewards) ─
app.get('/api/liquidity-rewards', async (req, res) => {
  if (!clobClient) return res.json({ total: 0, byDate: [], error: 'CLOB not ready' });
  const days = Math.min(parseInt(req.query.days || '30', 10) || 30, 90);
  const results = [];
  let total = 0;
  try {
    for (let i = 0; i < days; i++) {
      const d = new Date();
      d.setUTCDate(d.getUTCDate() - i);
      const dateStr = d.toISOString().slice(0, 10);
      const data = await clobClient.getTotalEarningsForUserForDay(dateStr);
      const arr = Array.isArray(data) ? data : (data?.data ? (Array.isArray(data.data) ? data.data : [data.data]) : []);
      const dayTotal = arr.length > 0
        ? arr.reduce((s, x) => s + (parseFloat(x?.earnings) || 0), 0)
        : (parseFloat(data?.earnings) || 0);
      if (dayTotal > 0) results.push({ date: dateStr, earnings: dayTotal });
      total += dayTotal;
    }
    res.json({ total, byDate: results });
  } catch (e) {
    console.error('[LIQUIDITY-REWARDS]', e.message);
    res.json({ total: 0, byDate: [], error: e.message });
  }
});

// ── Recent orders ──────────────────────────────────────────────────────────
app.get('/api/orders', async (req, res) => {
  const { data, error } = await supabase
    .from('polymarket_trades')
    .select('*')
    .in('order_type', ['supertrader', 'paper', 'live'])
    .order('created_at', { ascending: false })
    .limit(50);
  res.json({ orders: data || [], error });
});

// ── Wallet balance ─────────────────────────────────────────────────────────
app.get('/api/wallet', async (req, res) => {
  try {
    const r = await fetch(`https://data-api.polymarket.com/portfolio?user=${process.env.FUNDER_ADDRESS}`);
    const data = await r.json();
    res.json(data);
  } catch (e) {
    res.json({ error: e.message });
  }
});

// ── Positions from Polymarket (source of truth) ─────────────────────────────
app.get('/api/positions', async (req, res) => {
  try {
    const user = (process.env.PROXY_WALLET || process.env.FUNDER_ADDRESS)?.toLowerCase();
    if (!user) return res.json({ positions: [], error: 'PROXY_WALLET or FUNDER_ADDRESS not set' });
    const eventSlug = req.query.event;
    const conditionId = activeEvent?.conditionId && activeEvent?.slug === eventSlug
      ? activeEvent.conditionId
      : null;
    let url = `https://data-api.polymarket.com/positions?user=${user}&limit=100`;
    if (conditionId) url += `&market=${encodeURIComponent(conditionId)}`;
    const r = await fetch(url);
    const data = await r.json();
    let positions = Array.isArray(data) ? data : data.positions || [];
    if (eventSlug && !conditionId) {
      positions = positions.filter(p => (p.eventSlug || p.slug) === eventSlug);
    }
    res.json({ positions });
  } catch (e) {
    res.json({ positions: [], error: e.message });
  }
});

// ── Active event ───────────────────────────────────────────────────────────
app.get('/api/event', (req, res) => res.json({ event: activeEvent, liveState }));

// ── Shared slug cache (avoids slow 169K row scans on every request) ────────
let _slugCache = { k9Slugs: {}, snapSlugs: [], analysisSlugs: [], updatedAt: 0 };
const SLUG_CACHE_TTL = 60_000; // refresh every 60s

async function getSlugCache() {
  if (Date.now() - _slugCache.updatedAt < SLUG_CACHE_TTL) return _slugCache;
  try {
    // Use parallel sampling to get all distinct slugs from k9_observed_trades
    const { count } = await supabase.from('k9_observed_trades').select('*', { count: 'exact', head: true });
    const total = count || 0;
    const k9Slugs = {};
    if (total > 0) {
      const chunkSize = 1000;
      const numChunks = Math.min(Math.ceil(total / chunkSize), 200);
      const step = Math.max(1, Math.floor(total / numChunks));
      const fetches = [];
      for (let i = 0; i < numChunks; i++) {
        const offset = i * step;
        fetches.push(supabase.from('k9_observed_trades').select('slug').range(offset, offset + chunkSize - 1));
      }
      const results = await Promise.all(fetches);
      for (const { data } of results) {
        if (data) for (const r of data) k9Slugs[r.slug] = (k9Slugs[r.slug] || 0) + 1;
      }
    }
    const [{ data: snapRows }, { data: analysisRows }] = await Promise.all([
      supabase.from('polymarket_15m_snapshots').select('event_slug, observed_at').order('observed_at', { ascending: false }).limit(5000),
      supabase.from('price_change_analysis').select('event_name, time').order('time', { ascending: false }).limit(10000),
    ]);
    _slugCache = {
      k9Slugs,
      snapSlugs: [...new Set((snapRows || []).map(r => r.event_slug).filter(Boolean))],
      analysisSlugs: (analysisRows || []).map(r => r.event_name).filter(Boolean),
      updatedAt: Date.now(),
    };
    console.log(`[slug-cache] Refreshed: ${Object.keys(k9Slugs).length} k9 slugs, ${_slugCache.snapSlugs.length} snap slugs`);
  } catch (e) {
    console.error('[slug-cache] Error:', e.message);
  }
  return _slugCache;
}
// Pre-warm cache on startup
setTimeout(() => getSlugCache(), 3000);

// ── Event search (DB + generated slugs) ───────────────────────────────────
const MONTH_NAMES = ['january','february','march','april','may','june','july','august','september','october','november','december'];

function generateSlugsForDate(targetDate, durations) {
  const slugs = [];
  const durs = durations || ['5m', '15m', '1h'];

  for (const dur of durs) {
    if (dur === '5m' || dur === '15m') {
      const interval = dur === '5m' ? 300 : 900;
      const prefix = dur === '5m' ? 'btc-updown-5m' : 'btc-updown-15m';
      // Generate slots centered on the target date (UTC day ± 6h for timezone)
      const dayStart = new Date(targetDate); dayStart.setUTCHours(0, 0, 0, 0);
      const startEpoch = Math.floor(dayStart.getTime() / 1000);
      const endEpoch = startEpoch + 24 * 3600;
      for (let ep = endEpoch; ep >= startEpoch; ep -= interval) {
        slugs.push({ slug: `${prefix}-${ep}`, duration: dur, epoch: ep });
      }
    } else if (dur === '1h') {
      const etFmt = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', month: 'numeric', day: 'numeric' });
      const parts = {}; etFmt.formatToParts(targetDate).forEach(p => { parts[p.type] = p.value; });
      const month = MONTH_NAMES[parseInt(parts.month) - 1];
      const day = parseInt(parts.day);
      for (let h = 23; h >= 0; h--) {
        const hour12 = h === 0 ? 12 : h > 12 ? h - 12 : h;
        const ampm = h < 12 ? 'am' : 'pm';
        const slug = `bitcoin-up-or-down-${month}-${day}-${hour12}${ampm}-et`;
        // Approximate epoch for sorting
        const dayMs = new Date(targetDate); dayMs.setUTCHours(0, 0, 0, 0);
        const approxEpoch = Math.floor(dayMs.getTime() / 1000) + h * 3600;
        slugs.push({ slug, duration: '1h', epoch: approxEpoch });
      }
    }
  }
  return slugs;
}

function generateRecentSlugs(durations) {
  const slugs = [];
  const durs = durations || ['5m', '15m', '1h'];
  const now = Math.floor(Date.now() / 1000);

  for (const dur of durs) {
    if (dur === '5m' || dur === '15m') {
      const interval = dur === '5m' ? 300 : 900;
      const prefix = dur === '5m' ? 'btc-updown-5m' : 'btc-updown-15m';
      const base = Math.floor(now / interval) * interval;
      const count = dur === '5m' ? 36 : 16; // ~3h of 5m or ~4h of 15m
      for (let i = 2; i >= -count; i--) {
        const ep = base + i * interval;
        slugs.push({ slug: `${prefix}-${ep}`, duration: dur, epoch: ep });
      }
    } else if (dur === '1h') {
      // Generate today's and yesterday's 1h slugs
      for (let dayOff = 0; dayOff <= 1; dayOff++) {
        const d = new Date(Date.now() - dayOff * 86400000);
        const etFmt = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', month: 'numeric', day: 'numeric' });
        const parts = {}; etFmt.formatToParts(d).forEach(p => { parts[p.type] = p.value; });
        const month = MONTH_NAMES[parseInt(parts.month) - 1];
        const day = parseInt(parts.day);
        for (let h = 23; h >= 0; h--) {
          const hour12 = h === 0 ? 12 : h > 12 ? h - 12 : h;
          const ampm = h < 12 ? 'am' : 'pm';
          const slug = `bitcoin-up-or-down-${month}-${day}-${hour12}${ampm}-et`;
          const approxEpoch = now - dayOff * 86400 - (23 - h) * 3600;
          slugs.push({ slug, duration: '1h', epoch: approxEpoch });
        }
      }
    }
  }
  return slugs;
}

function slugToTitle(slug, dur) {
  const epochMatch = slug.match(/(\d{10,})/);
  if (epochMatch) {
    const ep = parseInt(epochMatch[1]);
    const d = new Date(ep * 1000);
    return `BTC Up/Down ${dur || '?'} — ${d.toLocaleString('en-US', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: true, timeZone: 'America/New_York' })} ET`;
  }
  if (slug.startsWith('bitcoin-up-or-down-')) {
    return 'BTC 1h — ' + slug.replace(/^bitcoin-up-or-down-/, '').replace(/-/g, ' ');
  }
  return slug;
}

app.get('/api/event-search', async (req, res) => {
  try {
    const { duration, date, q } = req.query;
    const limit = parseInt(req.query.limit) || 100;

    // 1. Get DB slugs from cache (fast!)
    const cache = await getSlugCache();
    const dbMap = {};
    function addDb(slug, source, count) {
      if (!slug) return;
      if (!dbMap[slug]) dbMap[slug] = { sources: new Set(), count: 0 };
      dbMap[slug].sources.add(source);
      dbMap[slug].count += (count || 1);
    }
    for (const s of cache.snapSlugs) addDb(s, 'snapshots');
    for (const [slug, count] of Object.entries(cache.k9Slugs)) addDb(slug, 'k9', count);
    for (const s of cache.analysisSlugs) addDb(s, 'analysis');

    // 2. Generate slugs based on filters
    const durs = duration ? [duration] : ['5m', '15m', '1h'];
    let generated;
    if (date) {
      generated = generateSlugsForDate(new Date(date + 'T12:00:00Z'), durs);
    } else {
      generated = generateRecentSlugs(durs);
    }

    // 3. Deduplicate generated slugs, then add DB-only slugs
    const seen = new Set();
    generated = generated.filter(g => {
      if (seen.has(g.slug)) return false;
      seen.add(g.slug);
      return true;
    });
    for (const slug of Object.keys(dbMap)) {
      if (seen.has(slug)) continue;
      let dur = null;
      if (slug.includes('-5m-')) dur = '5m';
      else if (slug.includes('-15m-')) dur = '15m';
      else if (slug.startsWith('bitcoin-up-or-down-')) dur = '1h';
      if (duration && dur !== duration) continue;
      const epochMatch = slug.match(/(\d{10,})/);
      const epoch = epochMatch ? parseInt(epochMatch[1]) : 0;
      generated.push({ slug, duration: dur, epoch });
    }

    // 4. Build results with DB enrichment
    const now = Math.floor(Date.now() / 1000);
    let results = generated.map(g => {
      const db = dbMap[g.slug];
      const durSecs = g.duration === '1h' ? 3600 : g.duration === '15m' ? 900 : 300;
      return {
        slug: g.slug,
        duration: g.duration,
        title: slugToTitle(g.slug, g.duration),
        active: g.epoch + durSecs > now && g.epoch <= now,
        upcoming: g.epoch > now,
        hasData: !!db,
        count: db?.count || 0,
        sources: db ? [...db.sources] : [],
        isCurrent: g.slug === liveState.eventSlug,
        epoch: g.epoch,
      };
    });

    // Sort: current first, then active, then by epoch descending
    results.sort((a, b) => {
      if (a.isCurrent !== b.isCurrent) return a.isCurrent ? -1 : 1;
      if (a.active !== b.active) return a.active ? -1 : 1;
      return b.epoch - a.epoch;
    });

    // Text search
    if (q) {
      const lower = q.toLowerCase();
      results = results.filter(e => e.slug.toLowerCase().includes(lower) || e.title.toLowerCase().includes(lower));
    }

    res.json({ events: results.slice(0, limit) });
  } catch (e) {
    console.error('[event-search] Error:', e.message);
    res.status(500).json({ events: [], error: e.message });
  }
});

// ── Switch active event ───────────────────────────────────────────────────
app.post('/api/event/switch', async (req, res) => {
  try {
    const { slug } = req.body;
    if (!slug) return res.status(400).json({ error: 'slug required' });

    const r = await fetch(`https://gamma-api.polymarket.com/events?slug=${encodeURIComponent(slug)}`);
    const data = await r.json();
    const ev = Array.isArray(data) ? data[0] : data;
    if (!ev) return res.status(404).json({ error: 'Event not found' });
    const market = ev.markets?.[0];
    if (!market) return res.status(404).json({ error: 'No market data' });

    let tokenIds = [];
    try { tokenIds = JSON.parse(typeof market.clobTokenIds === 'string' ? market.clobTokenIds : '[]'); } catch {}
    const outcomes = JSON.parse(market.outcomes || '["Up","Down"]');

    if (liveState.eventSlug) saveEventAnalysis(liveState.eventSlug);

    const newEvent = {
      slug: ev.slug, title: ev.title,
      startDate: ev.startDate, endDate: ev.endDate,
      tokenUp: tokenIds[0], tokenDown: tokenIds[1],
      marketId: market.id,
      conditionId: market.conditionId || market.condition_id || null,
      tickSize: market.orderPriceMinTickSize || '0.01',
      negRisk: !!market.negRisk,
      min_incentive_size: market.rewardsMinSize ?? market.min_incentive_size ?? null,
      max_incentive_spread: market.rewardsMaxSpread ?? market.max_incentive_spread ?? null,
      rewards_config: [],
    };

    liveState.eventSlug = newEvent.slug;
    liveState.eventTitle = newEvent.title;
    liveState.tokenUp = newEvent.tokenUp;
    liveState.tokenDown = newEvent.tokenDown;
    liveState.upPrice = null;
    liveState.downPrice = null;
    liveState.upStartPrice = null;
    liveState.downStartPrice = null;
    liveState.btcStart = liveState.btcCurrent;
    activeEvent = newEvent;
    manualEventOverride = true;

    broadcast({ type: 'event', event: newEvent });
    await fetchInitialPrices();
    if (newEvent.tokenUp && newEvent.tokenDown) {
      connectClobStream([newEvent.tokenUp, newEvent.tokenDown]);
    }

    console.log(`[EVENT] Manually switched to: ${slug}`);
    res.json({ success: true, event: newEvent });
  } catch (e) {
    console.error('[event/switch] Error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ── Force refresh (back to auto 5m cycle) ─────────────────────────────────
app.post('/api/event/refresh', async (req, res) => {
  manualEventOverride = false;
  await refreshEvent();
  res.json({ success: true, event: activeEvent });
});

// ── BTC 5m reward config (min_incentive_size, max_incentive_spread, epoch allocations) ─
app.get('/api/btc5m-reward-config', (req, res) => {
  if (!activeEvent) return res.json({ error: 'No active event' });
  res.json({
    slug: activeEvent.slug,
    min_incentive_size: activeEvent.min_incentive_size ?? null,
    max_incentive_spread: activeEvent.max_incentive_spread ?? null,
    rewards_config: activeEvent.rewards_config ?? [],
  });
});

// ── Price snapshot buffer — capture on every tick, batch-flush to Supabase ────
const snapshotBuffer = [];

async function pushSnapshot() {
  if (!liveState.eventSlug) return;
  if (liveState.btcCurrent == null && liveState.binanceBtc == null) return;
  const endDate = activeEvent?.endDate ? new Date(activeEvent.endDate) : null;
  const secsLeft = endDate ? Math.max(0, Math.floor((endDate - Date.now()) / 1000)) : null;

  // Fetch real bid/ask from CLOB for Up and Down tokens
  let upBid = null, upAsk = null, downBid = null, downAsk = null;
  try {
    const upToken = liveState.tokenUp || activeEvent?.tokenUp;
    const downToken = liveState.tokenDown || activeEvent?.tokenDown;
    if (upToken && downToken) {
      const [ubr, uar, dbr, dar] = await Promise.all([
        fetch(`https://clob.polymarket.com/price?token_id=${upToken}&side=buy`).then(r => r.json()).catch(() => null),
        fetch(`https://clob.polymarket.com/price?token_id=${upToken}&side=sell`).then(r => r.json()).catch(() => null),
        fetch(`https://clob.polymarket.com/price?token_id=${downToken}&side=buy`).then(r => r.json()).catch(() => null),
        fetch(`https://clob.polymarket.com/price?token_id=${downToken}&side=sell`).then(r => r.json()).catch(() => null),
      ]);
      upBid = ubr?.price ? parseFloat(ubr.price) : null;
      upAsk = uar?.price ? parseFloat(uar.price) : null;
      downBid = dbr?.price ? parseFloat(dbr.price) : null;
      downAsk = dar?.price ? parseFloat(dar.price) : null;
    }
  } catch (e) { /* ignore — bid/ask are optional */ }

  snapshotBuffer.push({
    event_slug: liveState.eventSlug,
    btc_price: liveState.btcCurrent,
    coin_price: liveState.binanceBtc,
    up_cost: liveState.upPrice,
    down_cost: liveState.downPrice,
    up_best_bid: upBid,
    up_best_ask: upAsk,
    down_best_bid: downBid,
    down_best_ask: downAsk,
    up_spread: upBid != null && upAsk != null ? Number((upAsk - upBid).toFixed(4)) : null,
    down_spread: downBid != null && downAsk != null ? Number((downAsk - downBid).toFixed(4)) : null,
    observed_at: new Date().toISOString(),
    seconds_left: secsLeft,
    coin: 'btc',
  });
}

// Capture a snapshot every 1s
setInterval(() => { pushSnapshot(); }, 1000);

// Flush buffer to Supabase every 5s
setInterval(async () => {
  if (!snapshotBuffer.length) return;
  const batch = snapshotBuffer.splice(0, snapshotBuffer.length);
  try {
    const { error } = await supabase.from('polymarket_15m_snapshots').insert(batch);
    if (error) console.error('[SNAPSHOT] batch error:', error.message);
  } catch (e) {
    console.error('[SNAPSHOT] flush error:', e.message);
  }
}, 1000);

// ── Event archive (from price_change_analysis + live snapshots) ──────────────
app.get('/api/event-archive', async (req, res) => {
  try {
    // 1. Get saved events from price_change_analysis
    const { data: analysisData } = await supabase
      .from('price_change_analysis')
      .select('event_name, time, delta')
      .order('time', { ascending: false })
      .limit(10000);

    const bySlug = {};
    for (const r of (analysisData || [])) {
      if (!r.event_name) continue;
      if (!bySlug[r.event_name]) bySlug[r.event_name] = { count: 0, first: r, last: r };
      bySlug[r.event_name].count++;
      // Since desc order: first seen = latest, update last = earliest
      bySlug[r.event_name].last = r;
    }

    // 2. Also get current live event from snapshots
    if (liveState.eventSlug?.startsWith('btc-updown-5m-')) {
      const { data: liveSnaps } = await supabase
        .from('polymarket_15m_snapshots')
        .select('observed_at, btc_price, coin_price, up_cost, down_cost')
        .eq('event_slug', liveState.eventSlug)
        .order('observed_at', { ascending: false })
        .limit(500);
      if (liveSnaps?.length) {
        const latest = liveSnaps[0];
        const earliest = liveSnaps[liveSnaps.length - 1];
        bySlug[liveState.eventSlug] = {
          count: liveSnaps.length,
          first: { time: latest.observed_at, delta: latest.btc_price && latest.coin_price ? latest.btc_price - latest.coin_price : null },
          last: { time: earliest.observed_at, delta: earliest.btc_price && earliest.coin_price ? earliest.btc_price - earliest.coin_price : null },
          live: true,
          up_end: latest.up_cost,
          down_end: latest.down_cost,
        };
      }
    }

    const events = Object.entries(bySlug).map(([slug, info]) => ({
      slug,
      count: info.count,
      start_time: info.last.time,
      end_time: info.first.time,
      avg_delta: info.first.delta,
      up_end: info.up_end,
      down_end: info.down_end,
      is_current: info.live || false,
    })).sort((a, b) => new Date(b.end_time) - new Date(a.end_time));

    res.json({ events });
  } catch (e) {
    res.json({ events: [], error: e.message });
  }
});

// ── CSV download endpoint ────────────────────────────────────────────────────
app.get('/api/price-csv', async (req, res) => {
  const slug = req.query.slug || liveState.eventSlug;
  if (!slug) return res.status(400).send('No slug');
  try {
    // Paginate to fetch ALL rows (Supabase caps at 1000 per request)
    let rows = [];
    let offset = 0;
    const PAGE = 1000;
    while (true) {
      const { data, error } = await supabase
        .from('polymarket_15m_snapshots')
        .select('observed_at, btc_price, coin_price, up_cost, down_cost, seconds_left')
        .eq('event_slug', slug)
        .order('observed_at', { ascending: true })
        .range(offset, offset + PAGE - 1);
      if (error) return res.status(500).send(error.message);
      if (!data || !data.length) break;
      rows = rows.concat(data);
      if (data.length < PAGE) break;
      offset += PAGE;
    }
    let csv = 'time,polymarket_btc,poly_chg,binance_btc,bin_chg,delta,up_cents,up_chg,down_cents,down_chg,seconds_left\n';
    for (let i = 0; i < rows.length; i++) {
      const s = rows[i];
      const prev = i > 0 ? rows[i - 1] : null;
      const pChg = prev && s.btc_price && prev.btc_price ? (s.btc_price - prev.btc_price).toFixed(2) : '';
      const bChg = prev && s.coin_price && prev.coin_price ? (s.coin_price - prev.coin_price).toFixed(2) : '';
      const delta = s.btc_price && s.coin_price ? (s.btc_price - s.coin_price).toFixed(2) : '';
      const up = s.up_cost != null ? (s.up_cost * 100).toFixed(1) : '';
      const dn = s.down_cost != null ? (s.down_cost * 100).toFixed(1) : '';
      const prevUp = prev && prev.up_cost != null ? prev.up_cost * 100 : null;
      const prevDn = prev && prev.down_cost != null ? prev.down_cost * 100 : null;
      const uChg = s.up_cost != null && prevUp != null ? (s.up_cost * 100 - prevUp).toFixed(1) : '';
      const dChg = s.down_cost != null && prevDn != null ? (s.down_cost * 100 - prevDn).toFixed(1) : '';
      csv += [s.observed_at || '', s.btc_price ?? '', pChg, s.coin_price ?? '', bChg, delta, up, uChg, dn, dChg, s.seconds_left ?? ''].join(',') + '\n';
    }
    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', `attachment; filename="${slug}.csv"`);
    res.send(csv);
  } catch (e) {
    res.status(500).send(e.message);
  }
});

// ── Price history endpoint ──────────────────────────────────────────────────
app.get('/api/price-history', async (req, res) => {
  const slug = req.query.slug || liveState.eventSlug;
  const limit = parseInt(req.query.limit || '100');
  if (!slug) return res.json({ snapshots: [] });
  try {
    const { data, error } = await supabase
      .from('polymarket_15m_snapshots')
      .select('observed_at, btc_price, coin_price, up_cost, down_cost, seconds_left')
      .eq('event_slug', slug)
      .order('observed_at', { ascending: false })
      .limit(limit);
    if (error) return res.json({ snapshots: [], error: error.message });
    res.json({ snapshots: (data || []).reverse(), slug });
  } catch (e) {
    res.json({ snapshots: [], error: e.message });
  }
});

// ── Resolution cache (resolved events never change) ────────────────────────
const resolutionCache = {};
async function getResolution(slug) {
  if (resolutionCache[slug] !== undefined) return resolutionCache[slug];
  try {
    const r = await fetch(`https://gamma-api.polymarket.com/events?slug=${slug}`);
    const data = await r.json();
    const m = data?.[0]?.markets?.[0];
    if (!m) return null; // don't cache — might be transient
    const prices = JSON.parse(m.outcomePrices || '[]');
    const outcomes = JSON.parse(m.outcomes || '[]');
    const closed = !!m.closed;
    let winner = null;
    if (closed && prices.length === 2) {
      if (prices[0] === '1') winner = outcomes[0];
      else if (prices[1] === '1') winner = outcomes[1];
    }
    const result = { closed, winner, title: data[0]?.title || slug };
    if (closed && winner) resolutionCache[slug] = result; // only cache resolved
    return result;
  } catch { return null; } // don't cache errors — retry next time
}

// ── Sim dashboard ──────────────────────────────────────────────────────────
// Net out complete-set buys from observed trades — per tx, cancel matching Up+Down shares
app.get('/api/sim-dashboard', async (req, res) => {
  const limit = parseInt(req.query.limit || '50');
  const { duration, date } = req.query;

  try {
    // Get ALL distinct slugs from cache (fast!)
    const cache = await getSlugCache();
    const k9Slugs = Object.keys(cache.k9Slugs);
    const seen = new Set(k9Slugs);
    for (const s of cache.snapSlugs) {
      if (!seen.has(s)) { seen.add(s); k9Slugs.push(s); }
    }
    let slugSet = k9Slugs;

    // Server-side duration filter (match known slug formats)
    if (duration) {
      slugSet = slugSet.filter(s => {
        if (duration === '5m') return s.includes('-5m-') || s.startsWith('btc-updown-5m');
        if (duration === '15m') return s.includes('-15m-') || s.startsWith('btc-updown-15m');
        if (duration === '1h') return s.startsWith('bitcoin-up-or-down-');
        return true;
      });
    }

    // Server-side date filter
    if (date) {
      slugSet = slugSet.filter(s => {
        const epochMatch = s.match(/(\d{10,})/);
        if (epochMatch) {
          const d = new Date(parseInt(epochMatch[1]) * 1000);
          return d.toISOString().slice(0, 10) === date;
        }
        // For 1h slugs like bitcoin-up-or-down-march-5-9pm-et, parse month/day
        const m = s.match(/bitcoin-up-or-down-(\w+)-(\d+)-/);
        if (m) {
          const monthNames = ['january','february','march','april','may','june','july','august','september','october','november','december'];
          const monthIdx = monthNames.indexOf(m[1].toLowerCase());
          const day = parseInt(m[2]);
          if (monthIdx >= 0) {
            const dateObj = new Date(date);
            return dateObj.getUTCMonth() === monthIdx && dateObj.getUTCDate() === day;
          }
        }
        return true;
      });
    }

    // When duration filter yields few slugs, always pad with generated (k9 may have traded a lot in few markets)
    const minSlugs = duration ? 30 : Math.max(limit, 20); // guarantee 30+ when filtered by timeframe
    if (slugSet.length < minSlugs) {
      const durs = duration ? [duration] : ['5m', '15m', '1h'];
      const generated = generateRecentSlugs(durs);
      const have = new Set(slugSet);
      for (const g of generated) {
        if (!have.has(g.slug)) { have.add(g.slug); slugSet.push(g.slug); }
        if (slugSet.length >= minSlugs) break;
      }
      // Sort by epoch desc (most recent first)
      slugSet.sort((a, b) => {
        const ea = parseInt((a.match(/(\d{10,})/) || [0, 0])[1]) || 0;
        const eb = parseInt((b.match(/(\d{10,})/) || [0, 0])[1]) || 0;
        return eb - ea;
      });
    }
    slugSet = slugSet.slice(0, limit);
    if (!slugSet.length) return res.json({ events: [], totals: {} });

    // Fetch k9 trades for all slugs in parallel batches
    async function fetchBatch(batch) {
      let all = [];
      let offset = 0;
      const PAGE = 1000;
      while (true) {
        const { data } = await supabase.from('k9_observed_trades')
          .select('*').in('slug', batch).order('trade_timestamp', { ascending: true })
          .range(offset, offset + PAGE - 1);
        if (!data || !data.length) break;
        all = all.concat(data);
        if (data.length < PAGE) break;
        offset += PAGE;
      }
      return all;
    }
    const CHUNK = 10; // smaller chunks run in parallel
    const batches = [];
    for (let i = 0; i < slugSet.length; i += CHUNK) {
      batches.push(slugSet.slice(i, i + CHUNK));
    }
    const batchResults = await Promise.all(batches.map(b => fetchBatch(b)));
    const obs = batchResults.flat();

    const events = slugSet.map(slug => {
      const k9Trades = (obs || []).filter(t => t.slug === slug);
      const summary = {};
      for (const side of ['Up', 'Down']) {
        const kt = k9Trades.filter(t => t.outcome === side);
        const k9Usdc   = kt.reduce((s,t) => s + parseFloat(t.usdc_size), 0);
        const k9Shares = kt.reduce((s,t) => s + parseFloat(t.shares), 0);
        const buys  = kt.filter(t => parseFloat(t.shares) > 0);
        const sells = kt.filter(t => parseFloat(t.shares) < 0);
        const buyUsdc    = buys.reduce((s,t) => s + parseFloat(t.usdc_size), 0);
        const buyShares  = buys.reduce((s,t) => s + parseFloat(t.shares), 0);
        const sellUsdc   = sells.reduce((s,t) => s + Math.abs(parseFloat(t.usdc_size)), 0);
        const sellShares = sells.reduce((s,t) => s + Math.abs(parseFloat(t.shares)), 0);
        const avgBuyPrice = buyShares > 0 ? buyUsdc / buyShares : 0;
        const sellPnl = sellShares > 0 ? sellUsdc - (sellShares * avgBuyPrice) : 0;
        summary[side] = {
          k9Usdc, k9Shares,
          k9AvgPrice: buyShares > 0 ? buyUsdc / buyShares : 0,
          k9BuyUsdc: buyUsdc, k9BuyShares: buyShares,
          k9SellUsdc: sellUsdc, k9SellShares: sellShares, k9SellPnl: sellPnl,
          k9LastPrice: kt.length ? parseFloat(kt[kt.length-1].price) : 0,
          tradeCount: kt.length,
        };
      }
      const totalK9Usdc = (summary.Up?.k9Usdc||0) + (summary.Down?.k9Usdc||0);
      // Recent trades feed
      const feed = k9Trades.slice(-50).map(t => ({
        outcome: t.outcome, side: parseFloat(t.shares) > 0 ? 'buy' : 'sell',
        price: parseFloat(t.price), shares: Math.abs(parseFloat(t.shares)),
        usdc: Math.abs(parseFloat(t.usdc_size)), ts: t.trade_timestamp,
      }));

      // ── Simulation: group by second ──
      const SIM_MODES = [
        '1pct_070',
        '5pct_070',
        '10pct_070',
        '50pct_070',
        '1pct_070_min5',
        '5pct_070_min5',
        '10pct_070_min5',
        '50pct_070_min5',
        '5sh',
        '1usd',
      ];
      const PCT_BY_MODE = {
        '1pct_070': 0.01,
        '5pct_070': 0.05,
        '10pct_070': 0.10,
        '50pct_070': 0.50,
        '1pct_070_min5': 0.01,
        '5pct_070_min5': 0.05,
        '10pct_070_min5': 0.10,
        '50pct_070_min5': 0.50,
      };
      const CUM50_PCT_MODES = new Set(['1pct_070', '5pct_070', '10pct_070', '50pct_070']);
      const MIN5_PCT_MODES = new Set(['1pct_070_min5', '5pct_070_min5', '10pct_070_min5', '50pct_070_min5']);
      const sim = {
        '5sh': { Up: { shares: 0, cost: 0, realized: 0, pending: [], queuedBuy: 0, queuedSell: 0 }, Down: { shares: 0, cost: 0, realized: 0, pending: [], queuedBuy: 0, queuedSell: 0 } },
        '1usd': { Up: { shares: 0, cost: 0, realized: 0, pending: [], queuedBuy: 0, queuedSell: 0 }, Down: { shares: 0, cost: 0, realized: 0, pending: [], queuedBuy: 0, queuedSell: 0 } },
        // 1% of k9 size, only when per-second grouped notional >= $0.01
        '1pct_070': { Up: { shares: 0, cost: 0, realized: 0, pending: [], queuedBuy: 0, queuedSell: 0 }, Down: { shares: 0, cost: 0, realized: 0, pending: [], queuedBuy: 0, queuedSell: 0 } },
        '5pct_070': { Up: { shares: 0, cost: 0, realized: 0, pending: [], queuedBuy: 0, queuedSell: 0 }, Down: { shares: 0, cost: 0, realized: 0, pending: [], queuedBuy: 0, queuedSell: 0 } },
        '10pct_070': { Up: { shares: 0, cost: 0, realized: 0, pending: [], queuedBuy: 0, queuedSell: 0 }, Down: { shares: 0, cost: 0, realized: 0, pending: [], queuedBuy: 0, queuedSell: 0 } },
        '50pct_070': { Up: { shares: 0, cost: 0, realized: 0, pending: [], queuedBuy: 0, queuedSell: 0 }, Down: { shares: 0, cost: 0, realized: 0, pending: [], queuedBuy: 0, queuedSell: 0 } },
        '1pct_070_min5': { Up: { shares: 0, cost: 0, realized: 0, pending: [], queuedBuy: 0, queuedSell: 0 }, Down: { shares: 0, cost: 0, realized: 0, pending: [], queuedBuy: 0, queuedSell: 0 } },
        '5pct_070_min5': { Up: { shares: 0, cost: 0, realized: 0, pending: [], queuedBuy: 0, queuedSell: 0 }, Down: { shares: 0, cost: 0, realized: 0, pending: [], queuedBuy: 0, queuedSell: 0 } },
        '10pct_070_min5': { Up: { shares: 0, cost: 0, realized: 0, pending: [], queuedBuy: 0, queuedSell: 0 }, Down: { shares: 0, cost: 0, realized: 0, pending: [], queuedBuy: 0, queuedSell: 0 } },
        '50pct_070_min5': { Up: { shares: 0, cost: 0, realized: 0, pending: [], queuedBuy: 0, queuedSell: 0 }, Down: { shares: 0, cost: 0, realized: 0, pending: [], queuedBuy: 0, queuedSell: 0 } },
      };
      const simMeta = Object.fromEntries(SIM_MODES.map(m => [m, { triggerCount: 0, triggers: [], fills: [] }]));
      // Group trades by second
      const bySecond = {};
      for (const t of k9Trades) {
        const sec = parseInt(t.trade_timestamp);
        if (!bySecond[sec]) bySecond[sec] = [];
        bySecond[sec].push(t);
      }
      // Process seconds in chronological order (critical for fill logic)
      const sortedSeconds = Object.keys(bySecond).map(Number).sort((a, b) => a - b);
      for (const sec of sortedSeconds) {
        const trades = bySecond[sec];
        // Aggregate net shares per outcome in this second
        const netByOutcome = {};
        for (const t of trades) {
          if (!netByOutcome[t.outcome]) netByOutcome[t.outcome] = { shares: 0, usdc: 0, usdcGross: 0, prices: [] };
          netByOutcome[t.outcome].shares += parseFloat(t.shares);
          netByOutcome[t.outcome].usdc += parseFloat(t.usdc_size);
          netByOutcome[t.outcome].usdcGross += Math.abs(parseFloat(t.usdc_size));
          netByOutcome[t.outcome].prices.push(parseFloat(t.price));
        }
        for (const [outcome, agg] of Object.entries(netByOutcome)) {
          if (Math.abs(agg.shares) < 0.01) continue; // no meaningful net movement
          const isBuySignal = agg.shares > 0;
          const avgPrice = agg.prices.reduce((a,b)=>a+b,0) / agg.prices.length;
          if (avgPrice <= 0) continue;

          for (const mode of SIM_MODES) {
            const book = sim[mode][outcome];

            // 1) Try to fill resting orders using this second's avg price
            if (book.pending?.length) {
              const nextPending = [];
              for (const ord of book.pending) {
                const canFill = ord.side === 'buy' ? (avgPrice <= ord.price) : (avgPrice >= ord.price);
                if (!canFill) {
                  nextPending.push(ord);
                  continue;
                }
                let fillQty = ord.remaining;
                if (ord.side === 'buy') {
                  book.shares += fillQty;
                  book.cost += fillQty * ord.price;
                } else {
                  const held = book.shares;
                  fillQty = Math.min(fillQty, held);
                  if (fillQty <= 0) {
                    nextPending.push(ord);
                    continue;
                  }
                  const avgBuy = book.shares > 0 ? (book.cost / book.shares) : ord.price;
                  const proceeds = fillQty * ord.price;
                  const basis = fillQty * avgBuy;
                  book.shares -= fillQty;
                  book.cost -= basis;
                  book.realized += (proceeds - basis);
                }
                const leftover = ord.remaining - fillQty;
                if (leftover > 0.000001) nextPending.push({ ...ord, remaining: leftover });
                simMeta[mode].fills.push({ ts: Number(sec), side: ord.side, outcome, shares: fillQty, price: ord.price, notional: fillQty * ord.price });
              }
              book.pending = nextPending;
            }

            // 2) New trigger: place limit order and keep resting if not filled
            const limitPrice = isBuySignal
              ? Math.max(avgPrice - 0.01, 0.01)
              : Math.min(avgPrice + 0.01, 0.99);

            let orderQty = 0;
            const side = isBuySignal ? 'buy' : 'sell';
            if (mode === '5sh') orderQty = 5;
            else if (mode === '1usd') orderQty = 1 / limitPrice;
            else if (PCT_BY_MODE[mode]) {
              const pct = PCT_BY_MODE[mode];
              const ourNotional = Math.abs(agg.usdc) * pct;
              if (ourNotional < 0.01) continue; // match live: skip if our copy size < 1¢
              const signalQty = Math.abs(agg.shares) * pct;
              if (CUM50_PCT_MODES.has(mode)) {
                if (side === 'buy') {
                  book.queuedBuy = (book.queuedBuy || 0) + signalQty;
                  if (book.queuedBuy < 50) continue; // keep adding until 50 units
                  orderQty = book.queuedBuy;
                  book.queuedBuy = 0;
                } else {
                  book.queuedSell = (book.queuedSell || 0) + signalQty;
                  const available = Math.min(book.queuedSell, book.shares);
                  if (available < 50) continue; // keep adding until 50 units
                  orderQty = available;
                  book.queuedSell = Math.max(0, (book.queuedSell || 0) - orderQty);
                }
              } else if (MIN5_PCT_MODES.has(mode)) {
                if (side === 'buy') {
                  book.queuedBuy = (book.queuedBuy || 0) + signalQty;
                  if (book.queuedBuy < 5) continue;
                  orderQty = Math.floor(book.queuedBuy * 100) / 100;
                  book.queuedBuy = Math.max(0, book.queuedBuy - orderQty);
                } else {
                  book.queuedSell = (book.queuedSell || 0) + signalQty;
                  const available = Math.min(book.queuedSell, book.shares);
                  if (available < 5) continue;
                  orderQty = Math.floor(available * 100) / 100;
                  book.queuedSell = Math.max(0, (book.queuedSell || 0) - orderQty);
                }
              }
            }
            if (orderQty <= 0) continue;
            if (side === 'sell') {
              orderQty = Math.min(orderQty, book.shares);
              if (orderQty < 0.01) continue;
            }

            const ord = {
              id: `${sec}-${mode}-${outcome}-${side}-${Math.random().toString(36).slice(2, 7)}`,
              side,
              price: limitPrice,
              remaining: orderQty,
              placedTs: Number(sec),
            };
            book.pending.push(ord);
            simMeta[mode].triggerCount += 1;
            simMeta[mode].triggers.push({ ts: Number(sec), side, outcome, shares: orderQty, price: limitPrice, notional: orderQty * limitPrice });
          }
        }
      }
      // Settle any remaining pending orders (assume they fill at limit price)
      // Without this, we'd show "cost $0 · pending" for events with sparse fills
      for (const mode of SIM_MODES) {
        for (const outcome of ['Up', 'Down']) {
          const book = sim[mode][outcome];
          const pending = book.pending || [];
          book.pending = [];
          for (const ord of pending) {
            if (ord.side === 'buy') {
              book.shares += ord.remaining;
              book.cost += ord.remaining * ord.price;
              simMeta[mode].fills.push({ ts: ord.placedTs, side: 'buy', outcome, shares: ord.remaining, price: ord.price, notional: ord.remaining * ord.price });
            } else {
              const fillQty = Math.min(ord.remaining, book.shares);
              if (fillQty < 0.000001) continue;
              const avgBuy = book.shares > 0 ? (book.cost / book.shares) : ord.price;
              const proceeds = fillQty * ord.price;
              const basis = fillQty * avgBuy;
              book.shares -= fillQty;
              book.cost -= basis;
              book.realized = (book.realized || 0) + (proceeds - basis);
              simMeta[mode].fills.push({ ts: ord.placedTs, side: 'sell', outcome, shares: fillQty, price: ord.price, notional: fillQty * ord.price });
            }
          }
        }
      }
      // Build sim summary with P&L fields
      const simSummary = {};
      for (const mode of SIM_MODES) {
        simSummary[mode] = {};
        for (const side of ['Up', 'Down']) {
          simSummary[mode][side] = {
            shares: sim[mode][side].shares,
            cost: sim[mode][side].cost,
            realized: sim[mode][side].realized || 0,
          };
        }
        simSummary[mode].totalCost = sim[mode].Up.cost + sim[mode].Down.cost;
        simSummary[mode].totalRealized = (sim[mode].Up.realized || 0) + (sim[mode].Down.realized || 0);
        simSummary[mode].triggerCount = simMeta[mode].triggerCount;
        simSummary[mode].triggers = simMeta[mode].triggers.slice(-30);
        simSummary[mode].fillCount = simMeta[mode].fills.length;
        simSummary[mode].fills = simMeta[mode].fills.slice(-30);
        simSummary[mode].pendingCount = (sim[mode].Up.pending?.length || 0) + (sim[mode].Down.pending?.length || 0);
        simSummary[mode].pendingNotional = (sim[mode].Up.pending || []).reduce((a, o) => a + (o.remaining * o.price), 0) + (sim[mode].Down.pending || []).reduce((a, o) => a + (o.remaining * o.price), 0);
        simSummary[mode].buyTriggerCount = simMeta[mode].triggers.filter(t => t.side === 'buy').length;
        simSummary[mode].sellTriggerCount = simMeta[mode].triggers.filter(t => t.side === 'sell').length;
        simSummary[mode].buyFillCount = simMeta[mode].fills.filter(f => f.side === 'buy').length;
        simSummary[mode].sellFillCount = simMeta[mode].fills.filter(f => f.side === 'sell').length;
        const upPending = sim[mode].Up.pending || [];
        const downPending = sim[mode].Down.pending || [];
        simSummary[mode].buyPendingCount = upPending.filter(o => o.side === 'buy').length + downPending.filter(o => o.side === 'buy').length;
        simSummary[mode].sellPendingCount = upPending.filter(o => o.side === 'sell').length + downPending.filter(o => o.side === 'sell').length;
        simSummary[mode].buyPendingNotional = upPending.filter(o => o.side === 'buy').reduce((a, o) => a + (o.remaining * o.price), 0)
          + downPending.filter(o => o.side === 'buy').reduce((a, o) => a + (o.remaining * o.price), 0);
        simSummary[mode].sellPendingNotional = upPending.filter(o => o.side === 'sell').reduce((a, o) => a + (o.remaining * o.price), 0)
          + downPending.filter(o => o.side === 'sell').reduce((a, o) => a + (o.remaining * o.price), 0);
      }

      return { slug, summary, feed, totalK9Usdc, sim: simSummary };
    });

    // Fetch resolution data
    const resolutions = await Promise.all(slugSet.map(s => getResolution(s)));
    events.forEach((ev, i) => { ev.resolution = resolutions[i]; });

    // Totals
    let totalK9Usdc = 0, totalSellPnl = 0, totalResPnl = 0, resolvedCount = 0;
    const SIM_MODES = [
      '1pct_070',
      '5pct_070',
      '10pct_070',
      '50pct_070',
      '1pct_070_min5',
      '5pct_070_min5',
      '10pct_070_min5',
      '50pct_070_min5',
      '5sh',
      '1usd',
    ];
    const simTotals = {
      '1pct_070': { cost: 0, pnl: 0, triggers: 0, fills: 0, pending: 0 },
      '5pct_070': { cost: 0, pnl: 0, triggers: 0, fills: 0, pending: 0 },
      '10pct_070': { cost: 0, pnl: 0, triggers: 0, fills: 0, pending: 0 },
      '50pct_070': { cost: 0, pnl: 0, triggers: 0, fills: 0, pending: 0 },
      '1pct_070_min5': { cost: 0, pnl: 0, triggers: 0, fills: 0, pending: 0 },
      '5pct_070_min5': { cost: 0, pnl: 0, triggers: 0, fills: 0, pending: 0 },
      '10pct_070_min5': { cost: 0, pnl: 0, triggers: 0, fills: 0, pending: 0 },
      '50pct_070_min5': { cost: 0, pnl: 0, triggers: 0, fills: 0, pending: 0 },
      '5sh': { cost: 0, pnl: 0, triggers: 0, fills: 0, pending: 0 },
      '1usd': { cost: 0, pnl: 0, triggers: 0, fills: 0, pending: 0 },
    };
    for (const ev of events) {
      totalK9Usdc += ev.totalK9Usdc;
      totalSellPnl += (ev.summary.Up?.k9SellPnl||0) + (ev.summary.Down?.k9SellPnl||0);
      if (ev.resolution?.closed && ev.resolution?.winner) {
        resolvedCount++;
        for (const side of ['Up', 'Down']) {
          const s = ev.summary[side];
          if (!s) continue;
          const won = side === ev.resolution.winner;
          totalResPnl += won ? (s.k9Shares * 1) - s.k9Usdc : -s.k9Usdc;
        }
        // Sim totals for resolved events
        for (const mode of SIM_MODES) {
          const sm = ev.sim?.[mode];
          if (!sm) continue;
          const cost = sm.totalCost || 0;
          const realized = sm.totalRealized || 0;
          const upPayout = ev.resolution.winner === 'Up' ? (sm.Up?.shares || 0) : 0;
          const dnPayout = ev.resolution.winner === 'Down' ? (sm.Down?.shares || 0) : 0;
          const pnl = upPayout + dnPayout - cost + realized;
          simTotals[mode].cost += cost;
          simTotals[mode].pnl += pnl;
          simTotals[mode].triggers += (sm.triggerCount || 0);
          simTotals[mode].fills += (sm.fillCount || 0);
          simTotals[mode].pending += (sm.pendingCount || 0);
        }
      }
    }
    const totals = {
      totalK9Usdc, totalSellPnl, totalResPnl,
      totalPnl: totalSellPnl + totalResPnl,
      eventCount: slugSet.length, resolvedCount,
      simTotals,
    };
    res.json({ events, totals });
  } catch(e) {
    console.error('/api/sim-dashboard error:', e.message);
    res.json({ events: [], totals: {}, error: e.message });
  }
});

// ── k9 live trades ─────────────────────────────────────────────────────────
app.get('/api/k9-trades', async (req, res) => {
  const limit = parseInt(req.query.limit || '20');
  const slugParam = req.query.slug || req.query.slugs;
  try {
    let slugSet = [];
    if (slugParam) {
      slugSet = slugParam.split(/[\s,]+/).map(s => s.trim()).filter(Boolean);
      if (slugSet.length > 50) slugSet = slugSet.slice(0, 50);
    }
    if (slugSet.length === 0) {
      const cache = await getSlugCache();
      const allSlugs = Object.keys(cache.k9Slugs);
      allSlugs.sort((a, b) => {
        const ea = parseInt((a.match(/(\d{10,})/) || [0, 0])[1]) || 0;
        const eb = parseInt((b.match(/(\d{10,})/) || [0, 0])[1]) || 0;
        return eb - ea;
      });
      slugSet = allSlugs.slice(0, limit);
    }
    if (!slugSet.length) return res.json({ events: [] });

    const { data: trades } = await supabase
      .from('k9_observed_trades')
      .select('*')
      .in('slug', slugSet)
      .order('trade_timestamp', { ascending: true });

    // Our trades: try polymarket_copy_trades first, then Polymarket API
    let ourTradesFromDb = [];
    try {
      const { data } = await supabase.from('polymarket_copy_trades')
        .select('*').eq('coin', 'k9-15m').order('purchase_time', { ascending: true });
      ourTradesFromDb = data || [];
    } catch {}

    const ourWallet = (process.env.PROXY_WALLET || process.env.FUNDER_ADDRESS || '').toLowerCase();
    let ourTradesFromPoly = [];
    if (ourWallet) {
      try {
        const r = await fetch(`https://data-api.polymarket.com/trades?user=${ourWallet}&limit=500`);
        const poly = await r.json();
        ourTradesFromPoly = (poly || []).map(t => {
          const sh = parseFloat(t.size || 0);
          const pr = parseFloat(t.price || 0);
          const amt = sh * pr;
          const side = (t.side || '').toLowerCase();
          const outcome = (t.outcome || '').includes('Up') ? 'up' : 'down';
          return { slug: t.eventSlug || t.slug, direction: outcome, purchase_amount: side === 'buy' ? amt : -amt, shares: side === 'buy' ? sh : -sh };
        }).filter(t => t.slug);
      } catch (e) { console.error('[k9-trades] Polymarket API error:', e.message); }
    }

    const events = slugSet.map(slug => {
      const k9 = (trades || []).filter(t => t.slug === slug);
      const oursDb = (ourTradesFromDb || []).filter(t => (t.notes || '').includes(slug));
      const oursPoly = (ourTradesFromPoly || []).filter(t => t.slug === slug);
      const ours = oursDb.length ? oursDb : oursPoly;
      const summary = {};
      for (const side of ['Up', 'Down']) {
        const k9s = k9.filter(t => t.outcome === side);
        const ourSide = ours.filter(t => t.direction === side.toLowerCase());
        const k9Usdc   = k9s.reduce((s, t) => s + parseFloat(t.usdc_size), 0);
        const k9Shares = k9s.reduce((s, t) => s + parseFloat(t.shares), 0);
        const ourUsdc  = ourSide.reduce((s, t) => s + parseFloat(t.purchase_amount), 0);
        const ourShares = ourSide.reduce((s, t) => s + parseFloat(t.shares || 0), 0);
        summary[side] = {
          k9Usdc, k9Shares,
          k9AvgPrice: k9Shares > 0 ? k9Usdc / k9Shares : 0,
          k9LastPrice: k9s.length ? parseFloat(k9s[k9s.length - 1].price) : 0,
          k9Trades: k9s.length,
          ourUsdc, ourShares,
          ourAvgPrice: ourShares > 0 ? ourUsdc / ourShares : 0,
          ourTrades: ourSide.length,
          targetUsdc: k9Usdc * 0.01,
          ratio: k9Usdc > 0 ? (ourUsdc / k9Usdc) * 100 : 0,
        };
      }
      const recent = k9.slice(-30).map(t => ({
        outcome: t.outcome, price: parseFloat(t.price),
        shares: parseFloat(t.shares), usdc: parseFloat(t.usdc_size), ts: t.trade_timestamp,
      }));
      return { slug, summary, recent, totalTrades: k9.length };
    });

    res.json({ events });
  } catch (e) {
    console.error('/api/k9-trades error:', e.message);
    res.json({ events: [], error: e.message });
  }
});

// ── k9 compare: k9 vs our trades with resolution & PnL (for copy-trade analysis) ─
app.get('/api/k9-compare', async (req, res) => {
  let slugs = (req.query.slug || req.query.slugs || '').split(/[\s,]+/).map(s => s.trim()).filter(Boolean);
  const ourWallet = (process.env.PROXY_WALLET || process.env.FUNDER_ADDRESS || '').toLowerCase();

  if (!slugs.length || slugs[0] === 'auto') {
    if (ourWallet) {
      try {
        const r = await fetch(`https://data-api.polymarket.com/trades?user=${ourWallet}&limit=200`);
        const trades = await r.json();
        slugs = [...new Set((trades || []).map(t => t.eventSlug || t.slug).filter(Boolean))].slice(0, 20);
      } catch (e) {}
    }
  }
  if (!slugs.length) return res.json({ events: [], error: 'Provide ?slug= or ?slugs= or ?slugs=auto' });
  const slugSet = slugs.slice(0, 30);

  try {
    const [{ data: k9Trades }, ourTradesFromPoly] = await Promise.all([
      supabase.from('k9_observed_trades').select('*').in('slug', slugSet).order('trade_timestamp', { ascending: true }),
      ourWallet ? fetch(`https://data-api.polymarket.com/trades?user=${ourWallet}&limit=500`).then(r => r.json()).catch(() => []) : [],
    ]);

    const ours = (ourTradesFromPoly || []).map(t => {
      const sh = parseFloat(t.size || 0);
      const pr = parseFloat(t.price || 0);
      const side = (t.side || '').toLowerCase();
      const outcome = (t.outcome || '').includes('Up') ? 'up' : 'down';
      return { slug: t.eventSlug || t.slug, direction: outcome, purchase_amount: side === 'buy' ? sh * pr : -sh * pr, shares: side === 'buy' ? sh : -sh };
    }).filter(t => t.slug);

    const resolutions = await Promise.all(slugSet.map(s => getResolution(s)));

    const events = slugSet.map((slug, i) => {
      const k9 = (k9Trades || []).filter(t => t.slug === slug);
      const our = ours.filter(t => t.slug === slug);
      const res = resolutions[i] || {};

      const k9BySide = { Up: { usdc: 0, shares: 0 }, Down: { usdc: 0, shares: 0 } };
      for (const t of k9) {
        k9BySide[t.outcome].usdc += parseFloat(t.usdc_size || 0);
        k9BySide[t.outcome].shares += parseFloat(t.shares || 0);
      }

      const ourBySide = { Up: { usdc: 0, shares: 0 }, Down: { usdc: 0, shares: 0 } };
      for (const t of our) {
        ourBySide[t.direction === 'up' ? 'Up' : 'Down'].usdc += parseFloat(t.purchase_amount || 0);
        ourBySide[t.direction === 'up' ? 'Up' : 'Down'].shares += parseFloat(t.shares || 0);
      }

      const winner = res?.winner;
      const k9Pnl = winner
        ? (winner === 'Up' ? k9BySide.Up.shares : k9BySide.Down.shares) - (k9BySide.Up.usdc + k9BySide.Down.usdc)
        : null;
      const ourPnl = winner
        ? (winner === 'Up' ? ourBySide.Up.shares : ourBySide.Down.shares) - (ourBySide.Up.usdc + ourBySide.Down.usdc)
        : null;

      const k9Total = k9BySide.Up.usdc + k9BySide.Down.usdc;
      const ourTotal = ourBySide.Up.usdc + ourBySide.Down.usdc;
      const ratio = k9Total > 0 ? (ourTotal / Math.abs(k9Total)) * 100 : null;

      return {
        slug,
        winner,
        k9: { usdc: k9Total, shares: k9BySide.Up.shares + k9BySide.Down.shares, trades: k9.length, pnl: k9Pnl },
        ours: { usdc: ourTotal, shares: ourBySide.Up.shares + ourBySide.Down.shares, trades: our.length, pnl: ourPnl },
        ratio,
      };
    });

    res.json({ events });
  } catch (e) {
    console.error('/api/k9-compare error:', e.message);
    res.json({ events: [], error: e.message });
  }
});

// ── Event detail: all k9 + our trades + P&L for a single event ────────────
app.get('/api/event-detail/:slug', async (req, res) => {
  const { slug } = req.params;
  if (!slug) return res.json({ error: 'Missing slug' });
  const ourWallet = (process.env.PROXY_WALLET || process.env.FUNDER_ADDRESS || '').toLowerCase();

  try {
    // Fetch k9 trades for this slug (paginate for large events)
    let k9Trades = [];
    let offset = 0;
    while (true) {
      const { data } = await supabase.from('k9_observed_trades')
        .select('*').eq('slug', slug).order('trade_timestamp', { ascending: true })
        .range(offset, offset + 999);
      if (!data || !data.length) break;
      k9Trades = k9Trades.concat(data);
      if (data.length < 1000) break;
      offset += 1000;
    }

    // Fetch our trades from Polymarket API
    let ourTrades = [];
    if (ourWallet) {
      try {
        const r = await fetch(`https://data-api.polymarket.com/trades?user=${ourWallet}&limit=500`);
        const poly = await r.json();
        ourTrades = (poly || []).filter(t => (t.eventSlug || t.slug) === slug).map(t => ({
          outcome: (t.outcome || '').includes('Up') ? 'Up' : 'Down',
          side: (t.side || '').toLowerCase(),
          price: parseFloat(t.price || 0),
          shares: parseFloat(t.size || 0),
          usdc: parseFloat(t.size || 0) * parseFloat(t.price || 0),
          ts: t.timestamp ? new Date(t.timestamp).getTime() / 1000 : 0,
          source: 'polymarket',
        }));
      } catch {}
    }

    // Resolution
    const resolution = await getResolution(slug);

    // Build k9 summary
    const k9Summary = {};
    for (const side of ['Up', 'Down']) {
      const kt = k9Trades.filter(t => t.outcome === side);
      const buys = kt.filter(t => parseFloat(t.shares) > 0);
      const sells = kt.filter(t => parseFloat(t.shares) < 0);
      const buyUsdc = buys.reduce((s, t) => s + parseFloat(t.usdc_size), 0);
      const buyShares = buys.reduce((s, t) => s + parseFloat(t.shares), 0);
      const sellUsdc = sells.reduce((s, t) => s + Math.abs(parseFloat(t.usdc_size)), 0);
      const sellShares = sells.reduce((s, t) => s + Math.abs(parseFloat(t.shares)), 0);
      const avgBuyPrice = buyShares > 0 ? buyUsdc / buyShares : 0;
      k9Summary[side] = {
        buyUsdc, buyShares, sellUsdc, sellShares, avgBuyPrice,
        netShares: buyShares - sellShares,
        tradeCount: kt.length,
        sellPnl: sellShares > 0 ? sellUsdc - (sellShares * avgBuyPrice) : 0,
      };
    }

    // Build our summary
    const ourSummary = {};
    for (const side of ['Up', 'Down']) {
      const ot = ourTrades.filter(t => t.outcome === side);
      const buys = ot.filter(t => t.side === 'buy');
      const sells = ot.filter(t => t.side === 'sell');
      const buyUsdc = buys.reduce((s, t) => s + t.usdc, 0);
      const buyShares = buys.reduce((s, t) => s + t.shares, 0);
      const sellUsdc = sells.reduce((s, t) => s + t.usdc, 0);
      const sellShares = sells.reduce((s, t) => s + t.shares, 0);
      const avgBuyPrice = buyShares > 0 ? buyUsdc / buyShares : 0;
      ourSummary[side] = {
        buyUsdc, buyShares, sellUsdc, sellShares, avgBuyPrice,
        netShares: buyShares - sellShares,
        tradeCount: ot.length,
        sellPnl: sellShares > 0 ? sellUsdc - (sellShares * avgBuyPrice) : 0,
      };
    }

    // P&L calculations
    const winner = resolution?.winner;
    function calcPnl(summary) {
      if (!winner) return null;
      const winSide = summary[winner] || {};
      const loseSide = summary[winner === 'Up' ? 'Down' : 'Up'] || {};
      const payout = winSide.netShares || 0;
      const totalCost = (summary.Up?.buyUsdc || 0) + (summary.Down?.buyUsdc || 0);
      const totalSellProceeds = (summary.Up?.sellUsdc || 0) + (summary.Down?.sellUsdc || 0);
      return payout + totalSellProceeds - totalCost;
    }

    // Combined feed (k9 + ours, sorted by time)
    const k9Feed = k9Trades.map(t => ({
      who: 'k9',
      outcome: t.outcome,
      side: parseFloat(t.shares) > 0 ? 'buy' : 'sell',
      price: parseFloat(t.price),
      shares: Math.abs(parseFloat(t.shares)),
      usdc: Math.abs(parseFloat(t.usdc_size)),
      ts: parseFloat(t.trade_timestamp),
    }));
    const ourFeed = ourTrades.map(t => ({
      who: 'us',
      outcome: t.outcome,
      side: t.side,
      price: t.price,
      shares: t.shares,
      usdc: t.usdc,
      ts: t.ts,
    }));
    const combinedFeed = [...k9Feed, ...ourFeed].sort((a, b) => a.ts - b.ts);

    res.json({
      slug,
      resolution,
      k9Summary,
      ourSummary,
      k9Pnl: calcPnl(k9Summary),
      ourPnl: calcPnl(ourSummary),
      k9TradeCount: k9Trades.length,
      ourTradeCount: ourTrades.length,
      feed: combinedFeed,
    });
  } catch (e) {
    console.error('/api/event-detail error:', e.message);
    res.json({ error: e.message });
  }
});

// ── WS frontend connection ─────────────────────────────────────────────────
wss.on('connection', (ws) => {
  // Send current state immediately on connect
  ws.send(JSON.stringify({ type: 'event', event: activeEvent }));
  ws.send(JSON.stringify({ type: 'prices', ...liveState }));
  ws.send(JSON.stringify({ type: 'btc', current: liveState.btcCurrent, start: liveState.btcStart }));
});

// ══════════════════════════════════════════════════════════════════════════
// k9 ON-CHAIN WATCHER (Alchemy WS — mirrors sg-onchain-watcher.py logic)
// ══════════════════════════════════════════════════════════════════════════
const K9_WALLET     = '0xd0d6053c3c37e727402d84c14069780d360993aa';
const K9_PAD        = '0x000000000000000000000000' + K9_WALLET.slice(2);
const TRANSFER_SIG  = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';
const ORDER_FILLED  = '0xd0a08e8c493f9c94f29311604c9de1b4e8c8d4c06bd0c789af57f2d65bfec0f6';
const TRANSFER_SINGLE = '0xc3d58168c5ae7397731d063d5bbf3d657854427343f4c083240f7aacaa2d0f62';
const CONDITIONAL_TOKENS = '0x4D97DCd97eC945f40cF65F87097ACe5EA0476045';
const REBATE_CONTRACT = '0xe3f18acc55091e2c48d883fc8c8413319d4ab7b0';
const ALCHEMY_WS    = `wss://polygon-mainnet.g.alchemy.com/v2/${process.env.ALCHEMY_KEY || '8kruQGYamUT6J4Ib0aMfw'}`;
const ALCHEMY_HTTP  = `https://polygon-mainnet.g.alchemy.com/v2/${process.env.ALCHEMY_KEY || '8kruQGYamUT6J4Ib0aMfw'}`;
const GAMMA_API     = 'https://gamma-api.polymarket.com/events';

const COIN_PREFIXES = [
  { prefix: 'btc-updown-15m', coin: 'btc', tf: '15m', interval: 900 },
  { prefix: 'btc-updown-5m',  coin: 'btc', tf: '5m',  interval: 300 },
];

let k9TokenMap     = {};   // BigInt(tokenId) -> { slug, outcome, coin, tf, timeframe }
let k9TokenExpiry  = 0;
let k9Pending      = {};   // txHash -> { detectedAt }
let k9SeenTx       = new Set();
const k9TxBuffer   = {};   // txHash -> [fills] — buffer to detect complete sets

// Seed k9SeenTx from Supabase so we don't re-insert after restart
async function seedK9SeenTx() {
  try {
    const { data } = await supabase.from('k9_observed_trades')
      .select('tx_hash, log_index')
      .order('id', { ascending: false }).limit(5000);
    if (data?.length) {
      for (const t of data) {
        const logIdx = t.log_index != null ? t.log_index : t.tx_hash; // fallback for old rows
        k9SeenTx.add(`${t.tx_hash}:${logIdx}`);
      }
      console.log(`[k9-watcher] Seeded dedup set with ${k9SeenTx.size} entries from Supabase`);
    }
  } catch (e) {
    console.error('[k9-watcher] seedK9SeenTx error:', e.message);
  }
}

// Generate 1h BTC event slugs: bitcoin-up-or-down-{month}-{day}-{hour}{am/pm}-et
function generate1hSlugs(nowMs) {
  const MONTHS = ['january','february','march','april','may','june','july','august','september','october','november','december'];
  const slugs = [];
  // ET = America/New_York — compute ET offset manually (EST=-5, EDT=-4)
  // Use Intl to get the correct ET hour
  const fmt = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', hour: 'numeric', hour12: true, day: 'numeric', month: 'numeric', year: 'numeric' });
  for (let delta = -1; delta <= 3; delta++) {
    const t = new Date(nowMs + delta * 3600000);
    const parts = {};
    fmt.formatToParts(t).forEach(p => { parts[p.type] = p.value; });
    const month = MONTHS[parseInt(parts.month) - 1];
    const day = parseInt(parts.day);
    const hour = parseInt(parts.hour);
    const ampm = parts.dayPeriod?.toLowerCase() || (t.getUTCHours() >= 12 ? 'pm' : 'am');
    const slug = `bitcoin-up-or-down-${month}-${day}-${hour}${ampm}-et`;
    slugs.push(slug);
  }
  return [...new Set(slugs)];
}

async function fetchTokensForSlug(slug, newMap, coin, tf) {
  try {
    const r    = await fetch(`${GAMMA_API}?slug=${slug}`);
    const data = await r.json();
    if (!data || !data.length) return;
    const market = data[0].markets?.[0];
    if (!market) return;
    const tokenIds = JSON.parse(typeof market.clobTokenIds === 'string' ? market.clobTokenIds : JSON.stringify(market.clobTokenIds));
    const outcomes = JSON.parse(typeof market.outcomes === 'string' ? market.outcomes : JSON.stringify(market.outcomes || '["Up","Down"]'));
    tokenIds.forEach((tid, idx) => {
      newMap[BigInt(tid).toString()] = {
        slug, outcome: outcomes[idx] || `token${idx}`,
        coin, tf, timeframe: `btc-updown-${tf}`,
      };
    });
  } catch (e) {
    console.error(`[k9-watcher] token fetch error for ${slug}:`, e.message);
  }
}

async function refreshK9TokenMap() {
  const now = Math.floor(Date.now() / 1000);
  const newMap = {};

  // Epoch-based events (5m, 15m)
  for (const { prefix, coin, tf, interval } of COIN_PREFIXES) {
    const lookahead = tf === '15m' ? 3 : 5;
    const base = Math.floor(now / interval) * interval;
    for (let i = 0; i < lookahead; i++) {
      const epoch = base + i * interval;
      const slug  = `${prefix}-${epoch}`;
      await fetchTokensForSlug(slug, newMap, coin, tf);
    }
  }

  // 1h events — different slug format
  const hourSlugs = generate1hSlugs(Date.now());
  for (const slug of hourSlugs) {
    await fetchTokensForSlug(slug, newMap, 'btc', '1h');
  }

  if (Object.keys(newMap).length) {
    k9TokenMap    = newMap;
    k9TokenExpiry = now + 60;
    console.log(`[k9-watcher] Token map: ${Object.keys(newMap).length} tokens loaded (incl 1h: ${hourSlugs.length} slugs)`);
  } else {
    console.warn('[k9-watcher] Token map refresh returned 0 tokens');
  }
}

async function decodeK9Receipt(txHash) {
  const resp = await fetch(ALCHEMY_HTTP, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_getTransactionReceipt', params: [txHash] }),
  });
  const { result: receipt } = await resp.json();
  if (!receipt) return null;

  const trades = [];
  for (const log of (receipt.logs || [])) {
    if (log.address?.toLowerCase() !== CTF_EXCHANGE.toLowerCase()) continue; // CTF_EXCHANGE defined at top
    const topics = log.topics || [];
    if (!topics[0] || topics[0].toLowerCase() !== ORDER_FILLED.toLowerCase()) continue;
    const data = (log.data || '0x').slice(2);
    if (data.length < 320) continue;
    const chunks = [];
    for (let i = 0; i < data.length; i += 64) chunks.push(data.slice(i, i + 64));
    try {
      const makerAsset  = BigInt('0x' + chunks[0]);
      const takerAsset  = BigInt('0x' + chunks[1]);
      const makerAmount = BigInt('0x' + chunks[2]);
      const takerAmount = BigInt('0x' + chunks[3]);

      // Only record fills where k9 is the maker or taker
      const logMaker = topics[2] ? '0x' + topics[2].slice(-40).toLowerCase() : '';
      const logTaker = topics[3] ? '0x' + topics[3].slice(-40).toLowerCase() : '';
      const k9IsMaker = logMaker === K9_WALLET.toLowerCase();
      const k9IsTaker = logTaker === K9_WALLET.toLowerCase();
      if (!k9IsMaker && !k9IsTaker) continue; // fill not involving k9

      // k9 BUYS only when k9 sends USDC:
      //   k9 is maker + makerAsset=0  → k9 sends USDC (limit buy filled)
      //   k9 is taker + takerAsset=0  → k9 sends USDC (market buy)
      let usdcSize, shares, tokenId;
      if (k9IsMaker && makerAsset === 0n) {
        usdcSize = Number(makerAmount) / 1e6;
        shares   = Number(takerAmount) / 1e6;
        tokenId  = takerAsset;
      } else if (k9IsTaker && takerAsset === 0n) {
        usdcSize = Number(takerAmount) / 1e6;
        shares   = Number(makerAmount) / 1e6;
        tokenId  = makerAsset;
      } else {
        continue; // k9 is selling or not USDC-involved — skip
      }

      const price = shares > 0 ? Math.round((usdcSize / shares) * 1e8) / 1e8 : 0;
      const info  = k9TokenMap[tokenId.toString()];
      if (!info) continue;
      trades.push({ txHash, slug: info.slug, outcome: info.outcome, price, shares, usdcSize,
                    coin: info.coin, tf: info.tf, timeframe: info.timeframe, ts: Math.floor(Date.now() / 1000) });
    } catch {}
  }
  return trades.length ? trades : null;
}

async function saveK9Trades(trades) {
  if (!trades || !trades.length) return;

  // ── K9 Copy-Trading: accumulate trades grouped by second ──
  if (k9Copy.enabled) {
    accumulateCopyTrades(trades);
  }

  // Save ALL observed trades (buys and sells)
  // Sells stored as negative shares so net position = sum of all shares
  const obsRows = trades.map(t => ({
    slug: t.slug, outcome: t.outcome, price: t.price,
    shares: t.side === 'sell' ? -t.shares : t.shares,
    usdc_size: t.side === 'sell' ? -t.usdcSize : t.usdcSize,
    tx_hash: t.txHash, trade_timestamp: t.ts,
  }));
  const { error: e1 } = await supabase.from('k9_observed_trades').insert(obsRows);
  if (e1) console.error('[k9-watcher] observed insert error:', e1.message);

  broadcast({ type: 'k9_trades', trades });
  console.log(`[k9-watcher] ${trades.map(t => `${t.side.toUpperCase()} ${t.outcome} ${t.slug} @${t.price} $${t.usdcSize.toFixed(2)}`).join(' | ')}`);
}

// ── Shared: decode an OrderFilled log into a fill object ──────────────────
function decodeOrderFilledLog(log) {
  const topics = log.topics || [];
  if (topics.length < 4) return null;

  const txHash   = log.transactionHash;
  const logMaker = '0x' + topics[2].slice(-40).toLowerCase();
  const logTaker = '0x' + topics[3].slice(-40).toLowerCase();
  if (logMaker !== K9_WALLET.toLowerCase() && logTaker !== K9_WALLET.toLowerCase()) return null;

  const data = (log.data || '0x').slice(2);
  if (data.length < 256) return null;
  const chunks = [];
  for (let i = 0; i < data.length; i += 64) chunks.push(data.slice(i, i + 64));

  const makerAsset  = BigInt('0x' + chunks[0]);
  const takerAsset  = BigInt('0x' + chunks[1]);
  const makerAmount = BigInt('0x' + chunks[2]);
  const takerAmount = BigInt('0x' + chunks[3]);

  const k9IsMaker = logMaker === K9_WALLET.toLowerCase();
  const k9IsTaker = logTaker === K9_WALLET.toLowerCase();
  let usdcSize, shares, tokenId, side;
  if (k9IsMaker && makerAsset === 0n) {
    usdcSize = Number(makerAmount) / 1e6; shares = Number(takerAmount) / 1e6;
    tokenId = takerAsset; side = 'buy';
  } else if (k9IsTaker && takerAsset === 0n) {
    usdcSize = Number(takerAmount) / 1e6; shares = Number(makerAmount) / 1e6;
    tokenId = makerAsset; side = 'buy';
  } else if (k9IsMaker && takerAsset === 0n) {
    usdcSize = Number(takerAmount) / 1e6; shares = Number(makerAmount) / 1e6;
    tokenId = makerAsset; side = 'sell';
  } else if (k9IsTaker && makerAsset === 0n) {
    usdcSize = Number(makerAmount) / 1e6; shares = Number(takerAmount) / 1e6;
    tokenId = takerAsset; side = 'sell';
  } else {
    return null;
  }

  const price = shares > 0 ? Math.round((usdcSize / shares) * 1e8) / 1e8 : 0;
  const info  = k9TokenMap[tokenId.toString()];
  if (!info) return null;

  const logIdx = log.logIndex || '0';
  const dedup = `${txHash}:${logIdx}`;
  if (k9SeenTx.has(dedup)) return null;
  k9SeenTx.add(dedup);
  if (k9SeenTx.size > 10000) k9SeenTx = new Set([...k9SeenTx].slice(-5000));

  return { txHash, logIndex: logIdx, slug: info.slug, outcome: info.outcome, side,
           price, shares, usdcSize, coin: info.coin,
           tf: info.tf, timeframe: info.timeframe, ts: Math.floor(Date.now() / 1000) };
}

// ── Decode rebate TransferSingle: ConditionalTokens → k9 from rebate contract ──
function decodeRebateTransfer(log) {
  const topics = log.topics || [];
  if (topics.length < 4) return null;
  const from = '0x' + topics[2].slice(-40).toLowerCase();
  if (from !== REBATE_CONTRACT.toLowerCase()) return null; // only rebate contract
  const to = '0x' + topics[3].slice(-40).toLowerCase();
  if (to !== K9_WALLET.toLowerCase()) return null;

  const data = (log.data || '0x').slice(2);
  if (data.length < 128) return null;
  const chunks = [];
  for (let i = 0; i < data.length; i += 64) chunks.push(data.slice(i, i + 64));

  const tokenId = BigInt('0x' + chunks[0]);
  const amount = Number(BigInt('0x' + chunks[1])) / 1e6;
  if (amount <= 0) return null;

  const info = k9TokenMap[tokenId.toString()];
  if (!info) return null;

  const txHash = log.transactionHash;
  const logIdx = log.logIndex || '0';
  const dedup = `rebate:${txHash}:${logIdx}`;
  if (k9SeenTx.has(dedup)) return null;
  k9SeenTx.add(dedup);

  return { txHash, logIndex: logIdx, slug: info.slug, outcome: info.outcome, side: 'buy',
           price: 0, shares: amount, usdcSize: 0, coin: info.coin,
           tf: info.tf, timeframe: info.timeframe, ts: Math.floor(Date.now() / 1000),
           isRebate: true };
}

// ── WS watcher (real-time, but drops events under load) ───────────────────
let k9WsRetryDelay = 2000;
function connectK9Watcher() {
  console.log('[k9-watcher] Connecting to Alchemy WS...');
  const ws = new WebSocket(ALCHEMY_WS);

  ws.on('open', async () => {
    k9WsRetryDelay = 2000;
    await refreshK9TokenMap();
    // Subscribe to OrderFilled (k9 as taker)
    ws.send(JSON.stringify({
      jsonrpc: '2.0', id: 1,
      method: 'eth_subscribe',
      params: ['logs', { address: CTF_EXCHANGE, topics: [ORDER_FILLED, null, null, K9_PAD] }],
    }));
    await new Promise(r => setTimeout(r, 300));
    // Subscribe to OrderFilled (k9 as maker)
    ws.send(JSON.stringify({
      jsonrpc: '2.0', id: 2,
      method: 'eth_subscribe',
      params: ['logs', { address: CTF_EXCHANGE, topics: [ORDER_FILLED, null, K9_PAD, null] }],
    }));
    await new Promise(r => setTimeout(r, 300));
    // Subscribe to TransferSingle on ConditionalTokens TO k9 (catches rebates)
    ws.send(JSON.stringify({
      jsonrpc: '2.0', id: 3,
      method: 'eth_subscribe',
      params: ['logs', { address: CONDITIONAL_TOKENS, topics: [TRANSFER_SINGLE, null, null, K9_PAD] }],
    }));
    console.log('[k9-watcher] Subscribed to CTF OrderFilled (maker+taker) + ConditionalTokens TransferSingle (rebates)');
    setInterval(() => {
      if (Date.now() / 1000 > k9TokenExpiry) refreshK9TokenMap();
    }, 5000);
  });

  ws.on('message', async (raw) => {
    try {
      const msg = JSON.parse(raw.toString());
      const log = msg?.params?.result;
      if (!log || log.removed) return;

      // Try OrderFilled first
      const fill = decodeOrderFilledLog(log);
      if (fill) {
        if (!k9TxBuffer[fill.txHash]) {
          k9TxBuffer[fill.txHash] = [];
          setTimeout(() => {
            const fills = k9TxBuffer[fill.txHash];
            delete k9TxBuffer[fill.txHash];
            if (fills?.length) saveK9Trades(fills);
          }, 500);
        }
        k9TxBuffer[fill.txHash].push(fill);
        return;
      }

      // Try rebate TransferSingle
      const rebate = decodeRebateTransfer(log);
      if (rebate) {
        saveK9Trades([rebate]);
        console.log(`[k9-watcher] REBATE: +${rebate.shares.toFixed(2)} ${rebate.outcome} ${rebate.slug}`);
      }
    } catch (e) {
      console.error('[k9-watcher] decode error:', e.message);
    }
  });

  ws.on('close', () => {
    console.log(`[k9-watcher] WS closed, retrying in ${k9WsRetryDelay}ms`);
    setTimeout(connectK9Watcher, k9WsRetryDelay);
    k9WsRetryDelay = Math.min(k9WsRetryDelay * 2, 30000);
  });
  ws.on('error', () => ws.close());
}

// ── HTTP poll fallback: sweep recent blocks for missed trades every 15s ───
let k9PollLastBlock = 0;
async function k9HttpPoll() {
  try {
    // Get current block number
    const blockRes = await fetch(ALCHEMY_HTTP, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_blockNumber', params: [] }),
    });
    const blockData = await blockRes.json();
    const currentBlock = parseInt(blockData.result, 16);
    if (!currentBlock) return;

    // On first run, look back ~120 blocks (~4 min on Polygon)
    const fromBlock = k9PollLastBlock ? k9PollLastBlock + 1 : currentBlock - 120;
    // k9PollLastBlock is only advanced at the end after success

    if (fromBlock > currentBlock) return;

    // Query k9 as taker
    const queryLogs = async (topics) => {
      const r = await fetch(ALCHEMY_HTTP, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          jsonrpc: '2.0', id: 1, method: 'eth_getLogs',
          params: [{ address: CTF_EXCHANGE, topics, fromBlock: '0x' + fromBlock.toString(16), toBlock: '0x' + currentBlock.toString(16) }],
        }),
      });
      const d = await r.json();
      return d.result || [];
    };

    const queryLogsAddr = async (address, topics) => {
      const r = await fetch(ALCHEMY_HTTP, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          jsonrpc: '2.0', id: 1, method: 'eth_getLogs',
          params: [{ address, topics, fromBlock: '0x' + fromBlock.toString(16), toBlock: '0x' + currentBlock.toString(16) }],
        }),
      });
      const d = await r.json();
      return d.result || [];
    };

    const [takerLogs, makerLogs, rebateLogs] = await Promise.all([
      queryLogs([ORDER_FILLED, null, null, K9_PAD]),
      queryLogs([ORDER_FILLED, null, K9_PAD, null]),
      queryLogsAddr(CONDITIONAL_TOKENS, [TRANSFER_SINGLE, null, null, K9_PAD]),
    ]);

    const allLogs = [...takerLogs, ...makerLogs];

    // Decode and collect new fills (dedup handled inside decodeOrderFilledLog)
    const fillsByTx = {};
    let newCount = 0;
    for (const log of allLogs) {
      if (log.removed) continue;
      const fill = decodeOrderFilledLog(log);
      if (!fill) continue; // already seen or unknown token
      newCount++;
      if (!fillsByTx[fill.txHash]) fillsByTx[fill.txHash] = [];
      fillsByTx[fill.txHash].push(fill);
    }

    // Decode rebate transfers
    let rebateCount = 0;
    for (const log of rebateLogs) {
      if (log.removed) continue;
      const rebate = decodeRebateTransfer(log);
      if (!rebate) continue;
      rebateCount++;
      if (!fillsByTx[rebate.txHash]) fillsByTx[rebate.txHash] = [];
      fillsByTx[rebate.txHash].push(rebate);
    }

    // Save each tx batch
    for (const [, fills] of Object.entries(fillsByTx)) {
      await saveK9Trades(fills);
    }

    // Only advance lastBlock after successful poll
    k9PollLastBlock = currentBlock;

    if (newCount > 0 || rebateCount > 0) {
      console.log(`[k9-poll] Backfilled ${newCount} fills + ${rebateCount} rebates from blocks ${fromBlock}-${currentBlock}`);
    }
  } catch (e) {
    // Don't advance k9PollLastBlock — retry same range next time
    console.error('[k9-poll] error:', e.message);
  }
}

// ── k9 Trade Monitor: compare our tracked data vs Polymarket every 60s ────
async function k9TradeMonitor() {
  try {
    // Get k9's current positions from Polymarket
    const r = await fetch(`https://data-api.polymarket.com/positions?user=${K9_WALLET}`);
    if (!r.ok) return;
    const positions = await r.json();

    // Build map of slug -> { Up: {size, totalBought}, Down: {size, totalBought} }
    const polyPos = {};
    for (const p of positions) {
      const slug = p.slug || p.eventSlug;
      if (!slug) continue;
      if (!polyPos[slug]) polyPos[slug] = {};
      polyPos[slug][p.outcome] = {
        size: p.size || 0,
        totalBought: p.totalBought || 0,
        avgPrice: p.avgPrice || 0,
        curPrice: p.curPrice || 0,
      };
    }

    // Get our tracked slugs from token map
    const trackedSlugs = new Set(Object.values(k9TokenMap).map(v => v.slug));

    // Fetch our observed trades from Supabase for these slugs
    const slugArr = [...trackedSlugs];
    if (!slugArr.length) return;

    const { data: obs } = await supabase.from('k9_observed_trades')
      .select('slug, outcome, shares, usdc_size')
      .in('slug', slugArr);

    // Aggregate our data per slug+side
    const ourData = {};
    for (const t of (obs || [])) {
      const key = t.slug;
      if (!ourData[key]) ourData[key] = { Up: { shares: 0, usdc: 0, count: 0 }, Down: { shares: 0, usdc: 0, count: 0 } };
      const side = t.outcome;
      if (!ourData[key][side]) continue;
      ourData[key][side].shares += parseFloat(t.shares);
      ourData[key][side].usdc += parseFloat(t.usdc_size);
      ourData[key][side].count++;
    }

    // Compare and log gaps
    let hasGap = false;
    for (const slug of slugArr) {
      const poly = polyPos[slug];
      const ours = ourData[slug];
      if (!poly) continue; // k9 has no position on this event

      for (const side of ['Up', 'Down']) {
        const p = poly[side];
        const o = ours?.[side];
        if (!p || p.totalBought === 0) continue;

        const polyNet = p.size;
        const ourNet = o ? o.shares : 0;
        const gap = Math.abs(polyNet - ourNet);
        const pctCaptured = polyNet > 0 ? ((ourNet / polyNet) * 100).toFixed(0) : '--';

        if (gap > 1) {
          hasGap = true;
          console.log(`[k9-monitor] GAP ${slug} ${side}: poly=${polyNet.toFixed(1)} ours=${ourNet.toFixed(1)} (${pctCaptured}% captured, gap=${gap.toFixed(1)} shares)`);
        }
      }
    }
    if (!hasGap) {
      console.log(`[k9-monitor] OK — all ${slugArr.length} tracked slugs match Polymarket positions`);
    }
  } catch (e) {
    console.error('[k9-monitor] error:', e.message);
  }
}

// ── Start ──────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3001;
server.listen(PORT, async () => {
  console.log(`SuperTrader server running on http://localhost:${PORT}`);
  await initClobClient();
  await ensureAllowance();
  await refreshEvent();
  connectBtcStream();
  connectBinanceStream();
  startPricePoll();
  scheduleNextEvent();
  const splitReady = !!FUNDER_ADDRESS && !!process.env.PRIVATE_KEY;
  const scriptExists = fs.existsSync(SPLIT_SCRIPT);
  console.log(`[SPLIT] autoSplit=${autoSplit.enabled ? 'ON' : 'OFF'}, amount=$${autoSplit.amount}, ready=${splitReady}, script=${scriptExists}`);
  await seedK9SeenTx();
  await loadK9CopyState();
  connectK9Watcher();
  // HTTP poll fallback: catch missed WS events every 15s
  setTimeout(k9HttpPoll, 5000); // first poll after 5s
  setInterval(k9HttpPoll, 15000);
  // Monitor k9 trades vs Polymarket every 60s
  setTimeout(k9TradeMonitor, 20000);
  setInterval(k9TradeMonitor, 60000);
});
