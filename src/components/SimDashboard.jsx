import React, { useEffect, useState, useRef } from 'react';

const REFRESH_MS = 30000; // 30s — sim-dashboard is heavy
const API_BASE   = (import.meta.env.VITE_API_URL || (typeof window !== 'undefined' ? `${window.location.protocol}//${window.location.hostname}:3001` : '')).replace(/\/$/, '');
const SIM_MODES  = [
  '1pct_070',
  '5pct_070',
  '10pct_070',
  '50pct_070',
  '1pct_070_min5',
  '5pct_070_min5',
  '10pct_070_min5',
  '50pct_070_min5',
  '5sh',
  '1usd'
];
const DURATIONS = [
  { value: '', label: 'All' },
  { value: '5m', label: '5m' },
  { value: '15m', label: '15m' },
  { value: '1h', label: '1h' },
];

const SIM_LABELS = {
  '1pct_070': '1% (cum50, +/-1c)',
  '5pct_070': '5% (cum50, +/-1c)',
  '10pct_070': '10% (cum50, +/-1c)',
  '50pct_070': '50% (cum50, +/-1c)',
  '1pct_070_min5': '1% (min5, +/-1c)',
  '5pct_070_min5': '5% (min5, +/-1c)',
  '10pct_070_min5': '10% (min5, +/-1c)',
  '50pct_070_min5': '50% (min5, +/-1c)',
  '5sh': '5 Shares',
  '1usd': '$1',
};

function usd(n)   { return '$' + (n||0).toFixed(2); }
function pri(n)   { return ((n||0) * 100).toFixed(1) + '\u00A2'; }

function parseSlug(slug) {
  try {
    const parts = slug.split('-');
    const epoch = parseInt(parts[parts.length - 1], 10);
    const tf = parts[parts.length - 2] || '';
    const date = new Date(epoch * 1000);
    const valid = !isNaN(epoch) && !isNaN(date.getTime());
    return {
      timeframe: tf,
      epoch: valid ? epoch : NaN,
      timeLabel: valid ? date.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: false }) : '',
      dateLabel: valid ? date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' }) : '',
    };
  } catch {
    return { timeframe: '', epoch: NaN, timeLabel: '', dateLabel: '' };
  }
}

/* ── Up/Down allocation bar ────────────────────────────────────── */
function UDBar({ up, down }) {
  const total = Math.abs(up) + Math.abs(down);
  if (!total) return null;
  const upPct = (Math.abs(up) / total) * 100;
  return (
    <div className="flex h-1.5 rounded-full overflow-hidden">
      <div className="bg-green-500" style={{ width: upPct + '%' }} />
      <div className="bg-red-500"   style={{ width: (100 - upPct) + '%' }} />
    </div>
  );
}

/* ── Winner badge ──────────────────────────────────────────────── */
function WinnerBadge({ resolution }) {
  if (!resolution?.closed || !resolution?.winner) return null;
  const isUp = resolution.winner === 'Up';
  return (
    <span className={`text-[10px] font-bold px-1.5 py-0.5 rounded ${
      isUp ? 'bg-green-500/20 text-green-400' : 'bg-red-500/20 text-red-400'
    }`}>
      {resolution.winner} won
    </span>
  );
}

/* ── Sim mode toggle ───────────────────────────────────────────── */
function SimToggle({ simMode, setSimMode }) {
  return (
    <div className="flex items-center gap-1 bg-gray-800 rounded-lg p-0.5">
      {SIM_MODES.map(mode => (
        <button
          key={mode}
          onClick={() => setSimMode(mode)}
          className={`px-2.5 py-1 text-xs font-mono rounded-md transition-all ${
            simMode === mode
              ? 'bg-orange-500 text-white font-bold'
              : 'text-gray-400 hover:text-gray-200'
          }`}
        >
          {SIM_LABELS[mode]}
        </button>
      ))}
    </div>
  );
}

/* ── Compute P&L for a side given resolution ───────────────────── */
function computePnl(shares, cost, side, resolution) {
  if (!resolution?.closed || !resolution?.winner) return null;
  const won = resolution.winner === side;
  const payout = won ? (shares || 0) : 0;
  const pnl = payout - (cost || 0);
  const pct = cost > 0 ? (pnl / cost * 100) : 0;
  return { won, payout, pnl, pct };
}

/* ── Sim P&L for an event ──────────────────────────────────────── */
function getSimPnl(ev, mode) {
  const sm = ev.sim?.[mode];
  if (!sm) return null;
  const cost = sm.totalCost || 0;
  const realized = sm.totalRealized || 0;
  const upShares = sm.Up?.shares || 0;
  const dnShares = sm.Down?.shares || 0;
  const res = ev.resolution;
  if (res?.closed && res?.winner) {
    const payout = res.winner === 'Up' ? upShares : dnShares;
    return { cost, realized, pnl: payout - cost + realized, resolved: true, upShares, dnShares };
  }
  const ifUpPnl = realized + upShares - cost;
  const ifDnPnl = realized + dnShares - cost;
  return { cost, realized, ifUpPnl, ifDnPnl, resolved: false, upShares, dnShares };
}

/* ── Totals bar ────────────────────────────────────────────────── */
function TotalsBar({ totals, simMode, filteredCount, totalCount }) {
  if (!totals) return null;
  const { totalK9Usdc, totalSellPnl, totalResPnl, totalPnl, eventCount, resolvedCount, simTotals } = totals;
  const st = simTotals?.[simMode];
  const showFiltered = filteredCount != null && totalCount != null && filteredCount !== totalCount;
  const eventsDisplay = showFiltered ? `${filteredCount} of ${totalCount}` : (eventCount || 0);

  return (
    <div className="space-y-3 mb-4">
      <div className="grid grid-cols-3 gap-3">
        <div className="bg-gray-900 rounded-xl p-3 border border-gray-800">
          <div className="text-[10px] uppercase tracking-wider text-gray-500">Events</div>
          <div className="text-lg font-bold font-mono text-white mt-0.5">{eventsDisplay}</div>
          {resolvedCount > 0 && <div className="text-[10px] text-orange-400 mt-0.5">{resolvedCount} resolved</div>}
        </div>
        <div className="bg-gray-900 rounded-xl p-3 border border-gray-800">
          <div className="text-[10px] uppercase tracking-wider text-gray-500">k9 Spent</div>
          <div className="text-lg font-bold font-mono text-white mt-0.5">{usd(totalK9Usdc)}</div>
        </div>
        {st && (
          <div className={`rounded-xl p-3 border ${st.pnl >= 0 ? 'bg-purple-950/30 border-purple-900/50' : 'bg-red-950/30 border-red-900/50'}`}>
            <div className="text-[10px] uppercase tracking-wider text-gray-500">Sim P&L ({SIM_LABELS[simMode]})</div>
            <div className={`text-lg font-bold font-mono mt-0.5 ${st.pnl >= 0 ? 'text-purple-400' : 'text-red-400'}`}>
              {st.pnl >= 0 ? '+' : ''}{usd(st.pnl)}
            </div>
            <div className="text-[10px] text-gray-500 mt-0.5 font-mono">
              cost: {usd(st.cost)} / {resolvedCount} resolved · {st.triggers || 0} trg · {st.fills || 0} fill · {st.pending || 0} pending
            </div>
          </div>
        )}
      </div>
      {(resolvedCount > 0 || totalSellPnl !== 0) && (
        <div className={`rounded-xl p-3 border ${totalPnl >= 0 ? 'bg-green-950/30 border-green-900/50' : 'bg-red-950/30 border-red-900/50'}`}>
          <div className="text-[10px] uppercase tracking-wider text-gray-500">k9 Total P&L</div>
          <div className={`text-lg font-bold font-mono mt-0.5 ${totalPnl >= 0 ? 'text-green-400' : 'text-red-400'}`}>
            {totalPnl >= 0 ? '+' : ''}{usd(totalPnl)}
          </div>
          {(totalSellPnl !== 0 && resolvedCount > 0) && (
            <div className="text-[10px] text-gray-500 mt-0.5 font-mono">
              resolve: {totalResPnl >= 0 ? '+' : ''}{usd(totalResPnl)} / sell: {totalSellPnl >= 0 ? '+' : ''}{usd(totalSellPnl)}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

/* ── Event row (list view) ─────────────────────────────────────── */
function EventRow({ ev, onClick, simMode }) {
  const { slug, summary, totalK9Usdc, resolution } = ev;
  const up = summary?.Up || {};
  const dn = summary?.Down || {};
  const parsed = parseSlug(slug);
  const tradeCount = (up.tradeCount || 0) + (dn.tradeCount || 0);
  const sellPnl = (up.k9SellPnl || 0) + (dn.k9SellPnl || 0);
  const buyShares = (up.k9BuyShares || 0) + (dn.k9BuyShares || 0);
  const sellShares = (up.k9SellShares || 0) + (dn.k9SellShares || 0);

  let resPnl = null;
  if (resolution?.closed && resolution?.winner) {
    const upR = computePnl(up.k9Shares, up.k9Usdc, 'Up', resolution);
    const dnR = computePnl(dn.k9Shares, dn.k9Usdc, 'Down', resolution);
    resPnl = (upR?.pnl || 0) + (dnR?.pnl || 0);
  }

  const sp = getSimPnl(ev, simMode);
  const triggerCount = ev.sim?.[simMode]?.triggerCount || 0;

  return (
    <button
      className="w-full text-left bg-gray-900 rounded-xl border border-gray-800 p-4 hover:border-gray-700 hover:bg-gray-800/50 cursor-pointer transition-all"
      onClick={() => onClick(slug)}
    >
      <div className="flex items-center justify-between mb-2">
        <div className="flex items-center gap-2 min-w-0">
          <span className="text-orange-400 text-sm font-mono font-bold">{parsed.timeLabel}</span>
          <span className="bg-gray-800 text-gray-400 text-[10px] px-1.5 py-0.5 rounded font-mono">{parsed.timeframe}</span>
          <span className="text-gray-500 text-xs">{parsed.dateLabel}</span>
          <WinnerBadge resolution={resolution} />
        </div>
        <div className="flex items-center gap-2">
          <a href={`https://polymarket.com/event/${slug}`} target="_blank" rel="noopener noreferrer"
            className="text-[10px] text-blue-400/50 hover:text-blue-300 transition-colors"
            onClick={e => e.stopPropagation()}>&#8599;</a>
          <span className="text-gray-600 text-sm">&rsaquo;</span>
        </div>
      </div>
      <div className="flex items-center gap-4 text-xs font-mono mb-2">
        <span className="text-gray-500">spent: <span className="text-white font-medium">{usd(totalK9Usdc)}</span></span>
        <span className="text-gray-500">{tradeCount} fills</span>
        {resPnl !== null && (
          <span className={`font-bold ${resPnl >= 0 ? 'text-green-400' : 'text-red-400'}`}>
            k9: {resPnl >= 0 ? '+' : ''}{usd(resPnl)}
          </span>
        )}
        {sp && (
          <span className={`font-bold ${
            sp.resolved
              ? (sp.pnl >= 0 ? 'text-purple-400' : 'text-red-400')
              : 'text-purple-400/60'
          }`}>
            sim: {sp.resolved ? (sp.pnl >= 0 ? '+' : '') + usd(sp.pnl) : usd(sp.cost) + ' in'}
          </span>
        )}
        <span className="text-purple-400/70">{triggerCount} trg</span>
      </div>
      <UDBar up={up.k9BuyUsdc||0} down={dn.k9BuyUsdc||0} />
      <div className="flex gap-3 text-[10px] text-gray-600 mt-1">
        <span>Up {pri(up.k9AvgPrice)} ({(up.k9BuyShares||0).toFixed(0)}sh)</span>
        <span>Down {pri(dn.k9AvgPrice)} ({(dn.k9BuyShares||0).toFixed(0)}sh)</span>
      </div>
    </button>
  );
}

/* ── Position card ─────────────────────────────────────────────── */
function PositionCard({ side, data, resolution, otherUsdc }) {
  const { k9AvgPrice, k9Shares, k9Usdc, k9BuyUsdc, k9BuyShares, k9SellUsdc, k9SellShares, k9SellPnl } = data;
  const sideColor = side === 'Up' ? 'text-green-400' : 'text-red-400';
  const sideBg    = side === 'Up' ? 'bg-green-500/10' : 'bg-red-500/10';
  const result = computePnl(k9Shares, k9Usdc, side, resolution);

  return (
    <div className={`bg-gray-900 rounded-xl border p-4 ${
      result ? (result.won ? 'border-green-800' : 'border-red-900/50') : 'border-gray-800'
    }`}>
      <div className="flex items-center gap-2 mb-3">
        <span className={`${sideBg} ${sideColor} text-xs font-bold px-2 py-0.5 rounded`}>
          {side} {pri(k9AvgPrice)}
        </span>
        <span className="text-gray-400 text-xs font-mono">
          net {(k9Shares||0).toFixed(1)} shares
        </span>
        {result && (
          <span className={`text-[10px] font-bold px-1.5 py-0.5 rounded ${
            result.won ? 'bg-green-500/20 text-green-400' : 'bg-red-500/20 text-red-400'
          }`}>{result.won ? 'WON' : 'LOST'}</span>
        )}
      </div>
      <div className="grid grid-cols-4 gap-3 text-xs font-mono">
        <div>
          <div className="text-gray-500 text-[10px]">Bought</div>
          <div className="text-white">{(k9BuyShares||0).toFixed(1)} sh</div>
          <div className="text-gray-500">{usd(k9BuyUsdc)}</div>
        </div>
        <div>
          <div className="text-gray-500 text-[10px]">Sold</div>
          <div className="text-white">{(k9SellShares||0).toFixed(1)} sh</div>
          <div className="text-gray-500">{usd(k9SellUsdc)}</div>
        </div>
        <div>
          <div className="text-gray-500 text-[10px]">Sell P&L</div>
          <div className={k9SellPnl >= 0 ? 'text-cyan-400' : 'text-red-400'}>
            {k9SellPnl !== 0 ? (k9SellPnl >= 0 ? '+' : '') + usd(k9SellPnl) : '--'}
          </div>
        </div>
        <div>
          <div className="text-gray-500 text-[10px]">{result ? 'Result' : 'If Win'}</div>
          {result ? (
            <div className={`font-bold ${result.pnl >= 0 ? 'text-green-400' : 'text-red-400'}`}>
              {result.pnl >= 0 ? '+' : ''}{usd(result.pnl)}
            </div>
          ) : (
            (() => {
              const ifWinPnl = (k9Shares||0) - (k9Usdc||0) - (otherUsdc||0);
              return <div className={`font-bold ${ifWinPnl >= 0 ? 'text-green-400/60' : 'text-red-400/60'}`}>{ifWinPnl >= 0 ? '+' : ''}{usd(ifWinPnl)}</div>;
            })()
          )}
        </div>
      </div>
    </div>
  );
}

/* ── Sim card (per event) ──────────────────────────────────────── */
function SimCard({ ev, simMode }) {
  const sp = getSimPnl(ev, simMode);
  if (!sp) return null;
  const sm = ev.sim?.[simMode];
  const triggerCount = sm?.triggerCount || 0;
  const fillCount = sm?.fillCount || 0;
  const pendingCount = sm?.pendingCount || 0;
  const pendingNotional = sm?.pendingNotional || 0;
  const buyTriggerCount = sm?.buyTriggerCount || 0;
  const sellTriggerCount = sm?.sellTriggerCount || 0;
  const buyFillCount = sm?.buyFillCount || 0;
  const sellFillCount = sm?.sellFillCount || 0;
  const buyPendingCount = sm?.buyPendingCount || 0;
  const sellPendingCount = sm?.sellPendingCount || 0;
  const buyPendingNotional = sm?.buyPendingNotional || 0;
  const sellPendingNotional = sm?.sellPendingNotional || 0;
  const lastTrig = sm?.triggers?.length ? sm.triggers[sm.triggers.length - 1] : null;
  const lastTrigTime = lastTrig?.ts ? new Date(lastTrig.ts * 1000).toLocaleTimeString('en-US', { hour12: false }) : null;

  return (
    <div className="bg-gray-900 rounded-xl border border-purple-900/30 p-4">
      <div className="flex items-center gap-2 mb-3">
        <span className="bg-purple-500/10 text-purple-400 text-xs font-bold px-2 py-0.5 rounded">
          Sim ({SIM_LABELS[simMode]})
        </span>
        <span className="text-[10px] text-purple-300/80 font-mono">{triggerCount} trg / {fillCount} fill / {pendingCount} pending</span>
        {lastTrig && (
          <span className="text-[10px] text-gray-500 font-mono">last {lastTrig.side.toUpperCase()} {lastTrig.outcome} {lastTrigTime}</span>
        )}
      </div>
      <div className="mb-3 text-[10px] font-mono text-gray-400 flex items-center gap-4">
        <span className="text-green-300/80">BUY {buyTriggerCount} trg / {buyFillCount} fill / {buyPendingCount} pending ({usd(buyPendingNotional)})</span>
        <span className="text-orange-300/80">SELL {sellTriggerCount} trg / {sellFillCount} fill / {sellPendingCount} pending ({usd(sellPendingNotional)})</span>
      </div>
      <div className="grid grid-cols-4 gap-3 text-xs font-mono">
        <div>
          <div className="text-gray-500 text-[10px]">Up Shares</div>
          <div className="text-green-400">{(sm?.Up?.shares||0).toFixed(1)}</div>
          <div className="text-gray-500">{usd(sm?.Up?.cost||0)}</div>
        </div>
        <div>
          <div className="text-gray-500 text-[10px]">Down Shares</div>
          <div className="text-red-400">{(sm?.Down?.shares||0).toFixed(1)}</div>
          <div className="text-gray-500">{usd(sm?.Down?.cost||0)}</div>
        </div>
        <div>
          <div className="text-gray-500 text-[10px]">Total Cost</div>
          <div className="text-white font-bold">{usd(sp.cost)}</div>
          <div className="text-[10px] text-gray-500">realized {usd(sp.realized || 0)}</div>
          <div className="text-[10px] text-gray-500">pending {usd(pendingNotional)}</div>
        </div>
        <div>
          {sp.resolved ? (
            <>
              <div className="text-gray-500 text-[10px]">Sim P&L</div>
              <div className={`font-bold ${sp.pnl >= 0 ? 'text-purple-400' : 'text-red-400'}`}>
                {sp.pnl >= 0 ? '+' : ''}{usd(sp.pnl)}
              </div>
            </>
          ) : (
            <>
              <div className="text-gray-500 text-[10px]">If Up / Down</div>
              <div className="text-purple-400/60 text-[11px]">
                {sp.ifUpPnl >= 0 ? '+' : ''}{usd(sp.ifUpPnl)} / {sp.ifDnPnl >= 0 ? '+' : ''}{usd(sp.ifDnPnl)}
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

/* ── Detail view ───────────────────────────────────────────────── */
function DetailView({ event, onBack, simMode }) {
  const { slug, summary, totalK9Usdc, resolution } = event;
  const parsed = parseSlug(slug);
  const up = summary?.Up || {};
  const dn = summary?.Down || {};

  const [detail, setDetail] = useState(null);
  const [detailLoading, setDetailLoading] = useState(true);
  const [feedFilter, setFeedFilter] = useState('all'); // all | k9 | us

  useEffect(() => {
    setDetailLoading(true);
    const base = API_BASE || `http://${window.location.hostname}:3001`;
    fetch(`${base}/api/event-detail/${encodeURIComponent(slug)}`)
      .then(r => r.json())
      .then(d => { setDetail(d); setDetailLoading(false); })
      .catch(() => setDetailLoading(false));
  }, [slug]);

  const k9UpPnl = computePnl(up.k9Shares, up.k9Usdc, 'Up', resolution);
  const k9DnPnl = computePnl(dn.k9Shares, dn.k9Usdc, 'Down', resolution);
  const k9TotalPnl = k9UpPnl && k9DnPnl ? (k9UpPnl.pnl + k9DnPnl.pnl) : null;
  const k9SellPnl = (up.k9SellPnl || 0) + (dn.k9SellPnl || 0);

  const feed = detail?.feed || event.feed || [];
  const filteredFeed = feedFilter === 'all' ? feed : feed.filter(t => t.who === feedFilter);
  const ourPnl = detail?.ourPnl;
  const ourSummary = detail?.ourSummary;
  const hasOurTrades = (detail?.ourTradeCount || 0) > 0;

  return (
    <div className="space-y-4">
      {/* Header */}
      <div>
        <button onClick={onBack} className="flex items-center gap-1.5 text-sm text-orange-400 hover:text-orange-300 transition-colors mb-3">
          &#8592; Back
        </button>
        <div className="flex items-center gap-3">
          <span className="text-2xl font-bold font-mono text-white">{parsed.timeLabel}</span>
          <span className="bg-gray-800 text-gray-400 text-xs px-2 py-1 rounded font-mono">{parsed.timeframe}</span>
          <span className="text-gray-500 text-sm">{parsed.dateLabel}</span>
          <WinnerBadge resolution={resolution} />
        </div>
        {resolution?.title && resolution.title !== slug && (
          <div className="text-sm text-gray-400 mt-1">{resolution.title}</div>
        )}
        <div className="flex items-center gap-2 mt-1">
          <span className="text-xs text-gray-600 font-mono">{slug}</span>
          <a href={`https://polymarket.com/event/${slug}`} target="_blank" rel="noopener noreferrer"
            className="text-[10px] text-blue-400 hover:text-blue-300 transition-colors">Polymarket &#8599;</a>
        </div>
      </div>

      {/* P&L Comparison: k9 vs Us vs Sim */}
      <div className="bg-gray-900 rounded-xl border border-gray-800 p-4">
        <div className="text-[10px] uppercase tracking-wider text-gray-500 font-bold mb-3">P&L Comparison</div>
        <div className="grid grid-cols-3 gap-4">
          {/* k9 */}
          <div className="space-y-1">
            <div className="text-[10px] text-gray-500 uppercase">k9</div>
            <div className="text-xs font-mono text-gray-400">Spent: {usd(totalK9Usdc)}</div>
            <div className="text-xs font-mono text-gray-400">Trades: {(up.tradeCount||0)+(dn.tradeCount||0)}</div>
            {k9TotalPnl !== null ? (
              <div className={`text-sm font-bold font-mono ${k9TotalPnl >= 0 ? 'text-green-400' : 'text-red-400'}`}>
                {k9TotalPnl >= 0 ? '+' : ''}{usd(k9TotalPnl)}
              </div>
            ) : (
              <div className="text-xs text-gray-500">Pending...</div>
            )}
          </div>
          {/* Us */}
          <div className="space-y-1">
            <div className="text-[10px] text-blue-400 uppercase">Us</div>
            {detailLoading ? (
              <div className="text-xs text-gray-600 animate-pulse">Loading...</div>
            ) : hasOurTrades ? (
              <>
                <div className="text-xs font-mono text-gray-400">
                  Spent: {usd((ourSummary?.Up?.buyUsdc||0)+(ourSummary?.Down?.buyUsdc||0))}
                </div>
                <div className="text-xs font-mono text-gray-400">Trades: {detail?.ourTradeCount||0}</div>
                {ourPnl !== null ? (
                  <div className={`text-sm font-bold font-mono ${ourPnl >= 0 ? 'text-blue-400' : 'text-red-400'}`}>
                    {ourPnl >= 0 ? '+' : ''}{usd(ourPnl)}
                  </div>
                ) : (
                  <div className="text-xs text-gray-500">Pending...</div>
                )}
              </>
            ) : (
              <div className="text-xs text-gray-600">No trades</div>
            )}
          </div>
          {/* Sim */}
          {(() => {
            const sp = getSimPnl(event, simMode);
            return (
              <div className="space-y-1">
                <div className="text-[10px] text-purple-400 uppercase">Sim ({SIM_LABELS[simMode]})</div>
                {sp ? (
                  <>
                    <div className="text-xs font-mono text-gray-400">Cost: {usd(sp.cost)}</div>
                    <div className="text-xs font-mono text-gray-400">Triggers: {event.sim?.[simMode]?.triggerCount||0}</div>
                    {sp.resolved ? (
                      <div className={`text-sm font-bold font-mono ${sp.pnl >= 0 ? 'text-purple-400' : 'text-red-400'}`}>
                        {sp.pnl >= 0 ? '+' : ''}{usd(sp.pnl)}
                      </div>
                    ) : (
                      <div className="text-xs text-gray-500">
                        If Up: {usd(sp.ifUpPnl)} / Dn: {usd(sp.ifDnPnl)}
                      </div>
                    )}
                  </>
                ) : (
                  <div className="text-xs text-gray-600">No sim data</div>
                )}
              </div>
            );
          })()}
        </div>
      </div>

      {/* Sim positions */}
      <SimCard ev={event} simMode={simMode} />

      {/* k9 positions */}
      <div className="space-y-2">
        {(up.k9BuyShares > 0 || up.k9SellShares > 0) && <PositionCard side="Up" data={up} resolution={resolution} otherUsdc={dn.k9Usdc||0} />}
        {(dn.k9BuyShares > 0 || dn.k9SellShares > 0) && <PositionCard side="Down" data={dn} resolution={resolution} otherUsdc={up.k9Usdc||0} />}
        {!up.k9BuyShares && !dn.k9BuyShares && !up.k9SellShares && !dn.k9SellShares && (
          <div className="bg-gray-900 rounded-xl border border-gray-800 p-4 text-gray-600 text-sm text-center">No k9 positions</div>
        )}
      </div>

      {/* Our positions (if any) */}
      {hasOurTrades && ourSummary && (
        <div className="space-y-2">
          <div className="text-[10px] uppercase tracking-wider text-blue-400 font-bold">Our Positions</div>
          {['Up', 'Down'].map(side => {
            const s = ourSummary[side];
            if (!s || (!s.buyShares && !s.sellShares)) return null;
            return (
              <div key={side} className={`bg-gray-900 rounded-xl border border-blue-900/30 p-4`}>
                <div className="flex items-center gap-2 mb-3">
                  <span className={`${side === 'Up' ? 'bg-green-500/10 text-green-400' : 'bg-red-500/10 text-red-400'} text-xs font-bold px-2 py-0.5 rounded`}>
                    {side} {pri(s.avgBuyPrice)}
                  </span>
                  <span className="text-gray-400 text-xs font-mono">net {(s.netShares||0).toFixed(1)} shares</span>
                  <span className="bg-blue-500/10 text-blue-400 text-[10px] px-1.5 py-0.5 rounded">OURS</span>
                </div>
                <div className="grid grid-cols-3 gap-3 text-xs font-mono">
                  <div>
                    <div className="text-gray-500 text-[10px]">Bought</div>
                    <div className="text-white">{(s.buyShares||0).toFixed(1)} sh</div>
                    <div className="text-gray-500">{usd(s.buyUsdc)}</div>
                  </div>
                  <div>
                    <div className="text-gray-500 text-[10px]">Sold</div>
                    <div className="text-white">{(s.sellShares||0).toFixed(1)} sh</div>
                    <div className="text-gray-500">{usd(s.sellUsdc)}</div>
                  </div>
                  <div>
                    <div className="text-gray-500 text-[10px]">Sell P&L</div>
                    <div className={s.sellPnl >= 0 ? 'text-cyan-400' : 'text-red-400'}>
                      {s.sellPnl !== 0 ? (s.sellPnl >= 0 ? '+' : '') + usd(s.sellPnl) : '--'}
                    </div>
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      )}

      {/* Combined trade feed */}
      <div className="bg-gray-900 rounded-xl border border-gray-800 overflow-hidden">
        <div className="flex items-center justify-between px-4 py-3 border-b border-gray-800">
          <div className="flex items-center gap-3">
            <span className="text-sm font-semibold text-gray-300">All Transactions</span>
            <div className="flex gap-0.5 bg-gray-800 rounded-lg p-0.5">
              {[
                { val: 'all', label: 'All' },
                { val: 'k9', label: 'k9' },
                { val: 'us', label: 'Ours' },
              ].map(f => (
                <button key={f.val} onClick={() => setFeedFilter(f.val)}
                  className={`px-2 py-0.5 text-[10px] rounded-md transition-colors ${
                    feedFilter === f.val ? 'bg-gray-700 text-white' : 'text-gray-500 hover:text-gray-300'
                  }`}>{f.label}</button>
              ))}
            </div>
          </div>
          <span className="text-xs text-gray-600">
            {detailLoading ? '...' : `${filteredFeed.length} fills`}
            {detail && ` (k9: ${detail.k9TradeCount}, us: ${detail.ourTradeCount})`}
          </span>
        </div>
        <div className="px-4">
          <div className="grid grid-cols-6 gap-2 text-[10px] text-gray-600 uppercase tracking-wider py-2 border-b border-gray-800">
            <div>Time</div><div>Who</div><div>Side</div><div>Type</div><div>Price</div><div className="text-right">Shares / USDC</div>
          </div>
          <div className="max-h-80 overflow-y-auto">
            {detailLoading && !feed.length && (
              <div className="text-gray-600 text-xs py-4 text-center animate-pulse">Loading transactions...</div>
            )}
            {[...filteredFeed].reverse().map((t, i) => {
              const isUp = t.outcome === 'Up';
              const isBuy = t.side === 'buy';
              const isUs = t.who === 'us';
              const time = t.ts ? new Date(t.ts * 1000).toLocaleTimeString('en-US', { hour12: false }) : '';
              return (
                <div key={i} className={`grid grid-cols-6 gap-2 text-xs font-mono py-1.5 border-b border-gray-800/50 items-center ${
                  isUs ? 'bg-blue-950/20' : ''
                }`}>
                  <span className="text-gray-500">{time}</span>
                  <span className={isUs ? 'text-blue-400 font-bold' : 'text-gray-500'}>{isUs ? 'US' : 'k9'}</span>
                  <span className={`font-bold ${isUp ? 'text-green-400' : 'text-red-400'}`}>{t.outcome}</span>
                  <span className={isBuy ? 'text-blue-400' : 'text-orange-400'}>{t.side}</span>
                  <span className="text-gray-400">{pri(t.price)}</span>
                  <span className="text-white text-right">{(t.shares||0).toFixed(1)}sh / {usd(t.usdc)}</span>
                </div>
              );
            })}
            {!detailLoading && !filteredFeed.length && (
              <div className="text-gray-600 text-sm py-4 text-center">
                {feedFilter === 'us' ? 'No trades from us on this event' : 'No fills yet'}
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

/* ── Root component ────────────────────────────────────────────── */
export default function SimDashboard() {
  const [data, setData]             = useState({ events: [], totals: {} });
  const [loading, setLoading]       = useState(true);
  const [view, setView]             = useState('list');
  const [selectedSlug, setSelected] = useState(null);
  const [search, setSearch]         = useState('');
  const [duration, setDuration]     = useState('');
  const [date, setDate]            = useState('');
  const [simMode, setSimMode]       = useState('1pct_070');
  const ws = useRef(null);

  async function load(dur, dt) {
    try {
      const base = API_BASE || (typeof window !== 'undefined' ? `http://${window.location.hostname}:3001` : '');
      const params = new URLSearchParams({ limit: '30' });
      if (dur) params.set('duration', dur);
      if (dt) params.set('date', dt);
      const r = await fetch(`${base}/api/sim-dashboard?${params}`);
      const d = await r.json();
      setData({
        events: Array.isArray(d?.events) ? d.events : [],
        totals: d?.totals ?? {},
        error: d?.error ?? null,
      });
    } catch (e) {
      setData({ events: [], totals: {}, error: e?.message || 'Failed to load' });
    }
    setLoading(false);
  }

  useEffect(() => {
    load(duration, date);
    const t = setInterval(() => load(duration, date), REFRESH_MS);

    function connectWs() {
      const proto = window.location.protocol === 'https:' ? 'wss' : 'ws';
      ws.current = new WebSocket(`${proto}://${window.location.hostname}:3001`);
      ws.current.onmessage = (e) => {
        try {
          const msg = JSON.parse(e.data);
          if (msg.type === 'k9_trades') load(duration, date);
        } catch {}
      };
      ws.current.onclose = () => setTimeout(connectWs, 2000);
      ws.current.onerror = () => ws.current?.close();
    }
    connectWs();
    return () => { clearInterval(t); ws.current?.close(); };
  }, [duration, date]);

  const events = Array.isArray(data?.events) ? data.events : [];
  const totals = data?.totals ?? {};
  const apiError = data?.error;
  const selectedEvent = events.find(ev => ev?.slug === selectedSlug);

  const filtered = events.filter(ev => {
    if (!ev?.slug) return false;
    const p = parseSlug(ev.slug);
    if (duration) {
      const hasDuration = ev.slug.includes(`-${duration}-`) || ev.slug.endsWith(`-${duration}`);
      if (!hasDuration) return false;
    }
    if (date) {
      if (!isNaN(p.epoch)) {
        const eventDateStr = new Date(p.epoch * 1000).toISOString().slice(0, 10);
        if (eventDateStr !== date) return false;
      }
    }
    if (!search.trim()) return true;
    const q = search.toLowerCase();
    return ev.slug.toLowerCase().includes(q) || p.timeLabel.includes(q) || p.dateLabel.toLowerCase().includes(q);
  });

  if (loading) {
    return (
      <div className="space-y-3">
        {[1,2,3].map(i => (
          <div key={i} className="bg-gray-900 rounded-xl border border-gray-800 p-4 animate-pulse">
            <div className="h-4 bg-gray-800 rounded w-1/3 mb-3" />
            <div className="h-3 bg-gray-800 rounded w-2/3 mb-2" />
            <div className="h-1.5 bg-gray-800 rounded w-full" />
          </div>
        ))}
      </div>
    );
  }

  if (view === 'detail' && selectedEvent) {
    return (
      <div className="space-y-3">
        <div className="flex items-center justify-between">
          <SimToggle simMode={simMode} setSimMode={setSimMode} />
        </div>
        <TotalsBar totals={totals} simMode={simMode} />
        <DetailView event={selectedEvent} onBack={() => { setView('list'); setSelected(null); }} simMode={simMode} />
      </div>
    );
  }

  return (
    <div className="space-y-3">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <div>
            <h2 className="text-sm font-semibold text-gray-300">k9 Tracker</h2>
            <p className="text-xs text-gray-600 mt-0.5">Tracking k9's BTC Up/Down trades</p>
          </div>
        </div>
        <SimToggle simMode={simMode} setSimMode={setSimMode} />
      </div>

      {/* Filters row */}
      <div className="flex items-center gap-2 flex-wrap">
        <div className="flex gap-0.5 bg-gray-800 rounded-lg p-0.5">
          {DURATIONS.map(d => (
            <button key={d.value || 'all'} onClick={() => setDuration(d.value)}
              className={`px-2.5 py-1 text-xs rounded-md transition-colors ${
                duration === d.value ? 'bg-orange-500/80 text-white' : 'text-gray-500 hover:text-gray-300'
              }`}>
              {d.label}
            </button>
          ))}
        </div>
        <input type="date" value={date} onChange={e => setDate(e.target.value)}
          className="bg-gray-800 border border-gray-700 rounded-lg px-2.5 py-1 text-xs text-gray-300" />
        {date && (
          <button onClick={() => setDate('')} className="text-xs text-gray-500 hover:text-gray-300">Clear</button>
        )}
        <input
          type="text"
          value={search}
          onChange={e => setSearch(e.target.value)}
          placeholder="Search events..."
          className="bg-gray-800 border border-gray-700 rounded-lg px-3 py-1.5 text-xs text-white placeholder-gray-600 focus:outline-none focus:border-orange-500 flex-1 min-w-[120px]"
        />
        {(duration || date || search) && (
          <button onClick={() => { setDuration(''); setDate(''); setSearch(''); }}
            className="text-xs text-gray-500 hover:text-orange-400">Clear all</button>
        )}
      </div>

      <TotalsBar totals={totals} simMode={simMode} filteredCount={filtered.length} totalCount={events.length} />

      {apiError ? (
        <div className="bg-red-950/30 border border-red-900/50 rounded-xl p-6 text-center">
          <p className="text-red-400 text-sm font-medium">Failed to load</p>
          <p className="text-gray-500 text-xs mt-1">{apiError}</p>
          <p className="text-gray-600 text-xs mt-2">Check server is running on port 3001</p>
        </div>
      ) : !filtered.length ? (
        <div className="bg-gray-900 rounded-xl border border-gray-800 p-8 text-center">
          <p className="text-gray-500 text-sm">
            {search ? `No events matching "${search}"` : 'Waiting for k9 to trade...'}
          </p>
        </div>
      ) : (
        <div className="space-y-2 max-h-[80vh] overflow-y-auto pr-1">
          {filtered.map(ev => (
            <EventRow key={ev.slug} ev={ev} onClick={(slug) => { setSelected(slug); setView('detail'); }} simMode={simMode} />
          ))}
        </div>
      )}
    </div>
  );
}
