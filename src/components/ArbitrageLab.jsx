import React, { useState, useEffect, useCallback, useRef, useMemo } from 'react';
import {
  LineChart,
  Line,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
  Legend,
} from 'recharts';
import { getApiBase } from '../apiBase.js';

const API_BASE = getApiBase();

const FEE = 0.02;

/** Current 15m slot unix timestamp — used to detect rollovers. */
function current15mSlot() {
  return Math.floor(Date.now() / 1000 / 900) * 900;
}

function fmt(n) {
  if (n == null || Number.isNaN(n)) return '—';
  return (typeof n === 'number' ? n : parseFloat(n)).toFixed(4);
}

function cents(n) {
  if (n == null || Number.isNaN(n)) return '—';
  return `${((typeof n === 'number' ? n : parseFloat(n)) * 100).toFixed(2)}¢`;
}

function fmtUsd(n) {
  if (n == null || n === '' || Number.isNaN(Number(n))) return '—';
  const x = Number(n);
  return `${x >= 0 ? '+' : ''}$${x.toFixed(2)}`;
}

function fetchErrMessage(e, base) {
  if (e?.name === 'TypeError' && String(e.message).includes('fetch')) {
    const where = base || '(same page /api)';
    return `Cannot reach API ${where}. Run server.js on port 3001 (Vite proxies /api to it). Set VITE_API_URL if the API is elsewhere.`;
  }
  return e?.message || String(e);
}

/** Avoid `r.json()` on empty/HTML error pages (proxy down → empty body). */
async function readJsonOrThrow(res, label) {
  const text = await res.text();
  const t = text?.trim() ?? '';
  if (!t) {
    throw new Error(
      `${label}: HTTP ${res.status} empty response — is server.js running on port 3001? (Vite proxies /api → :3001.)`,
    );
  }
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(
      `${label}: HTTP ${res.status} not JSON — ${t.slice(0, 180)}${t.length > 180 ? '…' : ''}`,
    );
  }
}

export default function ArbitrageLab() {
  const [externalUrl, setExternalUrl] = useState('');
  const [polySlug, setPolySlug] = useState('');
  const [loadingDefaults, setLoadingDefaults] = useState(true);
  const [meta, setMeta] = useState({ kalshi: null, poly: null });
  const [campaignsList, setCampaignsList] = useState([]);
  const [pnlData, setPnlData] = useState(null);
  const [arbSessions, setArbSessions] = useState([]);
  const [venuePnlRefreshing, setVenuePnlRefreshing] = useState(null);

  // Snipe state
  const [snipes, setSnipes] = useState([]);
  const [snipeForm, setSnipeForm] = useState({ asset: 'btc', side: 'up', limitPrice: '0.47', shares: '50', kalshiLimit: '0.51' });

  // Load snipes
  useEffect(() => {
    function loadSnipes() {
      fetch(`${API_BASE}/api/arb/snipes`).then(r => r.json()).then(d => { if (d.snipes) setSnipes(d.snipes); }).catch(() => {});
    }
    loadSnipes();
    const iv = setInterval(loadSnipes, 5000);
    return () => clearInterval(iv);
  }, []);

  async function addSnipe() {
    const { asset, side, limitPrice, shares, kalshiLimit } = snipeForm;
    if (!limitPrice || !shares) return;
    const sides = side === 'both' ? ['up', 'down'] : [side];
    try {
      for (const s of sides) {
        await fetch(`${API_BASE}/api/arb/snipes`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ asset, side: s, limitPrice: parseFloat(limitPrice), shares: parseInt(shares), kalshiLimit: parseFloat(kalshiLimit) }),
        });
      }
    } catch {}
  }

  async function deleteSnipe(id) {
    try { await fetch(`${API_BASE}/api/arb/snipes/${id}`, { method: 'DELETE' }); } catch {}
  }

  async function toggleSnipe(id, currentActive) {
    try {
      await fetch(`${API_BASE}/api/arb/snipes/${id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ active: !currentActive }),
      });
    } catch {}
  }

  // Load P&L
  useEffect(() => {
    function loadPnl() {
      fetch(`${API_BASE}/api/arb/pnl`).then(r => r.json()).then(d => setPnlData(d)).catch(() => {});
    }
    loadPnl();
    const iv = setInterval(loadPnl, 15000);
    return () => clearInterval(iv);
  }, []);

  // Arb sessions (includes venue_pnl_* from DB — Kalshi fills + Polymarket data-api trades)
  useEffect(() => {
    function loadSessions() {
      fetch(`${API_BASE}/api/arb/sessions`)
        .then(r => r.json())
        .then(d => {
          if (d.sessions) setArbSessions(d.sessions);
        })
        .catch(() => {});
    }
    loadSessions();
    const iv = setInterval(loadSessions, 10000);
    return () => clearInterval(iv);
  }, []);

  // Load campaigns on mount and every 2s
  useEffect(() => {
    function loadCampaigns() {
      fetch(`${API_BASE}/api/arb/campaigns`)
        .then(r => r.json())
        .then(d => { if (d.campaigns) setCampaignsList(d.campaigns); })
        .catch(() => {});
    }
    loadCampaigns();
    const iv = setInterval(loadCampaigns, 2000);
    return () => clearInterval(iv);
  }, []);

  async function createCampaign() {
    if (!externalUrl.trim() || !polySlug.trim()) return;
    try {
      const r = await fetch(`${API_BASE}/api/arb/campaigns`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          kalshiUrl: externalUrl.trim(),
          polyUrl: polySlug.trim(),
          label: meta.kalshi?.title || meta.poly?.question || 'Campaign',
          autoEnabled: recurring || autoEnabled,
          autoThreshold: autoThreshold,
          autoCooldown: autoCooldown,
          maxShares: maxShares,
          swapPoly: swapPoly,
          recurring: recurring,
        }),
      });
      const d = await r.json();
      if (d.campaign) {
        setCampaignsList(prev => [d.campaign, ...prev]);
        if (d.sessionId) {
          setSessionId(d.sessionId);
          setRunning(true);
          setTicks([]);
        }
      }
    } catch {}
  }

  async function stopCampaign(id) {
    await fetch(`${API_BASE}/api/arb/campaigns/${id}/stop`, { method: 'POST' }).catch(() => {});
    setCampaignsList(prev => prev.map(c => c.id === id ? { ...c, status: 'stopped', auto_enabled: false } : c));
  }

  async function toggleCampaignAuto(id, enabled) {
    await fetch(`${API_BASE}/api/arb/campaigns/${id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ autoEnabled: enabled }),
    }).catch(() => {});
    setCampaignsList(prev => prev.map(c => c.id === id ? { ...c, auto_enabled: enabled } : c));
  }
  const slotRef = useRef(current15mSlot());

  // Fetch both defaults from server; re-fetch when the 15m window rolls over.
  const fetchDefaults = useCallback(() => {
    setLoadingDefaults(true);
    fetch(`${API_BASE}/api/arb/defaults/btc15m`)
      .then(r => r.json())
      .then(d => {
        if (d.kalshi) setExternalUrl(d.kalshi);
        if (d.poly) setPolySlug(d.poly);
        setMeta({
          kalshi: d.kalshiMeta || null,
          poly: d.polyMeta || null,
        });
      })
      .catch(() => {})
      .finally(() => setLoadingDefaults(false));
  }, []);

  useEffect(() => {
    fetchDefaults();
    // Check every 10s if the 15m slot changed; refresh if so
    const iv = setInterval(() => {
      const now = current15mSlot();
      if (now !== slotRef.current) {
        slotRef.current = now;
        fetchDefaults();
      }
    }, 10_000);
    return () => clearInterval(iv);
  }, [fetchDefaults]);
  // Find match: paste one link, AI finds the other
  const [matchInput, setMatchInput] = useState('');
  const [matchLoading, setMatchLoading] = useState(false);
  const [matchError, setMatchError] = useState(null);
  const [savedEvents, setSavedEvents] = useState([]);

  // Load saved events + trades on mount
  useEffect(() => {
    fetch(`${API_BASE}/api/arb/saved-events`)
      .then(r => r.json())
      .then(d => { if (d.events) setSavedEvents(d.events); })
      .catch(() => {});
    fetch(`${API_BASE}/api/arb/trades`)
      .then(r => r.json())
      .then(d => { if (d.trades) setTrades(d.trades); })
      .catch(() => {});
  }, []);

  function applyMatch(d) {
    if (d.kalshiTicker) setExternalUrl(d.kalshiTicker);
    else if (d.kalshiUrl) setExternalUrl(d.kalshiUrl);
    if (d.polyUrl) setPolySlug(d.polyUrl);
    setMeta({
      kalshi: {
        title: d.kalshiTitle || null,
        yesSubtitle: d.kalshiYesSub || null,
        noSubtitle: d.kalshiNoSub || null,
      },
      poly: {
        question: d.polyTitle || null,
        outcomes: d.polyOutcomes || null,
      },
    });
  }

  // Market picker state
  const [marketOptions, setMarketOptions] = useState(null);

  async function resolveAndPick(url) {
    if (!url) return;
    setMatchLoading(true);
    setMatchError(null);
    setMarketOptions(null);
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 15000);
      const r = await fetch(`${API_BASE}/api/arb/resolve-markets`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url, skipAiMatch: true }),
        signal: controller.signal,
      });
      clearTimeout(timeout);
      const d = await r.json();
      if (d.error) { setMatchError(d.error); setMatchLoading(false); return; }
      const ksComplementary = d.kalshiMarkets?.length === 2;
      const needPicker = r.ok && (
        (d.kalshiMarkets?.length > 1 && !ksComplementary) ||
        d.polyMarkets?.length > 1
      );
      if (needPicker) {
        setMarketOptions({ ...d, inputUrl: url });
      }
    } catch {}
    setMatchLoading(false);
  }

  async function findMatch() {
    if (!matchInput.trim()) return;
    setMatchLoading(true);
    setMatchError(null);
    setMarketOptions(null);
    try {
      // First resolve to see all available markets
      const resolveR = await fetch(`${API_BASE}/api/arb/resolve-markets`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url: matchInput.trim() }),
      });
      const resolved = await resolveR.json();
      // Skip picker for Kalshi with exactly 2 complementary markets (same match, one per player)
      const ksComplementary = resolved.kalshiMarkets?.length === 2;
      const needPicker = resolveR.ok && (
        (resolved.kalshiMarkets?.length > 1 && !ksComplementary) ||
        resolved.polyMarkets?.length > 1
      );
      if (needPicker) {
        setMarketOptions({ ...resolved, inputUrl: matchInput.trim() });
        setMatchLoading(false);
        return;
      }

      // Single market or no markets — proceed with AI match
      const r = await fetch(`${API_BASE}/api/arb/find-match`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url: matchInput.trim() }),
      });
      const d = await r.json();
      if (!r.ok || d.error) throw new Error(d.error || r.statusText);
      applyMatch(d);
      setLastMatch(d);
      setMatchInput('');
    } catch (e) {
      setMatchError(e.message);
    } finally {
      setMatchLoading(false);
    }
  }

  async function selectMarket(type, market) {
    console.log('[selectMarket]', type, market.question || market.title, 'tokens:', market.clobTokenIds?.length);
    setMarketOptions(null);
    setMatchInput('');

    if (type === 'kalshi') {
      setExternalUrl(market.ticker);
      setMeta(prev => ({
        ...prev,
        kalshi: { title: market.title, yesSubtitle: market.yesSub, noSubtitle: market.noSub },
      }));
    } else {
      // Poly market selected — update meta + session tokens if running
      setPolySlug(marketOptions?.inputUrl || polySlug);
      setMeta(prev => ({
        ...prev,
        poly: { question: market.question, outcomes: market.outcomes },
      }));

      // Update the running session's tokens to match the selected market
      if (sessionId && market.clobTokenIds?.length >= 2) {
        try {
          const r = await fetch(`${API_BASE}/api/arb/session/${sessionId}/update-poly`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ tokenIds: market.clobTokenIds, outcomes: market.outcomes }),
          });
          const d = await r.json();
          console.log('[selectMarket] Session tokens updated:', d.ok, market.question);
        } catch (e) {
          console.error('[selectMarket] Update failed:', e.message);
        }
      } else {
        console.log('[selectMarket] No session or no tokens — tokens:', market.clobTokenIds?.length, 'session:', sessionId);
      }
    }
  }

  // Current match result (from find-match or manual entry)
  const [lastMatch, setLastMatch] = useState(null);

  async function saveCurrentEvent() {
    const label = meta.poly?.question || meta.kalshi?.title || polySlug || externalUrl || 'Untitled';
    const ev = {
      label,
      kalshiUrl: externalUrl,
      kalshiTicker: externalUrl,
      polyUrl: polySlug,
      kalshiTitle: meta.kalshi?.title || '',
      kalshiYesSub: meta.kalshi?.yesSubtitle || null,
      kalshiNoSub: meta.kalshi?.noSubtitle || null,
      polyTitle: meta.poly?.question || '',
      polyOutcomes: meta.poly?.outcomes || null,
      ...(lastMatch || {}),
      // Always override URLs with current inputs
      kalshiUrl: externalUrl,
      kalshiTicker: externalUrl,
      polyUrl: polySlug,
    };
    ev.label = ev.label || label;
    try {
      await fetch(`${API_BASE}/api/arb/saved-events`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(ev),
      });
      const r = await fetch(`${API_BASE}/api/arb/saved-events`);
      const d = await r.json();
      if (d.events) setSavedEvents(d.events);
    } catch {}
  }

  async function removeSavedEvent(label) {
    await fetch(`${API_BASE}/api/arb/saved-events/${encodeURIComponent(label)}`, { method: 'DELETE' }).catch(() => {});
    setSavedEvents(prev => prev.filter(e => e.label !== label));
  }

  const [sessionId, setSessionId] = useState(null);
  const [running, setRunning] = useState(false);
  const [ticks, setTicks] = useState([]);
  const [error, setError] = useState(null);
  const [book, setBook] = useState(null);
  const [trades, setTrades] = useState([]);

  // Swap poly pairing: false = default (YES+Down, NO+Up), true = swapped (YES+Up, NO+Down)
  const [swapPoly, setSwapPoly] = useState(false);
  const [recurring, setRecurring] = useState(false);
  const [chartExpanded, setChartExpanded] = useState(false);
  // Selected arb strategies for the campaign
  const [selectedCombos, setSelectedCombos] = useState([]);

  function addCombo(combo) {
    const key = `${combo.ksMarket.ticker}-${combo.ksSide}-${combo.polySide}`;
    if (selectedCombos.find(c => c.key === key)) return;
    setSelectedCombos(prev => [...prev, { ...combo, key }]);
  }

  function removeCombo(key) {
    setSelectedCombos(prev => prev.filter(c => c.key !== key));
  }

  // Auto-buy state
  const [autoEnabled, setAutoEnabled] = useState(false);
  const [autoThreshold, setAutoThreshold] = useState(3); // min profit in cents/sh
  const [autoCooldown, setAutoCooldown] = useState(60); // cooldown in seconds
  const [maxShares, setMaxShares] = useState(50); // per-campaign cap (global default is 50)
  const [fillAny, setFillAny] = useState(false);
  const autoCooldownUntil = useRef(0);
  const autoLock = useRef(false);
  const pollRef = useRef(null);
  const bookPollRef = useRef(null);

  const loadSession = useCallback(async (id) => {
    if (!id) return;
    try {
      const r = await fetch(`${API_BASE}/api/arb/session/${id}?limit=900`);
      const d = await readJsonOrThrow(r, 'session');
      if (!r.ok) throw new Error(d.error || r.statusText);
      if (d.error) throw new Error(d.error);
      setTicks(d.ticks || []);
    } catch (e) {
      setError(fetchErrMessage(e, API_BASE));
    }
  }, []);

  const loadBook = useCallback(async (id) => {
    if (!id) return;
    try {
      const r = await fetch(`${API_BASE}/api/arb/book/${id}`);
      if (r.ok) {
        const d = await r.json();
        setBook(d);
      }
    } catch { /* silent */ }
  }, []);

  useEffect(() => {
    if (!sessionId || !running) return;
    pollRef.current = setInterval(() => loadSession(sessionId), 200);
    bookPollRef.current = setInterval(() => loadBook(sessionId), 200);
    loadBook(sessionId);
    return () => {
      if (pollRef.current) clearInterval(pollRef.current);
      if (bookPollRef.current) clearInterval(bookPollRef.current);
    };
  }, [sessionId, running, loadSession, loadBook]);

  // Auto-buy: check on every book update + auto-renew for recurring BTC 15m
  useEffect(() => {
    if (!autoEnabled || !running || !sessionId || !book || autoLock.current) return;

    // Detect settled event (prices at 0/100) and auto-restart
    const ksY = book?.kalshi?.yesAsk;
    const ksN = book?.kalshi?.noAsk;
    const isSettled = (ksY != null && ksY <= 0.02 && ksN != null && ksN >= 0.98) ||
                      (ksY != null && ksY >= 0.98 && ksN != null && ksN <= 0.02);
    if (isSettled && !autoLock.current && Date.now() > autoCooldownUntil.current) {
      autoLock.current = true;
      autoCooldownUntil.current = Date.now() + 30000; // 30s cooldown before next renew attempt
      console.log('[auto] Event settled, renewing in 30s...');
      (async () => {
        try {
          await fetch(`${API_BASE}/api/arb/stop/${sessionId}`, { method: 'POST' });
          setRunning(false);
          // Wait 15s for new slot to open
          await new Promise(r => setTimeout(r, 15000));
          // Fetch new defaults (new 15m slot)
          const dr = await fetch(`${API_BASE}/api/arb/defaults/btc15m`);
          const dd = await dr.json();
          if (dd.kalshi && dd.poly) {
            setExternalUrl(dd.kalshi);
            setPolySlug(dd.poly);
            setMeta({ kalshi: null, poly: null });
            // Start new session
            const sr = await fetch(`${API_BASE}/api/arb/start`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ externalUrl: dd.kalshi, polymarketSlug: dd.poly, feeThreshold: FEE }),
            });
            const sd = await sr.json();
            if (sd.session?.id) {
              setSessionId(sd.session.id);
              setRunning(true);
              setTicks([]);
              setExecResult(null);
              if (sd.meta) setMeta({ kalshi: { title: sd.meta.kalshiTitle }, poly: { question: sd.meta.polyTitle, outcomes: sd.meta.polyOutcomes } });
              autoCooldownUntil.current = Date.now() + 10000; // 10s warmup
              console.log('[auto] Renewed to', sd.session.id.slice(0,8));
            }
          }
        } catch (e) { console.error('[auto] Renew failed:', e.message); }
        autoLock.current = false;
      })();
      return;
    }

    if (Date.now() < autoCooldownUntil.current) return;

    const ksYesAsk = book?.kalshi?.yesAsk;
    const ksNoAsk = book?.kalshi?.noAsk;
    const polyUpAsk = book?.poly?.up?.bestAsk;
    const polyDownAsk = book?.poly?.down?.bestAsk;
    const threshold = autoThreshold / 100; // convert cents to dollars

    // Strategy A: buy Kalshi YES + Poly Down
    const costA = ksYesAsk != null && polyDownAsk != null ? ksYesAsk + polyDownAsk : null;
    const profitA = costA != null ? 1 - FEE - costA : null;

    // Strategy B: buy Kalshi NO + Poly Up
    const costB = ksNoAsk != null && polyUpAsk != null ? ksNoAsk + polyUpAsk : null;
    const profitB = costB != null ? 1 - FEE - costB : null;

    let bestStrategy = null;
    if (fillAny) {
      // Fill at any price — pick whichever side has data, prefer the better one
      if (profitA != null && profitB != null) bestStrategy = profitA >= profitB ? 'A' : 'B';
      else if (profitA != null) bestStrategy = 'A';
      else if (profitB != null) bestStrategy = 'B';
    } else {
      if (profitA != null && profitA >= threshold && (profitB == null || profitA >= profitB)) bestStrategy = 'A';
      else if (profitB != null && profitB >= threshold) bestStrategy = 'B';
    }

    if (bestStrategy) {
      autoLock.current = true;
      const profit = bestStrategy === 'A' ? profitA : profitB;
      console.log(`[auto-arb] Triggering strategy ${bestStrategy}: ${(profit * 100).toFixed(1)}¢/sh profit ${fillAny ? '(FILL ANY)' : ''}`);
      executeArb(bestStrategy, fillAny).then(() => {
        autoCooldownUntil.current = Date.now() + autoCooldown * 1000;
        autoLock.current = false;
      });
    }
  }, [book, autoEnabled, running, sessionId, autoThreshold, autoCooldown]);

  async function start() {
    setError(null);
    try {
      const r = await fetch(`${API_BASE}/api/arb/start`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          externalUrl: externalUrl.trim(),
          polymarketSlug: polySlug.trim(),
          feeThreshold: FEE,
        }),
      });
      const d = await readJsonOrThrow(r, 'start');
      if (!r.ok) throw new Error(d.error || r.statusText);
      setSessionId(d.session.id);
      setRunning(true);
      setTicks([]);
      // Update metadata from server only if not already set by user
      if (d.meta) {
        setMeta(prev => ({
          kalshi: prev.kalshi || { title: d.meta.kalshiTitle || null },
          poly: prev.poly || { question: d.meta.polyTitle || null, outcomes: d.meta.polyOutcomes || null },
        }));
      }
      await loadSession(d.session.id);
      loadTrades();
    } catch (e) {
      setError(fetchErrMessage(e, API_BASE));
    }
  }

  async function stop() {
    if (!sessionId) return;
    setError(null);
    try {
      const r = await fetch(`${API_BASE}/api/arb/stop/${sessionId}`, { method: 'POST' });
      await readJsonOrThrow(r, 'stop');
    } catch (e) {
      setError(fetchErrMessage(e, API_BASE));
    }
    setRunning(false);
    if (pollRef.current) clearInterval(pollRef.current);
    if (bookPollRef.current) clearInterval(bookPollRef.current);
    setBook(null);
    await loadSession(sessionId);
    try {
      const sr = await fetch(`${API_BASE}/api/arb/sessions`);
      const sd = await sr.json();
      if (sd.sessions) setArbSessions(sd.sessions);
    } catch { /* ignore */ }
  }

  async function refreshVenuePnl(sid) {
    if (!sid) return;
    setVenuePnlRefreshing(sid);
    try {
      await fetch(`${API_BASE}/api/arb/session/${sid}/venue-pnl`, { method: 'POST' }).then(r => r.json());
      const sr = await fetch(`${API_BASE}/api/arb/sessions`);
      const sd = await sr.json();
      if (sd.sessions) setArbSessions(sd.sessions);
    } catch { /* ignore */ }
    setVenuePnlRefreshing(null);
  }

  const [executing, setExecuting] = useState(null); // 'A' | 'B' | null
  const [execResult, setExecResult] = useState(null);

  function loadTrades() {
    fetch(`${API_BASE}/api/arb/trades${sessionId ? `?session_id=${sessionId}` : ''}`)
      .then(r => r.json())
      .then(d => { if (d.trades) setTrades(d.trades); })
      .catch(() => {});
  }

  async function executeArb(strategy, marketOrder = false) {
    if (!sessionId || executing) return;
    setExecuting(strategy);
    setExecResult(null);
    try {
      const r = await fetch(`${API_BASE}/api/arb/execute`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sessionId, strategy, swapPoly, marketOrder }),
      });
      const d = await readJsonOrThrow(r, 'execute');
      if (!r.ok) throw new Error(d.error || r.statusText);
      setExecResult(d);
      // Refresh trades log
      setTimeout(loadTrades, 500);
    } catch (e) {
      setExecResult({ success: false, error: fetchErrMessage(e, API_BASE) });
    } finally {
      setExecuting(null);
    }
  }

  const last = ticks.length ? ticks[ticks.length - 1] : null;

  const chartData = useMemo(() => {
    return [...ticks]
      .sort((a, b) => a.unix_s - b.unix_s)
      .map((t) => ({
        unix: t.unix_s,
        time: new Date(t.unix_s * 1000).toLocaleTimeString(undefined, {
          hour: '2-digit',
          minute: '2-digit',
          second: '2-digit',
        }),
        ksYes: t.external_price != null ? Number(t.external_price) : null,
        ksNo: t.external_no_price != null ? Number(t.external_no_price) : null,
        polyYes: t.poly_up != null ? Number(t.poly_up) : null,
        polyNo: t.poly_down != null ? Number(t.poly_down) : null,
      }));
  }, [ticks]);

  // Derive human-readable labels from metadata
  const ksLabel = meta.kalshi?.title || meta.kalshi?.eventTitle || 'Kalshi';
  const polyLabel = meta.poly?.question || 'Polymarket';
  const polyOutcomes = meta.poly?.outcomes || ['Up', 'Down'];
  // For Kalshi yes/no subtitles: if they look like "Target Price: $X" or are empty, fall back to Yes/No
  const rawYesSub = meta.kalshi?.yesSubtitle || '';
  const rawNoSub = meta.kalshi?.noSubtitle || '';
  const ksYesSub = rawYesSub && !/target price/i.test(rawYesSub) && !/^TBD$/i.test(rawYesSub) ? rawYesSub : 'Yes';
  const ksNoSub = rawNoSub && !/target price/i.test(rawNoSub) && !/^TBD$/i.test(rawNoSub) ? rawNoSub : 'No';

  return (
    <div className="rounded-xl border border-amber-900/50 bg-gray-900/80 p-4 space-y-3">
      <div>
        <h2 className="text-sm font-bold text-amber-400">Arb Lab</h2>
        <p className="text-[10px] text-gray-500 mt-1">
          From project root run <code className="text-gray-400">npm run dev</code> (starts API :3001 + Vite :5173), then open{' '}
          <code className="text-gray-400">/arb</code>. Left: Kalshi · Right: Polymarket ·{' '}
          <span className="text-gray-600">{API_BASE || '(browser → /api → :3001)'}</span>
        </p>
      </div>

      {/* Venue P&L from Kalshi /portfolio/fills + Polymarket data-api trades (per ended session) */}
      <div className="border border-emerald-800/50 rounded-lg bg-emerald-950/25 p-2 space-y-1.5">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <span className="text-[11px] font-bold text-emerald-400">Venue P&amp;L (K + Poly)</span>
          <span className="text-[9px] text-gray-500">Direct from APIs · updates after you stop + when markets settle</span>
        </div>
        {arbSessions.filter((s) => s.ended_at).length === 0 ? (
          <p className="text-[10px] text-gray-500">
            No ended sessions yet. Click <span className="text-gray-400">Stop</span> to end a run; venue rows appear here. If the table stays empty after stopping, apply{' '}
            <code className="text-gray-600">scripts/sql/arb_session_venue_pnl.sql</code> to your DB.
          </p>
        ) : (
          <div className="overflow-x-auto -mx-0.5">
            <table className="w-full text-[10px] font-mono border-collapse">
              <thead>
                <tr className="text-gray-500 text-left border-b border-gray-800">
                  <th className="py-1 pr-2 font-normal">Session</th>
                  <th className="py-1 pr-2 font-normal">Ended</th>
                  <th className="py-1 pr-2 font-normal">Kalshi</th>
                  <th className="py-1 pr-2 font-normal">Polymarket</th>
                  <th className="py-1 pr-2 font-normal">Total</th>
                  <th className="py-1 pr-2 font-normal">Status</th>
                  <th className="py-1 font-normal w-14" />
                </tr>
              </thead>
              <tbody>
                {[...arbSessions]
                  .filter((s) => s.ended_at)
                  .sort((a, b) => new Date(b.ended_at) - new Date(a.ended_at))
                  .slice(0, 12)
                  .map((s) => (
                    <tr key={s.id} className={`border-b border-gray-800/80 ${sessionId && s.id === sessionId ? 'bg-amber-950/30' : ''}`}>
                      <td className="py-1 pr-2 max-w-[140px] truncate text-gray-300" title={s.polymarket_slug || s.label || s.id}>
                        {s.label || s.polymarket_slug || s.id?.slice(0, 8)}
                      </td>
                      <td className="py-1 pr-2 text-gray-500 whitespace-nowrap">
                        {s.ended_at ? new Date(s.ended_at).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : '—'}
                      </td>
                      <td className={`py-1 pr-2 ${s.venue_pnl_kalshi != null ? (Number(s.venue_pnl_kalshi) >= 0 ? 'text-green-400' : 'text-red-400') : 'text-gray-600'}`}>
                        {fmtUsd(s.venue_pnl_kalshi)}
                      </td>
                      <td className={`py-1 pr-2 ${s.venue_pnl_polymarket != null ? (Number(s.venue_pnl_polymarket) >= 0 ? 'text-green-400' : 'text-red-400') : 'text-gray-600'}`}>
                        {fmtUsd(s.venue_pnl_polymarket)}
                      </td>
                      <td className={`py-1 pr-2 font-bold ${s.venue_pnl_total != null ? (Number(s.venue_pnl_total) >= 0 ? 'text-green-300' : 'text-red-300') : 'text-gray-600'}`}>
                        {fmtUsd(s.venue_pnl_total)}
                      </td>
                      <td className="py-1 pr-2 text-gray-500">{s.venue_pnl_status || '—'}</td>
                      <td className="py-1">
                        <button
                          type="button"
                          disabled={venuePnlRefreshing === s.id}
                          onClick={() => refreshVenuePnl(s.id)}
                          className="text-[9px] px-1.5 py-0.5 rounded bg-emerald-900/60 text-emerald-300 hover:bg-emerald-800 disabled:opacity-40"
                        >
                          {venuePnlRefreshing === s.id ? '…' : '↻'}
                        </button>
                      </td>
                    </tr>
                  ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* Active campaigns */}
      {campaignsList.filter(c => c.status === 'running').length > 0 && (
        <div className="border border-gray-800 rounded-lg overflow-hidden">
          <div className="bg-gray-900 px-2 py-1.5 text-[10px] font-semibold flex justify-between items-center">
            <span className="text-gray-500">Active Campaigns</span>
            {pnlData?.current && (
              <span className={`text-xs font-bold ${Number(pnlData.current.profit) >= 0 ? 'text-green-400' : 'text-red-400'}`}>
                P&L: {Number(pnlData.current.profit) >= 0 ? '+' : ''}${Number(pnlData.current.profit).toFixed(2)}
                <span className="text-gray-600 font-normal ml-1">(${Number(pnlData.current.total).toFixed(0)} total)</span>
              </span>
            )}
            <span className="text-gray-500">{campaignsList.filter(c => c.status === 'running').length} running</span>
          </div>
          <div className="divide-y divide-gray-800 overflow-x-auto">
            {campaignsList.filter(c => c.status === 'running').map(c => (
              <div key={c.id} className="flex items-center gap-2 px-2 py-1.5 text-[10px] font-mono">
                <button
                  type="button"
                  onClick={() => {
                    // Load this campaign into the main view
                    setExternalUrl(c.kalshi_url);
                    setPolySlug(c.poly_url);
                    setMaxShares(c.max_shares || 50);
                    if (c.session_id) { setSessionId(c.session_id); setRunning(true); }
                  }}
                  className="flex-1 text-left text-amber-400 hover:text-amber-300 truncate"
                >
                  {c.label || c.kalshi_url?.slice(0, 30)}
                  {c.live?.expiration && (
                    <span className="text-gray-600 ml-1">
                      exp {new Date(c.live.expiration).toLocaleString('en-US', { timeZone: 'America/Los_Angeles', hour: 'numeric', minute: '2-digit' })}
                    </span>
                  )}
                </button>
                <span className={`px-1.5 py-0.5 rounded text-[9px] font-bold ${c.auto_enabled ? 'bg-green-700 text-white' : 'bg-gray-700 text-gray-400'}`}>
                  {c.auto_enabled ? 'AUTO' : 'manual'}
                </span>
                {c.recurring && <span className="px-1.5 py-0.5 rounded bg-blue-700 text-white text-[9px] font-bold">recurring</span>}
                {c.swap_poly && <span className="px-1.5 py-0.5 rounded bg-purple-700 text-white text-[9px] font-bold">swapped</span>}
                <span className="flex items-center gap-0.5 text-gray-500">
                  <input
                    type="number"
                    defaultValue={c.auto_threshold_cents}
                    onBlur={(e) => fetch(`${API_BASE}/api/arb/campaigns/${c.id}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ autoThreshold: parseInt(e.target.value) || 4 }) })}
                    className="w-8 bg-transparent border-b border-gray-700 text-center text-[9px] focus:border-amber-500 outline-none"
                  />¢/
                  <input
                    type="number"
                    defaultValue={c.auto_cooldown_sec}
                    onBlur={(e) => fetch(`${API_BASE}/api/arb/campaigns/${c.id}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ autoCooldown: parseInt(e.target.value) || 60 }) })}
                    className="w-10 bg-transparent border-b border-gray-700 text-center text-[9px] focus:border-amber-500 outline-none"
                  />s/
                  <input
                    type="number"
                    defaultValue={c.max_shares ?? 50}
                    onBlur={(e) => fetch(`${API_BASE}/api/arb/campaigns/${c.id}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ maxShares: parseInt(e.target.value) || 50 }) })}
                    className="w-9 bg-transparent border-b border-gray-700 text-center text-[9px] focus:border-amber-500 outline-none"
                  />sh
                </span>
                {c.live?.best != null && (
                  <span className={`px-1 py-0.5 rounded text-[9px] font-bold ${c.live.best > 0 ? 'bg-green-900/50 text-green-400' : 'bg-red-900/30 text-red-400'}`}>
                    A:{c.live.profitA != null ? `${c.live.profitA > 0 ? '+' : ''}${c.live.profitA.toFixed(1)}¢` : '—'}
                    {' '}B:{c.live.profitB != null ? `${c.live.profitB > 0 ? '+' : ''}${c.live.profitB.toFixed(1)}¢` : '—'}
                  </span>
                )}
                <span className="text-gray-500">{c.total_trades || 0} trades</span>
                <span className={`font-bold ${Number(c.total_profit || 0) >= 0 ? 'text-green-400' : 'text-red-400'}`}>
                  {Number(c.total_profit || 0) >= 0 ? '+' : ''}${Number(c.total_profit || 0).toFixed(2)}
                </span>
                <button
                  type="button"
                  onClick={() => toggleCampaignAuto(c.id, !c.auto_enabled)}
                  className="text-[9px] text-blue-400 hover:text-blue-300"
                >
                  {c.auto_enabled ? 'pause' : 'auto'}
                </button>
                <button
                  type="button"
                  onClick={() => stopCampaign(c.id)}
                  className="text-[9px] text-red-400 hover:text-red-300"
                >
                  stop
                </button>
                <span className="border-l border-gray-700 pl-1 flex items-center gap-1">
                  <button
                    type="button"
                    onClick={() => fetch(`${API_BASE}/api/arb/campaigns/${c.id}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ earlyExit: !c.early_exit }) })}
                    className={`text-[9px] px-1 py-0.5 rounded ${c.early_exit ? 'bg-orange-700 text-white' : 'text-gray-600 hover:text-gray-400'}`}
                  >
                    exit
                  </button>
                  {c.early_exit && (
                    <input
                      type="number"
                      defaultValue={c.exit_threshold_cents || 4}
                      onBlur={(e) => fetch(`${API_BASE}/api/arb/campaigns/${c.id}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ exitThreshold: parseInt(e.target.value) || 4 }) })}
                      className="w-7 bg-transparent border-b border-gray-700 text-center text-[9px] text-orange-400 focus:border-orange-500 outline-none"
                    />
                  )}
                </span>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Find match: paste one link */}
      <div className="flex items-center gap-2">
        <input
          className="flex-1 bg-gray-950 border border-gray-700 rounded px-2 py-1.5 font-mono text-[11px] min-w-0"
          placeholder="Paste a Kalshi or Polymarket link — AI finds the match on the other platform"
          value={matchInput}
          onChange={(e) => setMatchInput(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') findMatch(); }}
          spellCheck={false}
          autoComplete="off"
        />
        <button
          type="button"
          onClick={findMatch}
          disabled={matchLoading || !matchInput.trim()}
          className="px-3 py-1.5 rounded bg-blue-600 text-white text-xs font-bold hover:bg-blue-500 disabled:opacity-40 whitespace-nowrap"
        >
          {matchLoading ? 'Searching...' : 'Find match'}
        </button>
      </div>
      {matchError && <div className="text-[10px] text-red-400 font-mono">{matchError}</div>}

      {/* Market picker — shown when multiple markets found */}
      {marketOptions && (
        <div className="border border-amber-700/50 rounded-lg p-3 bg-gray-900/80 space-y-2">
          <div className="text-xs font-bold text-amber-400">Select a market — {marketOptions.eventTitle}</div>
          {marketOptions.kalshiMarkets?.length > 1 && (
            <div className="space-y-1">
              <div className="text-[10px] text-gray-500 font-semibold">Kalshi markets:</div>
              {marketOptions.kalshiMarkets.map((m, i) => (
                <button
                  key={m.ticker}
                  type="button"
                  onClick={() => selectMarket('kalshi', m)}
                  className="block w-full text-left px-2 py-1.5 rounded bg-gray-800 hover:bg-gray-700 border border-gray-700 hover:border-cyan-600 transition-colors"
                >
                  <div className="text-[11px] text-cyan-300">{m.title}</div>
                  <div className="text-[9px] text-gray-500 font-mono">
                    {m.ticker} · bid {m.yesBid} / ask {m.yesAsk}
                    {m.yesSub && !/target price/i.test(m.yesSub) ? ` · YES=${m.yesSub}` : ''}
                  </div>
                </button>
              ))}
            </div>
          )}
          {marketOptions.polyMarkets?.length > 1 && (
            <div className="space-y-1">
              <div className="text-[10px] text-gray-500 font-semibold">Polymarket markets:</div>
              {marketOptions.polyMarkets.map((m, i) => (
                <button
                  key={i}
                  type="button"
                  onClick={() => selectMarket('poly', m)}
                  className="block w-full text-left px-2 py-1.5 rounded bg-gray-800 hover:bg-gray-700 border border-gray-700 hover:border-green-600 transition-colors"
                >
                  <div className="text-[11px] text-green-400">{m.question}</div>
                  <div className="text-[9px] text-gray-500 font-mono">
                    {m.outcomes?.join(' / ')}
                  </div>
                </button>
              ))}
            </div>
          )}
          <button
            type="button"
            onClick={() => setMarketOptions(null)}
            className="text-[10px] text-gray-500 hover:text-gray-300"
          >
            Cancel
          </button>
        </div>
      )}

      {/* Saved matched events */}
      {savedEvents.length > 0 && (
        <div className="flex flex-wrap gap-1.5">
          {savedEvents.map((ev) => (
            <div key={ev.label} className="flex items-center gap-0 group">
              <button
                type="button"
                onClick={() => applyMatch(ev)}
                className="px-2 py-1 rounded-l bg-gray-800 hover:bg-gray-700 border border-r-0 border-gray-700 hover:border-amber-700/50 text-left transition-colors"
                title={`KS: ${ev.kalshiTitle}\nPoly: ${ev.polyTitle}`}
              >
                <div className="text-[10px] text-amber-400 font-semibold">{ev.label}</div>
                <div className="text-[9px] text-gray-500 flex gap-2">
                  <span className="text-cyan-400/70 truncate max-w-[80px]">{ev.kalshiTicker || 'KS'}</span>
                  <span className="text-green-400/70">PM</span>
                </div>
              </button>
              <button
                type="button"
                onClick={() => removeSavedEvent(ev.label)}
                className="px-1 py-1 rounded-r bg-gray-800 hover:bg-red-900/50 border border-l-0 border-gray-700 text-gray-600 hover:text-red-400 text-[10px] opacity-0 group-hover:opacity-100 transition-opacity self-stretch flex items-center"
                title="Remove"
              >
                ×
              </button>
            </div>
          ))}
        </div>
      )}

      {/* Market metadata labels */}
      {(meta.kalshi || meta.poly) && (
        <div className="text-[11px] border border-gray-800 rounded-lg p-2 bg-black/20 space-y-2">
          <div className="flex items-center gap-3">
            <div className="flex flex-wrap gap-4 flex-1">
              <div className="space-y-0.5">
                <div className="flex items-center gap-2">
                  <span className="text-gray-500 font-semibold">Kalshi</span>
                  <button type="button" onClick={() => resolveAndPick(externalUrl)} className="text-[9px] text-blue-400 hover:text-blue-300 hover:underline">change</button>
                </div>
                <div className="text-cyan-300">{ksLabel}</div>
              </div>
              <div className="space-y-0.5">
                <div className="flex items-center gap-2">
                  <span className="text-gray-500 font-semibold">Polymarket</span>
                  <button type="button" onClick={() => resolveAndPick(polySlug)} className="text-[9px] text-blue-400 hover:text-blue-300 hover:underline">change</button>
                </div>
                <div className="text-green-400">{polyLabel}</div>
              </div>
            </div>
          <button
            type="button"
            onClick={saveCurrentEvent}
            className="px-3 py-2 rounded bg-green-700 text-white text-xs font-bold hover:bg-green-600 whitespace-nowrap shrink-0"
          >
            Save
          </button>
          </div>
          {/* Arb pairing — click Swap to flip which poly side pairs with each strategy */}
          <div className="border-t border-gray-800 pt-1.5 space-y-1">
            <div className="flex flex-wrap items-center gap-2 text-[10px]">
              <span className="text-amber-400 font-bold">A:</span>
              <span className="text-cyan-400 font-mono">Kalshi {ksYesSub !== 'Yes' ? ksYesSub : 'YES'}</span>
              <span className="text-gray-600">+</span>
              <span className="text-green-400 font-mono">Poly {swapPoly ? polyOutcomes[0] : polyOutcomes[1]}</span>
              <span className="text-gray-600 mx-1">|</span>
              <span className="text-amber-400 font-bold">B:</span>
              <span className="text-cyan-400 font-mono">Kalshi {ksNoSub !== 'No' ? ksNoSub : 'NO'}</span>
              <span className="text-gray-600">+</span>
              <span className="text-green-400 font-mono">Poly {swapPoly ? polyOutcomes[1] : polyOutcomes[0]}</span>
              <button
                type="button"
                onClick={() => setSwapPoly(!swapPoly)}
                className="ml-2 px-2 py-0.5 rounded bg-purple-700 text-white text-[9px] font-bold hover:bg-purple-600"
              >
                Swap
              </button>
            </div>
          </div>
        </div>
      )}

      <div className="grid grid-cols-1 md:grid-cols-2 gap-2 text-xs">
        <label className="flex flex-col gap-1 min-w-0">
          <span className="text-gray-500">Kalshi {meta.kalshi?.title ? `— ${meta.kalshi.title}` : ''}</span>
          <input
            className="bg-gray-950 border border-gray-700 rounded px-2 py-1.5 font-mono text-[11px] w-full min-w-0"
            placeholder="kalshi.com/…/kxatpmatch-26mar25paufil or KXATPMATCH-…-PAU"
            value={externalUrl}
            onChange={(e) => { setExternalUrl(e.target.value); setMeta(prev => ({ ...prev, kalshi: null })); }}
            spellCheck={false}
            autoComplete="off"
          />
        </label>
        <label className="flex flex-col gap-1 min-w-0">
          <span className="text-gray-500">Polymarket {meta.poly?.question ? `— ${meta.poly.question}` : ''}</span>
          <input
            className="bg-gray-950 border border-gray-700 rounded px-2 py-1.5 font-mono text-[11px] w-full min-w-0"
            placeholder="polymarket.com/…/atp-paul-fils-2026-03-25 or slug only"
            value={polySlug}
            onChange={(e) => { setPolySlug(e.target.value); setMeta(prev => ({ ...prev, poly: null })); }}
            spellCheck={false}
            autoComplete="off"
          />
        </label>
      </div>

      {error && <div className="text-xs text-red-400 font-mono">{error}</div>}

      <div className="flex flex-wrap items-center gap-2">
        {!running ? (
          <button type="button" onClick={start} disabled={loadingDefaults} className="px-4 py-2 rounded-lg bg-amber-600 text-white text-xs font-bold hover:bg-amber-500 disabled:opacity-50">
            {loadingDefaults ? 'Loading…' : 'Start 500ms sampling'}
          </button>
        ) : (
          <button type="button" onClick={stop} className="px-4 py-2 rounded-lg bg-red-700 text-white text-xs font-bold hover:bg-red-600">
            Stop
          </button>
        )}
        {!running && (
          <button type="button" onClick={fetchDefaults} disabled={loadingDefaults} className="px-3 py-2 rounded-lg bg-gray-700 text-gray-300 text-xs hover:bg-gray-600 disabled:opacity-50">
            Refresh defaults
          </button>
        )}

        {/* Auto-buy controls */}
        <div className="flex items-center gap-2 ml-2 border-l border-gray-700 pl-2">
          <button
            type="button"
            onClick={() => setAutoEnabled(!autoEnabled)}
            className={`px-3 py-1.5 rounded text-xs font-bold ${autoEnabled ? 'bg-green-600 text-white animate-pulse' : 'bg-gray-700 text-gray-400 hover:bg-gray-600'}`}
          >
            {autoEnabled ? 'AUTO ON' : 'Auto'}
          </button>
          <label className="flex items-center gap-1 text-[10px] text-gray-500">
            <span>min</span>
            <input
              type="number"
              value={autoThreshold}
              onChange={(e) => setAutoThreshold(Math.max(1, parseInt(e.target.value) || 1))}
              className="w-10 bg-gray-900 border border-gray-700 rounded px-1 py-0.5 text-center text-[10px]"
            />
            <span>¢/sh</span>
          </label>
          <label className="flex items-center gap-1 text-[10px] text-gray-500">
            <span>cool</span>
            <input
              type="number"
              value={autoCooldown}
              onChange={(e) => setAutoCooldown(Math.max(5, parseInt(e.target.value) || 60))}
              className="w-12 bg-gray-900 border border-gray-700 rounded px-1 py-0.5 text-center text-[10px]"
            />
            <span>s</span>
          </label>
          <label className="flex items-center gap-1 text-[10px] text-gray-500">
            <span>max</span>
            <input
              type="number"
              value={maxShares}
              onChange={(e) => setMaxShares(Math.max(1, parseInt(e.target.value) || 50))}
              className="w-12 bg-gray-900 border border-gray-700 rounded px-1 py-0.5 text-center text-[10px]"
            />
            <span>sh</span>
          </label>
          {autoEnabled && Date.now() < autoCooldownUntil.current && (
            <span className="text-[10px] text-yellow-400">cooling...</span>
          )}
          <label className="flex items-center gap-1 text-[10px] text-gray-500">
            <input type="checkbox" checked={recurring} onChange={(e) => setRecurring(e.target.checked)} className="rounded" />
            <span>recurring</span>
          </label>
          <label className="flex items-center gap-1 text-[10px] text-gray-500">
            <input type="checkbox" checked={fillAny} onChange={(e) => setFillAny(e.target.checked)} className="rounded" />
            <span className={fillAny ? 'text-red-400 font-bold' : ''}>fill any</span>
          </label>
          <button
            type="button"
            onClick={createCampaign}
            disabled={!externalUrl.trim() || !polySlug.trim()}
            className="px-3 py-1.5 rounded bg-blue-600 text-white text-xs font-bold hover:bg-blue-500 disabled:opacity-40 whitespace-nowrap"
          >
            {recurring ? 'Launch Recurring' : 'Launch Campaign'}
          </button>
        </div>
      </div>

      {last && (() => {
        const SHARES = 5;

        // Live tick prices (real-time from WS)
        const ksY = last.external_price != null ? Number(last.external_price) : null;
        const ksN = last.external_no_price != null ? Number(last.external_no_price) : null;
        const pDown = last.poly_down != null ? Number(last.poly_down) : null;
        const pUp = last.poly_up != null ? Number(last.poly_up) : null;

        // Execution prices: use REAL ask from book when available, fallback to mid+1¢
        const ksYesAskBook = book?.kalshi?.yesAsk;
        const ksNoAskBook = book?.kalshi?.noAsk;
        const polyUpAskBook = book?.poly?.up?.bestAsk;
        const polyDownAskBook = book?.poly?.down?.bestAsk;

        const execKsY = ksYesAskBook ?? (ksY != null ? Math.min(0.99, Math.round(ksY * 100 + 1) / 100) : null);
        const execKsN = ksNoAskBook ?? (ksN != null ? Math.min(0.99, Math.round(ksN * 100 + 1) / 100) : null);
        const execPDown = polyDownAskBook ?? (pDown != null ? Math.min(0.99, Math.round((pDown + 0.01) * 100) / 100) : null);
        const execPUp = polyUpAskBook ?? (pUp != null ? Math.min(0.99, Math.round((pUp + 0.01) * 100) / 100) : null);

        // Strategy A: buy Kalshi YES + Poly Down at real ask prices
        const costA = execKsY != null && execPDown != null ? execKsY + execPDown : null;
        const profitAper = costA != null ? 1 - FEE - costA : null;
        const profitA5 = profitAper != null ? profitAper * SHARES : null;
        // Strategy B: buy Kalshi NO + Poly Up at real ask prices
        const costB = execKsN != null && execPUp != null ? execKsN + execPUp : null;
        const profitBper = costB != null ? 1 - FEE - costB : null;
        const profitB5 = profitBper != null ? profitBper * SHARES : null;

        // Multi-market combos — only OPPOSITE side pairs (real arbs)
        const allKs = book?.allKalshi;
        const combos = [];
        if (allKs?.length > 1 && polyOutcomes?.length >= 2) {
          for (const km of allKs) {
            const ksName = (km.yesSub || km.ticker?.split('-').pop() || '').toLowerCase();
            const polyName0 = (polyOutcomes[0] || '').toLowerCase();
            const polyName1 = (polyOutcomes[1] || '').toLowerCase();

            // Determine which Poly outcome this Kalshi market's YES matches
            // KS YES = this player wins. Find which Poly outcome is the SAME player.
            const yesMatchesPoly0 = ksName && polyName0 && (ksName.includes(polyName0.slice(0,4)) || polyName0.includes(ksName.slice(0,4)));
            const yesMatchesPoly1 = ksName && polyName1 && (ksName.includes(polyName1.slice(0,4)) || polyName1.includes(ksName.slice(0,4)));

            const yAsk = km.yesAsk;
            const nAsk = km.noAsk;

            // ARB: KS YES (this player wins) + Poly OPPOSITE player
            if (yAsk != null) {
              const oppPolyPrice = yesMatchesPoly0 ? execPDown : yesMatchesPoly1 ? execPUp : null;
              const oppPolyName = yesMatchesPoly0 ? polyOutcomes[1] : yesMatchesPoly1 ? polyOutcomes[0] : null;
              if (oppPolyPrice != null) {
                const cost = yAsk + oppPolyPrice;
                combos.push({ ksMarket: km, ksSide: 'YES', ksPrice: yAsk, polySide: oppPolyName, polyPrice: oppPolyPrice, cost, profit: 1 - FEE - cost, isArb: true });
              }
            }
            // ARB: KS NO (this player loses = other wins) + Poly SAME player
            if (nAsk != null) {
              const samePolyPrice = yesMatchesPoly0 ? execPUp : yesMatchesPoly1 ? execPDown : null;
              const samePolyName = yesMatchesPoly0 ? polyOutcomes[0] : yesMatchesPoly1 ? polyOutcomes[1] : null;
              if (samePolyPrice != null) {
                const cost = nAsk + samePolyPrice;
                combos.push({ ksMarket: km, ksSide: 'NO', ksPrice: nAsk, polySide: samePolyName, polyPrice: samePolyPrice, cost, profit: 1 - FEE - cost, isArb: true });
              }
            }
          }
          combos.sort((a, b) => b.profit - a.profit);
        }

        // Book depth for fill indicators
        const ksYesAskQty = book?.kalshi?.yesAskQty;
        const ksNoAskQty = book?.kalshi?.noAskQty;
        const polyDownDepth = book?.poly?.down?.depthAt1c;
        const polyUpDepth = book?.poly?.up?.depthAt1c;

        // Strategy A fills: need Kalshi YES ask depth >= 5 AND Poly Down ask depth >= 5
        const ksAFills = ksYesAskQty != null ? ksYesAskQty >= SHARES : null;
        const polyAFills = polyDownDepth != null ? polyDownDepth >= SHARES : null;
        // Strategy B fills: need Kalshi NO ask depth >= 5 AND Poly Up ask depth >= 5
        const ksBFills = ksNoAskQty != null ? ksNoAskQty >= SHARES : null;
        const polyBFills = polyUpDepth != null ? polyUpDepth >= SHARES : null;

        // Book prices for display
        const ksData = book?.kalshi || {};
        const polyUpData = book?.poly?.up || {};
        const polyDownData = book?.poly?.down || {};

        function fillBadge(label, bidPrice, bidQty, askPrice, askQty, fills) {
          if (bidPrice == null && askPrice == null) return <span className="text-gray-600 text-[9px]">{label}: —</span>;
          const bp = bidPrice != null ? (bidPrice * 100).toFixed(0) : '—';
          const ap = askPrice != null ? (askPrice * 100).toFixed(0) : '—';
          const bq = bidQty != null ? Math.floor(bidQty) : '';
          const aq = askQty != null ? Math.floor(askQty) : '';
          return (
            <span className={`text-[9px] font-mono ${fills ? 'text-green-500' : fills === false ? 'text-red-400' : 'text-gray-400'}`}>
              {label}: <span className="text-blue-400">{bp}¢</span>{bq ? <span className="text-gray-600">×{bq}</span> : ''}
              {' / '}
              <span className="text-orange-400">{ap}¢</span>{aq ? <span className="text-gray-600">×{aq}</span> : ''}
              {fills === false ? ' thin!' : ''}
            </span>
          );
        }

        return (
          <div className="space-y-2 border border-gray-800 rounded-lg p-2 bg-black/30">
            <div className="flex flex-wrap gap-2 text-[11px] font-mono">
              <span className="text-gray-500">Latest</span>
              <span className="text-cyan-300">KS {ksYesSub} {cents(last.external_price)}</span>
              <span className="text-cyan-500/90">KS {ksNoSub} {cents(last.external_no_price)}</span>
              <span className="text-green-400">Poly {polyOutcomes[0]} {cents(last.poly_up)}</span>
              <span className="text-rose-400">Poly {polyOutcomes[1]} {cents(last.poly_down)}</span>
            </div>
            {/* Strategy A/B — only for simple events (no multi-market combos) */}
            {combos.length === 0 && <>
            {/* Strategy A */}
            <div className="border-t border-gray-800/60 pt-1 space-y-0.5">
              <div className="flex flex-wrap items-center gap-2 text-[11px] font-mono">
                <span className="text-gray-500">A:</span>
                <span className="text-gray-400">KS {ksYesSub} {execKsY != null ? `${(execKsY*100).toFixed(0)}¢` : '—'} + P {polyOutcomes[1]} {execPDown != null ? `${(execPDown*100).toFixed(0)}¢` : '—'} = {costA != null ? cents(costA) : '—'}</span>
                <span className={profitAper != null && profitAper > 0 ? 'text-green-400 font-bold' : profitAper != null && profitAper < 0 ? 'text-red-400' : 'text-gray-500'}>
                  {profitAper != null ? `${profitAper > 0 ? '+' : ''}${(profitAper * 100).toFixed(2)}¢/sh` : '—'}
                </span>
                {profitA5 != null && (
                  <span className={profitA5 > 0 ? 'text-green-300' : 'text-red-300'}>
                    ({profitA5 > 0 ? '+' : ''}${(profitA5).toFixed(2)} for {SHARES})
                  </span>
                )}
                {running && (
                  <>
                    <button
                      type="button"
                      onClick={() => executeArb('A')}
                      disabled={!!executing || costA == null}
                      className="ml-1 px-2.5 py-1 rounded bg-amber-600 text-white text-[10px] font-bold hover:bg-amber-500 disabled:opacity-40"
                    >
                      {executing === 'A' ? 'Sending...' : `Buy ${SHARES} both sides`}
                    </button>
                  </>
                )}
                {!selectedCombos.find(c => c.key === 'strategy-A') ? (
                  <button type="button" onClick={() => addCombo({ key: 'strategy-A', strategy: 'A', ksMarket: { ticker: 'primary', yesSub: ksYesSub }, ksSide: 'YES', ksPrice: execKsY, polySide: polyOutcomes[swapPoly ? 0 : 1], polyPrice: execPDown })} className="w-5 h-5 rounded bg-gray-800 text-gray-500 hover:bg-gray-700 text-[10px] font-bold">+</button>
                ) : (
                  <button type="button" onClick={() => removeCombo('strategy-A')} className="w-5 h-5 rounded bg-amber-600 text-white text-[10px] font-bold">−</button>
                )}
              </div>
              {book && (
                <div className="flex flex-wrap gap-3 ml-6 font-mono">
                  {fillBadge(`KS ${ksYesSub}`, ksData.yesBid, ksData.yesBidQty, ksData.yesAsk, ksData.yesAskQty, ksAFills)}
                  {fillBadge(`P ${polyOutcomes[1]}`, polyDownData.bestBid, polyDownData.bestBidQty, polyDownData.bestAsk, polyDownData.bestAskQty, polyAFills)}
                  {ksAFills != null && polyAFills != null && (
                    <span className={`text-[9px] font-bold ${ksAFills && polyAFills ? 'text-green-400' : 'text-yellow-400'}`}>
                      {ksAFills && polyAFills ? 'WILL FILL' : 'MAY NOT FILL'}
                    </span>
                  )}
                </div>
              )}
            </div>
            {/* Strategy B */}
            <div className="border-t border-gray-800/60 pt-1 space-y-0.5">
              <div className="flex flex-wrap items-center gap-2 text-[11px] font-mono">
                <span className="text-gray-500">B:</span>
                <span className="text-gray-400">KS {ksNoSub} {execKsN != null ? `${(execKsN*100).toFixed(0)}¢` : '—'} + P {polyOutcomes[0]} {execPUp != null ? `${(execPUp*100).toFixed(0)}¢` : '—'} = {costB != null ? cents(costB) : '—'}</span>
                <span className={profitBper != null && profitBper > 0 ? 'text-green-400 font-bold' : profitBper != null && profitBper < 0 ? 'text-red-400' : 'text-gray-500'}>
                  {profitBper != null ? `${profitBper > 0 ? '+' : ''}${(profitBper * 100).toFixed(2)}¢/sh` : '—'}
                </span>
                {profitB5 != null && (
                  <span className={profitB5 > 0 ? 'text-green-300' : 'text-red-300'}>
                    ({profitB5 > 0 ? '+' : ''}${(profitB5).toFixed(2)} for {SHARES})
                  </span>
                )}
                {running && (
                  <>
                    <button
                      type="button"
                      onClick={() => executeArb('B')}
                      disabled={!!executing || costB == null}
                      className="ml-1 px-2.5 py-1 rounded bg-amber-600 text-white text-[10px] font-bold hover:bg-amber-500 disabled:opacity-40"
                    >
                      {executing === 'B' ? 'Sending...' : `Buy ${SHARES} both sides`}
                    </button>
                  </>
                )}
                {!selectedCombos.find(c => c.key === 'strategy-B') ? (
                  <button type="button" onClick={() => addCombo({ key: 'strategy-B', strategy: 'B', ksMarket: { ticker: 'primary', yesSub: ksNoSub }, ksSide: 'NO', ksPrice: execKsN, polySide: polyOutcomes[swapPoly ? 1 : 0], polyPrice: execPUp })} className="w-5 h-5 rounded bg-gray-800 text-gray-500 hover:bg-gray-700 text-[10px] font-bold">+</button>
                ) : (
                  <button type="button" onClick={() => removeCombo('strategy-B')} className="w-5 h-5 rounded bg-amber-600 text-white text-[10px] font-bold">−</button>
                )}
              </div>
              {book && (
                <div className="flex flex-wrap gap-3 ml-6 font-mono">
                  {fillBadge(`KS ${ksNoSub}`, ksData.noBid, ksData.noBidQty, ksData.noAsk, ksData.noAskQty, ksBFills)}
                  {fillBadge(`P ${polyOutcomes[0]}`, polyUpData.bestBid, polyUpData.bestBidQty, polyUpData.bestAsk, polyUpData.bestAskQty, polyBFills)}
                  {ksBFills != null && polyBFills != null && (
                    <span className={`text-[9px] font-bold ${ksBFills && polyBFills ? 'text-green-400' : 'text-yellow-400'}`}>
                      {ksBFills && polyBFills ? 'WILL FILL' : 'MAY NOT FILL'}
                    </span>
                  )}
                </div>
              )}
            </div>
            </>}
            {/* All combos for multi-market events */}
            {combos.length > 0 && (
              <div className="border-t border-gray-800/60 pt-1 space-y-0.5">
                <div className="text-[10px] text-gray-500 font-semibold">All combinations (sorted by profit):</div>
                {combos.map((c, i) => {
                  const p5 = c.profit * SHARES;
                  const ksName = c.ksMarket.yesSub || c.ksMarket.ticker?.split('-').pop();
                  const key = `${c.ksMarket.ticker}-${c.ksSide}-${c.polySide}`;
                  const isSelected = selectedCombos.find(sc => sc.key === key);
                  return (
                    <div key={i} className={`flex flex-wrap items-center gap-2 text-[10px] font-mono ${isSelected ? 'bg-amber-900/20 rounded px-1' : ''}`}>
                      <button
                        type="button"
                        onClick={() => isSelected ? removeCombo(key) : addCombo(c)}
                        className={`w-5 h-5 rounded text-[10px] font-bold ${isSelected ? 'bg-amber-600 text-white' : 'bg-gray-800 text-gray-500 hover:bg-gray-700'}`}
                      >
                        {isSelected ? '−' : '+'}
                      </button>
                      <span className="text-cyan-400">KS {ksName} {c.ksSide} {(c.ksPrice*100).toFixed(0)}¢</span>
                      <span className="text-gray-600">+</span>
                      <span className="text-green-400">Poly {c.polySide} {(c.polyPrice*100).toFixed(0)}¢</span>
                      <span className="text-gray-600">= {(c.cost*100).toFixed(0)}¢</span>
                      <span className={`font-bold ${c.profit > 0 ? 'text-green-400' : 'text-red-400'}`}>
                        {c.profit > 0 ? '+' : ''}{(c.profit*100).toFixed(0)}¢/sh ({p5 > 0 ? '+' : ''}${p5.toFixed(2)})
                      </span>
                      {running && c.profit > 0 && (
                        <button
                          type="button"
                          onClick={() => executeArb(c.ksSide === 'YES' ? 'A' : 'B')}
                          disabled={!!executing}
                          className="px-2 py-0.5 rounded bg-amber-600 text-white text-[9px] font-bold hover:bg-amber-500 disabled:opacity-40"
                        >
                          Buy 5
                        </button>
                      )}
                    </div>
                  );
                })}
              </div>
            )}

            {/* Selected strategies */}
            {selectedCombos.length > 0 && (
              <div className="border-t border-amber-700/50 pt-1 space-y-0.5">
                <div className="text-[10px] text-amber-400 font-semibold">Selected strategies ({selectedCombos.length}):</div>
                {selectedCombos.map((c) => {
                  const ksName = c.ksMarket.yesSub || c.ksMarket.ticker?.split('-').pop();
                  return (
                    <div key={c.key} className="flex items-center gap-2 text-[10px] font-mono">
                      <button type="button" onClick={() => removeCombo(c.key)} className="text-red-400 hover:text-red-300 text-[10px]">×</button>
                      <span className="text-cyan-400">KS {ksName} {c.ksSide}</span>
                      <span className="text-gray-600">+</span>
                      <span className="text-green-400">Poly {c.polySide}</span>
                    </div>
                  );
                })}
              </div>
            )}
            {(last.error_external || last.error_poly) && (
              <div className="text-[10px] text-red-400 font-mono space-y-0.5">
                {last.error_external && <div>Kalshi: {last.error_external}</div>}
                {last.error_poly && <div>Polymarket: {last.error_poly}</div>}
              </div>
            )}
            {execResult && (
              <div className={`text-[11px] font-mono p-2 rounded border ${execResult.success ? 'border-green-700 bg-green-900/30' : 'border-red-700 bg-red-900/30'}`}>
                {execResult.error ? (
                  <div className="text-red-400">Execute error: {execResult.error}</div>
                ) : (
                  <div className="space-y-1">
                    <div className="font-bold text-xs">
                      {execResult.success
                        ? <span className="text-green-400">BOTH ORDERS SENT — {meta.kalshi?.title || meta.poly?.question || ''}</span>
                        : <span className="text-yellow-400">PARTIAL — check below</span>
                      }
                    </div>
                    <div className={execResult.kalshi?.ok ? 'text-green-400' : 'text-red-400'}>
                      {execResult.kalshi?.ok ? '  ' : '  '}
                      Kalshi {execResult.kalshi?.side?.toUpperCase()} {execResult.kalshi?.fillCount || 0}/{execResult.kalshi?.shares}sh
                      {' '}limit {execResult.kalshi?.limitPrice}¢
                      {execResult.kalshi?.filled ? ` → filled avg ${execResult.kalshi.avgFillPrice}¢` : ''}
                      {execResult.kalshi?.remaining > 0 ? ` (${execResult.kalshi.remaining} resting)` : ''}
                      {' '}[{execResult.kalshi?.status}]
                      {execResult.kalshi?.orderId ? ` #${execResult.kalshi.orderId.slice(0,8)}` : ''}
                      {!execResult.kalshi?.ok && ` — ${execResult.kalshi?.error}`}
                    </div>
                    <div className={execResult.poly?.ok ? 'text-green-400' : 'text-red-400'}>
                      {execResult.poly?.ok ? '  ' : '  '}
                      Poly {execResult.poly?.side?.toUpperCase()} {execResult.poly?.fillCount || execResult.poly?.shares}/{execResult.poly?.shares}sh
                      {' '}limit {(execResult.poly?.limitPrice * 100).toFixed(0)}¢
                      {execResult.poly?.avgFillPrice ? ` → filled avg ${(execResult.poly.avgFillPrice * 100).toFixed(0)}¢` : ''}
                      {' '}[{execResult.poly?.status}]
                      {execResult.poly?.orderId ? ` #${execResult.poly.orderId.slice(0,8)}` : ''}
                      {!execResult.poly?.ok && ` — ${execResult.poly?.error}`}
                    </div>
                    {execResult.kalshi?.ok && execResult.poly?.ok && (() => {
                      const ksPrice = execResult.kalshi.filled ? execResult.kalshi.avgFillPrice : execResult.kalshi.limitPrice;
                      const polyFill = execResult.poly.avgFillPrice || execResult.poly.limitPrice;
                      const totalCost = (ksPrice / 100 + polyFill) * execResult.kalshi.shares;
                      const payout = 1 * execResult.kalshi.shares;
                      const netProfit = payout - FEE * execResult.kalshi.shares - totalCost;
                      return (
                        <div className="border-t border-gray-700 pt-1 mt-1 text-xs">
                          Cost: ${totalCost.toFixed(2)} | Payout: ${payout.toFixed(2)} | Fee: ${(FEE * execResult.kalshi.shares).toFixed(2)} |{' '}
                          <span className={netProfit > 0 ? 'text-green-400 font-bold' : 'text-red-400 font-bold'}>
                            Net: {netProfit > 0 ? '+' : ''}${netProfit.toFixed(2)}
                          </span>
                          {!execResult.kalshi.filled && <span className="text-yellow-400"> (estimated — Kalshi resting)</span>}
                        </div>
                      );
                    })()}
                  </div>
                )}
              </div>
            )}
          </div>
        );
      })()}

      {chartData.length > 0 && (
        <div className="h-64 w-full border border-gray-800 rounded-lg bg-gray-950/50 p-2">
          <ResponsiveContainer width="100%" height="100%">
            <LineChart data={chartData} margin={{ top: 8, right: 8, left: 0, bottom: 0 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="#374151" />
              <XAxis dataKey="time" tick={{ fontSize: 9, fill: '#9ca3af' }} interval="preserveStartEnd" />
              <YAxis domain={[0, 1]} tickFormatter={(v) => `${(v * 100).toFixed(0)}¢`} tick={{ fontSize: 9, fill: '#9ca3af' }} width={36} />
              <Tooltip
                contentStyle={{ background: '#111827', border: '1px solid #374151', fontSize: 11 }}
                formatter={(v) => (v != null ? `${(Number(v) * 100).toFixed(2)}¢` : '—')}
              />
              <Legend wrapperStyle={{ fontSize: 10 }} />
              <Line type="monotone" dataKey="ksYes" name={`KS ${ksYesSub}`} stroke="#22d3ee" strokeWidth={2} dot={false} isAnimationActive={false} connectNulls />
              <Line type="monotone" dataKey="ksNo" name={`KS ${ksNoSub}`} stroke="#0891b2" strokeWidth={2} dot={false} isAnimationActive={false} connectNulls />
              <Line type="monotone" dataKey="polyYes" name={`Poly ${polyOutcomes[0]}`} stroke="#4ade80" strokeWidth={2} dot={false} isAnimationActive={false} connectNulls />
              <Line type="monotone" dataKey="polyNo" name={`Poly ${polyOutcomes[1]}`} stroke="#fb7185" strokeWidth={2} dot={false} isAnimationActive={false} connectNulls />
            </LineChart>
          </ResponsiveContainer>
        </div>
      )}

      <div className="overflow-x-auto max-h-80 overflow-y-auto border border-gray-800 rounded-lg">
        <table className="w-full text-[10px] font-mono">
          <thead className="sticky top-0 bg-gray-900 text-gray-500">
            <tr>
              <th className="text-left p-1.5">unix</th>
              <th className="text-left p-1.5">KS {ksYesSub}</th>
              <th className="text-left p-1.5">KS {ksNoSub}</th>
              <th className="text-left p-1.5">P {polyOutcomes[0]}</th>
              <th className="text-left p-1.5">P {polyOutcomes[1]}</th>
            </tr>
          </thead>
          <tbody>
            {ticks.length === 0 && (
              <tr>
                <td colSpan={5} className="p-3 text-gray-600">
                  {running ? 'Collecting…' : 'Start a session to log second-by-second prices.'}
                </td>
              </tr>
            )}
            {[...ticks].reverse().map((t, i) => (
              <tr key={t.id != null ? String(t.id) : `r-${i}-${t.unix_s}`} className="border-t border-gray-800/80">
                <td className="p-1 text-gray-500">{t.unix_s}</td>
                <td className="p-1 text-cyan-300/90">{fmt(t.external_price)}</td>
                <td className="p-1 text-cyan-600/90">{fmt(t.external_no_price)}</td>
                <td className="p-1 text-green-400/90">{fmt(t.poly_up)}</td>
                <td className="p-1 text-rose-400/90">{fmt(t.poly_down)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {/* Trade log */}
      {trades.length > 0 && (
        <div className="border border-gray-800 rounded-lg overflow-hidden">
          <div className="bg-gray-900 px-2 py-1.5 text-[10px] text-gray-500 font-semibold">Trade Log</div>
          <div className="overflow-x-auto max-h-48 overflow-y-auto">
            <table className="w-full text-[10px] font-mono">
              <thead className="sticky top-0 bg-gray-900 text-gray-500">
                <tr>
                  <th className="text-left p-1.5">Time</th>
                  <th className="text-left p-1.5">Strategy</th>
                  <th className="text-left p-1.5">Kalshi</th>
                  <th className="text-left p-1.5">Event</th>
                  <th className="text-left p-1.5">Poly</th>
                  <th className="text-left p-1.5">Cost</th>
                  <th className="text-left p-1.5">Profit</th>
                </tr>
              </thead>
              <tbody>
                {trades.map((t) => (
                  <tr key={t.id} className="border-t border-gray-800/80">
                    <td className="p-1 text-gray-500">{new Date(t.ts).toLocaleTimeString()}</td>
                    <td className="p-1 text-amber-400">{t.strategy}</td>
                    <td className="p-1 text-gray-400 text-[9px] max-w-[140px] truncate" title={t.kalshi_ticker}>
                      {(() => {
                        const tk = t.kalshi_ticker || '';
                        // BTC15M/ETH15M/SOL15M → "BTC 15m 9:45PM"
                        const m15 = tk.match(/KX(BTC|ETH|SOL)(\d+)M-\d{2}[A-Z]{3}\d{2}(\d{2})(\d{2})-/i);
                        if (m15) {
                          const tf = parseInt(m15[2]);
                          const h = parseInt(m15[3]); const mn = parseInt(m15[4]);
                          const endMn = mn + tf; const endH = h + Math.floor(endMn / 60);
                          const eMn = endMn % 60; const eH = endH % 24;
                          const fmt = (hh, mm) => { const ap = hh >= 12 ? 'PM' : 'AM'; const h12 = hh > 12 ? hh - 12 : hh === 0 ? 12 : hh; return `${h12}:${String(mm).padStart(2,'0')}${ap}`; };
                          return `${m15[1]} ${tf}m ${fmt(h, mn)}-${fmt(eH, eMn)}`;
                        }
                        // Sports → short name
                        return tk.replace(/^KX/, '').replace(/-\d{2}[A-Z]{3}\d{2}.*/, '').slice(0,15) || '—';
                      })()}
                    </td>
                    <td className={`p-1 ${t.kalshi_filled ? 'text-green-400' : 'text-red-400'}`}>
                      {t.kalshi_side?.toUpperCase()} {t.kalshi_shares}sh
                      {t.kalshi_fill_price ? ` filled ${(Number(t.kalshi_fill_price) * 100).toFixed(0)}¢` : ` limit ${t.kalshi_limit_cents}¢`}
                      {t.kalshi_error ? ` — ${t.kalshi_error}` : ''}
                      {t.kalshi_order_id ? ` #${t.kalshi_order_id.slice(0,8)}` : ''}
                    </td>
                    <td className={`p-1 ${t.poly_filled ? 'text-green-400' : 'text-red-400'}`}>
                      {t.poly_side?.toUpperCase()} {t.poly_shares}sh
                      {t.poly_fill_price ? ` filled ${(Number(t.poly_fill_price) * 100).toFixed(0)}¢` : t.poly_limit_price != null ? ` limit ${(Number(t.poly_limit_price) * 100).toFixed(0)}¢` : ''}
                      {t.poly_error ? ` — ${t.poly_error}` : ''}
                      {t.poly_order_id ? ` #${t.poly_order_id.slice(0,8)}` : ''}
                    </td>
                    <td className="p-1 text-gray-400">${Number(t.total_cost || 0).toFixed(2)}</td>
                    <td className={`p-1 font-bold ${Number(t.expected_profit || 0) >= 0 ? 'text-green-400' : 'text-red-400'}`}>
                      {Number(t.expected_profit || 0) >= 0 ? '+' : ''}${Number(t.expected_profit || 0).toFixed(2)}
                      {!t.both_filled && <span className="text-yellow-400 font-normal"> (partial)</span>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* Pre-Market Snipes */}
      <div className="border border-gray-800 rounded-lg overflow-hidden">
        <div className="bg-gray-900 px-2 py-1.5 text-[10px] font-semibold flex justify-between items-center">
          <span className="text-amber-400">Pre-Market Snipes</span>
          <span className="text-gray-500">{snipes.filter(s => s.active).length} active</span>
        </div>

        {/* Add snipe form */}
        <div className="flex items-center gap-1 px-2 py-1.5 border-b border-gray-800 text-[10px]">
          <select
            value={snipeForm.asset}
            onChange={e => setSnipeForm(f => ({ ...f, asset: e.target.value }))}
            className="bg-gray-800 text-gray-300 rounded px-1.5 py-1 border border-gray-700 text-[10px]"
          >
            {['btc', 'eth', 'sol', 'xrp', 'hype'].map(a => (
              <option key={a} value={a}>{a.toUpperCase()}</option>
            ))}
          </select>
          <select
            value={snipeForm.side}
            onChange={e => setSnipeForm(f => ({ ...f, side: e.target.value }))}
            className="bg-gray-800 text-gray-300 rounded px-1.5 py-1 border border-gray-700 text-[10px]"
          >
            <option value="up">UP</option>
            <option value="down">DOWN</option>
            <option value="both">BOTH</option>
          </select>
          <input
            type="number"
            step="0.01"
            min="0.01"
            max="0.99"
            placeholder="Price"
            value={snipeForm.limitPrice}
            onChange={e => setSnipeForm(f => ({ ...f, limitPrice: e.target.value }))}
            className="w-14 bg-gray-800 text-gray-300 rounded px-1.5 py-1 border border-gray-700 text-[10px] text-center"
          />
          <span className="text-gray-500">@</span>
          <input
            type="number"
            min="1"
            placeholder="Shares"
            value={snipeForm.shares}
            onChange={e => setSnipeForm(f => ({ ...f, shares: e.target.value }))}
            className="w-12 bg-gray-800 text-gray-300 rounded px-1.5 py-1 border border-gray-700 text-[10px] text-center"
          />
          <span className="text-gray-500">sh</span>
          <span className="text-gray-500 text-[10px]">KS limit</span>
          <input
            type="number"
            step="0.01"
            min="0.01"
            max="0.99"
            placeholder="KS ¢"
            value={snipeForm.kalshiLimit}
            onChange={e => setSnipeForm(f => ({ ...f, kalshiLimit: e.target.value }))}
            className="w-12 bg-gray-800 text-gray-300 rounded px-1.5 py-1 border border-gray-700 text-[10px] text-center"
          />
          <button
            type="button"
            onClick={addSnipe}
            className="px-2 py-1 bg-amber-600 hover:bg-amber-500 text-white rounded text-[10px] font-bold"
          >
            Add
          </button>
        </div>

        {/* Snipes table */}
        {snipes.length > 0 && (
          <div className="overflow-x-auto max-h-48 overflow-y-auto">
            <table className="w-full text-[10px] font-mono">
              <thead className="sticky top-0 bg-gray-900 text-gray-500">
                <tr>
                  <th className="text-left p-1.5">Asset</th>
                  <th className="text-left p-1.5">Side</th>
                  <th className="text-left p-1.5">Limit</th>
                  <th className="text-left p-1.5">Shares</th>
                  <th className="text-left p-1.5">Status</th>
                  <th className="text-left p-1.5">Last Result</th>
                  <th className="text-left p-1.5"></th>
                </tr>
              </thead>
              <tbody>
                {snipes.map(s => (
                  <tr key={s.id} className="border-t border-gray-800/80">
                    <td className="p-1 text-amber-400 font-bold">{s.asset.toUpperCase()}</td>
                    <td className={`p-1 font-bold ${s.side === 'up' ? 'text-green-400' : 'text-red-400'}`}>{s.side.toUpperCase()}</td>
                    <td className="p-1 text-gray-300">{(Number(s.limit_price) * 100).toFixed(0)}¢ <span className="text-gray-500">→ KS {(Number(s.kalshi_limit || 0.51) * 100).toFixed(0)}¢</span></td>
                    <td className="p-1 text-gray-300">{s.shares}</td>
                    <td className="p-1">
                      <span className={`px-1 py-0.5 rounded text-[9px] font-bold ${s.active ? 'bg-green-700 text-white' : 'bg-gray-700 text-gray-400'}`}>
                        {s.active ? 'ACTIVE' : 'OFF'}
                      </span>
                      {s.poly_filled > 0 && (
                        <span className="ml-1 text-green-400">P:{s.poly_filled}</span>
                      )}
                      {s.kalshi_filled > 0 && (
                        <span className="ml-1 text-blue-400">K:{s.kalshi_filled}</span>
                      )}
                    </td>
                    <td className={`p-1 ${
                      s.last_result === 'hedged' ? 'text-green-400' :
                      s.last_result === 'filled' ? 'text-yellow-400' :
                      s.last_result === 'cancelled' ? 'text-gray-500' :
                      s.last_result?.startsWith('hedge_') ? 'text-red-400' :
                      'text-gray-500'
                    }`}>
                      {s.last_result || 'new'}
                    </td>
                    <td className="p-1 flex items-center gap-1">
                      <button
                        type="button"
                        onClick={() => toggleSnipe(s.id, s.active)}
                        className={`px-1.5 py-0.5 rounded text-[9px] font-bold ${s.active ? 'bg-gray-700 text-gray-400 hover:bg-gray-600' : 'bg-green-700 text-white hover:bg-green-600'}`}
                      >
                        {s.active ? 'Pause' : 'Start'}
                      </button>
                      <button
                        type="button"
                        onClick={() => deleteSnipe(s.id)}
                        className="px-1.5 py-0.5 rounded text-[9px] font-bold bg-red-900/50 text-red-400 hover:bg-red-800/50"
                      >
                        X
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {snipes.length === 0 && (
          <div className="px-2 py-3 text-[10px] text-gray-600 text-center">No snipes configured. Add one above.</div>
        )}
      </div>
    </div>
  );
}
