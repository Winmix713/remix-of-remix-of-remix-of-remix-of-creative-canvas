/**
 * TEST 5 — GOAL DISTRIBUTION
 *
 * QUESTION
 * --------
 * Do total goals per match follow a Poisson law, and are the two teams' goal
 * events independent?
 *
 * HYPOTHESIS UNDER TEST
 * ---------------------
 * "Total goals per match are Poisson distributed."
 *   COMPATIBLE   — dispersion CI contains 1 and the chi-square fit is not
 *                  rejected.
 *   INCOMPATIBLE — dispersion CI excludes 1, or the fit is clearly rejected.
 *   INCONCLUSIVE — the two diagnostics disagree, or the sample is too small.
 *
 * DESCRIPTIVE ONLY
 * ----------------
 * No predictive model is compared here, so this test reports NO out-of-sample
 * deltas. Its verdict rests on dispersion and goodness of fit alone, and it is
 * therefore the one test whose implication row carries no OOS numbers.
 */

import type { League, MatchRow, Season } from '../../types/winmix';
import { mulberry32 } from '../bootstrap';
import { BOOTSTRAP_CI_ALPHA } from '../constants';
import { chiSquareSf } from '../stats';
import { buildImplication } from './implication';
import { collectLeagueMatches } from './independence';
import type { Effect, GoalBin, GoalDistributionReport, TestResult } from './types';

export interface GoalDistributionOptions {
  bootstrapIterations: number;
  seed: number;
  /** Highest explicit bin; everything above is pooled into the tail bin. */
  maxGoals: number;
  /** Expected-count floor below which neighbouring bins are pooled. */
  minExpected: number;
  /** Smallest number of matches that may carry a verdict. */
  minMatches: number;
}

export const DEFAULT_GOAL_DISTRIBUTION_OPTIONS: GoalDistributionOptions = {
  bootstrapIterations: 2000,
  seed: 20260919,
  maxGoals: 7,
  minExpected: 5,
  minMatches: 100,
};

/** Poisson pmf at k for the given mean. */
function poissonPmf(lambda: number, k: number): number {
  let logP = -lambda + k * Math.log(Math.max(lambda, 1e-9));
  for (let i = 2; i <= k; i++) logP -= Math.log(i);
  return Math.exp(logP);
}

function meanOf(values: readonly number[]): number {
  if (values.length === 0) return 0;
  return values.reduce((a, c) => a + c, 0) / values.length;
}

function varianceOf(values: readonly number[]): number {
  const n = values.length;
  if (n < 2) return 0;
  const m = meanOf(values);
  return values.reduce((acc, v) => acc + (v - m) ** 2, 0) / (n - 1);
}

function quantile(sorted: readonly number[], q: number): number {
  if (sorted.length === 0) return 0;
  const idx = (sorted.length - 1) * q;
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  if (lo === hi) return sorted[lo];
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (idx - lo);
}

/**
 * Seeded percentile-bootstrap CI for the dispersion index (variance / mean).
 * 1 = Poisson, > 1 over-dispersed, < 1 under-dispersed.
 */
export function bootstrapDispersion(
  goals: readonly number[],
  iterations: number,
  seed: number,
): Effect {
  const m = meanOf(goals);
  const point = m > 0 ? varianceOf(goals) / m : 0;
  const n = goals.length;
  if (n < 2) return { estimate: point, ci95Low: point, ci95High: point };

  const rand = mulberry32(seed);
  const reps = new Array<number>(iterations);
  const sample = new Array<number>(n);
  for (let it = 0; it < iterations; it++) {
    for (let i = 0; i < n; i++) sample[i] = goals[Math.floor(rand() * n) % n];
    const sm = meanOf(sample);
    reps[it] = sm > 0 ? varianceOf(sample) / sm : 0;
  }
  reps.sort((a, b) => a - b);
  return {
    estimate: point,
    ci95Low: quantile(reps, BOOTSTRAP_CI_ALPHA / 2),
    ci95High: quantile(reps, 1 - BOOTSTRAP_CI_ALPHA / 2),
  };
}

/**
 * Observed vs Poisson-expected bins of total goals. Goals above `maxGoals` are
 * pooled into the `maxGoals` bin so the tail keeps a usable expected count.
 */
export function buildGoalBins(
  goals: readonly number[],
  maxGoals: number,
): GoalBin[] {
  const lambda = meanOf(goals);
  const n = goals.length;
  const observed = new Array<number>(maxGoals + 1).fill(0);
  for (const g of goals) observed[Math.min(g, maxGoals)]++;

  let tailExpected = 1;
  const bins: GoalBin[] = [];
  for (let k = 0; k < maxGoals; k++) {
    const p = poissonPmf(lambda, k);
    tailExpected -= p;
    bins.push({ goals: k, observed: observed[k], expectedPoisson: p * n });
  }
  bins.push({
    goals: maxGoals,
    observed: observed[maxGoals],
    expectedPoisson: Math.max(0, tailExpected) * n,
  });
  return bins;
}

/**
 * Chi-square goodness of fit against Poisson. Bins whose expected count is
 * below `minExpected` are pooled into the neighbouring tail; one degree of
 * freedom is spent on the estimated mean.
 */
export function goodnessOfFit(
  bins: readonly GoalBin[],
  minExpected: number,
): { statistic: number; df: number; p: number } {
  const pooled: GoalBin[] = [];
  for (const bin of bins) {
    const last = pooled[pooled.length - 1];
    if (last && last.expectedPoisson < minExpected) {
      last.observed += bin.observed;
      last.expectedPoisson += bin.expectedPoisson;
    } else {
      pooled.push({ ...bin });
    }
  }
  // A final under-populated bin folds backwards.
  if (pooled.length > 1 && pooled[pooled.length - 1].expectedPoisson < minExpected) {
    const tail = pooled.pop()!;
    const last = pooled[pooled.length - 1];
    last.observed += tail.observed;
    last.expectedPoisson += tail.expectedPoisson;
  }

  let statistic = 0;
  for (const bin of pooled) {
    if (bin.expectedPoisson <= 0) continue;
    statistic += (bin.observed - bin.expectedPoisson) ** 2 / bin.expectedPoisson;
  }
  const df = Math.max(1, pooled.length - 2); // −1 for the total, −1 for lambda
  return { statistic, df, p: chiSquareSf(statistic, df) };
}

/**
 * 2x2 chi-square independence of "home scored" vs "away scored".
 * Rejection means the two sides' goal events are not independent, which is what
 * a naive product-of-Poissons BTTS model assumes.
 */
export function bttsIndependence(
  matches: readonly MatchRow[],
): { statistic: number; df: number; p: number } {
  const n = matches.length;
  if (n < 4) return { statistic: 0, df: 1, p: 1 };

  const table = [
    [0, 0],
    [0, 0],
  ];
  for (const m of matches) {
    table[m.home_score > 0 ? 1 : 0][m.away_score > 0 ? 1 : 0]++;
  }
  const rowTotals = table.map((r) => r[0] + r[1]);
  const colTotals = [table[0][0] + table[1][0], table[0][1] + table[1][1]];

  let statistic = 0;
  for (let r = 0; r < 2; r++) {
    for (let c = 0; c < 2; c++) {
      const expected = (rowTotals[r] * colTotals[c]) / n;
      if (expected <= 0) continue;
      statistic += (table[r][c] - expected) ** 2 / expected;
    }
  }
  return { statistic, df: 1, p: chiSquareSf(statistic, 1) };
}

/**
 * Runs the Goal Distribution test for one league.
 * Returns null when the league has fewer than `minMatches` matches.
 */
export function runGoalDistributionTest(
  seasons: readonly Season[],
  league: League,
  options: GoalDistributionOptions = DEFAULT_GOAL_DISTRIBUTION_OPTIONS,
): GoalDistributionReport | null {
  const matches = collectLeagueMatches(seasons, league);
  if (matches.length < options.minMatches) return null;

  const goals = matches.map((m) => m.home_score + m.away_score);
  const dispersion = bootstrapDispersion(goals, options.bootstrapIterations, options.seed);
  const bins = buildGoalBins(goals, options.maxGoals);
  const chiSquare = goodnessOfFit(bins, options.minExpected);
  const btts = bttsIndependence(matches);

  const dispersionPoisson = dispersion.ci95Low <= 1 && dispersion.ci95High >= 1;
  const fitPoisson = chiSquare.p >= 0.05;
  let conclusion: TestResult['conclusion'];
  let rationale: string;
  if (dispersionPoisson && fitPoisson) {
    conclusion = 'COMPATIBLE';
    rationale =
      'The dispersion interval contains 1 and the chi-square fit is not rejected: ' +
      'total goals are compatible with a Poisson law.';
  } else if (!dispersionPoisson || chiSquare.p < 0.01) {
    conclusion = 'INCOMPATIBLE';
    rationale =
      dispersion.ci95Low > 1
        ? 'Total goals are over-dispersed (the whole dispersion interval is above 1), ' +
          'so a single-parameter Poisson understates the spread.'
        : dispersion.ci95High < 1
          ? 'Total goals are under-dispersed (the whole dispersion interval is below 1), ' +
            'so a Poisson law overstates the spread.'
          : 'The chi-square goodness of fit against Poisson is clearly rejected.';
  } else {
    conclusion = 'INCONCLUSIVE';
    rationale =
      'Dispersion and goodness of fit point in different directions; this sample ' +
      'does not settle whether the goal counts are Poisson.';
  }

  const result: TestResult = {
    conclusion,
    effectLabel: 'Dispersion index (variance / mean of total goals), 1 = Poisson',
    effect: dispersion,
    rawPValue: chiSquare.p,
    sampleSize: matches.length,
    // Descriptive test: no model is fitted, so nothing can leak.
    leakageSafe: true,
    rationale,
  };

  return {
    dataset: {
      league,
      seasonCount: seasons.filter((s) => s.league === league).length,
      matchCount: matches.length,
      sampleSize: matches.length,
      seed: options.seed,
    },
    meanGoals: meanOf(goals),
    varianceGoals: varianceOf(goals),
    dispersion,
    bins,
    chiSquare,
    bttsIndependence: btts,
    result,
    implication: buildImplication(
      'Poisson gólszám-modell',
      'ACTIVE — a közös gólmátrix Poisson-alapú marginálisokból épül',
      result,
    ),
  };
}
