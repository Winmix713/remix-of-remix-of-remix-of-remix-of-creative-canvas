/**
 * TEST 3 — HOME ADVANTAGE
 *
 * QUESTION
 * --------
 * Is there a home effect in the generator beyond team strength?
 *
 * HYPOTHESIS UNDER TEST
 * ---------------------
 * "The generator contains a home advantage."
 *   COMPATIBLE   — a model allowed to express a home effect predicts better
 *                  out-of-sample than one structurally unable to.
 *   INCOMPATIBLE — the OOS interval sits inside the practical-irrelevance band.
 *   INCONCLUSIVE — the interval spans both, or the sample is too small.
 *
 * HOW THE BASELINE IS MADE BLIND
 * ------------------------------
 * The baseline pins the latent intercept to 0 (`fixedIntercept: 0`), so it can
 * only express strength differences. The descriptive home/draw/away rates and
 * the mean goal difference are reported alongside, but the verdict rests on the
 * out-of-sample delta, never on the raw rates.
 */

import type { League, Season } from '../../types/winmix';
import { buildImplication } from './implication';
import { collectLeagueMatches } from './independence';
import { bootstrapMeanEffect } from './permutation';
import { DEFAULT_RATING_CONFIG, buildFeatureRows } from './ratings';
import type { RatingConfig } from './ratings';
import type { HomeAdvantageReport, TestResult } from './types';
import {
  DEFAULT_WALK_FORWARD_OPTIONS,
  concludeFromDelta,
  signFlipPValue,
  walkForwardCompare,
} from './walkforward';
import type { ModelSpec, WalkForwardOptions } from './walkforward';

export interface HomeAdvantageOptions extends WalkForwardOptions {
  ratingConfig: RatingConfig;
  /** Smallest mean log-loss gain that counts as a real home effect. */
  meaningfulLogLoss: number;
}

export const DEFAULT_HOME_ADVANTAGE_OPTIONS: HomeAdvantageOptions = {
  ...DEFAULT_WALK_FORWARD_OPTIONS,
  ratingConfig: DEFAULT_RATING_CONFIG,
  meaningfulLogLoss: 0.002,
};

/** Baseline: the latent intercept is pinned to 0 — no home effect expressible. */
const NO_HOME: ModelSpec = {
  label: 'Baseline — rating only, intercept pinned to 0',
  features: ['ratingDiff'],
  fixedIntercept: 0,
};

/** Candidate: the same features with a freely fitted home intercept. */
const WITH_HOME: ModelSpec = {
  label: 'Candidate — rating + fitted home intercept',
  features: ['ratingDiff'],
};

/**
 * Runs the Home Advantage test for one league.
 * Returns null when no leakage-safe walk-forward comparison is possible.
 */
export function runHomeAdvantageTest(
  seasons: readonly Season[],
  league: League,
  options: HomeAdvantageOptions = DEFAULT_HOME_ADVANTAGE_OPTIONS,
): HomeAdvantageReport | null {
  const matches = collectLeagueMatches(seasons, league);
  if (matches.length === 0) return null;

  const rows = buildFeatureRows(matches, options.ratingConfig);
  const wf = walkForwardCompare(rows, NO_HOME, WITH_HOME, 0, options);
  if (!wf) return null;

  const n = matches.length;
  const homeWins = matches.filter((m) => m.outcome === 'H').length;
  const draws = matches.filter((m) => m.outcome === 'D').length;
  const awayWins = matches.filter((m) => m.outcome === 'A').length;
  const meanGoalDiff = bootstrapMeanEffect(
    matches.map((m) => m.home_score - m.away_score),
    options.bootstrapIterations,
    options.seed,
  );

  const { conclusion, rationale } = concludeFromDelta(
    wf.comparison.deltaLogLoss,
    options.meaningfulLogLoss,
    {
      compatible:
        'A model allowed a home intercept beats an intercept-free one out-of-sample ' +
        'by more than the practical threshold: a home effect is present.',
      incompatible:
        'Allowing a home intercept does not improve out-of-sample log-loss beyond the ' +
        'practical-irrelevance band, so no home effect is detectable under this baseline.',
      inconclusive:
        'The 95% interval spans both a meaningful home effect and none; the available ' +
        'sample does not separate them.',
    },
  );

  const result: TestResult = {
    conclusion,
    effectLabel: 'OOS ΔLogLoss (home intercept − no intercept), negative = home effect',
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
      seasonCount: seasons.filter((s) => s.league === league).length,
      matchCount: n,
      sampleSize: wf.comparison.candidate.n,
      seed: options.seed,
    },
    homeWinRate: homeWins / n,
    awayWinRate: awayWins / n,
    drawRate: draws / n,
    meanGoalDiff,
    comparison: wf.comparison,
    result,
    implication: buildImplication(
      'Hazai előny (venue-hatás)',
      'ACTIVE — a predikciós motor külön hazai/vendég tagot használ',
      result,
    ),
  };
}
