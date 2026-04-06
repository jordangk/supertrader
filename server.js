import 'dotenv/config';

// Prevent unhandled WS/stream errors from crashing the process
process.on('uncaughtException', (err) => {
  console.error('[UNCAUGHT]', err.message);
});
process.on('unhandledRejection', (err) => {
  console.error('[UNHANDLED]', err?.message || err);
});

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
import { registerArbitrageRoutes } from './lib/arbitrageRoutes.mjs';
import { startAutoRedeem } from './scripts/auto-redeem-poly.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const K9_COPY_STATE_FILE = path.join(__dirname, '.k9-copy-state.json');

// ── Trade file logger ────────────────────────────────────────────────────
const TRADE_LOG_FILE = path.join(__dirname, 'trade-log.jsonl');
function logTrade(strategy, action, data) {
  const entry = { ts: new Date().toISOString(), strategy, action, ...data };
  fs.appendFileSync(TRADE_LOG_FILE, JSON.stringify(entry) + '\n');
  console.log(`[TRADE-LOG] ${strategy} ${action}:`, JSON.stringify(data));
}

const app = express();
const server = createServer(app);
const wss = new WebSocketServer({ server });

app.use(cors());
app.use(express.json());
registerArbitrageRoutes(app, { getClobClient: () => clobClient });

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

    // Use env CLOB credentials if available, otherwise derive
    let creds;
    if (process.env.CLOB_API_KEY && process.env.CLOB_SECRET && process.env.CLOB_PASSPHRASE) {
      creds = { key: process.env.CLOB_API_KEY, secret: process.env.CLOB_SECRET, passphrase: process.env.CLOB_PASSPHRASE };
      console.log('[CLOB] Using env API key:', creds.key);
    } else {
      const tempClient = new ClobClient(
        'https://clob.polymarket.com',
        CHAIN_ID,
        wallet,
      );
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
    // Start auto-redeem for resolved Polymarket positions (every 60s)
    startAutoRedeem(60000);
  } catch (e) {
    console.error('[CLOB] Failed to init client:', e.message);
  }
}

// ── USDC Allowance Check (funder = Safe that holds USDC) ──────────────────
const POLYGON_RPC = `https://polygon-mainnet.g.alchemy.com/v2/${process.env.ALCHEMY_KEY || '8kruQGYamUT6J4Ib0aMfw'}`;
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

// ── ETH parallel event tracking (uses BTC price for EMA, ETH event for prices) ──
let ethEvent = null;
let ethClobWs = null;
let liveStateEth = {
  upPrice: null, downPrice: null,
  upStartPrice: null, downStartPrice: null,
  eventSlug: null, eventTitle: null,
  tokenUp: null, tokenDown: null,
};

// ── ETH velocity strategy: BTC $10 in <1s → buy ETH, hedge 3s later ──
const ETH_VEL_THRESHOLD = 10;      // $10 single-tick move
let _ethPrevBtcPrice = null;        // previous Binance BTC tick price
let autoEth = {
  enabled: false,
  busy: false,
  priceMin: 30,
  priceMax: 90,
  shares: 5,
  cooldownMs: 4000,
  lastTriggerTime: 0,
  phase: null,       // null | 'entered' | 'hedging'
  entrySide: null,
  entryPrice: null,
  entryTime: null,
  hedgeTimer: null,
  log: [],
};

function checkEthVelocityTrigger() {
  if (!autoEth.enabled) return;

  // Phase: watching — after entry, check each BTC tick for reversal
  if (autoEth.phase === 'watching') {
    const btcNow = liveState.binanceBtc;
    if (btcNow != null && autoEth.watchPrevPrice != null) {
      const tickDir = btcNow - autoEth.watchPrevPrice;
      autoEth.watchPrevPrice = btcNow;
      // Same direction = hold, opposite or flat = hedge
      const sameDir = (autoEth.entryDirection > 0 && tickDir > 0) || (autoEth.entryDirection < 0 && tickDir < 0);
      if (!sameDir) {
        console.log(`[ETH-VEL] BTC tick reversed (${tickDir >= 0 ? '+' : ''}${tickDir.toFixed(2)}) — hedging at 99¢`);
        autoEth.phase = 'hedging';
        fireEthHedge();
      }
    }
    return;
  }

  if (autoEth.busy) return;
  if (!ethEvent || !clobClient) return;
  const now = Date.now();
  if (now - autoEth.lastTriggerTime < autoEth.cooldownMs) return;

  const btcNow = liveState.binanceBtc;
  if (!btcNow) return;

  // Single-tick trigger: compare to previous Binance tick
  const prevPrice = _ethPrevBtcPrice;
  _ethPrevBtcPrice = btcNow;
  if (prevPrice == null) return;

  const velocity = btcNow - prevPrice;
  const absVelocity = Math.abs(velocity);

  if (absVelocity < ETH_VEL_THRESHOLD) return;

  // BTC up → ETH up, BTC down → ETH down
  const winSide = velocity > 0 ? 'up' : 'down';
  const winPrice = winSide === 'up' ? liveStateEth.upPrice : liveStateEth.downPrice;
  const winCents = (winPrice ?? 0) * 100;

  if (winPrice == null || winCents < autoEth.priceMin || winCents > autoEth.priceMax) return;

  console.log(`[ETH-VEL] Trigger — BTC single tick $${velocity.toFixed(1)} → ETH ${winSide.toUpperCase()} @ ${winCents.toFixed(0)}¢`);
  autoEth.busy = true;
  autoEth.lastTriggerTime = now;
  autoEth.log = [{ ts: now, side: winSide, velocity, entryPrice: null, hedgePrice: null, profit: null, result: 'pending' }, ...autoEth.log].slice(0, 20);
  broadcast({ type: 'eth_auto', status: 'triggered', side: winSide, velocity });
  fireEthEntry(winSide);
}

// Post entry at market (ask). If not filled in 10s, cancel and repost at ask+20¢ to force.
async function fireEthEntry(side) {
  if (!clobClient || !ethEvent) { _ethAbort('no_client'); return; }

  const tokenId = side === 'up' ? liveStateEth.tokenUp : liveStateEth.tokenDown;
  if (!tokenId) { _ethAbort('no_token'); return; }

  const tickSize = ethEvent.tickSize || '0.01';
  const tick = typeof tickSize === 'string' ? parseFloat(tickSize) : tickSize;
  const negRisk = ethEvent.negRisk || false;

  try {
    const mkt = await fetchClobBidAsk(tokenId);
    const askPrice = mkt.bestAsk ?? (side === 'up' ? liveStateEth.upPrice : liveStateEth.downPrice);
    if (!askPrice || askPrice <= 0) { _ethAbort('no_price'); return; }

    // Entry at market (ask price)
    const buyPrice = Math.max(0.01, Math.min(Math.round(askPrice / tick) * tick, 0.99));

    console.log(`[ETH-VEL] Entry: BUY ${side.toUpperCase()} ${autoEth.shares}sh @ ${(buyPrice*100).toFixed(0)}¢ (ask)`);
    logTrade('eth-vel', 'entry', { side, buyPrice, shares: autoEth.shares, eventSlug: liveStateEth.eventSlug });
    const signed = await clobClient.createOrder({ tokenID: tokenId, price: buyPrice, size: autoEth.shares, side: 'BUY' }, { tickSize: String(tick), negRisk });
    const result = await clobClient.postOrder(signed, 'GTC');
    const ok = result?.success || result?.status === 'matched' || result?.status === 'live';
    const orderId = result?.orderID ?? result?.order_id;

    if (!ok) { console.log('[ETH-VEL] Entry failed:', JSON.stringify(result)); _ethAbort('order_failed'); return; }

    autoEth.entrySide = side;
    autoEth.entryPrice = buyPrice;
    autoEth.entryOrderId = orderId;

    autoEth.phase = 'watching';  // wait for next BTC tick to decide hedge
    autoEth.entryTime = Date.now();
    autoEth.entryDirection = side === 'up' ? 1 : -1; // +1 = BTC was going up, -1 = down
    autoEth.watchPrevPrice = liveState.binanceBtc;    // snapshot current BTC price
    if (autoEth.log.length > 0) { autoEth.log[0].entryPrice = buyPrice; autoEth.log[0].result = 'entered'; }
    console.log(`[ETH-VEL] Entry posted @ ${(buyPrice*100).toFixed(0)}¢ — watching BTC ticks, hedge on reversal`);
    broadcast({ type: 'eth_auto', status: 'entered', side, buyPrice });

  } catch (e) {
    console.error('[ETH-VEL] Entry error:', e?.message);
    _ethAbort();
  }
}

// Hedge: always buy opposite at 99¢ to force immediate fill
async function fireEthHedge() {
  if (!clobClient || !ethEvent) { _ethAbort(); return; }

  const oppSide = autoEth.entrySide === 'up' ? 'down' : 'up';
  const tokenId = oppSide === 'up' ? liveStateEth.tokenUp : liveStateEth.tokenDown;
  if (!tokenId) { _ethAbort(); return; }

  const tickSize = ethEvent.tickSize || '0.01';
  const tick = typeof tickSize === 'string' ? parseFloat(tickSize) : tickSize;
  const negRisk = ethEvent.negRisk || false;

  try {
    const hedgePrice = 0.99; // force fill
    const totalCost = Math.round((autoEth.entryPrice + hedgePrice) * 100);
    const profitCents = 100 - totalCost;

    console.log(`[ETH-VEL] Hedge: BUY ${oppSide.toUpperCase()} ${autoEth.shares}sh @ 99¢ (force, entry ${(autoEth.entryPrice*100).toFixed(0)}¢, ${profitCents >= 0 ? '+' : ''}${profitCents}¢)`);
    logTrade('eth-vel', 'hedge', { side: oppSide, buyPrice: hedgePrice, shares: autoEth.shares, entryPrice: autoEth.entryPrice, profitCents, eventSlug: liveStateEth.eventSlug });
    const signed = await clobClient.createOrder({ tokenID: tokenId, price: hedgePrice, size: autoEth.shares, side: 'BUY' }, { tickSize: String(tick), negRisk });
    const result = await clobClient.postOrder(signed, 'GTC');
    const ok = result?.success || result?.status === 'matched' || result?.status === 'live';

    if (!ok) { console.log('[ETH-VEL] Hedge failed:', JSON.stringify(result)); _ethAbort(); return; }

    console.log(`[ETH-VEL] Hedged @ 99¢ — ${profitCents >= 0 ? '+' : ''}${profitCents}¢`);
    if (autoEth.log.length > 0) {
      autoEth.log[0].hedgePrice = hedgePrice;
      autoEth.log[0].profit = profitCents;
      autoEth.log[0].result = `hedge ${profitCents >= 0 ? '+' : ''}${profitCents}¢`;
    }
    broadcast({ type: 'eth_auto', status: 'hedged', side: oppSide, hedgePrice, profitCents });
    _ethAbort();

  } catch (e) {
    console.error('[ETH-VEL] Hedge error:', e?.message);
    _ethAbort();
  }
}

function _ethAbort(reason) {
  if (reason) console.log(`[ETH-VEL] Abort: ${reason}`);
  autoEth.busy = false;
  autoEth.phase = null;
  autoEth.entrySide = null;
  autoEth.entryPrice = null;
  if (autoEth.hedgeTimer) { clearTimeout(autoEth.hedgeTimer); autoEth.hedgeTimer = null; }
}

// ── Auto-ETH-EMA: same BTC EMA trigger, but trades ETH Polymarket tokens ──
let autoEthEma = {
  enabled: false,
  shares: 5,
  gapOpenThreshold: 5,
  priceMin: 30,
  priceMax: 55,
  maxHedgeWaitMs: 30_000,
  cooldownMs: 0,
  busy: false,
  phase: null,
  entrySide: null,
  entryOrderId: null,
  hedgeOrderId: null,
  takeProfitOrderId: null,
  entryPrice: null,
  entryTime: null,
  oppPriceAtEntry: null,
  stopLossOppPrice: null,
  peakGap: 0,
  peakProfit: 0,
  btcAtEntry: null,
  btcPeak: null,
  lastTriggerTime: 0,
  lastHedgeTime: 0,
  lastEntrySide: null,
  log: [],
};

function _autoEthEmaAbort(reason) {
  if (clobClient) {
    if (autoEthEma.takeProfitOrderId) clobClient.cancelOrder({ orderID: autoEthEma.takeProfitOrderId }).catch(() => {});
    if (autoEthEma.entryOrderId) clobClient.cancelOrder({ orderID: autoEthEma.entryOrderId }).catch(() => {});
  }
  if (reason && autoEthEma.log.length > 0 && autoEthEma.log[0].result === 'pending') {
    autoEthEma.log[0].result = reason;
  }
  autoEthEma.takeProfitPrice = null;
  autoEthEma.lastTriggerTime = Date.now();
  autoEthEma.busy = false;
  autoEthEma.phase = null;
  autoEthEma.entrySide = null;
  autoEthEma.entryOrderId = null;
  autoEthEma.hedgeOrderId = null;
  autoEthEma.takeProfitOrderId = null;
  autoEthEma.entryPrice = null;
  autoEthEma.entryTime = null;
  autoEthEma.oppPriceAtEntry = null;
  autoEthEma.stopLossOppPrice = null;
  autoEthEma.peakGap = 0;
  autoEthEma.btcAtEntry = null;
  autoEthEma.btcPeak = null;
  autoEthEma.entryFillTime = null;
  autoEthEma.peakProfit = 0;
}

let _lastEthEmaDebug = 0;
function checkEthEmaTrigger(btcEmaCrossed, fGap) {
  if (!autoEthEma.enabled || autoEthEma.busy) return;
  if (!ethEvent || !clobClient) return;
  if (Date.now() - autoEthEma.lastTriggerTime < 4_000) return; // 4s cooldown

  const now = Date.now();
  const fHist = serverEma.fHistogram ?? 0;

  const winSide = fGap > 0 ? 'up' : 'down';
  const winPrice = winSide === 'up' ? liveStateEth.upPrice : liveStateEth.downPrice;
  const winCents = (winPrice ?? 0) * 100;

  // Debug log every 10s
  if (now - _lastEthEmaDebug > 10_000) {
    _lastEthEmaDebug = now;
    console.log(`[ETH-EMA-DBG] btcGap=$${fGap.toFixed(1)} hist=${fHist.toFixed(2)} ethWin=${winCents.toFixed(0)}¢ (${autoEthEma.priceMin}-${autoEthEma.priceMax})`);
  }

  // Same convergence trigger as BTC: gap near zero + closing fast
  const absGap = Math.abs(fGap);
  if (absGap > EMA_GAP_NEAR_THRESHOLD) return; // not close enough
  const gapFrom3sAgo = _emaGapHistory.length > 0 ? _emaGapHistory[0].gap : fGap;
  const gapNarrow = Math.abs(gapFrom3sAgo) - absGap;
  if (gapNarrow < EMA_GAP_FROM_THRESHOLD) return; // hasn't narrowed fast enough

  // Side: approaching cross = about to flip
  const winSideAdj = fGap > 0 ? 'down' : 'up';
  const winPriceAdj = winSideAdj === 'up' ? liveStateEth.upPrice : liveStateEth.downPrice;
  const winCentsAdj = (winPriceAdj ?? 0) * 100;

  // Price must be in range
  if (winPriceAdj == null) return;
  if (winCentsAdj < autoEthEma.priceMin || winCentsAdj > autoEthEma.priceMax) return;

  console.log(`[ETH-EMA] Trigger — ${winSideAdj.toUpperCase()}, gap=$${fGap.toFixed(1)} (was $${gapFrom3sAgo.toFixed(1)} 3s ago, narrowed $${gapNarrow.toFixed(1)}), winning=${winCentsAdj.toFixed(0)}¢`);
  logTrade('eth-ema', 'trigger', { side: winSideAdj, winCents: winCentsAdj, gap: fGap, gapNarrow, ethUp: liveStateEth.upPrice, ethDown: liveStateEth.downPrice });
  autoEthEma.busy = true;
  autoEthEma.lastTriggerTime = now;
  autoEthEma.log = [{ ts: now, side: winSideAdj, triggerGap: fGap, gapNarrow, fHist, entryPrice: null, entryFillTime: null, hedgePrice: null, hedgeReason: null, hedgeTime: null, peakGap: 0, tpPrice: null, profit: null, result: 'pending' }, ...autoEthEma.log].slice(0, 20);
  broadcast({ type: 'auto_eth_ema', status: 'triggered', side: winSideAdj, gap: fGap, gapNarrow });
  fireEthEmaEntry(winSideAdj);
}

async function fireEthEmaEntry(side) {
  if (!clobClient || !ethEvent) { _autoEthEmaAbort('no_client'); return; }

  const tokenId = side === 'up' ? liveStateEth.tokenUp : liveStateEth.tokenDown;
  if (!tokenId) { _autoEthEmaAbort('no_token'); return; }

  const tickSize = ethEvent.tickSize || '0.01';
  const tick = typeof tickSize === 'string' ? parseFloat(tickSize) : tickSize;
  const negRisk = ethEvent.negRisk || false;
  const sizeShares = 5;

  try {
    const mkt = await fetchClobBidAsk(tokenId);
    const marketPrice = mkt.bestAsk ?? (side === 'up' ? liveStateEth.upPrice : liveStateEth.downPrice);
    if (!marketPrice || marketPrice <= 0) { _autoEthEmaAbort('no_market_price'); return; }

    const buyPrice = Math.max(0.01, Math.min(Math.round((marketPrice + 0.03) / tick) * tick, 0.99));

    console.log(`[ETH-EMA] Entry: FAK BUY ${side.toUpperCase()} ${sizeShares}sh @ ${(buyPrice*100).toFixed(0)}¢ (ask ${(marketPrice*100).toFixed(0)}¢ +3¢)`);
    const signedOrder = await clobClient.createOrder({ tokenID: tokenId, price: buyPrice, size: sizeShares, side: 'BUY' }, { tickSize: String(tick), negRisk });
    const result = await clobClient.postOrder(signedOrder, 'FAK');
    const ok = result?.success || result?.status === 'matched';
    const orderId = result?.orderID ?? result?.order_id;

    if (!ok) {
      console.log('[ETH-EMA] Entry FAK didn\'t fill:', JSON.stringify(result));
      _autoEthEmaAbort('fak_no_fill');
      return;
    }

    console.log(`[ETH-EMA] Entry result: status=${result?.status}, orderId=${orderId}`);

    const oppAskNow = side === 'up' ? liveStateEth.downPrice : liveStateEth.upPrice;
    const stopLossOppPrice = (100 + 5 - Math.round(buyPrice * 100)) / 100;

    autoEthEma.phase = 'entered';
    autoEthEma.entrySide = side;
    autoEthEma.lastEntrySide = side;
    autoEthEma.entryOrderId = orderId;
    autoEthEma.entryPrice = buyPrice;
    autoEthEma.totalShares = sizeShares;
    autoEthEma.hedgedShares = 0;
    autoEthEma.entryTime = Date.now();
    autoEthEma.entryFillTime = Date.now();
    autoEthEma.oppPriceAtEntry = oppAskNow;
    autoEthEma.stopLossOppPrice = stopLossOppPrice;
    autoEthEma.peakGap = Math.abs((serverEma.fE12 ?? 0) - (serverEma.fE26 ?? 0));
    autoEthEma.btcAtEntry = liveState.binanceBtc;
    autoEthEma.btcPeak = liveState.binanceBtc;
    autoEthEma.peakProfit = 0;

    console.log(`[ETH-EMA] Stop loss locked: opp now=${(oppAskNow*100).toFixed(0)}¢, stop if opp ≥ ${(stopLossOppPrice*100).toFixed(0)}¢ (= -5¢ loss)`);

    // DB insert
    supabase.from('polymarket_trades').insert({
      polymarket_event_id: null, direction: side,
      purchase_price: buyPrice, purchase_amount: Math.round(sizeShares * buyPrice * 100) / 100,
      purchase_time: new Date().toISOString(), minute: Math.floor(Date.now() / 60000),
      btc_price_at_purchase: liveState.binanceBtc, order_type: 'live',
      order_status: 'open', polymarket_order_id: orderId, shares: sizeShares,
      notes: JSON.stringify({ type: 'auto-eth-ema-entry', side, buyPrice, gap: (serverEma.fE12 ?? 0) - (serverEma.fE26 ?? 0), eventSlug: liveStateEth.eventSlug, histogram: serverEma.fHistogram, e12: serverEma.fE12, e26: serverEma.fE26 }),
    }).then(({ error: dbErr }) => { if (dbErr) console.error('[ETH-EMA] DB error:', dbErr); });

    broadcast({ type: 'auto_eth_ema', status: 'entered', side, buyPrice, gap: (serverEma.fE12 ?? 0) - (serverEma.fE26 ?? 0) });
    if (autoEthEma.log.length > 0) {
      autoEthEma.log[0].entryPrice = buyPrice;
      autoEthEma.log[0].entryFillTime = Date.now();
      autoEthEma.log[0].result = 'entered';
    }
    console.log(`[ETH-EMA] ENTERED @ ${(buyPrice*100).toFixed(0)}¢ — hedge all on EMA cross back or gap $6`);
    logTrade('eth-ema', 'entry', { side, buyPrice, shares: sizeShares, gap: (serverEma.fE12??0)-(serverEma.fE26??0), orderId, eventSlug: liveStateEth.eventSlug });
  } catch (e) {
    console.error('[ETH-EMA] Entry error:', e?.message ?? e);
    _autoEthEmaAbort();
  }
}

function checkEthEmaHedge() {
  if (!autoEthEma.enabled || !autoEthEma.busy || autoEthEma.phase !== 'entered') return;
  if (!ethEvent || !clobClient) return;

  // Use BTC EMA (serverEma)
  const fGap = (serverEma.fE12 ?? 0) - (serverEma.fE26 ?? 0);
  const absFGap = Math.abs(fGap);
  autoEthEma.peakGap = Math.max(autoEthEma.peakGap, absFGap);

  const oppPrice = autoEthEma.entrySide === 'up' ? liveStateEth.downPrice : liveStateEth.upPrice;
  if (oppPrice == null || autoEthEma.entryPrice == null) return;
  const totalCostCents = Math.round((autoEthEma.entryPrice + oppPrice) * 100);
  const profitCents = 100 - totalCostCents;
  autoEthEma.peakProfit = Math.max(autoEthEma.peakProfit, profitCents);

  const totalShares = autoEthEma.totalShares || 5;

  // 1. EMA gap reaches $6: take profit
  if (absFGap >= 6) {
    const reason = `ema_gap_6(${profitCents}¢, gap=$${fGap.toFixed(1)})`;
    console.log(`[ETH-EMA] EMA GAP $6 — hedge all ${totalShares}sh, profit=${profitCents}¢, gap=$${fGap.toFixed(1)}`);
    _logEthEmaHedge(reason);
    autoEthEma.phase = 'hedging';
    fireEthEmaExit(reason, totalShares, true);
    return;
  }

  // 2. EMA crosses back
  const crossedBack = (autoEthEma.entrySide === 'up' && fGap < 0) ||
                      (autoEthEma.entrySide === 'down' && fGap > 0);
  if (crossedBack) {
    const reason = `ema_cross_back(${profitCents}¢, gap=$${fGap.toFixed(1)})`;
    console.log(`[ETH-EMA] EMA CROSS BACK — hedge all ${totalShares}sh, profit=${profitCents}¢, gap=$${fGap.toFixed(1)}`);
    _logEthEmaHedge(reason);
    autoEthEma.phase = 'hedging';
    fireEthEmaExit(reason, totalShares, true);
    return;
  }
}

function _logEthEmaHedge(reason) {
  if (autoEthEma.log.length > 0) {
    autoEthEma.log[0].hedgeReason = reason;
    autoEthEma.log[0].hedgeTime = Date.now();
    autoEthEma.log[0].peakGap = autoEthEma.peakGap;
    autoEthEma.log[0].peakProfit = autoEthEma.peakProfit;
  }
}

async function fireEthEmaExit(reason, sharesToHedge, isFinal) {
  if (!clobClient || !ethEvent) { _autoEthEmaAbort(); return; }

  const oppSide = autoEthEma.entrySide === 'up' ? 'down' : 'up';
  const tokenId = oppSide === 'up' ? liveStateEth.tokenUp : liveStateEth.tokenDown;
  if (!tokenId) { _autoEthEmaAbort(); return; }

  const tickSize = ethEvent.tickSize || '0.01';
  const tick = typeof tickSize === 'string' ? parseFloat(tickSize) : tickSize;
  const negRisk = ethEvent.negRisk || false;

  try {
    const mkt = await fetchClobBidAsk(tokenId);
    const marketPrice = mkt.bestAsk ?? (oppSide === 'up' ? liveStateEth.upPrice : liveStateEth.downPrice);
    if (!marketPrice || marketPrice <= 0) { _autoEthEmaAbort(); return; }

    const buyPrice = Math.max(0.01, Math.min(Math.round((marketPrice - 0.01) / tick) * tick, 0.99));
    const totalCost = Math.round((autoEthEma.entryPrice + buyPrice) * 100);
    const profitCents = 100 - totalCost;

    const totalShares = autoEthEma.totalShares || 5;
    const rideShares = isFinal ? 0 : totalShares - sharesToHedge - (autoEthEma.hedgedShares || 0);

    console.log(`[ETH-EMA] HEDGE: GTC BUY ${oppSide.toUpperCase()} ${sharesToHedge}sh @ ${(buyPrice*100).toFixed(0)}¢ (ask ${(marketPrice*100).toFixed(0)}¢ -1¢, entry ${(autoEthEma.entryPrice*100).toFixed(0)}¢, ${profitCents >= 0 ? '+' : ''}${profitCents}¢, reason=${reason})`);
    logTrade('eth-ema', 'hedge', { side: oppSide, buyPrice, shares: sharesToHedge, entryPrice: autoEthEma.entryPrice, totalCost, profitCents, reason, eventSlug: liveStateEth.eventSlug });

    const signedOrder = await clobClient.createOrder({ tokenID: tokenId, price: buyPrice, size: sharesToHedge, side: 'BUY' }, { tickSize: String(tick), negRisk });
    const result = await clobClient.postOrder(signedOrder, 'GTC');
    const ok = result?.success || result?.status === 'matched' || result?.status === 'live';
    const orderId = result?.orderID ?? result?.order_id;

    console.log(`[ETH-EMA] Hedge result: status=${result?.status}, orderId=${orderId}`);
    if (!ok) {
      console.log('[ETH-EMA] Hedge order failed, retrying in 2s:', JSON.stringify(result));
      await new Promise(r => setTimeout(r, 2000));
      return fireEthEmaExit(reason, sharesToHedge, isFinal);
    }

    // If resting (not filled immediately), wait 10s then cancel and FAK at current ask+3¢
    if (result?.status === 'live' && orderId) {
      console.log(`[ETH-EMA] Hedge resting — will force FAK +3¢ in 10s`);
      await new Promise(resolve => setTimeout(resolve, 10_000));
      try {
        await clobClient.cancelOrder({ orderID: orderId });
      } catch (e) { console.log(`[ETH-EMA] Cancel error (continuing): ${e?.message}`); }
      // Retry FAK until filled
      for (let attempt = 1; attempt <= 5; attempt++) {
        try {
          const freshMkt = await fetchClobBidAsk(tokenId);
          const freshAsk = freshMkt.bestAsk ?? (oppSide === 'up' ? liveStateEth.upPrice : liveStateEth.downPrice);
          const fakPrice = Math.max(0.01, Math.min(Math.round((freshAsk + 0.03) / tick) * tick, 0.99));
          console.log(`[ETH-EMA] Hedge force #${attempt}: FAK BUY ${oppSide.toUpperCase()} ${sharesToHedge}sh @ ${(fakPrice*100).toFixed(0)}¢ (ask ${(freshAsk*100).toFixed(0)}¢ +3¢)`);
          const fakSigned = await clobClient.createOrder({ tokenID: tokenId, price: fakPrice, size: sharesToHedge, side: 'BUY' }, { tickSize: String(tick), negRisk });
          const fakResult = await clobClient.postOrder(fakSigned, 'FAK');
          const fakOk = fakResult?.success || fakResult?.status === 'matched';
          logTrade('eth-ema', 'hedge-fak', { side: oppSide, price: fakPrice, shares: sharesToHedge, reason: `10s_force_#${attempt}` });
          if (fakOk) break;
          console.log(`[ETH-EMA] Force FAK #${attempt} didn't fill, retrying in 3s...`);
          if (attempt < 5) await new Promise(r => setTimeout(r, 3000));
        } catch (e) {
          console.log(`[ETH-EMA] Force hedge #${attempt} error: ${e?.message}`);
          if (attempt < 5) await new Promise(r => setTimeout(r, 3000));
        }
      }
    }

    autoEthEma.hedgedShares = (autoEthEma.hedgedShares || 0) + sharesToHedge;

    if (autoEthEma.log.length > 0) {
      autoEthEma.log[0].hedgePrice = buyPrice;
      autoEthEma.log[0].profit = profitCents;
      autoEthEma.log[0].hedgedShares = autoEthEma.hedgedShares;
      autoEthEma.log[0].rideShares = isFinal ? 0 : rideShares;
      autoEthEma.log[0].result = isFinal
        ? `hedge ALL ${profitCents >= 0 ? '+' : ''}${profitCents}¢`
        : `hedge ${sharesToHedge}sh ${profitCents >= 0 ? '+' : ''}${profitCents}¢, ride ${rideShares}sh`;
    }

    // DB insert
    supabase.from('polymarket_trades').insert({
      polymarket_event_id: null, direction: oppSide,
      purchase_price: buyPrice, purchase_amount: Math.round(sharesToHedge * buyPrice * 100) / 100,
      purchase_time: new Date().toISOString(), minute: Math.floor(Date.now() / 60000),
      btc_price_at_purchase: liveState.binanceBtc, order_type: 'live',
      order_status: 'open', polymarket_order_id: orderId, shares: sharesToHedge,
      notes: JSON.stringify({ type: isFinal ? 'auto-eth-ema-hedge' : 'auto-eth-ema-hedge-partial', side: oppSide, buyPrice, sharesToHedge, rideShares, entryPrice: autoEthEma.entryPrice, entrySide: autoEthEma.entrySide, profitCents, peakProfit: autoEthEma.peakProfit, reason, eventSlug: liveStateEth.eventSlug, gap: (serverEma.fE12 ?? 0) - (serverEma.fE26 ?? 0), peakGap: autoEthEma.peakGap, histogram: serverEma.fHistogram }),
    }).then(({ error: dbErr }) => { if (dbErr) console.error('[ETH-EMA] DB error:', dbErr); });

    broadcast({ type: 'auto_eth_ema', status: isFinal ? 'hedged_all' : 'hedged_half', side: oppSide, buyPrice, profitCents, sharesToHedge, rideShares });
    autoEthEma.lastHedgeTime = Date.now();

    if (isFinal) {
      _autoEthEmaAbort();
    } else {
      autoEthEma.phase = 'entered';
      autoEthEma.busy = true;
    }

  } catch (e) {
    console.error('[ETH-EMA] Hedge error, retrying in 3s:', e?.message ?? e);
    await new Promise(r => setTimeout(r, 3000));
    return fireEthEmaExit(reason, sharesToHedge, isFinal);
  }
}

// ── Auto-scalp on BTC $5 move (Binance stream) ─────────────────────────────
let autoScalp = {
  enabled: false,
  threshold: 5,        // $5 BTC move
  profitCents: 2,      // scalp with 2¢ profit
  shares: 5,           // shares per scalp
  winningPriceMin: 30, // only trigger when winning side 30–60¢
  winningPriceMax: 60,
  cooldownSeconds: 15,
  lastTriggerPrice: null,
  lastTriggerTime: 0,
  busy: false,         // single global lock — 1 active trade at a time
  upOrderId: null,
  downOrderId: null,
  unhedged: null,
  // Keep sides for API compat but use global busy
  sides: {
    up:   { firing: false, inFlight: false, needsHedge: false, unhedged: null, hedgeOrderId: null, mainOrderId: null },
    down: { firing: false, inFlight: false, needsHedge: false, unhedged: null, hedgeOrderId: null, mainOrderId: null },
  },
  log: [],
};
let autoScalpLastDiagLog = 0;

// ── Auto-flow: triggers on smooth directional price movement (low volatility trend) ──
let autoFlow = {
  enabled: false,
  shares: 5,
  windowSecs: 60,        // look at last 60s of ticks
  monotonicity: 0.70,    // 70%+ of ticks flat or with-trend (smooth drift)
  minMoveCents: 2,       // price must have moved at least 2¢ over the window
  maxReversalPct: 0.30,  // max 30% of ticks can be against the trend
  priceMin: 30,          // only when trending side is 30–60¢
  priceMax: 60,
  busy: false,           // single global lock — 1 active trade at a time
  upOrderId: null,
  downOrderId: null,
  unhedged: null,
  sides: {
    up:   { firing: false, inFlight: false, needsHedge: false, unhedged: null, hedgeOrderId: null, mainOrderId: null },
    down: { firing: false, inFlight: false, needsHedge: false, unhedged: null, hedgeOrderId: null, mainOrderId: null },
  },
  log: [],
  lastTriggerTime: { up: 0, down: 0 },
  cooldownMs: 30_000,
};

// ── Auto-Lost: on each new event, place GTC BUY@2¢ + GTC SELL@7¢ on chosen side ──
let autoLost = {
  enabled: false,
  side: 'down',         // 'up' | 'down' | 'both'
  shares: 10,
  buyPrice: 0.02,
  sellPrice: 0.07,
  buyOrderIds: [],      // track placed buy order IDs
  sellOrderIds: [],     // track placed sell order IDs
  lastEventSlug: null,  // prevent duplicate fires on same event
  log: [],              // recent results
};

async function fireAutoLost() {
  if (!autoLost.enabled || !clobClient || !activeEvent) return;
  if (autoLost.lastEventSlug === activeEvent.slug) return; // already fired for this event
  autoLost.lastEventSlug = activeEvent.slug;

  const sides = autoLost.side === 'both' ? ['up', 'down'] : [autoLost.side];
  const tickSize = activeEvent.tickSize || '0.01';
  const negRisk = activeEvent.negRisk || false;

  for (const s of sides) {
    const tokenId = s === 'up' ? liveState.tokenUp : liveState.tokenDown;
    if (!tokenId) { console.log(`[AUTO-LOST] No token for ${s}`); continue; }

    try {
      console.log(`[AUTO-LOST] Placing GTC BUY ${s.toUpperCase()} ${autoLost.shares}sh @ ${(autoLost.buyPrice*100).toFixed(0)}¢ + GTC SELL @ ${(autoLost.sellPrice*100).toFixed(0)}¢`);
      const buyOrder = await clobClient.createOrder({ tokenID: tokenId, price: autoLost.buyPrice, size: autoLost.shares, side: 'BUY' }, { tickSize, negRisk });
      const sellOrder = await clobClient.createOrder({ tokenID: tokenId, price: autoLost.sellPrice, size: autoLost.shares, side: 'SELL' }, { tickSize, negRisk });
      const results = await clobClient.postOrders([
        { order: buyOrder, orderType: 'GTC' },
        { order: sellOrder, orderType: 'GTC' },
      ]);
      const arr = Array.isArray(results) ? results : (results?.responses || [results] || []);
      const buyId = arr[0]?.orderID ?? arr[0]?.order_id;
      const sellId = arr[1]?.orderID ?? arr[1]?.order_id;
      if (buyId) autoLost.buyOrderIds.push(buyId);
      if (sellId) autoLost.sellOrderIds.push(sellId);
      console.log(`[AUTO-LOST] ${s.toUpperCase()} orders placed — buy=${buyId?.slice(0,8)} sell=${sellId?.slice(0,8)}`);
      autoLost.log.unshift({ time: Date.now(), side: s, event: activeEvent.slug, buyId, sellId });
      if (autoLost.log.length > 20) autoLost.log.length = 20;
      broadcast({ type: 'auto_lost', status: 'placed', side: s, buyId, sellId });
    } catch (e) {
      console.error(`[AUTO-LOST] Error placing ${s}:`, e?.message ?? e);
      autoLost.log.unshift({ time: Date.now(), side: s, event: activeEvent.slug, error: e?.message });
    }
  }
}

// ── Auto-EMA: two-step scalp — buy winning side on EMA divergence, hedge on convergence ──
let autoEma = {
  enabled: false,
  shares: 5,
  gapOpenThreshold: 5,   // EMA gap threshold (hybrid: velocity + gap)
  priceMin: 30,           // winning side 30-55¢ (buy cheap only)
  priceMax: 55,
  maxHedgeWaitMs: 30_000, // max 30s to wait for hedge signal
  cooldownMs: 0,          // no cooldown between cycles
  busy: false,
  phase: null,            // null | 'entered' | 'hedged'
  entrySide: null,        // 'up' | 'down' — the winning/trending side
  entryOrderId: null,
  hedgeOrderId: null,
  takeProfitOrderId: null,
  entryPrice: null,
  entryTime: null,
  oppPriceAtEntry: null,  // opposite side ask at entry — used to compute stop loss threshold
  stopLossOppPrice: null, // hedge at this opposite price = -5¢ loss
  peakGap: 0,
  peakProfit: 0,          // highest unrealized profit in cents (for trailing stop)
  btcAtEntry: null,       // BTC price when entry filled
  btcPeak: null,          // highest BTC since entry (for UP trades) or lowest (for DOWN)
  lastTriggerTime: 0,
  lastHedgeTime: 0,
  lastEntrySide: null,      // prevent same side twice in a row
  log: [],
};

// Server-side EMA state (computed from Binance BTC ticks)
// Fast EMA sampled every 300ms for quicker trigger detection
const EMA_STATE_FILE = path.join(__dirname, '.ema-state.json');
let serverEma = {
  e12: null, e26: null, gap: 0,
  signal: null, histogram: 0, prevHistogram: 0,
  gapHistory: [], crossBtcPrice: null, crossTime: null,
  lastCandleTs: 0, lastDelta: 0,
  // Fast tick-level MACD for exit detection (only active when in trade)
  fE12: null, fE26: null, fSignal: null, fHistogram: 0, fPrevHistogram: 0,
  // EMA for Polymarket Up/Down prices
  upE12: null, upE26: null, downE12: null, downE26: null,
};

// Persist EMA state to disk every 10s, restore on startup
function saveEmaState() {
  try {
    const state = {
      serverEma: { ...serverEma, gapHistory: serverEma.gapHistory.slice(-60) },
      autoEmaLog: autoEma.log,
      lastEntrySide: autoEma.lastEntrySide,
      btcStart: liveState.btcStart,
      btcTicks: _btcTicks.slice(-100), // save recent BTC ticks for velocity on restart
      savedAt: Date.now(),
    };
    fs.writeFileSync(EMA_STATE_FILE, JSON.stringify(state));
  } catch {}
}
function restoreEmaState() {
  try {
    if (!fs.existsSync(EMA_STATE_FILE)) return;
    const state = JSON.parse(fs.readFileSync(EMA_STATE_FILE, 'utf8'));
    // Only restore if saved recently (< 30 min)
    if (Date.now() - state.savedAt > 1_800_000) { console.log('[EMA] Saved state too old (>30m), skipping restore'); return; }
    if (state.serverEma) {
      Object.assign(serverEma, state.serverEma);
      console.log(`[EMA] Restored — e12=$${serverEma.e12?.toFixed(1)} e26=$${serverEma.e26?.toFixed(1)} gap=$${serverEma.gap.toFixed(1)}`);
    }
    if (state.btcTicks && Array.isArray(state.btcTicks)) {
      // Restore BTC ticks that are still within the velocity window
      const now = Date.now();
      const valid = state.btcTicks.filter(t => now - t.t < BTC_VELOCITY_WINDOW_MS);
      _btcTicks.push(...valid);
      console.log(`[EMA] Restored ${valid.length} BTC ticks for velocity`);
    }
    if (state.autoEmaLog) autoEma.log = state.autoEmaLog;
    if (state.lastEntrySide) autoEma.lastEntrySide = state.lastEntrySide;
  } catch (e) { console.error('[EMA] Restore error:', e?.message); }
}
// EMA persistence disabled to save resources
// restoreEmaState();
// setInterval(saveEmaState, 10_000);
const EMA12_ALPHA = 2 / 13;  // MACD fast (candle-based)
const EMA26_ALPHA = 2 / 27;  // MACD slow (candle-based)
const EMA9_ALPHA = 2 / 10;   // MACD signal line (candle-based)
const MACD_CANDLE_MS = 2000;  // 2-second candles for entry
// Standard MACD alphas applied to tick data (same as chart)
const FAST_EMA12_ALPHA = 2 / 13;   // standard EMA12
const FAST_EMA26_ALPHA = 2 / 27;   // standard EMA26
const FAST_EMA9_ALPHA = 2 / 10;    // standard signal line

// EMA log buffer — disabled to save resources
const _emaLogBuffer = [];
// setInterval(async () => {
//   if (_emaLogBuffer.length === 0) return;
//   const batch = _emaLogBuffer.splice(0, _emaLogBuffer.length);
//   const { error } = await supabase.from('ema_snapshots').insert(batch);
//   if (error) console.error('[EMA-LOG] DB error:', error.message);
// }, 5000);

function updateServerEma(btcPrice) {
  if (liveState.btcStart == null) return;
  const now = Date.now();
  const delta = btcPrice - liveState.btcStart;
  serverEma.lastDelta = delta;

  // Fast tick-level MACD (always updated, used for trigger & exit)
  serverEma.fE12 = serverEma.fE12 == null ? delta : delta * FAST_EMA12_ALPHA + serverEma.fE12 * (1 - FAST_EMA12_ALPHA);
  serverEma.fE26 = serverEma.fE26 == null ? delta : delta * FAST_EMA26_ALPHA + serverEma.fE26 * (1 - FAST_EMA26_ALPHA);
  const fGap = serverEma.fE12 - serverEma.fE26;
  const fSignalNew = serverEma.fSignal == null ? fGap : fGap * FAST_EMA9_ALPHA + serverEma.fSignal * (1 - FAST_EMA9_ALPHA);
  serverEma.fPrevHistogram = serverEma.fHistogram;
  serverEma.fHistogram = fGap - fSignalNew;
  serverEma.fSignal = fSignalNew;

  // Slow 2s candle MACD (used for entry trigger)
  if (now - serverEma.lastCandleTs < MACD_CANDLE_MS) return;
  serverEma.lastCandleTs = now;

  serverEma.e12 = serverEma.e12 == null ? delta : delta * EMA12_ALPHA + serverEma.e12 * (1 - EMA12_ALPHA);
  serverEma.e26 = serverEma.e26 == null ? delta : delta * EMA26_ALPHA + serverEma.e26 * (1 - EMA26_ALPHA);

  const prevGap = serverEma.gap;
  serverEma.gap = (serverEma.e12 != null && serverEma.e26 != null) ? serverEma.e12 - serverEma.e26 : 0;

  serverEma.signal = serverEma.signal == null ? serverEma.gap : serverEma.gap * EMA9_ALPHA + serverEma.signal * (1 - EMA9_ALPHA);

  serverEma.prevHistogram = serverEma.histogram;
  serverEma.histogram = serverEma.gap - serverEma.signal;

  if ((prevGap <= 0 && serverEma.gap > 0) || (prevGap >= 0 && serverEma.gap < 0)) {
    serverEma.crossBtcPrice = btcPrice;
    serverEma.crossTime = now;
  }

  serverEma.gapHistory.push({ t: now, gap: serverEma.gap, hist: serverEma.histogram });
  if (serverEma.gapHistory.length > 600) serverEma.gapHistory.splice(0, serverEma.gapHistory.length - 600);

  // EMA DB logging disabled to save resources
}

function resetServerEma() {
  serverEma = { e12: null, e26: null, gap: 0, signal: null, histogram: 0, prevHistogram: 0, gapHistory: [], crossBtcPrice: null, crossTime: null, lastCandleTs: 0, lastDelta: 0, fE12: null, fE26: null, fSignal: null, fHistogram: 0, fPrevHistogram: 0, upE12: null, upE26: null, downE12: null, downE26: null };
}

// Seed EMA from Binance klines on startup so it doesn't start cold
async function seedServerEma() {
  try {
    if (!liveState.btcStart) return;
    const res = await fetch('https://api.binance.com/api/v3/klines?symbol=BTCUSDT&interval=1s&limit=180');
    const klines = await res.json();
    if (!Array.isArray(klines) || klines.length === 0) return;
    for (const k of klines) {
      const close = parseFloat(k[4]);
      const delta = close - liveState.btcStart;
      // Feed into slow EMA (every 2nd kline ≈ 2s candles)
      serverEma.e12 = serverEma.e12 == null ? delta : delta * EMA12_ALPHA + serverEma.e12 * (1 - EMA12_ALPHA);
      serverEma.e26 = serverEma.e26 == null ? delta : delta * EMA26_ALPHA + serverEma.e26 * (1 - EMA26_ALPHA);
      // Feed into fast EMA (tick-level alphas)
      serverEma.fE12 = serverEma.fE12 == null ? delta : delta * FAST_EMA12_ALPHA + serverEma.fE12 * (1 - FAST_EMA12_ALPHA);
      serverEma.fE26 = serverEma.fE26 == null ? delta : delta * FAST_EMA26_ALPHA + serverEma.fE26 * (1 - FAST_EMA26_ALPHA);
    }
    serverEma.gap = (serverEma.e12 ?? 0) - (serverEma.e26 ?? 0);
    serverEma.signal = serverEma.gap;
    serverEma.histogram = 0;
    const fGap = (serverEma.fE12 ?? 0) - (serverEma.fE26 ?? 0);
    serverEma.fSignal = fGap;
    serverEma.fHistogram = 0;
    serverEma.lastCandleTs = Date.now();
    console.log(`[AUTO-EMA] Seeded from ${klines.length} klines — e12=$${serverEma.e12?.toFixed(1)} e26=$${serverEma.e26?.toFixed(1)} gap=$${serverEma.gap.toFixed(1)}`);
  } catch (e) {
    console.error('[AUTO-EMA] Seed error:', e?.message);
  }
}

function _autoEmaAbort(reason) {
  // Cancel pending orders when aborting (user disabled or error)
  // Don't cancel hedgeOrderId — if placed, let it fill to complete the pair
  if (clobClient) {
    if (autoEma.takeProfitOrderId) clobClient.cancelOrder({ orderID: autoEma.takeProfitOrderId }).catch(() => {});
    if (autoEma.entryOrderId) clobClient.cancelOrder({ orderID: autoEma.entryOrderId }).catch(() => {});
  }
  // Update log entry if still pending (so UI shows why it aborted)
  if (reason && autoEma.log.length > 0 && autoEma.log[0].result === 'pending') {
    autoEma.log[0].result = reason;
  }
  autoEma.takeProfitPrice = null;
  // Cooldown starts from cycle completion (prevents rapid re-triggers)
  autoEma.lastTriggerTime = Date.now();
  autoEma.busy = false;
  autoEma.phase = null;
  autoEma.entrySide = null;
  autoEma.entryOrderId = null;
  autoEma.hedgeOrderId = null;
  autoEma.takeProfitOrderId = null;
  autoEma.entryPrice = null;
  autoEma.entryTime = null;
  autoEma.oppPriceAtEntry = null;
  autoEma.stopLossOppPrice = null;
  autoEma.peakGap = 0;
  autoEma.btcAtEntry = null;
  autoEma.btcPeak = null;
  autoEma.entryFillTime = null;
  autoEma.peakProfit = 0;
}

// BTC velocity tracker — rolling 3-second window
const _btcTicks = []; // { t: timestamp, price: number }
const BTC_VELOCITY_WINDOW_MS = 3000;  // 3-second window
const BTC_VELOCITY_THRESHOLD = 5;      // $5 move in 3s to trigger

// EMA gap history — track gap over time to detect fast convergence
const _emaGapHistory = []; // { t: timestamp, gap: number }
const EMA_GAP_WINDOW_MS = 5000;   // look back 5 seconds
const EMA_GAP_NEAR_THRESHOLD = 2; // gap must be within $2 of crossing
const EMA_GAP_FROM_THRESHOLD = 2; // gap must have narrowed by at least $2 in 5s

// Step 1: Enter when EMA gap is about to cross (near $0 + closing fast)
let _lastEmaDebug = 0;
function checkEmaTrigger(btcEmaCrossed, fGap) {
  if (!autoEma.enabled || autoEma.busy) return;
  if (!activeEvent || !clobClient) return;
  if (isNoTradeZone()) return;
  if (Date.now() - autoEma.lastTriggerTime < 4_000) return; // 4s cooldown

  const now = Date.now();
  const btcNow = liveState.binanceBtc;
  if (!btcNow) return;

  // Add tick and prune old ones
  _btcTicks.push({ t: now, price: btcNow });
  while (_btcTicks.length > 0 && now - _btcTicks[0].t > BTC_VELOCITY_WINDOW_MS) _btcTicks.shift();
  if (_btcTicks.length < 2) return;

  // Calculate velocity: price change over the window
  const oldest = _btcTicks[0];
  const velocity = btcNow - oldest.price; // positive = BTC going up
  const absVelocity = Math.abs(velocity);

  // Track EMA gap history for convergence detection
  _emaGapHistory.push({ t: now, gap: fGap });
  while (_emaGapHistory.length > 0 && now - _emaGapHistory[0].t > EMA_GAP_WINDOW_MS) _emaGapHistory.shift();

  // fGap passed as parameter from shared BTC EMA cross detection
  const fHist = serverEma.fHistogram ?? 0;

  // Determine side based on which direction the gap is converging toward
  // If gap is positive and shrinking → EMA12 dropping toward EMA26 → bearish → buy Down
  // If gap is negative and shrinking → EMA12 rising toward EMA26 → bullish → buy Up
  // But we want to buy the side that will win AFTER the cross completes
  const winSide = fGap > 0 ? 'down' : 'up'; // approaching cross = about to flip
  const winPrice = winSide === 'up' ? liveState.upPrice : liveState.downPrice;
  const winCents = (winPrice ?? 0) * 100;

  // Debug log every 10s
  const gapFrom3sAgo = _emaGapHistory.length > 0 ? _emaGapHistory[0].gap : fGap;
  const gapNarrow = Math.abs(gapFrom3sAgo) - Math.abs(fGap);
  if (now - _lastEmaDebug > 10_000) {
    _lastEmaDebug = now;
    console.log(`[AUTO-EMA-DBG] gap=$${fGap.toFixed(1)} (near≤$${EMA_GAP_NEAR_THRESHOLD}) gapNarrow=$${gapNarrow.toFixed(1)}/3s (need≥$${EMA_GAP_FROM_THRESHOLD}) hist=${fHist.toFixed(2)} win=${winSide}@${winCents.toFixed(0)}¢ (${autoEma.priceMin}-${autoEma.priceMax})`);
  }

  // Trigger: gap is near zero AND it narrowed fast in the last 3 seconds
  const absGap = Math.abs(fGap);
  if (absGap > EMA_GAP_NEAR_THRESHOLD) return;  // not close enough to crossing
  if (gapNarrow < EMA_GAP_FROM_THRESHOLD) return; // hasn't narrowed fast enough

  // Price must be in range (buy cheap, not expensive)
  if (winPrice == null) return;
  if (winCents < autoEma.priceMin || winCents > autoEma.priceMax) return;

  console.log(`[AUTO-EMA] Trigger — ${winSide.toUpperCase()}, gap=$${fGap.toFixed(1)} (was $${gapFrom3sAgo.toFixed(1)} 3s ago, narrowed $${gapNarrow.toFixed(1)}), winning=${winCents.toFixed(0)}¢`);
  autoEma.busy = true;
  autoEma.lastTriggerTime = now;
  autoEma.log = [{ ts: now, side: winSide, triggerGap: fGap, gapNarrow, fHist, velocity, entryPrice: null, entryFillTime: null, hedgePrice: null, hedgeReason: null, hedgeTime: null, peakGap: 0, tpPrice: null, profit: null, result: 'pending' }, ...autoEma.log].slice(0, 20);
  broadcast({ type: 'auto_ema', status: 'triggered', side: winSide, gap: fGap, gapNarrow });
  fireAutoEmaEntry(winSide);
}

// Step 1 execution: buy 5 shares at ask price
async function fireAutoEmaEntry(side) {
  if (!clobClient || !activeEvent) { _autoEmaAbort('no_client'); return; }
  if (isNoTradeZone()) { _autoEmaAbort('no_trade_zone'); return; }

  const tokenId = side === 'up' ? liveState.tokenUp : liveState.tokenDown;
  if (!tokenId) { _autoEmaAbort('no_token'); return; }

  const tickSize = activeEvent.tickSize || '0.01';
  const tick = parseFloat(tickSize);
  const negRisk = activeEvent.negRisk || false;
  const sizeShares = 5;

  try {
    const mkt = await fetchClobBidAsk(tokenId);
    const marketPrice = mkt.bestAsk ?? (side === 'up' ? liveState.upPrice : liveState.downPrice);
    if (!marketPrice || marketPrice <= 0) { _autoEmaAbort('no_market_price'); return; }

    const buyPrice = Math.max(0.01, Math.min(Math.round((marketPrice + 0.03) / tick) * tick, 0.99));

    console.log(`[AUTO-EMA] Entry: FAK BUY ${side.toUpperCase()} ${sizeShares}sh @ ${(buyPrice*100).toFixed(0)}¢ (ask ${(marketPrice*100).toFixed(0)}¢ +3¢)`);
    const signedOrder = await clobClient.createOrder({ tokenID: tokenId, price: buyPrice, size: sizeShares, side: 'BUY' }, { tickSize, negRisk });
    const result = await clobClient.postOrder(signedOrder, 'FAK');
    const ok = result?.success || result?.status === 'matched';
    const orderId = result?.orderID ?? result?.order_id;

    if (!ok) {
      console.log('[AUTO-EMA] Entry FAK didn\'t fill:', JSON.stringify(result));
      _autoEmaAbort('fak_no_fill');
      return;
    }

    console.log(`[AUTO-EMA] Entry result: status=${result?.status}, orderId=${orderId}`);

    // Capture opposite side price NOW to lock in stop loss level
    const oppAskNow = side === 'up' ? liveState.downPrice : liveState.upPrice;
    const stopLossOppPrice = (100 + 5 - Math.round(buyPrice * 100)) / 100;

    autoEma.phase = 'entered';
    autoEma.entrySide = side;
    autoEma.lastEntrySide = side;
    autoEma.entryOrderId = orderId;
    autoEma.entryPrice = buyPrice;
    autoEma.totalShares = sizeShares;
    autoEma.hedgedShares = 0;
    autoEma.entryTime = Date.now();
    autoEma.entryFillTime = Date.now();
    autoEma.oppPriceAtEntry = oppAskNow;
    autoEma.stopLossOppPrice = stopLossOppPrice;
    autoEma.peakGap = Math.abs(serverEma.gap);
    autoEma.btcAtEntry = liveState.binanceBtc;
    autoEma.btcPeak = liveState.binanceBtc;
    autoEma.peakProfit = 0;

    console.log(`[AUTO-EMA] Stop loss locked: opp now=${(oppAskNow*100).toFixed(0)}¢, stop if opp ≥ ${(stopLossOppPrice*100).toFixed(0)}¢ (= -5¢ loss)`);

    // DB insert
    supabase.from('polymarket_trades').insert({
      polymarket_event_id: eventDbId(), direction: side,
      purchase_price: buyPrice, purchase_amount: Math.round(sizeShares * buyPrice * 100) / 100,
      purchase_time: new Date().toISOString(), minute: Math.floor(Date.now() / 60000),
      btc_price_at_purchase: liveState.btcCurrent, order_type: 'live',
      order_status: 'open', polymarket_order_id: orderId, shares: sizeShares,
      notes: JSON.stringify({ type: 'auto-ema-entry', side, buyPrice, gap: serverEma.gap, eventSlug: liveState.eventSlug, histogram: serverEma.histogram, e12: serverEma.e12, e26: serverEma.e26 }),
    }).then(({ error: dbErr }) => { if (dbErr) console.error('[AUTO-EMA] DB error:', dbErr); });

    broadcast({ type: 'auto_ema', status: 'entered', side, buyPrice, gap: serverEma.gap });
    if (autoEma.log.length > 0) {
      autoEma.log[0].entryPrice = buyPrice;
      autoEma.log[0].entryFillTime = Date.now();
      autoEma.log[0].result = 'entered';
    }
    console.log(`[AUTO-EMA] ENTERED @ ${(buyPrice*100).toFixed(0)}¢ — hedge on EMA cross back or gap $6`);
    logTrade('btc-ema', 'entry', { side, buyPrice, shares: sizeShares, gap: serverEma.gap, fGap: (serverEma.fE12??0)-(serverEma.fE26??0), orderId, eventSlug: liveState.eventSlug });
  } catch (e) {
    console.error('[AUTO-EMA] Entry error:', e?.message ?? e);
    _autoEmaAbort();
  }
}

// Exit: hedge ALL 5sh when EMA crosses back OR gap reaches $6. Stop loss -5¢.
function checkEmaHedge() {
  if (!autoEma.enabled || !autoEma.busy || autoEma.phase !== 'entered') return;
  if (!activeEvent || !clobClient) return;

  const fGap = (serverEma.fE12 ?? 0) - (serverEma.fE26 ?? 0);
  const absFGap = Math.abs(fGap);
  autoEma.peakGap = Math.max(autoEma.peakGap, absFGap);

  const oppPrice = autoEma.entrySide === 'up' ? liveState.downPrice : liveState.upPrice;
  if (oppPrice == null || autoEma.entryPrice == null) return;
  const totalCostCents = Math.round((autoEma.entryPrice + oppPrice) * 100);
  const profitCents = 100 - totalCostCents;
  autoEma.peakProfit = Math.max(autoEma.peakProfit, profitCents);

  const totalShares = autoEma.totalShares || 5;

  // 1. EMA gap reaches $6: take profit, ride is done
  if (absFGap >= 6) {
    const reason = `ema_gap_6(${profitCents}¢, gap=$${fGap.toFixed(1)})`;
    console.log(`[AUTO-EMA] EMA GAP $6 — hedge all ${totalShares}sh, profit=${profitCents}¢, gap=$${fGap.toFixed(1)}`);
    _logHedge(reason);
    autoEma.phase = 'hedging';
    fireAutoEmaExit(reason, totalShares, true);
    return;
  }

  // 2. EMA crosses back (gap flips sign against entry direction)
  const crossedBack = (autoEma.entrySide === 'up' && fGap < 0) ||
                      (autoEma.entrySide === 'down' && fGap > 0);
  if (crossedBack) {
    const reason = `ema_cross_back(${profitCents}¢, gap=$${fGap.toFixed(1)})`;
    console.log(`[AUTO-EMA] EMA CROSS BACK — hedge all ${totalShares}sh, profit=${profitCents}¢, gap=$${fGap.toFixed(1)}`);
    _logHedge(reason);
    autoEma.phase = 'hedging';
    fireAutoEmaExit(reason, totalShares, true);
    return;
  }
}

function _logHedge(reason) {
  if (autoEma.log.length > 0) {
    autoEma.log[0].hedgeReason = reason;
    autoEma.log[0].hedgeTime = Date.now();
    autoEma.log[0].peakGap = autoEma.peakGap;
    autoEma.log[0].peakProfit = autoEma.peakProfit;
  }
}

// Exit: hedge by buying opposite side. Supports partial (50%) and full (stop loss) exits.
// isFinal=true: close entire position. isFinal=false: hedge partial, keep riding rest.
async function fireAutoEmaExit(reason, sharesToHedge, isFinal) {
  if (!clobClient || !activeEvent) { _autoEmaAbort(); return; }

  const oppSide = autoEma.entrySide === 'up' ? 'down' : 'up';
  const tokenId = oppSide === 'up' ? liveState.tokenUp : liveState.tokenDown;
  if (!tokenId) { _autoEmaAbort(); return; }

  const tickSize = activeEvent.tickSize || '0.01';
  const tick = parseFloat(tickSize);
  const negRisk = activeEvent.negRisk || false;

  try {
    // Hedge: buy opposite side at ask for quick fill
    const mkt = await fetchClobBidAsk(tokenId);
    const marketPrice = mkt.bestAsk ?? (oppSide === 'up' ? liveState.upPrice : liveState.downPrice);
    if (!marketPrice || marketPrice <= 0) { _autoEmaAbort(); return; }

    const buyPrice = Math.max(0.01, Math.min(Math.round((marketPrice - 0.01) / tick) * tick, 0.99));
    const totalCost = Math.round((autoEma.entryPrice + buyPrice) * 100);
    const profitCents = 100 - totalCost;

    const totalShares = autoEma.totalShares || 5;
    const rideShares = isFinal ? 0 : totalShares - sharesToHedge - (autoEma.hedgedShares || 0);

    console.log(`[AUTO-EMA] HEDGE: GTC BUY ${oppSide.toUpperCase()} ${sharesToHedge}sh @ ${(buyPrice*100).toFixed(0)}¢ (ask ${(marketPrice*100).toFixed(0)}¢ -1¢, entry ${(autoEma.entryPrice*100).toFixed(0)}¢, ${profitCents >= 0 ? '+' : ''}${profitCents}¢, reason=${reason})`);
    logTrade('btc-ema', 'hedge', { side: oppSide, buyPrice, shares: sharesToHedge, entryPrice: autoEma.entryPrice, totalCost, profitCents, reason, eventSlug: liveState.eventSlug });

    const signedOrder = await clobClient.createOrder({ tokenID: tokenId, price: buyPrice, size: sharesToHedge, side: 'BUY' }, { tickSize, negRisk });
    const result = await clobClient.postOrder(signedOrder, 'GTC');
    const ok = result?.success || result?.status === 'matched' || result?.status === 'live';
    const orderId = result?.orderID ?? result?.order_id;

    console.log(`[AUTO-EMA] Hedge result: status=${result?.status}, orderId=${orderId}`);
    if (!ok) {
      console.log('[AUTO-EMA] Hedge order failed, retrying in 2s:', JSON.stringify(result));
      await new Promise(r => setTimeout(r, 2000));
      return fireAutoEmaExit(reason, sharesToHedge, isFinal);
    }

    // If resting (not filled immediately), wait 10s then cancel and FAK at current ask+3¢
    if (result?.status === 'live' && orderId) {
      console.log(`[AUTO-EMA] Hedge resting — will force FAK +3¢ in 10s`);
      await new Promise(resolve => setTimeout(resolve, 10_000));
      try {
        await clobClient.cancelOrder({ orderID: orderId });
      } catch (e) { console.log(`[AUTO-EMA] Cancel error (continuing): ${e?.message}`); }
      // Retry FAK until filled
      for (let attempt = 1; attempt <= 5; attempt++) {
        try {
          const freshMkt = await fetchClobBidAsk(tokenId);
          const freshAsk = freshMkt.bestAsk ?? (oppSide === 'up' ? liveState.upPrice : liveState.downPrice);
          const fakPrice = Math.max(0.01, Math.min(Math.round((freshAsk + 0.03) / tick) * tick, 0.99));
          console.log(`[AUTO-EMA] Hedge force #${attempt}: FAK BUY ${oppSide.toUpperCase()} ${sharesToHedge}sh @ ${(fakPrice*100).toFixed(0)}¢ (ask ${(freshAsk*100).toFixed(0)}¢ +3¢)`);
          const fakSigned = await clobClient.createOrder({ tokenID: tokenId, price: fakPrice, size: sharesToHedge, side: 'BUY' }, { tickSize, negRisk });
          const fakResult = await clobClient.postOrder(fakSigned, 'FAK');
          const fakOk = fakResult?.success || fakResult?.status === 'matched';
          logTrade('btc-ema', 'hedge-fak', { side: oppSide, price: fakPrice, shares: sharesToHedge, reason: `10s_force_#${attempt}` });
          if (fakOk) break;
          console.log(`[AUTO-EMA] Force FAK #${attempt} didn't fill, retrying in 3s...`);
          if (attempt < 5) await new Promise(r => setTimeout(r, 3000));
        } catch (e) {
          console.log(`[AUTO-EMA] Force hedge #${attempt} error: ${e?.message}`);
          if (attempt < 5) await new Promise(r => setTimeout(r, 3000));
        }
      }
    }

    autoEma.hedgedShares = (autoEma.hedgedShares || 0) + sharesToHedge;

    if (autoEma.log.length > 0) {
      autoEma.log[0].hedgePrice = buyPrice;
      autoEma.log[0].profit = profitCents;
      autoEma.log[0].hedgedShares = autoEma.hedgedShares;
      autoEma.log[0].rideShares = isFinal ? 0 : rideShares;
      autoEma.log[0].result = isFinal
        ? `hedge ALL ${profitCents >= 0 ? '+' : ''}${profitCents}¢`
        : `hedge ${sharesToHedge}sh ${profitCents >= 0 ? '+' : ''}${profitCents}¢, ride ${rideShares}sh`;
    }

    // DB insert
    supabase.from('polymarket_trades').insert({
      polymarket_event_id: eventDbId(), direction: oppSide,
      purchase_price: buyPrice, purchase_amount: Math.round(sharesToHedge * buyPrice * 100) / 100,
      purchase_time: new Date().toISOString(), minute: Math.floor(Date.now() / 60000),
      btc_price_at_purchase: liveState.btcCurrent, order_type: 'live',
      order_status: 'open', polymarket_order_id: orderId, shares: sharesToHedge,
      notes: JSON.stringify({ type: isFinal ? 'auto-ema-hedge-all' : 'auto-ema-hedge-half', side: oppSide, buyPrice, sharesToHedge, rideShares, entryPrice: autoEma.entryPrice, entrySide: autoEma.entrySide, profitCents, peakProfit: autoEma.peakProfit, reason, eventSlug: liveState.eventSlug, gap: serverEma.gap, peakGap: autoEma.peakGap, histogram: serverEma.histogram }),
    }).then(({ error: dbErr }) => { if (dbErr) console.error('[AUTO-EMA] DB error:', dbErr); });

    broadcast({ type: 'auto_ema', status: isFinal ? 'hedged_all' : 'hedged_half', side: oppSide, buyPrice, profitCents, sharesToHedge, rideShares });
    autoEma.lastHedgeTime = Date.now();

    if (isFinal) {
      // Position fully closed
      _autoEmaAbort();
    } else {
      // Partial hedge done — go back to 'entered' so next tranche can fire
      autoEma.phase = 'entered';
      autoEma.busy = true;
      console.log(`[AUTO-EMA] Partial hedge done — ${autoEma.hedgedShares}/${autoEma.totalShares}sh hedged, ${remainingShares - sharesToHedge}sh remaining (stop loss still active)`);
    }

  } catch (e) {
    console.error('[AUTO-EMA] Hedge error, retrying in 3s:', e?.message ?? e);
    await new Promise(r => setTimeout(r, 3000));
    return fireAutoEmaExit(reason, sharesToHedge, isFinal);
  }
}

// Price tick history for flow detection
const flowTicks = { up: [], down: [] }; // [{ t: ms, p: price }]
const FLOW_TICK_MAX = 300; // keep last 300 ticks (~5 min at 1/s)

function recordFlowTick(side, price) {
  const arr = flowTicks[side];
  arr.push({ t: Date.now(), p: price });
  if (arr.length > FLOW_TICK_MAX) arr.splice(0, arr.length - FLOW_TICK_MAX);
}

function detectFlow(side) {
  const arr = flowTicks[side];
  const cutoff = Date.now() - autoFlow.windowSecs * 1000;
  const recent = arr.filter(t => t.t >= cutoff);
  if (recent.length < 10) return null; // need at least 10 ticks

  // Net direction from first to last
  const netMove = recent[recent.length - 1].p - recent[0].p;
  if (netMove === 0) return null; // no movement at all
  const goingUp = netMove > 0;
  const moveCents = Math.abs(netMove) * 100;

  // Count ALL ticks (including flat). Flat = holding the trend = good.
  // "Against" = moved opposite to net direction
  let withTrend = 0, againstTrend = 0;
  const total = recent.length - 1;
  for (let i = 1; i < recent.length; i++) {
    const d = recent[i].p - recent[i - 1].p;
    if (d === 0) {
      withTrend++; // flat = price holding = flow
    } else if ((goingUp && d > 0) || (!goingUp && d < 0)) {
      withTrend++;
    } else {
      againstTrend++;
    }
  }
  if (total < 5) return null;

  // Monotonicity: % of ticks that are flat or with-trend
  const mono = withTrend / total;

  // Reversals: how many ticks went against the trend (fewer = smoother)
  const reversals = againstTrend;

  // Max drawback: largest single move against the trend
  let maxReverse = 0;
  for (let i = 1; i < recent.length; i++) {
    const d = recent[i].p - recent[i - 1].p;
    if ((goingUp && d < 0) || (!goingUp && d > 0)) {
      maxReverse = Math.max(maxReverse, Math.abs(d));
    }
  }
  const maxReverseCents = maxReverse * 100;

  return { mono, moveCents, goingUp, ticks: recent.length, side, reversals, maxReverseCents };
}

function checkFlowTrigger() {
  if (!autoFlow.enabled) return;
  if (!activeEvent || !clobClient) return;

  if (autoFlow.busy) return;

  for (const side of ['up', 'down']) {
    if (Date.now() - (autoFlow.lastTriggerTime[side] || 0) < autoFlow.cooldownMs) continue;

    const f = detectFlow(side);
    if (!f) continue;

    // Check winning side is in range (30-60¢)
    const winningPrice = Math.max(liveState.upPrice || 0, liveState.downPrice || 0);
    const winCents = winningPrice * 100;
    if (winCents < autoFlow.priceMin || winCents > autoFlow.priceMax) continue;

    const ticks = flowTicks[side];
    let last10trending = false;
    if (ticks.length >= 10) {
      const last10 = ticks.slice(-10);
      const first5avg = last10.slice(0, 5).reduce((s, t) => s + t.p, 0) / 5;
      const last5avg = last10.slice(-5).reduce((s, t) => s + t.p, 0) / 5;
      last10trending = f.goingUp ? (last5avg >= first5avg) : (last5avg <= first5avg);
    }

    const maxRevAllowed = Math.max(3, Math.floor(f.ticks * (autoFlow.maxReversalPct ?? 0.20)));
    const triggered = f.mono >= autoFlow.monotonicity
      && f.moveCents >= autoFlow.minMoveCents
      && f.reversals <= maxRevAllowed
      && last10trending;

    if (triggered) {
      autoFlow.busy = true;
      autoFlow.lastTriggerTime[side] = Date.now();
      const logEntry = { ts: Date.now(), side, mono: f.mono.toFixed(2), move: f.moveCents.toFixed(1), reversals: f.reversals, maxRev: f.maxReverseCents.toFixed(1), ticks: f.ticks, buyPrice: null, oppBuyPrice: null };
      autoFlow.log = [logEntry, ...autoFlow.log].slice(0, 20);
      console.log(`[AUTO-FLOW] Triggered ${side.toUpperCase()} — mono=${(f.mono*100).toFixed(0)}% move=${f.moveCents.toFixed(1)}¢ reversals=${f.reversals} ticks=${f.ticks}`);
      broadcast({ type: 'auto_flow', status: 'triggered', ...logEntry });
      fireAutoFlow(side);
      return; // only 1 at a time
    }
  }
}

// Returns true if we're in the no-trade zone (first 15s or last 45s of event)
function isNoTradeZone() {
  if (!activeEvent) return false;
  const now = Date.now();
  const start = activeEvent.startDate ? new Date(activeEvent.startDate).getTime() : null;
  const end = activeEvent.endDate ? new Date(activeEvent.endDate).getTime() : null;
  if (start && now - start < 15_000) return true;  // first 15 seconds
  if (end && end - now < 45_000) return true;       // last 45 seconds
  return false;
}

async function fireAutoFlow(side) {
  if (!clobClient || !activeEvent) { _autoFlowAbort(); return; }
  if (isNoTradeZone()) { console.log('[AUTO-FLOW] Skipping — no-trade zone (first 15s / last 45s)'); _autoFlowAbort(); return; }
  const upTokenId = liveState.tokenUp;
  const downTokenId = liveState.tokenDown;
  if (!upTokenId || !downTokenId) { _autoFlowAbort(); return; }

  const tickSize = activeEvent.tickSize || '0.01';
  const tick = parseFloat(tickSize);
  const negRisk = activeEvent.negRisk || false;
  const sizeShares = autoFlow.shares;

  try {
    const [upMkt, downMkt] = await Promise.all([fetchClobBidAsk(upTokenId), fetchClobBidAsk(downTokenId)]);
    const upMarket = upMkt.bestAsk ?? liveState.upPrice;
    const downMarket = downMkt.bestAsk ?? liveState.downPrice;
    if (!upMarket || upMarket <= 0 || !downMarket || downMarket <= 0) { _autoFlowAbort(); return; }

    // Winning side (higher price) → -1¢, losing side (hammered) → -3¢
    const upWinning = upMarket >= downMarket;
    const upDiscount = upWinning ? 0.01 : 0.03;
    const downDiscount = upWinning ? 0.03 : 0.01;
    const upBuyPrice = Math.max(0.01, Math.min(Math.round((upMarket - upDiscount) / tick) * tick, 0.99));
    const downBuyPrice = Math.max(0.01, Math.min(Math.round((downMarket - downDiscount) / tick) * tick, 0.99));
    const totalCost = Math.round((upBuyPrice + downBuyPrice) * 100);
    const profitCentsActual = 100 - totalCost;

    if (profitCentsActual <= 0) { _autoFlowAbort(); return; }

    console.log(`[AUTO-FLOW] GTC UP ${sizeShares}sh @ ${(upBuyPrice*100).toFixed(0)}¢ + GTC DN @ ${(downBuyPrice*100).toFixed(0)}¢ (mkt ${(upMarket*100).toFixed(0)}/${(downMarket*100).toFixed(0)}¢, +${profitCentsActual}¢)`);

    const upOrder = await clobClient.createOrder({ tokenID: upTokenId, price: upBuyPrice, size: sizeShares, side: 'BUY' }, { tickSize, negRisk });
    const downOrder = await clobClient.createOrder({ tokenID: downTokenId, price: downBuyPrice, size: sizeShares, side: 'BUY' }, { tickSize, negRisk });

    const results = await clobClient.postOrders([
      { order: upOrder, orderType: 'GTC' },
      { order: downOrder, orderType: 'GTC' },
    ]);
    const arr = Array.isArray(results) ? results : (results?.responses || [results] || []);
    const upResult = arr[0];
    const downResult = arr[1];
    const upOk = upResult?.success || upResult?.status === 'matched' || upResult?.status === 'live';
    const downOk = downResult?.success || downResult?.status === 'live' || downResult?.status === 'matched';
    let upId = upResult?.orderID ?? upResult?.order_id;
    let downId = downResult?.orderID ?? downResult?.order_id;

    if (!upOk && !downOk) { _autoFlowAbort(); return; }

    autoFlow.upOrderId = upId;
    autoFlow.downOrderId = downId;
    autoFlow.unhedged = { shares: sizeShares, upBuyPrice, downBuyPrice, ts: Date.now() };
    broadcast({ type: 'auto_flow', status: 'placed', upBuyPrice, downBuyPrice, sizeShares, profitCents: profitCentsActual });

    if (upOk && upId) {
      supabase.from('polymarket_trades').insert({
        polymarket_event_id: eventDbId(), direction: 'up',
        purchase_price: upBuyPrice, purchase_amount: Math.round(sizeShares * upBuyPrice * 100) / 100,
        purchase_time: new Date().toISOString(), minute: Math.floor(Date.now() / 60000),
        btc_price_at_purchase: liveState.btcCurrent, order_type: 'live',
        order_status: 'open', polymarket_order_id: upId, shares: sizeShares,
        notes: JSON.stringify({ type: 'auto-flow-up', upBuyPrice, sizeShares }),
      }).then(({ error: dbErr }) => { if (dbErr) console.error('[AUTO-FLOW] DB error (up):', dbErr); });
    }
    if (downOk && downId) {
      supabase.from('polymarket_trades').insert({
        polymarket_event_id: eventDbId(), direction: 'down',
        purchase_price: downBuyPrice, purchase_amount: Math.round(sizeShares * downBuyPrice * 100) / 100,
        purchase_time: new Date().toISOString(), minute: Math.floor(Date.now() / 60000),
        btc_price_at_purchase: liveState.btcCurrent, order_type: 'live',
        order_status: 'open', polymarket_order_id: downId, shares: sizeShares,
        notes: JSON.stringify({ type: 'auto-flow-down', downBuyPrice, sizeShares, profitCentsActual }),
      }).then(({ error: dbErr }) => { if (dbErr) console.error('[AUTO-FLOW] DB error (down):', dbErr); });
    }

    // Update log entry with order prices
    if (autoFlow.log.length > 0) {
      autoFlow.log[0].buyPrice = upBuyPrice;
      autoFlow.log[0].oppBuyPrice = downBuyPrice;
      autoFlow.log[0].profit = profitCentsActual;
    }
    console.log(`[AUTO-FLOW] GTC UP @ ${(upBuyPrice*100).toFixed(0)}¢ + GTC DN @ ${(downBuyPrice*100).toFixed(0)}¢ → ${profitCentsActual}¢ profit when both fill`);

    // Chase logic: after 4s, if one filled but other hasn't, cancel & re-place at market-1¢
    let chased = false;
    setTimeout(async () => {
      if (chased) return;
      try {
        const raw = await clobClient.getOpenOrders();
        const list = Array.isArray(raw) ? raw : (raw?.data ?? raw?.orders ?? []);
        const oid = o => o?.id ?? o?.order_id ?? o?.orderID ?? o?.orderId;
        const upStill = upId && list.some(o => oid(o) === upId);
        const downStill = downId && list.some(o => oid(o) === downId);

        if (!upStill && !downStill) return; // both filled already
        if (upStill && downStill) return; // neither filled, keep waiting

        chased = true;
        const unfilledSide = upStill ? 'up' : 'down';
        const unfilledId = upStill ? upId : downId;
        const unfilledTokenId = upStill ? upTokenId : downTokenId;

        console.log(`[AUTO-FLOW] Chase ${unfilledSide} — canceling and re-placing at market-1¢`);
        try { await clobClient.cancelOrder({ orderID: unfilledId }); } catch (ce) { console.error('[AUTO-FLOW] Cancel error:', ce.message); }

        const mkt = await fetchClobBidAsk(unfilledTokenId);
        const marketPrice = mkt.bestAsk ?? (upStill ? liveState.upPrice : liveState.downPrice);
        const chasePrice = Math.max(0.01, Math.min(Math.round((marketPrice - 0.01) / tick) * tick, 0.99));
        const filledPrice = upStill ? downBuyPrice : upBuyPrice;
        const chaseTotalCost = Math.round((filledPrice + chasePrice) * 100);
        if (chaseTotalCost >= 100) {
          console.log(`[AUTO-FLOW] Chase SKIP — would lock loss: ${chaseTotalCost}¢ total. Aborting.`);
          _autoFlowAbort();
          return;
        }

        console.log(`[AUTO-FLOW] Chase ${unfilledSide} @ ${(chasePrice*100).toFixed(0)}¢ (mkt ${(marketPrice*100).toFixed(0)}¢)`);
        const chaseOrder = await clobClient.createOrder({ tokenID: unfilledTokenId, price: chasePrice, size: sizeShares, side: 'BUY' }, { tickSize, negRisk });
        const chaseResult = await clobClient.postOrders([{ order: chaseOrder, orderType: 'GTC' }]);
        const chaseArr = Array.isArray(chaseResult) ? chaseResult : (chaseResult?.responses || [chaseResult] || []);
        const newId = chaseArr[0]?.orderID ?? chaseArr[0]?.order_id;

        if (upStill) { upId = newId; autoFlow.upOrderId = newId; }
        else { downId = newId; autoFlow.downOrderId = newId; }
        broadcast({ type: 'auto_flow', status: 'chasing', side: unfilledSide, chasePrice });
      } catch (e) {
        console.error('[AUTO-FLOW] Chase error:', e.message);
      }
    }, 4000);

    // Poll until BOTH fill
    const pollBoth = setInterval(async () => {
      try {
        const raw = await clobClient.getOpenOrders();
        const list = Array.isArray(raw) ? raw : (raw?.data ?? raw?.orders ?? []);
        const oid = o => o?.id ?? o?.order_id ?? o?.orderID ?? o?.orderId;
        const upStill = upId && (list || []).some(o => oid(o) === upId);
        const downStill = downId && (list || []).some(o => oid(o) === downId);
        if (!upStill && !downStill) {
          console.log(`[AUTO-FLOW] Both filled — profit locked`);
          broadcast({ type: 'auto_flow', status: 'filled', profit: chased ? '~1¢ (chased)' : profitCentsActual });
          _autoFlowAbort(); // releases busy lock
          clearInterval(pollBoth);
        }
      } catch (e) {
        console.error('[AUTO-FLOW] Poll error:', e.message);
      }
    }, 3000);
  } catch (e) {
    console.error('[AUTO-FLOW] Error:', e?.message ?? e);
    broadcast({ type: 'auto_flow', status: 'error', error: e?.message });
    _autoFlowAbort();
  }
}

function _autoFlowAbort() {
  autoFlow.busy = false;
  autoFlow.upOrderId = null;
  autoFlow.downOrderId = null;
  autoFlow.unhedged = null;
}

// ── Stop-loss state (persisted in memory + DB, survives frontend refresh & restart) ──
let stopLossState = null; // { side: 'up'|'down', trigger: cents, shares: number }
let stopLossFiring = false; // lock to prevent double-fire

// Encoding: value = trigger (1-99), side & shares packed into a second row or encoded:
// We use two rows: 'stop_loss' for enabled/trigger, 'stop_loss_detail' for side+shares
// Actually simpler: pack as value = side_bit * 10000 + shares * 100 + trigger
// side_bit: 0=up, 1=down; shares max 999; trigger max 99
function packSL(sl) { return (sl.side === 'down' ? 10000 : 0) + sl.shares * 100 + sl.trigger; }
function unpackSL(v) {
  const side = v >= 10000 ? 'down' : 'up';
  const rem = v % 10000;
  return { side, shares: Math.floor(rem / 100), trigger: rem % 100 };
}

async function saveStopLossToDb(sl) {
  try {
    await supabase.from('strategy_settings').upsert({
      strategy: 'stop_loss',
      enabled: !!sl,
      value: sl ? packSL(sl) : 0,
      updated_at: new Date().toISOString(),
    }, { onConflict: 'strategy' });
  } catch (e) { console.error('[SL] DB save error:', e.message); }
}

async function loadStopLossFromDb() {
  try {
    const { data, error } = await supabase.from('strategy_settings')
      .select('enabled, value')
      .eq('strategy', 'stop_loss')
      .single();
    if (error || !data || !data.enabled || !data.value) {
      console.log('[SL] No active stop-loss in DB');
      return;
    }
    stopLossState = unpackSL(data.value);
    console.log(`[SL] RESTORED from DB — ${stopLossState.shares}sh ${stopLossState.side} ≥${stopLossState.trigger}¢`);
  } catch (e) { console.error('[SL] DB load error:', e.message); }
}

// Cached DB open price for /api/event (invalidated on event change)
let cachedOpenPrice = { slug: null, btc: null, up: null, down: null };

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
  // Try KS 15m price first (more accurate for 15m events)
  try {
    const ksRes = await fetch(`http://localhost:${process.env.PORT || 3001}/api/arb/ks-price/btc`);
    if (ksRes.ok) {
      const ks = await ksRes.json();
      if (ks.yesAsk && ks.noAsk) {
        // Figure out which outcome this tokenId maps to
        // Check k9TokenMap for this tokenId's outcome
        const info = k9TokenMap[tokenId];
        const outcome = info?.outcome?.toLowerCase();
        if (outcome === 'up') {
          // Poly UP = KS YES
          return orderSide === 'buy' ? ks.yesAsk : ks.yesBid;
        } else if (outcome === 'down') {
          // Poly DOWN = KS NO
          return orderSide === 'buy' ? ks.noAsk : ks.noBid;
        }
      }
    }
  } catch {}

  // Fallback to Poly CLOB price
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
    // Use +1¢ (was +4¢) — overpaying caused significant losses when price reverted
    const buyPrice = Math.min(Number((Math.round((price + 0.01) / tick) * tick).toFixed(2)), 0.99);
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

// ── Fetch active 15m BTC event from Polymarket ────────────────────────────
async function fetchActiveEvent() {
  try {
    // Find current 15m BTC event by timestamp
    const now = Math.floor(Date.now() / 1000);
    // Round down to nearest 15 min
    const slot = Math.floor(now / 900) * 900;
    const slug = `btc-updown-15m-${slot}`;

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

        // Poly WS prices disabled — KS prices are the sole source (synced every 3s)
        // Only use Poly WS for flow ticks
        if (price != null && !isNaN(price) && price > 0 && price < 1) {
          if (assetId === liveState.tokenUp) {
            recordFlowTick('up', price);
          } else if (assetId === liveState.tokenDown) {
            recordFlowTick('down', price);
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

// ── ETH event: auto-detect + CLOB WS ──────────────────────────────────────
async function fetchActiveEthEvent() {
  try {
    const now = Math.floor(Date.now() / 1000);
    const slot = Math.floor(now / 900) * 900;
    const slug = `eth-updown-15m-${slot}`;
    const res = await fetch(`https://gamma-api.polymarket.com/events?slug=${slug}`);
    const data = await res.json();
    const event = Array.isArray(data) ? data[0] : data;
    if (!event) return null;
    const market = event.markets?.[0];
    if (!market) return null;
    const tokenIds = typeof market.clobTokenIds === 'string' ? JSON.parse(market.clobTokenIds) : market.clobTokenIds;
    console.log(`[ETH EVENT] Found: ${event.slug} — ${event.title}`);
    return {
      slug: event.slug, title: event.title,
      tokenUp: tokenIds[0], tokenDown: tokenIds[1],
      tickSize: market.orderPriceMinTickSize || '0.01',
      negRisk: !!market.negRisk,
    };
  } catch (e) {
    console.error('[ETH EVENT] fetch error:', e.message);
    return null;
  }
}

function connectEthClobStream(tokenIds) {
  if (ethClobWs) ethClobWs.close();
  ethClobWs = new WebSocket('wss://ws-subscriptions-clob.polymarket.com/ws/market');

  ethClobWs.on('open', () => {
    console.log('[ETH CLOB WS] connected');
    ethClobWs.send(JSON.stringify({ assets_ids: tokenIds, type: 'market' }));
  });

  ethClobWs.on('message', (raw) => {
    try {
      const msgs = JSON.parse(raw);
      const arr = Array.isArray(msgs) ? msgs : [msgs];
      let changed = false;
      for (const msg of arr) {
        let price = null;
        const assetId = msg.asset_id || msg.market;
        if (msg.event_type === 'price_change' || msg.type === 'price_change') price = parseFloat(msg.price);
        else if (msg.event_type === 'last_trade_price' || msg.type === 'last_trade_price') price = parseFloat(msg.price);
        if (price != null && !isNaN(price) && price > 0 && price < 1) {
          if (assetId === liveStateEth.tokenUp) {
            liveStateEth.upPrice = price;
            if (liveStateEth.upStartPrice == null) liveStateEth.upStartPrice = price;
            changed = true;
          } else if (assetId === liveStateEth.tokenDown) {
            liveStateEth.downPrice = price;
            if (liveStateEth.downStartPrice == null) liveStateEth.downStartPrice = price;
            changed = true;
          }
        }
      }
      if (changed) {
        broadcast({ type: 'eth_prices', ...liveStateEth });
      }
    } catch {}
  });

  ethClobWs.on('close', () => {
    console.log('[ETH CLOB WS] disconnected, reconnecting in 3s...');
    setTimeout(() => { if (liveStateEth.tokenUp) connectEthClobStream([liveStateEth.tokenUp, liveStateEth.tokenDown]); }, 3000);
  });
  ethClobWs.on('error', (e) => console.error('[ETH CLOB WS] error:', e.message));
}

async function refreshEthEvent() {
  const event = await fetchActiveEthEvent();
  if (!event) { console.log('[ETH EVENT] No active ETH event found'); return; }
  ethEvent = event;
  liveStateEth.eventSlug = event.slug;
  liveStateEth.eventTitle = event.title;
  liveStateEth.tokenUp = event.tokenUp;
  liveStateEth.tokenDown = event.tokenDown;
  liveStateEth.upPrice = null;
  liveStateEth.downPrice = null;
  liveStateEth.upStartPrice = null;
  liveStateEth.downStartPrice = null;
  broadcast({ type: 'eth_event', event });
  connectEthClobStream([event.tokenUp, event.tokenDown]);
  // Fetch initial prices
  try {
    const [upP, downP] = await Promise.all([fetchClobPrice(event.tokenUp), fetchClobPrice(event.tokenDown)]);
    if (upP != null) liveStateEth.upPrice = upP;
    if (downP != null) liveStateEth.downPrice = downP;
    broadcast({ type: 'eth_prices', ...liveStateEth });
  } catch {}
}

// Schedule ETH event refresh alongside BTC
let ethEventTimer = null;
function scheduleEthEvent() {
  if (ethEventTimer) clearTimeout(ethEventTimer);
  const now = Date.now();
  const nowSecs = Math.floor(now / 1000);
  const nextSlot = (Math.floor(nowSecs / 900) + 1) * 900;
  const delay = (nextSlot * 1000) - now + 3000; // 3s after slot boundary
  ethEventTimer = setTimeout(() => { refreshEthEvent(); scheduleEthEvent(); }, delay);
}

// ── BTC 5m event tracking (Poly only) ────────────────────────────────────
let btc5mEvent = null;
let btc5mClobWs = null;
let btc5mState = {
  eventSlug: null, tokenUp: null, tokenDown: null,
  upPrice: null, downPrice: null, btcStart: null, btcCurrent: null,
  endTime: null, title: null, tickSize: '0.01', negRisk: false,
};
const btc5mSnapshotBuffer = [];

async function fetchActive5mEvent() {
  try {
    const now = Math.floor(Date.now() / 1000);
    const slot = Math.floor(now / 300) * 300;
    const slug = `btc-updown-5m-${slot}`;
    const res = await fetch(`https://gamma-api.polymarket.com/events?slug=${slug}`);
    const data = await res.json();
    const event = Array.isArray(data) ? data[0] : data;
    if (!event) return null;
    const market = event.markets?.[0];
    if (!market) return null;
    const tokenIds = typeof market.clobTokenIds === 'string' ? JSON.parse(market.clobTokenIds) : market.clobTokenIds;
    console.log(`[BTC5M] Found: ${event.slug} — ${event.title}`);
    return {
      slug: event.slug, title: event.title,
      startDate: event.startDate, endDate: event.endDate,
      tokenUp: tokenIds[0], tokenDown: tokenIds[1],
      tickSize: market.orderPriceMinTickSize || '0.01',
      negRisk: !!market.negRisk,
    };
  } catch (e) {
    console.error('[BTC5M] fetch error:', e.message);
    return null;
  }
}

function connect5mClobStream(tokenIds) {
  if (btc5mClobWs) btc5mClobWs.close();
  btc5mClobWs = new WebSocket('wss://ws-subscriptions-clob.polymarket.com/ws/market');

  btc5mClobWs.on('open', () => {
    console.log('[BTC5M CLOB WS] connected');
    btc5mClobWs.send(JSON.stringify({ assets_ids: tokenIds, type: 'market' }));
  });

  btc5mClobWs.on('message', (raw) => {
    try {
      const msgs = JSON.parse(raw);
      const arr = Array.isArray(msgs) ? msgs : [msgs];
      let changed = false;
      for (const msg of arr) {
        let price = null;
        const assetId = msg.asset_id || msg.market;
        if (msg.event_type === 'price_change' || msg.type === 'price_change') price = parseFloat(msg.price);
        else if (msg.event_type === 'last_trade_price' || msg.type === 'last_trade_price') price = parseFloat(msg.price);
        if (price != null && !isNaN(price) && price > 0 && price < 1) {
          if (assetId === btc5mState.tokenUp) {
            btc5mState.upPrice = price;
            changed = true;
          } else if (assetId === btc5mState.tokenDown) {
            btc5mState.downPrice = price;
            changed = true;
          }
        }
      }
      if (changed) {
        btc5mState.btcCurrent = liveState.binanceBtc;
        broadcast({ type: 'btc5m_prices', ...btc5mState });
      }
    } catch {}
  });

  btc5mClobWs.on('close', () => {
    console.log('[BTC5M CLOB WS] disconnected, reconnecting in 3s...');
    setTimeout(() => { if (btc5mState.tokenUp) connect5mClobStream([btc5mState.tokenUp, btc5mState.tokenDown]); }, 3000);
  });
  btc5mClobWs.on('error', (e) => console.error('[BTC5M CLOB WS] error:', e.message));
}

async function refresh5mEvent() {
  const event = await fetchActive5mEvent();
  if (!event) { console.log('[BTC5M] No active 5m event found'); return; }
  btc5mEvent = event;
  btc5mState.eventSlug = event.slug;
  btc5mState.title = event.title;
  btc5mState.tokenUp = event.tokenUp;
  btc5mState.tokenDown = event.tokenDown;
  btc5mState.endTime = event.endDate;
  btc5mState.tickSize = event.tickSize;
  btc5mState.negRisk = event.negRisk;
  btc5mState.upPrice = null;
  btc5mState.downPrice = null;
  // Capture BTC start from Binance
  btc5mState.btcStart = liveState.binanceBtc || null;
  btc5mState.btcCurrent = liveState.binanceBtc || null;
  broadcast({ type: 'btc5m_event', event });
  connect5mClobStream([event.tokenUp, event.tokenDown]);
  // Fetch initial prices
  try {
    const [upP, downP] = await Promise.all([fetchClobPrice(event.tokenUp), fetchClobPrice(event.tokenDown)]);
    if (upP != null) btc5mState.upPrice = upP;
    if (downP != null) btc5mState.downPrice = downP;
    broadcast({ type: 'btc5m_prices', ...btc5mState });
  } catch {}
}

let btc5mEventTimer = null;
function schedule5mEvent() {
  if (btc5mEventTimer) clearTimeout(btc5mEventTimer);
  const now = Date.now();
  const nowSecs = Math.floor(now / 1000);
  const nextSlot = (Math.floor(nowSecs / 300) + 1) * 300;
  const delay = (nextSlot * 1000) - now + 3000; // 3s after 5m boundary
  btc5mEventTimer = setTimeout(() => { refresh5mEvent(); schedule5mEvent(); }, delay);
}

// Multi-coin 5m tracker — all coins share the same logic
const EXTRA_5M_COINS = ['eth', 'sol', 'xrp'];
const extra5m = {}; // coin → { event, state, priceLog }

for (const coin of EXTRA_5M_COINS) {
  extra5m[coin] = {
    event: null,
    state: { eventSlug: null, tokenUp: null, tokenDown: null, upPrice: null, downPrice: null, endTime: null, title: null, tickSize: '0.01', negRisk: false },
    priceLog: [],
    firedSlug: null,
  };
}

async function refreshExtra5mEvent(coin) {
  try {
    const now = Math.floor(Date.now() / 1000);
    const slot = Math.floor(now / 300) * 300;
    const slug = `${coin}-updown-5m-${slot}`;
    const res = await fetch(`https://gamma-api.polymarket.com/events?slug=${slug}`);
    const data = await res.json();
    const event = Array.isArray(data) ? data[0] : data;
    if (!event?.markets?.[0]) return;
    const market = event.markets[0];
    const tokens = typeof market.clobTokenIds === 'string' ? JSON.parse(market.clobTokenIds) : market.clobTokenIds;
    const outcomes = typeof market.outcomes === 'string' ? JSON.parse(market.outcomes) : market.outcomes;
    const upIdx = outcomes?.findIndex(o => o.toLowerCase().includes('up')) ?? 0;
    const downIdx = upIdx === 0 ? 1 : 0;
    extra5m[coin].event = { ...event, tokenUp: tokens[upIdx], tokenDown: tokens[downIdx], tickSize: market.minimumTickSize || '0.01', negRisk: market.negRisk || false, endDate: event.endDate };
    extra5m[coin].state = { eventSlug: slug, tokenUp: tokens[upIdx], tokenDown: tokens[downIdx], upPrice: null, downPrice: null, endTime: event.endDate, title: event.title, tickSize: market.minimumTickSize || '0.01', negRisk: market.negRisk || false };
    extra5m[coin].priceLog = [];
    console.log(`[${coin.toUpperCase()}-5M] ${event.title}`);
    const [upP, downP] = await Promise.all([fetchClobPrice(tokens[upIdx]), fetchClobPrice(tokens[downIdx])]).catch(() => [null, null]);
    if (upP != null) extra5m[coin].state.upPrice = upP;
    if (downP != null) extra5m[coin].state.downPrice = downP;
  } catch {}
}

// Price poll all extra coins every 3s
setInterval(async () => {
  for (const coin of EXTRA_5M_COINS) {
    const s = extra5m[coin].state;
    if (!s.tokenUp) continue;
    try {
      const [upP, downP] = await Promise.all([fetchClobPrice(s.tokenUp), fetchClobPrice(s.tokenDown)]);
      if (upP != null) s.upPrice = upP;
      if (downP != null) s.downPrice = downP;
    } catch {}
  }
}, 3000);

// Schedule all extra coins
function scheduleExtra5m() {
  const now = Date.now();
  const nextSlot = (Math.floor(Math.floor(now/1000) / 300) + 1) * 300;
  const delay = (nextSlot * 1000) - now + 3000;
  setTimeout(async () => {
    for (const coin of EXTRA_5M_COINS) {
      await refreshExtra5mEvent(coin);
      await new Promise(r => setTimeout(r, 300));
    }
    scheduleExtra5m();
  }, delay);
}

// API for each coin
for (const coin of EXTRA_5M_COINS) {
  app.get(`/api/${coin}5m/event`, (req, res) => res.json({ ...extra5m[coin].state, btcCurrent: liveState.binanceBtc }));
  app.get(`/api/${coin}5m/price-history`, (req, res) => res.json({ snapshots: [], slug: req.query.slug }));
  app.post(`/api/${coin}5m/buy`, async (req, res) => {
    const { side, shares: reqShares, limitPrice, orderType } = req.body;
    const e = extra5m[coin];
    if (!e.event) return res.status(400).json({ error: `No active ${coin} 5m event` });
    if (!['up', 'down'].includes(side) || !clobClient) return res.status(400).json({ error: 'Invalid' });
    const tokenId = side === 'up' ? e.state.tokenUp : e.state.tokenDown;
    if (!tokenId) return res.status(400).json({ error: 'No token' });
    const shares = Math.max(1, Math.round(parseFloat(reqShares || 5)));
    const price = limitPrice ? Math.max(0.01, Math.min(parseFloat(limitPrice), 0.99)) : Math.max(0.01, Math.min(side === 'up' ? e.state.upPrice : e.state.downPrice, 0.99));
    res.json({ success: true, price, shares, status: 'sending' });
    (async () => {
      try {
        const signed = await clobClient.createOrder({ tokenID: tokenId, price, size: shares, side: 'BUY' }, { tickSize: String(e.event.tickSize || '0.01'), negRisk: e.event.negRisk || false });
        await clobClient.postOrder(signed, orderType || 'GTC');
      } catch (err) { console.error(`[${coin}-5m] buy error:`, err.message?.slice(0, 60)); }
    })();
  });
  app.post(`/api/${coin}5m/limit99`, async (req, res) => {
    const e = extra5m[coin];
    if (!e.event || !clobClient) return res.status(400).json({ error: 'No active event' });
    const winSide = (e.state.upPrice || 0) >= (e.state.downPrice || 0) ? 'up' : 'down';
    const tokenId = winSide === 'up' ? e.state.tokenUp : e.state.tokenDown;
    if (!tokenId) return res.status(400).json({ error: 'No token' });
    res.json({ success: true, side: winSide, price: 0.99, shares: 5 });
    (async () => {
      try {
        const signed = await clobClient.createOrder({ tokenID: tokenId, price: 0.99, size: 5, side: 'BUY' }, { tickSize: String(e.event.tickSize || '0.01'), negRisk: e.event.negRisk || false });
        await clobClient.postOrder(signed, 'GTC');
      } catch (err) { console.error(`[${coin}-5m 99] error:`, err.message?.slice(0, 60)); }
    })();
  });
  app.post(`/api/${coin}5m/auto99/toggle`, (req, res) => res.json({ enabled: auto99State.enabled }));
  app.get(`/api/${coin}5m/auto99/status`, (req, res) => res.json({ enabled: auto99State.enabled, logSize: extra5m[coin].priceLog.length }));
}


// Server-side Auto-99: winning side >96¢ for 10s with no side switch → burst orders in last 1s
const auto99State = { enabled: false, firedSlug: null, priceLog: [], firing: false };
app.post('/api/btc5m/auto99/toggle', (req, res) => {
  auto99State.enabled = !auto99State.enabled;
  if (!auto99State.enabled) { auto99State.firedSlug = null; auto99State.priceLog = []; auto99State.firing = false; }
  console.log(`[auto-99] ${auto99State.enabled ? 'ENABLED' : 'DISABLED'}`);
  res.json({ enabled: auto99State.enabled });
});
app.get('/api/btc5m/auto99/status', (req, res) => {
  res.json({ enabled: auto99State.enabled, firedSlug: auto99State.firedSlug, logSize: auto99State.priceLog.length });
});

// Shared helper: place an order for a coin. Try 99.9¢ first, fall back to 99¢.
async function placeAuto99Order(coin, side, state, event) {
  if (!clobClient) return;
  const tokenId = side === 'up' ? state.tokenUp : state.tokenDown;
  if (!tokenId) return;
  const negRisk = event.negRisk || false;
  let result;
  try {
    const signed = await clobClient.createOrder({ tokenID: tokenId, price: 0.999, size: 5, side: 'BUY' }, { tickSize: '0.001', negRisk });
    result = await clobClient.postOrder(signed, 'GTC');
  } catch {
    const signed2 = await clobClient.createOrder({ tokenID: tokenId, price: 0.99, size: 5, side: 'BUY' }, { tickSize: String(event.tickSize || '0.01'), negRisk });
    result = await clobClient.postOrder(signed2, 'GTC');
  }
  console.log(`[${coin}-auto-99] PLACED: ${side} 5sh → ${result?.status} id:${result?.orderID?.slice(0,8)}`);
  return result;
}

// Check if a coin's price log qualifies: winning side >96¢ for 10s, no side switch
function check99Eligible(priceLog) {
  const now = Date.now();
  const last10s = priceLog.filter(p => now - p.t < 10000);
  if (last10s.length < 3) return null; // need at least 3 data points in 10s
  const side = last10s[0].side;
  if (!last10s.every(p => p.side === side && p.winner > 0.96)) return null;
  return side;
}

// Burst-fire orders every 200ms for a coin during the last ~1s
function startBurstFire(coin, state, event, priceLog, firedKey) {
  let orderCount = 0;
  const maxOrders = 5; // ~1s at 200ms intervals

  function fireNext() {
    if (!auto99State.enabled) return;
    const now = Date.now();
    const endMs = new Date(event.endDate).getTime();
    const secsLeft = (endMs - now) / 1000;
    if (secsLeft <= 0 || orderCount >= maxOrders) return;

    // Re-check price is still >96¢
    const up = state.upPrice, down = state.downPrice;
    if (up == null || down == null) return;
    const winPrice = Math.max(up, down);
    if (winPrice <= 0.96) {
      console.log(`[${coin}-auto-99] ABORT burst: winner dropped to ${(winPrice*100).toFixed(0)}¢`);
      return;
    }

    const side = up > down ? 'up' : 'down';
    // Verify side hasn't flipped
    const eligibleSide = check99Eligible(priceLog);
    if (!eligibleSide || eligibleSide !== side) {
      console.log(`[${coin}-auto-99] ABORT burst: side switched`);
      return;
    }

    orderCount++;
    console.log(`[${coin}-auto-99] BURST ${orderCount}/${maxOrders}: ${side} @ 99¢ (${secsLeft.toFixed(1)}s left, winner ${(winPrice*100).toFixed(0)}¢)`);
    placeAuto99Order(coin, side, state, event).catch(e => console.error(`[${coin}-auto-99] burst error:`, e.message?.slice(0, 80)));

    setTimeout(fireNext, 200);
  }

  fireNext();
}

// Price logging — every 1s for BTC
function schedule99Tick() {
  setTimeout(async () => {
    try {
      if (!auto99State.enabled) { schedule99Tick(); return; }
      if (!btc5mState.eventSlug || !btc5mEvent?.endDate) { schedule99Tick(); return; }

      const up = btc5mState.upPrice, down = btc5mState.downPrice;
      if (up == null || down == null) { schedule99Tick(); return; }

      const winningSide = up > down ? 'up' : 'down';
      const winningPrice = Math.max(up, down);
      const now = Date.now();

      // Log sane prices only
      if (up + down < 1.5) {
        auto99State.priceLog.push({ t: now, winner: winningPrice, side: winningSide });
      }
      auto99State.priceLog = auto99State.priceLog.filter(p => now - p.t < 30000);

      const secsLeft = Math.max(0, (new Date(btc5mEvent.endDate).getTime() - now) / 1000);

      // When we hit ~1s left, check eligibility and start burst
      if (secsLeft <= 1.6 && secsLeft > 0.2 && auto99State.firedSlug !== btc5mState.eventSlug) {
        const eligibleSide = check99Eligible(auto99State.priceLog);
        if (eligibleSide) {
          auto99State.firedSlug = btc5mState.eventSlug;
          console.log(`[btc-auto-99] ELIGIBLE: ${eligibleSide} >96¢ for 10s — starting burst`);
          startBurstFire('btc', btc5mState, btc5mEvent, auto99State.priceLog, 'firedSlug');
        }
      }
    } catch (e) { console.error('[auto-99] tick error:', e.message); }
    schedule99Tick();
  }, 1000);
}
schedule99Tick();

// Auto-99 for extra coins — same logic, sequential setTimeout
function scheduleExtra99Tick() {
  setTimeout(async () => {
    try {
      if (!auto99State.enabled || !clobClient) { scheduleExtra99Tick(); return; }

      const now = Date.now();
      for (const coin of EXTRA_5M_COINS) {
        const e = extra5m[coin];
        if (!e.state.eventSlug || !e.event?.endDate) continue;

        const up = e.state.upPrice, down = e.state.downPrice;
        if (up == null || down == null) continue;

        const winningSide = up > down ? 'up' : 'down';
        const winningPrice = Math.max(up, down);

        // Log sane prices
        if (up + down < 1.5) {
          e.priceLog.push({ t: now, winner: winningPrice, side: winningSide });
        }
        e.priceLog = e.priceLog.filter(p => now - p.t < 30000);

        const secsLeft = Math.max(0, (new Date(e.event.endDate).getTime() - now) / 1000);

        // When ~1s left, check and burst
        if (secsLeft <= 1.6 && secsLeft > 0.2 && e.firedSlug !== e.state.eventSlug) {
          const eligibleSide = check99Eligible(e.priceLog);
          if (eligibleSide) {
            e.firedSlug = e.state.eventSlug;
            console.log(`[${coin}-auto-99] ELIGIBLE: ${eligibleSide} >96¢ for 10s — starting burst`);
            startBurstFire(coin, e.state, e.event, e.priceLog, 'firedSlug');
          }
        }
      }
    } catch (e) { console.error('[extra-auto-99] tick error:', e.message); }
    scheduleExtra99Tick();
  }, 1000);
}
scheduleExtra99Tick();

// BTC 5m snapshots — capture every 5s
function push5mSnapshot() {
  if (!btc5mState.eventSlug) return;
  if (btc5mState.upPrice == null && btc5mState.downPrice == null) return;
  const endDate = btc5mEvent?.endDate ? new Date(btc5mEvent.endDate) : null;
  const secsLeft = endDate ? Math.max(0, Math.floor((endDate - Date.now()) / 1000)) : null;
  btc5mSnapshotBuffer.push({
    event_slug: btc5mState.eventSlug,
    btc_price: liveState.binanceBtc,
    up_cost: btc5mState.upPrice,
    down_cost: btc5mState.downPrice,
    observed_at: new Date().toISOString(),
    seconds_left: secsLeft,
  });
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
        // Update EMA BEFORE broadcasting so UI gets fresh values
        if (changed) {
          updateServerEma(newPrice);
        }
        const fGap = (serverEma.fE12 ?? 0) - (serverEma.fE26 ?? 0);
        // Compute current velocity for UI
        const velOldest = _btcTicks.length > 0 ? _btcTicks[0] : null;
        const velocity = velOldest ? newPrice - velOldest.price : 0;
        broadcast({ type: 'binance_btc', price: newPrice, velocity, ema: { e12: serverEma.fE12, e26: serverEma.fE26, gap: fGap, histogram: serverEma.fHistogram } });
        if (changed) {
          // Compute BTC EMA cross ONCE — shared by both BTC and ETH strategies
          const prevFGap = serverEma._prevFGap ?? 0;
          const btcEmaCrossed = (prevFGap <= 0 && fGap > 0) || (prevFGap >= 0 && fGap < 0);
          serverEma._prevFGap = fGap;

          checkEmaTrigger(btcEmaCrossed, fGap);
          checkEmaHedge();
          checkEthVelocityTrigger();
          checkEthEmaTrigger(btcEmaCrossed, fGap);
          checkEthEmaHedge();
        }
        // if (changed) pushSnapshot(); // paused
        // Auto-scalp: $threshold BTC move arms, then wait 500ms of stability to fire
        if (changed && autoScalp.enabled && !autoScalp.busy && activeEvent && liveState.btcStart != null) {
          const ref = autoScalp.lastTriggerPrice ?? liveState.btcStart;
          const delta = newPrice - ref;
          const thresh = autoScalp.threshold || 5;
          const absDelta = Math.abs(delta);
          const winningPrice = liveState.upPrice != null && liveState.downPrice != null
            ? Math.max(liveState.upPrice, liveState.downPrice) : null;
          const winMin = (autoScalp.winningPriceMin ?? 30) / 100;
          const winMax = (autoScalp.winningPriceMax ?? 60) / 100;
          const inRange = winningPrice != null && winningPrice >= winMin && winningPrice <= winMax;
          if (!inRange) {
            autoScalp._armed = false;
            if (autoScalp._settleTimer) { clearTimeout(autoScalp._settleTimer); autoScalp._settleTimer = null; }
            if (Date.now() - autoScalpLastDiagLog > 60000) {
              autoScalpLastDiagLog = Date.now();
              console.log(`[AUTO-SCALP] No trigger: winning side ${winningPrice != null ? (winningPrice * 100).toFixed(0) : '?'}¢ outside ${(winMin*100).toFixed(0)}–${(winMax*100).toFixed(0)}¢`);
            }
          } else if (absDelta < thresh) {
            autoScalp._armed = false;
            if (autoScalp._settleTimer) { clearTimeout(autoScalp._settleTimer); autoScalp._settleTimer = null; }
            if (Date.now() - autoScalpLastDiagLog > 60000) {
              autoScalpLastDiagLog = Date.now();
              console.log(`[AUTO-SCALP] No trigger: delta=$${delta.toFixed(1)} (need $${thresh}+) | ref=$${ref?.toFixed(0)} btc=$${newPrice.toFixed(0)}`);
            }
          } else {
            // Threshold hit — arm and reset 500ms settle timer on every tick
            if (!autoScalp._armed) {
              autoScalp._armed = true;
              console.log(`[AUTO-SCALP] ARMED — BTC $${delta >= 0 ? '+' : ''}${delta.toFixed(0)} from ref, waiting for settle...`);
            }
            autoScalp._armedDelta = delta;
            if (autoScalp._settleTimer) clearTimeout(autoScalp._settleTimer);
            autoScalp._settleTimer = setTimeout(() => {
              autoScalp._settleTimer = null;
              autoScalp._armed = false;
              if (autoScalp.busy || !autoScalp.enabled) return;
              autoScalp.busy = true; // LOCK immediately
              const finalDelta = autoScalp._armedDelta;
              const triggerSide = finalDelta > 0 ? 'up' : 'down';
              autoScalp.lastTriggerTime = Date.now();
              const logEntry = { ts: Date.now(), side: triggerSide, btc: liveState.binanceBtc, delta: Math.round(finalDelta) };
              autoScalp.log = [logEntry, ...autoScalp.log].slice(0, 20);
              console.log(`[AUTO-SCALP] SETTLED — firing. BTC $${finalDelta >= 0 ? '+' : ''}${finalDelta.toFixed(0)} from ref $${ref.toFixed(0)} (Up=${(liveState.upPrice*100).toFixed(0)}¢ Dn=${(liveState.downPrice*100).toFixed(0)}¢)`);
              broadcast({ type: 'auto_scalp', status: 'triggered', side: triggerSide, delta: Math.round(finalDelta), btc: liveState.binanceBtc });
              fireAutoScalp(triggerSide);
            }, 500);
          }
        }
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

// ── Auto-scalp fire function ─────────────────────────────────────────────
// 1. Fetch market (best ask) for winning side
// 2. FAK buy at (ask - 1¢) to ensure fill (aggressive taker)
// 3. GTC sell at (ask + 3¢) — lock in ≥2¢ profit when filled
// 4. Send both via postOrders at the same time
function _autoScalpAbort() {
  autoScalp.busy = false;
  autoScalp.upOrderId = null;
  autoScalp.downOrderId = null;
  autoScalp.unhedged = null;
  if (liveState.binanceBtc != null) {
    autoScalp.lastTriggerPrice = liveState.binanceBtc;
    autoScalp.lastTriggerTime = Date.now();
  }
}

async function fireAutoScalp(side) {
  if (!clobClient || !activeEvent) { _autoScalpAbort(); return; }
  if (isNoTradeZone()) { console.log('[AUTO-SCALP] Skipping — no-trade zone (first 15s / last 45s)'); _autoScalpAbort(); return; }
  const upTokenId = liveState.tokenUp;
  const downTokenId = liveState.tokenDown;
  if (!upTokenId || !downTokenId) { _autoScalpAbort(); return; }
  const tickSize = activeEvent.tickSize || '0.01';
  const tick = parseFloat(tickSize);
  const negRisk = activeEvent.negRisk || false;
  const sizeShares = autoScalp.shares;

  try {
    // Use KS prices instead of Poly
    const upMarket = liveState.upPrice;
    const downMarket = liveState.downPrice;
    if (!upMarket || upMarket <= 0 || !downMarket || downMarket <= 0) { _autoScalpAbort(); return; }

    // Winning side (higher price) → -1¢, losing side (hammered) → -3¢
    const upWinning = upMarket >= downMarket;
    const upDiscount = upWinning ? 0.01 : 0.03;
    const downDiscount = upWinning ? 0.03 : 0.01;
    const upBuyPriceCents = Math.max(1, Math.min(Math.round((upMarket - upDiscount) * 100), 99));
    const downBuyPriceCents = Math.max(1, Math.min(Math.round((downMarket - downDiscount) * 100), 99));
    const totalCost = upBuyPriceCents + downBuyPriceCents;
    const profitCentsActual = 100 - totalCost;

    if (profitCentsActual <= 0) { _autoScalpAbort(); return; }

    console.log(`[AUTO-SCALP] KS GTC YES ${sizeShares}sh @ ${upBuyPriceCents}¢ + NO @ ${downBuyPriceCents}¢ (mkt ${(upMarket*100).toFixed(0)}/${(downMarket*100).toFixed(0)}¢, +${profitCentsActual}¢)`);

    // Place both KS limit orders via internal API
    const [upRes, downRes] = await Promise.all([
      fetch(`http://localhost:${process.env.PORT || 3001}/api/ks-limit`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ side: 'yes', shares: sizeShares, priceCents: upBuyPriceCents }),
      }).then(r => r.json()).catch(() => ({})),
      fetch(`http://localhost:${process.env.PORT || 3001}/api/ks-limit`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ side: 'no', shares: sizeShares, priceCents: downBuyPriceCents }),
      }).then(r => r.json()).catch(() => ({})),
    ]);

    const upOk = upRes?.ok;
    const downOk = downRes?.ok;
    let upId = upRes?.orderId;
    let downId = downRes?.orderId;
    const upBuyPrice = upBuyPriceCents / 100;
    const downBuyPrice = downBuyPriceCents / 100;

    if (!upOk && !downOk) { _autoScalpAbort(); return; }

    autoScalp.lastTriggerPrice = liveState.binanceBtc;
    autoScalp.upOrderId = upId;
    autoScalp.downOrderId = downId;
    autoScalp.unhedged = { shares: sizeShares, upBuyPrice, downBuyPrice, ts: Date.now() };
    broadcast({ type: 'auto_scalp', status: 'placed', upBuyPrice, downBuyPrice, sizeShares, profitCents: profitCentsActual });

    if (upOk && upId) {
      supabase.from('polymarket_trades').insert({
        polymarket_event_id: eventDbId(), direction: 'up',
        purchase_price: upBuyPrice, purchase_amount: Math.round(sizeShares * upBuyPrice * 100) / 100,
        purchase_time: new Date().toISOString(), minute: Math.floor(Date.now() / 60000),
        btc_price_at_purchase: liveState.btcCurrent, order_type: 'live',
        order_status: 'open', polymarket_order_id: upId, shares: sizeShares,
        notes: JSON.stringify({ type: 'auto-scalp-up', upBuyPrice, sizeShares }),
      }).then(({ error: dbErr }) => { if (dbErr) console.error('[AUTO-SCALP] DB error (up):', dbErr); });
    }
    if (downOk && downId) {
      supabase.from('polymarket_trades').insert({
        polymarket_event_id: eventDbId(), direction: 'down',
        purchase_price: downBuyPrice, purchase_amount: Math.round(sizeShares * downBuyPrice * 100) / 100,
        purchase_time: new Date().toISOString(), minute: Math.floor(Date.now() / 60000),
        btc_price_at_purchase: liveState.btcCurrent, order_type: 'live',
        order_status: 'open', polymarket_order_id: downId, shares: sizeShares,
        notes: JSON.stringify({ type: 'auto-scalp-down', downBuyPrice, sizeShares, profitCentsActual }),
      }).then(({ error: dbErr }) => { if (dbErr) console.error('[AUTO-SCALP] DB error (down):', dbErr); });
    }

    console.log(`[AUTO-SCALP] GTC UP @ ${(upBuyPrice*100).toFixed(0)}¢ + GTC DN @ ${(downBuyPrice*100).toFixed(0)}¢ → ${profitCentsActual}¢ profit when both fill`);

    // Chase logic: after 4s, if one filled but other hasn't, cancel & re-place at market-1¢
    let chased = false;
    setTimeout(async () => {
      if (chased) return;
      try {
        const raw = await clobClient.getOpenOrders();
        const list = Array.isArray(raw) ? raw : (raw?.data ?? raw?.orders ?? []);
        const oid = o => o?.id ?? o?.order_id ?? o?.orderID ?? o?.orderId;
        const upStill = upId && list.some(o => oid(o) === upId);
        const downStill = downId && list.some(o => oid(o) === downId);

        if (!upStill && !downStill) return; // both filled already
        if (upStill && downStill) return; // neither filled, keep waiting

        chased = true;
        const unfilledSide = upStill ? 'up' : 'down';
        const unfilledId = upStill ? upId : downId;
        const unfilledTokenId = upStill ? upTokenId : downTokenId;

        console.log(`[AUTO-SCALP] Chase ${unfilledSide} — canceling and re-placing at market-1¢`);
        try { await clobClient.cancelOrder({ orderID: unfilledId }); } catch (ce) { console.error('[AUTO-SCALP] Cancel error:', ce.message); }

        const mkt = await fetchClobBidAsk(unfilledTokenId);
        const marketPrice = mkt.bestAsk ?? (upStill ? liveState.upPrice : liveState.downPrice);
        const chasePrice = Math.max(0.01, Math.min(Math.round((marketPrice - 0.01) / tick) * tick, 0.99));
        const filledPrice = upStill ? downBuyPrice : upBuyPrice;
        const chaseTotalCost = Math.round((filledPrice + chasePrice) * 100);
        if (chaseTotalCost >= 100) {
          console.log(`[AUTO-SCALP] Chase SKIP — would lock loss: ${chaseTotalCost}¢ total. Aborting.`);
          _autoScalpAbort();
          return;
        }

        console.log(`[AUTO-SCALP] Chase ${unfilledSide} @ ${(chasePrice*100).toFixed(0)}¢ (mkt ${(marketPrice*100).toFixed(0)}¢)`);
        const chaseOrder = await clobClient.createOrder({ tokenID: unfilledTokenId, price: chasePrice, size: sizeShares, side: 'BUY' }, { tickSize, negRisk });
        const chaseResult = await clobClient.postOrders([{ order: chaseOrder, orderType: 'GTC' }]);
        const chaseArr = Array.isArray(chaseResult) ? chaseResult : (chaseResult?.responses || [chaseResult] || []);
        const newId = chaseArr[0]?.orderID ?? chaseArr[0]?.order_id;

        if (upStill) { upId = newId; autoScalp.upOrderId = newId; }
        else { downId = newId; autoScalp.downOrderId = newId; }
        broadcast({ type: 'auto_scalp', status: 'chasing', side: unfilledSide, chasePrice });
      } catch (e) {
        console.error('[AUTO-SCALP] Chase error:', e.message);
      }
    }, 4000);

    // Poll until BOTH fill
    const pollBoth = setInterval(async () => {
      try {
        const raw = await clobClient.getOpenOrders();
        const list = Array.isArray(raw) ? raw : (raw?.data ?? raw?.orders ?? []);
        const oid = o => o?.id ?? o?.order_id ?? o?.orderID ?? o?.orderId;
        const upStill = upId && (list || []).some(o => oid(o) === upId);
        const downStill = downId && (list || []).some(o => oid(o) === downId);
        if (!upStill && !downStill) {
          console.log(`[AUTO-SCALP] Both filled — profit locked`);
          broadcast({ type: 'auto_scalp', status: 'filled', profit: chased ? '~1¢ (chased)' : profitCentsActual });
          _autoScalpAbort(); // releases busy lock
          clearInterval(pollBoth);
        }
      } catch (e) {
        console.error('[AUTO-SCALP] Poll error:', e.message);
      }
    }, 3000);
  } catch (e) {
    console.error('[AUTO-SCALP] Error:', e?.message ?? e);
    broadcast({ type: 'auto_scalp', status: 'error', error: e?.message });
    _autoScalpAbort();
  }
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
  const nextSlot = (Math.floor(nowSecs / 900) + 1) * 900;

  // If locked to 1h only, skip 15m splits — schedule hourly splits instead
  if (!autoSplit.enabled || !k9Copy.enabled || k9Copy.eventTime === '1h') {
    const delay = (nextSlot * 1000) - now + 2000;
    eventTimer = setTimeout(refreshEvent, delay);
    // Schedule hourly pre-split if in 1h mode
    if (k9Copy.eventTime === '1h' && autoSplit.enabled && k9Copy.enabled) {
      scheduleHourlySplit();
    }
    return;
  }

  // Pre-split: 15s BEFORE the next 15m boundary — retry every 2s until event is available
  const PRE_SPLIT_START_SECONDS = 15;
  const PRE_SPLIT_RETRY_MS = 2000;
  const preSplitStartDelay = (nextSlot * 1000) - now - (PRE_SPLIT_START_SECONDS * 1000);

  const runPreSplit = async () => {
    const upcomingSlug = `btc-updown-15m-${nextSlot}`;
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
      const upcomingSlug = `btc-updown-15m-${nextSlot}`;
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
  if (!oldSlug || !oldSlug.startsWith('btc-updown-15m-')) return;
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

async function refreshEvent(clientBtcOpen) {
  const event = await fetchActiveEvent();
  if (event && event.slug !== liveState.eventSlug) {
    // DISABLED — was killing snipe limit orders on Poly
    // Event-level order cleanup is now handled by the snipe manager
    // Save analysis for the old event before switching
    if (liveState.eventSlug) saveEventAnalysis(liveState.eventSlug);
    // Reset in-memory shares for new event — but keep them if pre-split already ran for this slot
    const newEventSlot = parseInt(String(event.slug).match(/(\d{10,})/)?.[1] || 0);
    if (lastSplitSlot !== newEventSlot) {
      inMemoryShares = { up: 0, down: 0 };
    }
    console.log('[EVENT] new active event:', event.slug);
    // Clear stop-loss on event change — shouldn't carry to new events
    if (stopLossState) {
      console.log('[SL] Clearing stop-loss on event change');
      stopLossState = null;
      stopLossFiring = false;
      saveStopLossToDb(null);
      broadcast({ type: 'stop_loss', armed: false });
    }
    // Reset auto-scalp/flow/ema busy locks on event change
    _autoScalpAbort();
    _autoFlowAbort();
    _autoEmaAbort();
    autoEma.lastHedgeTime = 0; // new event = fresh episode
    resetServerEma();
    autoScalp.lastTriggerPrice = null; // reset reference on event change
    liveState.eventSlug = event.slug;
    liveState.eventTitle = event.title;
    liveState.tokenUp = event.tokenUp;
    liveState.tokenDown = event.tokenDown;
    // Fire auto-lost orders for new event (delay so CLOB prices settle)
    setTimeout(() => fireAutoLost(), 3000);
    liveState.upPrice = null;
    liveState.downPrice = null;
    liveState.upStartPrice = null;
    liveState.downStartPrice = null;
    // Capture BTC open price — prefer client-provided (from Binance REST on client),
    // then try server-side Binance REST, then fall back to cached values
    let freshBtc = clientBtcOpen || null;
    if (!freshBtc) {
      try {
        const binRes = await fetch('https://api.binance.com/api/v3/ticker/price?symbol=BTCUSDT');
        const binData = await binRes.json();
        if (binData?.price) freshBtc = parseFloat(binData.price);
      } catch {}
    }
    if (!freshBtc) freshBtc = liveState.binanceBtc || liveState.btcCurrent;
    liveState.btcStart = freshBtc;
    liveState.binanceBtc = freshBtc; // update cached value too
    cachedOpenPrice = { slug: null, btc: null, up: null, down: null }; // invalidate cache for /api/event
    activeEvent = event;
    resetServerEma();
    seedServerEma(); // seed EMA from Binance history so it doesn't start cold
    broadcast({ type: 'event', event });
    // Save open price to database
    try {
      await supabase.from('polymarket_15m_snapshots').insert({
        event_slug: event.slug,
        btc_price: liveState.btcCurrent,
        coin_price: freshBtc,
        up_cost: null,
        down_cost: null,
        observed_at: new Date().toISOString(),
        seconds_left: 300,
        coin: 'btc',
      });
      console.log(`[EVENT] Saved open BTC=$${freshBtc} for ${event.slug}`);
    } catch (e) { console.error('[EVENT] Failed to save open:', e.message); }
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
      // Try KS 15m prices first (more accurate), fall back to Poly CLOB
      let upPrice = null, downPrice = null;
      try {
        const ksRes = await fetch(`http://localhost:${process.env.PORT || 3001}/api/arb/ks-price/btc`);
        if (ksRes.ok) {
          const ks = await ksRes.json();
          if (ks.yesAsk && ks.noAsk) {
            upPrice = ks.yesAsk;    // KS YES = UP
            downPrice = ks.noAsk;   // KS NO = DOWN
          }
        }
      } catch {}
      // Fallback to Poly CLOB if KS not available
      if (upPrice == null || downPrice == null) {
        const [polyUp, polyDown] = await Promise.all([
          fetchClobPrice(liveState.tokenUp),
          fetchClobPrice(liveState.tokenDown),
        ]);
        if (upPrice == null) upPrice = polyUp;
        if (downPrice == null) downPrice = polyDown;
      }
      let changed = false;
      if (upPrice != null && upPrice !== liveState.upPrice) { liveState.upPrice = upPrice; changed = true; }
      if (downPrice != null && downPrice !== liveState.downPrice) { liveState.downPrice = downPrice; changed = true; }
      if (liveState.upStartPrice == null && upPrice != null) liveState.upStartPrice = upPrice;
      if (liveState.downStartPrice == null && downPrice != null) liveState.downStartPrice = downPrice;
      if (changed) broadcast({ type: 'prices', ...liveState });

      // ── Server-side stop-loss trigger check ───────────────────────────
      if (stopLossState && !stopLossFiring && clobClient && activeEvent) {
        const watchPrice = stopLossState.side === 'up' ? liveState.upPrice : liveState.downPrice;
        if (watchPrice != null && watchPrice * 100 >= stopLossState.trigger) {
          const sl = stopLossState;
          stopLossState = null; // clear immediately
          stopLossFiring = true;
          console.log(`[SL] TRIGGERED — ${sl.shares}sh ${sl.side} @ ${(watchPrice * 100).toFixed(0)}¢ ≥ ${sl.trigger}¢`);
          saveStopLossToDb(null); // clear from DB
          const tokenId = sl.side === 'up' ? liveState.tokenUp : liveState.tokenDown;
          if (tokenId) {
            try {
              const tickSize = activeEvent.tickSize || '0.01';
              const signedOrder = await clobClient.createOrder({
                tokenID: tokenId, price: 0.99, size: Math.max(5, sl.shares), side: 'BUY',
              }, { tickSize, negRisk: activeEvent.negRisk || false });
              const result = await clobClient.postOrder(signedOrder, 'FAK');
              console.log(`[SL] FAK order filled:`, result?.orderID || result);
              broadcast({ type: 'stop_loss', armed: false, fired: true, side: sl.side, shares: sl.shares, orderID: result?.orderID });
            } catch (e) {
              console.error('[SL] FAK order error:', e?.message ?? e);
              broadcast({ type: 'stop_loss', armed: false, fired: true, error: e?.message });
            }
          }
          stopLossFiring = false;
        }
      }
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
  const { side, amount, limitPrice, shares: reqShares } = req.body;

  if (!activeEvent) return res.status(400).json({ error: 'No active event' });
  if (!['up', 'down'].includes(side)) return res.status(400).json({ error: 'Invalid side' });
  if (!clobClient) return res.status(500).json({ error: 'CLOB client not ready' });

  const price = side === 'up' ? liveState.upPrice : liveState.downPrice;
  const tokenId = side === 'up' ? liveState.tokenUp : liveState.tokenDown;

  if (!price) return res.status(400).json({ error: 'No price available' });
  if (!tokenId) return res.status(400).json({ error: 'No token ID' });

  const tickSize = activeEvent.tickSize || '0.01';
  const tick = parseFloat(tickSize);
  // Use explicit limitPrice if provided, otherwise current price (rounds to tick)
  const buyPrice = limitPrice
    ? Math.max(0.01, Math.min(Math.round(Math.round(parseFloat(limitPrice) * 100) / 100 / tick) * tick, 0.99))
    : Math.min(Math.round(Math.round(price * 100) / 100 / tick) * tick, 0.99);
  // Use explicit shares if provided, otherwise compute from amount (min 5)
  const sizeUsd = Math.round((amount || 0) * 100) / 100;
  const sizeShares = reqShares ? Math.max(5, Math.round(parseFloat(reqShares))) : Math.max(5, Math.ceil((sizeUsd / buyPrice) * 100) / 100);

  const endDate = activeEvent.endDate ? new Date(activeEvent.endDate) : null;
  const timeLeftSecs = endDate ? Math.max(0, Math.floor((endDate - Date.now()) / 1000)) : null;

  // Respond instantly — fire order in background
  res.json({
    success: true, error: null,
    price: buyPrice, shares: sizeShares,
    purchase_amount: Math.round(sizeShares * buyPrice * 100) / 100,
    status: 'sending',
    snapshot: { upPrice: liveState.upPrice, downPrice: liveState.downPrice, btcPrice: liveState.btcCurrent, timeLeftSecs },
  });

  // Fire-and-forget: sign, post, record
  (async () => {
    try {
      const t0 = Date.now();
      const signedOrder = await clobClient.createOrder({
        tokenID: tokenId, price: buyPrice, size: sizeShares, side: 'BUY',
      }, { tickSize, negRisk: activeEvent.negRisk || false });
      const result = await clobClient.postOrder(signedOrder, 'GTC');
      console.log(`[BUY] Posted in ${Date.now() - t0}ms — id:`, result?.orderID || result);

      const tradeData = {
        polymarket_event_id: eventDbId(), direction: side,
        purchase_price: buyPrice, purchase_amount: Math.round(sizeShares * buyPrice * 100) / 100,
        purchase_time: new Date().toISOString(), minute: Math.floor(Date.now() / 60000),
        btc_price_at_purchase: liveState.btcCurrent, order_type: 'live',
        order_status: result?.orderID ? 'open' : 'failed',
        polymarket_order_id: result?.orderID || `live-${Date.now()}`,
        shares: sizeShares,
        notes: JSON.stringify({ tokenId, eventTitle: liveState.eventTitle, upPriceAtBuy: liveState.upPrice, downPriceAtBuy: liveState.downPrice, timeLeftSecs, orderType: 'GTC' }),
      };
      supabase.from('polymarket_trades').insert(tradeData).select().single()
        .then(({ error: dbErr }) => { if (dbErr) console.error('[BUY] DB error:', dbErr); });

      broadcast({ type: 'order', status: 'placed', side, price: buyPrice, shares: sizeShares, orderID: result?.orderID });
    } catch (e) {
      console.error('[BUY] Error:', e?.message ?? e);
      broadcast({ type: 'order', status: 'failed', side, price: buyPrice, error: e?.message });
    }
  })();
});

// ── Scalp: GTC BUY clicked side @ market, GTC BUY opposite @ 100-market-profit ──
// ── Lost strategy: buy cheap side at 2¢, sell at 7¢ ─────────────────────────
app.get('/api/auto-lost', (req, res) => {
  res.json({
    enabled: autoLost.enabled,
    side: autoLost.side,
    shares: autoLost.shares,
    buyPrice: autoLost.buyPrice,
    sellPrice: autoLost.sellPrice,
    lastEventSlug: autoLost.lastEventSlug,
    log: autoLost.log.slice(0, 10),
  });
});

app.post('/api/auto-lost', (req, res) => {
  const { enabled, side, shares, buyPrice, sellPrice } = req.body || {};
  if (typeof enabled === 'boolean') autoLost.enabled = enabled;
  if (side && ['up', 'down', 'both'].includes(side)) autoLost.side = side;
  if (shares) autoLost.shares = Math.max(1, Math.round(shares));
  if (buyPrice) autoLost.buyPrice = Math.max(0.01, Math.min(parseFloat(buyPrice), 0.10));
  if (sellPrice) autoLost.sellPrice = Math.max(0.02, Math.min(parseFloat(sellPrice), 0.20));
  console.log(`[AUTO-LOST] ${autoLost.enabled ? 'ENABLED' : 'DISABLED'} — side=${autoLost.side} ${autoLost.shares}sh buy@${(autoLost.buyPrice*100).toFixed(0)}¢ sell@${(autoLost.sellPrice*100).toFixed(0)}¢`);
  broadcast({ type: 'auto_lost', status: autoLost.enabled ? 'enabled' : 'disabled', side: autoLost.side });
  res.json({ success: true, ...autoLost, log: autoLost.log.slice(0, 10) });
});

app.post('/api/lost-scalp', async (req, res) => {
  try {
    const { side } = req.body || {};
    if (!activeEvent) return res.status(400).json({ error: 'No active event' });
    if (!['up', 'down'].includes(side)) return res.status(400).json({ error: 'Invalid side' });
    if (!clobClient) return res.status(500).json({ error: 'CLOB client not ready' });

    const tokenId = side === 'up' ? liveState.tokenUp : liveState.tokenDown;
    if (!tokenId) return res.status(400).json({ error: 'No token ID' });

    const tickSize = activeEvent.tickSize || '0.01';
    const negRisk = activeEvent.negRisk || false;
    const shares = 10;
    const buyPrice = 0.02;
    const sellPrice = 0.07;

    console.log(`[LOST] GTC BUY ${side.toUpperCase()} ${shares}sh @ 2¢ + GTC SELL @ 7¢`);

    const buyOrder = await clobClient.createOrder({ tokenID: tokenId, price: buyPrice, size: shares, side: 'BUY' }, { tickSize, negRisk });
    const sellOrder = await clobClient.createOrder({ tokenID: tokenId, price: sellPrice, size: shares, side: 'SELL' }, { tickSize, negRisk });

    const results = await clobClient.postOrders([
      { order: buyOrder, orderType: 'GTC' },
      { order: sellOrder, orderType: 'GTC' },
    ]);
    const arr = Array.isArray(results) ? results : (results?.responses || [results] || []);

    console.log(`[LOST] Orders placed — buy=${arr[0]?.orderID?.slice(0,8)} sell=${arr[1]?.orderID?.slice(0,8)}`);
    res.json({ success: true, buy: arr[0], sell: arr[1] });
  } catch (e) {
    console.error('[LOST] Error:', e?.message ?? e);
    res.status(500).json({ error: e?.message });
  }
});

// Buy at X, auto-sell at X+3¢
app.post('/api/buy-sell', async (req, res) => {
  try {
    const { side, price, shares: reqShares, profitCents: reqProfit } = req.body || {};
    if (!activeEvent) return res.status(400).json({ error: 'No active event' });
    if (!['up', 'down'].includes(side)) return res.status(400).json({ error: 'Invalid side' });
    if (!clobClient) return res.status(500).json({ error: 'CLOB client not ready' });
    if (!price || price <= 0 || price >= 1) return res.status(400).json({ error: 'Invalid price' });

    const tokenId = side === 'up' ? liveState.tokenUp : liveState.tokenDown;
    if (!tokenId) return res.status(400).json({ error: 'No token ID' });

    const tickSize = activeEvent.tickSize || '0.01';
    const tick = parseFloat(tickSize);
    const negRisk = activeEvent.negRisk || false;
    const sizeShares = Math.max(1, Math.round(parseFloat(reqShares) || 5));
    const profit = parseFloat(reqProfit) || 3;
    const buyPrice = Math.round(price / tick) * tick;
    const sellPrice = Math.max(0.01, Math.min(Math.round((buyPrice + profit / 100) / tick) * tick, 0.99));

    console.log(`[BUY-SELL] GTC BUY ${side.toUpperCase()} ${sizeShares}sh @ ${(buyPrice*100).toFixed(0)}¢ + GTC SELL @ ${(sellPrice*100).toFixed(0)}¢ (+${profit}¢)`);

    const buyOrder = await clobClient.createOrder({ tokenID: tokenId, price: buyPrice, size: sizeShares, side: 'BUY' }, { tickSize, negRisk });
    const sellOrder = await clobClient.createOrder({ tokenID: tokenId, price: sellPrice, size: sizeShares, side: 'SELL' }, { tickSize, negRisk });

    const results = await clobClient.postOrders([
      { order: buyOrder, orderType: 'GTC' },
      { order: sellOrder, orderType: 'GTC' },
    ]);
    const arr = Array.isArray(results) ? results : (results?.responses || [results] || []);

    console.log(`[BUY-SELL] Orders placed — buy=${arr[0]?.orderID?.slice(0,8)} sell=${arr[1]?.orderID?.slice(0,8)}`);
    res.json({ success: true, buyPrice, sellPrice, profit, shares: sizeShares, buy: arr[0], sell: arr[1] });
  } catch (e) {
    console.error('[BUY-SELL] Error:', e?.message ?? e);
    res.status(500).json({ error: e?.message });
  }
});

// S↑ 1¢: Buy Up @ current, Buy Down @ (100 - upPrice - 1)¢ → 1¢ profit
// S↓ 5¢: Buy Down @ current, Buy Up @ (100 - downPrice - 5)¢ → 5¢ profit
app.post('/api/scalp', async (req, res) => {
  if (isNoTradeZone()) return res.json({ ok: false, error: 'No-trade zone (first 15s / last 45s)' });
  try {
    const { side, shares: reqShares, profitCents } = req.body || {};
    const profit = parseInt(profitCents) || 2;

    if (!activeEvent) return res.status(400).json({ error: 'No active event' });
    if (!['up', 'down'].includes(side)) return res.status(400).json({ error: 'Invalid side' });
    if (!clobClient) return res.status(500).json({ error: 'CLOB client not ready' });

    const mainTokenId = side === 'up' ? liveState.tokenUp : liveState.tokenDown;
    const oppSide = side === 'up' ? 'down' : 'up';
    const oppTokenId = side === 'up' ? liveState.tokenDown : liveState.tokenUp;
    if (!mainTokenId || !oppTokenId) return res.status(400).json({ error: 'No token IDs' });

    const tickSize = activeEvent.tickSize || '0.01';
    const tick = parseFloat(tickSize);
    const negRisk = activeEvent.negRisk || false;
    const sizeShares = Math.max(5, Math.round(parseFloat(reqShares) || 5));

    // Fetch current market for clicked side
    const mainMkt = await fetchClobBidAsk(mainTokenId);
    const mainMarket = mainMkt.bestAsk ?? (side === 'up' ? liveState.upPrice : liveState.downPrice);
    if (!mainMarket || mainMarket <= 0) return res.status(400).json({ error: 'No market price' });

    // Main side: GTC at market + 1¢ (ensures fill)
    const mainBuyPrice = Math.max(0.01, Math.min(Math.round((mainMarket + 0.01) / tick) * tick, 0.99));
    // Opposite side: GTC at 100 - mainPrice - profit (guarantees profitCents when both fill)
    const oppBuyPrice = Math.max(0.01, Math.min(Math.round((1.00 - mainBuyPrice - profit / 100) / tick) * tick, 0.99));
    const totalCost = Math.round((mainBuyPrice + oppBuyPrice) * 100);
    const profitCentsActual = 100 - totalCost;

    if (profitCentsActual <= 0) return res.status(400).json({ error: `No profit: ${(mainBuyPrice*100).toFixed(0)}+${(oppBuyPrice*100).toFixed(0)}=${totalCost}¢ ≥100¢` });

    res.json({
      success: true,
      main: { price: mainBuyPrice, shares: sizeShares, side },
      opp: { price: oppBuyPrice, shares: sizeShares, side: oppSide },
      profitCents: profitCentsActual,
      status: 'sending',
    });

    // Fire-and-forget: send both GTC limit orders
    (async () => {
    try {
      const t0 = Date.now();
      console.log(`[SCALP] GTC BUY ${side.toUpperCase()} ${sizeShares}sh @ ${(mainBuyPrice*100).toFixed(0)}¢ + GTC BUY ${oppSide.toUpperCase()} @ ${(oppBuyPrice*100).toFixed(0)}¢ (mkt ${(mainMarket*100).toFixed(0)}¢, +${profitCentsActual}¢)`);
      const mainOrder = await clobClient.createOrder({ tokenID: mainTokenId, price: mainBuyPrice, size: sizeShares, side: 'BUY' }, { tickSize, negRisk });
      const oppOrder = await clobClient.createOrder({ tokenID: oppTokenId, price: oppBuyPrice, size: sizeShares, side: 'BUY' }, { tickSize, negRisk });

      const results = await clobClient.postOrders([
        { order: mainOrder, orderType: 'GTC' },
        { order: oppOrder, orderType: 'GTC' },
      ]);
      const arr = Array.isArray(results) ? results : (results?.responses || [results] || []);
      const mainResult = arr[0];
      const oppResult = arr[1];

      const mainOk = mainResult?.success || mainResult?.status === 'matched' || mainResult?.status === 'live';
      const oppOk = oppResult?.success || oppResult?.status === 'live' || oppResult?.status === 'matched';
      const mainId = mainResult?.orderID ?? mainResult?.order_id;
      const oppId = oppResult?.orderID ?? oppResult?.order_id;

      if (!mainOk && !oppOk) {
        console.error('[SCALP] Both orders failed:', mainResult?.error, oppResult?.error);
        broadcast({ type: 'scalp', status: 'error', error: 'Both orders failed' });
        return;
      }

      // Log to DB
      if (mainOk && mainId) {
        supabase.from('polymarket_trades').insert({
          polymarket_event_id: eventDbId(), direction: side,
          purchase_price: mainBuyPrice, purchase_amount: Math.round(sizeShares * mainBuyPrice * 100) / 100,
          purchase_time: new Date().toISOString(), minute: Math.floor(Date.now() / 60000),
          btc_price_at_purchase: liveState.btcCurrent, order_type: 'live',
          order_status: 'open', polymarket_order_id: mainId, shares: sizeShares,
          notes: JSON.stringify({ type: 'scalp-main', side, mainBuyPrice, sizeShares }),
        }).then(({ error: dbErr }) => { if (dbErr) console.error('[SCALP] DB error (main):', dbErr); });
      }
      if (oppOk && oppId) {
        supabase.from('polymarket_trades').insert({
          polymarket_event_id: eventDbId(), direction: oppSide,
          purchase_price: oppBuyPrice, purchase_amount: Math.round(sizeShares * oppBuyPrice * 100) / 100,
          purchase_time: new Date().toISOString(), minute: Math.floor(Date.now() / 60000),
          btc_price_at_purchase: liveState.btcCurrent, order_type: 'live',
          order_status: 'open', polymarket_order_id: oppId, shares: sizeShares,
          notes: JSON.stringify({ type: 'scalp-opp', oppSide, oppBuyPrice, sizeShares, profitCentsActual }),
        }).then(({ error: dbErr }) => { if (dbErr) console.error('[SCALP] DB error (opp):', dbErr); });
      }

      broadcast({ type: 'scalp', status: 'placed', mainId, oppId, side, oppSide, mainBuyPrice, oppBuyPrice, sizeShares, profit: profitCentsActual });
      console.log(`[SCALP] ${side.toUpperCase()} @ ${(mainBuyPrice*100).toFixed(0)}¢ + ${oppSide.toUpperCase()} @ ${(oppBuyPrice*100).toFixed(0)}¢ → ${profitCentsActual}¢ profit (${Date.now()-t0}ms)`);

      // Poll until BOTH fill
      const pollBoth = setInterval(async () => {
        try {
          const raw = await clobClient.getOpenOrders();
          const list = Array.isArray(raw) ? raw : (raw?.data ?? raw?.orders ?? []);
          const oid = o => o?.id ?? o?.order_id ?? o?.orderID ?? o?.orderId;
          const mainStill = mainId && (list || []).some(o => oid(o) === mainId);
          const oppStill = oppId && (list || []).some(o => oid(o) === oppId);
          if (!mainStill && !oppStill) {
            console.log(`[SCALP] Both orders filled — ${profitCentsActual}¢ profit locked`);
            broadcast({ type: 'scalp', status: 'complete', profit: profitCentsActual });
            clearInterval(pollBoth);
          }
        } catch (e) { console.error('[SCALP] Poll error:', e.message); }
      }, 3000);
    } catch (e) {
      console.error('[SCALP] Error:', e.message);
      broadcast({ type: 'scalp', status: 'error', error: e.message });
    }
    })();
  } catch (e) {
    console.error('[SCALP] Route error:', e.message);
    if (!res.headersSent) res.status(500).json({ error: e.message });
  }
});

// ── Stop-loss config: arm / disarm / query ─────────────────────────────────
app.get('/api/stop-loss-config', (req, res) => {
  res.json({ armed: !!stopLossState, ...(stopLossState || {}) });
});

app.post('/api/stop-loss-config', async (req, res) => {
  const { side, trigger, shares } = req.body;
  if (!['up', 'down'].includes(side)) return res.status(400).json({ error: 'Invalid side' });
  const t = parseInt(trigger);
  if (!t || t < 1 || t > 99) return res.status(400).json({ error: 'Trigger must be 1-99¢' });
  const s = Math.max(5, parseInt(shares) || 5);
  stopLossState = { side, trigger: t, shares: s };
  stopLossFiring = false;
  await saveStopLossToDb(stopLossState);
  console.log(`[SL] ARMED — ${s}sh ${side} ≥${t}¢`);
  broadcast({ type: 'stop_loss', armed: true, ...stopLossState });
  res.json({ armed: true, ...stopLossState });
});

app.delete('/api/stop-loss-config', async (req, res) => {
  stopLossState = null;
  stopLossFiring = false;
  await saveStopLossToDb(null);
  console.log('[SL] DISARMED');
  broadcast({ type: 'stop_loss', armed: false });
  res.json({ armed: false });
});

// ── Stop-loss kill: FAK buy opposite side at 99¢ to sweep the book ──────────
app.post('/api/stop-loss', async (req, res) => {
  const { side, shares } = req.body; // side = 'up' or 'down' — the side to BUY (opposite of your position)

  if (!activeEvent) return res.status(400).json({ error: 'No active event' });
  if (!['up', 'down'].includes(side)) return res.status(400).json({ error: 'Invalid side' });
  if (!clobClient) return res.status(500).json({ error: 'CLOB client not ready' });

  const tokenId = side === 'up' ? liveState.tokenUp : liveState.tokenDown;
  if (!tokenId) return res.status(400).json({ error: 'No token ID' });

  const tickSize = activeEvent.tickSize || '0.01';
  const buyPrice = 0.99;
  const sizeShares = Math.max(5, Math.ceil(parseFloat(shares || 5)));

  try {
    console.log(`[STOP-LOSS] FAK BUY ${sizeShares}sh ${side.toUpperCase()} @ ${buyPrice} (sweep)`);

    const signedOrder = await clobClient.createOrder({
      tokenID: tokenId,
      price: buyPrice,
      size: sizeShares,
      side: 'BUY',
    }, { tickSize, negRisk: activeEvent.negRisk || false });

    const result = await clobClient.postOrder(signedOrder, 'FAK');
    console.log('[STOP-LOSS] Order posted:', result?.orderID || result);

    res.json({ success: true, orderID: result?.orderID, shares: sizeShares, price: buyPrice });
  } catch (e) {
    console.error('[STOP-LOSS] Error:', e?.message ?? e);
    res.status(500).json({ success: false, error: e?.message ?? String(e) });
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
  // Sell at current price - 1¢ (cross the spread to fill immediately)
  const sellPrice = Math.max(Math.round((price - 0.01) / tick) * tick, 0.01);
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

    const dbPromise = supabase.from('polymarket_trades').insert(tradeData).select().single();
    dbPromise.then(({ error: dbErr }) => { if (dbErr) console.error('[SELL] DB error:', dbErr); });

    res.json({
      success: true,
      error: null,
      trade: tradeData,
      order: { orderID: result?.orderID },
      price: sellPrice,
      shares: roundedShares,
      snapshot: {
        upPrice: liveState.upPrice, downPrice: liveState.downPrice,
        btcPrice: liveState.btcCurrent,
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
  const nextSlot = (Math.floor(nowSecs / 900) + 1) * 900;
  const preSplitStartDelay = (nextSlot * 1000) - now - (15 * 1000);
  const refreshDelay = (nextSlot * 1000) - now + 2000;
  const upcomingSlug = `btc-updown-15m-${nextSlot}`;
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

// ── Whale-style buy (limit at best BID - N¢ — opportunistic: rest behind bids, fill only on dips)
app.post('/api/whale-style-buy', async (req, res) => {
  const { side, shares: reqShares, discountCents } = req.body;
  if (!activeEvent) return res.status(400).json({ error: 'No active event' });
  if (!['up', 'down'].includes(side)) return res.status(400).json({ error: 'Invalid side' });
  if (!clobClient) return res.status(500).json({ error: 'CLOB client not ready' });

  const tokenId = side === 'up' ? liveState.tokenUp : liveState.tokenDown;
  if (!tokenId) return res.status(400).json({ error: 'No token ID' });

  const discount = Math.min(10, Math.max(1, parseInt(discountCents, 10) || 2)) / 100;
  const shares = Math.max(5, Math.min(100, parseInt(reqShares, 10) || 5));

  const { bestAsk, bestBid } = await fetchClobBidAsk(tokenId);
  // Use best BID as anchor — place BELOW the front of the queue so we rest behind, fill only on dips
  const anchor = bestBid != null && bestBid > 0 ? bestBid : bestAsk;
  if (!anchor || anchor <= 0) return res.status(400).json({ error: 'Could not fetch best bid/ask' });

  const tickSize = activeEvent.tickSize || '0.01';
  const tick = parseFloat(tickSize);
  const buyPrice = Math.max(0.01, Math.round((anchor - discount) / tick) * tick);

  try {
    console.log(`[WHALE-STYLE] ${side.toUpperCase()} BUY ${shares}@${buyPrice} (bid ${anchor ? (anchor*100).toFixed(0) : '?'}¢ - ${(discount*100).toFixed(0)}¢)`);
    const negRisk = activeEvent.negRisk || false;
    const buyOrder = await clobClient.createOrder({ tokenID: tokenId, price: buyPrice, size: shares, side: 'BUY' }, { tickSize, negRisk });
    const buyResult = await clobClient.postOrder(buyOrder, 'GTC');
    console.log('[WHALE-STYLE] Order posted:', buyResult?.orderID || buyResult);

    const { error: dbErr } = await supabase.from('polymarket_trades').insert({
      polymarket_event_id: eventDbId(), direction: side,
      purchase_price: buyPrice, purchase_amount: shares * buyPrice,
      purchase_time: new Date().toISOString(), btc_price_at_purchase: liveState.btcCurrent,
      order_type: 'live', order_status: buyResult?.orderID ? 'open' : 'failed',
      polymarket_order_id: buyResult?.orderID || `whale-style-${Date.now()}`,
      shares, notes: JSON.stringify({ type: 'whale-style-buy', tokenId, bestBid: anchor, discount, orderType: 'GTC' }),
    });
    if (dbErr) console.error('[WHALE-STYLE] DB error:', dbErr);

    broadcast({ type: 'order', status: 'placed', side, price: buyPrice, shares, orderID: buyResult?.orderID });
    res.json({ success: true, buyPrice, bestBid: anchor, discount, shares, order: { orderID: buyResult?.orderID } });
  } catch (e) {
    console.error('[WHALE-STYLE] Error:', e.message);
    res.status(500).json({ success: false, error: e.message });
  }
});

// ── Whale flip: batch SELL Up + BUY Down in one request (same tx when matched)
app.post('/api/whale-flip', async (req, res) => {
  const { sellUp, buyDown } = req.body;
  if (!activeEvent) return res.status(400).json({ error: 'No active event' });
  if (!clobClient) return res.status(500).json({ error: 'CLOB client not ready' });

  const sellShares = Math.max(5, Math.min(100, parseFloat(sellUp) || 5));
  const buyShares = Math.max(5, Math.min(100, parseFloat(buyDown) || 5));

  const tokenUp = liveState.tokenUp;
  const tokenDown = liveState.tokenDown;
  if (!tokenUp || !tokenDown) return res.status(400).json({ error: 'No token IDs' });

  try {
    const bal = await clobClient.getBalanceAllowance({ asset_type: 'CONDITIONAL', token_id: tokenUp });
    const held = parseFloat(bal?.balance || '0') / 1e6;
    if (held < sellShares) return res.status(400).json({ error: `Only ${held.toFixed(1)} Up, need ${sellShares}` });
  } catch (e) {
    console.warn('[WHALE-FLIP] Balance check failed:', e.message);
  }

  const tickSize = activeEvent.tickSize || '0.01';
  const tick = parseFloat(tickSize);
  const negRisk = activeEvent.negRisk || false;

  try {
    const [upBook, downBook] = await Promise.all([
      fetchClobBidAsk(tokenUp),
      fetchClobBidAsk(tokenDown),
    ]);
    const sellPrice = Math.max(0.01, Math.round(((upBook.bestBid || liveState.upPrice || 0.5) - 0.01) / tick) * tick);
    const buyPrice = Math.min(0.99, Math.round(((downBook.bestAsk || liveState.downPrice || 0.5) + 0.01) / tick) * tick);

    const sellOrder = await clobClient.createOrder(
      { tokenID: tokenUp, price: sellPrice, size: sellShares, side: 'SELL' },
      { tickSize, negRisk },
    );
    const buyOrder = await clobClient.createOrder(
      { tokenID: tokenDown, price: buyPrice, size: buyShares, side: 'BUY' },
      { tickSize, negRisk },
    );

    const results = await clobClient.postOrders([
      { order: sellOrder, orderType: 'FAK' },
      { order: buyOrder, orderType: 'FAK' },
    ]);
    const arr = Array.isArray(results) ? results : (results?.responses || [results] || []);

    const sellOk = arr[0]?.success || arr[0]?.status === 'matched';
    const buyOk = arr[1]?.success || arr[1]?.status === 'matched';
    console.log(`[WHALE-FLIP] SELL ${sellShares} Up @ ${sellPrice} (${sellOk ? 'OK' : 'fail'}) | BUY ${buyShares} Down @ ${buyPrice} (${buyOk ? 'OK' : 'fail'})`);

    res.json({
      success: sellOk || buyOk,
      sellUp: { shares: sellShares, price: sellPrice, ok: sellOk, result: arr[0] },
      buyDown: { shares: buyShares, price: buyPrice, ok: buyOk, result: arr[1] },
    });
  } catch (e) {
    console.error('[WHALE-FLIP] Error:', e.message);
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

// ── Auto-scalp toggle + status ───────────────────────────────────────────────
app.get('/api/auto-scalp', (req, res) => {
  res.json({
    enabled: autoScalp.enabled,
    threshold: autoScalp.threshold,
    profitCents: autoScalp.profitCents,
    shares: autoScalp.shares,
    winningPriceMin: autoScalp.winningPriceMin,
    winningPriceMax: autoScalp.winningPriceMax,
    cooldownSeconds: autoScalp.cooldownSeconds,
    lastTriggerPrice: autoScalp.lastTriggerPrice,
    sides: autoScalp.sides,
    ref: autoScalp.lastTriggerPrice ?? liveState.btcStart,
    btc: liveState.binanceBtc,
    log: autoScalp.log,
  });
});

app.post('/api/auto-scalp', (req, res) => {
  const { enabled, threshold, profitCents, shares, winningPriceMin, winningPriceMax, cooldownSeconds } = req.body;
  if (typeof enabled === 'boolean') autoScalp.enabled = enabled;
  if (threshold != null) autoScalp.threshold = parseFloat(threshold) || 5;
  if (profitCents != null) autoScalp.profitCents = parseInt(profitCents) || 2;
  if (shares != null) autoScalp.shares = Math.max(5, parseInt(shares) || 5);
  if (winningPriceMin != null) autoScalp.winningPriceMin = Math.max(1, Math.min(99, parseInt(winningPriceMin) || 45));
  if (winningPriceMax != null) autoScalp.winningPriceMax = Math.max(1, Math.min(99, parseInt(winningPriceMax) || 85));
  if (cooldownSeconds != null) autoScalp.cooldownSeconds = Math.max(5, Math.min(120, parseInt(cooldownSeconds) || 15));
  if (enabled) {
    autoScalp.lastTriggerPrice = liveState.binanceBtc ?? liveState.btcStart;
    autoScalp.busy = false;
    autoScalp.upOrderId = null;
    autoScalp.downOrderId = null;
    autoScalp.unhedged = null;
    autoScalp._armed = false;
    if (autoScalp._settleTimer) { clearTimeout(autoScalp._settleTimer); autoScalp._settleTimer = null; }
  }
  console.log(`[AUTO-SCALP] ${autoScalp.enabled ? 'ON' : 'OFF'} — $${autoScalp.threshold} threshold, ${autoScalp.profitCents}¢ profit, ${autoScalp.shares}sh, ${autoScalp.cooldownSeconds}s cooldown, winning ${autoScalp.winningPriceMin}–${autoScalp.winningPriceMax}¢`);
  res.json({ success: true, ...autoScalp });
});

// ── Auto-flow API ────────────────────────────────────────────────────────────
app.get('/api/auto-flow', (req, res) => {
  // Include live flow scores for debugging
  const upFlow = detectFlow('up');
  const downFlow = detectFlow('down');
  res.json({
    ...autoFlow,
    upFlow: upFlow ? { mono: upFlow.mono, moveCents: upFlow.moveCents, goingUp: upFlow.goingUp, ticks: upFlow.ticks, reversals: upFlow.reversals, maxReverseCents: upFlow.maxReverseCents } : null,
    downFlow: downFlow ? { mono: downFlow.mono, moveCents: downFlow.moveCents, goingUp: downFlow.goingUp, ticks: downFlow.ticks, reversals: downFlow.reversals, maxReverseCents: downFlow.maxReverseCents } : null,
  });
});

app.post('/api/auto-flow', (req, res) => {
  const { enabled, shares, windowSecs, monotonicity, minMoveCents, maxTickStdDev, priceMin, priceMax, cooldownMs } = req.body;
  if (typeof enabled === 'boolean') autoFlow.enabled = enabled;
  if (shares != null) autoFlow.shares = Math.max(5, parseInt(shares) || 5);
  if (windowSecs != null) autoFlow.windowSecs = Math.max(10, Math.min(300, parseInt(windowSecs) || 60));
  if (monotonicity != null) autoFlow.monotonicity = Math.max(0.5, Math.min(1.0, parseFloat(monotonicity) || 0.75));
  if (minMoveCents != null) autoFlow.minMoveCents = Math.max(1, Math.min(20, parseInt(minMoveCents) || 3));
  const { maxReversalPct } = req.body;
  if (maxReversalPct != null) autoFlow.maxReversalPct = Math.max(0.05, Math.min(0.50, parseFloat(maxReversalPct) || 0.20));
  if (priceMin != null) autoFlow.priceMin = Math.max(1, Math.min(99, parseInt(priceMin) || 30));
  if (priceMax != null) autoFlow.priceMax = Math.max(1, Math.min(99, parseInt(priceMax) || 70));
  if (cooldownMs != null) autoFlow.cooldownMs = Math.max(10000, Math.min(300000, parseInt(cooldownMs) || 60000));
  if (enabled) {
    autoFlow.busy = false;
    autoFlow.upOrderId = null;
    autoFlow.downOrderId = null;
    autoFlow.unhedged = null;
    autoFlow.lastTriggerTime = { up: 0, down: 0 };
  }
  console.log(`[AUTO-FLOW] ${autoFlow.enabled ? 'ON' : 'OFF'} — window=${autoFlow.windowSecs}s mono≥${(autoFlow.monotonicity*100).toFixed(0)}% move≥${autoFlow.minMoveCents}¢ maxRev≤${(autoFlow.maxReversalPct*100).toFixed(0)}% price=${autoFlow.priceMin}-${autoFlow.priceMax}¢`);
  res.json({ success: true, ...autoFlow });
});

// ── Auto-EMA endpoints ───────────────────────────────────────────────────────
app.get('/api/eth-state', (req, res) => {
  res.json({ event: ethEvent, prices: liveStateEth, autoEth });
});

app.post('/api/eth-auto', (req, res) => {
  const { enabled } = req.body;
  if (enabled != null) autoEth.enabled = !!enabled;
  console.log(`[ETH-VEL] ${autoEth.enabled ? 'ON' : 'OFF'} — BTC single tick $${ETH_VEL_THRESHOLD} → ETH, hedge immediately at 99¢, price ${autoEth.priceMin}-${autoEth.priceMax}¢`);
  res.json(autoEth);
});

app.get('/api/auto-ema', (req, res) => {
  res.json({
    ...autoEma,
    ema: { e12: serverEma.fE12, e26: serverEma.fE26, gap: (serverEma.fE12 ?? 0) - (serverEma.fE26 ?? 0), histogram: serverEma.fHistogram },
  });
});

app.post('/api/auto-ema', (req, res) => {
  const { enabled, gapOpenThreshold, priceMin, priceMax, maxHedgeWaitMs, cooldownMs } = req.body;
  if (typeof enabled === 'boolean') autoEma.enabled = enabled;
  if (gapOpenThreshold != null) autoEma.gapOpenThreshold = Math.max(1, Math.min(50, parseFloat(gapOpenThreshold) || 5));
  if (priceMin != null) autoEma.priceMin = Math.max(1, Math.min(99, parseInt(priceMin) || 25));
  if (priceMax != null) autoEma.priceMax = Math.max(1, Math.min(99, parseInt(priceMax) || 85));
  if (maxHedgeWaitMs != null) autoEma.maxHedgeWaitMs = Math.max(5000, Math.min(120000, parseInt(maxHedgeWaitMs) || 30000));
  if (cooldownMs != null) autoEma.cooldownMs = Math.max(0, Math.min(300000, parseInt(cooldownMs) ?? 0));
  if (enabled) {
    _autoEmaAbort();
    autoEma.enabled = true;
  } else if (enabled === false) {
    _autoEmaAbort(); // Stop all trading when disabled — cancel pending orders, clear busy
  }
  console.log(`[AUTO-EMA] ${autoEma.enabled ? 'ON' : 'OFF'} — gap≥$${autoEma.gapOpenThreshold} (open & close) price=${autoEma.priceMin}-${autoEma.priceMax}¢ hedgeWait=${autoEma.maxHedgeWaitMs/1000}s`);
  res.json({ success: true, ...autoEma });
});

// ── ETH EMA endpoints ───────────────────────────────────────────────────────
app.get('/api/eth-ema-state', (req, res) => {
  const fGap = (serverEma.fE12 ?? 0) - (serverEma.fE26 ?? 0);
  res.json({
    ...autoEthEma,
    ema: { e12: serverEma.fE12, e26: serverEma.fE26, gap: fGap, histogram: serverEma.fHistogram },
  });
});

app.post('/api/eth-ema', (req, res) => {
  const { enabled, gapOpenThreshold, priceMin, priceMax, maxHedgeWaitMs, cooldownMs } = req.body;
  if (typeof enabled === 'boolean') autoEthEma.enabled = enabled;
  if (gapOpenThreshold != null) autoEthEma.gapOpenThreshold = Math.max(1, Math.min(50, parseFloat(gapOpenThreshold) || 5));
  if (priceMin != null) autoEthEma.priceMin = Math.max(1, Math.min(99, parseInt(priceMin) || 25));
  if (priceMax != null) autoEthEma.priceMax = Math.max(1, Math.min(99, parseInt(priceMax) || 85));
  if (maxHedgeWaitMs != null) autoEthEma.maxHedgeWaitMs = Math.max(5000, Math.min(120000, parseInt(maxHedgeWaitMs) || 30000));
  if (cooldownMs != null) autoEthEma.cooldownMs = Math.max(0, Math.min(300000, parseInt(cooldownMs) ?? 0));
  if (enabled) {
    _autoEthEmaAbort();
    autoEthEma.enabled = true;
  } else if (enabled === false) {
    _autoEthEmaAbort();
  }
  console.log(`[ETH-EMA] ${autoEthEma.enabled ? 'ON' : 'OFF'} — gap≥$${autoEthEma.gapOpenThreshold} price=${autoEthEma.priceMin}-${autoEthEma.priceMax}¢ hedgeWait=${autoEthEma.maxHedgeWaitMs/1000}s`);
  res.json({ success: true, ...autoEthEma });
});

app.get('/api/trade-log', (req, res) => {
  try {
    if (!fs.existsSync(TRADE_LOG_FILE)) return res.json([]);
    const lines = fs.readFileSync(TRADE_LOG_FILE, 'utf-8').trim().split('\n').filter(Boolean);
    const entries = lines.map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
    res.json(entries.slice(-200).reverse());
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── Hedged trade log (Auto-EMA, Auto-Scalp, Auto-Flow — all profitable cycle records) ─
app.get('/api/ema-trades', async (req, res) => {
  const limit = Math.min(parseInt(req.query.limit || '100', 10) || 100, 300);
  try {
    const { data: rows } = await supabase
      .from('polymarket_trades')
      .select('id, direction, purchase_price, purchase_amount, purchase_time, polymarket_event_id, btc_price_at_purchase, notes')
      .eq('order_type', 'live')
      .order('purchase_time', { ascending: false })
      .limit(limit * 4);
    const entries = [];
    const hedges = [];
    const scalpUps = [];
    const scalpDowns = [];
    const flowUps = [];
    const flowDowns = [];
    for (const r of rows || []) {
      try {
        const n = r.notes ? JSON.parse(r.notes) : {};
        if (n.type === 'auto-ema-entry') entries.push({ ...r, notes: n });
        else if (n.type === 'auto-ema-hedge') hedges.push({ ...r, notes: n });
        else if (n.type === 'auto-scalp-up') scalpUps.push({ ...r, notes: n });
        else if (n.type === 'auto-scalp-down') scalpDowns.push({ ...r, notes: n });
        else if (n.type === 'auto-flow-up') flowUps.push({ ...r, notes: n });
        else if (n.type === 'auto-flow-down') flowDowns.push({ ...r, notes: n });
      } catch {}
    }
    const cycles = [];
    // Auto-EMA cycles (entry + hedge)
    for (const h of hedges) {
      const n = h.notes;
      const entrySide = n.entrySide || (n.side === 'up' ? 'down' : 'up');
      const entry = entries.find(e =>
        String(e.polymarket_event_id) === String(h.polymarket_event_id) &&
        e.notes?.side === entrySide &&
        new Date(e.purchase_time).getTime() < new Date(h.purchase_time).getTime()
      );
      const entryPrice = n.entryPrice ?? entry?.purchase_price;
      const entryNotes = entry?.notes || {};
      const upPrice = entrySide === 'up' ? entryPrice : n.buyPrice;
      const downPrice = entrySide === 'down' ? entryPrice : n.buyPrice;
      const totalCost = (parseFloat(upPrice) || 0) + (parseFloat(downPrice) || 0);
      const profitCents = n.profitCents != null ? Math.round(n.profitCents) : Math.round((1 - totalCost) * 100);
      cycles.push({
        id: h.id,
        source: 'ema',
        eventSlug: n.eventSlug || `btc-updown-5m-${h.polymarket_event_id}`,
        polymarketEventId: h.polymarket_event_id,
        entryTime: entry?.purchase_time || h.purchase_time,
        hedgeTime: h.purchase_time,
        entrySide: entrySide,
        entryPriceCents: Math.round((entryPrice || 0) * 100),
        hedgePriceCents: Math.round((n.buyPrice || 0) * 100),
        upPaidCents: Math.round((upPrice || 0) * 100),
        downPaidCents: Math.round((downPrice || 0) * 100),
        gap: n.gap != null ? parseFloat(n.gap).toFixed(1) : null,
        peakGap: n.peakGap != null ? parseFloat(n.peakGap).toFixed(1) : null,
        histogram: n.histogram != null ? parseFloat(n.histogram).toFixed(2) : null,
        e12: entryNotes.e12 != null ? parseFloat(entryNotes.e12).toFixed(2) : null,
        e26: entryNotes.e26 != null ? parseFloat(entryNotes.e26).toFixed(2) : null,
        hedgeReason: n.reason || 'macd_cross',
        profitCents,
        shares: n.sizeShares || 5,
        btcAtEntry: entry?.btc_price_at_purchase ?? h.btc_price_at_purchase,
      });
    }
    // Auto-Scalp / Auto-Flow cycles (up + down placed together)
    const pairScalp = (ups, downs, usedUps, source) => {
      for (const d of downs) {
        const u = ups.find((u, i) =>
          !usedUps.has(i) &&
          String(u.polymarket_event_id) === String(d.polymarket_event_id) &&
          Math.abs(new Date(u.purchase_time) - new Date(d.purchase_time)) < 15000
        );
        if (!u) continue;
        const uIdx = ups.indexOf(u);
        usedUps.add(uIdx);
        const upPrice = u.notes?.upBuyPrice ?? u.purchase_price;
        const downPrice = d.notes?.downBuyPrice ?? d.purchase_price;
        const profitCents = d.notes?.profitCentsActual ?? Math.round((1 - upPrice - downPrice) * 100);
        const shares = u.notes?.sizeShares ?? 5;
        cycles.push({
          id: d.id,
          source: source || 'scalp',
          eventSlug: `btc-updown-5m-${d.polymarket_event_id}`,
          polymarketEventId: d.polymarket_event_id,
          entryTime: u.purchase_time,
          hedgeTime: d.purchase_time,
          entrySide: 'both',
          entryPriceCents: Math.round((upPrice || 0) * 100),
          hedgePriceCents: Math.round((downPrice || 0) * 100),
          upPaidCents: Math.round((upPrice || 0) * 100),
          downPaidCents: Math.round((downPrice || 0) * 100),
          gap: null,
          peakGap: null,
          histogram: null,
          e12: null,
          e26: null,
          hedgeReason: source || 'scalp',
          profitCents,
          shares,
          btcAtEntry: u.btc_price_at_purchase ?? d.btc_price_at_purchase,
        });
      }
    };
    const usedScalpUps = new Set();
    const usedFlowUps = new Set();
    pairScalp(scalpUps, scalpDowns, usedScalpUps, 'scalp');
    pairScalp(flowUps, flowDowns, usedFlowUps, 'flow');
    // Sort by time desc, dedupe by id, limit
    cycles.sort((a, b) => new Date(b.entryTime || b.hedgeTime) - new Date(a.entryTime || a.hedgeTime));
    const seen = new Set();
    const deduped = cycles.filter(c => {
      const key = `${c.source}-${c.polymarketEventId}-${c.hedgeTime}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
    res.json({ cycles: deduped.slice(0, limit) });
  } catch (e) {
    res.json({ cycles: [], error: e.message });
  }
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

// ── My trades from Polymarket (on-chain, source of truth for your wallet) ──
// Note: Don't use market=conditionId - neg-risk Up/Down may use different condition IDs per outcome
app.get('/api/my-trades', async (req, res) => {
  const slug = req.query.slug;
  const tokenUp = req.query.tokenUp || '';
  const tokenDown = req.query.tokenDown || '';
  const user = (process.env.PROXY_WALLET || process.env.FUNDER_ADDRESS || '').toLowerCase();
  if (!user) return res.json({ trades: [], error: 'Wallet not configured' });
  if (!slug) return res.json({ trades: [], error: 'Missing slug' });
  try {
    const url = `https://data-api.polymarket.com/trades?user=${user}&limit=500&takerOnly=false`;
    const r = await fetch(url);
    const poly = await r.json();
    const slugLower = slug.toLowerCase();
    const slugNum = slug.match(/(\d{10,})/)?.[1];
    const trades = (poly || [])
      .filter(t => {
        const tSlug = ((t.eventSlug || t.slug || '') + '').toLowerCase();
        return tSlug === slugLower || (slugNum && tSlug.includes(slugNum));
      })
      .map(t => {
        const asset = t.asset || t.token_id || '';
        let outcome = 'down';
        if (tokenUp && asset === tokenUp) outcome = 'up';
        else if (tokenDown && asset === tokenDown) outcome = 'down';
        else {
          const o = (t.outcome || '').trim();
          const idx = t.outcomeIndex;
          if (/up|yes/i.test(o)) outcome = 'up';
          else if (/down|no/i.test(o)) outcome = 'down';
          else if (typeof idx === 'number') outcome = idx === 0 ? 'up' : 'down';
        }
        return {
          ts: t.timestamp ? t.timestamp * 1000 : 0,
          side: (t.side || '').toLowerCase(),
          outcome,
          shares: parseFloat(t.size || 0),
          price: parseFloat(t.price || 0),
          usdc: parseFloat(t.size || 0) * parseFloat(t.price || 0),
        };
      });
    res.json({ trades });
  } catch (e) {
    res.json({ trades: [], error: e.message });
  }
});

// ── Recent orders ──────────────────────────────────────────────────────────
app.get('/api/orders', async (req, res) => {
  const slug = req.query.slug;
  let q = supabase
    .from('polymarket_trades')
    .select('*')
    .in('order_type', ['supertrader', 'paper', 'live'])
    .order('created_at', { ascending: false })
    .limit(slug ? 200 : 50);
  if (slug) {
    const slugNum = (slug.match(/(\d{10,})/) || [])[1];
    // polymarket_event_id can be slug string or numeric id
    if (slugNum) q = q.or(`polymarket_event_id.eq.${slug},polymarket_event_id.eq.${slugNum}`);
    else q = q.eq('polymarket_event_id', slug);
  }
  const { data, error } = await q;
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
    const user = (process.env.FUNDER_ADDRESS || process.env.PROXY_WALLET)?.toLowerCase();
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
app.get('/api/event', async (req, res) => {
  // Lazily fetch & cache the open price from the first DB snapshot for this event
  const slug = liveState.eventSlug;
  if (slug && slug !== cachedOpenPrice.slug) {
    try {
      const { data } = await supabase
        .from('polymarket_15m_snapshots')
        .select('coin_price, btc_price, up_cost, down_cost')
        .eq('event_slug', slug)
        .order('observed_at', { ascending: true })
        .limit(1);
      const row = data?.[0];
      cachedOpenPrice = {
        slug,
        btc: row ? (parseFloat(row.coin_price) || parseFloat(row.btc_price) || null) : null,
        up: row?.up_cost != null ? parseFloat(row.up_cost) : null,
        down: row?.down_cost != null ? parseFloat(row.down_cost) : null,
      };
    } catch { cachedOpenPrice = { slug, btc: null, up: null, down: null }; }
  }
  res.json({ event: activeEvent, liveState, openPrice: cachedOpenPrice, stopLoss: stopLossState ? { armed: true, ...stopLossState } : { armed: false } });
});

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
  const clientBtcOpen = req.body?.btcOpen ? parseFloat(req.body.btcOpen) : null;
  await refreshEvent(clientBtcOpen);
  // Reconnect stale streams
  try { connectBinanceStream(); } catch (e) { console.error('[REFRESH] Binance reconnect:', e.message); }
  try { connectBtcStream(); } catch (e) { console.error('[REFRESH] BTC reconnect:', e.message); }
  scheduleNextEvent();
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

  // Fetch KS 15m prices from arb session
  let ksYesAsk = null, ksYesBid = null, ksNoAsk = null, ksNoBid = null;
  try {
    const ksRes = await fetch(`http://localhost:${process.env.PORT || 3001}/api/arb/ks-price/btc`);
    if (ksRes.ok) {
      const ks = await ksRes.json();
      ksYesAsk = ks.yesAsk ?? null;
      ksYesBid = ks.yesBid ?? null;
      ksNoAsk = ks.noAsk ?? null;
      ksNoBid = ks.noBid ?? null;
    }
  } catch {}

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
    ks_yes_ask: ksYesAsk,
    ks_yes_bid: ksYesBid,
    ks_no_ask: ksNoAsk,
    ks_no_bid: ksNoBid,
    up_spread: upBid != null && upAsk != null ? Number((upAsk - upBid).toFixed(4)) : null,
    down_spread: downBid != null && downAsk != null ? Number((downAsk - downBid).toFixed(4)) : null,
    observed_at: new Date().toISOString(),
    seconds_left: secsLeft,
    coin: 'btc',
  });
}

const ethSnapshotBuffer = [];

async function pushEthSnapshot() {
  if (!liveStateEth.eventSlug) return;
  // Do not require liveState.binanceBtc — otherwise no rows are written until BTC WS connects,
  // and Polymarket up/down never persist to eth_15m_snapshots for the chart.
  const endDate = ethEvent?.endDate ? new Date(ethEvent.endDate) : null;
  const secsLeft = endDate ? Math.max(0, Math.floor((endDate - Date.now()) / 1000)) : 0;

  // Fetch ETH Binance price
  let ethPrice = null;
  try {
    const res = await fetch('https://api.binance.com/api/v3/ticker/price?symbol=ETHUSDT').then(r => r.json()).catch(() => null);
    ethPrice = res?.price ? parseFloat(res.price) : null;
  } catch {}

  let upBid = null, upAsk = null, downBid = null, downAsk = null;
  try {
    const upToken = liveStateEth.tokenUp;
    const downToken = liveStateEth.tokenDown;
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
  } catch (e) { /* ignore */ }

  ethSnapshotBuffer.push({
    event_slug: liveStateEth.eventSlug,
    eth_price: ethPrice,
    up_cost: liveStateEth.upPrice,
    down_cost: liveStateEth.downPrice,
    up_best_bid: upBid,
    up_best_ask: upAsk,
    down_best_bid: downBid,
    down_best_ask: downAsk,
    up_spread: upBid != null && upAsk != null ? Number((upAsk - upBid).toFixed(4)) : null,
    down_spread: downBid != null && downAsk != null ? Number((downAsk - downBid).toFixed(4)) : null,
    observed_at: new Date().toISOString(),
    seconds_left: secsLeft,
  });
}

// Capture a snapshot every 5s (was 1s — reduced to lower Supabase + Polymarket API load)
setInterval(() => { pushSnapshot(); pushEthSnapshot(); push5mSnapshot(); }, 5000);

// Sync KS 15m prices into liveState every 3s (overrides Poly WS prices for BTC)
setInterval(async () => {
  try {
    const ksRes = await fetch(`http://localhost:${process.env.PORT || 3001}/api/arb/ks-price/btc`);
    if (!ksRes.ok) return;
    const ks = await ksRes.json();
    if (!ks.yesAsk || !ks.noAsk) return;
    let changed = false;
    if (ks.yesAsk !== liveState.upPrice) { liveState.upPrice = ks.yesAsk; changed = true; }
    if (ks.noAsk !== liveState.downPrice) { liveState.downPrice = ks.noAsk; changed = true; }
    if (changed) broadcast({ type: 'prices', ...liveState });
  } catch {}
}, 3000);

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
}, 5000);

// Flush ETH snapshot buffer to Supabase every 5s
setInterval(async () => {
  if (!ethSnapshotBuffer.length) return;
  const batch = ethSnapshotBuffer.splice(0, ethSnapshotBuffer.length);
  try {
    const { error } = await supabase.from('eth_15m_snapshots').insert(batch);
    if (error) console.error('[ETH-SNAPSHOT] batch error:', error.message);
  } catch (e) {
    console.error('[ETH-SNAPSHOT] flush error:', e.message);
  }
}, 5000);

// Flush BTC 5m snapshot buffer to Supabase every 5s
setInterval(async () => {
  if (!btc5mSnapshotBuffer.length) return;
  const batch = btc5mSnapshotBuffer.splice(0, btc5mSnapshotBuffer.length);
  try {
    const { error } = await supabase.from('btc_5m_snapshots').insert(batch);
    if (error) console.error('[BTC5M-SNAPSHOT] batch error:', error.message);
  } catch (e) {
    console.error('[BTC5M-SNAPSHOT] flush error:', e.message);
  }
}, 5000);

// ── BTC 5m API endpoints ──────────────────────────────────────────────────
app.get('/api/btc5m/event', (req, res) => {
  res.json({
    ...btc5mState,
    btcCurrent: liveState.binanceBtc || btc5mState.btcCurrent,
  });
});

app.get('/api/btc5m/price-history', async (req, res) => {
  const slug = req.query.slug || btc5mState.eventSlug;
  const limit = parseInt(req.query.limit || '500');
  if (!slug) return res.json({ snapshots: [] });
  try {
    const { data, error } = await supabase
      .from('btc_5m_snapshots')
      .select('observed_at, btc_price, up_cost, down_cost, seconds_left')
      .eq('event_slug', slug)
      .order('observed_at', { ascending: false })
      .limit(limit);
    if (error) return res.json({ snapshots: [], error: error.message });
    res.json({ snapshots: (data || []).reverse(), slug });
  } catch (e) {
    res.json({ snapshots: [], error: e.message });
  }
});

app.post('/api/btc5m/buy', async (req, res) => {
  const { side, shares: reqShares, limitPrice, orderType } = req.body;
  if (!btc5mEvent) return res.status(400).json({ error: 'No active 5m event' });
  if (!['up', 'down'].includes(side)) return res.status(400).json({ error: 'Invalid side' });
  if (!clobClient) return res.status(500).json({ error: 'CLOB client not ready' });

  const tokenId = side === 'up' ? btc5mState.tokenUp : btc5mState.tokenDown;
  if (!tokenId) return res.status(400).json({ error: 'No token ID' });

  const tickSize = btc5mEvent.tickSize || '0.01';
  const tick = parseFloat(tickSize);
  const negRisk = btc5mEvent.negRisk || false;
  const shares = Math.max(1, Math.round(parseFloat(reqShares || 5)));
  const price = limitPrice
    ? Math.max(0.01, Math.min(Math.round(Math.round(parseFloat(limitPrice) * 100) / 100 / tick) * tick, 0.99))
    : Math.max(0.01, Math.min(Math.round(Math.round((side === 'up' ? btc5mState.upPrice : btc5mState.downPrice) * 100) / 100 / tick) * tick, 0.99));

  // Respond instantly
  res.json({ success: true, price, shares, status: 'sending' });

  // Fire and forget
  (async () => {
    try {
      const t0 = Date.now();
      const signed = await clobClient.createOrder(
        { tokenID: tokenId, price, size: shares, side: 'BUY' },
        { tickSize: String(tick), negRisk },
      );
      const otype = orderType === 'GTC' ? 'GTC' : 'GTC';
      const result = await clobClient.postOrder(signed, otype);
      console.log(`[BTC5M BUY] ${side} ${shares}sh @ ${(price * 100).toFixed(0)}¢ — ${Date.now() - t0}ms — id:`, result?.orderID || result);
      logTrade('btc5m', 'buy', { side, price, shares, eventSlug: btc5mState.eventSlug, orderId: result?.orderID });
      broadcast({ type: 'btc5m_order', status: 'placed', side, price, shares, orderID: result?.orderID });
    } catch (e) {
      console.error('[BTC5M BUY] error:', e?.message);
      broadcast({ type: 'btc5m_order', status: 'failed', side, price, shares, error: e?.message });
    }
  })();
});

// Live + ending soon events (CORS proxy for Gamma API)
app.get('/api/ending-soon', async (req, res) => {
  try {
    // Fetch live events + events ending within 7 days
    const [liveRes, soonRes] = await Promise.all([
      fetch('https://gamma-api.polymarket.com/events?active=true&closed=false&live=true&limit=100').then(r => r.json()).catch(() => []),
      fetch(`https://gamma-api.polymarket.com/markets?active=true&closed=false&limit=200&end_date_min=${new Date().toISOString().slice(0,10)}T00:00:00Z&end_date_max=${new Date(Date.now()+7*86400000).toISOString().slice(0,10)}T23:59:59Z`).then(r => r.json()).catch(() => []),
    ]);

    const liveEvents = Array.isArray(liveRes) ? liveRes : [];
    const soonMarkets = Array.isArray(soonRes) ? soonRes : [];

    // Convert live events to a flat list with markets
    const liveFlat = [];
    for (const e of liveEvents) {
      const slug = (e.slug || '').toLowerCase();
      if (slug.includes('updown') || slug.includes('up-or-down')) continue; // skip crypto
      if (e.ended) continue; // skip finished matches
      for (const m of (e.markets || [])) {
        liveFlat.push({
          ...m,
          _eventTitle: e.title,
          _live: true,
          _score: e.score,
          _period: e.period,
          _ended: e.ended,
          _eventSlug: e.slug,
          _startTime: e.startTime,
          _finishedTimestamp: e.finishedTimestamp,
        });
      }
    }

    // Filter non-crypto from soon markets
    const soonFiltered = soonMarkets.filter(m => {
      const q = (m.question || '').toLowerCase();
      return !q.includes('up or down') && !q.includes('bitcoin up') && !q.includes('ethereum up') &&
             !q.includes('solana up') && !q.includes('xrp up') && !q.includes('dogecoin up') &&
             !q.includes('bnb up') && !q.includes('hyperliquid up');
    });

    // Combine: live first, then ending soon
    const combined = [...liveFlat, ...soonFiltered];
    res.json(combined);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Check USDC balance — cache for 30s to avoid spamming RPC
let _balanceCache = { bal: 0, ts: 0 };
async function getUsdcBalance() {
  const now = Date.now();
  if (now - _balanceCache.ts < 30000) return _balanceCache.bal;
  try {
    const { JsonRpcProvider } = await import('@ethersproject/providers');
    const { Contract } = await import('@ethersproject/contracts');
    const provider = new JsonRpcProvider(`https://polygon-mainnet.g.alchemy.com/v2/${process.env.ALCHEMY_KEY || '8kruQGYamUT6J4Ib0aMfw'}`);
    const usdc = new Contract('0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174', ['function balanceOf(address) view returns (uint256)'], provider);
    const bal = await usdc.balanceOf(process.env.FUNDER_ADDRESS);
    _balanceCache = { bal: Number(bal) / 1e6, ts: now };
    return _balanceCache.bal;
  } catch { return _balanceCache.bal; }
}

// Helper: place 99.9¢ order (try 0.001 tick, fall back to 0.01)
async function placeLive99Order(tokenId, size, negRisk, label) {
  // Balance gate — don't place if wallet has less than $10
  const bal = await getUsdcBalance();
  if (bal < 10) {
    console.log(`${label} → SKIP (balance $${bal.toFixed(2)} < $10)`);
    return null;
  }

  // 30 minute expiration — use GTD order type
  const expiration = Math.floor(Date.now() / 1000) + 1800;

  let result;
  try {
    const signed = await clobClient.createOrder({ tokenID: tokenId, price: 0.999, size, side: 'BUY', expiration }, { tickSize: '0.001', negRisk });
    result = await clobClient.postOrder(signed, 'GTD');
  } catch {
    const signed2 = await clobClient.createOrder({ tokenID: tokenId, price: 0.99, size, side: 'BUY', expiration }, { tickSize: '0.01', negRisk });
    result = await clobClient.postOrder(signed2, 'GTD');
  }
  console.log(`${label} → ${result?.status} id:${result?.orderID?.slice(0,8)}`);
  return result;
}

// Helper: check exact score markets for a soccer game and buy NO on impossible scores
async function checkExactScores(slug, title, score, firedSet) {
  if (!clobClient) return;
  const parts = String(score).split('-');
  const nums = parts.map(p => parseInt(p.trim())).filter(n => !isNaN(n));
  if (nums.length !== 2) return;
  // Skip esports (pipes in score) and 0-0 (nothing impossible yet)
  if (String(score).includes('|')) return;
  const homeScore = nums[0], awayScore = nums[1];
  if (homeScore + awayScore === 0) return;

  const esSlug = slug + '-exact-score';
  try {
    const esRes = await fetch(`https://gamma-api.polymarket.com/events?slug=${encodeURIComponent(esSlug)}`);
    const esData = await esRes.json();
    const esEvent = Array.isArray(esData) ? esData[0] : esData;
    if (!esEvent?.markets?.length) return;

    for (const m of esEvent.markets) {
      const q = m.question || '';
      const condId = m.conditionId;
      if (!condId || firedSet.has(condId)) continue;

      const scoreMatch = q.match(/(\d+)\s*-\s*(\d+)/);
      if (!scoreMatch) continue; // skip "Any Other Score"
      const mHome = parseInt(scoreMatch[1]), mAway = parseInt(scoreMatch[2]);

      // Impossible if current home > market home OR current away > market away
      if (homeScore <= mHome && awayScore <= mAway) continue;

      firedSet.add(condId);

      const tokens = typeof m.clobTokenIds === 'string' ? JSON.parse(m.clobTokenIds) : m.clobTokenIds;
      if (!tokens || tokens.length < 2) continue;
      const noToken = tokens[1]; // NO is index 1
      const negRisk = m.negRisk != null ? m.negRisk : true;

      // Check both sides — YES + NO ask should be <= 103¢, skip if inflated or no liquidity
      const yesToken = tokens[0];
      try {
        const [yesRes, noRes] = await Promise.all([
          fetch('https://clob.polymarket.com/price?token_id=' + yesToken + '&side=sell'),
          fetch('https://clob.polymarket.com/price?token_id=' + noToken + '&side=sell'),
        ]);
        const yesData = await yesRes.json();
        const noData = await noRes.json();
        const yesAsk = yesData?.price ? parseFloat(yesData.price) : null;
        const noAsk = noData?.price ? parseFloat(noData.price) : null;
        if (yesAsk == null || noAsk == null) {
          console.log(`[exact-score] SKIP ${mHome}-${mAway}: no price data (no liquidity)`);
          firedSet.delete(condId);
          continue;
        }
        const total = yesAsk + noAsk;
        if (total > 1.03) {
          console.log(`[exact-score] SKIP ${mHome}-${mAway}: YES ${(yesAsk*100).toFixed(0)}¢ + NO ${(noAsk*100).toFixed(0)}¢ = ${(total*100).toFixed(0)}¢ > 103¢`);
          firedSet.delete(condId);
          continue;
        }
      } catch {
        firedSet.delete(condId);
        continue;
      }

      console.log(`[exact-score] ${title.slice(0,30)} score ${score} → ${mHome}-${mAway} IMPOSSIBLE → BUY NO`);
      try {
        const result = await placeLive99Order(noToken, 10, negRisk, `[exact-score] NO on ${mHome}-${mAway} 10sh`);
        liveEventTracker.log.unshift({ ts: Date.now(), event: title, score, market: `Exact ${mHome}-${mAway} NO`, side: 'NO', price: '99.9¢', status: result?.status });
        if (liveEventTracker.log.length > 50) liveEventTracker.log.length = 50;
      } catch (err) {
        console.error(`[exact-score] Error ${mHome}-${mAway}:`, err.message?.slice(0, 60));
      }
    }
  } catch (err) {
    console.error(`[exact-score] Fetch error for ${esSlug}:`, err.message?.slice(0, 60));
  }
}

// Helper: buy winners on exact score event when game ends
async function buyExactScoreOnEnd(slug, title, finalScore) {
  if (!clobClient) return;
  const esSlug = slug + '-exact-score';
  try {
    const esRes = await fetch(`https://gamma-api.polymarket.com/events?slug=${encodeURIComponent(esSlug)}`);
    const esData = await esRes.json();
    const esEvent = Array.isArray(esData) ? esData[0] : esData;
    if (!esEvent?.markets?.length) return;

    console.log(`[exact-score] END: ${title} final ${finalScore} — ${esEvent.markets.length} exact score markets`);

    for (const m of esEvent.markets) {
      if (m.closed) continue;
      const q = m.question || '';
      const prices = m.outcomePrices ? (typeof m.outcomePrices === 'string' ? JSON.parse(m.outcomePrices) : m.outcomePrices) : null;
      const tokens = m.clobTokenIds ? (typeof m.clobTokenIds === 'string' ? JSON.parse(m.clobTokenIds) : m.clobTokenIds) : null;
      if (!prices || !tokens || prices.length < 2) continue;

      const p0 = parseFloat(prices[0]), p1 = parseFloat(prices[1]);
      const winIdx = p0 >= p1 ? 0 : 1;
      const winPrice = Math.max(p0, p1);
      const losePrice = Math.min(p0, p1);
      const winToken = tokens[winIdx];
      const negRisk = m.negRisk != null ? m.negRisk : true;

      if (!winToken || winPrice < 0.90 || losePrice > 0.15) continue;

      // Verify BOTH sides from CLOB — sum must be <= 103¢
      try {
        const [r0, r1] = await Promise.all([
          fetch('https://clob.polymarket.com/price?token_id=' + tokens[0] + '&side=sell'),
          fetch('https://clob.polymarket.com/price?token_id=' + tokens[1] + '&side=sell'),
        ]);
        const d0 = await r0.json(), d1 = await r1.json();
        const a0 = d0?.price ? parseFloat(d0.price) : null;
        const a1 = d1?.price ? parseFloat(d1.price) : null;
        if (a0 == null || a1 == null) { console.log(`[exact-score] END SKIP ${q.slice(0,40)}: no price`); continue; }
        if (a0 + a1 > 1.03) { console.log(`[exact-score] END SKIP ${q.slice(0,40)}: ${(a0*100).toFixed(0)}+${(a1*100).toFixed(0)}=${((a0+a1)*100).toFixed(0)}¢ > 103`); continue; }
        const winAsk = winIdx === 0 ? a0 : a1;
        // Place limit at 99.9¢ even if ask is 100¢ — someone might sell into our bid
        // Trust Gamma — place limit regardless of current ask
      } catch { continue; }

      const winLabel = winIdx === 0 ? 'YES' : 'NO';
      console.log(`[exact-score] END: ${q.slice(0,40)} → BUY ${winLabel} (${(winPrice*100).toFixed(0)}¢)`);
      try {
        const result = await placeLive99Order(winToken, 10, negRisk, `[exact-score] END ${winLabel} on ${q.slice(0,30)} 10sh`);
        liveEventTracker.log.unshift({ ts: Date.now(), event: title, score: finalScore, market: q.slice(0, 50), side: winLabel, price: '99.9¢', status: result?.status });
        if (liveEventTracker.log.length > 50) liveEventTracker.log.length = 50;
      } catch (err) {
        console.error(`[exact-score] END Error ${q.slice(0,30)}:`, err.message?.slice(0, 60));
      }
    }
  } catch (err) {
    console.error(`[exact-score] END fetch error for ${esSlug}:`, err.message?.slice(0, 60));
  }
}

// Auto-99 for live sports events: when a match ends, buy winner at 99¢
const LIVE_EVENTS_FILE = new URL('./.live-events.json', import.meta.url).pathname;

function saveLiveEvents(knownLive, fired) {
  try {
    const data = {
      knownLive: Object.fromEntries([...knownLive].map(([k, v]) => [k, { title: v.title, score: v.score, period: v.period, htScore: v.htScore || null, _htFired: v._htFired || false, _lastPeriod: v._lastPeriod || '' }])),
      fired: [...fired],
    };
    fs.writeFileSync(LIVE_EVENTS_FILE, JSON.stringify(data));
  } catch {}
}

function loadLiveEvents() {
  try {
    if (!fs.existsSync(LIVE_EVENTS_FILE)) return { knownLive: new Map(), fired: new Set() };
    const data = JSON.parse(fs.readFileSync(LIVE_EVENTS_FILE, 'utf8'));
    const knownLive = new Map();
    for (const [slug, v] of Object.entries(data.knownLive || {})) {
      knownLive.set(slug, { title: v.title, score: v.score, period: v.period, markets: [], ouFired: new Set(), exactScoreFired: new Set(), htScore: v.htScore || null, _htFired: v._htFired || false, _lastPeriod: v._lastPeriod || '' });
    }
    const fired = new Set(data.fired || []);
    console.log(`[live-99] Restored ${knownLive.size} tracked events, ${fired.size} fired from disk`);
    return { knownLive, fired };
  } catch { return { knownLive: new Map(), fired: new Set() }; }
}

const restored = loadLiveEvents();
const liveEventTracker = { enabled: true, knownLive: restored.knownLive, fired: restored.fired, log: [] };

app.post('/api/live99/toggle', (req, res) => {
  liveEventTracker.enabled = !liveEventTracker.enabled;
  console.log(`[live-99] ${liveEventTracker.enabled ? 'ENABLED' : 'DISABLED'}`);
  res.json({ enabled: liveEventTracker.enabled });
});

app.get('/api/live99/status', (req, res) => {
  res.json({
    enabled: liveEventTracker.enabled,
    tracking: liveEventTracker.knownLive.size,
    fired: liveEventTracker.fired.size,
    log: liveEventTracker.log.slice(0, 20),
  });
});

// Poll live events every 3 seconds
setInterval(async () => {
  if (!liveEventTracker.enabled || !clobClient) return;

  try {
    const r = await fetch('https://gamma-api.polymarket.com/events?active=true&closed=false&live=true&limit=100');
    const events = await r.json();
    if (!Array.isArray(events)) return;

    const currentLive = new Set();

    for (const e of events) {
      const slug = e.slug;
      if (!slug) continue;
      // Skip crypto
      if (slug.includes('updown') || slug.includes('up-or-down')) continue;

      currentLive.add(slug);

      // Track it if new
      if (!liveEventTracker.knownLive.has(slug)) {
        liveEventTracker.knownLive.set(slug, { title: e.title, markets: e.markets, score: e.score, period: e.period, ouFired: new Set() });
      } else {
        // Update score/period — check if score changed
        const tracked = liveEventTracker.knownLive.get(slug);
        const oldScore = tracked.score;
        tracked.score = e.score;
        tracked.period = e.period;
        tracked.markets = e.markets || tracked.markets;

        // Capture halftime score when period is HT
        if (e.period === 'HT' && !tracked.htScore) {
          tracked.htScore = e.score;
          console.log(`[live-ht] ${e.title} HALFTIME score: ${e.score}`);
        }

        // ── NBA/NHL 1H markets: fire when period changes to Q3/2H/3P (halftime over) ──
        const oldPeriod = tracked._lastPeriod || '';
        tracked._lastPeriod = e.period;
        const htJustEnded = (
          (oldPeriod === 'HT' && e.period !== 'HT') ||
          (oldPeriod === 'Q2' && (e.period === 'Q3' || e.period === 'HT')) ||
          (oldPeriod === '1H' && (e.period === '2H' || e.period === 'HT'))
        );
        if (htJustEnded && !tracked._htFired && clobClient) {
          tracked._htFired = true;
          const htScore = tracked.htScore || e.score;
          const htParts = String(htScore).split('-').map(p => parseInt(p.trim())).filter(n => !isNaN(n));
          if (htParts.length === 2) {
            const homeHT = htParts[0], awayHT = htParts[1], totalHT = homeHT + awayHT;
            console.log(`[live-ht] ${e.title} HT ended: ${htScore} (total ${totalHT}) — scanning 1H markets`);

            for (const m of (e.markets || [])) {
              const q = (m.question || '');
              const ql = q.toLowerCase();
              // Only 1H markets
              if (!ql.includes('1h ') && !ql.includes('1h:')) continue;
              const tokens = typeof m.clobTokenIds === 'string' ? JSON.parse(m.clobTokenIds) : m.clobTokenIds;
              const outcomes = typeof m.outcomes === 'string' ? JSON.parse(m.outcomes) : m.outcomes;
              const negRisk = m.negRisk != null ? m.negRisk : true;
              if (!tokens || tokens.length < 2 || !outcomes) continue;

              let winIdx = -1;

              if (ql.includes('moneyline')) {
                // 1H Moneyline — home won if homeHT > awayHT
                winIdx = homeHT > awayHT ? 0 : homeHT < awayHT ? 1 : -1;
              // SKIP spreads — team name matching is too fragile, could buy losing side
              } else if (ql.includes('o/u')) {
                // 1H O/U — check total against line
                const ouMatch = ql.match(/o\/u\s*([\d.]+)/);
                if (ouMatch) {
                  const line = parseFloat(ouMatch[1]);
                  if (totalHT > line) winIdx = outcomes.findIndex(o => o.toLowerCase().includes('over'));
                  else if (totalHT < line) winIdx = outcomes.findIndex(o => o.toLowerCase().includes('under'));
                  if (winIdx < 0 && totalHT > line) winIdx = 0;
                  if (winIdx < 0 && totalHT < line) winIdx = 1;
                }
              }

              if (winIdx < 0) continue;
              const winToken = tokens[winIdx];
              const winLabel = outcomes[winIdx];

              // Price check: both sides, sum <= 103¢
              try {
                const [r0, r1] = await Promise.all([
                  fetch('https://clob.polymarket.com/price?token_id=' + tokens[0] + '&side=sell'),
                  fetch('https://clob.polymarket.com/price?token_id=' + tokens[1] + '&side=sell'),
                ]);
                const d0 = await r0.json(), d1 = await r1.json();
                const a0 = d0?.price ? parseFloat(d0.price) : null;
                const a1 = d1?.price ? parseFloat(d1.price) : null;
                if (a0 == null || a1 == null) { console.log(`[live-ht] SKIP ${q.slice(0,40)}: no price`); continue; }
                if (a0 + a1 > 1.03) { console.log(`[live-ht] SKIP ${q.slice(0,40)}: ${(a0*100).toFixed(0)}+${(a1*100).toFixed(0)}=${((a0+a1)*100).toFixed(0)}¢ > 103`); continue; }
              } catch { continue; }

              console.log(`[live-ht] ${e.title.slice(0,25)} | ${q.slice(0,40)} → BUY ${winLabel}`);
              try {
                const result = await placeLive99Order(winToken, 10, negRisk, `[live-ht] ${winLabel} on ${q.slice(0,30)} 10sh`);
                liveEventTracker.log.unshift({ ts: Date.now(), event: e.title, score: htScore, market: q.slice(0, 50), side: winLabel, price: '99.9¢', status: result?.status });
                if (liveEventTracker.log.length > 50) liveEventTracker.log.length = 50;
              } catch (err) {
                console.error(`[live-ht] Error ${q.slice(0,30)}:`, err.message?.slice(0, 60));
              }
            }
          }
        }

      }
    }

    // ── Game Total O/U: check ALL tracked non-esports games on every poll ──
    for (const [slug, data] of liveEventTracker.knownLive) {
      if (!data.score || String(data.score).includes('|') || String(data.score).includes(',')) continue;
      if (!clobClient) continue;
      // If no markets yet, fetch them
      if (!data.markets?.length) {
        try {
          const evRes = await fetch(`https://gamma-api.polymarket.com/events?slug=${encodeURIComponent(slug)}`);
          const evData = await evRes.json();
          const ev = Array.isArray(evData) ? evData[0] : evData;
          if (ev?.markets?.length) data.markets = ev.markets;
        } catch {}
        if (!data.markets?.length) continue;
      }
      const ouParts = String(data.score).split('-').map(p => parseInt(p.trim())).filter(n => !isNaN(n));
      if (ouParts.length < 2) continue;
      const ouTotal = ouParts[0] + ouParts[1];
      if (ouTotal === 0) continue;
      if (!data.ouFired) data.ouFired = new Set();

      for (const m of data.markets) {
        const q = (m.question || '');
        const ql = q.toLowerCase();
        if (!ql.includes('o/u')) continue;
        if (ql.includes('points') || ql.includes('rebounds') || ql.includes('assists')) continue;
        if (ql.includes('kills') || ql.includes('map ') || ql.includes('game ')) continue;
        if (ql.includes('total set') || ql.includes('total games')) continue;
        if (ql.includes('1h ') || ql.includes('2h ')) continue;
        if (ql.includes('set ')) continue;
        const ouMatch = ql.match(/o\/u\s*([\d.]+)/);
        if (!ouMatch) continue;
        const line = parseFloat(ouMatch[1]);
        if (line < 3.5) continue;
        const condId = m.conditionId;
        if (!condId || data.ouFired.has(condId)) continue;

        if (ouTotal > line) {
          data.ouFired.add(condId);
          const tokens = typeof m.clobTokenIds === 'string' ? JSON.parse(m.clobTokenIds) : m.clobTokenIds;
          const outcomes = typeof m.outcomes === 'string' ? JSON.parse(m.outcomes) : m.outcomes;
          if (!tokens || tokens.length < 2) continue;
          const overIdx = outcomes ? outcomes.findIndex(o => o.toLowerCase().includes('over')) : 0;
          const overToken = tokens[overIdx >= 0 ? overIdx : 0];
          const overLabel = outcomes ? outcomes[overIdx >= 0 ? overIdx : 0] : 'Over';
          const negRisk = m.negRisk != null ? m.negRisk : true;

          // Price check: both sides sum <= 103¢
          try {
            const [r0, r1] = await Promise.all([
              fetch('https://clob.polymarket.com/price?token_id=' + tokens[0] + '&side=sell'),
              fetch('https://clob.polymarket.com/price?token_id=' + tokens[1] + '&side=sell'),
            ]);
            const d0 = await r0.json(), d1 = await r1.json();
            const a0 = d0?.price ? parseFloat(d0.price) : null;
            const a1 = d1?.price ? parseFloat(d1.price) : null;
            if (a0 == null || a1 == null) { data.ouFired.delete(condId); continue; }
            if (a0 + a1 > 1.03) { data.ouFired.delete(condId); continue; }
          } catch { data.ouFired.delete(condId); continue; }

          console.log(`[live-ou] SCORE ${data.score} (total ${ouTotal}) > O/U ${line} → BUY ${overLabel} | ${data.title}`);
          try {
            const result = await placeLive99Order(overToken, 10, negRisk, `[live-ou] ${overLabel} O/U ${line} 10sh`);
            liveEventTracker.log.unshift({ ts: Date.now(), event: data.title, score: data.score, market: `O/U ${line}`, side: overLabel, price: '99.9¢', status: result?.status });
            if (liveEventTracker.log.length > 50) liveEventTracker.log.length = 50;
          } catch (err) {
            console.error(`[live-ou] Error O/U ${line}:`, err.message?.slice(0, 60));
          }
        }
      }
    }

    // ── Tennis: guaranteed bets based on set/game math ──
    for (const [slug, data] of liveEventTracker.knownLive) {
      if (!data.score || !String(data.score).includes(',')) continue; // tennis has commas in score
      if (!data.markets?.length || !clobClient) continue;
      if (!data._tennisFired) data._tennisFired = new Set();

      const scoreStr = String(data.score);
      // Parse "1-6, 6-3, 0-1" → sets = [[1,6],[6,3],[0,1]]
      const sets = scoreStr.split(',').map(s => {
        // Handle tiebreak: "7-6(7-4)" → [7,6]
        const clean = s.replace(/\(.*\)/, '').trim();
        const parts = clean.split('-').map(n => parseInt(n.trim()));
        return parts.length === 2 && !isNaN(parts[0]) && !isNaN(parts[1]) ? parts : null;
      }).filter(Boolean);

      if (sets.length === 0) continue;

      // Count completed sets (a set is complete if either side has 6+ and leads by 2, or 7-6)
      const completedSets = [];
      let currentSet = null;
      for (const [a, b] of sets) {
        const isComplete = (a >= 6 || b >= 6) && (Math.abs(a - b) >= 2 || (a === 7 && b === 6) || (a === 6 && b === 7));
        if (isComplete) completedSets.push([a, b]);
        else currentSet = [a, b];
      }

      // Total completed games
      const completedGames = completedSets.reduce((sum, [a, b]) => sum + a + b, 0);
      const currentSetGames = currentSet ? currentSet[0] + currentSet[1] : 0;

      // Minimum remaining games in current set
      let minRemainingInSet = 0;
      if (currentSet) {
        const [a, b] = currentSet;
        const leader = Math.max(a, b);
        minRemainingInSet = Math.max(0, 6 - leader);
        // If both at 5+, need at least 2 more (to get to 7-5 or tiebreak)
        if (a >= 5 && b >= 5) minRemainingInSet = Math.max(minRemainingInSet, 2);
      }

      const minTotalGames = completedGames + currentSetGames + minRemainingInSet;
      const totalSetsPlayed = sets.length;

      // Sets won by each side (player 1 = top, player 2 = bottom)
      let p1SetsWon = 0, p2SetsWon = 0;
      for (const [a, b] of completedSets) {
        if (a > b) p1SetsWon++; else p2SetsWon++;
      }

      // Set 1 data
      const set1 = sets.length >= 1 ? sets[0] : null;
      const set1Complete = set1 && completedSets.length >= 1;
      const set1Games = set1 ? set1[0] + set1[1] : 0;

      for (const m of data.markets) {
        const q = m.question || '';
        const ql = q.toLowerCase();
        const condId = m.conditionId;
        if (!condId || data._tennisFired.has(condId)) continue;

        const tokens = typeof m.clobTokenIds === 'string' ? JSON.parse(m.clobTokenIds) : m.clobTokenIds;
        const outcomes = typeof m.outcomes === 'string' ? JSON.parse(m.outcomes) : m.outcomes;
        if (!tokens || tokens.length < 2 || !outcomes) continue;
        const negRisk = m.negRisk != null ? m.negRisk : true;

        let winIdx = -1;

        // Total Sets O/U 2.5 — if in 3rd set or later, Over is guaranteed
        if (ql.includes('total sets') && ql.includes('o/u') && ql.includes('2.5')) {
          if (totalSetsPlayed >= 3) {
            winIdx = outcomes.findIndex(o => o.toLowerCase().includes('over'));
            if (winIdx < 0) winIdx = 0;
          }
        }
        // Set 1 Winner — decided once set 1 is complete
        else if (ql.includes('set 1 winner') || (ql.includes('set 1') && !ql.includes('o/u') && !ql.includes('game'))) {
          // skip — hard to map player names to outcome indices reliably
        }
        // Set 1 Games O/U — decided once set 1 complete
        else if (ql.includes('set 1') && ql.includes('o/u') && set1Complete) {
          const ouMatch = ql.match(/o\/u\s*([\d.]+)/);
          if (ouMatch) {
            const line = parseFloat(ouMatch[1]);
            if (set1Games > line) {
              winIdx = outcomes.findIndex(o => o.toLowerCase().includes('over'));
              if (winIdx < 0) winIdx = 0;
            } else if (set1Games < line) {
              winIdx = outcomes.findIndex(o => o.toLowerCase().includes('under'));
              if (winIdx < 0) winIdx = 1;
            }
          }
        }
        // Match O/U total games — use minimum guaranteed total
        else if (ql.includes('match') && ql.includes('o/u')) {
          const ouMatch = ql.match(/o\/u\s*([\d.]+)/);
          if (ouMatch) {
            const line = parseFloat(ouMatch[1]);
            if (minTotalGames > line) {
              winIdx = outcomes.findIndex(o => o.toLowerCase().includes('over'));
              if (winIdx < 0) winIdx = 0;
            }
          }
        }

        if (winIdx < 0) continue;
        data._tennisFired.add(condId);

        const winToken = tokens[winIdx];
        const winLabel = outcomes[winIdx];

        // Price check: both sides sum <= 103¢
        try {
          const [r0, r1] = await Promise.all([
            fetch('https://clob.polymarket.com/price?token_id=' + tokens[0] + '&side=sell'),
            fetch('https://clob.polymarket.com/price?token_id=' + tokens[1] + '&side=sell'),
          ]);
          const d0 = await r0.json(), d1 = await r1.json();
          const a0 = d0?.price ? parseFloat(d0.price) : null;
          const a1 = d1?.price ? parseFloat(d1.price) : null;
          if (a0 == null || a1 == null) { data._tennisFired.delete(condId); continue; }
          if (a0 + a1 > 1.03) {
            console.log(`[tennis] SKIP ${q.slice(0,40)}: ${(a0*100).toFixed(0)}+${(a1*100).toFixed(0)}=${((a0+a1)*100).toFixed(0)}¢ > 103`);
            data._tennisFired.delete(condId);
            continue;
          }
        } catch { data._tennisFired.delete(condId); continue; }

        console.log(`[tennis] ${data.title.slice(0,30)} | ${q.slice(0,40)} → ${winLabel} (minGames=${minTotalGames}, sets=${totalSetsPlayed})`);
        try {
          const result = await placeLive99Order(winToken, 10, negRisk, `[tennis] ${winLabel} on ${q.slice(0,30)} 10sh`);
          liveEventTracker.log.unshift({ ts: Date.now(), event: data.title, score: data.score, market: q.slice(0, 50), side: winLabel, price: '99.9¢', status: result?.status });
          if (liveEventTracker.log.length > 50) liveEventTracker.log.length = 50;
        } catch (err) {
          console.error(`[tennis] Error ${q.slice(0,30)}:`, err.message?.slice(0, 60));
        }
      }
    }

    // ── Esports BO3/BO5: Games Total O/U when series score guarantees more games ──
    for (const [slug, data] of liveEventTracker.knownLive) {
      if (!data.score || !String(data.score).includes('|') || !String(data.score).includes('Bo')) continue;
      if (!clobClient) continue;
      // Fetch markets if not loaded yet
      if (!data.markets?.length) {
        try {
          const evRes = await fetch(`https://gamma-api.polymarket.com/events?slug=${encodeURIComponent(slug)}`);
          const evData = await evRes.json();
          const ev = Array.isArray(evData) ? evData[0] : evData;
          if (ev?.markets?.length) data.markets = ev.markets;
        } catch {}
        if (!data.markets?.length) continue;
      }
      if (!data._esportsFired) data._esportsFired = new Set();

      const scoreParts = String(data.score).split('|');
      const seriesStr = scoreParts.length >= 2 ? scoreParts[1].trim() : '';
      const boStr = scoreParts.find(p => p.trim().startsWith('Bo')) || '';
      const boMatch = boStr.match(/Bo(\d+)/);
      if (!boMatch) continue;
      const bestOf = parseInt(boMatch[1]);
      const seriesParts = seriesStr.split('-').map(n => parseInt(n.trim())).filter(n => !isNaN(n));
      if (seriesParts.length !== 2) continue;

      const [s1, s2] = seriesParts;
      const totalGamesPlayed = s1 + s2;
      const winsNeeded = Math.ceil(bestOf / 2); // BO3=2, BO5=3

      for (const m of data.markets) {
        const ql = (m.question || '').toLowerCase();
        if (!ql.includes('games total') || !ql.includes('o/u')) continue;
        const condId = m.conditionId;
        if (!condId || data._esportsFired.has(condId)) continue;

        const ouMatch = ql.match(/o\/u\s*([\d.]+)/);
        if (!ouMatch) continue;
        const line = parseFloat(ouMatch[1]);

        // Minimum total games: current + minimum remaining
        // If neither team has won yet, min remaining = winsNeeded - max(s1,s2)
        // But for O/U Over, we need totalGamesPlayed + minRemaining > line
        // If s1 == s2 (tied), there MUST be at least 1 more game
        // Min remaining = winsNeeded - Math.max(s1, s2)
        const minRemaining = Math.max(0, winsNeeded - Math.max(s1, s2));
        const minTotalGames = totalGamesPlayed + minRemaining;

        const seriesOver = s1 >= winsNeeded || s2 >= winsNeeded;
        const tokens = typeof m.clobTokenIds === 'string' ? JSON.parse(m.clobTokenIds) : m.clobTokenIds;
        const outcomes = typeof m.outcomes === 'string' ? JSON.parse(m.outcomes) : m.outcomes;
        if (!tokens || tokens.length < 2) continue;
        const negRisk = m.negRisk != null ? m.negRisk : true;

        let winIdx = -1, winLabel = '';
        // Over: minimum total games already exceeds line
        if (minTotalGames > line) {
          winIdx = outcomes ? outcomes.findIndex(o => o.toLowerCase().includes('over')) : 0;
          if (winIdx < 0) winIdx = 0;
          winLabel = outcomes?.[winIdx] || 'Over';
        }
        // Under: series is over and total maps played is below line
        else if (seriesOver && totalGamesPlayed < line) {
          winIdx = outcomes ? outcomes.findIndex(o => o.toLowerCase().includes('under')) : 1;
          if (winIdx < 0) winIdx = 1;
          winLabel = outcomes?.[winIdx] || 'Under';
        }

        if (winIdx < 0) continue;
        data._esportsFired.add(condId);
        const winToken = tokens[winIdx];

        // No price check — mathematically verified from series score, just place limit
        console.log(`[esports] ${data.title.slice(0,30)} ${s1}-${s2} Bo${bestOf} → O/U ${line} ${winLabel} (${totalGamesPlayed} maps, min ${minTotalGames})`);
        try {
          const result = await placeLive99Order(winToken, 10, negRisk, `[esports] ${winLabel} O/U ${line} 10sh`);
          liveEventTracker.log.unshift({ ts: Date.now(), event: data.title, score: data.score, market: `Games O/U ${line} ${winLabel}`, side: winLabel, price: '99.9¢', status: result?.status });
          if (liveEventTracker.log.length > 50) liveEventTracker.log.length = 50;
        } catch (err) {
          console.error(`[esports] Error O/U ${line} ${winLabel}:`, err.message?.slice(0, 60));
        }

      } // end O/U for loop

      // ── Map/Game Winners: buy winner on completed maps ──
      // Series score s1+s2 = total maps played. Maps 1..N are decided.
      const mapsPlayed = s1 + s2;
        for (const m of data.markets) {
          const q = m.question || '';
          const ql = q.toLowerCase();
          // Match "Map X Winner" or "Game X Winner"
          const mapMatch = ql.match(/(?:map|game)\s*(\d+)\s*winner/);
          if (!mapMatch) continue;
          const mapNum = parseInt(mapMatch[1]);
          if (mapNum > mapsPlayed) continue; // map not finished yet

          const condId = m.conditionId;
          if (!condId || data._esportsFired.has(condId)) continue;

          // Use Gamma prices to determine winner
          const prices = m.outcomePrices ? (typeof m.outcomePrices === 'string' ? JSON.parse(m.outcomePrices) : m.outcomePrices) : null;
          const tokens = m.clobTokenIds ? (typeof m.clobTokenIds === 'string' ? JSON.parse(m.clobTokenIds) : m.clobTokenIds) : null;
          const outcomes = m.outcomes ? (typeof m.outcomes === 'string' ? JSON.parse(m.outcomes) : m.outcomes) : null;
          if (!prices || !tokens || prices.length < 2 || !outcomes) continue;

          const p0 = parseFloat(prices[0]), p1 = parseFloat(prices[1]);
          if (Math.max(p0, p1) < 0.90) continue; // not clear enough
          const winIdx = p0 >= p1 ? 0 : 1;
          const winToken = tokens[winIdx];
          const winLabel = outcomes[winIdx];
          const negRisk = m.negRisk != null ? m.negRisk : true;

          data._esportsFired.add(condId);

          // No CLOB price check — map is completed, Gamma confirms winner, just place limit
          console.log(`[esports] ${data.title.slice(0,30)} Map ${mapNum} Winner → ${winLabel} (Gamma ${(Math.max(p0,p1)*100).toFixed(0)}%)`);
          try {
            const result = await placeLive99Order(winToken, 10, negRisk, `[esports] ${winLabel} Map ${mapNum} 10sh`);
            liveEventTracker.log.unshift({ ts: Date.now(), event: data.title, score: data.score, market: `Map ${mapNum} Winner`, side: winLabel, price: '99.9¢', status: result?.status });
            if (liveEventTracker.log.length > 50) liveEventTracker.log.length = 50;
          } catch (err) {
            console.error(`[esports] Error Map ${mapNum}:`, err.message?.slice(0, 60));
          }
        }

        // ── Esports completed map props: buy winner on all decided Game X markets ──
        // "Game 1: Both Teams Destroy Barracks?", "First Blood in Game 1?", etc.
        for (const m of data.markets) {
          const q = m.question || '';
          const ql = q.toLowerCase();
          // Match "Game X:" or "Game X " at the start, or "in Game X"
          const gameMatch = ql.match(/(?:^game\s*(\d+)|in\s+game\s+(\d+))/);
          if (!gameMatch) continue;
          const gameNum = parseInt(gameMatch[1] || gameMatch[2]);
          if (gameNum > mapsPlayed) continue; // game not finished
          // Skip markets we already handle (map winner, O/U, handicap)
          if (ql.includes('winner') || ql.includes('o/u') || ql.includes('handicap')) continue;

          const condId = m.conditionId;
          if (!condId || data._esportsFired.has(condId)) continue;

          const prices = m.outcomePrices ? (typeof m.outcomePrices === 'string' ? JSON.parse(m.outcomePrices) : m.outcomePrices) : null;
          const tokens = m.clobTokenIds ? (typeof m.clobTokenIds === 'string' ? JSON.parse(m.clobTokenIds) : m.clobTokenIds) : null;
          const outcomes = m.outcomes ? (typeof m.outcomes === 'string' ? JSON.parse(m.outcomes) : m.outcomes) : null;
          if (!prices || !tokens || prices.length < 2 || !outcomes) continue;

          const p0 = parseFloat(prices[0]), p1 = parseFloat(prices[1]);
          if (Math.max(p0, p1) < 0.90) continue; // not decided enough
          const mktVol = parseFloat(m.volume || 0);
          if (mktVol < 50) continue; // skip no-volume markets

          const winIdx = p0 >= p1 ? 0 : 1;
          const winToken = tokens[winIdx];
          const winLabel = outcomes[winIdx];
          const negRisk = m.negRisk != null ? m.negRisk : true;

          // CLOB check: sum < 150¢ and winner > 98¢
          try {
            const [r0, r1] = await Promise.all([
              fetch('https://clob.polymarket.com/price?token_id=' + tokens[0] + '&side=sell'),
              fetch('https://clob.polymarket.com/price?token_id=' + tokens[1] + '&side=sell'),
            ]);
            const d0 = await r0.json(), d1 = await r1.json();
            const a0 = d0?.price ? parseFloat(d0.price) : null;
            const a1 = d1?.price ? parseFloat(d1.price) : null;
            if (a0 == null || a1 == null) continue;
            const clobSum = a0 + a1;
            const winAsk = winIdx === 0 ? a0 : a1;
            if (clobSum > 1.50) continue;
            if (clobSum > 1.03 && (winAsk < 0.98 || mktVol < 50)) continue;
          } catch { continue; }

          data._esportsFired.add(condId);
          const shares = 10;
          console.log(`[esports] ${data.title.slice(0,25)} Game ${gameNum}: ${q.slice(0,35)} → ${winLabel} ($${mktVol.toFixed(0)} vol)`);
          try {
            const result = await placeLive99Order(winToken, shares, negRisk, `[esports] ${winLabel} ${q.slice(0,25)} ${shares}sh`);
            liveEventTracker.log.unshift({ ts: Date.now(), event: data.title, score: data.score, market: q.slice(0, 50), side: winLabel, price: '99.9¢', status: result?.status });
            if (liveEventTracker.log.length > 50) liveEventTracker.log.length = 50;
          } catch (err) {
            console.error(`[esports] Error prop ${q.slice(0,25)}:`, err.message?.slice(0, 60));
          }
        }

        // ── Esports Map Handicap: if series lead >= handicap, it's guaranteed ──
        // e.g., 2-0 in BO3 → Team (-1.5) is guaranteed (lead of 2 > 1.5)
        for (const m of data.markets) {
          const q = m.question || '';
          const ql = q.toLowerCase();
          if (!ql.includes('handicap')) continue;
          const condId = m.conditionId;
          if (!condId || data._esportsFired.has(condId)) continue;

          const hcMatch = ql.match(/\(([+-]?\d+\.?\d*)\)/);
          if (!hcMatch) continue;
          const spread = parseFloat(hcMatch[1]); // e.g., -1.5
          if (spread >= 0) continue; // only negative handicaps (the favored side)

          const tokens = typeof m.clobTokenIds === 'string' ? JSON.parse(m.clobTokenIds) : m.clobTokenIds;
          const outcomes = typeof m.outcomes === 'string' ? JSON.parse(m.outcomes) : m.outcomes;
          if (!tokens || tokens.length < 2 || !outcomes) continue;

          // Figure out which team has the handicap — outcomes[0] is the handicap team
          // Check if that team's series lead covers the spread
          // outcomes[0] is listed first in the handicap market title
          const lead1 = s1 - s2; // team1 lead
          const lead2 = s2 - s1; // team2 lead
          // The handicap team needs: their actual lead + spread > 0
          // We check with Gamma prices since we can't reliably map team names
          const prices = m.outcomePrices ? (typeof m.outcomePrices === 'string' ? JSON.parse(m.outcomePrices) : m.outcomePrices) : null;
          if (!prices) continue;
          const p0 = parseFloat(prices[0]), p1 = parseFloat(prices[1]);
          if (Math.max(p0, p1) < 0.90) continue; // not clear enough
          const winIdx = p0 >= p1 ? 0 : 1;
          const winToken = tokens[winIdx];
          const winLabel = outcomes[winIdx];
          const negRisk = m.negRisk != null ? m.negRisk : true;

          // Verify: the actual lead must mathematically cover the spread
          // If it's BO3 and score is 2-0, lead=2, spread=-1.5 → 2+(-1.5)=0.5 > 0 → covered
          const maxLead = Math.max(lead1, lead2);
          if (maxLead + spread <= 0) continue; // spread not covered yet

          data._esportsFired.add(condId);

          // Price check
          try {
            const [r0, r1] = await Promise.all([
              fetch('https://clob.polymarket.com/price?token_id=' + tokens[0] + '&side=sell'),
              fetch('https://clob.polymarket.com/price?token_id=' + tokens[1] + '&side=sell'),
            ]);
            const d0 = await r0.json(), d1 = await r1.json();
            const a0 = d0?.price ? parseFloat(d0.price) : null;
            const a1 = d1?.price ? parseFloat(d1.price) : null;
            if (a0 == null || a1 == null) { data._esportsFired.delete(condId); continue; }
            if (a0 + a1 > 1.03) { data._esportsFired.delete(condId); continue; }
          } catch { data._esportsFired.delete(condId); continue; }

          console.log(`[esports] ${data.title.slice(0,30)} ${s1}-${s2} Handicap ${spread} → ${winLabel}`);
          try {
            const result = await placeLive99Order(winToken, 10, negRisk, `[esports] ${winLabel} HC ${spread} 10sh`);
            liveEventTracker.log.unshift({ ts: Date.now(), event: data.title, score: data.score, market: q.slice(0, 50), side: winLabel, price: '99.9¢', status: result?.status });
            if (liveEventTracker.log.length > 50) liveEventTracker.log.length = 50;
          } catch (err) {
            console.error(`[esports] Error HC ${spread}:`, err.message?.slice(0, 60));
          }
        }
      }

    // ── Soccer: "Both Teams to Score: Yes" when both teams have scored ──
    for (const [slug, data] of liveEventTracker.knownLive) {
      if (!data.score || String(data.score).includes('|') || String(data.score).includes(',')) continue;
      const parts = String(data.score).split('-').map(p => parseInt(p.trim())).filter(n => !isNaN(n));
      if (parts.length !== 2) continue;
      const [home, away] = parts;
      if (home === 0 || away === 0) continue; // both must have scored
      if (!data._bttsFired) data._bttsFired = false;
      if (data._bttsFired) continue;

      for (const m of (data.markets || [])) {
        const ql = (m.question || '').toLowerCase();
        if (!ql.includes('both teams') || !ql.includes('score')) continue;
        const tokens = typeof m.clobTokenIds === 'string' ? JSON.parse(m.clobTokenIds) : m.clobTokenIds;
        const outcomes = typeof m.outcomes === 'string' ? JSON.parse(m.outcomes) : m.outcomes;
        if (!tokens || tokens.length < 2 || !outcomes) continue;

        // "Yes" = both teams scored = guaranteed
        const yesIdx = outcomes.findIndex(o => o.toLowerCase() === 'yes');
        if (yesIdx < 0) continue;
        const yesToken = tokens[yesIdx];
        const negRisk = m.negRisk != null ? m.negRisk : true;

        // Price check
        try {
          const [r0, r1] = await Promise.all([
            fetch('https://clob.polymarket.com/price?token_id=' + tokens[0] + '&side=sell'),
            fetch('https://clob.polymarket.com/price?token_id=' + tokens[1] + '&side=sell'),
          ]);
          const d0 = await r0.json(), d1 = await r1.json();
          const a0 = d0?.price ? parseFloat(d0.price) : null;
          const a1 = d1?.price ? parseFloat(d1.price) : null;
          if (a0 == null || a1 == null) continue;
          if (a0 + a1 > 1.03) continue;
        } catch { continue; }

        data._bttsFired = true;
        console.log(`[soccer] ${data.title.slice(0,30)} ${data.score} → Both Teams to Score: YES`);
        try {
          const result = await placeLive99Order(yesToken, 10, negRisk, `[soccer] BTTS Yes 10sh`);
          liveEventTracker.log.unshift({ ts: Date.now(), event: data.title, score: data.score, market: 'Both Teams to Score', side: 'Yes', price: '99.9¢', status: result?.status });
          if (liveEventTracker.log.length > 50) liveEventTracker.log.length = 50;
        } catch (err) {
          console.error(`[soccer] BTTS error:`, err.message?.slice(0, 60));
        }
        break;
      }
    }

    // ── MLB: "Run in first inning: Yes" when score > 0 in 1st inning ──
    for (const [slug, data] of liveEventTracker.knownLive) {
      if (!data.score || String(data.score).includes('|') || String(data.score).includes(',')) continue;
      const period = (data.period || '').toLowerCase();
      if (!period.includes('1st')) continue; // must still be in 1st inning
      const parts = String(data.score).split('-').map(p => parseInt(p.trim())).filter(n => !isNaN(n));
      if (parts.length !== 2 || parts[0] + parts[1] === 0) continue;
      if (!data._firstInningFired) data._firstInningFired = false;
      if (data._firstInningFired) continue;

      for (const m of (data.markets || [])) {
        const ql = (m.question || '').toLowerCase();
        if (!ql.includes('run') || !ql.includes('first inning')) continue;
        const tokens = typeof m.clobTokenIds === 'string' ? JSON.parse(m.clobTokenIds) : m.clobTokenIds;
        const outcomes = typeof m.outcomes === 'string' ? JSON.parse(m.outcomes) : m.outcomes;
        if (!tokens || tokens.length < 2 || !outcomes) continue;

        const yesIdx = outcomes.findIndex(o => o.toLowerCase().includes('yes') || o.toLowerCase().includes('run'));
        if (yesIdx < 0) continue;
        const yesToken = tokens[yesIdx];
        const negRisk = m.negRisk != null ? m.negRisk : true;

        // Price check
        try {
          const [r0, r1] = await Promise.all([
            fetch('https://clob.polymarket.com/price?token_id=' + tokens[0] + '&side=sell'),
            fetch('https://clob.polymarket.com/price?token_id=' + tokens[1] + '&side=sell'),
          ]);
          const d0 = await r0.json(), d1 = await r1.json();
          const a0 = d0?.price ? parseFloat(d0.price) : null;
          const a1 = d1?.price ? parseFloat(d1.price) : null;
          if (a0 == null || a1 == null) continue;
          if (a0 + a1 > 1.03) continue;
        } catch { continue; }

        data._firstInningFired = true;
        console.log(`[mlb] ${data.title.slice(0,30)} ${data.score} in ${data.period} → First inning run: YES`);
        try {
          const result = await placeLive99Order(yesToken, 10, negRisk, `[mlb] 1st inning run Yes 10sh`);
          liveEventTracker.log.unshift({ ts: Date.now(), event: data.title, score: data.score, market: 'First inning run', side: 'Yes', price: '99.9¢', status: result?.status });
          if (liveEventTracker.log.length > 50) liveEventTracker.log.length = 50;
        } catch (err) {
          console.error(`[mlb] 1st inning error:`, err.message?.slice(0, 60));
        }
        break;
      }
    }

    // ── Exact Score: check ALL tracked soccer games on every poll ──
    for (const [slug, data] of liveEventTracker.knownLive) {
      if (!data.score || String(data.score).includes('|')) continue; // skip esports
      const scoreParts = String(data.score).split('-').map(p => parseInt(p.trim())).filter(n => !isNaN(n));
      if (scoreParts.length !== 2 || scoreParts[0] + scoreParts[1] === 0) continue; // skip 0-0
      if (!data.exactScoreFired) data.exactScoreFired = new Set();
      checkExactScores(slug, data.title, data.score, data.exactScoreFired);
    }

    // Check for events that WERE live but are NO LONGER in the live list
    for (const [slug, data] of liveEventTracker.knownLive) {
      if (currentLive.has(slug)) continue; // still live
      if (liveEventTracker.fired.has(slug)) continue; // already fired

      // This event just ended! Re-fetch fresh data and fire 99¢ on ALL markets
      liveEventTracker.fired.add(slug);
      liveEventTracker.knownLive.delete(slug);

      console.log(`[live-99] EVENT ENDED: ${data.title} (${data.score}) — waiting 10s for prices to settle`);

      // Wait 10 seconds for prices to settle before placing orders
      await new Promise(r => setTimeout(r, 10000));

      // Re-fetch event to get latest prices for all markets
      let freshMarkets = data.markets || [];
      try {
        const freshRes = await fetch(`https://gamma-api.polymarket.com/events?slug=${encodeURIComponent(slug)}`);
        const freshData = await freshRes.json();
        const freshEvent = Array.isArray(freshData) ? freshData[0] : freshData;
        if (freshEvent?.markets?.length) freshMarkets = freshEvent.markets;
      } catch {}

      console.log(`[live-99] ${data.title}: ${freshMarkets.length} markets to check`);

      let placed = 0;
      // Buy winning side on ALL markets in the event
      for (const m of freshMarkets) {
        if (m.closed) continue;
        const prices = m.outcomePrices ? (typeof m.outcomePrices === 'string' ? JSON.parse(m.outcomePrices) : m.outcomePrices) : null;
        const tokens = m.clobTokenIds ? (typeof m.clobTokenIds === 'string' ? JSON.parse(m.clobTokenIds) : m.clobTokenIds) : null;
        const outcomes = m.outcomes ? (typeof m.outcomes === 'string' ? JSON.parse(m.outcomes) : m.outcomes) : null;
        if (!prices || !tokens || prices.length < 2) continue;

        const p0 = parseFloat(prices[0]);
        const p1 = parseFloat(prices[1]);
        // Winner must be > 90¢ AND loser must be < 10¢ — clear result
        const winIdx = p0 >= p1 ? 0 : 1;
        const winPrice = Math.max(p0, p1);
        const losePrice = Math.min(p0, p1);
        const winToken = tokens[winIdx];
        const winOutcome = outcomes ? outcomes[winIdx] : winIdx === 0 ? 'Yes' : 'No';

        if (!winToken || winPrice < 0.90 || losePrice > 0.15) {
          console.log(`[live-99] SKIP ${m.question?.slice(0,30)}: winner=${(winPrice*100).toFixed(0)}¢ loser=${(losePrice*100).toFixed(0)}¢ — not clear enough`);
          continue;
        }

        let orderSize = 10;
        // Verify BOTH sides from CLOB — sum must be <= 103¢
        try {
          const [r0, r1] = await Promise.all([
            fetch('https://clob.polymarket.com/price?token_id=' + tokens[0] + '&side=sell'),
            fetch('https://clob.polymarket.com/price?token_id=' + tokens[1] + '&side=sell'),
          ]);
          const d0 = await r0.json(), d1 = await r1.json();
          const a0 = d0?.price ? parseFloat(d0.price) : null;
          const a1 = d1?.price ? parseFloat(d1.price) : null;
          if (a0 == null || a1 == null) {
            console.log(`[live-99] SKIP ${m.question?.slice(0,30)}: no price data`);
            continue;
          }
          const clobSum = a0 + a1;
          const winAsk = winIdx === 0 ? a0 : a1;
          const mktVol = parseFloat(m.volume || 0);
          if (clobSum > 1.50) {
            console.log(`[live-99] SKIP ${m.question?.slice(0,30)}: ${(a0*100).toFixed(0)}+${(a1*100).toFixed(0)}=${(clobSum*100).toFixed(0)}¢ > 150`);
            continue;
          }
          // If sum > 103 but < 150, only buy if winner > 98¢ and volume > $50 (5sh instead of 10)
          if (clobSum > 1.03 && (winAsk < 0.98 || mktVol < 50)) {
            console.log(`[live-99] SKIP ${m.question?.slice(0,30)}: ${(a0*100).toFixed(0)}+${(a1*100).toFixed(0)}=${(clobSum*100).toFixed(0)}¢ > 103, ask ${(winAsk*100).toFixed(0)}¢ vol $${mktVol.toFixed(0)}`);
            continue;
          }
          orderSize = clobSum > 1.03 ? 5 : 10; // Smaller size for less certain markets
        } catch { continue; }

        // Try 99.9¢ first (0.001 tick), fall back to 99¢ (0.01 tick)
        const negRisk = m.negRisk != null ? m.negRisk : true;

        try {
          let result = null;
          const expiration = Math.floor(Date.now() / 1000) + 1800; // 30 min
          try {
            const signed = await clobClient.createOrder(
              { tokenID: winToken, price: 0.999, size: orderSize, side: 'BUY', expiration },
              { tickSize: '0.001', negRisk },
            );
            result = await clobClient.postOrder(signed, 'GTD');
          } catch {
            const signed2 = await clobClient.createOrder(
              { tokenID: winToken, price: 0.99, size: orderSize, side: 'BUY', expiration },
              { tickSize: '0.01', negRisk },
            );
            result = await clobClient.postOrder(signed2, 'GTD');
          }
          placed++;
          const logEntry = {
            ts: Date.now(),
            event: data.title,
            score: data.score,
            market: m.question?.slice(0, 50),
            side: winOutcome,
            price: (winPrice * 100).toFixed(0) + '¢',
            status: result?.status,
            orderId: result?.orderID?.slice(0, 12),
          };
          liveEventTracker.log.unshift(logEntry);
          if (liveEventTracker.log.length > 50) liveEventTracker.log.length = 50;
          console.log(`[live-99] PLACED: ${data.title} | ${m.question?.slice(0,30)} | ${winOutcome} ${orderSize}sh @ 99.9¢ → ${result?.status}`);
        } catch (err) {
          console.error(`[live-99] Error: ${m.question?.slice(0,30)}:`, err.message?.slice(0, 80));
        }
      }
      console.log(`[live-99] ${data.title}: placed ${placed} orders across ${freshMarkets.length} markets`);

      // Also buy on exact score event if it's a soccer game
      if (data.score && !String(data.score).includes('|')) {
        await buyExactScoreOnEnd(slug, data.title, data.score);
      }
    }

    // Clean up old fired slugs (keep last 200)
    if (liveEventTracker.fired.size > 200) {
      const arr = [...liveEventTracker.fired];
      liveEventTracker.fired = new Set(arr.slice(-100));
    }

    // Persist to disk every poll
    saveLiveEvents(liveEventTracker.knownLive, liveEventTracker.fired);
  } catch (e) {
    // silent — don't spam logs on API errors
  }
}, 3000);

// ── Startup scan: catch recently ended events we missed during restarts ──
setTimeout(async () => {
  if (!clobClient) return;
  console.log('[startup-scan] Scanning for recently ended events...');
  try {
    // Fetch events that were live recently — check if any ended
    const r = await fetch('https://gamma-api.polymarket.com/events?active=true&closed=false&limit=200&order=volume&ascending=false');
    const events = await r.json();
    if (!Array.isArray(events)) return;

    let placed = 0;
    for (const e of events) {
      const slug = e.slug;
      if (!slug) continue;
      if (liveEventTracker.fired.has(slug)) continue; // already handled
      if (e.live) continue; // still live
      if (!e.ended) continue; // not ended

      // Skip crypto
      if (slug.includes('updown') || slug.includes('up-or-down')) continue;

      const mkts = e.markets || [];
      let hasDecided = false;
      for (const m of mkts) {
        const prices = m.outcomePrices ? (typeof m.outcomePrices === 'string' ? JSON.parse(m.outcomePrices) : m.outcomePrices) : null;
        if (!prices || prices.length < 2) continue;
        if (Math.max(parseFloat(prices[0]), parseFloat(prices[1])) >= 0.90) { hasDecided = true; break; }
      }
      if (!hasDecided) continue;

      liveEventTracker.fired.add(slug);
      console.log(`[startup-scan] Found ended event: ${e.title} (${e.score})`);

      // Same logic as end-of-game scanner
      for (const m of mkts) {
        if (m.closed) continue;
        const prices = m.outcomePrices ? (typeof m.outcomePrices === 'string' ? JSON.parse(m.outcomePrices) : m.outcomePrices) : null;
        const tokens = m.clobTokenIds ? (typeof m.clobTokenIds === 'string' ? JSON.parse(m.clobTokenIds) : m.clobTokenIds) : null;
        const outcomes = m.outcomes ? (typeof m.outcomes === 'string' ? JSON.parse(m.outcomes) : m.outcomes) : null;
        if (!prices || !tokens || prices.length < 2) continue;

        const p0 = parseFloat(prices[0]), p1 = parseFloat(prices[1]);
        const winIdx = p0 >= p1 ? 0 : 1;
        const winPrice = Math.max(p0, p1);
        const losePrice = Math.min(p0, p1);
        const winToken = tokens[winIdx];
        const winOutcome = outcomes ? outcomes[winIdx] : winIdx === 0 ? 'Yes' : 'No';
        const negRisk = m.negRisk != null ? m.negRisk : true;

        if (!winToken || winPrice < 0.90 || losePrice > 0.15) continue;

        // Both sides sum check
        try {
          const [r0, r1] = await Promise.all([
            fetch('https://clob.polymarket.com/price?token_id=' + tokens[0] + '&side=sell'),
            fetch('https://clob.polymarket.com/price?token_id=' + tokens[1] + '&side=sell'),
          ]);
          const d0 = await r0.json(), d1 = await r1.json();
          const a0 = d0?.price ? parseFloat(d0.price) : null;
          const a1 = d1?.price ? parseFloat(d1.price) : null;
          if (a0 == null || a1 == null) continue;
          if (a0 + a1 > 1.03) continue;
        } catch { continue; }

        try {
          const result = await placeLive99Order(winToken, 10, negRisk, `[startup-scan] ${winOutcome} on ${m.question?.slice(0,30)} 10sh`);
          if (result) placed++;
        } catch {}
      }
    }
    console.log(`[startup-scan] Done. Placed ${placed} orders on missed events.`);
  } catch (err) {
    console.error('[startup-scan] Error:', err.message?.slice(0, 100));
  }
}, 10000); // Run 10s after startup

// ── Weather Temperature Scanner ──
// Every hour, check actual observed temps and buy on decided weather markets
const WEATHER_CITIES = {
  tokyo: { station: 'RJTT:9:JP', tz: 'Asia/Tokyo' },
  singapore: { station: 'WSSS:9:SG', tz: 'Asia/Singapore' },
  // wellington: { station: 'NZWN:9:NZ', tz: 'Pacific/Auckland' },
  // paris: { station: 'LFPG:9:FR', tz: 'Europe/Paris' },
  // miami: { station: 'KMIA:9:US', tz: 'America/New_York' },
  // seoul: { station: 'RKSS:9:KR', tz: 'Asia/Seoul' },
};
const weatherFired = new Set(); // track conditionIds we've already placed on

async function getObservedMaxTemp(station, dateStr) {
  try {
    const r = await fetch(`https://api.weather.com/v1/location/${station}/observations/historical.json?apiKey=e1f10a1e78da46f5b10a1e78da96f525&units=m&startDate=${dateStr}&endDate=${dateStr}`);
    const data = await r.json();
    const obs = data.observations || [];
    if (!obs.length) return null;
    const temps = obs.map(o => o.temp).filter(t => t != null);
    return temps.length ? Math.max(...temps) : null;
  } catch { return null; }
}

async function runWeatherScan() {
    try {
      if (!clobClient) { scheduleWeatherScan(); return; }

      const now = new Date();
      const bal = await getUsdcBalance();
      if (bal < 10) { scheduleWeatherScan(); return; }

      for (const [city, info] of Object.entries(WEATHER_CITIES)) {
        // Get today's date in the city's timezone
        const localDate = new Date(now.toLocaleString('en-US', { timeZone: info.tz }));
        const localHour = localDate.getHours();

        // Format date for API: YYYYMMDD
        const y = localDate.getFullYear();
        const m = String(localDate.getMonth() + 1).padStart(2, '0');
        const d = String(localDate.getDate()).padStart(2, '0');
        const dateStr = `${y}${m}${d}`;
        const slugDate = `${y}-${m}-${d}`;

        // Get observed max temp
        const maxTemp = await getObservedMaxTemp(info.station, dateStr);
        if (maxTemp == null) continue;

        // Find Poly event for this city and date
        const slug = `highest-temperature-in-${city}-on-${slugDate.replace(/-0/g, '-').replace(/-/g, '-')}`;
        // Poly slugs use format: highest-temperature-in-wellington-on-april-6-2026
        const monthNames = ['january','february','march','april','may','june','july','august','september','october','november','december'];
        const polySlug = `highest-temperature-in-${city}-on-${monthNames[localDate.getMonth()]}-${localDate.getDate()}-${y}`;

        let event;
        try {
          const er = await fetch(`https://gamma-api.polymarket.com/events?slug=${polySlug}`);
          const ed = await er.json();
          event = Array.isArray(ed) ? ed[0] : ed;
        } catch { continue; }
        if (!event?.markets?.length) continue;

        console.log(`[weather] ${city} ${slugDate} | max observed: ${maxTemp}°C | hour: ${localHour} | ${event.markets.length} markets`);

        for (const mkt of event.markets) {
          const q = (mkt.question || '');
          const condId = mkt.conditionId;
          if (!condId || weatherFired.has(condId)) continue;

          const tokens = typeof mkt.clobTokenIds === 'string' ? JSON.parse(mkt.clobTokenIds) : mkt.clobTokenIds;
          const outcomes = typeof mkt.outcomes === 'string' ? JSON.parse(mkt.outcomes) : mkt.outcomes;
          if (!tokens || tokens.length < 2 || !outcomes) continue;
          const negRisk = mkt.negRisk != null ? mkt.negRisk : true;

          // Parse the temperature from the question
          // "Will the highest temperature in X be 22°C on ..." → 22
          // "Will the highest temperature in X be 23°C or higher..." → 23+
          // "Will the highest temperature in X be 13°C or below..." → 13-
          const exactMatch = q.match(/be\s+(\d+)°C\s+on/);
          const orHigherMatch = q.match(/be\s+(\d+)°C\s+or\s+high/i);
          const orBelowMatch = q.match(/be\s+(\d+)°C\s+or\s+below/i);

          let winIdx = -1;

          if (orBelowMatch) {
            const threshold = parseInt(orBelowMatch[1]);
            // "X°C or below" — if observed max > threshold, NO is guaranteed
            if (maxTemp > threshold) {
              winIdx = outcomes.findIndex(o => o.toLowerCase() === 'no');
              if (winIdx < 0) winIdx = 1;
            }
          } else if (orHigherMatch) {
            const threshold = parseInt(orHigherMatch[1]);
            // "X°C or higher" — if observed max >= threshold, YES is guaranteed
            // But only if day is essentially over (after 6 PM local)
            if (maxTemp >= threshold) {
              winIdx = outcomes.findIndex(o => o.toLowerCase() === 'yes');
              if (winIdx < 0) winIdx = 0;
            }
            // If max < threshold AND day is over, NO is guaranteed
            if (maxTemp < threshold && localHour >= 20) {
              winIdx = outcomes.findIndex(o => o.toLowerCase() === 'no');
              if (winIdx < 0) winIdx = 1;
            }
          } else if (exactMatch) {
            const threshold = parseInt(exactMatch[1]);
            // "Will highest be X°C" — exact match
            // If observed max already > threshold, NO is guaranteed (max exceeded X)
            if (maxTemp > threshold) {
              winIdx = outcomes.findIndex(o => o.toLowerCase() === 'no');
              if (winIdx < 0) winIdx = 1;
            }
            // If day is over and max == threshold, YES is guaranteed
            if (maxTemp === threshold && localHour >= 20) {
              winIdx = outcomes.findIndex(o => o.toLowerCase() === 'yes');
              if (winIdx < 0) winIdx = 0;
            }
            // If day is over and max != threshold, NO is guaranteed
            if (maxTemp !== threshold && localHour >= 20) {
              winIdx = outcomes.findIndex(o => o.toLowerCase() === 'no');
              if (winIdx < 0) winIdx = 1;
            }
          }

          if (winIdx < 0) continue;
          weatherFired.add(condId);
          const winToken = tokens[winIdx];
          const winLabel = outcomes[winIdx];

          console.log(`[weather] ${city} ${maxTemp}°C → ${q.slice(0, 45)} → ${winLabel}`);
          try {
            const result = await placeLive99Order(winToken, 10, negRisk, `[weather] ${city} ${winLabel} 10sh`);
            liveEventTracker.log.unshift({ ts: Date.now(), event: event.title, market: q.slice(0, 50), side: winLabel, price: '99.9¢', status: result?.status });
            if (liveEventTracker.log.length > 50) liveEventTracker.log.length = 50;
          } catch (err) {
            console.error(`[weather] Error ${city}:`, err.message?.slice(0, 60));
          }
        }
      }
    } catch (e) {
      console.error('[weather] Scan error:', e.message?.slice(0, 100));
    }
}
function scheduleWeatherLoop() {
  // Wait until next :01, :16, :31, or :46 (1 min after weather data updates)
  const _nm = new Date().getMinutes();
  const _targets = [1, 16, 31, 46];
  let _wait = _targets.find(t => t > _nm);
  if (!_wait) _wait = 61;
  const _delay = Math.max(((_wait - _nm) * 60 - new Date().getSeconds()) * 1000, 10000);
  console.log(`[weather] Next scan in ${Math.round(_delay/60000)}min`);
  setTimeout(async () => {
    await runWeatherScan();
    scheduleWeatherLoop();
  }, _delay);
}
// Weather scanner — disabled temporarily, was spamming dead orderbooks
// setTimeout(async () => {
//   console.log('[weather] Starting weather scanner...');
//   await runWeatherScan();
//   scheduleWeatherLoop();
// }, 15000);

// Scan for decided markets (99%+) and place 99.9¢ bids
const decidedScanner = { enabled: false, placed: new Set(), log: [] };

app.post('/api/decided99/toggle', (req, res) => {
  decidedScanner.enabled = !decidedScanner.enabled;
  console.log(`[decided-99] ${decidedScanner.enabled ? 'ENABLED' : 'DISABLED'}`);
  res.json({ enabled: decidedScanner.enabled });
});

app.get('/api/decided99/status', (req, res) => {
  res.json({ enabled: decidedScanner.enabled, placed: decidedScanner.placed.size, log: decidedScanner.log.slice(0, 20) });
});

// Scan every 10s for decided markets + markets ending within 2 days
setInterval(async () => {
  if (!decidedScanner.enabled || !clobClient) return;

  try {
    const twoDays = new Date(Date.now() + 2 * 86400000).toISOString().slice(0, 10);
    const today = new Date().toISOString().slice(0, 10);
    const [decidedRes, endingSoonRes, recentRes] = await Promise.all([
      fetch('https://gamma-api.polymarket.com/markets?active=true&closed=false&limit=200&order=volume&ascending=false').then(r => r.json()).catch(() => []),
      fetch(`https://gamma-api.polymarket.com/markets?active=true&closed=false&limit=200&end_date_min=${today}T00:00:00Z&end_date_max=${twoDays}T23:59:59Z`).then(r => r.json()).catch(() => []),
      fetch('https://gamma-api.polymarket.com/markets?active=true&closed=false&limit=200&order=endDate&ascending=true').then(r => r.json()).catch(() => []),
    ]);
    const allMarkets = [...(Array.isArray(decidedRes) ? decidedRes : []), ...(Array.isArray(endingSoonRes) ? endingSoonRes : []), ...(Array.isArray(recentRes) ? recentRes : [])];
    // Dedupe by conditionId
    const seen = new Set();
    const markets = allMarkets.filter(m => { if (!m.conditionId || seen.has(m.conditionId)) return false; seen.add(m.conditionId); return true; });

    for (const m of markets) {
      const condId = m.conditionId;
      if (!condId || decidedScanner.placed.has(condId)) continue;

      const prices = m.outcomePrices ? JSON.parse(m.outcomePrices) : null;
      const tokens = m.clobTokenIds ? JSON.parse(m.clobTokenIds) : null;
      const outcomes = m.outcomes ? JSON.parse(m.outcomes) : null;
      if (!prices || !tokens || prices.length < 2) continue;

      const p0 = parseFloat(prices[0]);
      const p1 = parseFloat(prices[1]);
      const winPrice = Math.max(p0, p1);
      const losePrice = Math.min(p0, p1);

      // Bid when winner hits 99.9%
      if (winPrice < 0.999 || losePrice > 0.05) continue;

      // Skip Yes/No markets where "No" is winning — these are multi-choice garbage
      // (e.g. "Will Jalen Duren lead rebounds?" No @ 99.9% — meaningless)
      const winIdx2 = p0 >= p1 ? 0 : 1;
      const outcomes2 = m.outcomes ? (typeof m.outcomes === 'string' ? JSON.parse(m.outcomes) : m.outcomes) : null;
      if (outcomes2 && outcomes2.length === 2) {
        const winOutcome = (outcomes2[winIdx2] || '').toLowerCase();
        if (winOutcome === 'no') continue; // "No" winning = multi-choice, skip
      }

      // Skip crypto up/down
      const q = (m.question || '').toLowerCase();
      if (q.includes('up or down') || q.includes('updown')) continue;

      // Only bid on markets that opened/started/end within 24h
      const endTime = m.endDate ? new Date(m.endDate).getTime() : 0;
      const startTime = m.startDate ? new Date(m.startDate).getTime() : 0;
      const createdTime = m.createdAt ? new Date(m.createdAt).getTime() : 0;
      const now = Date.now();
      const endsWithin24h = endTime > now && endTime < now + 24 * 3600000;
      const startedWithin24h = startTime > now - 24 * 3600000;
      const createdWithin24h = createdTime > now - 24 * 3600000;
      // Must end within 24h OR be a live sport (started within 24h)
      if (!endsWithin24h && !startedWithin24h) continue;
      // Skip ended markets
      if (endTime < now && !startedWithin24h) continue;

      // Verify CLOB ask > 97¢ before placing
      try {
        const winToken2 = tokens[p0 >= p1 ? 0 : 1];
        if (winToken2) {
          const pr = await fetch('https://clob.polymarket.com/price?token_id=' + winToken2 + '&side=sell');
          const pd = await pr.json();
          const ask = pd?.price ? parseFloat(pd.price) : null;
          if (ask != null && ask < 0.97) continue;
        }
      } catch {}
      await new Promise(r => setTimeout(r, 100));

      const winIdx = p0 >= p1 ? 0 : 1;
      const winToken = tokens[winIdx];
      const winOutcome = outcomes ? outcomes[winIdx] : 'Yes';
      if (!winToken) continue;

      decidedScanner.placed.add(condId);
      const negRisk = m.negRisk != null ? m.negRisk : true;

      try {
        let result = null;
        try {
          const signed = await clobClient.createOrder(
            { tokenID: winToken, price: 0.999, size: 10, side: 'BUY' },
            { tickSize: '0.001', negRisk },
          );
          result = await clobClient.postOrder(signed, 'GTC');
        } catch {
          try {
            const signed2 = await clobClient.createOrder(
              { tokenID: winToken, price: 0.99, size: 10, side: 'BUY' },
              { tickSize: '0.01', negRisk },
            );
            result = await clobClient.postOrder(signed2, 'GTC');
          } catch {
            const signed3 = await clobClient.createOrder(
              { tokenID: winToken, price: 0.99, size: 10, side: 'BUY' },
              { tickSize: '0.01', negRisk: false },
            );
            result = await clobClient.postOrder(signed3, 'GTC');
          }
        }
        const logEntry = { ts: Date.now(), market: m.question?.slice(0, 50), side: winOutcome, price: (winPrice*100).toFixed(1) + '¢', status: result?.status };
        decidedScanner.log.unshift(logEntry);
        if (decidedScanner.log.length > 100) decidedScanner.log.length = 100;
        console.log(`[decided-99] PLACED: ${winOutcome} 5sh @ 99.9¢ | ${m.question?.slice(0,40)} → ${result?.status}`);
      } catch (err) {
        console.error(`[decided-99] Error: ${m.question?.slice(0,30)}:`, err.message?.slice(0, 80));
      }

      await new Promise(r => setTimeout(r, 200)); // rate limit
    }
  } catch {}
}, 10000);

// Helper: place 5 limit orders of 5sh each at 99.9¢ (or 99¢ fallback)
async function place99x5(tokenId, negRisk) {
  const results = [];
  for (let i = 0; i < 5; i++) {
    try {
      let result = null;
      try {
        const signed = await clobClient.createOrder(
          { tokenID: tokenId, price: 0.999, size: 10, side: 'BUY' },
          { tickSize: '0.001', negRisk },
        );
        result = await clobClient.postOrder(signed, 'GTC');
      } catch {
        try {
          const signed2 = await clobClient.createOrder(
            { tokenID: tokenId, price: 0.99, size: 10, side: 'BUY' },
            { tickSize: '0.01', negRisk },
          );
          result = await clobClient.postOrder(signed2, 'GTC');
        } catch {
          const signed3 = await clobClient.createOrder(
            { tokenID: tokenId, price: 0.99, size: 10, side: 'BUY' },
            { tickSize: '0.01', negRisk: !negRisk },
          );
          result = await clobClient.postOrder(signed3, 'GTC');
        }
      }
      results.push(result);
    } catch (err) {
      results.push({ error: err.message?.slice(0, 50) });
    }
    await new Promise(r => setTimeout(r, 100));
  }
  return results;
}

// General Poly buy — any market, any token
app.post('/api/poly/buy', async (req, res) => {
  if (!clobClient) return res.status(500).json({ error: 'CLOB client not ready' });
  const { tokenId, shares: reqShares, limitPrice, tickSize: reqTick, negRisk: reqNeg, orderType } = req.body;
  if (!tokenId) return res.status(400).json({ error: 'tokenId required' });
  const shares = Math.max(1, Math.round(parseFloat(reqShares || 5)));
  const price = Math.max(0.01, Math.min(parseFloat(limitPrice || 0.99), 0.99));
  const tickSize = reqTick || '0.01';
  const negRisk = reqNeg || false;
  try {
    const signed = await clobClient.createOrder(
      { tokenID: tokenId, price, size: shares, side: 'BUY' },
      { tickSize: String(tickSize), negRisk },
    );
    const result = await clobClient.postOrder(signed, orderType || 'GTC');
    console.log(`[poly-buy] ${shares}sh @ ${(price*100).toFixed(0)}¢ token:${tokenId.slice(0,12)} → ${result?.status || result?.orderID?.slice(0,8)}`);
    res.json({ ok: true, status: result?.status, orderId: result?.orderID, filled: result?.status === 'matched' });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/btc5m/limit99', async (req, res) => {
  if (!btc5mEvent) return res.status(400).json({ error: 'No active 5m event' });
  if (!clobClient) return res.status(500).json({ error: 'CLOB client not ready' });

  const upP = btc5mState.upPrice || 0;
  const downP = btc5mState.downPrice || 0;
  if (upP === 0 && downP === 0) return res.status(400).json({ error: 'No prices' });

  const winSide = upP >= downP ? 'up' : 'down';
  const tokenId = winSide === 'up' ? btc5mState.tokenUp : btc5mState.tokenDown;
  if (!tokenId) return res.status(400).json({ error: 'No token' });

  const tickSize = btc5mEvent.tickSize || '0.01';
  const tick = parseFloat(tickSize);
  const negRisk = btc5mEvent.negRisk || false;
  const price = 0.99;
  const shares = 5;

  res.json({ success: true, side: winSide, price, shares, status: 'sending' });

  (async () => {
    try {
      const t0 = Date.now();
      const signed = await clobClient.createOrder(
        { tokenID: tokenId, price, size: shares, side: 'BUY' },
        { tickSize: String(tick), negRisk },
      );
      const result = await clobClient.postOrder(signed, 'GTC');
      console.log(`[BTC5M 99¢] ${winSide} ${shares}sh @ 99¢ — ${Date.now() - t0}ms — id:`, result?.orderID || result);
      logTrade('btc5m', 'limit99', { side: winSide, price, shares, eventSlug: btc5mState.eventSlug, orderId: result?.orderID });
      broadcast({ type: 'btc5m_order', status: 'placed', side: winSide, price, shares, orderID: result?.orderID });
    } catch (e) {
      console.error('[BTC5M 99¢] error:', e?.message);
      broadcast({ type: 'btc5m_order', status: 'failed', side: winSide, price, error: e?.message });
    }
  })();
});

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
    if (liveState.eventSlug?.startsWith('btc-updown-15m-')) {
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
      .select('observed_at, btc_price, coin_price, up_cost, down_cost, seconds_left, ks_yes_ask, ks_yes_bid, ks_no_ask, ks_no_bid')
      .eq('event_slug', slug)
      .order('observed_at', { ascending: false })
      .limit(limit);
    if (error) return res.json({ snapshots: [], error: error.message });
    res.json({ snapshots: (data || []).reverse(), slug });
  } catch (e) {
    res.json({ snapshots: [], error: e.message });
  }
});

app.get('/api/eth-price-history', async (req, res) => {
  const slug = req.query.slug || liveStateEth.eventSlug;
  const limit = parseInt(req.query.limit || '1000');
  if (!slug) return res.json({ snapshots: [] });
  try {
    const { data, error } = await supabase
      .from('eth_15m_snapshots')
      .select('observed_at, eth_price, up_cost, down_cost, seconds_left')
      .eq('event_slug', slug)
      .order('observed_at', { ascending: false })
      .limit(limit);
    if (error) return res.json({ snapshots: [], error: error.message });
    res.json({ snapshots: (data || []).reverse(), slug });
  } catch (e) {
    res.json({ snapshots: [], error: e.message });
  }
});

/** Latest stored Polymarket up/down for an ETH event (hydrate UI after refresh). */
app.get('/api/eth-latest-snapshot', async (req, res) => {
  const slug = req.query.slug || liveStateEth.eventSlug;
  if (!slug) return res.json({ up: null, down: null, slug: null });
  try {
    const { data, error } = await supabase
      .from('eth_15m_snapshots')
      .select('up_cost, down_cost, observed_at')
      .eq('event_slug', slug)
      .order('observed_at', { ascending: false })
      .limit(1);
    if (error) return res.json({ up: null, down: null, error: error.message, slug });
    const row = data?.[0];
    res.json({
      slug,
      observed_at: row?.observed_at ?? null,
      up: row?.up_cost != null ? parseFloat(row.up_cost) : null,
      down: row?.down_cost != null ? parseFloat(row.down_cost) : null,
    });
  } catch (e) {
    res.json({ up: null, down: null, error: e.message, slug });
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
  // Send ETH event + prices so ETH chart works on page load
  if (ethEvent) ws.send(JSON.stringify({ type: 'eth_event', event: ethEvent }));
  if (liveStateEth.upPrice != null || liveStateEth.downPrice != null) {
    ws.send(JSON.stringify({ type: 'eth_prices', upPrice: liveStateEth.upPrice, downPrice: liveStateEth.downPrice, upStartPrice: liveStateEth.upStartPrice, downStartPrice: liveStateEth.downStartPrice }));
  }
});

// ══════════════════════════════════════════════════════════════════════════
// k9 ON-CHAIN WATCHER (Alchemy WS — mirrors sg-onchain-watcher.py logic)
// ══════════════════════════════════════════════════════════════════════════
const K9_WALLET     = '0xd0d6053c3c37e727402d84c14069780d360993aa';
const K9_PAD        = '0x000000000000000000000000' + K9_WALLET.slice(2);
const WHALE_WALLET  = '0x63ce342161250d705dc0b16df89036c8e5f9ba9a'; // @0x8dxd
const WHALE_PAD     = '0x000000000000000000000000' + WHALE_WALLET.slice(2);
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

// Whale watcher DISABLED to save resources

// Seed k9SeenTx from Supabase so we don't re-insert after restart
async function seedK9SeenTx() {
  try {
    const { data } = await supabase.from('k9_observed_trades')
      .select('tx_hash')
      .order('id', { ascending: false }).limit(5000);
    if (data?.length) {
      for (const t of data) {
        k9SeenTx.add(t.tx_hash);  // partial dedup — new logs use txHash:logIndex
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
function decodeOrderFilledLog(log, wallet = K9_WALLET, seenSet = k9SeenTx) {
  const topics = log.topics || [];
  if (topics.length < 4) return null;

  const walletLower = wallet.toLowerCase();
  const txHash   = log.transactionHash;
  const logMaker = '0x' + topics[2].slice(-40).toLowerCase();
  const logTaker = '0x' + topics[3].slice(-40).toLowerCase();
  if (logMaker !== walletLower && logTaker !== walletLower) return null;

  const data = (log.data || '0x').slice(2);
  if (data.length < 256) return null;
  const chunks = [];
  for (let i = 0; i < data.length; i += 64) chunks.push(data.slice(i, i + 64));

  const makerAsset  = BigInt('0x' + chunks[0]);
  const takerAsset  = BigInt('0x' + chunks[1]);
  const makerAmount = BigInt('0x' + chunks[2]);
  const takerAmount = BigInt('0x' + chunks[3]);

  const isMaker = logMaker === walletLower;
  const isTaker = logTaker === walletLower;
  let usdcSize, shares, tokenId, side;
  if (isMaker && makerAsset === 0n) {
    usdcSize = Number(makerAmount) / 1e6; shares = Number(takerAmount) / 1e6;
    tokenId = takerAsset; side = 'buy';
  } else if (isTaker && takerAsset === 0n) {
    usdcSize = Number(takerAmount) / 1e6; shares = Number(makerAmount) / 1e6;
    tokenId = makerAsset; side = 'buy';
  } else if (isMaker && takerAsset === 0n) {
    usdcSize = Number(takerAmount) / 1e6; shares = Number(makerAmount) / 1e6;
    tokenId = makerAsset; side = 'sell';
  } else if (isTaker && makerAsset === 0n) {
    usdcSize = Number(makerAmount) / 1e6; shares = Number(takerAmount) / 1e6;
    tokenId = takerAsset; side = 'sell';
  } else {
    return null;
  }

  const price = shares > 0 ? Math.round((usdcSize / shares) * 1e8) / 1e8 : 0;
  const info  = k9TokenMap[tokenId.toString()];
  if (!info) return null;

  const logIdx = log.logIndex || '0';
  const blockNum = log.blockNumber ? parseInt(log.blockNumber, 16) : null;
  const dedup = `${txHash}:${logIdx}`;
  if (seenSet.has(dedup)) return null;
  seenSet.add(dedup);
  if (seenSet.size > 10000) seenSet = new Set([...seenSet].slice(-5000));

  return { txHash, logIndex: logIdx, blockNumber: blockNum, slug: info.slug, outcome: info.outcome, side,
           price, shares, usdcSize, coin: info.coin,
           tf: info.tf, timeframe: info.timeframe, ts: Math.floor(Date.now() / 1000) };
}

// ── Decode rebate TransferSingle: ConditionalTokens → k9 from rebate contract ──
function decodeRebateTransfer(log, wallet = K9_WALLET, seenSet = k9SeenTx) {
  const topics = log.topics || [];
  if (topics.length < 4) return null;
  const from = '0x' + topics[2].slice(-40).toLowerCase();
  if (from !== REBATE_CONTRACT.toLowerCase()) return null; // only rebate contract
  const to = '0x' + topics[3].slice(-40).toLowerCase();
  if (to !== wallet.toLowerCase()) return null;

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
  if (seenSet.has(dedup)) return null;
  seenSet.add(dedup);

  const blockNum = log.blockNumber ? parseInt(log.blockNumber, 16) : null;
  return { txHash, logIndex: logIdx, blockNumber: blockNum, slug: info.slug, outcome: info.outcome, side: 'buy',
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

// ══════════════════════════════════════════════════════════════════════════
// WHALE WATCHER (0x8dxd) — 15m events only
// ══════════════════════════════════════════════════════════════════════════

async function fetchBlockTimestamp(blockNumber) {
  if (!blockNumber) return null;
  try {
    const r = await fetch(ALCHEMY_HTTP, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0', id: 1, method: 'eth_getBlockByNumber',
        params: ['0x' + blockNumber.toString(16), false],
      }),
    });
    const d = await r.json();
    const ts = d?.result?.timestamp;
    return ts ? parseInt(ts, 16) : null;
  } catch (e) {
    return null;
  }
}

async function seedWhaleSeenTx() {
  try {
    const { data } = await supabase.from('k9_observed_trades')
      .select('tx_hash')
      .like('slug', '%-15m-%')
      .order('id', { ascending: false }).limit(5000);
    if (data?.length) {
      for (const t of data) {
        whaleSeenTx.add(t.tx_hash);  // partial dedup
      }
      console.log(`[whale-watcher] Seeded dedup set with ${whaleSeenTx.size} entries`);
    }
  } catch (e) {
    console.error('[whale-watcher] seedWhaleSeenTx error:', e.message);
  }
}

async function fetchClobBidAsk(tokenId) {
  try {
    const [buyRes, sellRes] = await Promise.all([
      fetch(`https://clob.polymarket.com/price?token_id=${tokenId}&side=buy`).then(r => r.json()).catch(() => null),
      fetch(`https://clob.polymarket.com/price?token_id=${tokenId}&side=sell`).then(r => r.json()).catch(() => null),
    ]);
    const bestAsk = buyRes?.price ? parseFloat(buyRes.price) : null;   // price to buy = best ask
    const bestBid = sellRes?.price ? parseFloat(sellRes.price) : null; // price to sell = best bid
    return { bestAsk, bestBid };
  } catch (e) {
    return { bestAsk: null, bestBid: null };
  }
}

async function saveWhaleTrades(trades) {
  if (!trades || !trades.length) return;
  // Only save 15m trades
  const filtered = trades.filter(t => t.slug && t.slug.includes('-15m-'));
  if (!filtered.length) return;

  // Use actual block timestamp instead of Date.now() (when we received the log)
  const blockNums = [...new Set(filtered.map(t => t.blockNumber).filter(Boolean))];
  const blockTs = {};
  for (const bn of blockNums) {
    const ts = await fetchBlockTimestamp(bn);
    if (ts) blockTs[bn] = ts;
  }
  for (const t of filtered) {
    if (t.blockNumber && blockTs[t.blockNumber]) t.ts = blockTs[t.blockNumber];
  }
  // Sort by logIndex within same tx so fill order is preserved
  filtered.sort((a, b) => {
    if (a.txHash !== b.txHash) return 0;
    return (parseInt(a.logIndex, 16) || 0) - (parseInt(b.logIndex, 16) || 0);
  });

  // Fetch true market (best ask/bid) — NOT liveState which can be last_trade (= whale's fill price)
  // Whale uses limit orders a few cents below market; last_trade would show his price as "mkt"
  let upAsk = null, upBid = null, downAsk = null, downBid = null;
  const slug = liveState.eventSlug || activeEvent?.slug || '';
  const matchesActive = slug && filtered.some(t => t.slug === slug);
  if (matchesActive && liveState.tokenUp && liveState.tokenDown) {
    const [up, down] = await Promise.all([
      fetchClobBidAsk(liveState.tokenUp),
      fetchClobBidAsk(liveState.tokenDown),
    ]);
    upAsk = up.bestAsk; upBid = up.bestBid;
    downAsk = down.bestAsk; downBid = down.bestBid;
  }
  // Fallback to liveState if fetch failed or different event
  if (upAsk == null) upAsk = liveState.upPrice;
  if (downAsk == null) downAsk = liveState.downPrice;
  if (upBid == null) upBid = liveState.upPrice;
  if (downBid == null) downBid = liveState.downPrice;

  const enriched = filtered.map(t => {
    const isUp = /up/i.test(t.outcome);
    // For BUY: market = best ask (what you'd pay). For SELL: market = best bid (what you'd get).
    const mktUp = t.side === 'buy' ? upAsk : upBid;
    const mktDown = t.side === 'buy' ? downAsk : downBid;
    return {
      ...t,
      marketUp: mktUp,
      marketDown: mktDown,
      blockNumber: t.blockNumber,
      logIndex: t.logIndex,
    };
  });

  // For DB persist: best ask (typical whale buy-below-ask scenario)
  const marketUp = upAsk ?? liveState.upPrice;
  const marketDown = downAsk ?? liveState.downPrice;
  const obsRows = filtered.map(t => ({
    slug: t.slug, outcome: t.outcome, price: t.price,
    shares: t.side === 'sell' ? -t.shares : t.shares,
    usdc_size: t.side === 'sell' ? -t.usdcSize : t.usdcSize,
    tx_hash: t.txHash, trade_timestamp: t.ts,
    market_up: marketUp != null ? marketUp : null,
    market_down: marketDown != null ? marketDown : null,
  }));
  const { error: e1 } = await supabase.from('k9_observed_trades').insert(obsRows);
  if (e1) console.error('[whale-watcher] insert error:', e1.message);

  broadcast({ type: 'whale_trades', trades: enriched });
  console.log(`[whale-watcher] ${filtered.map(t => `${t.side.toUpperCase()} ${t.outcome} ${t.slug} @${t.price} $${t.usdcSize.toFixed(2)}`).join(' | ')}`);
}

let whaleWsRetryDelay = 2000;
function connectWhaleWatcher() {
  console.log('[whale-watcher] Connecting to Alchemy WS...');
  const ws = new WebSocket(ALCHEMY_WS);

  ws.on('open', async () => {
    whaleWsRetryDelay = 2000;
    // Subscribe to OrderFilled (whale as taker)
    ws.send(JSON.stringify({
      jsonrpc: '2.0', id: 10,
      method: 'eth_subscribe',
      params: ['logs', { address: CTF_EXCHANGE, topics: [ORDER_FILLED, null, null, WHALE_PAD] }],
    }));
    await new Promise(r => setTimeout(r, 300));
    // Subscribe to OrderFilled (whale as maker)
    ws.send(JSON.stringify({
      jsonrpc: '2.0', id: 11,
      method: 'eth_subscribe',
      params: ['logs', { address: CTF_EXCHANGE, topics: [ORDER_FILLED, null, WHALE_PAD, null] }],
    }));
    await new Promise(r => setTimeout(r, 300));
    // Subscribe to TransferSingle (rebates to whale)
    ws.send(JSON.stringify({
      jsonrpc: '2.0', id: 12,
      method: 'eth_subscribe',
      params: ['logs', { address: CONDITIONAL_TOKENS, topics: [TRANSFER_SINGLE, null, null, WHALE_PAD] }],
    }));
    console.log('[whale-watcher] Subscribed to OrderFilled + TransferSingle');
  });

  ws.on('message', async (raw) => {
    try {
      const msg = JSON.parse(raw.toString());
      const log = msg?.params?.result;
      if (!log || log.removed) return;

      const fill = decodeOrderFilledLog(log, WHALE_WALLET, whaleSeenTx);
      if (fill) {
        if (!whaleTxBuffer[fill.txHash]) {
          whaleTxBuffer[fill.txHash] = [];
          setTimeout(() => {
            const fills = whaleTxBuffer[fill.txHash];
            delete whaleTxBuffer[fill.txHash];
            if (fills?.length) saveWhaleTrades(fills);
          }, 500);
        }
        whaleTxBuffer[fill.txHash].push(fill);
        return;
      }

      const rebate = decodeRebateTransfer(log, WHALE_WALLET, whaleSeenTx);
      if (rebate) {
        saveWhaleTrades([rebate]);
        console.log(`[whale-watcher] REBATE: +${rebate.shares.toFixed(2)} ${rebate.outcome} ${rebate.slug}`);
      }
    } catch (e) {
      console.error('[whale-watcher] decode error:', e.message);
    }
  });

  ws.on('close', () => {
    console.log(`[whale-watcher] WS closed, retrying in ${whaleWsRetryDelay}ms`);
    setTimeout(connectWhaleWatcher, whaleWsRetryDelay);
    whaleWsRetryDelay = Math.min(whaleWsRetryDelay * 2, 30000);
  });
  ws.on('error', () => ws.close());
}

// Whale HTTP poll fallback
let whalePollLastBlock = 0;
async function whaleHttpPoll() {
  try {
    const blockRes = await fetch(ALCHEMY_HTTP, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_blockNumber', params: [] }),
    });
    const blockData = await blockRes.json();
    const currentBlock = parseInt(blockData.result, 16);
    if (!currentBlock) return;

    const fromBlock = whalePollLastBlock ? whalePollLastBlock + 1 : currentBlock - 120;
    if (fromBlock > currentBlock) return;

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
      queryLogs([ORDER_FILLED, null, null, WHALE_PAD]),
      queryLogs([ORDER_FILLED, null, WHALE_PAD, null]),
      queryLogsAddr(CONDITIONAL_TOKENS, [TRANSFER_SINGLE, null, null, WHALE_PAD]),
    ]);

    const fillsByTx = {};
    let newCount = 0;
    for (const log of [...takerLogs, ...makerLogs]) {
      if (log.removed) continue;
      const fill = decodeOrderFilledLog(log, WHALE_WALLET, whaleSeenTx);
      if (!fill) continue;
      newCount++;
      if (!fillsByTx[fill.txHash]) fillsByTx[fill.txHash] = [];
      fillsByTx[fill.txHash].push(fill);
    }

    let rebateCount = 0;
    for (const log of rebateLogs) {
      if (log.removed) continue;
      const rebate = decodeRebateTransfer(log, WHALE_WALLET, whaleSeenTx);
      if (!rebate) continue;
      rebateCount++;
      if (!fillsByTx[rebate.txHash]) fillsByTx[rebate.txHash] = [];
      fillsByTx[rebate.txHash].push(rebate);
    }

    for (const [, fills] of Object.entries(fillsByTx)) {
      await saveWhaleTrades(fills);
    }
    whalePollLastBlock = currentBlock;

    if (newCount > 0 || rebateCount > 0) {
      console.log(`[whale-poll] Backfilled ${newCount} fills + ${rebateCount} rebates from blocks ${fromBlock}-${currentBlock}`);
    }
  } catch (e) {
    console.error('[whale-poll] error:', e.message);
  }
}

// Whale trades API — fetch from Supabase (persisted trades, source of truth for holdings)
app.get('/api/whale-trades', async (req, res) => {
  const { slug } = req.query;
  try {
    const limit = Math.min(parseInt(req.query.limit || '1000', 10) || 1000, 5000);
    let q = supabase.from('k9_observed_trades').select('*').like('slug', '%-15m-%').order('id', { ascending: false }).limit(limit);
    if (slug) q = q.eq('slug', slug);
    const { data, error } = await q;
    if (error) return res.status(500).json({ error: error.message });
    // Normalize for frontend: ts, side, outcome, shares, usdc, marketUp, marketDown
    const trades = (data || []).map(t => {
      const shares = parseFloat(t.shares) || 0;
      const side = shares >= 0 ? 'buy' : 'sell';
      return {
        ...t,
        ts: (t.trade_timestamp || 0) * 1000,
        side,
        shares: Math.abs(shares),
        usdc: Math.abs(parseFloat(t.usdc_size) || 0),
        marketUp: t.market_up != null ? parseFloat(t.market_up) : undefined,
        marketDown: t.market_down != null ? parseFloat(t.market_down) : undefined,
      };
    });
    res.json({ trades });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// List all slugs the whale has traded on (for browsing history)
app.get('/api/whale-slugs', async (req, res) => {
  try {
    const limit = Math.min(parseInt(req.query.limit || '50000', 10) || 50000, 100000);
    const { data, error } = await supabase.from('k9_observed_trades')
      .select('slug, trade_timestamp')
      .like('slug', '%-15m-%')
      .order('id', { ascending: false })
      .limit(limit);
    if (error) return res.status(500).json({ error: error.message });
    // Group by slug, get latest timestamp per slug
    const bySlug = {};
    for (const r of (data || [])) {
      if (!r.slug) continue;
      if (!bySlug[r.slug] || r.trade_timestamp > bySlug[r.slug]) bySlug[r.slug] = r.trade_timestamp;
    }
    const slugs = Object.entries(bySlug)
      .sort((a, b) => b[1] - a[1])
      .map(([slug, ts]) => ({ slug, ts }));
    res.json({ slugs });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Whale holdings for 15m events — derived from stored trades (k9_observed_trades)
app.get('/api/whale-holdings', async (req, res) => {
  try {
    const nowSecs = Math.floor(Date.now() / 1000);
    const currentSlot = Math.floor(nowSecs / 900) * 900;
    const slug = req.query.slug || `btc-updown-15m-${currentSlot}`;
    const all = req.query.all === '1' || req.query.all === 'true';

    let query = supabase.from('k9_observed_trades').select('slug, outcome, shares').like('slug', '%-15m-%');
    if (!all) query = query.eq('slug', slug);
    const { data, error } = await query;
    if (error) return res.status(500).json({ error: error.message });

    if (all) {
      // Aggregate across all slugs
      const bySlug = {};
      for (const t of (data || [])) {
        const s = t.slug || '';
        if (!bySlug[s]) bySlug[s] = { up: 0, down: 0 };
        const shares = parseFloat(t.shares) || 0;
        if (/up/i.test(t.outcome)) bySlug[s].up += shares;
        else bySlug[s].down += shares;
      }
      const slugs = Object.entries(bySlug).map(([s, h]) => ({ slug: s, up: Math.round(h.up * 100) / 100, down: Math.round(h.down * 100) / 100 }));
      let totalUp = 0, totalDown = 0;
      for (const h of slugs) { totalUp += h.up; totalDown += h.down; }
      return res.json({ all: true, slugs, totalUp: Math.round(totalUp * 100) / 100, totalDown: Math.round(totalDown * 100) / 100 });
    }

    let upShares = 0, downShares = 0;
    for (const t of (data || [])) {
      const shares = parseFloat(t.shares) || 0;
      if (/up/i.test(t.outcome)) upShares += shares;
      else downShares += shares;
    }
    res.json({ slug, up: Math.round(upShares * 100) / 100, down: Math.round(downShares * 100) / 100 });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Whale total positions from Polymarket (source of truth — actual on-chain holdings)
app.get('/api/whale-positions', async (req, res) => {
  try {
    const eventSlug = req.query.event || req.query.slug;
    const r = await fetch(`https://data-api.polymarket.com/positions?user=${WHALE_WALLET}&limit=200`);
    if (!r.ok) return res.json({ positions: [], totalUp: 0, totalDown: 0, totalValue: 0, error: `Polymarket ${r.status}` });
    const data = await r.json();
    const positions = Array.isArray(data) ? data : (data.positions || []);
    const filtered = eventSlug
      ? positions.filter(p => (p.eventSlug || p.slug || '').toLowerCase() === eventSlug.toLowerCase())
      : positions;

    let totalUp = 0, totalDown = 0, totalValue = 0;
    const bySlug = {};
    for (const p of filtered) {
      const slug = p.eventSlug || p.slug;
      const outcome = (p.outcome || '').toLowerCase();
      const size = parseFloat(p.size || 0);
      const value = parseFloat(p.currentValue || 0) || (parseFloat(p.curPrice || 0) * size);
      if (!bySlug[slug]) bySlug[slug] = { up: 0, down: 0, value: 0 };
      const isUp = outcome === 'yes' || outcome === 'up';
      const isDown = outcome === 'no' || outcome === 'down';
      if (isUp) {
        totalUp += size;
        bySlug[slug].up += size;
      } else if (isDown) {
        totalDown += size;
        bySlug[slug].down += size;
      }
      totalValue += value;
      bySlug[slug].value += value;
    }
    res.json({
      positions: filtered,
      totalUp: Math.round(totalUp * 100) / 100,
      totalDown: Math.round(totalDown * 100) / 100,
      totalValue: Math.round(totalValue * 100) / 100,
      bySlug: Object.entries(bySlug).map(([s, v]) => ({ slug: s, ...v })),
    });
  } catch (e) {
    res.json({ positions: [], totalUp: 0, totalDown: 0, totalValue: 0, error: e.message });
  }
});

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
  await refreshEthEvent();
  await refresh5mEvent();
  connectBtcStream();
  connectBinanceStream();
  startPricePoll();
  scheduleNextEvent();
  scheduleEthEvent();
  schedule5mEvent();
  for (const coin of EXTRA_5M_COINS) {
    await refreshExtra5mEvent(coin);
    await new Promise(r => setTimeout(r, 300));
  }
  scheduleExtra5m();
  const splitReady = !!FUNDER_ADDRESS && !!process.env.PRIVATE_KEY;
  const scriptExists = fs.existsSync(SPLIT_SCRIPT);
  console.log(`[SPLIT] autoSplit=${autoSplit.enabled ? 'ON' : 'OFF'}, amount=$${autoSplit.amount}, ready=${splitReady}, script=${scriptExists}`);
  // K9 watcher DISABLED to save resources
  // await seedK9SeenTx();
  // await loadK9CopyState();
  await loadStopLossFromDb();
  // connectK9Watcher();
  // setTimeout(k9HttpPoll, 5000);
  // setInterval(k9HttpPoll, 15000);
  // setTimeout(k9TradeMonitor, 20000);
  // setInterval(k9TradeMonitor, 60000);
  // Whale watcher DISABLED to save resources

  // Auto-flow: check every 3s for smooth price trends
  setInterval(checkFlowTrigger, 3000);
});
