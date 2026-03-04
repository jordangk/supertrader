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
};

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

    console.log('[EVENT] Market flags:', {
      negRisk: market.negRisk,
      enableNegRisk: event.enableNegRisk,
      negRiskAugmented: event.negRiskAugmented,
      tickSize: market.orderPriceMinTickSize,
      feeType: market.feeType,
    });

    const conditionId = market.conditionId ?? market.condition_id;
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

// ── Buy order ──────────────────────────────────────────────────────────────
app.post('/api/buy', async (req, res) => {
  const { side, amount } = req.body; // side: 'up' | 'down', amount: number

  if (!activeEvent) return res.status(400).json({ error: 'No active event' });
  if (!['up', 'down'].includes(side)) return res.status(400).json({ error: 'Invalid side' });

  const price = side === 'up' ? liveState.upPrice : liveState.downPrice;
  const tokenId = side === 'up' ? liveState.tokenUp : liveState.tokenDown;

  if (!price) return res.status(400).json({ error: 'No price available' });

  const buyPrice = Math.min(price + 0.01, 0.99);
  const roundedPrice = Math.round(buyPrice * 100) / 100;
  const rawSize = amount / roundedPrice;
  const roundedSize = Math.ceil(rawSize * 100) / 100;
  const actualCost = roundedSize * roundedPrice;

  // Snapshot of both prices & time left at moment of buy
  const endDate = activeEvent.endDate ? new Date(activeEvent.endDate) : null;
  const timeLeftSecs = endDate ? Math.max(0, Math.floor((endDate - Date.now()) / 1000)) : null;

  // Record to Supabase — same polymarket_trades table (use actual order size & cost)
  const tradeData = {
    polymarket_event_id: liveState.eventSlug,
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
    .eq('polymarket_event_id', liveState.eventSlug)
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
  if (trade) {
    if (!orderError && orderId) {
      await supabase.from('polymarket_trades').update({
        polymarket_order_id: orderId,
        order_status: 'filled',
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
  res.json({
    success: orderSuccess,
    error: orderError || null,
    dbError: dbErr ? dbErr.message : null,
    trade: trade || tradeData, // return tradeData even if DB failed
    order: orderData,
    price: roundedPrice,
    shares: roundedSize,
    snapshot: {
      upPrice: liveState.upPrice,
      downPrice: liveState.downPrice,
      btcPrice: liveState.btcCurrent,
      timeLeftSecs,
      holdings,
    },
  });
});

// ── Recent orders ──────────────────────────────────────────────────────────
app.get('/api/orders', async (req, res) => {
  const { data, error } = await supabase
    .from('polymarket_trades')
    .select('*')
    .eq('order_type', 'supertrader')
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

// ── Sim dashboard ──────────────────────────────────────────────────────────
app.get('/api/sim-dashboard', async (req, res) => {
  const limit = parseInt(req.query.limit || '10');
  try {
    // Get recent slugs from sim trades
    const { data: slugRows } = await supabase
      .from('k9_sim_trades').select('slug')
      .order('trade_timestamp', { ascending: false }).limit(5000);

    const slugSet = [...new Set((slugRows || []).map(r => r.slug))].slice(0, limit);
    if (!slugSet.length) return res.json({ events: [], totals: {} });

    const { data: sim } = await supabase.from('k9_sim_trades')
      .select('*').in('slug', slugSet).order('trade_timestamp', { ascending: true });

    const { data: obs } = await supabase.from('k9_observed_trades')
      .select('*').in('slug', slugSet).order('trade_timestamp', { ascending: true });

    const events = slugSet.map(slug => {
      const simTrades = (sim || []).filter(t => t.slug === slug);
      const k9Trades  = (obs || []).filter(t => t.slug === slug);

      const sides = ['Up', 'Down'];
      const summary = {};
      for (const side of sides) {
        const st = simTrades.filter(t => t.outcome === side);
        const kt = k9Trades.filter(t => t.outcome === side);
        const simUsdc   = st.reduce((s,t) => s + parseFloat(t.sim_usdc), 0);
        const simShares = st.reduce((s,t) => s + parseFloat(t.sim_shares), 0);
        const k9Usdc    = kt.reduce((s,t) => s + parseFloat(t.usdc_size), 0);
        const k9Shares  = kt.reduce((s,t) => s + parseFloat(t.shares), 0);
        summary[side] = {
          simUsdc, simShares,
          simAvgPrice: simShares > 0 ? simUsdc / simShares : 0,
          k9Usdc, k9Shares,
          k9AvgPrice: k9Shares > 0 ? k9Usdc / k9Shares : 0,
          k9LastPrice: kt.length ? parseFloat(kt[kt.length-1].price) : 0,
          tradeCount: st.length,
        };
      }

      const totalSimUsdc = (summary.Up?.simUsdc||0) + (summary.Down?.simUsdc||0);
      const totalK9Usdc  = (summary.Up?.k9Usdc||0)  + (summary.Down?.k9Usdc||0);

      // Trade feed (last 50)
      const feed = simTrades.slice(-50).map(t => ({
        outcome: t.outcome,
        k9Price: parseFloat(t.k9_price),
        k9Usdc: parseFloat(t.k9_usdc),
        simUsdc: parseFloat(t.sim_usdc),
        simShares: parseFloat(t.sim_shares),
        simPrice: parseFloat(t.sim_price),
        ts: t.trade_timestamp,
      }));

      return { slug, summary, feed, totalSimUsdc, totalK9Usdc };
    });

    // Overall totals
    const allSim = sim || [];
    const totals = {
      totalSimUsdc: allSim.reduce((s,t) => s + parseFloat(t.sim_usdc), 0),
      totalK9Usdc:  (obs||[]).reduce((s,t) => s + parseFloat(t.usdc_size), 0),
      tradeCount:   allSim.length,
      eventCount:   slugSet.length,
    };

    res.json({ events, totals });
  } catch(e) {
    console.error('/api/sim-dashboard error:', e.message);
    res.json({ events: [], totals: {}, error: e.message });
  }
});

// ── k9 live trades ─────────────────────────────────────────────────────────
app.get('/api/k9-trades', async (req, res) => {
  const limit = parseInt(req.query.limit || '5');
  try {
    const { data: slugRows } = await supabase
      .from('k9_observed_trades')
      .select('slug')
      .order('trade_timestamp', { ascending: false })
      .limit(2000);

    const slugSet = [...new Set((slugRows || []).map(r => r.slug))].slice(0, limit);
    if (!slugSet.length) return res.json({ events: [] });

    const { data: trades } = await supabase
      .from('k9_observed_trades')
      .select('*')
      .in('slug', slugSet)
      .order('trade_timestamp', { ascending: true });

    const { data: ourTrades } = await supabase
      .from('polymarket_copy_trades')
      .select('*')
      .eq('coin', 'k9-15m')
      .order('purchase_time', { ascending: true });

    const events = slugSet.map(slug => {
      const k9 = (trades || []).filter(t => t.slug === slug);
      const ours = (ourTrades || []).filter(t => (t.notes || '').includes(slug));
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
const ALCHEMY_WS    = `wss://polygon-mainnet.g.alchemy.com/v2/${process.env.ALCHEMY_KEY || '8kruQGYamUT6J4Ib0aMfw'}`;
const ALCHEMY_HTTP  = `https://polygon-mainnet.g.alchemy.com/v2/${process.env.ALCHEMY_KEY || '8kruQGYamUT6J4Ib0aMfw'}`;

const COIN_PREFIXES = [
  { prefix: 'btc-updown-15m', coin: 'btc', tf: '15m', interval: 900 },
  { prefix: 'btc-updown-5m',  coin: 'btc', tf: '5m',  interval: 300 },
];

let k9TokenMap     = {};   // BigInt(tokenId) -> { slug, outcome, coin, tf, timeframe }
let k9TokenExpiry  = 0;
let k9Pending      = {};   // txHash -> { detectedAt }
let k9SeenTx       = new Set();

async function refreshK9TokenMap() {
  const now = Math.floor(Date.now() / 1000);
  const newMap = {};
  for (const { prefix, coin, tf, interval } of COIN_PREFIXES) {
    const lookahead = tf === '15m' ? 3 : 5;
    const base = Math.floor(now / interval) * interval;
    for (let i = 0; i < lookahead; i++) {
      const epoch = base + i * interval;
      const slug  = `${prefix}-${epoch}`;
      try {
        const r    = await fetch(`${GAMMA_API}?slug=${slug}`);
        const data = await r.json();
        if (!data || !data.length) continue;
        const market   = data[0];
        const tokenIds = JSON.parse(typeof market.clobTokenIds === 'string' ? market.clobTokenIds : JSON.stringify(market.clobTokenIds));
        const outcomes = JSON.parse(typeof market.outcomes === 'string' ? market.outcomes : JSON.stringify(market.outcomes || '["Up","Down"]'));
        tokenIds.forEach((tid, idx) => {
          newMap[BigInt(tid).toString()] = {
            slug, outcome: outcomes[idx] || `token${idx}`,
            coin, tf, timeframe: prefix, epoch,
          };
        });
      } catch {}
    }
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
  startPricePoll();
  scheduleNextEvent();
  connectK9Watcher();
});
