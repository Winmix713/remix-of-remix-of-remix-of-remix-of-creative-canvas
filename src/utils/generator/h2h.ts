/**
 * TEST 4 — HEAD-TO-HEAD
 *
 * QUESTION
 * --------
 * Do the prior meetings of the SAME pair carry out-of-sample information
 * beyond rating and recent form?
 *
 * HYPOTHESIS UNDER TEST
 * ---------------------
 * "Pair history is informative beyond rating and form."
 *   COMPATIBLE   — adding the head-to-head feature improves OOS log-loss.
 *   INCOMPATIBLE — the OOS interval sits inside the practical-irrelevance band.
 *   INCONCLUSIVE — the interval spans both, or the sample is too small.
 *
 * SCORING SET
 * -----------
 * Only matches whose pair already has at least `minPriorMeetings` meetings are
 * scored, and BOTH models score exactly the same rows, so the comparison stays
 * paired. Pair history is built from matches < t only (see ratings.ts).
 */

import type { League, Season } from '../../types/winmix';
import { buildImplication } from './implication';
import { collectLeagueMatches } from './independence';
import { DEFAULT_RATING_CONFIG, buildFeatureRows } from './ratings';
import type { FeatureRow, RatingConfig } from './ratings';
import type { H2HReport, TestResult } from './types';
import {
  DEFAULT_WALK_FORWARD_OPTIONS,
  concludeFromDelta,
  signFlipPValue,
  walkForwardCompare,
} from './walkforward';
import type { ModelSpec, WalkForwardOptions } from './walkforward';

export interface H2HOptions extends WalkForwardOptions {
  ratingConfig: RatingConfig;
  /** A match is only scored once the pair has at least this many meetings. */
  minPriorMeetings: number;
  /** Smallest mean log-loss gain that counts as real pair information. */
  meaningfulLogLoss: number;
}

export const DEFAULT_H2H_OPTIONS: H2HOptions = {
  ...DEFAULT_WALK_FORWARD_OPTIONS,
  ratingConfig: DEFAULT_RATING_CONFIG,
  minPriorMeetings: 2,
  meaningfulLogLoss: 0.002,
};

/** Baseline: everything the suite already believes in — strength and form. */
const WITHOUT_H2H: ModelSpec = {
  label: 'Baseline — rating + form',
  features: ['ratingDiff', 'formDiff', 'gdFormDiff'],
};

/** Candidate: the same, plus the prior-meetings feature. */
const WITH_H2H: ModelSpec = {
  label: 'Candidate — rating + form + head-to-head',
  features: ['ratingDiff', 'formDiff', 'gdFormDiff', 'h2hDiff'],
};

/**
 * Runs the Head-to-Head test for one league.
 * Returns null when no leakage-safe walk-forward comparison is possible.
 */
export function runH2HTest(
  seasons: readonly Season[],
  league: League,
  options: H2HOptions = DEFAULT_H2H_OPTIONS,
): H2HReport | null {
  const matches = collectLeagueMatches(seasons, league);
  if (matches.length === 0) return null;

  const rows = buildFeatureRows(matches, options.ratingConfig);
  const hasHistory = (row: FeatureRow): boolean =>
    row.h2hMatches >= options.minPriorMeetings;

  const wf = walkForwardCompare(
    rows,
    WITHOUT_H2H,
    WITH_H2H,
    options.ratingConfig.formWindow,
    options,
    hasHistory,
  );
  if (!wf) return null;

  const scored = rows.filter(
    (row) => row.index >= options.minTrain && hasHistory(row) &&
      row.priorMatches >= options.ratingConfig.formWindow,
  );
  const meanPriorMeetings =
    scored.length > 0
      ? scored.reduce((acc, row) => acc + row.h2hMatches, 0) / scored.length
      : 0;

  const { conclusion, rationale } = concludeFromDelta(
    wf.comparison.deltaLogLoss,
    options.meaningfulLogLoss,
    {
      compatible:
        'Adding prior meetings of the same pair improves out-of-sample log-loss by ' +
        'more than the practical threshold, on top of rating and form.',
      incompatible:
        'Prior meetings add no out-of-sample accuracy beyond rating and form: the ' +
        '95% interval stays inside the practical-irrelevance band.',
      inconclusive:
        'The 95% interval spans both a meaningful pair effect and none; the available ' +
        'sample of repeat meetings does not separate them.',
    },
  );

  const result: TestResult = {
    conclusion,
    effectLabel: 'OOS ΔLogLoss (with H2H − without H2H), negative = H2H helps',
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
      matchCount: matches.length,
      sampleSize: wf.comparison.candidate.n,
      seed: options.seed,
    },
    pairsWithHistory: wf.comparison.candidate.n,
    meanPriorMeetings,
    comparison: wf.comparison,
    result,
    implication: buildImplication(
      'Irányhelyes H2H minta',
      'ACTIVE — a döntési rétegben recency-súlyozott H2H jel szerepel',
      result,
    ),
  };
}
