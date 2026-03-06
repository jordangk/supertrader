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
import LiveBetsConfig from './components/LiveBetsConfig.jsx';
import SimDashboard from './components/SimDashboard.jsx';
import PriceTracker from './components/PriceTracker.jsx';
import EventSearch from './components/EventSearch.jsx';

const AMOUNTS = [50, 20, 10, 5, 1];
const FEE_PCT = 0.02; // 2% Polymarket fee

const API_BASE = (import.meta.env.VITE_API_URL || '').replace(/\/$/, '');

export default function App() {
  const { prices, btc, binanceBtc, event, refreshTrigger } = useWebSocket();
  const [wallet, setWallet] = useState(null);
  const [orders, setOrders] = useState([]);
  const [positions, setPositions] = useState([]);
  const [openOrders, setOpenOrders] = useState([]);
  const [buying, setBuying] = useState(null);
  const [toast, setToast] = useState(null);
  const [tab, setTab] = useState('trade');
  const [showEventSearch, setShowEventSearch] = useState(false);
  const [liquidityRewards, setLiquidityRewards] = useState({ total: 0, byDate: [] });

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
    return () => { clearInterval(iv); clearInterval(rv); };
  }, []);

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
        body: JSON.stringify({ side, amount }),
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
        </div>
        <WalletBar wallet={wallet} liquidityRewards={liquidityRewards} />
      </div>

      {showEventSearch && (
        <div className="px-4 py-2 bg-gray-950 border-b border-gray-800">
          <EventSearch currentSlug={event?.slug} onClose={() => setShowEventSearch(false)} />
        </div>
      )}

      {/* Tab bar */}
      <div className="bg-gray-900 border-b border-gray-800 px-4 flex gap-1">
        {[['trade', '⚡ Trade'], ['trades', '🔥 Live Trades'], ['prices', '📈 Prices'], ['sim', '📊 k9 Simulator'], ['k9', '👁 k9 Raw']].map(([t, label]) => (
          <button key={t} onClick={() => setTab(t)}
            className={`px-4 py-2 text-sm font-medium border-b-2 transition-colors ${
              tab === t ? 'border-orange-500 text-orange-400' : 'border-transparent text-gray-500 hover:text-gray-300'
            }`}>{label}</button>
        ))}
      </div>

      <div className={`flex-1 p-4 mx-auto w-full space-y-4 ${tab === 'prices' ? 'max-w-5xl' : 'max-w-2xl'}`}>
        {tab === 'trades' && (
          <div className="space-y-4">
            <div>
              <h2 className="text-lg font-bold text-gray-200">Live Trades</h2>
              <p className="text-xs text-gray-500 mt-0.5">Copy k9&apos;s BTC Up/Down trades in real time. Select %, event time, and enable.</p>
            </div>
            <LiveBetsConfig />
          </div>
        )}
        {tab === 'k9' && (
          <>
            <LiveBetsConfig />
            <K9Trades />
          </>
        )}
        {tab === 'sim' && <SimDashboard />}
        {tab === 'prices' && <PriceTracker btc={btc} binanceBtc={binanceBtc} prices={prices} event={event} />}
        {tab === 'trade' && <>
        {/* Sim shortcut banner */}
        <button
          onClick={() => setTab('sim')}
          className="w-full flex items-center justify-between bg-gray-900 border border-orange-900/50 hover:border-orange-500/50 rounded-lg px-4 py-3 transition-colors group"
        >
          <div className="flex items-center gap-3">
            <span className="text-orange-400 text-lg">📊</span>
            <div className="text-left">
              <div className="text-sm font-medium text-gray-200">k9 Simulator</div>
              <div className="text-xs text-gray-500">Live sim of what we'd trade at 1% of k9</div>
            </div>
          </div>
          <span className="text-gray-600 group-hover:text-orange-400 transition-colors">→</span>
        </button>
        </>}
        {tab === 'trade' && <>
        {/* Event */}
        <EventHeader event={event} />

        {/* BTC Price Bar */}
        <BTCBar btc={btc} />

        {/* Compact price tracker link */}
        <button
          onClick={() => setTab('prices')}
          className="w-full flex items-center justify-between bg-gray-900 border border-gray-800 hover:border-gray-700 rounded-lg px-4 py-2 transition-colors group text-xs font-mono"
        >
          <span className="text-gray-500">BTC <span className="text-white font-bold">${btc.current ? btc.current.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) : '—'}</span></span>
          {btc.start != null && btc.current != null && (
            <span className={`${btc.current >= btc.start ? 'text-green-400' : 'text-red-400'}`}>
              {btc.current >= btc.start ? '+' : ''}{(btc.current - btc.start).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
            </span>
          )}
          <span className="text-gray-600 group-hover:text-orange-400 transition-colors">📈 Price History →</span>
        </button>

        {/* Live Prices */}
        <PricePanel prices={prices} />

        {/* Threshold to increase expected ROI */}
        {prices?.upPrice != null && prices?.downPrice != null && totalCost > 0 && (
          <div className="rounded-lg border border-green-800/50 bg-green-950/20 px-4 py-2 flex items-center justify-between text-xs">
            <span className="text-gray-400">Buy below to increase expected ROI:</span>
            <span className="font-mono">
              <span className="text-green-400">UP {(prices.upPrice / (1 + expectedROI) * 100).toFixed(1)}¢</span>
              <span className="text-gray-600 mx-2">|</span>
              <span className="text-red-400">DN {(prices.downPrice / (1 + expectedROI) * 100).toFixed(1)}¢</span>
            </span>
          </div>
        )}

        {/* Buy Panels */}
        <div className="grid grid-cols-2 gap-3">
          <BuyPanel
            side="up"
            price={prices.upPrice}
            amounts={AMOUNTS}
            buying={buying}
            onBuy={handleBuy}
            onRewardsBuy={handleRewardsBuy}
            onRewardsSell={handleRewardsSell}
            onSuperRewards={handleSuperRewards}
            onSuperSell={handleSuperSell}
            onSell={handleSell}
            onSellAll={handleSellAll}
            holdings={holdings}
            tokenId={prices.tokenUp}
            expectedROI={expectedROI}
          />
          <BuyPanel
            side="down"
            price={prices.downPrice}
            amounts={AMOUNTS}
            buying={buying}
            onBuy={handleBuy}
            onRewardsBuy={handleRewardsBuy}
            onRewardsSell={handleRewardsSell}
            onSuperRewards={handleSuperRewards}
            onSuperSell={handleSuperSell}
            onSell={handleSell}
            onSellAll={handleSellAll}
            holdings={holdings}
            tokenId={prices.tokenDown}
            expectedROI={expectedROI}
          />
        </div>

        {/* Buy/Sell Both */}
        <div className="grid grid-cols-2 gap-3">
          <button
            disabled={buying === 'buy-both' || !prices.upPrice || !prices.downPrice}
            onClick={handleBuyBoth}
            className={`py-2 rounded-lg text-sm font-bold transition-all ${
              buying === 'buy-both' ? 'opacity-50 cursor-wait' : ''
            } bg-blue-700/40 hover:bg-blue-600/40 border border-blue-500/40 text-blue-300 disabled:opacity-30`}
          >
            {buying === 'buy-both' ? '...' : 'Buy Both 10 (-1¢)'}
          </button>
          <button
            disabled={buying === 'sell-both' || !prices.upPrice || !prices.downPrice}
            onClick={handleSellBoth}
            className={`py-2 rounded-lg text-sm font-bold transition-all ${
              buying === 'sell-both' ? 'opacity-50 cursor-wait' : ''
            } bg-purple-700/40 hover:bg-purple-600/40 border border-purple-500/40 text-purple-300 disabled:opacity-30`}
          >
            {buying === 'sell-both' ? '...' : 'Sell Both 10 (+1¢)'}
          </button>
          <button
            disabled={buying === 'buy-then-sell-both' || !prices.upPrice || !prices.downPrice}
            onClick={handleBuyThenSellBoth}
            className={`col-span-2 py-2 rounded-lg text-sm font-bold transition-all ${
              buying === 'buy-then-sell-both' ? 'opacity-50 cursor-wait' : ''
            } bg-cyan-700/40 hover:bg-cyan-600/40 border border-cyan-500/40 text-cyan-300 disabled:opacity-30`}
          >
            {buying === 'buy-then-sell-both' ? '...' : 'Buy 10 Both @ p-1¢ → Sell @ p+1¢ when filled'}
          </button>
        </div>

        {/* Pending Sells (limit sells resting on book) */}
        {(() => {
          const pendingSells = openOrders.filter(o => {
            const aid = o.asset_id ?? o.asset;
            return o.side === 'SELL' && (aid === prices.tokenUp || aid === prices.tokenDown);
          });
          return pendingSells.length > 0 ? (
            <div className="rounded-xl border border-yellow-800/50 bg-yellow-950/20 p-4 space-y-2">
              <h3 className="font-bold text-sm text-yellow-400">Pending Sells ({pendingSells.length})</h3>
              <div className="space-y-1">
                {pendingSells.map(o => {
                  const aid = o.asset_id ?? o.asset;
                  const side = aid === prices.tokenUp ? 'up' : 'down';
                  const curPrice = side === 'up' ? prices.upPrice : prices.downPrice;
                  const targetPrice = parseFloat(o.price || 0);
                  const total = parseFloat(o.original_size || 0);
                  const filled = parseFloat(o.size_matched || 0);
                  const remaining = total - filled;
                  const diff = curPrice != null ? (targetPrice - curPrice) : null;
                  const sideColor = side === 'up' ? 'text-green-400' : 'text-red-400';
                  return (
                    <div key={o.id} className="flex items-center justify-between text-xs">
                      <div className="flex items-center gap-2 font-mono flex-wrap">
                        <span className="font-bold text-yellow-400">SELL</span>
                        <span className={`font-bold ${sideColor}`}>{side.toUpperCase()}</span>
                        <span className="text-gray-300">{(targetPrice * 100).toFixed(1)}¢</span>
                        <span className="text-gray-500">{remaining.toFixed(1)} sh</span>
                        {diff != null && (
                          <span className={`text-[10px] ${diff <= 0 ? 'text-green-400' : 'text-orange-400'}`}>
                            {diff <= 0 ? 'READY' : `${(diff * 100).toFixed(1)}¢ away`}
                          </span>
                        )}
                      </div>
                      <button onClick={() => handleCancelOrder(o.id)}
                        className="px-2 py-0.5 rounded text-[10px] font-bold bg-gray-800 hover:bg-red-900 text-gray-400 hover:text-red-300 transition-colors">
                        Cancel
                      </button>
                    </div>
                  );
                })}
              </div>
            </div>
          ) : null;
        })()}

        {/* Open Orders */}
        {openOrders.length > 0 && (
          <div className="rounded-xl border border-blue-800/50 bg-blue-950/20 p-4 space-y-2">
            <div className="flex items-center justify-between">
              <h3 className="font-bold text-sm text-blue-400">Open Orders ({openOrders.length})</h3>
              <button onClick={handleCancelAll}
                className="px-2 py-1 rounded text-[10px] font-bold bg-gray-800 hover:bg-red-900 text-gray-400 hover:text-red-300 transition-colors">
                Cancel All
              </button>
            </div>
            <div className="space-y-1">
              {openOrders.map(o => {
                const assetId = o.asset_id ?? o.asset;
                const oSide = assetId === prices.tokenUp ? 'UP' : assetId === prices.tokenDown ? 'DN' : /up|yes/i.test(o.outcome || '') ? 'UP' : 'DN';
                const isSell = o.side === 'SELL';
                const sideColor = oSide === 'UP' ? 'text-green-400' : 'text-red-400';
                const filled = parseFloat(o.size_matched || 0);
                const total = parseFloat(o.original_size || 0);
                return (
                  <div key={o.id} className="flex items-center justify-between text-xs">
                    <div className="flex items-center gap-2 font-mono">
                      <span className={`font-bold ${isSell ? 'text-yellow-400' : sideColor}`}>{isSell ? 'SELL' : 'BUY'}</span>
                      <span className={`font-bold ${sideColor}`}>{oSide}</span>
                      <span className="text-gray-300">{(parseFloat(o.price) * 100).toFixed(1)}¢</span>
                      <span className="text-gray-500">{total.toFixed(1)} sh</span>
                      {filled > 0 && <span className="text-blue-400">({filled.toFixed(1)} filled)</span>}
                    </div>
                    <button onClick={() => handleCancelOrder(o.id)}
                      className="px-2 py-0.5 rounded text-[10px] font-bold bg-gray-800 hover:bg-red-900 text-gray-400 hover:text-red-300 transition-colors">
                      Cancel
                    </button>
                  </div>
                );
              })}
            </div>
          </div>
        )}

        {/* Positions — Polymarket API when available, else derive from orders */}
        <Positions
          positions={positions}
          eventSlug={event?.slug}
          fallbackOrders={eventOrders}
          prices={prices}
          onSell={handleSell}
          selling={buying}
        />

        {/* Orders */}
        <OrderHistory orders={eventOrders} prices={prices} />

        {/* Toast */}
        <OrderToast toast={toast} onDismiss={() => setToast(null)} />
        </>}
      </div>
    </div>
  );
}
