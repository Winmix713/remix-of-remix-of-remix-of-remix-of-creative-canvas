/**
 * Synthetic generators with KNOWN ground truth — the suite's release gate.
 *
 * If the tests cannot separate these controlled generators, no conclusion drawn
 * on the 24 720 real matches may be trusted. Everything here is seeded; no
 * Math.random, no clock.
 */

import { mulberry32 } from '../../bootstrap';
import type { League, MatchRow, Outcome, Season } from '../../../types/winmix';

export interface SyntheticOptions {
  seed: number;
  teams: number;
  matches: number;
  /** Spread of the fixed latent team strengths. */
  strengthSpread: number;
  /** Home advantage on the latent scale. */
  homeAdvantage: number;
  /** Half-width of the draw band. */
  drawWidth: number;
  /**
   * Weight of the form term: latent += formStrength * (formHome − formAway),
   * where form is mean points over the last 5 matches. 0 = no form generator.
   */
  formStrength: number;
  league: League;
  /**
   * Weight of the head-to-head pair term: latent += h2hStrength *
   * (pairPointsHome − pairPointsAway) for the prior meetings of this specific
   * pair. 0 = no H2H dependency.
   */
  h2hStrength?: number;
  /**
   * Goal-generation mode:
   *  - 'poisson'   — independent Poisson scores (default)
   *  - 'overdisp'  — extra goals injected to produce variance > mean
   *  - 'underdisp' — compressed goal counts to produce variance < mean
   */
  goalMode?: 'poisson' | 'overdisp' | 'underdisp';
  /**
   * Per-season strength drift applied when building multiple seasons. Each
   * season's strengths are shifted by `drift * seasonIndex`, so a non-zero
   * value produces a non-stationary generator. Only used by
   * `makeSyntheticSeasons`.
   */
  drift?: number;
}

export const BASE_SYNTHETIC: SyntheticOptions = {
  seed: 424242,
  teams: 16,
  matches: 960,
  strengthSpread: 0.9,
  homeAdvantage: 0.25,
  drawWidth: 0.6,
  formStrength: 0,
  league: 'angol',
  h2hStrength: 0,
  goalMode: 'poisson',
  drift: 0,
};

function sigmoid(z: number): number {
  return 1 / (1 + Math.exp(-z));
}

function tailMean(values: readonly number[], window: number): number {
  if (values.length === 0) return 0;
  const slice = values.slice(-window);
  return slice.reduce((a, c) => a + c, 0) / slice.length;
}

/** Deterministic Poisson sampler via Knuth's algorithm. */
function poissonSample(rand: () => number, lambda: number): number {
  const L = Math.exp(-lambda);
  let k = 0;
  let p = 1;
  do {
    k++;
    p *= rand();
  } while (p > L);
  return k - 1;
}

/**
 * Build one synthetic season whose generator structure is known exactly.
 * `formStrength > 0` means recent results genuinely feed back into the outcome
 * probability beyond fixed team strength.
 */
export function makeSyntheticSeason(
  overrides: Partial<SyntheticOptions> = {},
): Season {
  const o = { ...BASE_SYNTHETIC, ...overrides };
  const rand = mulberry32(o.seed);
  const h2hW = o.h2hStrength ?? 0;
  const goalMode = o.goalMode ?? 'poisson';

  const names = Array.from({ length: o.teams }, (_, i) => `T${String(i + 1).padStart(2, '0')}`);
  // Deterministic, evenly spread latent strengths.
  const strength = new Map<string, number>();
  names.forEach((n, i) => {
    strength.set(n, (i / (o.teams - 1) - 0.5) * 2 * o.strengthSpread);
  });

  const recentPoints = new Map<string, number[]>(names.map((n) => [n, []]));
  /** H2H pair history, keyed order-independently. */
  const pairHistory = new Map<string, { home: number[]; away: number[] }>();
  const pairKey = (a: string, b: string): string =>
    a < b ? `${a}||${b}` : `${b}||${a}`;
  const getPair = (a: string, b: string) => {
    const key = pairKey(a, b);
    let p = pairHistory.get(key);
    if (!p) {
      p = { home: [], away: [] };
      pairHistory.set(key, p);
    }
    return p;
  };

  const matches: MatchRow[] = [];

  for (let i = 0; i < o.matches; i++) {
    const hi = Math.floor(rand() * o.teams) % o.teams;
    let ai = Math.floor(rand() * o.teams) % o.teams;
    if (ai === hi) ai = (ai + 1) % o.teams;
    const home = names[hi];
    const away = names[ai];

    const formHome = tailMean(recentPoints.get(home)!, 5);
    const formAway = tailMean(recentPoints.get(away)!, 5);

    // H2H term: prior meetings of THIS pair only.
    const pair = getPair(home, away);
    const first = home < away;
    const priorHome = first ? pair.home : pair.away;
    const priorAway = first ? pair.away : pair.home;
    const h2hHome = priorHome.length > 0 ? tailMean(priorHome, priorHome.length) : 0;
    const h2hAway = priorAway.length > 0 ? tailMean(priorAway, priorAway.length) : 0;

    const z =
      strength.get(home)! -
      strength.get(away)! +
      o.homeAdvantage +
      o.formStrength * (formHome - formAway) +
      h2hW * (h2hHome - h2hAway);

    const pAway = sigmoid(-o.drawWidth - z);
    const pUpToDraw = sigmoid(o.drawWidth - z);
    const u = rand();
    const outcome: Outcome = u < pAway ? 'A' : u < pUpToDraw ? 'D' : 'H';

    // Goal generation depends on mode.
    // Poisson mode: pure independent Poisson scores, outcome derived from them.
    // Overdisp mode: outcome-conditioned scores with extra variance injected.
    let homeScore: number;
    let awayScore: number;

    if (goalMode === 'poisson') {
      const lambdaHome = Math.exp(0.3 + 0.4 * z);
      const lambdaAway = Math.exp(0.3 - 0.4 * z);
      homeScore = poissonSample(rand, lambdaHome);
      awayScore = poissonSample(rand, lambdaAway);
    } else if (goalMode === 'underdisp') {
      // Under-dispersed: compress goals toward the mean, reducing variance.
      // Sample from a narrow band around the expected mean, clamped tight.
      const lambdaHome = Math.exp(0.3 + 0.4 * z);
      const lambdaAway = Math.exp(0.3 - 0.4 * z);
      const rawHome = poissonSample(rand, lambdaHome);
      const rawAway = poissonSample(rand, lambdaAway);
      // Shrink toward the mean: 70% of the time use the rounded mean, 30% use raw.
      const meanTotal = lambdaHome + lambdaAway;
      const useMean = rand() < 0.7;
      if (useMean) {
        homeScore = Math.round(lambdaHome);
        awayScore = Math.round(lambdaAway);
      } else {
        homeScore = rawHome;
        awayScore = rawAway;
      }
      // Clamp to a narrow band around the expected total to reduce variance.
      const total = homeScore + awayScore;
      const expectedTotal = Math.round(meanTotal);
      if (total > expectedTotal + 1) {
        const excess = total - (expectedTotal + 1);
        if (homeScore > awayScore) homeScore -= excess;
        else awayScore -= excess;
      } else if (total < expectedTotal - 1) {
        const deficit = (expectedTotal - 1) - total;
        homeScore += Math.ceil(deficit / 2);
        awayScore += Math.floor(deficit / 2);
      }
      if (homeScore < 0) homeScore = 0;
      if (awayScore < 0) awayScore = 0;
    } else {
      // Outcome-conditioned with heavy tail to inflate variance beyond Poisson.
      const base = outcome === 'H' ? 1 : outcome === 'A' ? 0 : 0;
      homeScore = base + Math.floor(rand() * 2);
      awayScore = (1 - base) + Math.floor(rand() * 2);
      if (outcome === 'D') { homeScore = Math.floor(rand() * 2); awayScore = homeScore; }
      // Heavy tail: 25% chance of a large goal injection on either side.
      if (rand() < 0.25) homeScore += 2 + Math.floor(rand() * 3);
      if (rand() < 0.25) awayScore += 2 + Math.floor(rand() * 3);
    }

    // In Poisson mode the outcome comes from the actual scores; in overdisp
    // mode the outcome was already determined by the probability model.
    const finalOutcome: Outcome = (goalMode === 'poisson' || goalMode === 'underdisp')
      ? (homeScore > awayScore ? 'H' : homeScore < awayScore ? 'A' : 'D')
      : outcome;

    recentPoints.get(home)!.push(finalOutcome === 'H' ? 3 : finalOutcome === 'D' ? 1 : 0);
    recentPoints.get(away)!.push(finalOutcome === 'A' ? 3 : finalOutcome === 'D' ? 1 : 0);

    const homePts = finalOutcome === 'H' ? 3 : finalOutcome === 'D' ? 1 : 0;
    const awayPts = finalOutcome === 'A' ? 3 : finalOutcome === 'D' ? 1 : 0;
    priorHome.push(homePts);
    priorAway.push(awayPts);

    matches.push({
      match_no: i + 1,
      date: `2026-01-${String(i % 28 + 1).padStart(2, '0')}`,
      kickoffIso: null,
      home_team: home,
      away_team: away,
      ht_home_score: null,
      ht_away_score: null,
      home_score: homeScore,
      away_score: awayScore,
      total_goals: homeScore + awayScore,
      btts: homeScore > 0 && awayScore > 0,
      outcome: finalOutcome,
    });
  }

  return {
    id: `synthetic-${o.seed}-${o.formStrength}-h2h${h2hW}-${goalMode}`,
    league: o.league,
    seasonIndex: 1,
    name: `Synthetic ${o.formStrength > 0 ? 'form' : 'no-form'}`,
    fileName: 'synthetic.csv',
    createdAt: '2026-01-01T00:00:00.000Z',
    contentHash: null,
    countWarning: false,
    actualMatchCount: matches.length,
    orderMode: 'source-order',
    datedMatchCount: 0,
    matches,
  };
}

/**
 * Build multiple synthetic seasons with a controlled drift parameter.
 * Each season gets a different seed (deterministic from the base) and its
 * team strengths are shifted by `drift * seasonIndex`, producing a
 * non-stationary generator when `drift > 0`.
 */
export function makeSyntheticSeasons(
  count: number,
  overrides: Partial<SyntheticOptions> = {},
): Season[] {
  const o = { ...BASE_SYNTHETIC, ...overrides };
  const drift = o.drift ?? 0;
  const seasons: Season[] = [];

  for (let s = 0; s < count; s++) {
    const seasonSeed = o.seed + s * 100003;
    const seasonOverrides: Partial<SyntheticOptions> = {
      ...overrides,
      seed: seasonSeed,
    };

    // Apply drift by shifting the strength spread for each subsequent season.
    if (drift !== 0) {
      seasonOverrides.strengthSpread = o.strengthSpread + drift * (s + 1);
      // Also shift home advantage slightly to make drift detectable.
      seasonOverrides.homeAdvantage = o.homeAdvantage + drift * 0.3 * s;
    }

    const season = makeSyntheticSeason(seasonOverrides);
    seasons.push({
      ...season,
      seasonIndex: s + 1,
      id: `synthetic-${seasonSeed}-s${s + 1}`,
      name: `Synthetic S${s + 1}${drift !== 0 ? ' drift' : ''}`,
    });
  }

  return seasons;
}
