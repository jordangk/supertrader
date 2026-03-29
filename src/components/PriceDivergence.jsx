import React, { useState, useEffect, useRef, useMemo } from 'react';
import {
  ComposedChart, Line, XAxis, YAxis, CartesianGrid, Tooltip,
  ResponsiveContainer, ReferenceLine, ReferenceDot, Area, Bar, Cell,
} from 'recharts';

const API_BASE = (import.meta.env.VITE_API_URL || '').replace(/\/$/, '');

/** Slugs like eth-updown-15m-1739123456 → market window start (ms). */
function parseEventStartMsFromSlug(slug) {
  if (!slug || typeof slug !== 'string') return null;
  const m = slug.match(/-(\d{9,})$/);
  if (!m) return null;
  return parseInt(m[1], 10) * 1000;
}

export default function PriceDivergence({ prices, btc, binanceBtc, serverEma: sEma, priceEma, event, autoEmaLog = [], mode = 'btc' }) {
  const [history, setHistory] = useState([]);
  const [live, setLive] = useState({ btc: null, up: null, down: null, upStart: null, downStart: null, btcStart: null, slug: null, endDate: null, title: null });
  const [btcOpen, setBtcOpen] = useState(null); // captured at event start, client-side
  const [upOpen, setUpOpen] = useState(null);
  const [downOpen, setDownOpen] = useState(null);
  const [tick, setTick] = useState(0);
  const [buyStatus, setBuyStatus] = useState(null); // { side, msg, ok }
  const [pos, setPos] = useState({ up: null, down: null }); // positions from Polymarket
  const [openOrders, setOpenOrders] = useState([]); // pending limit orders
  const [chartWindowS, setChartWindowS] = useState(180); // chart zoom in seconds
  const [myTradesForEvent, setMyTradesForEvent] = useState([]);
  const [stopLoss, setStopLoss] = useState(null); // { side: 'up'|'down', trigger: cents, shares }
  const stopLossRef = useRef(null); // keep in sync for poll callback
  const [slTrigger, setSlTrigger] = useState('');
  const [slShares, setSlShares] = useState('5');
  const lastSlug = useRef(null);
  const openLockedForSlug = useRef(null); // once set, opens don't change until next slug
  const waitingForHistory = useRef(false); // block live capture until history fetch resolves
  const pricesRef = useRef(prices); // keep latest ethPrices accessible inside poll closure
  const ethLastPolyRef = useRef({ up: null, down: null }); // WS + DB + sessionStorage — survives refresh
  const eventRef = useRef(event);
  const sEmaRef = useRef(sEma);
  pricesRef.current = prices;
  eventRef.current = event;
  sEmaRef.current = sEma;

  // Hydrate last Polymarket up/down from session + latest DB row (so chart / header work before WS reconnects)
  useEffect(() => {
    if (mode !== 'eth') return;
    const slug = event?.slug || live.slug;
    if (!slug) return;
    try {
      const raw = sessionStorage.getItem(`ethPoly:${slug}`);
      if (raw) {
        const p = JSON.parse(raw);
        ethLastPolyRef.current = { up: p.up ?? null, down: p.down ?? null };
      }
    } catch {}
    fetch(`${API_BASE}/api/eth-latest-snapshot?slug=${encodeURIComponent(slug)}`)
      .then(r => r.json())
      .then(d => {
        if (d.up != null || d.down != null) {
          ethLastPolyRef.current = {
            up: d.up != null ? d.up : ethLastPolyRef.current?.up,
            down: d.down != null ? d.down : ethLastPolyRef.current?.down,
          };
          try {
            sessionStorage.setItem(`ethPoly:${slug}`, JSON.stringify(ethLastPolyRef.current));
          } catch {}
        }
      })
      .catch(() => {});
  }, [mode, event?.slug, live.slug]);

  // Load stop-loss config from server on mount (persisted across refresh)
  useEffect(() => {
    fetch(`${API_BASE}/api/stop-loss-config`).then(r => r.json()).then(d => {
      if (d.armed) {
        const sl = { side: d.side, trigger: d.trigger, shares: d.shares };
        setStopLoss(sl);
        stopLossRef.current = sl;
      }
    }).catch(() => {});
  }, []);

  // On mount + at every 5m boundary, refresh the event (send fresh Binance price)
  useEffect(() => {
    const refresh = async () => {
      try {
        const bin = await fetch('https://api.binance.com/api/v3/ticker/price?symbol=BTCUSDT').then(r => r.json()).catch(() => null);
        const btcOpen = bin?.price ? parseFloat(bin.price) : null;
        await fetch(`${API_BASE}/api/event/refresh`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ btcOpen }),
        });
      } catch {}
    };
    refresh();
    // Schedule refresh 2s after next 5m boundary, then repeat
    const scheduleNext = () => {
      const now = Math.floor(Date.now() / 1000);
      const nextSlot = (Math.floor(now / 300) + 1) * 300;
      const delay = (nextSlot - now) * 1000 + 2000; // 2s after boundary
      return setTimeout(() => {
        refresh();
        // Schedule the next one
        timerRef.current = scheduleNext();
      }, delay);
    };
    const timerRef = { current: scheduleNext() };
    return () => clearTimeout(timerRef.current);
  }, []);

  // Seed history on mount (re-run when ETH event slug appears from WS)
  useEffect(() => {
    if (mode === 'eth') {
      const qs = event?.slug ? `slug=${encodeURIComponent(event.slug)}&` : '';
      // ETH mode: fetch DB snapshots + both klines in parallel
      Promise.all([
        fetch(`${API_BASE}/api/eth-price-history?${qs}limit=1000`).then(r => r.json()).catch(() => ({ snapshots: [] })),
        fetch('https://api.binance.com/api/v3/klines?symbol=BTCUSDT&interval=1s&limit=900').then(r => r.json()).catch(() => []),
        fetch('https://api.binance.com/api/v3/klines?symbol=ETHUSDT&interval=1s&limit=900').then(r => r.json()).catch(() => []),
      ]).then(([d, btcKlines, ethKlines]) => {
        if (!Array.isArray(btcKlines)) return;
        // Build kline seed with both BTC + ETH
        const ethKlineMap = {};
        if (Array.isArray(ethKlines)) {
          for (const k of ethKlines) ethKlineMap[k[0]] = parseFloat(k[4]);
        }
        const klineSeed = btcKlines.map(k => ({
          t: k[0], btc: parseFloat(k[4]), eth: ethKlineMap[k[0]] ?? null, up: null, down: null,
        }));
        // Build DB snapshots with BTC merged from klines
        const btcArr = btcKlines.map(k => ({ t: k[0], btc: parseFloat(k[4]) }));
        const dbSnaps = (d.snapshots || []).map(s => {
          const t = new Date(s.observed_at.endsWith('Z') ? s.observed_at : s.observed_at + 'Z').getTime();
          let bestBtc = null, bestDist = Infinity;
          for (const k of btcArr) {
            const dist = Math.abs(k.t - t);
            if (dist < bestDist) { bestDist = dist; bestBtc = k.btc; }
            if (k.t > t) break;
          }
          if (bestDist > 2000) bestBtc = null;
          return {
            t, eth: s.eth_price != null ? parseFloat(s.eth_price) : null,
            up: s.up_cost != null ? parseFloat(s.up_cost) : null,
            down: s.down_cost != null ? parseFloat(s.down_cost) : null,
            secsLeft: s.seconds_left, btc: bestBtc,
          };
        });
        // Forward-fill BTC in DB snaps
        let lastBtc = null;
        for (const s of dbSnaps) { if (s.btc != null) lastBtc = s.btc; else s.btc = lastBtc; }
        // Merge: kline seed + DB snapshots (DB overwrites overlapping time range)
        let merged;
        if (dbSnaps.length > 0) {
          const firstDbT = dbSnaps[0].t;
          const lastDbT = dbSnaps[dbSnaps.length - 1].t;
          const older = klineSeed.filter(k => k.t < firstDbT);
          const newer = klineSeed.filter(k => k.t > lastDbT);
          merged = [...older, ...dbSnaps, ...newer];
        } else {
          merged = klineSeed;
        }
        // Back-fill + forward-fill up/down/eth
        let fUp = null, fDown = null, fEth = null;
        for (const h of merged) {
          if (fUp == null && h.up != null) fUp = h.up;
          if (fDown == null && h.down != null) fDown = h.down;
          if (fEth == null && h.eth != null) fEth = h.eth;
          if (fUp != null && fDown != null && fEth != null) break;
        }
        for (const h of merged) { if (h.up == null) h.up = fUp; else break; }
        for (const h of merged) { if (h.down == null) h.down = fDown; else break; }
        for (const h of merged) { if (h.eth == null) h.eth = fEth; else break; }
        let lUp = null, lDown = null, lEth = null;
        for (const h of merged) {
          if (h.up != null) lUp = h.up; else h.up = lUp;
          if (h.down != null) lDown = h.down; else h.down = lDown;
          if (h.eth != null) lEth = h.eth; else h.eth = lEth;
        }
        const t0ms = parseEventStartMsFromSlug(event?.slug);
        if (t0ms != null) merged = merged.filter(h => h.t >= t0ms);
        setHistory(merged.length > 1000 ? merged.slice(-1000) : merged);
        const firstBtc = merged.find(h => h.btc != null);
        if (firstBtc) setBtcOpen(firstBtc.btc);
        const lastPoly = [...merged].reverse().find(h => h.up != null || h.down != null);
        if (lastPoly && event?.slug) {
          ethLastPolyRef.current = { up: lastPoly.up ?? null, down: lastPoly.down ?? null };
          try {
            sessionStorage.setItem(`ethPoly:${event.slug}`, JSON.stringify(ethLastPolyRef.current));
          } catch {}
        }
      });
    } else {
      // BTC mode: just kline seed
      fetch('https://api.binance.com/api/v3/klines?symbol=BTCUSDT&interval=1s&limit=900')
        .then(r => r.json())
        .then(klines => {
          if (!Array.isArray(klines)) return;
          const seed = klines.map(k => ({ t: k[0], btc: parseFloat(k[4]), up: null, down: null }));
          setHistory(prev => prev.length > 0 ? prev : seed);
        })
        .catch(() => {});
    }
  }, [mode, event?.slug]);

  // Poll /api/event + Binance REST every 1s
  useEffect(() => {
    let active = true;
    const poll = async () => {
      try {
        const fetches = [
          fetch(`${API_BASE}/api/event`).then(r => r.json()).catch(() => null),
          fetch('https://api.binance.com/api/v3/ticker/price?symbol=BTCUSDT').then(r => r.json()).catch(() => null),
        ];
        if (mode === 'eth') {
          fetches.push(fetch('https://api.binance.com/api/v3/ticker/price?symbol=ETHUSDT').then(r => r.json()).catch(() => null));
          // Same liveStateEth as WS — REST fallback when eth_prices messages lag or miss
          fetches.push(fetch(`${API_BASE}/api/eth-state`).then(r => r.json()).catch(() => null));
        }
        const [eventRes, binanceRes, ethBinanceRes, ethStateRes] = await Promise.all(fetches);
        if (!active) return;
        const ls = eventRes?.liveState || {};
        const ev = eventRes?.event || {};
        const op = eventRes?.openPrice || {};
        const liveBinance = binanceRes?.price ? parseFloat(binanceRes.price) : null;
        const btcPrice = liveBinance || (ls.binanceBtc ? parseFloat(ls.binanceBtc) : null) || (ls.btcCurrent ? parseFloat(ls.btcCurrent) : null);
        const up = ls.upPrice != null ? parseFloat(ls.upPrice) : null;
        const down = ls.downPrice != null ? parseFloat(ls.downPrice) : null;
        let histUp;
        let histDown;
        if (mode === 'eth') {
          // ETH: BTC from poll; Up/Down from WS → REST liveState → cached DB/session → last history point
          const p = pricesRef.current;
          const srv = ethStateRes?.prices;
          const ev2 = eventRef.current;
          const ethUp = (p?.upPrice != null ? parseFloat(p.upPrice) : null)
            ?? (srv?.upPrice != null ? parseFloat(srv.upPrice) : null)
            ?? (ethLastPolyRef.current?.up != null ? ethLastPolyRef.current.up : null);
          const ethDown = (p?.downPrice != null ? parseFloat(p.downPrice) : null)
            ?? (srv?.downPrice != null ? parseFloat(srv.downPrice) : null)
            ?? (ethLastPolyRef.current?.down != null ? ethLastPolyRef.current.down : null);
          if (ethUp != null || ethDown != null) {
            ethLastPolyRef.current = {
              up: ethUp ?? ethLastPolyRef.current?.up ?? null,
              down: ethDown ?? ethLastPolyRef.current?.down ?? null,
            };
            const slug = ev2?.slug;
            if (slug) {
              try {
                sessionStorage.setItem(`ethPoly:${slug}`, JSON.stringify(ethLastPolyRef.current));
              } catch {}
            }
          }
          histUp = ethUp;
          histDown = ethDown;
          setLive(prev => ({
            ...prev,
            btc: btcPrice,
            up: ethUp ?? prev.up,
            down: ethDown ?? prev.down,
            upStart: (p?.upStartPrice != null ? parseFloat(p.upStartPrice) : null)
              ?? (srv?.upStartPrice != null ? parseFloat(srv.upStartPrice) : prev.upStart),
            downStart: (p?.downStartPrice != null ? parseFloat(p.downStartPrice) : null)
              ?? (srv?.downStartPrice != null ? parseFloat(srv.downStartPrice) : prev.downStart),
            btcStart: ls.btcStart != null ? parseFloat(ls.btcStart) : prev.btcStart,
            slug: ev2?.slug || prev.slug,
            endDate: ev2?.endDate || prev.endDate,
            title: ev2?.title || prev.title,
            tokenUp: ev2?.tokenUp || prev.tokenUp,
            tokenDown: ev2?.tokenDown || prev.tokenDown,
          }));
        } else {
          histUp = up;
          histDown = down;
          setLive({
            btc: btcPrice,
            up,
            down,
            upStart: ls.upStartPrice != null ? parseFloat(ls.upStartPrice) : null,
            downStart: ls.downStartPrice != null ? parseFloat(ls.downStartPrice) : null,
            btcStart: ls.btcStart != null ? parseFloat(ls.btcStart) : null,
            dbOpenBtc: op.btc || null, // authoritative open from DB
            dbOpenUp: op.up,
            dbOpenDown: op.down,
            slug: ls.eventSlug || ev.slug,
            endDate: ev.endDate,
            title: ev.title || ls.eventTitle,
            tokenUp: ls.tokenUp || ev.tokenUp || null,
            tokenDown: ls.tokenDown || ev.tokenDown || null,
          });
        }
        // Sync stop-loss state from server (monitored server-side, survives refresh)
        const slServer = eventRes?.stopLoss;
        if (slServer) {
          if (slServer.armed && !stopLossRef.current) {
            const sl = { side: slServer.side, trigger: slServer.trigger, shares: slServer.shares };
            setStopLoss(sl);
            stopLossRef.current = sl;
          } else if (!slServer.armed && stopLossRef.current) {
            setStopLoss(null);
            stopLossRef.current = null;
          }
        }
        // Accumulate history — histUp/histDown set above (ETH includes cached/DB snapshot)
        const se = sEmaRef.current;
        const ethPrice = ethBinanceRes?.price ? parseFloat(ethBinanceRes.price) : null;
        if (btcPrice || histUp || histDown) {
          setHistory(prev => {
            const last = prev[prev.length - 1];
            const u = mode === 'eth' ? (histUp ?? last?.up ?? null) : histUp;
            const d = mode === 'eth' ? (histDown ?? last?.down ?? null) : histDown;
            const next = [...prev, { t: Date.now(), btc: btcPrice, eth: ethPrice, up: u, down: d, sE12: se?.e12 ?? null, sE26: se?.e26 ?? null }];
            return next.length > 1000 ? next.slice(-1000) : next;
          });
        }
        // tick counter removed — setLive/setHistory already trigger re-renders
      } catch {}
    };
    poll();
    const iv = setInterval(poll, 500);
    return () => { active = false; clearInterval(iv); };
  }, []);

  // ETH mode: also capture when ethPrices prop changes between polls
  useEffect(() => {
    if (mode !== 'eth') return;
    const up = prices?.upPrice != null ? parseFloat(prices.upPrice) : null;
    const down = prices?.downPrice != null ? parseFloat(prices.downPrice) : null;
    if (up == null && down == null) return;
    ethLastPolyRef.current = {
      up: up ?? ethLastPolyRef.current?.up ?? null,
      down: down ?? ethLastPolyRef.current?.down ?? null,
    };
    const slug = event?.slug || live.slug;
    if (slug) {
      try {
        sessionStorage.setItem(`ethPoly:${slug}`, JSON.stringify(ethLastPolyRef.current));
      } catch {}
    }
    setLive(prev => ({ ...prev, up: up ?? prev.up, down: down ?? prev.down }));
  }, [mode, prices?.upPrice, prices?.downPrice, event?.slug, live.slug]);

  // When event slug changes: reset history, unlock opens for new capture
  useEffect(() => {
    if (live.slug && live.slug !== lastSlug.current) {
      lastSlug.current = live.slug;
      openLockedForSlug.current = null; // unlock so next tick captures opens
      setBtcOpen(null);
      setUpOpen(null);
      setDownOpen(null);
      waitingForHistory.current = true;
      // Keep history across events so chart always has BTC data to show
      const slug = live.slug;

      if (mode === 'eth') {
        // Fetch ETH snapshots + BTC klines in parallel, merge by nearest timestamp
        Promise.all([
          fetch(`${API_BASE}/api/eth-price-history?slug=${slug}&limit=1000`).then(r => r.json()).catch(() => ({ snapshots: [] })),
          fetch('https://api.binance.com/api/v3/klines?symbol=BTCUSDT&interval=1s&limit=900').then(r => r.json()).catch(() => []),
        ]).then(([d, klines]) => {
          const btcArr = Array.isArray(klines) ? klines.map(k => ({ t: k[0], btc: parseFloat(k[4]) })) : [];
          const snaps = (d.snapshots || []).map(s => {
            const t = new Date(s.observed_at.endsWith('Z') ? s.observed_at : s.observed_at + 'Z').getTime();
            // Find nearest BTC kline within 2s
            let bestBtc = null, bestDist = Infinity;
            for (const k of btcArr) {
              const dist = Math.abs(k.t - t);
              if (dist < bestDist) { bestDist = dist; bestBtc = k.btc; }
              if (k.t > t) break; // klines are sorted, stop early
            }
            if (bestDist > 2000) bestBtc = null;
            return {
              t,
              eth: s.eth_price != null ? parseFloat(s.eth_price) : null,
              up: s.up_cost != null ? parseFloat(s.up_cost) : null,
              down: s.down_cost != null ? parseFloat(s.down_cost) : null,
              secsLeft: s.seconds_left,
              btc: bestBtc,
            };
          });
          // Fill remaining gaps: forward-fill BTC from klines
          if (snaps.length > 0 && btcArr.length > 0) {
            let lastBtc = null;
            for (const s of snaps) {
              if (s.btc != null) lastBtc = s.btc;
              else if (lastBtc != null) s.btc = lastBtc;
            }
          }
          // Set BTC open from first entry with BTC data
          const firstBtc = snaps.find(s => s.btc != null);
          if (firstBtc && !btcOpen) setBtcOpen(firstBtc.btc);
          waitingForHistory.current = false;
          if (snaps.length === 0) return;
          setHistory(prev => {
            const firstSnapT = snaps[0].t;
            const lastSnapT = snaps[snaps.length - 1].t;
            const older = prev.filter(p => p.t < firstSnapT);
            const newer = prev.filter(p => p.t > lastSnapT);
            const merged = [...older, ...snaps, ...newer];
            // Back-fill then forward-fill so ALL entries have up/down/eth
            // Back-fill: entries before first DB snapshot get the earliest known value
            let firstUp = null, firstDown = null, firstEth = null;
            for (const h of merged) {
              if (firstUp == null && h.up != null) firstUp = h.up;
              if (firstDown == null && h.down != null) firstDown = h.down;
              if (firstEth == null && h.eth != null) firstEth = h.eth;
              if (firstUp != null && firstDown != null && firstEth != null) break;
            }
            for (const h of merged) {
              if (h.up == null) h.up = firstUp; else break;
            }
            for (const h of merged) {
              if (h.down == null) h.down = firstDown; else break;
            }
            for (const h of merged) {
              if (h.eth == null) h.eth = firstEth; else break;
            }
            // Forward-fill: entries after DB gaps get last known value
            let lastUp = null, lastDown = null, lastEth = null;
            for (const h of merged) {
              if (h.up != null) lastUp = h.up; else h.up = lastUp;
              if (h.down != null) lastDown = h.down; else h.down = lastDown;
              if (h.eth != null) lastEth = h.eth; else h.eth = lastEth;
            }
            const t0ms = parseEventStartMsFromSlug(slug);
            if (t0ms != null) merged = merged.filter(h => h.t >= t0ms);
            const lastPoly = [...merged].reverse().find(h => h.up != null || h.down != null);
            if (lastPoly) {
              ethLastPolyRef.current = { up: lastPoly.up ?? null, down: lastPoly.down ?? null };
              try {
                sessionStorage.setItem(`ethPoly:${slug}`, JSON.stringify(ethLastPolyRef.current));
              } catch {}
            }
            return merged.length > 1000 ? merged.slice(-1000) : merged;
          });
        }).catch(() => { waitingForHistory.current = false; });
      } else {
        // Fetch BTC historical snapshots — open price comes from DB (first snapshot)
        fetch(`${API_BASE}/api/price-history?slug=${slug}&limit=1000`)
          .then(r => r.json())
          .then(d => {
            const snaps = (d.snapshots || []).map(s => ({
              t: new Date(s.observed_at.endsWith('Z') ? s.observed_at : s.observed_at + 'Z').getTime(),
              btc: parseFloat(s.coin_price) || parseFloat(s.btc_price) || null,
              up: s.up_cost != null ? parseFloat(s.up_cost) : null,
              down: s.down_cost != null ? parseFloat(s.down_cost) : null,
              secsLeft: s.seconds_left,
            }));
            // Filter out stale snapshots (btc way off from live price)
            const refBtc = live.btc || (snaps.length > 0 ? snaps[snaps.length - 1]?.btc : null);
            const saneSnaps = refBtc
              ? snaps.filter(s => !s.btc || Math.abs(s.btc - refBtc) / refBtc < 0.005)
              : snaps;
            // Use first sane historical tick as open
            const firstSane = saneSnaps.find(s => s.btc);
            if (openLockedForSlug.current !== slug && firstSane && live.btc) {
              const sane = Math.abs(firstSane.btc - live.btc) / live.btc < 0.005;
              if (sane) {
                setBtcOpen(firstSane.btc);
                if (firstSane.up != null) setUpOpen(firstSane.up);
                if (firstSane.down != null) setDownOpen(firstSane.down);
                openLockedForSlug.current = slug;
              }
            }
            waitingForHistory.current = false; // allow live capture fallback if no history
            // Merge: keep old history + new event snapshots + live ticks
            setHistory(prev => {
              if (saneSnaps.length === 0) return prev;
              const firstSnapT = saneSnaps[0].t;
              const lastSnapT = saneSnaps[saneSnaps.length - 1].t;
              const older = prev.filter(p => p.t < firstSnapT);
              const newer = prev.filter(p => p.t > lastSnapT);
              const merged = [...older, ...saneSnaps, ...newer];
              // Back-fill: kline entries before first DB snapshot get earliest known price
              let firstUp = null, firstDown = null;
              for (const h of merged) {
                if (firstUp == null && h.up != null) firstUp = h.up;
                if (firstDown == null && h.down != null) firstDown = h.down;
                if (firstUp != null && firstDown != null) break;
              }
              for (const h of merged) { if (h.up == null) h.up = firstUp; else break; }
              for (const h of merged) { if (h.down == null) h.down = firstDown; else break; }
              // Forward-fill: entries after DB gaps get last known value
              let lastUp = null, lastDown = null;
              for (const h of merged) {
                if (h.up != null) lastUp = h.up; else h.up = lastUp;
                if (h.down != null) lastDown = h.down; else h.down = lastDown;
              }
              return merged.length > 1000 ? merged.slice(-1000) : merged;
            });
          })
          .catch(() => { waitingForHistory.current = false; });
      }
    }
  }, [live.slug]);

  // Capture opens: check localStorage first, then DB/server (if sane), then live btc
  useEffect(() => {
    if (!live.slug || openLockedForSlug.current === live.slug) return;
    if (waitingForHistory.current) return; // history fetch still in flight
    if (!live.btc) return; // need live price to validate
    const isSane = (v) => v && Math.abs(v - live.btc) / live.btc < 0.005;
    // Check localStorage for a previously saved open for this slug
    const stored = (() => {
      try {
        const raw = localStorage.getItem(`btcOpen:${live.slug}`);
        if (raw) {
          const parsed = JSON.parse(raw);
          if (isSane(parsed.btc)) return parsed;
        }
      } catch {}
      return null;
    })();
    const openBtc = stored?.btc
                  || (isSane(live.dbOpenBtc) ? live.dbOpenBtc : null)
                  || (isSane(live.btcStart) ? live.btcStart : null)
                  || live.btc;
    const openUp = stored?.up ?? live.dbOpenUp ?? live.upStart ?? live.up ?? null;
    const openDown = stored?.down ?? live.dbOpenDown ?? live.downStart ?? live.down ?? null;
    setBtcOpen(openBtc);
    setUpOpen(openUp);
    setDownOpen(openDown);
    openLockedForSlug.current = live.slug;
    // Persist to localStorage so it survives page refresh
    try {
      localStorage.setItem(`btcOpen:${live.slug}`, JSON.stringify({ btc: openBtc, up: openUp, down: openDown }));
    } catch {}
  }, [live.slug, live.dbOpenBtc, live.btcStart, live.btc]);

  // (history accumulation now happens directly in the poll callback above)

  // Fetch positions from Polymarket
  const fetchPositions = async (slug) => {
    if (!slug) return;
    try {
      const r = await fetch(`${API_BASE}/api/positions?event=${slug}`);
      const d = await r.json();
      const list = d.positions || [];
      const toNum = v => { const n = parseFloat(v); return Number.isFinite(n) ? n : 0; };
      const norm = o => (o || '').toLowerCase() === 'yes' || (o || '').toLowerCase() === 'up' ? 'up' : 'down';
      let up = null, down = null;
      for (const p of list) {
        const side = norm(p.outcome);
        const shares = toNum(p.size ?? p.shares ?? p.balance);
        const cost = toNum(p.initialValue ?? p.cost);
        const avg = toNum(p.avgPrice ?? p.averagePrice) || (shares > 0 ? cost / shares : 0);
        if (shares <= 0) continue;
        const obj = { shares, cost, avg };
        if (side === 'up') up = obj;
        else down = obj;
      }
      setPos({ up, down });
    } catch {}
  };

  // Fetch open orders from CLOB — filter to current event's tokens
  const fetchOpenOrders = async () => {
    try {
      const r = await fetch(`${API_BASE}/api/open-orders`);
      const d = await r.json();
      const all = d.orders || [];
      const tokens = new Set([live.tokenUp, live.tokenDown].filter(Boolean));
      setOpenOrders(tokens.size > 0 ? all.filter(o => tokens.has(o.asset_id || o.token_id)) : all);
    } catch {}
  };

  useEffect(() => {
    if (live.slug) {
      fetchPositions(live.slug);
      fetchOpenOrders();
    }
  }, [live.slug]);

  // Poll positions every 10s and open orders every 5s
  const prevOrderCount = useRef(0);
  useEffect(() => {
    const ordersIv = setInterval(fetchOpenOrders, 5000);
    const posIv = setInterval(() => { if (live.slug) fetchPositions(live.slug); }, 10000);
    return () => { clearInterval(ordersIv); clearInterval(posIv); };
  }, [live.slug]);
  useEffect(() => {
    if (prevOrderCount.current > 0 && openOrders.length < prevOrderCount.current) {
      // An order disappeared (filled or cancelled) — refresh positions
      fetchPositions(live.slug);
    }
    prevOrderCount.current = openOrders.length;
  }, [openOrders.length]);

  // Quick buy 5 shares at given or current price (Polymarket min limit order = 5 shares)
  const quickBuy = async (side, offsetCents = 0) => {
    const rawPrice = side === 'up' ? live.up : live.down;
    if (!rawPrice || rawPrice <= 0) {
      setBuyStatus({ side, msg: 'No price', ok: false });
      setTimeout(() => setBuyStatus(null), 2000);
      return;
    }
    const price = Math.max(0.01, Math.round((rawPrice + offsetCents / 100) * 100) / 100);
    const amount = Math.round(5 * price * 100) / 100; // 5 shares * price = USD to spend
    const label = offsetCents ? `5sh @ ${(price * 100).toFixed(0)}¢ (${offsetCents > 0 ? '+' : ''}${offsetCents}¢)` : `5sh @ ${(price * 100).toFixed(0)}¢`;
    setBuyStatus({ side, msg: `${label}...`, ok: null });
    try {
      const res = await fetch(`${API_BASE}/api/buy`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ side, amount, limitPrice: price, shares: 5 }),
      });
      const data = await res.json();
      if (res.ok) {
        setBuyStatus({ side, msg: `Sent ${label}`, ok: true });
        setTimeout(() => { fetchPositions(live.slug); fetchOpenOrders(); }, 2000);
      } else {
        setBuyStatus({ side, msg: data.error || 'Failed', ok: false });
      }
    } catch (e) {
      setBuyStatus({ side, msg: 'Error', ok: false });
    }
    setTimeout(() => setBuyStatus(null), 3000);
  };

  const quickSell = async (side, shares) => {
    const sh = shares || 5;
    setBuyStatus({ side, msg: `Sell ${sh}sh ${side}...`, ok: null });
    try {
      const res = await fetch(`${API_BASE}/api/sell`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ side, shares: sh }),
      });
      const data = await res.json();
      if (res.ok && data.success) {
        setBuyStatus({ side, msg: `Sold ${sh}sh ${side} @ ${(data.price * 100).toFixed(0)}¢`, ok: true });
        setTimeout(() => { fetchPositions(live.slug); fetchOpenOrders(); }, 2000);
      } else {
        setBuyStatus({ side, msg: data.error || 'Sell failed', ok: false });
      }
    } catch (e) {
      setBuyStatus({ side, msg: 'Sell error', ok: false });
    }
    setTimeout(() => setBuyStatus(null), 3000);
  };

  // Whale holdings — refresh on new trades + poll every 10s (use event slug when 15m)
  const [whaleHoldings, setWhaleHoldings] = useState(null);
  const slug = event?.slug;
  const fetchWhaleHoldings = () => {
    const q = slug?.includes('-15m-') ? `?slug=${encodeURIComponent(slug)}` : '';
    return fetch(`${API_BASE}/api/whale-holdings${q}`).then(r => r.json()).then(setWhaleHoldings).catch(() => {});
  };
  useEffect(() => {
    fetchWhaleHoldings();
    const iv = setInterval(fetchWhaleHoldings, 10000);
    return () => clearInterval(iv);
  }, [slug]);

  // Fetch my trades from Polymarket (on-chain, your wallet) for chart markers
  useEffect(() => {
    if (!event?.slug) { setMyTradesForEvent([]); return; }
    const params = new URLSearchParams({ slug: event.slug });
    if (event.tokenUp) params.set('tokenUp', event.tokenUp);
    if (event.tokenDown) params.set('tokenDown', event.tokenDown);
    const fetchMy = () =>
      fetch(`${API_BASE}/api/my-trades?${params}`)
        .then(r => r.json())
        .then(d => setMyTradesForEvent(d.trades || []))
        .catch(() => setMyTradesForEvent([]));
    fetchMy();
    const iv = setInterval(fetchMy, 10000); // refresh every 10s
    return () => clearInterval(iv);
  }, [event?.slug, event?.tokenUp, event?.tokenDown]);

  // Scalp: FAK buy at ask+1¢ + GTC sell at buy+profitCents (same side, sent together)
  const scalp = async (side, profitCents = 2) => {
    const rawPrice = side === 'up' ? live.up : live.down;
    if (!rawPrice || rawPrice <= 0) {
      setBuyStatus({ side, msg: 'No price', ok: false });
      setTimeout(() => setBuyStatus(null), 2000);
      return;
    }
    setBuyStatus({ side, msg: `Scalp +${profitCents}¢: buy @ mkt+1¢, sell @ +${profitCents}¢...`, ok: null });
    try {
      const res = await fetch(`${API_BASE}/api/scalp`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ side, shares: 5, profitCents }),
      });
      const text = await res.text();
      let data;
      try {
        data = JSON.parse(text);
      } catch (_) {
        setBuyStatus({ side, msg: (text && text.length < 80 ? text : null) || `HTTP ${res.status}`, ok: false });
        setTimeout(() => setBuyStatus(null), 4000);
        return;
      }
      if (res.ok && data.success) {
        setBuyStatus({ side, msg: `Scalp +${profitCents}¢ sent: buy @${((data.buy?.price ?? 0) * 100).toFixed(0)}¢ → sell @${((data.sell?.price ?? 0) * 100).toFixed(0)}¢ (5sh)`, ok: true });
        setTimeout(fetchOpenOrders, 500);
        setTimeout(fetchOpenOrders, 1500);
      } else {
        setBuyStatus({ side, msg: data.error || 'Scalp failed', ok: false });
      }
    } catch (e) {
      setBuyStatus({ side, msg: e?.message || 'Scalp error', ok: false });
    }
    setTimeout(() => setBuyStatus(null), 3000);
  };

  // Derived
  const openPrice = btcOpen;
  const currentBtc = live.btc;
  const btcChange = openPrice && currentBtc ? currentBtc - openPrice : null;
  const btcChangePct = openPrice && currentBtc ? ((currentBtc - openPrice) / openPrice) * 100 : null;

  // Format Up/Down as cents: "54.0¢" or "$0.54"
  const fmtCents = (v) => v != null ? `${(v * 100).toFixed(1)}¢` : '—';

  // Time left
  const endDate = live.endDate ? new Date(live.endDate) : null;
  const secsLeft = endDate ? Math.max(0, Math.floor((endDate - Date.now()) / 1000)) : null;
  const expired = secsLeft != null && secsLeft <= 0;
  const timeStr = secsLeft != null
    ? expired ? 'EXPIRED' : `${Math.floor(secsLeft / 60)}:${String(secsLeft % 60).padStart(2, '0')}`
    : '—';

  // Chart data + indicators — memoized to avoid recomputing every render
  const { chartData, lastSignal, speed } = useMemo(() => {
    const slugForEth = event?.slug || live.slug;
    const eventStartMs = mode === 'eth' ? parseEventStartMsFromSlug(slugForEth) : null;

    let pool = history;
    if (eventStartMs != null) pool = history.filter(h => h.t >= eventStartMs);

    const lastT = pool.length > 0 ? pool[pool.length - 1].t : 0;
    // ETH: keep rows that only have Polymarket up/down (DB often has poly before kline match fills btc/eth)
    const windowed = pool.filter(h => {
      const inWin = (lastT - h.t) / 1000 <= chartWindowS;
      if (!inWin) return false;
      if (mode !== 'eth') return (h.btc != null || h.eth != null);
      return h.btc != null || h.eth != null || h.up != null || h.down != null;
    });

    const t0 = eventStartMs != null
      ? eventStartMs
      : (windowed.length > 0 ? windowed[0].t : Date.now());

    const btcAnchor = eventStartMs != null
      ? (pool.find(h => h.t >= eventStartMs && h.btc != null)?.btc ?? openPrice)
      : openPrice;

    const ethOpen = mode === 'eth'
      ? (eventStartMs != null
          ? (pool.find(h => h.t >= eventStartMs && h.eth != null)?.eth ?? null)
          : (history.find(h => h.eth != null)?.eth ?? null))
      : null;

    const data = windowed.map((h, i) => ({
      idx: i,
      elapsed: Math.round((h.t - t0) / 1000),
      btcDelta: btcAnchor && h.btc ? ((h.btc - btcAnchor) / btcAnchor) * 100 : null,
      ethDelta: ethOpen && h.eth ? ((h.eth - ethOpen) / ethOpen) * 100 : null,
      pctSpread: (btcAnchor && h.btc && ethOpen && h.eth)
        ? (((h.eth - ethOpen) / ethOpen) - ((h.btc - btcAnchor) / btcAnchor)) * 100
        : null,
      upPrice: h.up != null ? h.up * 100 : null,
      downPrice: h.down != null ? h.down * 100 : null,
      btcVal: h.btc,
      sE12: h.sE12 ?? null, sE26: h.sE26 ?? null,
      ema12: null, ema26: null, macdHist: null, macdLine: null, macdSignal: null, rsi: null, signal: null,
    }));

    // ETH Polymarket lines: forward-fill cents in-window, then pad from live header if history had no poly
    if (mode === 'eth' && data.length > 0) {
      let lu = null;
      let ld = null;
      for (const d of data) {
        if (d.upPrice != null) lu = d.upPrice;
        else if (lu != null) d.upPrice = lu;
        if (d.downPrice != null) ld = d.downPrice;
        else if (ld != null) d.downPrice = ld;
      }
      const lpUp = live.up != null ? live.up * 100 : null;
      const lpDn = live.down != null ? live.down * 100 : null;
      for (const d of data) {
        if (d.upPrice == null && lpUp != null) d.upPrice = lpUp;
        if (d.downPrice == null && lpDn != null) d.downPrice = lpDn;
      }
    }

    // BTC velocity: price change over 3-second rolling window (matches server trigger)
    for (let i = 0; i < data.length; i++) {
      if (data[i].btcVal == null) { data[i].velocity = null; continue; }
      // Find point ~3 seconds ago
      let j = i - 1;
      while (j >= 0 && data[i].elapsed - data[j].elapsed < 3) j--;
      if (j >= 0 && data[j].btcVal != null) {
        data[i].velocity = Math.round((data[i].btcVal - data[j].btcVal) * 100) / 100;
      } else {
        data[i].velocity = 0;
      }
    }

    // MACD (12,26,9) — same standard alphas as server trigger
    let mf = null, msl = null, ms = null;
    const ma12 = 2 / 13, ma26 = 2 / 27, a9 = 2 / 10;
    for (const d of data) {
      if (d.btcVal == null) continue;
      mf = mf == null ? d.btcVal : d.btcVal * ma12 + mf * (1 - ma12);
      msl = msl == null ? d.btcVal : d.btcVal * ma26 + msl * (1 - ma26);
      d.ema12 = btcAnchor ? Math.round(((mf - btcAnchor) / btcAnchor) * 10000) / 100 : null;
      d.ema26 = btcAnchor ? Math.round(((msl - btcAnchor) / btcAnchor) * 10000) / 100 : null;
      const ml = mf - msl;
      ms = ms == null ? ml : ml * a9 + ms * (1 - a9);
      d.macdHist = Math.round((ml - ms) * 100) / 100;
      d.macdLine = Math.round(ml * 100) / 100;
      d.macdSignal = Math.round(ms * 100) / 100;
    }

    // RSI(14)
    let ag = null, al = null, pb = null;
    for (const d of data) {
      if (d.btcVal == null) continue;
      if (pb != null) {
        const ch = d.btcVal - pb, g = ch > 0 ? ch : 0, l = ch < 0 ? -ch : 0;
        if (ag == null) { ag = g; al = l; }
        else { ag = (ag * 13 + g) / 14; al = (al * 13 + l) / 14; }
        d.rsi = al === 0 ? 100 : Math.round((100 - 100 / (1 + ag / al)) * 10) / 10;
      }
      pb = d.btcVal;
    }

    // Composite signal
    let pmh = null;
    for (const d of data) {
      let s = 0;
      if (d.ema12 != null && d.ema26 != null) s += d.ema12 > d.ema26 ? 1 : -1;
      if (d.macdHist != null) {
        s += d.macdHist > 0 ? 1 : -1;
        if (pmh != null) { if (d.macdHist > 0 && d.macdHist > pmh) s += 0.5; else if (d.macdHist < 0 && d.macdHist < pmh) s -= 0.5; }
        pmh = d.macdHist;
      }
      if (d.rsi != null) { if (d.rsi > 70) s -= 1; else if (d.rsi < 30) s += 1; else if (d.rsi >= 50) s += 0.5; else s -= 0.5; }
      d.signal = s >= 2.5 ? 'Strong Bull' : s >= 1 ? 'Bull' : s <= -2.5 ? 'Strong Bear' : s <= -1 ? 'Bear' : 'Hold';
    }

    // Speed
    const ticks = pool.filter(h => h.btc != null).slice(-10);
    let spd = null;
    if (ticks.length >= 2) {
      const dt = (ticks[ticks.length - 1].t - ticks[0].t) / 1000;
      if (dt > 0) spd = (ticks[ticks.length - 1].btc - ticks[0].btc) / dt;
    }

    return { chartData: data, lastSignal: data.length > 0 ? data[data.length - 1] : null, speed: spd };
  }, [history, openPrice, chartWindowS, mode, event?.slug, live.slug, live.up, live.down]);


  // Map autoEma trade entries + hedges onto chart (entry = winning side, hedge = opposite)
  const entryMarkers = useMemo(() => {
    if (!autoEmaLog.length || !history.length) return [];
    const slugForEth = event?.slug || live.slug;
    const eventStartMs = mode === 'eth' ? parseEventStartMsFromSlug(slugForEth) : null;
    let pool = history;
    if (eventStartMs != null) pool = history.filter(h => h.t >= eventStartMs);
    const lastT = pool[pool.length - 1].t;
    const windowed = pool.filter(h => (lastT - h.t) / 1000 <= chartWindowS);
    const t0 = eventStartMs != null ? eventStartMs : (windowed.length > 0 ? windowed[0].t : Date.now());
    const maxElapsed = windowed.length > 0 ? Math.round((windowed[windowed.length - 1].t - t0) / 1000) : chartWindowS;
    const markers = [];
    for (const e of autoEmaLog) {
      if (e.entryFillTime && e.entryPrice) {
        const elapsed = Math.round((e.entryFillTime - t0) / 1000);
        if (elapsed >= 0 && elapsed <= maxElapsed) {
          markers.push({ elapsed, price: Math.round(e.entryPrice * 100), side: e.side });
        }
      }
      if (e.hedgeTime && e.hedgePrice) {
        const oppSide = e.side === 'up' ? 'down' : 'up';
        const elapsed = Math.round((e.hedgeTime - t0) / 1000);
        if (elapsed >= 0 && elapsed <= maxElapsed) {
          markers.push({ elapsed, price: Math.round(e.hedgePrice * 100), side: oppSide });
        }
      }
    }
    return markers;
  }, [autoEmaLog, history, chartWindowS, mode, event?.slug, live.slug]);

  // My trade markers — from Polymarket API (your wallet's on-chain trades)
  const myTradeMarkers = useMemo(() => {
    if (!history.length) return [];
    const slugForEth = event?.slug || live.slug;
    const eventStartMs = mode === 'eth' ? parseEventStartMsFromSlug(slugForEth) : null;
    let pool = history;
    if (eventStartMs != null) pool = history.filter(h => h.t >= eventStartMs);
    const lastT = pool[pool.length - 1].t;
    const windowed = pool.filter(h => (lastT - h.t) / 1000 <= chartWindowS);
    const t0 = eventStartMs != null ? eventStartMs : (windowed.length > 0 ? windowed[0].t : Date.now());
    const maxElapsed = windowed.length > 0 ? Math.round((windowed[windowed.length - 1].t - t0) / 1000) : chartWindowS;
    return myTradesForEvent
      .filter(t => t.price > 0 && (t.ts || 0) > 0)
      .map(t => {
        const ts = t.ts || 0;
        const price = Math.round((parseFloat(t.price) || 0) * 100);
        const isUp = /up/i.test(t.outcome || '');
        const isBuy = (t.side || '').toLowerCase() === 'buy';
        const elapsed = Math.round((ts - t0) / 1000);
        return { elapsed, price, isUp, isBuy };
      })
      .filter(m => m.price > 0 && m.elapsed >= 0 && m.elapsed <= maxElapsed);
  }, [myTradesForEvent, history, chartWindowS, mode, event?.slug, live.slug]);

  // Divergence detection — BTC moved but Up/Down didn't react
  const divergences = [];
  for (let i = 10; i < chartData.length; i++) {
    const prev = chartData[i - 10];
    const curr = chartData[i];
    if (prev.btcDelta == null || curr.btcDelta == null) continue;
    const btcMove = Math.abs(curr.btcDelta - prev.btcDelta);
    const upDelta = (prev.upPrice != null && curr.upPrice != null) ? Math.abs(curr.upPrice - prev.upPrice) : null;
    const downDelta = (prev.downPrice != null && curr.downPrice != null) ? Math.abs(curr.downPrice - prev.downPrice) : null;
    const polyStale = (upDelta != null && upDelta < 2) || (downDelta != null && downDelta < 2);
    if (btcMove > 15 && polyStale) {
      divergences.push({ elapsed: curr.elapsed, btcDelta: btcMove, upDelta, downDelta });
    }
  }

  // Reverse divergence — Up/Down moved ≥5¢ but BTC flat
  const polyMisprices = useMemo(() => {
    const results = [];
    for (let i = 10; i < chartData.length; i++) {
      const prev = chartData[i - 10];
      const curr = chartData[i];
      if (prev.btcDelta == null || curr.btcDelta == null) continue;
      const btcMove = Math.abs(curr.btcDelta - prev.btcDelta);
      const upMove = (prev.upPrice != null && curr.upPrice != null) ? curr.upPrice - prev.upPrice : null;
      const downMove = (prev.downPrice != null && curr.downPrice != null) ? curr.downPrice - prev.downPrice : null;
      const upAbs = upMove != null ? Math.abs(upMove) : 0;
      const downAbs = downMove != null ? Math.abs(downMove) : 0;
      // Poly moved ≥5¢ but BTC moved < $5
      if ((upAbs >= 5 || downAbs >= 5) && btcMove < 5) {
        results.push({
          elapsed: curr.elapsed,
          btcMove,
          upMove, downMove, upAbs, downAbs,
          // If Up went up without BTC, it's overpriced → sell Up / buy Down
          // If Up went down without BTC, it's underpriced → buy Up
          fadeSide: upAbs >= 5 ? (upMove > 0 ? 'down' : 'up') : (downMove > 0 ? 'up' : 'down'),
          fadePrice: upAbs >= 5
            ? (upMove > 0 ? curr.downPrice : curr.upPrice)
            : (downMove > 0 ? curr.upPrice : curr.downPrice),
        });
      }
    }
    return results;
  }, [chartData]);

  // Active misprice = most recent one, only if it's from the last 5 ticks
  const activeMisprice = polyMisprices.length > 0 && chartData.length > 0
    && chartData[chartData.length - 1].elapsed - polyMisprices[polyMisprices.length - 1].elapsed < 10
    ? polyMisprices[polyMisprices.length - 1] : null;

  // FAK buy for misprice fade
  const fadeBuy = async (side) => {
    const price = side === 'up' ? live.up : live.down;
    if (!price) return;
    setBuyStatus({ side, msg: `FAK 5sh ${side}...`, ok: null });
    try {
      const res = await fetch(`${API_BASE}/api/scalp`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ side, shares: 5, profitCents: 3 }),
      });
      const data = await res.json();
      if (res.ok && data.success) {
        setBuyStatus({ side, msg: `Fade sent: ${side}@${((data.buy?.price ?? 0) * 100).toFixed(0)}¢`, ok: true });
      } else {
        setBuyStatus({ side, msg: data.error || 'Failed', ok: false });
      }
    } catch (e) {
      setBuyStatus({ side, msg: 'Error', ok: false });
    }
    setTimeout(() => setBuyStatus(null), 3000);
  };

  const CustomTooltip = ({ active, payload }) => {
    if (!active || !payload?.length) return null;
    const d = payload[0]?.payload;
    if (!d) return null;
    return (
      <div className="bg-gray-900 border border-gray-700 rounded-lg px-3 py-2 text-xs">
        <div className="text-gray-400">{d.elapsed}s elapsed</div>
        {d.btcDelta != null && <div className={d.btcDelta >= 0 ? 'text-green-400' : 'text-red-400'}>BTC: {d.btcDelta >= 0 ? '+' : ''}{d.btcDelta.toFixed(3)}%</div>}
        {d.ethDelta != null && <div className={d.ethDelta >= 0 ? 'text-green-400' : 'text-red-400'}>ETH: {d.ethDelta >= 0 ? '+' : ''}{d.ethDelta.toFixed(3)}%</div>}
        {d.pctSpread != null && <div className="text-orange-400">ETH vs BTC: {d.pctSpread >= 0 ? '+' : ''}{d.pctSpread.toFixed(3)}% {d.pctSpread > 0 ? '(ETH over)' : '(ETH under)'}</div>}
        {d.ema12 != null && <div className="text-cyan-400">EMA12: {d.ema12 >= 0 ? '+' : ''}{d.ema12.toFixed(3)}%</div>}
        {d.ema26 != null && <div className="text-purple-400">EMA26: {d.ema26 >= 0 ? '+' : ''}{d.ema26.toFixed(3)}%</div>}
        {d.btcVal && <div className="text-yellow-400">BTC: ${d.btcVal.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</div>}
        {d.upPrice != null && <div className="text-green-300">Up: {d.upPrice.toFixed(1)}¢</div>}
        {d.downPrice != null && <div className="text-red-300">Down: {d.downPrice.toFixed(1)}¢</div>}
      </div>
    );
  };

  const formatElapsed = (secs) => `${Math.floor(secs / 60)}:${String(secs % 60).padStart(2, '0')}`;

  return (
    <div className="space-y-4">
      {expired && (
        <div className="rounded-lg border border-yellow-800/50 bg-yellow-950/30 px-4 py-2 flex items-center justify-between text-yellow-400 text-sm">
          <span>Event expired — waiting for next event.</span>
          <button
            onClick={() => fetch(`${API_BASE}/api/event/refresh`, { method: 'POST' }).catch(() => {})}
            className="px-3 py-1 rounded bg-yellow-800/40 hover:bg-yellow-700/40 text-yellow-300 text-xs font-bold"
          >Refresh Event</button>
        </div>
      )}

      {/* Stats Bar */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <StatCard
          label="Up Price"
          value={fmtCents(live.up)}
          color={expired ? 'text-gray-600' : 'text-green-400'}
          sub={upOpen != null ? `open: ${fmtCents(upOpen)}` : null}
        />
        <StatCard
          label="Down Price"
          value={fmtCents(live.down)}
          color={expired ? 'text-gray-600' : 'text-red-400'}
          sub={downOpen != null ? `open: ${fmtCents(downOpen)}` : null}
        />
        <StatCard
          label="BTC (Binance)"
          value={currentBtc ? `$${currentBtc.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}` : '—'}
          color="text-yellow-400"
          sub={openPrice ? `open: $${openPrice.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}` : null}
        />
        <StatCard
          label="Time Left"
          value={timeStr}
          color={expired ? 'text-yellow-600' : 'text-orange-400'}
          sub={live.title?.replace('Bitcoin Up or Down - ', '')}
        />
      </div>

      {/* Signal + BTC Change + Indicators Row */}
      <div className="flex items-center gap-4 px-4 py-3 rounded-lg bg-gray-900 border border-gray-800 flex-wrap">
        {/* Signal label */}
        {lastSignal?.signal && (() => {
          const s = lastSignal.signal;
          const cls = s === 'Strong Bull' ? 'bg-green-500 text-black' : s === 'Bull' ? 'bg-green-800 text-green-200' : s === 'Strong Bear' ? 'bg-red-500 text-white' : s === 'Bear' ? 'bg-red-800 text-red-200' : 'bg-gray-700 text-gray-300';
          return <span className={`px-3 py-1 rounded font-bold text-sm ${cls}`}>{s}</span>;
        })()}
        <div>
          <span className="text-xs text-gray-500 mr-1">BTC:</span>
          {btcChange != null ? (
            <span className={`font-mono font-bold text-sm ${btcChange >= 0 ? 'text-green-400' : 'text-red-400'}`}>
              {btcChange >= 0 ? '+' : ''}${Math.abs(btcChange).toFixed(2)}
            </span>
          ) : <span className="text-gray-600">—</span>}
        </div>
        <div>
          <span className="text-xs text-gray-500 mr-1">Speed:</span>
          {speed != null ? (
            <span className={`font-mono text-xs ${speed >= 0 ? 'text-green-400' : 'text-red-400'}`}>
              {speed >= 0 ? '+' : ''}{speed.toFixed(2)}$/s
            </span>
          ) : <span className="text-gray-600">—</span>}
        </div>
        <div>
          <span className="text-xs text-gray-500 mr-1">MACD:</span>
          <span className={`font-mono text-xs ${lastSignal?.macdHist > 0 ? 'text-green-400' : lastSignal?.macdHist < 0 ? 'text-red-400' : 'text-gray-300'}`}>
            {lastSignal?.macdHist != null ? lastSignal.macdHist.toFixed(1) : '—'}
          </span>
        </div>
        <div>
          <span className="text-xs text-gray-500 mr-1">EMA:</span>
          <span className={`font-mono text-xs ${lastSignal?.ema12 > lastSignal?.ema26 ? 'text-green-400' : lastSignal?.ema12 < lastSignal?.ema26 ? 'text-red-400' : 'text-gray-300'}`}>
            {lastSignal?.ema12 != null ? (lastSignal.ema12 > lastSignal.ema26 ? '12>26' : '12<26') : '—'}
          </span>
        </div>
      </div>

      {/* Trading Controls */}
      <div className="px-4 py-3 rounded-lg bg-gray-900 border border-gray-800 space-y-2">
        {/* Row 1: Buy buttons + status */}
        <div className="flex items-center gap-2 flex-wrap">
          <button onClick={() => quickBuy('up', -3)} disabled={expired || buyStatus?.side === 'up'}
            className="px-2 py-1.5 rounded bg-green-900/30 hover:bg-green-800/40 disabled:opacity-40 text-green-400/60 font-bold text-[10px] transition-colors">-3¢</button>
          <button onClick={() => quickBuy('up')} disabled={expired || buyStatus?.side === 'up'}
            className="px-3 py-1.5 rounded bg-green-800/40 hover:bg-green-700/50 disabled:opacity-40 text-green-300 font-bold text-xs transition-colors">5sh Up</button>
          <button onClick={() => quickBuy('up', 3)} disabled={expired || buyStatus?.side === 'up'}
            className="px-2 py-1.5 rounded bg-green-900/30 hover:bg-green-800/40 disabled:opacity-40 text-green-400/60 font-bold text-[10px] transition-colors">+3¢</button>
          <button onClick={() => quickBuy('down', -3)} disabled={expired || buyStatus?.side === 'down'}
            className="px-2 py-1.5 rounded bg-red-900/30 hover:bg-red-800/40 disabled:opacity-40 text-red-400/60 font-bold text-[10px] transition-colors">-3¢</button>
          <button onClick={() => quickBuy('down')} disabled={expired || buyStatus?.side === 'down'}
            className="px-3 py-1.5 rounded bg-red-800/40 hover:bg-red-700/50 disabled:opacity-40 text-red-300 font-bold text-xs transition-colors">5sh Down</button>
          <button onClick={() => quickBuy('down', 3)} disabled={expired || buyStatus?.side === 'down'}
            className="px-2 py-1.5 rounded bg-red-900/30 hover:bg-red-800/40 disabled:opacity-40 text-red-400/60 font-bold text-[10px] transition-colors">+3¢</button>
          <span className="text-gray-700">|</span>
          {/* Scalp: FAK buy + GTC hedge */}
          <button onClick={() => scalp('up', 1)} disabled={expired || buyStatus?.side === 'up'}
            className="px-2 py-1.5 rounded bg-green-900/70 hover:bg-green-800/80 disabled:opacity-40 text-green-100 font-bold text-[10px] transition-colors border border-green-600/50">S↑ 1¢</button>
          <button onClick={() => scalp('up', 2)} disabled={expired || buyStatus?.side === 'up'}
            className="px-2 py-1.5 rounded bg-green-900/50 hover:bg-green-800/60 disabled:opacity-40 text-green-200 font-bold text-[10px] transition-colors border border-green-700/40">S↑ 2¢</button>
          <button onClick={() => scalp('up', 5)} disabled={expired || buyStatus?.side === 'up'}
            className="px-2 py-1.5 rounded bg-green-900/30 hover:bg-green-800/40 disabled:opacity-40 text-green-300/70 font-bold text-[10px] transition-colors border border-green-700/20">S↑ 5¢</button>
          <button onClick={() => scalp('down', 1)} disabled={expired || buyStatus?.side === 'down'}
            className="px-2 py-1.5 rounded bg-red-900/70 hover:bg-red-800/80 disabled:opacity-40 text-red-100 font-bold text-[10px] transition-colors border border-red-600/50">S↓ 1¢</button>
          <button onClick={() => scalp('down', 2)} disabled={expired || buyStatus?.side === 'down'}
            className="px-2 py-1.5 rounded bg-red-900/50 hover:bg-red-800/60 disabled:opacity-40 text-red-200 font-bold text-[10px] transition-colors border border-red-700/40">S↓ 2¢</button>
          <button onClick={() => scalp('down', 5)} disabled={expired || buyStatus?.side === 'down'}
            className="px-2 py-1.5 rounded bg-red-900/30 hover:bg-red-800/40 disabled:opacity-40 text-red-300/70 font-bold text-[10px] transition-colors border border-red-700/20">S↓ 5¢</button>
          <span className="text-gray-700">|</span>
          {/* Quick Sell */}
          <button onClick={() => quickSell('up')} disabled={expired || buyStatus?.side === 'up'}
            className="px-2 py-1.5 rounded bg-green-900/50 hover:bg-green-800/60 disabled:opacity-40 text-green-200 font-bold text-[10px] transition-colors border border-green-600/30">Sell ↑</button>
          <button onClick={() => quickSell('down')} disabled={expired || buyStatus?.side === 'down'}
            className="px-2 py-1.5 rounded bg-red-900/50 hover:bg-red-800/60 disabled:opacity-40 text-red-200 font-bold text-[10px] transition-colors border border-red-600/30">Sell ↓</button>
          {pos.up?.shares > 0 && (
            <button onClick={() => quickSell('up', Math.ceil(pos.up.shares * 0.25))} disabled={expired || buyStatus?.side === 'up'}
              className="px-2 py-1.5 rounded bg-green-900/30 hover:bg-green-800/40 disabled:opacity-40 text-green-300/70 font-bold text-[10px] transition-colors border border-green-700/20">25% ↑ ({Math.ceil(pos.up.shares * 0.25)})</button>
          )}
          {pos.down?.shares > 0 && (
            <button onClick={() => quickSell('down', Math.ceil(pos.down.shares * 0.25))} disabled={expired || buyStatus?.side === 'down'}
              className="px-2 py-1.5 rounded bg-red-900/30 hover:bg-red-800/40 disabled:opacity-40 text-red-300/70 font-bold text-[10px] transition-colors border border-red-700/20">25% ↓ ({Math.ceil(pos.down.shares * 0.25)})</button>
          )}
          <span className="text-gray-700">|</span>
          {/* Stop Loss inline */}
          {stopLoss ? (
            <>
              <span className="text-[10px] font-mono text-orange-400 animate-pulse">
                SL: {stopLoss.shares}sh {stopLoss.side.toUpperCase()} ≥{stopLoss.trigger}¢
              </span>
              <span className="text-[10px] text-gray-500">
                (now {stopLoss.side === 'up' ? (live.up != null ? `${(live.up * 100).toFixed(0)}¢` : '—') : (live.down != null ? `${(live.down * 100).toFixed(0)}¢` : '—')})
              </span>
              <button onClick={() => {
                fetch(`${API_BASE}/api/stop-loss-config`, { method: 'DELETE' })
                  .then(() => { setStopLoss(null); stopLossRef.current = null; }).catch(() => {});
              }}
                className="px-1.5 py-0.5 rounded text-[10px] font-bold bg-red-900/30 hover:bg-red-800/40 text-red-400 transition-colors">✕</button>
            </>
          ) : (
            <>
              <span className="text-[10px] text-orange-500 font-bold">SL</span>
              <input type="number" min="1" max="99" placeholder="¢" value={slTrigger} onChange={e => setSlTrigger(e.target.value)}
                className="w-10 px-1 py-0.5 rounded bg-gray-800 border border-gray-700 text-white text-[10px] font-mono text-center focus:border-orange-500 focus:outline-none" />
              <input type="number" min="5" placeholder="sh" value={slShares} onChange={e => setSlShares(e.target.value)}
                className="w-10 px-1 py-0.5 rounded bg-gray-800 border border-gray-700 text-white text-[10px] font-mono text-center focus:border-orange-500 focus:outline-none" />
              {['up', 'down'].map(side => (
                <button key={side} onClick={() => {
                  const t = parseInt(slTrigger); if (!t || t < 1 || t > 99) return;
                  const s = Math.max(5, parseInt(slShares) || 5);
                  const sl = { side, trigger: t, shares: s };
                  fetch(`${API_BASE}/api/stop-loss-config`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(sl),
                  }).then(r => r.json()).then(d => {
                    if (d.armed) { setStopLoss(sl); stopLossRef.current = sl; }
                  }).catch(() => {});
                }} className={`px-1.5 py-0.5 rounded text-[10px] font-bold transition-colors ${side === 'up' ? 'bg-green-900/30 hover:bg-green-800/40 text-green-400' : 'bg-red-900/30 hover:bg-red-800/40 text-red-400'}`}
                >{side.toUpperCase()}</button>
              ))}
            </>
          )}
          {buyStatus && (
            <span className={`text-[10px] font-mono ml-auto ${buyStatus.ok === true ? 'text-green-400' : buyStatus.ok === false ? 'text-red-400' : 'text-gray-400'}`}>
              {buyStatus.msg}
            </span>
          )}
        </div>
        {/* Row 2: Positions */}
        <div className="flex items-center gap-3 text-xs font-mono flex-wrap">
          {pos.up ? (() => {
            const val = live.up != null ? pos.up.shares * live.up : null;
            const pnl = val != null ? val - pos.up.cost : null;
            return (
              <span>
                <span className="text-green-400 font-bold">{pos.up.shares.toFixed(1)}sh Up</span>
                <span className="text-gray-500"> avg {(pos.up.avg * 100).toFixed(1)}¢ cost ${pos.up.cost.toFixed(2)}</span>
                {pnl != null && <span className={pnl >= 0 ? 'text-green-400' : 'text-red-400'}> {pnl >= 0 ? '+' : ''}${pnl.toFixed(2)}</span>}
              </span>
            );
          })() : <span className="text-gray-600">No Up</span>}
          <span className="text-gray-700">|</span>
          {pos.down ? (() => {
            const val = live.down != null ? pos.down.shares * live.down : null;
            const pnl = val != null ? val - pos.down.cost : null;
            return (
              <span>
                <span className="text-red-400 font-bold">{pos.down.shares.toFixed(1)}sh Down</span>
                <span className="text-gray-500"> avg {(pos.down.avg * 100).toFixed(1)}¢ cost ${pos.down.cost.toFixed(2)}</span>
                {pnl != null && <span className={pnl >= 0 ? 'text-green-400' : 'text-red-400'}> {pnl >= 0 ? '+' : ''}${pnl.toFixed(2)}</span>}
              </span>
            );
          })() : <span className="text-gray-600">No Down</span>}
          {whaleHoldings?.up != null && (
            <>
              <span className="text-gray-700">|</span>
              <span className="text-gray-500 font-bold">@0x8d</span>
              <span className="text-green-400">{whaleHoldings.up.toFixed(1)} Up</span>
              <span className="text-red-400">{(whaleHoldings.down ?? 0).toFixed(1)} Dn</span>
            </>
          )}
        </div>
      </div>

      {/* Open Orders */}
      {openOrders.length > 0 && (
        <div className="px-4 py-2 rounded-lg bg-gray-900 border border-yellow-800/30">
          <div className="flex items-center gap-2 mb-1">
            <span className="text-[10px] uppercase tracking-wider text-yellow-500">Pending Orders ({openOrders.length})</span>
            <button
              onClick={async () => {
                try {
                  await fetch(`${API_BASE}/api/cancel-all`, { method: 'POST' });
                  fetchOpenOrders();
                } catch {}
              }}
              className="text-[10px] px-2 py-0.5 rounded bg-yellow-900/30 hover:bg-yellow-800/40 text-yellow-500 transition-colors"
            >Cancel All</button>
          </div>
          <div className="space-y-0.5">
            {openOrders.map((o, i) => {
              const price = parseFloat(o.price || 0);
              const size = parseFloat(o.original_size || o.size || 0);
              const filled = parseFloat(o.size_matched || 0);
              const side = o.side === 'BUY' ? 'BUY' : 'SELL';
              const tokenId = o.asset_id || o.token_id;
              const outcome = tokenId === live.tokenUp ? 'Up' : tokenId === live.tokenDown ? 'Down' : '?';
              const orderId = o.id || o.order_id;
              return (
                <div key={orderId || i} className="flex items-center gap-2 text-xs font-mono">
                  <span className={side === 'BUY' ? 'text-green-400' : 'text-red-400'}>{side}</span>
                  <span className={outcome === 'Up' ? 'text-green-300' : outcome === 'Down' ? 'text-red-300' : 'text-gray-400'}>{outcome}</span>
                  <span className="text-white">{size.toFixed(1)}sh</span>
                  <span className="text-gray-500">@ {(price * 100).toFixed(0)}¢</span>
                  {filled > 0 && <span className="text-yellow-400">(filled {filled.toFixed(1)})</span>}
                  {orderId && <button
                    onClick={async () => {
                      try {
                        await fetch(`${API_BASE}/api/cancel`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ orderID: orderId }) });
                        fetchOpenOrders();
                      } catch {}
                    }}
                    className="text-[10px] px-1.5 py-0.5 rounded bg-gray-800 hover:bg-red-900/40 text-gray-500 hover:text-red-400 transition-colors ml-1"
                  >✕</button>}
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* Chart */}
      {chartData.length > 2 ? (
        <div className="rounded-xl border border-gray-800 bg-gray-900 p-4">
          <div className="flex items-center justify-between mb-3">
            <h3 className="text-sm font-bold text-gray-300">{mode === 'eth' ? 'BTC Price Change vs ETH Polymarket Prices' : 'BTC Price Change vs Polymarket Prices'}</h3>
            <div className="flex items-center gap-1">
              {[60, 120, 180, 300, 600, 900].map(s => (
                <button key={s} onClick={() => setChartWindowS(s)}
                  className={`px-2 py-0.5 rounded text-xs font-mono transition-colors ${chartWindowS === s ? 'bg-blue-600 text-white' : 'bg-gray-800 text-gray-400 hover:bg-gray-700'}`}
                >{s < 60 ? `${s}s` : `${s / 60}m`}</button>
              ))}
            </div>
          </div>
          <ResponsiveContainer width="100%" height={350}>
            <ComposedChart data={chartData} margin={{ top: 5, right: 10, left: 0, bottom: 5 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="#333" />
              <XAxis dataKey="elapsed" tickFormatter={formatElapsed} stroke="#666" tick={{ fontSize: 11 }} interval="preserveStartEnd" />
              <YAxis yAxisId="btc" orientation="left" width={50} stroke="#eab308" tick={{ fontSize: 11 }} tickFormatter={v => `${v >= 0 ? '+' : ''}${v.toFixed(2)}%`} domain={['auto', 'auto']} label={{ value: mode === 'eth' ? 'BTC/ETH %' : 'BTC %', angle: -90, position: 'insideLeft', fill: '#eab308', fontSize: 11 }} />
              <YAxis yAxisId="poly" orientation="right" width={40} stroke="#4ade80" tick={{ fontSize: 11 }} tickFormatter={v => `${v.toFixed(0)}¢`} domain={[0, 100]} label={{ value: 'Price (¢)', angle: 90, position: 'insideRight', fill: '#4ade80', fontSize: 11 }} />
              <Tooltip content={<CustomTooltip />} position={{ x: 70, y: 0 }} />
              <ReferenceLine yAxisId="btc" y={0} stroke="#555" strokeDasharray="3 3" />
              <Area yAxisId="btc" dataKey="btcDelta" stroke="#eab308" fill="#eab30822" strokeWidth={2} dot={false} connectNulls isAnimationActive={false} />
              {mode === 'eth' && <Line yAxisId="btc" dataKey="ethDelta" stroke="#8b5cf6" strokeWidth={2} dot={false} connectNulls isAnimationActive={false} />}
              {mode === 'eth' && <Line yAxisId="btc" dataKey="pctSpread" stroke="#f97316" strokeWidth={1.5} dot={false} connectNulls isAnimationActive={false} strokeDasharray="6 3" />}
              <Line yAxisId="btc" dataKey="ema12" stroke="#06b6d4" strokeWidth={1.5} dot={false} connectNulls isAnimationActive={false} strokeDasharray="4 2" />
              <Line yAxisId="btc" dataKey="ema26" stroke="#a855f7" strokeWidth={1.5} dot={false} connectNulls isAnimationActive={false} strokeDasharray="4 2" />
              <Line yAxisId="poly" dataKey="upPrice" stroke="#4ade80" strokeWidth={2} dot={false} connectNulls isAnimationActive={false} />
              <Line yAxisId="poly" dataKey="downPrice" stroke="#f87171" strokeWidth={2} dot={false} connectNulls isAnimationActive={false} />
              {entryMarkers.map((m, i) => (
                <ReferenceDot key={`entry-${i}`} yAxisId="poly" x={m.elapsed} y={m.price} r={6}
                  fill={m.side === 'up' ? '#4ade80' : '#f87171'} stroke="#fff" strokeWidth={2}
                  label={{ value: `${m.price}¢`, position: 'top', fill: '#fff', fontSize: 10, fontWeight: 'bold' }} />
              ))}
              {myTradeMarkers.map((m, i) => {
                // Up: green buy, red sell. Down: cyan buy, orange sell (so they stand out on red line)
                const color = m.isUp
                  ? (m.isBuy ? '#22c55e' : '#ef4444')
                  : (m.isBuy ? '#06b6d4' : '#f97316');
                return (
                  <ReferenceDot key={`my-${i}`} yAxisId="poly" x={m.elapsed} y={m.price} r={5}
                    fill={color} fillOpacity={0.9} stroke="#fff" strokeWidth={1.5}
                    label={{ value: `${m.price}¢`, position: 'top', fill: '#fff', fontSize: 9, fontWeight: 'bold' }} />
                );
              })}
            </ComposedChart>
          </ResponsiveContainer>
          <div className="flex items-center justify-center gap-6 mt-2 text-xs flex-wrap">
            <span className="flex items-center gap-1"><span className="w-3 h-0.5 bg-yellow-500 inline-block"></span> BTC %</span>
            {mode === 'eth' && <span className="flex items-center gap-1"><span className="w-3 h-0.5 bg-violet-500 inline-block"></span> ETH %</span>}
            {mode === 'eth' && <span className="flex items-center gap-1"><span className="w-3 h-0.5 bg-orange-500 inline-block" style={{borderTop:'1px dashed'}}></span> Spread</span>}
            <span className="flex items-center gap-1"><span className="w-3 h-0.5 bg-green-400 inline-block"></span> Up</span>
            <span className="flex items-center gap-1"><span className="w-3 h-0.5 bg-red-400 inline-block"></span> Down</span>
            <span className="flex items-center gap-1"><span className="w-3 h-0.5 bg-cyan-400 inline-block" style={{borderTop:'1px dashed'}}></span> EMA12</span>
            <span className="flex items-center gap-1"><span className="w-3 h-0.5 bg-purple-400 inline-block" style={{borderTop:'1px dashed'}}></span> EMA26</span>
            {myTradeMarkers.some(m => m.isUp && m.isBuy) && (
              <span className="flex items-center gap-1"><span className="w-2 h-2 rounded-full bg-green-500 inline-block border border-white"></span> Up Buy</span>
            )}
            {myTradeMarkers.some(m => m.isUp && !m.isBuy) && (
              <span className="flex items-center gap-1"><span className="w-2 h-2 rounded-full bg-red-500 inline-block border border-white"></span> Up Sell</span>
            )}
            {myTradeMarkers.some(m => !m.isUp && m.isBuy) && (
              <span className="flex items-center gap-1"><span className="w-2 h-2 rounded-full bg-cyan-400 inline-block border border-white"></span> Down Buy</span>
            )}
            {myTradeMarkers.some(m => !m.isUp && !m.isBuy) && (
              <span className="flex items-center gap-1"><span className="w-2 h-2 rounded-full bg-orange-500 inline-block border border-white"></span> Down Sell</span>
            )}
          </div>
          {/* MACD Histogram */}
          <ResponsiveContainer width="100%" height={80}>
            <ComposedChart data={chartData} margin={{ top: 5, right: 10, left: 0, bottom: 0 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="#222" />
              <XAxis dataKey="elapsed" tickFormatter={formatElapsed} stroke="#666" tick={{ fontSize: 9 }} interval="preserveStartEnd" />
              <YAxis yAxisId="mh" orientation="left" width={50} stroke="#888" tick={{ fontSize: 9 }} domain={['auto', 'auto']} />
              <ReferenceLine yAxisId="mh" y={0} stroke="#555" />
              <Bar yAxisId="mh" dataKey="macdHist" isAnimationActive={false}>
                {chartData.map((d, i) => (
                  <Cell key={i} fill={(d.macdHist ?? 0) >= 0 ? '#22c55e' : '#ef4444'} fillOpacity={0.7} />
                ))}
              </Bar>
              <Line yAxisId="mh" dataKey="macdLine" stroke="#06b6d4" strokeWidth={1} dot={false} connectNulls isAnimationActive={false} />
              <Line yAxisId="mh" dataKey="macdSignal" stroke="#f97316" strokeWidth={1} dot={false} connectNulls isAnimationActive={false} />
            </ComposedChart>
          </ResponsiveContainer>
          <div className="flex items-center justify-center gap-6 text-xs">
            <span className="flex items-center gap-1"><span className="w-3 h-2 bg-green-500 inline-block"></span>/<span className="w-3 h-2 bg-red-500 inline-block"></span> MACD Hist</span>
            <span className="flex items-center gap-1"><span className="w-3 h-0.5 bg-cyan-400 inline-block"></span> MACD</span>
            <span className="flex items-center gap-1"><span className="w-3 h-0.5 bg-orange-500 inline-block"></span> Signal</span>
          </div>
          {/* BTC Velocity ($/3s) */}
          <ResponsiveContainer width="100%" height={100}>
            <ComposedChart data={chartData} margin={{ top: 5, right: 10, left: 0, bottom: 0 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="#222" />
              <XAxis dataKey="elapsed" tickFormatter={formatElapsed} stroke="#666" tick={{ fontSize: 9 }} interval="preserveStartEnd" />
              <YAxis yAxisId="macd" orientation="left" width={50} stroke="#888" tick={{ fontSize: 9 }} tickFormatter={v => `$${v.toFixed(0)}`} domain={['auto', 'auto']} />
              <YAxis yAxisId="macdR" orientation="right" width={40} stroke="transparent" tick={false} />
              <ReferenceLine yAxisId="macd" y={0} stroke="#555" />
              <ReferenceLine yAxisId="macd" y={20} stroke="#22c55e33" strokeDasharray="4 2" label={{ value: '+$20', position: 'right', fill: '#22c55e', fontSize: 9 }} />
              <ReferenceLine yAxisId="macd" y={-20} stroke="#ef444433" strokeDasharray="4 2" label={{ value: '-$20', position: 'right', fill: '#ef4444', fontSize: 9 }} />
              <Bar yAxisId="macd" dataKey="velocity" isAnimationActive={false}>
                {chartData.map((d, i) => (
                  <Cell key={i} fill={(d.velocity ?? 0) >= 0 ? '#22c55e' : '#ef4444'} fillOpacity={Math.abs(d.velocity ?? 0) >= 20 ? 1.0 : 0.4} />
                ))}
              </Bar>
            </ComposedChart>
          </ResponsiveContainer>
          <div className="flex items-center justify-center gap-6 text-xs">
            <span className="flex items-center gap-1"><span className="w-3 h-2 bg-green-500 inline-block"></span>/<span className="w-3 h-2 bg-red-500 inline-block"></span> BTC Velocity ($/3s)</span>
            <span className="text-gray-500">trigger at ±$20</span>
          </div>
        </div>
      ) : (
        <div className="rounded-xl border border-gray-800 bg-gray-900 p-8 text-center text-gray-500 text-sm">
          Waiting for price data... ({history.length} ticks)
        </div>
      )}

      {activeMisprice && (
        <div className="rounded-xl border border-cyan-500/60 bg-cyan-950/30 p-4 animate-pulse">
          <div className="flex items-center justify-between mb-1">
            <h3 className="text-sm font-bold text-cyan-300">Poly Moved — BTC Flat</h3>
            <button
              onClick={() => fadeBuy(activeMisprice.fadeSide)}
              disabled={!!buyStatus}
              className={`px-3 py-1.5 rounded-lg text-xs font-bold transition-all ${
                activeMisprice.fadeSide === 'up'
                  ? 'bg-green-600 hover:bg-green-500 text-white'
                  : 'bg-red-600 hover:bg-red-500 text-white'
              } disabled:opacity-40`}
            >
              FAK 5sh {activeMisprice.fadeSide.toUpperCase()} @ {activeMisprice.fadePrice?.toFixed(0)}¢
            </button>
          </div>
          <div className="flex gap-4 text-xs font-mono">
            <span className="text-gray-400">BTC: ${activeMisprice.btcMove.toFixed(0)}</span>
            {activeMisprice.upMove != null && <span className={activeMisprice.upMove > 0 ? 'text-green-400' : 'text-red-400'}>Up: {activeMisprice.upMove > 0 ? '+' : ''}{activeMisprice.upMove.toFixed(1)}¢</span>}
            {activeMisprice.downMove != null && <span className={activeMisprice.downMove > 0 ? 'text-green-400' : 'text-red-400'}>Down: {activeMisprice.downMove > 0 ? '+' : ''}{activeMisprice.downMove.toFixed(1)}¢</span>}
          </div>
        </div>
      )}

      {divergences.length > 0 && (
        <div className="rounded-xl border border-orange-800/50 bg-orange-950/20 p-4">
          <h3 className="text-sm font-bold text-orange-400 mb-2">Divergences Detected ({divergences.length})</h3>
          <p className="text-xs text-gray-400 mb-2">BTC moved {'>'} $15 over 10 ticks but Up or Down changed {'<'} 2¢</p>
          <div className="max-h-32 overflow-y-auto space-y-1">
            {divergences.slice(-10).map((d, i) => (
              <div key={i} className="flex items-center gap-3 text-xs font-mono">
                <span className="text-gray-500">{formatElapsed(d.elapsed)}</span>
                <span className="text-yellow-400">BTC: ${d.btcDelta.toFixed(2)}</span>
                {d.upDelta != null && <span className="text-green-400">Up: {d.upDelta.toFixed(1)}¢</span>}
                {d.downDelta != null && <span className="text-red-400">Down: {d.downDelta.toFixed(1)}¢</span>}
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

function StatCard({ label, value, color, sub }) {
  return (
    <div className="rounded-lg bg-gray-900 border border-gray-800 px-4 py-3">
      <div className="text-[10px] uppercase tracking-wider text-gray-500">{label}</div>
      <div className={`text-xl font-bold font-mono ${color}`}>{value}</div>
      {sub && <div className="text-[10px] text-gray-600 mt-0.5">{sub}</div>}
    </div>
  );
}
