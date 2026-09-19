/**
 * TEST 2 — STATIONARITY
 *
 * QUESTION
 * --------
 * Does the generator stay the same across seasons?
 *
 * HYPOTHESIS UNDER TEST
 * ---------------------
 * "The generator does not drift across seasons."
 *   COMPATIBLE   — a frozen model is not beaten by a refitting one, and the
 *                  per-season outcome mix is homogeneous.
 *   INCOMPATIBLE — a rolling refit beats the frozen warm-up model out-of-sample
 *                  by more than the practical threshold. That IS drift.
 *   INCONCLUSIVE — the interval spans both, or the sample is too small.
 *
 * INTERPRETATION LIMIT
 * --------------------
 * A frozen model also degrades when the TEAMS change (promotion, relegation,
 * squad turnover), which is drift of the population, not necessarily of the
 * generator's mechanics. The chi-square homogeneity row is reported next to the
 * OOS delta so the two can be read together.
 */

import type { League, MatchRow, Season } from '../../types/winmix';
import { chiSquareSf } from '../stats';
import { buildImplication } from './implication';
import { collectLeagueMatches } from './independence';
import { DEFAULT_RATING_CONFIG, buildFeatureRows } from './ratings';
import type { RatingConfig } from './ratings';
import type { Conclusion, SeasonSlice, StationarityReport, TestResult } from './types';
import {
  DEFAULT_WALK_FORWARD_OPTIONS,
  signFlipPValue,
  walkForwardCompare,
} from './walkforward';
import type { ModelSpec, WalkForwardOptions } from './walkforward';

export interface StationarityOptions extends WalkForwardOptions {
  ratingConfig: RatingConfig;
  /** Smallest mean log-loss gain of refitting that counts as real drift. */
  meaningfulLogLoss: number;
}

export const DEFAULT_STATIONARITY_OPTIONS: StationarityOptions = {
  ...DEFAULT_WALK_FORWARD_OPTIONS,
  ratingConfig: DEFAULT_RATING_CONFIG,
  meaningfulLogLoss: 0.002,
};

/** Baseline: fitted once on the warm-up window and never refitted. */
const FROZEN: ModelSpec = {
  label: 'Frozen model — fitted once on the warm-up window',
  features: ['ratingDiff'],
  frozen: true,
};

/** Candidate: the same specification, refitted on a rolling window. */
const REFIT: ModelSpec = {
  label: 'Rolling refit — same features, refitted walk-forward',
  features: ['ratingDiff'],
};

/** Per-season descriptive slices, in season order. */
export function computeSeasonSlices(
  seasons: readonly Season[],
  league: League,
): SeasonSlice[] {
  return seasons
    .filter((s) => s.league === league)
    .slice()
    .sort((a, b) => a.seasonIndex - b.seasonIndex)
    .map((season, i) => {
      const matches = season.matches;
      const n = matches.length;
      const homeWins = matches.filter((m) => m.outcome === 'H').length;
      const draws = matches.filter((m) => m.outcome === 'D').length;
      const goals = matches.reduce((acc, m) => acc + m.home_score + m.away_score, 0);
      return {
        seasonIndex: i,
        name: season.name,
        matches: n,
        homeWinRate: n > 0 ? homeWins / n : 0,
        drawRate: n > 0 ? draws / n : 0,
        goalsPerMatch: n > 0 ? goals / n : 0,
      };
    });
}

/**
 * Chi-square homogeneity of the H/D/A distribution across seasons.
 * Seasons with no matches are dropped; df = (seasons − 1) * 2.
 */
export function outcomeHomogeneity(
  seasons: readonly Season[],
  league: League,
): { statistic: number; df: number; p: number } {
  const rows = seasons
    .filter((s) => s.league === league && s.matches.length > 0)
    .map((s) => {
      const counts = [0, 0, 0];
      for (const m of s.matches) {
        counts[m.outcome === 'H' ? 0 : m.outcome === 'D' ? 1 : 2]++;
      }
      return counts;
    });

  if (rows.length < 2) return { statistic: 0, df: 0, p: 1 };

  const colTotals = [0, 1, 2].map((c) => rows.reduce((acc, r) => acc + r[c], 0));
  const grand = colTotals.reduce((a, c) => a + c, 0);
  let statistic = 0;
  for (const row of rows) {
    const rowTotal = row.reduce((a, c) => a + c, 0);
    for (let c = 0; c < 3; c++) {
      const expected = (rowTotal * colTotals[c]) / grand;
      if (expected <= 0) continue;
      statistic += (row[c] - expected) ** 2 / expected;
    }
  }
  const df = (rows.length - 1) * 2;
  return { statistic, df, p: chiSquareSf(statistic, df) };
}

/**
 * Reading of the refit-minus-frozen ΔLogLoss for the NO-DRIFT hypothesis.
 * Note the inversion: a real out-of-sample GAIN from refitting is evidence
 * AGAINST stationarity.
 */
export function concludeDrift(
  ci95Low: number,
  ci95High: number,
  threshold: number,
): { conclusion: Conclusion; rationale: string } {
  if (ci95High < -threshold) {
    return {
      conclusion: 'INCOMPATIBLE',
      rationale:
        'A rolling refit beats the frozen warm-up model out-of-sample by more than ' +
        'the practical threshold: the generator (or the population it describes) ' +
        'moves between seasons.',
    };
  }
  if (ci95Low > -threshold && ci95High < threshold) {
    return {
      conclusion: 'COMPATIBLE',
      rationale:
        'Refitting buys no out-of-sample accuracy over a frozen model, so no drift ' +
        'is detectable at this sample size under this baseline.',
    };
  }
  return {
    conclusion: 'INCONCLUSIVE',
    rationale:
      'The 95% interval spans both meaningful drift and none; the available sample ' +
      'does not separate the two.',
  };
}

/**
 * Runs the Stationarity test for one league.
 * Returns null when no leakage-safe walk-forward comparison is possible.
 */
export function runStationarityTest(
  seasons: readonly Season[],
  league: League,
  options: StationarityOptions = DEFAULT_STATIONARITY_OPTIONS,
): StationarityReport | null {
  const matches: MatchRow[] = collectLeagueMatches(seasons, league);
  if (matches.length === 0) return null;

  const rows = buildFeatureRows(matches, options.ratingConfig);
  const wf = walkForwardCompare(rows, FROZEN, REFIT, 0, options);
  if (!wf) return null;

  const slices = computeSeasonSlices(seasons, league);
  const homeRates = slices.filter((s) => s.matches > 0).map((s) => s.homeWinRate);
  const { conclusion, rationale } = concludeDrift(
    wf.comparison.deltaLogLoss.ci95Low,
    wf.comparison.deltaLogLoss.ci95High,
    options.meaningfulLogLoss,
  );

  const result: TestResult = {
    conclusion,
    effectLabel: 'OOS ΔLogLoss (rolling refit − frozen model), negative = drift',
    effect: wf.comparison.deltaLogLoss,
    rawPValue: signFlipPValue(wf.logLossDeltas, options.bootstrapIterations, options.seed),
    oosDeltaBrier: wf.comparison.deltaBrier.estimate,
    oosDeltaLogLoss: wf.comparison.deltaLogLoss.estimate,
    sampleSize: wf.comparison.candidate.n,
    leakageSafe: true,
    rationale,
  };

  return {
    dataset: {
      league,
      seasonCount: slices.length,
      matchCount: matches.length,
      sampleSize: wf.comparison.candidate.n,
      seed: options.seed,
    },
    seasons: slices,
    outcomeHomogeneity: outcomeHomogeneity(seasons, league),
    homeWinRateSpread:
      homeRates.length > 0 ? Math.max(...homeRates) - Math.min(...homeRates) : 0,
    comparison: wf.comparison,
    result,
    // Drift (INCOMPATIBLE with stationarity) is what justifies refitting, so the
    // KEEP mapping is inverted relative to a "structure exists" test.
    implication: buildImplication(
      'Gördülő újraillesztés (drift-kezelés)',
      'ACTIVE — a pipeline gördülő ablakon illeszt újra',
      result,
      false,
    ),
  };
}
