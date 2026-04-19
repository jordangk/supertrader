/**
 * Sub-market slug patterns by sport.
 * Base slug format: {league}-{team1}-{team2}-{date}
 * Sub-markets append suffixes to the base slug.
 */

export const SOCCER_SUFFIXES = [
  '-total-1pt5', '-total-2pt5', '-total-3pt5', '-total-4pt5', '-total-5pt5',
  '-spread-home-1pt5', '-spread-away-1pt5', '-spread-home-2pt5', '-spread-away-2pt5',
  '-btts',
  '-exact-score-0-0', '-exact-score-0-1', '-exact-score-0-2', '-exact-score-0-3',
  '-exact-score-1-0', '-exact-score-1-1', '-exact-score-1-2', '-exact-score-1-3',
  '-exact-score-2-0', '-exact-score-2-1', '-exact-score-2-2', '-exact-score-2-3',
  '-exact-score-3-0', '-exact-score-3-1', '-exact-score-3-2', '-exact-score-3-3',
  '-exact-score-any-other',
];

export const NBA_SUFFIXES = [
  '-total-200pt5', '-total-205pt5', '-total-210pt5', '-total-215pt5', '-total-220pt5',
  '-total-225pt5', '-total-230pt5', '-total-235pt5', '-total-240pt5',
  '-spread-home-1pt5', '-spread-away-1pt5', '-spread-home-3pt5', '-spread-away-3pt5',
  '-spread-home-5pt5', '-spread-away-5pt5', '-spread-home-7pt5', '-spread-away-7pt5',
  '-spread-home-9pt5', '-spread-away-9pt5', '-spread-home-11pt5', '-spread-away-11pt5',
];

export const MLB_SUFFIXES = [
  '-total-5pt5', '-total-6pt5', '-total-7pt5', '-total-8pt5', '-total-9pt5',
  '-total-10pt5', '-total-11pt5', '-total-12pt5', '-total-13pt5', '-total-14pt5', '-total-15pt5',
  '-spread-home-1pt5', '-spread-away-1pt5', '-spread-home-2pt5', '-spread-away-2pt5',
  '-nrfi',
];

export const NHL_SUFFIXES = [
  '-total-3pt5', '-total-4pt5', '-total-5pt5', '-total-6pt5', '-total-7pt5',
  '-spread-home-1pt5', '-spread-away-1pt5',
];

export const ESPORTS_SUFFIXES = [
  '-game1', '-game2', '-game3',
  '-total-games-2pt5',
  '-game1-odd-even-total-kills', '-game2-odd-even-total-kills', '-game3-odd-even-total-kills',
  '-game1-odd-even-total-rounds', '-game2-odd-even-total-rounds', '-game3-odd-even-total-rounds',
  '-game1-first-blood', '-game2-first-blood',
  '-game1-kill-over-20pt5', '-game1-kill-over-21pt5', '-game1-kill-over-22pt5',
  '-game1-kill-over-23pt5', '-game1-kill-over-24pt5', '-game1-kill-over-25pt5',
  '-game1-kill-over-26pt5', '-game1-kill-over-27pt5', '-game1-kill-over-28pt5',
  '-game1-kill-over-29pt5', '-game1-kill-over-30pt5',
  '-game1-both-teams-slay-dragon', '-game2-both-teams-slay-dragon',
  '-game1-both-teams-slay-baron', '-game2-both-teams-slay-baron',
  '-game1-both-teams-beat-roshan', '-game2-both-teams-beat-roshan',
  '-game1-both-teams-destroy-inhibitors', '-game2-both-teams-destroy-inhibitors',
];

export const TENNIS_SUFFIXES = [
  '-match-total-19pt5', '-match-total-20pt5', '-match-total-21pt5',
  '-match-total-22pt5', '-match-total-23pt5', '-match-total-24pt5',
  '-total-sets-2pt5',
];

export function getSuffixesForSport(slug) {
  if (slug.startsWith('nba-') || slug.startsWith('cbb-')) return NBA_SUFFIXES;
  if (slug.startsWith('mlb-')) return MLB_SUFFIXES;
  if (slug.startsWith('nhl-')) return NHL_SUFFIXES;
  if (slug.startsWith('cs2-') || slug.startsWith('lol-') || slug.startsWith('dota2-') || slug.startsWith('val-') || slug.startsWith('ow-') || slug.startsWith('r6siege-')) return ESPORTS_SUFFIXES;
  if (slug.startsWith('atp-') || slug.startsWith('wta-')) return TENNIS_SUFFIXES;
  // Soccer: mls-, mex-, lal-, epl-, ser-, bun-, fl1-, lig-, etc.
  return SOCCER_SUFFIXES;
}
