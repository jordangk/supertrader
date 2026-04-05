import React, { useState, useEffect, useCallback } from 'react';
import { useWebSocket } from './hooks/useWebSocket.js';
import EventHeader from './components/EventHeader.jsx';
import BTCBar from './components/BTCBar.jsx';
import PricePanel from './components/PricePanel.jsx';
import BuyPanel from './components/BuyPanel.jsx';
import WalletBar from './components/WalletBar.jsx';
import OrderHistory from './components/OrderHistory.jsx';
import Positions from './components/Positions.jsx';
import OrderToast from './components/OrderToast.jsx';
import K9Trades from './components/K9Trades.jsx';
import MyTrades from './components/MyTrades.jsx';
import LiveBetsConfig from './components/LiveBetsConfig.jsx';
import SimDashboard from './components/SimDashboard.jsx';
import PriceTracker from './components/PriceTracker.jsx';
import EventSearch from './components/EventSearch.jsx';
import PriceDivergence from './components/PriceDivergence.jsx';
import EmaTradeLog from './components/EmaTradeLog.jsx';
import Btc5mSequenceTab from './components/Btc5mSequenceTab.jsx';
import Btc5mTrader from './components/Btc5mTrader.jsx';
import EndingSoon from './components/EndingSoon.jsx';
import { getApiBase } from './apiBase.js';

const AMOUNTS = [50, 25, 10, 5];
const FEE_PCT = 0.02; // 2% Polymarket fee

const API_BASE = getApiBase();

export default function App() {
  const { prices, btc, binanceBtc, serverEma, priceEma, event, refreshTrigger, copyFeed, whaleTrades, ethPrices, ethEvent } = useWebSocket();
  const [wallet, setWallet] = useState(null);
  const [orders, setOrders] = useState([]);
  const [positions, setPositions] = useState([]);
  const [openOrders, setOpenOrders] = useState([]);
  const [buying, setBuying] = useState(null);
  const [toast, setToast] = useState(null);
  const [tab, setTab] = useState('btc');
  const [showEventSearch, setShowEventSearch] = useState(false);
  const [liquidityRewards, setLiquidityRewards] = useState({ total: 0, byDate: [] });
  const [autoScalp, setAutoScalp] = useState({ enabled: false, threshold: 5, profitCents: 2, shares: 50, log: [] });
  const [buySell, setBuySell] = useState({ price: '', shares: 5, profit: 3 });
  const [autoFlow, setAutoFlow] = useState({ enabled: false, log: [], upFlow: null, downFlow: null });
  const [autoEma, setAutoEma] = useState({ enabled: false, phase: null, log: [], ema: {} });
  const [autoLost, setAutoLost] = useState({ enabled: false, side: 'down', shares: 10, buyPrice: 0.02, sellPrice: 0.07, log: [] });
  const [autoEthState, setAutoEthState] = useState({ enabled: false, log: [] });
  const [autoEthEma, setAutoEthEma] = useState({ enabled: false, phase: null, log: [], ema: {} });

  function fetchOpenOrders() {
    fetch(`${API_BASE}/api/open-orders`)
      .then(r => r.json())
      .then(d => setOpenOrders(d.orders || []))
      .catch(() => {});
  }

  // Fetch wallet + orders + liquidity rewards on load (positions are fetched when event loads)
  function fetchLiquidityRewards() {
    fetch(`${API_BASE}/api/liquidity-rewards?days=7`)
      .then(r => r.json())
      .then(d => setLiquidityRewards(d))
      .catch(() => setLiquidityRewards({ total: 0, byDate: [] }));
  }
  useEffect(() => {
    fetch(`${API_BASE}/api/wallet`).then(r => r.json()).then(setWallet).catch(() => {});
    fetchLiquidityRewards();
    fetchOrders();
    fetchOpenOrders();
    // Poll open orders every 5s
    const iv = setInterval(fetchOpenOrders, 5000);
    // Refresh liquidity rewards every 5 min (rewards distributed daily at midnight UTC)
    const rv = setInterval(fetchLiquidityRewards, 5 * 60 * 1000);
    fetchAutoScalp();
    fetchAutoFlow();
    fetchAutoEma();
    fetchAutoLost();
    const asIv = setInterval(fetchAutoScalp, 5000);
    const afIv = setInterval(fetchAutoFlow, 3000);
    const aeIv = setInterval(fetchAutoEma, 2000);
    const alIv = setInterval(fetchAutoLost, 5000);
    return () => { clearInterval(iv); clearInterval(rv); clearInterval(asIv); clearInterval(afIv); clearInterval(aeIv); clearInterval(alIv); };
  }, []);

  function fetchAutoScalp() {
    fetch(`${API_BASE}/api/auto-scalp`).then(r => r.json()).then(setAutoScalp).catch(() => {});
  }
  function fetchAutoFlow() {
    fetch(`${API_BASE}/api/auto-flow`).then(r => { if (r.ok) return r.json(); throw new Error(); }).then(setAutoFlow).catch(() => {});
  }

  function fetchAutoEma() {
    fetch(`${API_BASE}/api/auto-ema`).then(r => { if (r.ok) return r.json(); throw new Error(); }).then(setAutoEma).catch(() => {});
    fetch(`${API_BASE}/api/eth-state`).then(r => { if (r.ok) return r.json(); throw new Error(); }).then(d => { if (d.autoEth) setAutoEthState(d.autoEth); }).catch(() => {});
    fetch(`${API_BASE}/api/eth-ema-state`).then(r => { if (r.ok) return r.json(); throw new Error(); }).then(setAutoEthEma).catch(() => {});
  }
  async function toggleAutoEma() {
    try {
      const cur = await fetch(`${API_BASE}/api/auto-ema`).then(r => r.json());
      const res = await fetch(`${API_BASE}/api/auto-ema`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ enabled: !cur.enabled }),
      });
      const data = await res.json();
      setAutoEma(prev => ({ ...prev, ...data }));
    } catch (e) {
      setToast({ success: false, error: e.message });
    }
  }

  function fetchAutoLost() {
    fetch(`${API_BASE}/api/auto-lost`).then(r => { if (r.ok) return r.json(); throw new Error(); }).then(setAutoLost).catch(() => {});
  }
  async function toggleAutoLost() {
    try {
      const cur = await fetch(`${API_BASE}/api/auto-lost`).then(r => r.json());
      const res = await fetch(`${API_BASE}/api/auto-lost`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ enabled: !cur.enabled }),
      });
      const data = await res.json();
      setAutoLost(prev => ({ ...prev, ...data }));
    } catch (e) {
      setToast({ success: false, error: e.message });
    }
  }
  async function setAutoLostSide(side) {
    try {
      const res = await fetch(`${API_BASE}/api/auto-lost`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ side }),
      });
      const data = await res.json();
      setAutoLost(prev => ({ ...prev, ...data }));
    } catch (e) {
      setToast({ success: false, error: e.message });
    }
  }

  async function toggleAutoFlow() {
    try {
      const cur = await fetch(`${API_BASE}/api/auto-flow`).then(r => r.json());
      const res = await fetch(`${API_BASE}/api/auto-flow`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ enabled: !cur.enabled }),
      });
      const data = await res.json();
      setAutoFlow(prev => ({ ...prev, ...data }));
    } catch (e) {
      setToast({ success: false, error: e.message });
    }
  }

  async function toggleAutoScalp() {
    try {
      // Read current state from server first to avoid stale closure
      const cur = await fetch(`${API_BASE}/api/auto-scalp`).then(r => r.json());
      const res = await fetch(`${API_BASE}/api/auto-scalp`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ enabled: !cur.enabled }),
      });
      const data = await res.json();
      setAutoScalp(prev => ({ ...prev, ...data, ref: data.lastTriggerPrice ?? prev.ref, btc: prev.btc }));
    } catch (e) {
      setToast({ success: false, error: e.message });
    }
  }

  useEffect(() => {
    if (event?.slug) {
      setPositions([]);
      fetchOrders();
      fetchOpenOrders();
      fetch(`${API_BASE}/api/wallet`).then(r => r.json()).then(setWallet).catch(() => {});
      const q = `?event=${encodeURIComponent(event.slug)}`;
      fetch(`${API_BASE}/api/positions${q}`)
        .then(r => r.json())
        .then(d => setPositions(d.positions || []))
        .catch(() => setPositions([]));
    }
  }, [event?.slug]);

  // When server broadcasts 'refresh' (e.g. buy-then-sell placed sells), refresh orders + positions
  useEffect(() => {
    if (refreshTrigger > 0) {
      fetchOrders();
      fetchOpenOrders();
      if (event?.slug) {
        fetch(`${API_BASE}/api/positions?event=${encodeURIComponent(event.slug)}`)
          .then(r => r.json())
          .then(d => setPositions(d.positions || []))
          .catch(() => {});
      }
      fetch(`${API_BASE}/api/wallet`).then(r => r.json()).then(setWallet).catch(() => {});
    }
  }, [refreshTrigger]);

  function fetchOrders() {
    fetch(`${API_BASE}/api/orders`)
      .then(r => r.json())
      .then(d => {
        const fromApi = d.orders || [];
        setOrders(prev => {
          const pending = prev.filter(o => String(o.id).startsWith('temp-'));
          const apiIds = new Set(fromApi.map(o => o.polymarket_order_id).filter(Boolean));
          const stillPending = pending.filter(t => !apiIds.has(t.polymarket_order_id));
          return [...stillPending, ...fromApi];
        });
      })
      .catch(() => {});
  }

  async function handleBuy(side, amount) {
    setBuying(`${side}-${amount}`);
    try {
      const res = await fetch(`${API_BASE}/api/buy`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ side, shares: amount }),
      });
      const text = await res.text();
      let data;
      try {
        data = text ? JSON.parse(text) : {};
      } catch (parseErr) {
        setToast({ success: false, error: `Server error (not JSON). Is server running? ${res.status}`, side });
        return;
      }
      setToast({ ...data, side });
      if (data.success && data.trade) {
        const newOrder = {
          ...data.trade,
          id: data.trade.id || `temp-${Date.now()}`,
          order_status: 'filled',
          polymarket_event_id: data.trade.polymarket_event_id || event?.slug,
          polymarket_order_id: data.order?.orderID || data.order?.orderId || data.trade.polymarket_order_id,
          purchase_amount: data.trade.purchase_amount ?? data.purchase_amount ?? (data.shares * data.price),
          shares: data.trade.shares ?? data.shares,
          direction: data.trade.direction ?? side,
        };
        setOrders(prev => [newOrder, ...prev]);
      }
      setTimeout(() => {
        fetchOrders();
        if (event?.slug) {
          fetch(`${API_BASE}/api/positions?event=${encodeURIComponent(event.slug)}`)
            .then(r => r.json())
            .then(d => setPositions(d.positions || []))
            .catch(() => {});
        }
      }, 600);
      fetch(`${API_BASE}/api/wallet`).then(r => r.json()).then(setWallet).catch(() => {});
    } catch (e) {
      const msg = e.message === 'Failed to fetch'
        ? 'Cannot reach server. Is it running on port 3001?'
        : e.message;
      setToast({ success: false, error: msg, side });
    } finally {
      setBuying(null);
    }
  }

  async function handleRewardsBuy(side) {
    setBuying(`rewards-buy-${side}`);
    try {
      const res = await fetch(`${API_BASE}/api/rewards-buy`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ side }),
      });
      const data = await res.json();
      setToast({ ...data, side, type: 'rewards-buy' });
      setTimeout(() => { fetchOrders(); fetchOpenOrders(); }, 600);
    } catch (e) {
      setToast({ success: false, error: e.message, side });
    } finally { setBuying(null); }
  }

  async function handleRewardsSell(side) {
    setBuying(`rewards-sell-${side}`);
    try {
      const res = await fetch(`${API_BASE}/api/rewards-sell`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ side }),
      });
      const data = await res.json();
      setToast({ ...data, side, type: 'rewards-sell' });
      setTimeout(() => { fetchOrders(); fetchOpenOrders(); }, 600);
    } catch (e) {
      setToast({ success: false, error: e.message, side });
    } finally { setBuying(null); }
  }

  async function handleSuperRewards(side) {
    setBuying(`super-${side}`);
    try {
      const res = await fetch(`${API_BASE}/api/super-rewards`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ side }),
      });
      const data = await res.json();
      setToast({ ...data, side, type: 'super-rewards' });
      fetchOrders(); fetchOpenOrders();
      fetch(`${API_BASE}/api/wallet`).then(r => r.json()).then(setWallet).catch(() => {});
    } catch (e) {
      setToast({ success: false, error: e.message, side });
    } finally { setBuying(null); }
  }

  async function handleWhaleStyleBuy(side, discountCents = 2) {
    setBuying(`whale-style-${side}-${discountCents}`);
    try {
      const res = await fetch(`${API_BASE}/api/whale-style-buy`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ side, shares: 5, discountCents }),
      });
      const data = await res.json();
      if (!res.ok) setToast({ success: false, error: data.error || `HTTP ${res.status}`, side });
      else setToast({ ...data, side, type: 'whale-style', discountCents });
      if (data.success) {
        fetchOrders(); fetchOpenOrders();
        fetch(`${API_BASE}/api/wallet`).then(r => r.json()).then(setWallet).catch(() => {});
      }
    } catch (e) {
      setToast({ success: false, error: e.message, side });
    } finally { setBuying(null); }
  }

  async function handleSuperSell(side) {
    setBuying(`super-sell-${side}`);
    try {
      const res = await fetch(`${API_BASE}/api/super-sell`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ side }),
      });
      const data = await res.json();
      setToast({ ...data, side, type: 'super-sell' });
      fetchOrders(); fetchOpenOrders();
      fetch(`${API_BASE}/api/wallet`).then(r => r.json()).then(setWallet).catch(() => {});
    } catch (e) {
      setToast({ success: false, error: e.message, side });
    } finally { setBuying(null); }
  }

  async function handleSell(side, shares, price) {
    setBuying(`sell-${side}`);
    try {
      const res = await fetch(`${API_BASE}/api/sell`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ side, shares }),
      });
      const text = await res.text();
      let data;
      try { data = text ? JSON.parse(text) : {}; } catch {
        setToast({ success: false, error: `Invalid response (${res.status})`, side, type: 'sell' });
        return;
      }
      setToast({ ...data, side, type: 'sell', isSell: data.success });
      const refresh = () => {
        fetchOrders();
        fetchOpenOrders();
        if (event?.slug) {
          fetch(`${API_BASE}/api/positions?event=${encodeURIComponent(event.slug)}`)
            .then(r => r.json())
            .then(d => setPositions(d.positions || []))
            .catch(() => {});
        }
        fetch(`${API_BASE}/api/wallet`).then(r => r.json()).then(setWallet).catch(() => {});
      };
      refresh();
      setTimeout(refresh, 800);
      setTimeout(refresh, 2000);
      setTimeout(refresh, 5000);
    } catch (e) {
      setToast({ success: false, error: e.message, side });
    } finally {
      setBuying(null);
    }
  }

  async function handleSellAll(side, tokenId) {
    setBuying(`sellall-${side}`);
    try {
      const res = await fetch(`${API_BASE}/api/sell-all`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ side, ...(tokenId && { tokenId }) }),
      });
      const text = await res.text();
      let data;
      try { data = text ? JSON.parse(text) : {}; } catch {
        setToast({ success: false, error: `Invalid response (${res.status})`, side, type: 'sell-all' });
        return;
      }
      setToast({ ...data, side, type: 'sell-all', isSell: data.success });
      const refresh = () => {
        fetchOrders();
        fetchOpenOrders();
        if (event?.slug) {
          fetch(`${API_BASE}/api/positions?event=${encodeURIComponent(event.slug)}`)
            .then(r => r.json()).then(d => setPositions(d.positions || [])).catch(() => {});
        }
        fetch(`${API_BASE}/api/wallet`).then(r => r.json()).then(setWallet).catch(() => {});
      };
      refresh();
      setTimeout(refresh, 800);
      setTimeout(refresh, 2000);
      setTimeout(refresh, 5000);
    } catch (e) {
      setToast({ success: false, error: e.message, side });
    } finally { setBuying(null); }
  }

  async function handleBuySell(side) {
    const p = parseFloat(buySell.price) / 100;
    if (!p || p <= 0 || p >= 1) { setToast({ success: false, error: 'Enter price in cents (1-99)' }); return; }
    setBuying('bs-' + side);
    try {
      const res = await fetch(`${API_BASE}/api/buy-sell`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ side, price: p, shares: buySell.shares, profitCents: buySell.profit }),
      });
      const data = await res.json();
      if (data.success) setToast({ success: true, message: `${side.toUpperCase()}: buy@${buySell.price}¢ sell@${(parseFloat(buySell.price)+buySell.profit).toFixed(0)}¢` });
      else setToast({ success: false, error: data.error });
    } catch (e) { setToast({ success: false, error: e.message }); }
    setBuying(null);
  }

  async function handleLostScalp(side) {
    setBuying('lost-' + side);
    try {
      const res = await fetch(`${API_BASE}/api/lost-scalp`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ side }),
      });
      const data = await res.json();
      if (data.success) setToast({ success: true, message: `Lost ${side.toUpperCase()}: buy@2¢ sell@7¢` });
      else setToast({ success: false, error: data.error });
    } catch (e) { setToast({ success: false, error: e.message }); }
    setBuying(null);
  }

  async function handleBuyBoth() {
    setBuying('buy-both');
    try {
      const res = await fetch(`${API_BASE}/api/buy-both`, { method: 'POST', headers: { 'Content-Type': 'application/json' } });
      const text = await res.text();
      let data;
      try {
        data = text ? JSON.parse(text) : {};
      } catch {
        setToast({ success: false, error: `Invalid response (${res.status})`, type: 'buy-both' });
        return;
      }
      setToast({ ...data, type: 'buy-both', message: data.message, up: data.up, down: data.down });
      if (data.success) {
        const nowIso = new Date().toISOString();
        const optimistic = [];
        if (data.up?.orderID) optimistic.push({ id: `temp-${Date.now()}-up`, polymarket_order_id: data.up.orderID, polymarket_event_id: event?.slug, direction: 'up', purchase_price: data.up.price, purchase_amount: (data.up.shares || 0) * (data.up.price || 0), shares: data.up.shares, order_status: 'open', purchase_time: nowIso, order_type: 'live' });
        if (data.down?.orderID) optimistic.push({ id: `temp-${Date.now()}-down`, polymarket_order_id: data.down.orderID, polymarket_event_id: event?.slug, direction: 'down', purchase_price: data.down.price, purchase_amount: (data.down.shares || 0) * (data.down.price || 0), shares: data.down.shares, order_status: 'open', purchase_time: nowIso, order_type: 'live' });
        if (optimistic.length) setOrders(prev => [...optimistic, ...prev]);
      }
      const refresh = () => { fetchOrders(); fetchOpenOrders(); if (event?.slug) fetch(`${API_BASE}/api/positions?event=${encodeURIComponent(event.slug)}`).then(r => r.json()).then(d => setPositions(d.positions || [])).catch(() => {}); fetch(`${API_BASE}/api/wallet`).then(r => r.json()).then(setWallet).catch(() => {}); };
      refresh();
      setTimeout(refresh, 800); setTimeout(refresh, 2000); setTimeout(refresh, 5000); setTimeout(refresh, 10000);
    } catch (e) { setToast({ success: false, error: e.message }); } finally { setBuying(null); }
  }

  async function handleBuyThenSellBoth() {
    setBuying('buy-then-sell-both');
    try {
      const res = await fetch(`${API_BASE}/api/buy-then-sell-both`, { method: 'POST', headers: { 'Content-Type': 'application/json' } });
      const text = await res.text();
      let data;
      try {
        data = text ? JSON.parse(text) : {};
      } catch {
        setToast({ success: false, error: `Invalid response (${res.status})`, type: 'buy-then-sell' });
        return;
      }
      setToast({ ...data, type: 'buy-then-sell', message: data.message || 'Buys placed. Sells will be placed when filled.' });
      const refresh = () => { fetchOrders(); fetchOpenOrders(); if (event?.slug) fetch(`${API_BASE}/api/positions?event=${encodeURIComponent(event.slug)}`).then(r => r.json()).then(d => setPositions(d.positions || [])).catch(() => {}); fetch(`${API_BASE}/api/wallet`).then(r => r.json()).then(setWallet).catch(() => {}); };
      refresh();
      setTimeout(refresh, 800); setTimeout(refresh, 2000); setTimeout(refresh, 5000); setTimeout(refresh, 10000);
    } catch (e) { setToast({ success: false, error: e.message }); } finally { setBuying(null); }
  }

  async function handleSellBoth() {
    setBuying('sell-both');
    try {
      const res = await fetch(`${API_BASE}/api/sell-both`, { method: 'POST', headers: { 'Content-Type': 'application/json' } });
      const text = await res.text();
      let data;
      try {
        data = text ? JSON.parse(text) : {};
      } catch {
        setToast({ success: false, error: `Invalid response (${res.status})`, type: 'sell-both' });
        return;
      }
      setToast({ ...data, type: 'sell-both' });
      const refresh = () => { fetchOrders(); fetchOpenOrders(); if (event?.slug) fetch(`${API_BASE}/api/positions?event=${encodeURIComponent(event.slug)}`).then(r => r.json()).then(d => setPositions(d.positions || [])).catch(() => {}); fetch(`${API_BASE}/api/wallet`).then(r => r.json()).then(setWallet).catch(() => {}); };
      setTimeout(refresh, 2000); setTimeout(refresh, 5000); setTimeout(refresh, 10000);
    } catch (e) { setToast({ success: false, error: e.message }); } finally { setBuying(null); }
  }

  async function handleSplit() {
    setBuying('split');
    try {
      const res = await fetch(`${API_BASE}/api/split`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ amount: 150 }),
      });
      const data = await res.json();
      setToast({ ...data, type: 'split', message: data.success ? `Split $150 → 150 Up + 150 Down (tx: ${data.txHash?.slice(0,10)}...)` : data.error });
      const refresh = () => { fetchOrders(); fetchOpenOrders(); fetch(`${API_BASE}/api/wallet`).then(r => r.json()).then(setWallet).catch(() => {}); };
      refresh(); setTimeout(refresh, 3000); setTimeout(refresh, 10000);
    } catch (e) { setToast({ success: false, error: e.message }); } finally { setBuying(null); }
  }

  async function handleCancelOrder(orderID) {
    try {
      await fetch(`${API_BASE}/api/cancel`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ orderID }),
      });
      fetchOpenOrders();
    } catch (e) {
      setToast({ success: false, error: e.message });
    }
  }

  async function handleCancelAll() {
    try {
      await fetch(`${API_BASE}/api/cancel-all`, { method: 'POST' });
      setOpenOrders([]);
      fetchOpenOrders();
    } catch (e) {
      setToast({ success: false, error: e.message });
    }
  }

  // Orders for current event; fall back to most recent event if filter yields nothing
  let eventOrders = orders;
  if (event?.slug) {
    const slugNum = (event.slug.match(/(\d{10,})/) || [])[1];
    const filtered = orders.filter(o => {
      const eid = String(o.polymarket_event_id || o.polymarket_event || '');
      return eid === event.slug || eid === slugNum;
    });
    if (filtered.length > 0) {
      eventOrders = filtered;
    } else if (orders.length > 0) {
      // No match: use most recent event from orders
      const byEvent = {};
      for (const o of orders) {
        const eid = o.polymarket_event_id || o.polymarket_event || '';
        if (!byEvent[eid]) byEvent[eid] = [];
        byEvent[eid].push(o);
      }
      const mostRecent = Object.entries(byEvent).sort((a, b) => {
        const aMax = a[1].length ? Math.max(...a[1].map(x => new Date(x.created_at || x.purchase_time || 0).getTime())) : 0;
        const bMax = b[1].length ? Math.max(...b[1].map(x => new Date(x.created_at || x.purchase_time || 0).getTime())) : 0;
        return bMax - aMax;
      })[0];
      if (mostRecent) eventOrders = mostRecent[1];
    }
  }
  const holdings = { up: { shares: 0, cost: 0 }, down: { shares: 0, cost: 0 } };
  for (const o of eventOrders) {
    if (o.order_status === 'resolved') continue;
    const s = o.direction;
    if (holdings[s]) {
      holdings[s].shares += parseFloat(o.shares || 0);
      holdings[s].cost += parseFloat(o.purchase_amount || 0);
    }
  }
  const totalCost = holdings.up.cost + holdings.down.cost;
  const ev = (prices.upPrice ?? 0) * holdings.up.shares + (prices.downPrice ?? 0) * holdings.down.shares - totalCost;
  const expectedROI = totalCost > 0 ? ev / totalCost : 0;

  return (
    <div className="min-h-screen bg-gray-950 flex flex-col">
      {/* Header */}
      <div className="bg-gray-900 border-b border-gray-800 px-4 py-3 flex items-center justify-between">
        <div className="flex items-center gap-3">
          <span className="text-orange-500 text-2xl">₿</span>
          <span className="font-bold text-lg tracking-tight">SuperTrader</span>
          <button onClick={() => setShowEventSearch(!showEventSearch)}
            className={`px-3 py-1 text-xs rounded-lg border transition-colors ${
              showEventSearch
                ? 'bg-orange-600/30 border-orange-500/50 text-orange-300'
                : 'bg-gray-800 border-gray-700 text-gray-400 hover:text-gray-200'
            }`}>
            {showEventSearch ? 'Hide Search' : 'Find Event'}
          </button>
          <a
            href="/arb"
            target="_blank"
            rel="noopener noreferrer"
            className="px-3 py-1 text-xs rounded-lg border border-gray-700 bg-gray-800 text-amber-400 hover:bg-gray-700 hover:text-amber-300 transition-colors"
          >
            Arb Lab ↗
          </a>
        </div>
        <WalletBar wallet={wallet} liquidityRewards={liquidityRewards} />
      </div>

      {showEventSearch && (
        <div className="px-4 py-2 bg-gray-950 border-b border-gray-800">
          <EventSearch currentSlug={event?.slug} onClose={() => setShowEventSearch(false)} />
        </div>
      )}

      <div className="flex-1 p-4 mx-auto w-full space-y-4 max-w-5xl">
          <div className="space-y-4">
            {/* Auto-Scalp Toggle */}
            <div className={`rounded-xl border p-3 space-y-2 ${autoScalp.enabled ? 'border-cyan-600 bg-cyan-950/30' : 'border-gray-800 bg-gray-900/50'}`}>
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <span className="text-sm font-bold text-cyan-400">Auto-Scalp</span>
                  <span className="text-[10px] text-gray-500">${autoScalp.threshold} BTC move → {autoScalp.profitCents}¢ scalp ({autoScalp.shares}sh)</span>
                </div>
                <button
                  onClick={toggleAutoScalp}
                  className={`px-3 py-1 rounded-lg text-xs font-bold transition-all ${
                    autoScalp.enabled
                      ? 'bg-cyan-600 text-white hover:bg-cyan-500'
                      : 'bg-gray-800 text-gray-400 hover:bg-gray-700 hover:text-gray-200'
                  }`}
                >
                  {autoScalp.enabled ? 'ON' : 'OFF'}
                </button>
              </div>
              {autoScalp.enabled && autoScalp.ref != null && (
                <div className="text-[10px] text-gray-500 font-mono">
                  Ref: ${autoScalp.ref?.toLocaleString()} | BTC: ${autoScalp.btc?.toLocaleString()} | Next trigger: ±${autoScalp.threshold}
                </div>
              )}
              {(autoScalp.sides?.up?.hedgeOrderId || autoScalp.sides?.down?.hedgeOrderId) && (
                <div className="text-[10px] text-yellow-400 font-mono">
                  {autoScalp.sides?.up?.hedgeOrderId && <div>Hedge UP: {autoScalp.sides.up.hedgeOrderId.slice(0, 12)}...</div>}
                  {autoScalp.sides?.down?.hedgeOrderId && <div>Hedge DN: {autoScalp.sides.down.hedgeOrderId.slice(0, 12)}...</div>}
                </div>
              )}
              {autoScalp.log?.length > 0 && (
                <div className="space-y-0.5">
                  {autoScalp.log.slice(0, 5).map((l, i) => (
                    <div key={i} className="text-[10px] font-mono text-gray-500">
                      {new Date(l.ts).toLocaleTimeString()} — {l.side.toUpperCase()} (BTC {l.delta >= 0 ? '+' : ''}{l.delta})
                    </div>
                  ))}
                </div>
              )}
              <div className="border-t border-gray-800 pt-2 space-y-1 text-[10px] text-gray-600 leading-relaxed">
                <p>Watches Binance BTC stream. $5+ move → 1 scalp. FAK buys {autoScalp.shares}sh winning side → waits 1.5s for BTC to keep moving same direction → GTC hedge opposite side at price locking 1¢ profit.</p>
                <p>One scalp at a time — blocked until hedge fills or you cancel it. 3s cooldown after. Only 50-80¢.</p>
              </div>
            </div>
            {/* Auto-Flow Toggle */}
            <div className={`rounded-xl border p-3 space-y-2 ${autoFlow.enabled ? 'border-purple-600 bg-purple-950/30' : 'border-gray-800 bg-gray-900/50'}`}>
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <span className="text-sm font-bold text-purple-400">Auto-Flow</span>
                  <span className="text-[10px] text-gray-500">Smooth trend → 2¢ profit ({autoFlow.shares || 5}sh)</span>
                </div>
                <button
                  onClick={toggleAutoFlow}
                  className={`px-3 py-1 rounded-lg text-xs font-bold transition-all ${
                    autoFlow.enabled
                      ? 'bg-purple-600 text-white hover:bg-purple-500'
                      : 'bg-gray-800 text-gray-400 hover:bg-gray-700 hover:text-gray-200'
                  }`}
                >
                  {autoFlow.enabled ? 'ON' : 'OFF'}
                </button>
              </div>
              {/* Live flow scores */}
              <div className="flex gap-4 text-[10px] font-mono">
                {autoFlow.upFlow && (
                  <span className={`${autoFlow.upFlow.goingUp ? 'text-green-400' : 'text-green-400/40'}`}>
                    Up: {(autoFlow.upFlow.mono * 100).toFixed(0)}% flow, {autoFlow.upFlow.moveCents.toFixed(1)}¢ {autoFlow.upFlow.goingUp ? '↑' : '↓'}, {autoFlow.upFlow.reversals}rev ({autoFlow.upFlow.ticks}t)
                  </span>
                )}
                {autoFlow.downFlow && (
                  <span className={`${!autoFlow.downFlow.goingUp ? 'text-red-400' : 'text-red-400/40'}`}>
                    Dn: {(autoFlow.downFlow.mono * 100).toFixed(0)}% flow, {autoFlow.downFlow.moveCents.toFixed(1)}¢ {autoFlow.downFlow.goingUp ? '↑' : '↓'}, {autoFlow.downFlow.reversals}rev ({autoFlow.downFlow.ticks}t)
                  </span>
                )}
                {!autoFlow.upFlow && !autoFlow.downFlow && <span className="text-gray-600">Collecting ticks...</span>}
              </div>
              {(autoFlow.sides?.up?.hedgeOrderId || autoFlow.sides?.down?.hedgeOrderId) && (
                <div className="text-[10px] text-yellow-400 font-mono">
                  {autoFlow.sides?.up?.hedgeOrderId && <div>Hedge UP: {autoFlow.sides.up.hedgeOrderId.slice(0, 12)}...</div>}
                  {autoFlow.sides?.down?.hedgeOrderId && <div>Hedge DN: {autoFlow.sides.down.hedgeOrderId.slice(0, 12)}...</div>}
                </div>
              )}
              {autoFlow.log?.length > 0 && (
                <div className="space-y-0.5">
                  {autoFlow.log.slice(0, 5).map((l, i) => (
                    <div key={i} className="text-[10px] font-mono text-gray-500">
                      {new Date(l.ts).toLocaleTimeString()} — {l.side.toUpperCase()} (flow={l.mono} move={l.move}¢ rev={l.reversals})
                      {l.buyPrice != null && (
                        <span className="text-cyan-400 ml-1">
                          → UP @{(l.buyPrice*100).toFixed(0)}¢ + DN @{(l.oppBuyPrice*100).toFixed(0)}¢ = {l.profit}¢
                        </span>
                      )}
                    </div>
                  ))}
                </div>
              )}
              <div className="border-t border-gray-800 pt-2 text-[10px] text-gray-600 leading-relaxed">
                <p>Detects smooth price drift (mostly flat ticks + slow creep). Triggers when ≥{(autoFlow.monotonicity * 100 || 85).toFixed(0)}% of ticks are flat or with-trend, ≤{((autoFlow.maxReversalPct ?? 0.20) * 100).toFixed(0)}% reversals, ≥{autoFlow.minMoveCents || 3}¢ total move over {autoFlow.windowSecs || 60}s. Same buy+sell as scalp. {autoFlow.priceMin || 30}–{autoFlow.priceMax || 70}¢ range.</p>
              </div>
            </div>
            {/* Auto-EMA Toggle */}
            <div className={`rounded-xl border p-3 space-y-2 transition-all ${
              autoEma.phase === 'pending' || autoEma.phase === 'retrying' ? 'border-orange-500 bg-orange-950/40 ring-1 ring-orange-500/50 animate-pulse' :
              autoEma.phase === 'entered' ? 'border-yellow-500 bg-yellow-950/40 ring-1 ring-yellow-500/50 animate-pulse' :
              autoEma.phase === 'hedging' || autoEma.phase === 'hedged' ? 'border-green-500 bg-green-950/30 ring-1 ring-green-500/50' :
              autoEma.enabled && Math.abs(autoEma.ema?.gap || 0) >= (autoEma.gapOpenThreshold || 5) ? 'border-cyan-500 bg-cyan-950/40 ring-1 ring-cyan-400/40' :
              autoEma.enabled ? 'border-cyan-600 bg-cyan-950/30' : 'border-gray-800 bg-gray-900/50'
            }`}>
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <span className="text-sm font-bold text-cyan-400">Auto-EMA</span>
                  <span className="text-[10px] text-gray-500">EMA gap ≥${autoEma.gapOpenThreshold || 5} → scalp 5sh (mkt-3¢)</span>
                  {autoEma.phase === 'pending' && <span className="text-[10px] font-bold text-orange-400 animate-pulse">PENDING FILL</span>}
                  {autoEma.phase === 'entered' && <span className="text-[10px] font-bold text-yellow-400 animate-pulse">ENTERED</span>}
                  {autoEma.phase === 'hedging' && <span className="text-[10px] font-bold text-green-400 animate-pulse">HEDGING</span>}
                  {autoEma.phase === 'hedged' && <span className="text-[10px] font-bold text-green-400">HEDGED</span>}
                </div>
                <button
                  onClick={toggleAutoEma}
                  className={`px-3 py-1 rounded-lg text-xs font-bold transition-all ${
                    autoEma.enabled
                      ? 'bg-cyan-600 text-white hover:bg-cyan-500'
                      : 'bg-gray-800 text-gray-400 hover:bg-gray-700 hover:text-gray-200'
                  }`}
                >
                  {autoEma.enabled ? 'ON' : 'OFF'}
                </button>
              </div>
              {/* Live velocity + EMA — from WebSocket (tick-by-tick) */}
              <div className="flex gap-3 text-[10px] font-mono flex-wrap">
                <span className={`font-bold ${
                  Math.abs(serverEma?.velocity || 0) >= 20
                    ? (serverEma?.velocity || 0) > 0 ? 'text-green-400' : 'text-red-400'
                    : 'text-gray-500'
                }`}>
                  Vel: ${(serverEma?.velocity || 0).toFixed(1)}/3s
                  {Math.abs(serverEma?.velocity || 0) >= 20 && ' TRIGGER'}
                </span>
                <span className="text-cyan-400">E12: ${(serverEma?.e12 || 0).toFixed(1)}</span>
                <span className="text-purple-400">E26: ${(serverEma?.e26 || 0).toFixed(1)}</span>
                <span className="text-gray-500">Gap: ${Math.abs(serverEma?.gap || 0).toFixed(1)}</span>
                <span className="text-gray-500">Hist: {(serverEma?.histogram || 0).toFixed(2)}</span>
              </div>
              {autoEma.phase && (
                <div className={`text-[10px] font-mono font-bold ${autoEma.phase === 'entered' ? 'text-yellow-400' : 'text-green-400'}`}>
                  {autoEma.entrySide?.toUpperCase()} @ {autoEma.entryPrice ? `${(autoEma.entryPrice * 100).toFixed(0)}¢` : '—'}
                  {autoEma.peakProfit != null && ` | peak: +${autoEma.peakProfit}¢`}
                  {autoEma.phase === 'entered' && ` | stop: -5¢ | exit on MACD cross`}
                </div>
              )}
              {autoEma.log?.length > 0 && (
                <div className="space-y-1">
                  {autoEma.log.slice(0, 5).map((l, i) => (
                    <div key={i} className={`text-[10px] font-mono rounded px-1.5 py-0.5 ${
                      l.result === 'filled' || l.result === 'tp_filled' ? 'bg-green-950/50 text-green-400' :
                      l.result === 'hedged' ? 'bg-yellow-950/50 text-yellow-400' :
                      l.result === 'trend_faded' || l.result === 'max_retries' ? 'bg-red-950/50 text-red-400' :
                      l.result === 'entered' ? 'bg-cyan-950/50 text-cyan-400' :
                      'bg-gray-900/50 text-gray-500'
                    }`}>
                      <span>{new Date(l.ts).toLocaleTimeString()}</span>
                      <span className="ml-1 font-bold">{l.side?.toUpperCase()}</span>
                      <span className="ml-1">gap=${Math.abs(l.triggerGap || l.gap || 0).toFixed(1)}</span>
                      {l.entryPrice != null && <span className="ml-1 text-cyan-300">buy@{(l.entryPrice*100).toFixed(0)}¢</span>}
                      {l.tpPrice != null && <span className="ml-1 text-purple-300">tp@{(l.tpPrice*100).toFixed(0)}¢</span>}
                      {l.peakGap > 0 && <span className="ml-1">peak=${l.peakGap.toFixed(1)}</span>}
                      {l.hedgePrice != null && <span className="ml-1 text-yellow-300">hedge@{(l.hedgePrice*100).toFixed(0)}¢</span>}
                      {l.hedgeReason && <span className="ml-1 text-gray-400">({l.hedgeReason})</span>}
                      {l.profit != null && <span className={`ml-1 font-bold ${l.profit >= 0 ? 'text-green-400' : 'text-red-400'}`}>{l.profit >= 0 ? '+' : ''}{l.profit}¢</span>}
                      <span className={`ml-1 ${
                        l.result === 'filled' || l.result === 'tp_filled' ? 'text-green-300' :
                        l.result === 'trend_faded' || l.result === 'max_retries' ? 'text-red-300' : ''
                      }`}>{l.result}</span>
                    </div>
                  ))}
                </div>
              )}
              <div className="border-t border-gray-800 pt-2 text-[10px] text-gray-600 leading-relaxed">
                <p>Gap ≥${autoEma.gapOpenThreshold || 5} & widening → buy winning side at mkt-3¢. Gap &lt;${autoEma.gapOpenThreshold || 5} → hedge opposite at mkt-3¢. Always 5sh. {autoEma.priceMin || 25}–{autoEma.priceMax || 85}¢. Timeout: {(autoEma.maxHedgeWaitMs || 30000) / 1000}s.</p>
              </div>
            </div>
            {/* BTC / ETH tab switcher */}
            <div className="flex gap-2 mb-2">
              {[
                { id: 'btc', label: 'BTC' },
                { id: 'eth', label: 'ETH' },
                { id: 'btc5m', label: 'BTC 5m' },
                { id: 'btc5mTrader', label: '5m Trade' },
                { id: 'ending', label: 'Ending Soon' },
              ].map((t) => (
                <button key={t.id} onClick={() => setTab(t.id)}
                  className={`px-4 py-1 rounded text-sm font-bold transition-colors ${tab === t.id ? 'bg-blue-600 text-white' : 'bg-gray-800 text-gray-400 hover:bg-gray-700'}`}>
                  {t.label}
                </button>
              ))}
            </div>
            {tab === 'btc' ? (
              <PriceDivergence key={event?.slug} prices={prices} btc={btc} binanceBtc={binanceBtc} serverEma={serverEma} priceEma={priceEma} event={event} autoEmaLog={autoEma.log || []} />
            ) : tab === 'btc5m' ? (
              <Btc5mSequenceTab />
            ) : tab === 'btc5mTrader' ? (
              <Btc5mTrader />
            ) : tab === 'ending' ? (
              <EndingSoon />
            ) : (
              <>
                {/* ETH Auto-Trade Toggle */}
                <div className="rounded-xl border border-gray-800 bg-gray-900 p-3 mb-2">
                  <div className="flex items-center justify-between">
                    <div>
                      <span className="text-sm font-bold text-purple-400">ETH Velocity</span>
                      <span className="text-[10px] text-gray-500 ml-2">BTC $10/1s → buy ETH, hedge 3s later</span>
                    </div>
                    <button
                      onClick={() => {
                        const next = !autoEthState.enabled;
                        fetch(`${API_BASE}/api/eth-auto`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ enabled: next }) })
                          .then(r => r.json()).then(d => setAutoEthState(d)).catch(() => {});
                      }}
                      className={`px-3 py-1 rounded text-xs font-bold ${autoEthState.enabled ? 'bg-green-600 text-white' : 'bg-gray-700 text-gray-400'}`}>
                      {autoEthState.enabled ? 'ON' : 'OFF'}
                    </button>
                  </div>
                  {autoEthState.log?.length > 0 && (
                    <div className="mt-2 space-y-1 max-h-40 overflow-y-auto">
                      {autoEthState.log.map((t, i) => (
                        <div key={i} className="flex gap-2 text-[10px] font-mono">
                          <span className="text-gray-500">{new Date(t.ts).toLocaleTimeString()}</span>
                          <span className={t.side === 'up' ? 'text-green-400' : 'text-red-400'}>{t.side?.toUpperCase()}</span>
                          <span className="text-gray-400">vel=${t.velocity?.toFixed(0)}</span>
                          <span className="text-gray-400">buy@{((t.entryPrice||0)*100).toFixed(0)}¢</span>
                          <span className="text-gray-400">hedge@{((t.hedgePrice||0)*100).toFixed(0)}¢</span>
                          <span className={`font-bold ${(t.profit||0) >= 0 ? 'text-green-400' : 'text-red-400'}`}>
                            {t.profit != null ? `${t.profit >= 0 ? '+' : ''}${t.profit}¢` : '...'}
                          </span>
                          <span className="text-gray-600">{t.result}</span>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
                {/* ETH EMA Toggle */}
                <div className="rounded-xl border border-gray-800 bg-gray-900 p-3 mb-2">
                  <div className="flex items-center justify-between">
                    <div>
                      <span className="text-sm font-bold text-cyan-400">ETH Auto-EMA</span>
                      <span className="text-[10px] text-gray-500 ml-2">BTC EMA cross → trade ETH, hedge on cross back or gap $6</span>
                    </div>
                    <button
                      onClick={() => {
                        const next = !autoEthEma.enabled;
                        fetch(`${API_BASE}/api/eth-ema`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ enabled: next }) })
                          .then(r => r.json()).then(d => setAutoEthEma(prev => ({ ...prev, ...d }))).catch(() => {});
                      }}
                      className={`px-3 py-1 rounded text-xs font-bold ${autoEthEma.enabled ? 'bg-green-600 text-white' : 'bg-gray-700 text-gray-400'}`}>
                      {autoEthEma.enabled ? 'ON' : 'OFF'}
                    </button>
                  </div>
                  {autoEthEma.phase && (
                    <div className="text-[10px] text-yellow-400 mt-1">Phase: {autoEthEma.phase} | {autoEthEma.entrySide?.toUpperCase()} @ {((autoEthEma.entryPrice||0)*100).toFixed(0)}¢</div>
                  )}
                  {autoEthEma.log?.length > 0 && (
                    <div className="mt-2 space-y-1 max-h-40 overflow-y-auto">
                      {autoEthEma.log.map((t, i) => (
                        <div key={i} className="flex gap-2 text-[10px] font-mono">
                          <span className="text-gray-500">{new Date(t.ts).toLocaleTimeString()}</span>
                          <span className={t.side === 'up' ? 'text-green-400' : 'text-red-400'}>{t.side?.toUpperCase()}</span>
                          <span className="text-gray-400">gap=${t.triggerGap?.toFixed(1)}</span>
                          <span className="text-gray-400">buy@{((t.entryPrice||0)*100).toFixed(0)}¢</span>
                          <span className="text-gray-400">hedge@{((t.hedgePrice||0)*100).toFixed(0)}¢</span>
                          <span className={`font-bold ${(t.profit||0) >= 0 ? 'text-green-400' : 'text-red-400'}`}>
                            {t.profit != null ? `${t.profit >= 0 ? '+' : ''}${t.profit}¢` : '...'}
                          </span>
                          <span className="text-gray-600">{t.result}</span>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
                <PriceDivergence key={ethEvent?.slug || 'eth'} prices={ethPrices} btc={btc} binanceBtc={binanceBtc} serverEma={serverEma} priceEma={priceEma} event={ethEvent} autoEmaLog={autoEthEma.log || []} mode="eth" />
              </>
            )}
          </div>
          <MyTrades />
        <OrderToast toast={toast} onDismiss={() => setToast(null)} />
      </div>
    </div>
  );
}
