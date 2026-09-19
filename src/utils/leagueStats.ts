import { canon, displayNameOf } from './teams';
import { computeStandings } from './standings';
import { computeH2HPairs } from './h2h';
import type { StandingRow } from '../types/winmix';
import type { League, MatchRow, Season, AliasMap, WeightMap } from '../types/winmix';

/* ------------------------------------------------------------------ *
 * Types consumed by LeagueAnalyzer.tsx
 * ------------------------------------------------------------------ */

export interface TeamOverUnderRow {
  key: string;
  displayName: string;
  played: number;
  over25Pct: number;
  under25Pct: number;
  over15Pct: number;
  bttsPct: number;
}

export interface TeamFormRow {
  key: string;
  displayName: string;
  played: number;
  form: ('W' | 'D' | 'L')[];
  formPoints: number;
}

export interface ResultMatrixCell {
  homeScore: number;
  awayScore: number;
  outcome: 'W' | 'D' | 'L';
}

export interface ResultMatrixOpponentRow {
  opponentKey: string;
  opponentName: string;
  home: ResultMatrixCell | null;
  away: ResultMatrixCell | null;
}

export interface ResultMatrix {
  teamName: string;
  rows: ResultMatrixOpponentRow[];
}

export interface FixtureEntry {
  homeTeam: string;
  awayTeam: string;
  homeScore: number | null;
  awayScore: number | null;
  date: string;
  isUpcoming: boolean;
}

export interface TeamMatchEntry {
  date: string;
  opponentKey: string;
  opponent: string;
  isHome: boolean;
  homeScore: number;
  awayScore: number;
  isUpcoming: boolean;
  over25: boolean;
}

export interface LeagueOverview {
  totalMatches: number;
  totalGoals: number;
  goalsPerMatch: number;
  homeWinPct: number;
  drawPct: number;
  awayWinPct: number;
  over25Pct: number;
  bttsPct: number;
}

export interface LeagueBenchmark {
  totalMatches: number;
  goalsPerMatch: number;
  homeWinPct: number;
  drawPct: number;
  awayWinPct: number;
  over25Pct: number;
  bttsPct: number;
}

export interface TeamPoolRow {
  key: string;
  display: string;
  played: number;
}

export interface LeagueAnalyzerData {
  standings: StandingRow[];
  overview: LeagueOverview;
  benchmark: LeagueBenchmark;
  overUnder: TeamOverUnderRow[];
  form: TeamFormRow[];
  teamPool: TeamPoolRow[];
  h2hPairs: ReturnType<typeof computeH2HPairs>;
}

/* ------------------------------------------------------------------ *
 * Helpers
 * ------------------------------------------------------------------ */

function isPlayed(m: MatchRow): boolean {
  return m.home_score !== null && m.away_score !== null;
}

function matchOutcome(
  m: MatchRow,
  teamKey: string,
): 'W' | 'D' | 'L' {
  const hKey = canon(m.home_team);
  const aKey = canon(m.away_team);
  const isHome = hKey === teamKey;

  const our = isHome ? m.home_score : m.away_score;
  const their = isHome ? m.away_score : m.home_score;

  if (our > their) return 'W';
  if (our < their) return 'L';
  return 'D';
}

/* ------------------------------------------------------------------ *
 * Overview + benchmark
 * ------------------------------------------------------------------ */

function computeOverview(matches: MatchRow[]): LeagueOverview {
  const played = matches.filter(isPlayed);
  const n = played.length;
  if (n === 0) {
    return {
      totalMatches: 0,
      totalGoals: 0,
      goalsPerMatch: 0,
      homeWinPct: 0,
      drawPct: 0,
      awayWinPct: 0,
      over25Pct: 0,
      bttsPct: 0,
    };
  }

  let home = 0;
  let draw = 0;
  let away = 0;
  let goals = 0;
  let over25 = 0;
  let btts = 0;

  for (const m of played) {
    goals += m.total_goals;
    if (m.home_score > m.away_score) home++;
    else if (m.home_score === m.away_score) draw++;
    else away++;
    if (m.total_goals > 2.5) over25++;
    if (m.btts) btts++;
  }

  return {
    totalMatches: n,
    totalGoals: goals,
    goalsPerMatch: goals / n,
    homeWinPct: (home / n) * 100,
    drawPct: (draw / n) * 100,
    awayWinPct: (away / n) * 100,
    over25Pct: (over25 / n) * 100,
    bttsPct: (btts / n) * 100,
  };
}

/* ------------------------------------------------------------------ *
 * Over / Under per team
 * ------------------------------------------------------------------ */

function computeOverUnder(
  matches: MatchRow[],
  aliases: Record<string, string>,
): TeamOverUnderRow[] {
  const teams = new Map<
    string,
    {
      key: string;
      played: number;
      over25: number;
      over15: number;
      btts: number;
    }
  >();

  for (const m of matches) {
    if (!isPlayed(m)) continue;
    const hKey = canon(m.home_team);
    const aKey = canon(m.away_team);

    for (const key of [hKey, aKey]) {
      if (!teams.has(key)) {
        teams.set(key, { key, played: 0, over25: 0, over15: 0, btts: 0 });
      }
      const t = teams.get(key)!;
      t.played++;
      if (m.total_goals > 2.5) t.over25++;
      if (m.total_goals > 1.5) t.over15++;
      if (m.btts) t.btts++;
    }
  }

  return Array.from(teams.values())
    .map<TeamOverUnderRow>((t) => ({
      key: t.key,
      displayName: displayNameOf(aliases, t.key),
      played: t.played,
      over25Pct: t.played > 0 ? (t.over25 / t.played) * 100 : 0,
      under25Pct: t.played > 0 ? ((t.played - t.over25) / t.played) * 100 : 0,
      over15Pct: t.played > 0 ? (t.over15 / t.played) * 100 : 0,
      bttsPct: t.played > 0 ? (t.btts / t.played) * 100 : 0,
    }))
    .sort((a, b) => b.over25Pct - a.over25Pct || a.displayName.localeCompare(b.displayName, 'hu'));
}

/* ------------------------------------------------------------------ *
 * Form (last 5)
 * ------------------------------------------------------------------ */

function computeForm(
  matches: MatchRow[],
  aliases: Record<string, string>,
): TeamFormRow[] {
  const teams = new Map<
    string,
    { key: string; results: ('W' | 'D' | 'L')[] }
  >();

  for (const m of matches) {
    if (!isPlayed(m)) continue;
    const hKey = canon(m.home_team);
    const aKey = canon(m.away_team);

    const hRes: 'W' | 'D' | 'L' =
      m.home_score > m.away_score ? 'W' : m.home_score < m.away_score ? 'L' : 'D';
    const aRes: 'W' | 'D' | 'L' =
      m.away_score > m.home_score ? 'W' : m.away_score < m.home_score ? 'L' : 'D';

    if (!teams.has(hKey)) teams.set(hKey, { key: hKey, results: [] });
    if (!teams.has(aKey)) teams.set(aKey, { key: aKey, results: [] });
    teams.get(hKey)!.results.push(hRes);
    teams.get(aKey)!.results.push(aRes);
  }

  return Array.from(teams.values())
    .map<TeamFormRow>((t) => {
      const last5 = t.results.slice(-5).reverse();
      const formPoints = last5.reduce((sum, r) => {
        if (r === 'W') return sum + 3;
        if (r === 'D') return sum + 1;
        return sum;
      }, 0);
      return {
        key: t.key,
        displayName: displayNameOf(aliases, t.key),
        played: t.results.length,
        form: last5,
        formPoints,
      };
    })
    .sort((a, b) => b.formPoints - a.formPoints || a.displayName.localeCompare(b.displayName, 'hu'));
}

/* ------------------------------------------------------------------ *
 * Team pool
 * ------------------------------------------------------------------ */

function computeTeamPool(
  standings: StandingRow[],
): TeamPoolRow[] {
  return standings.map((s) => ({
    key: s.key,
    display: s.displayName,
    played: s.played,
  }));
}

/* ------------------------------------------------------------------ *
 * Main builder
 * ------------------------------------------------------------------ */

export function buildLeagueAnalyzerData(
  seasons: Season[],
  currentLeague: League,
  teamWeights: WeightMap,
  teamAliasMap: AliasMap,
  scopedSelectedSeason: Season | null,
): LeagueAnalyzerData {
  const leagueSeasons = seasons.filter((s) => s.league === currentLeague);
  const leagueMatches = leagueSeasons.flatMap((s) => s.matches);
  const scopedMatches = scopedSelectedSeason
    ? scopedSelectedSeason.matches
    : leagueMatches;

  const aliases = teamAliasMap[currentLeague] ?? {};
  const weights = teamWeights[currentLeague] ?? {};

  const standings = computeStandings(scopedMatches, weights, aliases);
  const overview = computeOverview(scopedMatches);
  const overUnder = computeOverUnder(scopedMatches, aliases);
  const form = computeForm(scopedMatches, aliases);
  const teamPool = computeTeamPool(standings);
  const h2hPairs = computeH2HPairs(leagueSeasons, aliases);

  const allMatches = seasons.flatMap((s) => s.matches);
  const benchmark = computeOverview(allMatches);

  return {
    standings,
    overview,
    benchmark,
    overUnder,
    form,
    teamPool,
    h2hPairs,
  };
}

/* ------------------------------------------------------------------ *
 * Position history (per-round standings for a single season)
 * ------------------------------------------------------------------ */

export function computePositionHistory(
  season: Season,
  weights: Record<string, number>,
  aliases: Record<string, string>,
): {
  key: string;
  displayName: string;
  history: { round: number; position: number }[];
}[] {
  const matches = season.matches;
  if (matches.length === 0) return [];

  const teamKeys = new Set<string>();
  for (const m of matches) {
    teamKeys.add(canon(m.home_team));
    teamKeys.add(canon(m.away_team));
  }

  const result: {
    key: string;
    displayName: string;
    history: { round: number; position: number }[];
  }[] = [];

  for (const key of teamKeys) {
    const teamMatches = matches.filter(
      (m) => canon(m.home_team) === key || canon(m.away_team) === key,
    );
    const history: { round: number; position: number }[] = [];

    for (let i = 1; i <= teamMatches.length; i++) {
      const slice = teamMatches.slice(0, i);
      const standings = computeStandings(slice, weights, aliases);
      const pos = standings.findIndex((s) => s.key === key);
      if (pos >= 0) {
        history.push({ round: i, position: pos + 1 });
      }
    }

    result.push({
      key,
      displayName: displayNameOf(aliases, key),
      history,
    });
  }

  return result;
}

/* ------------------------------------------------------------------ *
 * Result matrix (one team vs every opponent, home + away)
 * ------------------------------------------------------------------ */

export function computeResultMatrix(
  matches: MatchRow[],
  teamKey: string,
  aliases: Record<string, string>,
): ResultMatrix | null {
  const opponents = new Map<
    string,
    { home: ResultMatrixCell | null; away: ResultMatrixCell | null }
  >();

  for (const m of matches) {
    if (!isPlayed(m)) continue;
    const hKey = canon(m.home_team);
    const aKey = canon(m.away_team);

    if (hKey === teamKey) {
      const oppKey = aKey;
      if (!opponents.has(oppKey)) {
        opponents.set(oppKey, { home: null, away: null });
      }
      const cell: ResultMatrixCell = {
        homeScore: m.home_score,
        awayScore: m.away_score,
        outcome: matchOutcome(m, teamKey),
      };
      const existing = opponents.get(oppKey)!;
      if (!existing.home) existing.home = cell;
    } else if (aKey === teamKey) {
      const oppKey = hKey;
      if (!opponents.has(oppKey)) {
        opponents.set(oppKey, { home: null, away: null });
      }
      const cell: ResultMatrixCell = {
        homeScore: m.home_score,
        awayScore: m.away_score,
        outcome: matchOutcome(m, teamKey),
      };
      const existing = opponents.get(oppKey)!;
      if (!existing.away) existing.away = cell;
    }
  }

  if (opponents.size === 0) return null;

  const rows = Array.from(opponents.entries())
    .map(([oppKey, cells]) => ({
      opponentKey: oppKey,
      opponentName: displayNameOf(aliases, oppKey),
      home: cells.home,
      away: cells.away,
    }))
    .sort((a, b) => a.opponentName.localeCompare(b.opponentName, 'hu'));

  return {
    teamName: displayNameOf(aliases, teamKey),
    rows,
  };
}

/* ------------------------------------------------------------------ *
 * Team matches (previous + upcoming)
 * ------------------------------------------------------------------ */

export function computeTeamMatches(
  matches: MatchRow[],
  teamKey: string,
  aliases: Record<string, string>,
): { previous: TeamMatchEntry[]; upcoming: TeamMatchEntry[] } {
  const previous: TeamMatchEntry[] = [];
  const upcoming: TeamMatchEntry[] = [];

  for (const m of matches) {
    const hKey = canon(m.home_team);
    const aKey = canon(m.away_team);
    const isHome = hKey === teamKey;
    if (!isHome && aKey !== teamKey) continue;

    const oppKey = isHome ? aKey : hKey;
    const played = isPlayed(m);

    const entry: TeamMatchEntry = {
      date: m.date,
      opponentKey: oppKey,
      opponent: displayNameOf(aliases, oppKey),
      isHome,
      homeScore: m.home_score,
      awayScore: m.away_score,
      isUpcoming: !played,
      over25: played ? m.total_goals > 2.5 : false,
    };

    if (played) {
      previous.push(entry);
    } else {
      upcoming.push(entry);
    }
  }

  return {
    previous: previous.reverse().slice(0, 10),
    upcoming: upcoming.slice(0, 10),
  };
}

/* ------------------------------------------------------------------ *
 * Current + next fixtures for a season
 * ------------------------------------------------------------------ */

export function computeCurrentAndNextFixtures(
  season: Season,
  aliases: Record<string, string>,
): { current: FixtureEntry[]; next: FixtureEntry[] } {
  const matches = season.matches;
  if (matches.length === 0) {
    return { current: [], next: [] };
  }

  let lastPlayedIdx = -1;
  for (let i = matches.length - 1; i >= 0; i--) {
    if (isPlayed(matches[i])) {
      lastPlayedIdx = i;
      break;
    }
  }

  const current: FixtureEntry[] = [];
  const next: FixtureEntry[] = [];

  if (lastPlayedIdx >= 0) {
    let roundStart = lastPlayedIdx;
    while (
      roundStart > 0 &&
      isPlayed(matches[roundStart - 1])
    ) {
      roundStart--;
    }

    for (let i = roundStart; i <= lastPlayedIdx; i++) {
      const m = matches[i];
      current.push(toFixtureEntry(m, aliases));
    }
  }

  let nextIdx = lastPlayedIdx + 1;
  if (nextIdx < matches.length && !isPlayed(matches[nextIdx])) {
    let roundEnd = nextIdx;
    while (
      roundEnd + 1 < matches.length &&
      !isPlayed(matches[roundEnd + 1])
    ) {
      roundEnd++;
    }
    for (let i = nextIdx; i <= roundEnd; i++) {
      next.push(toFixtureEntry(matches[i], aliases));
    }
  }

  return { current, next };
}

function toFixtureEntry(
  m: MatchRow,
  aliases: Record<string, string>,
): FixtureEntry {
  const played = isPlayed(m);
  return {
    homeTeam: displayNameOf(aliases, canon(m.home_team), m.home_team),
    awayTeam: displayNameOf(aliases, canon(m.away_team), m.away_team),
    homeScore: played ? m.home_score : null,
    awayScore: played ? m.away_score : null,
    date: m.date,
    isUpcoming: !played,
  };
}
