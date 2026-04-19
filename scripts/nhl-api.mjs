/**
 * NHL Official API — cross-check for player stats
 * api-web.nhle.com — free, no auth, Kalshi's primary settlement source
 */

let nhlGameIds = {}; // "AWAY-HOME" → gameId

export async function refreshNhlGameIds() {
  try {
    const r = await fetch('https://api-web.nhle.com/v1/schedule/now', { signal: AbortSignal.timeout(5000) });
    const d = await r.json();
    for (const day of (d.gameWeek || [])) {
      for (const g of (day.games || [])) {
        const key = `${g.awayTeam?.abbrev}-${g.homeTeam?.abbrev}`;
        nhlGameIds[key] = g.id;
      }
    }
  } catch {}
}

export async function getNhlPlayerStat(gameId, playerName, stat) {
  try {
    const r = await fetch(`https://api-web.nhle.com/v1/gamecenter/${gameId}/boxscore`, { signal: AbortSignal.timeout(5000) });
    const d = await r.json();
    const norm = (s) => String(s || '').toLowerCase().replace(/[^a-z ]/g, '').trim();
    const target = norm(playerName).split(' ').pop(); // last name

    for (const side of ['awayTeam', 'homeTeam']) {
      for (const group of ['forwards', 'defense', 'goalies']) {
        for (const p of (d.playerByGameStats?.[side]?.[group] || [])) {
          const name = norm(p.name?.default || '');
          if (name.includes(target)) {
            const map = {
              goals: p.goals,
              assists: p.assists,
              points: (p.goals || 0) + (p.assists || 0),
              saves: p.savePctg != null ? Math.round(p.savePctg * (p.shotsAgainst || 0)) : p.saves,
              blocks: p.blockedShots,
            };
            return map[stat] ?? null;
          }
        }
      }
    }
    return null;
  } catch { return null; }
}

export function getNhlGameId(awayAbbr, homeAbbr) {
  return nhlGameIds[`${awayAbbr}-${homeAbbr}`] || null;
}
