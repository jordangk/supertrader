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

    // Derive API credentials
    const tempClient = new ClobClient(
      'https://clob.polymarket.com',
      CHAIN_ID,
      wallet,
    );
    const creds = await tempClient.createOrDeriveApiKey();
    console.log('[CLOB] API key derived:', creds.key);

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
const CTF_ADDRESS = '0x4D97DCd97eC945f40cF65F87097ACe5EA0476045'; // Conditional Token Framework (ERC-1155)
const CTF_ABI = [
  'function isApprovedForAll(address account, address operator) view returns (bool)',
];
let ctfApprovedForSell = false; // cached result

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

    // Check ERC-1155 conditional token approval (needed for SELL orders)
    const ctf = new Contract(CTF_ADDRESS, CTF_ABI, provider);
    ctfApprovedForSell = await ctf.isApprovedForAll(ownerAddress, CTF_EXCHANGE);
    console.log('[ALLOWANCE] CTF isApprovedForAll for CTF Exchange:', ctfApprovedForSell);
    if (!ctfApprovedForSell) {
      console.warn('[ALLOWANCE] CTF NOT approved — SELL orders will fail. Approve at polymarket.com or call setApprovalForAll.');
    }
  } catch (e) {
    console.error('[ALLOWANCE] Failed:', e.message);
  }
}

// ── State ──────────────────────────────────────────────────────────────────
let activeEvent = null;
let liveState = {
  upPrice: null,
  downPrice: null,
  upStartPrice: null,
  downStartPrice: null,
  btcStart: null,
  btcCurrent: null,
  eventSlug: null,
  eventTitle: null,
  marketId: null,
  dbEventId: null,
  tokenUp: null,
  tokenDown: null,
};

// Pending auto-sells: wait for price to hit target, then sell
// { id: { side, tokenId, shares, targetPrice, buyPrice, createdAt } }
const pendingAutoSells = {};

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

async function fetchBtcPrice() {
  try {
    const res = await fetch('https://api.binance.com/api/v3/ticker/price?symbol=BTCUSDT');
    const data = await res.json();
    return data?.price ? parseFloat(data.price) : null;
  } catch {
    return null;
  }
}
let lastBroadcastPrices = 0;
const BROADCAST_THROTTLE_MS = 800;

// ── Fetch active 5m BTC event (must be accepting orders, not closed) ───────
async function fetchActiveEvent() {
  try {
    const now = Math.floor(Date.now() / 1000);
    const slot = Math.floor(now / 300) * 300;
    // Try current slot, next slot, previous slot (in case current just resolved)
    for (const ts of [slot, slot + 300, slot - 300]) {
      const slug = `btc-updown-5m-${ts}`;
      const res = await fetch(`https://gamma-api.polymarket.com/events?slug=${slug}`);
      const data = await res.json();
      const event = Array.isArray(data) ? data[0] : data;
      if (!event) continue;
      const market = event.markets?.[0];
      if (!market) continue;

      const conditionId = market.conditionId ?? market.condition_id;
      if (!conditionId) continue;

      // Check CLOB: market must be accepting orders and not closed
      const clobRes = await fetch(`https://clob.polymarket.com/markets/${conditionId}`);
      if (!clobRes.ok) continue;
      const clob = await clobRes.json();
      const m = clob.data ?? clob;
      if (!m?.accepting_orders || m?.closed) continue;

      const tokens = m.tokens ?? [];
      const tokenUp = tokens[0]?.token_id;
      const tokenDown = tokens[1]?.token_id;
      if (!tokenUp || !tokenDown) continue;

      console.log('[EVENT] Active market:', slug, 'accepting_orders:', m.accepting_orders, 'closed:', m.closed);
      return {
        slug: event.slug,
        title: event.title,
        startDate: event.startDate,
        endDate: event.endDate,
        tokenUp,
        tokenDown,
        marketId: market.id,
        conditionId: conditionId || null,
        tickSize: String(m.minimum_tick_size ?? market.orderPriceMinTickSize ?? '0.01'),
        negRisk: !!(market.negRisk ?? m.neg_risk),
      };
    }
    return null;
  } catch (e) {
    console.error('fetchActiveEvent error:', e.message);
    return null;
  }
}

// ── Polymarket CLOB WebSocket for live prices ──────────────────────────────
let clobWs = null;
let clobPingInterval = null;

function connectClobStream(tokenIds) {
  if (clobPingInterval) clearInterval(clobPingInterval);
  clobPingInterval = null;
  if (clobWs) clobWs.close();

  clobWs = new WebSocket('wss://ws-subscriptions-clob.polymarket.com/ws/market');

  clobWs.on('open', () => {
    console.log('[CLOB WS] connected');
    clobWs.send(JSON.stringify({
      assets_ids: tokenIds,
      type: 'market',
      custom_feature_enabled: true,
    }));
  });

  clobPingInterval = setInterval(() => {
    if (clobWs?.readyState === WebSocket.OPEN) clobWs.send('PING');
  }, 30000);

  clobWs.on('message', (raw) => {
    try {
      if (raw === 'PONG') return;
      const msgs = JSON.parse(raw);
      const arr = Array.isArray(msgs) ? msgs : [msgs];
      let changed = false;
      for (const msg of arr) {
        let price = null;
        let assetId = msg.asset_id || msg.market;

        // Only use trade-based prices — book mid-market on thin 5m markets resets to ~50¢
        if (msg.event_type === 'price_change' || msg.type === 'price_change') {
          price = parseFloat(msg.price);
        } else if (msg.event_type === 'last_trade_price' || msg.type === 'last_trade_price') {
          price = parseFloat(msg.price);
        }
        // Skip book, best_bid_ask — they flash to 50¢ on thin 5-min markets

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
        const now = Date.now();
        if (now - lastBroadcastPrices >= BROADCAST_THROTTLE_MS) {
          lastBroadcastPrices = now;
          broadcast({ type: 'prices', ...liveState });
        }
      }
    } catch {}
  });

  clobWs.on('close', () => {
    if (clobPingInterval) clearInterval(clobPingInterval);
    clobPingInterval = null;
    console.log('[CLOB WS] disconnected, reconnecting in 3s...');
    setTimeout(() => { if (liveState.tokenUp) connectClobStream([liveState.tokenUp, liveState.tokenDown]); }, 3000);
  });

  clobWs.on('error', (e) => {
    if (clobPingInterval) clearInterval(clobPingInterval);
    clobPingInterval = null;
    console.error('[CLOB WS] error:', e.message);
  });
}

// ── BTC: Polymarket RTDS (primary) + Binance REST when silent (like CLOB pattern)
let btcWs = null;
let btcPingInterval = null;
let lastBtcWsUpdate = 0;

function connectBtcStream() {
  if (btcPingInterval) clearInterval(btcPingInterval);
  btcPingInterval = null;
  if (btcWs) btcWs.close();
  btcWs = new WebSocket('wss://ws-live-data.polymarket.com');
  btcWs.on('open', () => {
    console.log('[BTC] Polymarket RTDS connected');
    btcWs.send(JSON.stringify({
      action: 'subscribe',
      subscriptions: [{ topic: 'crypto_prices', type: 'update', filters: 'btcusdt' }],
    }));
    btcPingInterval = setInterval(() => {
      if (btcWs?.readyState === WebSocket.OPEN) btcWs.send('PING');
    }, 5000);
  });
  btcWs.on('message', (raw) => {
    try {
      if (raw === 'PONG') return;
      const msg = JSON.parse(raw);
      if (msg.topic === 'crypto_prices' && msg.payload?.value != null) {
        lastBtcWsUpdate = Date.now();
        liveState.btcCurrent = parseFloat(msg.payload.value);
        if (liveState.btcStart == null) liveState.btcStart = liveState.btcCurrent;
        broadcast({ type: 'btc', current: liveState.btcCurrent, start: liveState.btcStart });
      }
    } catch {}
  });
  btcWs.on('close', () => {
    if (btcPingInterval) clearInterval(btcPingInterval);
    btcPingInterval = null;
    setTimeout(connectBtcStream, 3000);
  });
  btcWs.on('error', (e) => {
    if (btcPingInterval) clearInterval(btcPingInterval);
    btcPingInterval = null;
  });
}

let btcPollInterval = null;
function startBtcPoll() {
  if (btcPollInterval) clearInterval(btcPollInterval);
  const poll = async () => {
    const price = await fetchBtcPrice();
    if (price == null) return;
    const now = Date.now();
    if (liveState.btcCurrent == null || now - lastBtcWsUpdate > 10000) {
      liveState.btcCurrent = price;
      if (liveState.btcStart == null) liveState.btcStart = price;
      broadcast({ type: 'btc', current: liveState.btcCurrent, start: liveState.btcStart });
    }
  };
  poll();
  btcPollInterval = setInterval(poll, 2000);
}

// ── Refresh event on the 5-min boundary ──────────────────────────────────
let eventTimer = null;

function scheduleNextEvent() {
  if (eventTimer) clearTimeout(eventTimer);
  // Next 5-min boundary + 2s buffer for Polymarket to create it
  const now = Date.now();
  const nowSecs = Math.floor(now / 1000);
  const nextSlot = (Math.floor(nowSecs / 300) + 1) * 300;
  const delay = (nextSlot * 1000) - now + 2000;
  console.log(`[EVENT] Next event in ${Math.round(delay / 1000)}s`);
  eventTimer = setTimeout(async () => {
    await refreshEvent();
    scheduleNextEvent();
  }, delay);
}

async function refreshEvent() {
  const event = await fetchActiveEvent();
  if (event && event.slug !== liveState.eventSlug) {
    console.log('[EVENT] new active event:', event.slug);
    // Keep pending auto-sells across events
    const pendingCount = Object.keys(pendingAutoSells).length;
    if (pendingCount > 0) {
      console.log(`[EVENT] Keeping ${pendingCount} pending auto-sells from previous event`);
    }
    liveState.eventSlug = event.slug;
    liveState.eventTitle = event.title;
    liveState.marketId = event.marketId;
    liveState.tokenUp = event.tokenUp;
    liveState.tokenDown = event.tokenDown;

    // Upsert event into polymarket_events so FK is satisfied for trades
    try {
      const { data: existing } = await supabase
        .from('polymarket_events')
        .select('id')
        .eq('slug', event.slug)
        .single();
      if (existing) {
        liveState.dbEventId = existing.id;
      } else {
        const { data: inserted } = await supabase
          .from('polymarket_events')
          .insert({
            slug: event.slug,
            title: event.title,
            end_date: event.endDate,
            up_token_id: event.tokenUp,
            down_token_id: event.tokenDown,
            condition_id: event.conditionId,
            asset_type: 'btc',
          })
          .select('id')
          .single();
        liveState.dbEventId = inserted?.id || null;
      }
      console.log('[EVENT] dbEventId:', liveState.dbEventId);
    } catch (e) {
      console.error('[EVENT] upsert error:', e.message);
    }
    liveState.upPrice = null;
    liveState.downPrice = null;
    liveState.upStartPrice = null;
    liveState.downStartPrice = null;
    // Capture current BTC as the start price for this event, then reset so next tick re-captures
    liveState.btcStart = liveState.btcCurrent;
    activeEvent = event;
    broadcast({ type: 'event', event: { ...event, dbEventId: liveState.dbEventId } });
    // Fetch initial prices via REST immediately
    await fetchInitialPrices();
    // Then connect WS for live streaming
    if (event.tokenUp && event.tokenDown) {
      connectClobStream([event.tokenUp, event.tokenDown]);
    }
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
      if (changed) {
        const now = Date.now();
        if (now - lastBroadcastPrices >= BROADCAST_THROTTLE_MS) {
          lastBroadcastPrices = now;
          const pendingSells = Object.entries(pendingAutoSells).map(([id, ps]) => ({
            id, side: ps.side, shares: ps.shares,
            targetPrice: ps.targetPrice, buyPrice: ps.buyPrice,
            age: Math.round((Date.now() - ps.createdAt) / 1000),
          }));
          broadcast({ type: 'prices', ...liveState, pendingSells });
        }
      }
      // Check pending auto-sells: sell when price hits target
      for (const id of Object.keys(pendingAutoSells)) {
        const ps = pendingAutoSells[id];
        const curPrice = ps.side === 'up' ? liveState.upPrice : liveState.downPrice;
        if (curPrice == null) continue;
        // Sell when current price >= target (someone willing to buy at our sell price)
        if (curPrice >= ps.targetPrice) {
          delete pendingAutoSells[id];
          console.log(`[AUTO-SELL] Price hit ${curPrice} >= target ${ps.targetPrice} for ${ps.side}, selling ${ps.shares}sh`);
          (async () => {
            const tk = String(activeEvent?.tickSize || '0.01');
            const nr = !!(activeEvent?.negRisk);
            let sp = ps.targetPrice;
            for (let att = 1; att <= 8; att++) {
              try {
                const so = await clobClient.createOrder(
                  { tokenID: ps.tokenId, price: sp, side: 'SELL', size: ps.shares },
                  { tickSize: tk, negRisk: nr },
                );
                const od = await clobClient.postOrder(so);
                if (od.error || od.errorMsg) {
                  const err = od.error || od.errorMsg;
                  if (/crosses/i.test(err)) {
                    const cp = ps.side === 'up' ? liveState.upPrice : liveState.downPrice;
                    if (cp) sp = Math.round(Math.min(cp + 0.01, 0.99) * 100) / 100;
                    continue;
                  }
                  if (/balance|allowance/i.test(err) && att < 8) { await new Promise(r => setTimeout(r, 3000)); continue; }
                  console.error('[AUTO-SELL] Failed:', err); return;
                }
                console.log('[AUTO-SELL] Sold on attempt', att, od.orderID);
                broadcast({ type: 'auto-sell', side: ps.side, price: sp, shares: ps.shares, buyPrice: ps.buyPrice, status: od.status });
                await supabase.from('polymarket_trades').insert({
                  polymarket_event_id: liveState.dbEventId, minute: 0, direction: ps.side,
                  purchase_price: sp, purchase_amount: -(ps.shares * sp),
                  purchase_time: new Date().toISOString(), btc_price_at_purchase: liveState.btcCurrent,
                  order_type: 'supertrader', order_status: od.status === 'matched' ? 'filled' : 'open',
                  shares: -ps.shares, polymarket_order_id: od.orderID || od.orderId,
                  notes: JSON.stringify({ sell: true, autoSell: true, tokenId: ps.tokenId }),
                }).then(({ error }) => { if (error) console.error('[AUTO-SELL DB]', error.message); });
                return;
              } catch (e) {
                if (/balance|allowance/i.test(e.message) && att < 8) { await new Promise(r => setTimeout(r, 3000)); continue; }
                console.error('[AUTO-SELL ERROR]', e.message); return;
              }
            }
          })();
        }
        // Pending sells stay until executed or event changes (cleared in event switch)
      }
    } finally {
      pricePollInFlight = false;
    }
  }, 500);
}

// ── Buy order ──────────────────────────────────────────────────────────────
app.post('/api/buy', async (req, res) => {
  const { side, amount, limitPrice, postAction } = req.body; // side: 'up' | 'down', amount: number, limitPrice?: number, postAction?: string
  console.log('[BUY] Request:', { side, amount, limitPrice, postAction });

  if (!activeEvent) return res.status(400).json({ error: 'No active event' });
  if (!['up', 'down'].includes(side)) return res.status(400).json({ error: 'Invalid side' });

  const price = side === 'up' ? liveState.upPrice : liveState.downPrice;
  const tokenId = side === 'up' ? liveState.tokenUp : liveState.tokenDown;

  if (!price && !limitPrice) return res.status(400).json({ error: 'No price available' });

  // Limit order: use exact price; Market order: add 1¢ buffer
  const roundedPrice = limitPrice
    ? Math.round(limitPrice * 100) / 100
    : Math.round(Math.min((price || 0) + 0.01, 0.99) * 100) / 100;
  const rawSize = amount / roundedPrice;
  const roundedSize = Math.max(5, Math.ceil(rawSize * 100) / 100);
  const actualCost = roundedSize * roundedPrice;

  // Snapshot of both prices & time left at moment of buy
  const endDate = activeEvent.endDate ? new Date(activeEvent.endDate) : null;
  const timeLeftSecs = endDate ? Math.max(0, Math.floor((endDate - Date.now()) / 1000)) : null;

  // Record to Supabase — same polymarket_trades table (use actual order size & cost)
  const tradeData = {
    polymarket_event_id: liveState.dbEventId,
    minute: 0,
    direction: side === 'up' ? 'up' : 'down',
    purchase_price: roundedPrice,
    purchase_amount: actualCost,
    purchase_time: new Date().toISOString(),
    btc_price_at_purchase: liveState.btcCurrent,
    order_type: 'supertrader',
    order_status: 'pending',
    shares: roundedSize,
    notes: JSON.stringify({
      tokenId,
      eventTitle: liveState.eventTitle,
      upPriceAtBuy: liveState.upPrice,
      downPriceAtBuy: liveState.downPrice,
      timeLeftSecs,
    }),
  };

  const { data: trade, error: dbErr } = await supabase
    .from('polymarket_trades')
    .insert(tradeData)
    .select()
    .single();

  if (dbErr) console.error('DB error:', dbErr);

  // Fetch existing holdings before this buy
  const { data: existingOrders } = await supabase
    .from('polymarket_trades')
    .select('direction, shares, purchase_amount')
    .eq('order_type', 'supertrader')
    .eq('polymarket_event_id', liveState.dbEventId)
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

  // Place order via Polymarket CLOB Client (properly signed)
  let orderData = null;
  let orderError = null;
  if (!clobClient) {
    orderError = 'CLOB client not initialized';
  } else {
    try {
      const tickSize = String(activeEvent.tickSize || '0.01');
      const negRisk = !!activeEvent.negRisk;
      console.log('[ORDER] Creating signed order:', { tokenId, price: roundedPrice, size: roundedSize, dollarAmount: amount, side: 'BUY', tickSize, negRisk });

      const signedOrder = await clobClient.createOrder(
        {
          tokenID: tokenId,
          price: roundedPrice,
          side: 'BUY',
          size: roundedSize,
        },
        { tickSize, negRisk },
      );

      console.log('[ORDER] Posting signed order...');
      orderData = await clobClient.postOrder(signedOrder);
      console.log('[ORDER]', orderData);

      // Check if Polymarket accepted
      if (orderData.error || orderData.errorMsg) {
        orderError = orderData.error || orderData.errorMsg;
        console.error('[ORDER REJECTED]', orderError);
      }
    } catch (e) {
      orderError = e.message;
      console.error('[ORDER ERROR]', e.message);
    }
  }

  // Update DB with result
  const orderId = orderData?.orderID || orderData?.orderId || orderData?.id;
  const clobStatus = orderData?.status; // 'matched' = filled, 'live' = open limit
  const dbStatus = clobStatus === 'matched' ? 'filled' : (orderId ? 'open' : 'pending');
  if (trade) {
    if (!orderError && orderId) {
      await supabase.from('polymarket_trades').update({
        polymarket_order_id: orderId,
        order_status: dbStatus,
      }).eq('id', trade.id);
    } else {
      await supabase.from('polymarket_trades').update({
        order_status: orderError ? 'error' : 'pending',
        notes: JSON.stringify({
          ...JSON.parse(tradeData.notes),
          orderError: orderError || null,
        }),
      }).eq('id', trade.id);
    }
  }

  const orderSuccess = !orderError && !!(orderData?.orderID || orderData?.orderId);
  const isMatched = orderData?.status === 'matched';

  // Server-side force sell: watch price and sell when it hits buyPrice + 3¢
  if (orderSuccess && isMatched && postAction === 'forcesell') {
    const sellPrice = Math.round((roundedPrice + 0.03) * 100) / 100;
    if (sellPrice > 0 && sellPrice < 1) {
      const sellId = `sell-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
      pendingAutoSells[sellId] = {
        side, tokenId, shares: roundedSize,
        targetPrice: sellPrice, buyPrice: roundedPrice,
        createdAt: Date.now(),
      };
      console.log(`[AUTO-SELL] Queued: sell ${roundedSize}sh ${side} when price hits ${sellPrice} (bought at ${roundedPrice})`);
    }
  }

  // Server-side trigger: place opposite side limit after matched buy
  // Skip if buy price > 0.80 — opposite side too cheap, unlikely to fill in 5min
  if (orderSuccess && isMatched && postAction === 'trigger') {
    if (roundedPrice > 0.80) {
      console.log(`[AUTO-TRIGGER] Skipped — buy price ${roundedPrice} > 0.80, trigger not profitable`);
    } else {
      const oppSide = side === 'up' ? 'down' : 'up';
      const oppLimit = Math.round((1 - roundedPrice - 0.01) * 100) / 100;
      if (oppLimit > 0 && oppLimit < 1) {
        const triggerAmount = Math.round(amount * 0.17 * 100) / 100;
        console.log(`[AUTO-TRIGGER] Placing ${oppSide} limit at ${oppLimit}, $${triggerAmount} (17% of $${amount})`);
        fetch(`http://localhost:${PORT}/api/buy`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ side: oppSide, amount: triggerAmount, limitPrice: oppLimit }),
        }).catch(() => {});
      }
    }
  }

  res.json({
    success: orderSuccess,
    error: orderError || null,
    dbError: dbErr ? dbErr.message : null,
    trade: trade || tradeData, // return tradeData even if DB failed
    order: orderData,
    price: roundedPrice,
    shares: roundedSize,
    tokenId,
    snapshot: {
      upPrice: liveState.upPrice,
      downPrice: liveState.downPrice,
      btcPrice: liveState.btcCurrent,
      timeLeftSecs,
      holdings,
    },
  });
});

// ── Recent orders (from database) ────────────────────────────────────────────
app.get('/api/orders', async (req, res) => {
  let q = supabase
    .from('polymarket_trades')
    .select('*')
    .eq('order_type', 'supertrader')
    .neq('order_status', 'open')
    .order('id', { ascending: false })
    .limit(50);
  const eventId = req.query.eventId;
  if (eventId) {
    q = q.eq('polymarket_event_id', parseInt(eventId));
  }
  const { data, error } = await q;
  res.json({ orders: data || [], error });
});

// ── Open orders from CLOB + reconcile DB ──────────────────────────────────
app.get('/api/open-orders', async (req, res) => {
  if (!clobClient) return res.json({ orders: [] });
  try {
    const open = await clobClient.getOpenOrders();
    const openList = open || [];

    // Reconcile: find DB records marked 'open' that are no longer in CLOB open list
    const { data: dbOpen } = await supabase
      .from('polymarket_trades')
      .select('id, polymarket_order_id')
      .eq('order_status', 'open')
      .eq('order_type', 'supertrader');
    if (dbOpen && dbOpen.length > 0) {
      const clobIds = new Set(openList.map(o => o.id));
      const filled = dbOpen.filter(o => o.polymarket_order_id && !clobIds.has(o.polymarket_order_id));
      for (const o of filled) {
        await supabase.from('polymarket_trades').update({ order_status: 'filled' }).eq('id', o.id);
        console.log('[RECONCILE] order filled:', o.polymarket_order_id);
      }
    }

    res.json({ orders: openList });
  } catch (e) {
    console.error('[OPEN ORDERS]', e.message);
    res.json({ orders: [], error: e.message });
  }
});

// ── Cancel order ──────────────────────────────────────────────────────────
app.post('/api/cancel', async (req, res) => {
  const { orderId } = req.body;
  if (!orderId) return res.status(400).json({ error: 'Missing orderId' });
  if (!clobClient) return res.status(500).json({ error: 'CLOB client not initialized' });
  try {
    const result = await clobClient.cancelOrder({ orderID: orderId });
    console.log('[CANCEL]', orderId, result);
    // Update DB status
    await supabase.from('polymarket_trades').update({ order_status: 'cancelled' }).eq('polymarket_order_id', orderId);
    res.json({ success: true, result });
  } catch (e) {
    console.error('[CANCEL ERROR]', e.message);
    res.json({ success: false, error: e.message });
  }
});

// ── Buy Both (limit buy UP + DOWN at -1¢ discount, force sell +1¢ on fill) ──
// Both sides: buy EQUAL shares at price - 2¢. Payout = n shares either way.
// n = budget / (p_up + p_down), spend_up = n * p_up, spend_down = n * p_down
app.post('/api/buy-both', async (req, res) => {
  const { amount } = req.body; // total budget (e.g. $10)
  if (!activeEvent) return res.status(400).json({ error: 'No active event' });
  if (!amount || amount <= 0) return res.status(400).json({ error: 'Invalid amount' });
  if (!clobClient) return res.status(500).json({ error: 'CLOB client not initialized' });

  const upPrice = liveState.upPrice;
  const downPrice = liveState.downPrice;
  if (!upPrice || !downPrice) return res.status(400).json({ error: 'Prices not available' });

  const upLimit = Math.round((upPrice - 0.02) * 100) / 100;
  const downLimit = Math.round((downPrice - 0.02) * 100) / 100;
  const sum = upLimit + downLimit;
  const n = Math.max(5, Math.floor((amount / sum) * 100) / 100); // equal shares both sides
  const spendUp = Math.round(n * upLimit * 100) / 100;
  const spendDown = Math.round(n * downLimit * 100) / 100;
  const profit = n - (spendUp + spendDown);
  console.log(`[BUY-BOTH] budget=$${amount} — UP@${upLimit}×${n}=$${spendUp} + DOWN@${downLimit}×${n}=$${spendDown} = $${(spendUp+spendDown).toFixed(2)} → payout $${n.toFixed(2)} (profit $${profit.toFixed(2)})`);

  const tickSize = String(activeEvent?.tickSize || '0.01');
  const negRisk = !!(activeEvent?.negRisk);

  async function placeLimit(side, limitPrice, shares) {
    const tokenId = side === 'up' ? liveState.tokenUp : liveState.tokenDown;
    const rp = Math.round(Math.max(0.01, Math.min(limitPrice, 0.99)) * 100) / 100;
    const roundedSize = Math.max(5, Math.ceil(shares * 100) / 100);

    try {
      const signedOrder = await clobClient.createOrder(
        { tokenID: tokenId, price: rp, side: 'BUY', size: roundedSize },
        { tickSize, negRisk },
      );
      const orderData = await clobClient.postOrder(signedOrder);
      if (orderData.error || orderData.errorMsg) {
        console.error(`[BUY-BOTH] ${side} limit@${rp} failed:`, orderData.error || orderData.errorMsg);
        return { success: false, error: orderData.error || orderData.errorMsg, side };
      }
      const orderId = orderData.orderID || orderData.orderId;
      const isMatched = orderData.status === 'matched';
      console.log(`[BUY-BOTH] ${side} limit@${rp} ${orderData.status}: ${orderId} (${roundedSize}sh)`);

      // Record in DB
      await supabase.from('polymarket_trades').insert({
        polymarket_event_id: liveState.dbEventId, minute: 0, direction: side,
        purchase_price: rp, purchase_amount: roundedSize * rp,
        purchase_time: new Date().toISOString(), btc_price_at_purchase: liveState.btcCurrent,
        order_type: 'supertrader', order_status: isMatched ? 'filled' : 'open',
        shares: roundedSize, polymarket_order_id: orderId,
        notes: JSON.stringify({ tokenId, buyBoth: true }),
      }).then(({ error }) => { if (error) console.error('[BUY-BOTH DB]', error.message); });

      return { success: true, side, price: rp, shares: roundedSize, status: orderData.status, orderId };
    } catch (e) {
      console.error(`[BUY-BOTH] ${side} error:`, e.message);
      return { success: false, error: e.message, side };
    }
  }

  // 2 limit orders: equal shares, prices at -2¢
  const results = await Promise.all([
    placeLimit('up', upLimit, n),
    placeLimit('down', downLimit, n),
  ]);

  const filled = results.filter(r => r.success && r.status === 'matched').length;
  const live = results.filter(r => r.success && r.status === 'live').length;
  console.log(`[BUY-BOTH] Done: ${filled} filled, ${live} live limits`);
  res.json({ success: results.some(r => r.success), results, filled, live });
});

// ── Pending auto-sells (queued sell orders waiting for price trigger) ───────
app.get('/api/pending-sells', (req, res) => {
  const pending = Object.entries(pendingAutoSells).map(([id, ps]) => ({
    id, side: ps.side, shares: ps.shares,
    targetPrice: ps.targetPrice, buyPrice: ps.buyPrice,
    age: Math.round((Date.now() - ps.createdAt) / 1000),
  }));
  res.json({ pending });
});

// ── Sell Both: buy equal shares at market, queue sell at +3¢ ───────────────
app.post('/api/sell-both', async (req, res) => {
  const { amount } = req.body; // total budget
  if (!activeEvent) return res.status(400).json({ error: 'No active event' });
  if (!amount || amount <= 0) return res.status(400).json({ error: 'Invalid amount' });
  if (!clobClient) return res.status(500).json({ error: 'CLOB client not initialized' });

  const upPrice = liveState.upPrice;
  const downPrice = liveState.downPrice;
  if (!upPrice || !downPrice) return res.status(400).json({ error: 'Prices not available' });

  // Same balanced formula: equal shares both sides
  const upBuy = Math.round(upPrice * 100) / 100;
  const downBuy = Math.round(downPrice * 100) / 100;
  const sum = upBuy + downBuy;
  const n = Math.max(5, Math.floor((amount / sum) * 100) / 100);
  const spendUp = Math.round(n * upBuy * 100) / 100;
  const spendDown = Math.round(n * downBuy * 100) / 100;
  console.log(`[SELL-BOTH] budget=$${amount} — UP@${upBuy}×${n}=$${spendUp} + DOWN@${downBuy}×${n}=$${spendDown}, then sell at +3¢`);

  const tickSize = String(activeEvent?.tickSize || '0.01');
  const negRisk = !!(activeEvent?.negRisk);

  async function buyThenSell(side) {
    const tokenId = side === 'up' ? liveState.tokenUp : liveState.tokenDown;
    const rp = side === 'up' ? upBuy : downBuy;
    const roundedSize = Math.max(5, Math.ceil(n * 100) / 100);

    try {
      // Step 1: Market buy
      const buyOrder = await clobClient.createOrder(
        { tokenID: tokenId, price: rp, side: 'BUY', size: roundedSize },
        { tickSize, negRisk },
      );
      const buyData = await clobClient.postOrder(buyOrder);
      if (buyData.error || buyData.errorMsg) {
        console.error(`[SELL-BOTH] ${side} BUY@${rp} failed:`, buyData.error || buyData.errorMsg);
        return { success: false, error: buyData.error || buyData.errorMsg, side };
      }
      const buyId = buyData.orderID || buyData.orderId;
      const isMatched = buyData.status === 'matched';
      console.log(`[SELL-BOTH] ${side} BUY@${rp} ${buyData.status}: ${buyId} (${roundedSize}sh)`);

      // Record buy in DB
      await supabase.from('polymarket_trades').insert({
        polymarket_event_id: liveState.dbEventId, minute: 0, direction: side,
        purchase_price: rp, purchase_amount: roundedSize * rp,
        purchase_time: new Date().toISOString(), btc_price_at_purchase: liveState.btcCurrent,
        order_type: 'supertrader', order_status: isMatched ? 'filled' : 'open',
        shares: roundedSize, polymarket_order_id: buyId,
        notes: JSON.stringify({ tokenId, sellBoth: true }),
      }).then(({ error }) => { if (error) console.error('[SELL-BOTH DB]', error.message); });

      // Step 2: Queue sell at +3¢ (for both matched and live orders)
      const sellPrice = Math.round((rp + 0.03) * 100) / 100;
      if (sellPrice >= 1) {
        return { success: true, side, action: 'buy-only', price: rp, shares: roundedSize, status: buyData.status, note: 'sell price >= $1' };
      }

      const sellId = `sellboth-${Date.now()}-${side}`;
      pendingAutoSells[sellId] = {
        side, tokenId, shares: roundedSize,
        targetPrice: sellPrice, buyPrice: rp,
        createdAt: Date.now(),
      };
      console.log(`[SELL-BOTH] ${side} queued sell ${roundedSize}sh@${sellPrice} (buy ${buyData.status})`);

      return { success: true, side, action: 'buy+sell-queued', buyPrice: rp, sellPrice, shares: roundedSize, status: buyData.status };
    } catch (e) {
      console.error(`[SELL-BOTH] ${side} error:`, e.message);
      return { success: false, error: e.message, side };
    }
  }

  const results = await Promise.all([
    buyThenSell('up'),
    buyThenSell('down'),
  ]);

  const filled = results.filter(r => r.success && r.status === 'matched').length;
  const live = results.filter(r => r.success && r.status === 'live').length;
  console.log(`[SELL-BOTH] Done:`, results.map(r => `${r.side}: ${r.action || r.status}`).join(', '));
  res.json({ success: results.some(r => r.success), results, filled, live });
});

// ── Merge (on-chain CTF mergePositions via Gnosis Safe) ───────────────────
const SAFE_ABI = [
  'function execTransaction(address to, uint256 value, bytes data, uint8 operation, uint256 safeTxGas, uint256 baseGas, uint256 gasPrice, address gasToken, address refundReceiver, bytes signatures) payable returns (bool)',
  'function nonce() view returns (uint256)',
  'function getTransactionHash(address to, uint256 value, bytes data, uint8 operation, uint256 safeTxGas, uint256 baseGas, uint256 gasPrice, address gasToken, address refundReceiver, uint256 _nonce) view returns (bytes32)',
];
const CTF_MERGE_ABI = [
  'function mergePositions(address collateralToken, bytes32 parentCollectionId, bytes32 conditionId, uint256[] partition, uint256 amount)',
];
import { arrayify } from '@ethersproject/bytes';
import { HashZero, AddressZero } from '@ethersproject/constants';
import { parseUnits } from '@ethersproject/units';

app.post('/api/merge', async (req, res) => {
  const { shares } = req.body;
  if (!activeEvent) return res.status(400).json({ error: 'No active event' });
  if (!shares || shares <= 0) return res.status(400).json({ error: 'Invalid shares' });

  const conditionId = activeEvent.conditionId;
  if (!conditionId) return res.status(400).json({ error: 'No conditionId for this event' });

  const proxyWallet = FUNDER_ADDRESS || process.env.PROXY_WALLET;
  if (!proxyWallet) return res.status(500).json({ error: 'No proxy wallet configured' });

  // Amount in USDC decimals (6) — 1 share = 1e6
  const amount = parseUnits(shares.toFixed(6), 6);
  console.log(`[MERGE] Merging ${shares} shares (${amount.toString()} raw) for condition ${conditionId.slice(0, 20)}...`);

  try {
    const provider = new JsonRpcProvider(POLYGON_RPC);
    const wallet = new Wallet(process.env.PRIVATE_KEY, provider);

    // Encode CTF mergePositions call
    const ctf = new Contract(CTF_ADDRESS, CTF_MERGE_ABI, provider);
    const mergeData = ctf.interface.encodeFunctionData('mergePositions', [
      USDC_ADDRESS,   // collateralToken
      HashZero,       // parentCollectionId (always 0x00...00 on Polymarket)
      conditionId,    // conditionId
      [1, 2],         // partition (binary market)
      amount,         // amount of each outcome token to merge
    ]);

    // Execute through Gnosis Safe proxy
    const safe = new Contract(proxyWallet, SAFE_ABI, provider);
    const nonce = await safe.nonce();
    console.log(`[MERGE] Safe nonce: ${nonce.toString()}`);

    // Get the Safe transaction hash
    const txHash = await safe.getTransactionHash(
      CTF_ADDRESS,    // to
      0,              // value
      mergeData,      // data
      0,              // operation (CALL)
      0,              // safeTxGas
      0,              // baseGas
      0,              // gasPrice
      AddressZero,    // gasToken
      AddressZero,    // refundReceiver
      nonce,          // nonce
    );

    // Sign with owner key (eth_sign style, v += 4 for Safe)
    const sig = await wallet.signMessage(arrayify(txHash));
    const split = { r: sig.slice(0, 66), s: '0x' + sig.slice(66, 130), v: parseInt(sig.slice(130, 132), 16) };
    split.v += 4; // Safe expects v+4 for eth_sign
    const packedSig = split.r + split.s.slice(2) + split.v.toString(16).padStart(2, '0');

    // Send execTransaction from EOA
    const safeWithSigner = new Contract(proxyWallet, SAFE_ABI, wallet);
    const tx = await safeWithSigner.execTransaction(
      CTF_ADDRESS, 0, mergeData, 0, 0, 0, 0, AddressZero, AddressZero, packedSig,
      { gasLimit: 300000 },
    );
    console.log(`[MERGE] TX sent: ${tx.hash}`);
    const receipt = await tx.wait();
    console.log(`[MERGE] TX confirmed in block ${receipt.blockNumber}, gas used: ${receipt.gasUsed.toString()}`);

    res.json({ success: true, txHash: tx.hash, shares, block: receipt.blockNumber });
  } catch (e) {
    console.error(`[MERGE] Error:`, e.message);
    res.json({ success: false, error: e.message });
  }
});

// ── Sell order (limit sell existing shares) ────────────────────────────────
app.post('/api/sell', async (req, res) => {
  const { side, shares, price, tokenId: reqTokenId } = req.body;
  if (!['up', 'down'].includes(side)) return res.status(400).json({ error: 'Invalid side' });
  if (!shares || shares <= 0) return res.status(400).json({ error: 'Invalid shares' });
  if (!price || price <= 0 || price >= 1) return res.status(400).json({ error: 'Invalid price' });
  if (!clobClient) return res.status(500).json({ error: 'CLOB client not initialized' });

  // Use provided tokenId (from buy response) or fall back to current event
  const tokenId = reqTokenId || (side === 'up' ? liveState.tokenUp : liveState.tokenDown);
  const roundedPrice = Math.round(price * 100) / 100;
  const roundedSize = Math.max(5, Math.ceil(shares * 100) / 100);
  const tickSize = String(activeEvent?.tickSize || '0.01');
  const negRisk = !!(activeEvent?.negRisk);

  // If CTF not approved for selling, fail fast — retrying won't help
  if (!ctfApprovedForSell) {
    // Re-check in case it was approved since startup
    try {
      const provider = new JsonRpcProvider(POLYGON_RPC);
      const ctf = new Contract(CTF_ADDRESS, CTF_ABI, provider);
      const ownerAddress = FUNDER_ADDRESS || process.env.PROXY_WALLET;
      ctfApprovedForSell = await ctf.isApprovedForAll(ownerAddress, CTF_EXCHANGE);
    } catch {}
    if (!ctfApprovedForSell) {
      console.error('[SELL] CTF not approved for selling — setApprovalForAll needed');
      return res.json({ success: false, error: 'CTF not approved for selling. Approve at polymarket.com first.' });
    }
  }

  // Retry up to 8 times (wait for on-chain settlement after buy)
  const MAX_RETRIES = 8;
  const RETRY_DELAY = 5000; // 5 seconds between retries
  let sellPrice = roundedPrice;
  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      console.log(`[SELL] Attempt ${attempt}/${MAX_RETRIES}:`, { tokenId: tokenId.slice(0, 20) + '...', price: sellPrice, size: roundedSize });

      const signedOrder = await clobClient.createOrder(
        { tokenID: tokenId, price: sellPrice, side: 'SELL', size: roundedSize },
        { tickSize, negRisk },
      );
      const orderData = await clobClient.postOrder(signedOrder);

      if (orderData.error || orderData.errorMsg) {
        const err = orderData.error || orderData.errorMsg;
        // "crosses the book" = price moved up, sell is below best bid → use current market price
        if (/crosses/i.test(err)) {
          const curPrice = side === 'up' ? liveState.upPrice : liveState.downPrice;
          if (curPrice) {
            sellPrice = Math.round(Math.min(curPrice + 0.01, 0.99) * 100) / 100;
            console.log(`[SELL] Crosses book, adjusting price to ${sellPrice}`);
            continue;
          }
        }
        // If balance/allowance issue and we have retries left, wait and retry
        if (/balance|allowance/i.test(err) && attempt < MAX_RETRIES) {
          console.log(`[SELL] Balance not settled yet, retrying in ${RETRY_DELAY / 1000}s...`);
          await new Promise(r => setTimeout(r, RETRY_DELAY));
          continue;
        }
        console.error('[SELL] Failed:', err);
        return res.json({ success: false, error: err });
      }

      console.log('[SELL] Success on attempt', attempt, orderData.orderID);

      // Record sell in DB (negative shares/amount so positions subtract correctly)
      const sellStatus = orderData.status === 'matched' ? 'filled' : 'open';
      await supabase.from('polymarket_trades').insert({
        polymarket_event_id: liveState.dbEventId,
        minute: 0,
        direction: side,
        purchase_price: sellPrice,
        purchase_amount: -(roundedSize * sellPrice),
        purchase_time: new Date().toISOString(),
        btc_price_at_purchase: liveState.btcCurrent,
        order_type: 'supertrader',
        order_status: sellStatus,
        shares: -roundedSize,
        polymarket_order_id: orderData.orderID || orderData.orderId,
        notes: JSON.stringify({ sell: true, tokenId }),
      }).then(({ error }) => { if (error) console.error('[SELL DB]', error.message); });

      return res.json({ success: true, order: orderData });
    } catch (e) {
      if (/balance|allowance/i.test(e.message) && attempt < MAX_RETRIES) {
        console.log(`[SELL] Balance not settled yet, retrying in ${RETRY_DELAY / 1000}s...`);
        await new Promise(r => setTimeout(r, RETRY_DELAY));
        continue;
      }
      console.error('[SELL ERROR]', e.message);
      return res.json({ success: false, error: e.message });
    }
  }
  res.json({ success: false, error: 'Settlement timeout — shares not available after retries' });
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
app.get('/api/event', (req, res) => res.json({ event: activeEvent, liveState }));

app.post('/api/event/refresh', async (req, res) => {
  try {
    await refreshEvent();
    res.json({ event: activeEvent, ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message, event: activeEvent });
  }
});

// ── WS frontend connection ─────────────────────────────────────────────────
wss.on('connection', (ws) => {
  ws.send(JSON.stringify({ type: 'event', event: activeEvent ? { ...activeEvent, dbEventId: liveState.dbEventId } : null }));
  ws.send(JSON.stringify({ type: 'prices', ...liveState }));
  ws.send(JSON.stringify({ type: 'btc', current: liveState.btcCurrent, start: liveState.btcStart }));
});

// Heartbeat: broadcast every 5s (throttled to reduce flashing)
setInterval(() => {
  if (wss.clients.size > 0) {
    broadcast({ type: 'prices', ...liveState });
    broadcast({ type: 'btc', current: liveState.btcCurrent, start: liveState.btcStart });
  }
  if (Object.keys(newMap).length) {
    k9TokenMap    = newMap;
    k9TokenExpiry = now + 60;
    console.log(`[k9-watcher] Token map: ${Object.keys(newMap).length} tokens loaded`);
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

      if (makerAsset !== 0n) continue; // not a USDC buy
      const usdcSize = Number(makerAmount) / 1e6;
      const shares   = Number(takerAmount) / 1e6;
      const price    = shares > 0 ? Math.round((usdcSize / shares) * 1e8) / 1e8 : 0;
      const info     = k9TokenMap[takerAsset.toString()];
      if (!info) continue;
      trades.push({ txHash, slug: info.slug, outcome: info.outcome, price, shares, usdcSize,
                    coin: info.coin, tf: info.tf, timeframe: info.timeframe, ts: Math.floor(Date.now() / 1000) });
    } catch {}
  }
  return trades.length ? trades : null;
}

const COPY_PCT  = 0.01;
const MIN_USDC  = 1.00;  // Polymarket $1 minimum (matches bot logic exactly)

// Accumulator per slug+side — mirrors bot's owed_usdc carry-over
// key: `${slug}:${outcome}` -> usdc owed
const owed = {};

async function saveK9Trades(trades) {
  if (!trades || !trades.length) return;

  // Save observed trades
  const obsRows = trades.map(t => ({
    slug: t.slug, outcome: t.outcome, price: t.price, shares: t.shares,
    usdc_size: t.usdcSize, tx_hash: t.txHash, trade_timestamp: t.ts,
  }));
  const { error: e1 } = await supabase.from('k9_observed_trades').insert(obsRows);
  if (e1) console.error('[k9-watcher] observed insert error:', e1.message);

  // Simulate bot carry-over: accumulate 1% of k9's usdc, fire at $1 min
  const simRows = [];
  for (const t of trades) {
    const key = `${t.slug}:${t.outcome}`;
    if (!owed[key]) owed[key] = 0;
    owed[key] += t.usdcSize * COPY_PCT;

    if (owed[key] >= MIN_USDC) {
      const simUsdc   = owed[key];
      // shares = floor(owed / price) — same as bot's int floor
      const simShares = t.price > 0 ? Math.floor(simUsdc / t.price) : 0;
      if (simShares < 1) {
        // Can't fill even 1 share — keep accumulating (price too high edge case)
        console.log(`[sim] carry ${t.outcome} ${t.slug} $${simUsdc.toFixed(3)} @ ${t.price} < 1sh, keep accumulating`);
        continue;
      }
      simRows.push({
        slug: t.slug, outcome: t.outcome,
        k9_price: t.price, k9_usdc: t.usdcSize, k9_shares: t.shares,
        sim_usdc: simUsdc, sim_shares: simShares, sim_price: t.price,
        copy_pct: COPY_PCT, tx_hash: t.txHash, trade_timestamp: t.ts,
      });
      console.log(`[sim] FILL ${t.outcome} ${t.slug} @ ${t.price} → $${simUsdc.toFixed(3)} / ${simShares}sh`);
      owed[key] = 0;
    } else {
      console.log(`[sim] carry ${t.outcome} ${t.slug} → $${owed[key].toFixed(3)} / $${MIN_USDC} needed`);
    }
  }

  if (simRows.length) {
    const { error: e2 } = await supabase.from('k9_sim_trades').insert(simRows);
    if (e2) console.error('[k9-watcher] sim insert error:', e2.message);
  }

  broadcast({ type: 'k9_trades', trades, simFills: simRows });
  console.log(`[k9-watcher] ${trades.map(t => `${t.outcome} ${t.slug} @${t.price} k9=$${t.usdcSize.toFixed(2)}`).join(' | ')}`);
}

let k9WsRetryDelay = 2000;
function connectK9Watcher() {
  console.log('[k9-watcher] Connecting to Alchemy WS...');
  const ws = new WebSocket(ALCHEMY_WS);

  ws.on('open', async () => {
    k9WsRetryDelay = 2000;
    await refreshK9TokenMap();
    // Subscribe directly to CTF OrderFilled where k9 is TAKER (topic[3])
    ws.send(JSON.stringify({
      jsonrpc: '2.0', id: 1,
      method: 'eth_subscribe',
      params: ['logs', { address: CTF_EXCHANGE, topics: [ORDER_FILLED, null, null, K9_PAD] }],
    }));
    await new Promise(r => setTimeout(r, 300));
    // Also subscribe where k9 is MAKER (topic[2])
    ws.send(JSON.stringify({
      jsonrpc: '2.0', id: 2,
      method: 'eth_subscribe',
      params: ['logs', { address: CTF_EXCHANGE, topics: [ORDER_FILLED, null, K9_PAD, null] }],
    }));
    console.log('[k9-watcher] Subscribed to CTF OrderFilled (k9 as maker + taker)');
    // Refresh token map every 55s
    setInterval(() => {
      if (Date.now() / 1000 > k9TokenExpiry) refreshK9TokenMap();
    }, 5000);
  });

  ws.on('message', async (raw) => {
    try {
      const msg = JSON.parse(raw.toString());
      const log = msg?.params?.result;
      if (!log || log.removed) return;

      const topics = log.topics || [];
      if (topics.length < 4) return;

      const txHash   = log.transactionHash;
      const logMaker = '0x' + topics[2].slice(-40).toLowerCase();
      const logTaker = '0x' + topics[3].slice(-40).toLowerCase();
      if (logMaker !== K9_WALLET.toLowerCase() && logTaker !== K9_WALLET.toLowerCase()) return;

      // Decode inline — no receipt fetch needed
      const data   = (log.data || '0x').slice(2);
      if (data.length < 256) return;
      const chunks = [];
      for (let i = 0; i < data.length; i += 64) chunks.push(data.slice(i, i + 64));

      const makerAsset  = BigInt('0x' + chunks[0]);
      const takerAsset  = BigInt('0x' + chunks[1]);
      const makerAmount = BigInt('0x' + chunks[2]);
      const takerAmount = BigInt('0x' + chunks[3]);
      if (makerAsset !== 0n) return; // not a USDC buy

      const usdcSize = Number(makerAmount) / 1e6;
      const shares   = Number(takerAmount) / 1e6;
      const price    = shares > 0 ? Math.round((usdcSize / shares) * 1e8) / 1e8 : 0;
      const info     = k9TokenMap[takerAsset.toString()];
      if (!info) return;

      // Dedup
      const dedup = `${txHash}:${info.outcome}:${shares}`;
      if (k9SeenTx.has(dedup)) return;
      k9SeenTx.add(dedup);
      if (k9SeenTx.size > 10000) k9SeenTx = new Set([...k9SeenTx].slice(-5000));

      await saveK9Trades([{ txHash, slug: info.slug, outcome: info.outcome,
                            price, shares, usdcSize, coin: info.coin,
                            tf: info.tf, timeframe: info.timeframe, ts: Math.floor(Date.now() / 1000) }]);
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

  // No resolver loop needed — decoding inline from WS events
}

// ── Start ──────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3001;
server.listen(PORT, async () => {
  console.log(`SuperTrader server running on http://localhost:${PORT}`);
  await initClobClient();
  await ensureAllowance();
  await refreshEvent();
  connectBtcStream();
  startBtcPoll();
  startPricePoll();
  scheduleNextEvent();
  connectK9Watcher();
});
