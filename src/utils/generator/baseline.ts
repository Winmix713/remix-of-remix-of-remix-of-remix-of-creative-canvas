/**
 * baseline.ts
 *
 * Minimal reference baseline for the walk-forward backtesting pipeline.
 *
 * The base-rate model uses NO team identity: match t is predicted solely by
 * the H/D/A frequencies of matches < t (Laplace-smoothed). If a richer model
 * cannot beat this out-of-sample, its extra structure buys nothing.
 *
 * Design principles:
 *  - Strict walk-forward: all state is updated AFTER scoring, never before.
 *  - No randomness beyond the seeded bootstrap.
 *  - `RatingConfigless` is NOT re-exported from here; import it from './types'.
 */

import type { League, Season } from '../../types/winmix';
import { logLoss, scoreAll } from '../backtest/metrics';
import type { ScoredPrediction } from '../backtest/metrics';
import type { Probs } from '../../types/winmix';
import { bootstrapMeanEffect } from './permutation';
import { buildFeatureRows, fitOrderedLogit, predictRow } from './ratings';
import type { FeatureRow } from './ratings';
import { collectLeagueMatches } from './independence';
import {
  DEFAULT_WALK_FORWARD_OPTIONS,
  MIN_SCORED_MATCHES,
  signFlipPValue,
} from './walkforward';
import type { WalkForwardOptions } from './walkforward';
import type { BaselineReport } from './types';

// ---------------------------------------------------------------------------
// Internal types
// ---------------------------------------------------------------------------

/** Mutable running counts of the three outcomes for the base-rate estimator. */
interface OutcomeCounts {
  h: number;
  d: number;
  a: number;
}

/** Accumulated per-match scoring state built by the walk-forward loop. */
interface WalkForwardAccumulator {
  scoredBase: ScoredPrediction[];
  scoredRating: ScoredPrediction[];
  logLossDeltas: number[];
  firstTest: number;
  lastTest: number;
  lastTrainEnd: number;
}

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

/**
 * Laplace-smoothed outcome probabilities derived from running outcome counts.
 *
 * Adds 1 pseudo-count per class so probabilities never collapse to zero,
 * which would make log-loss undefined.
 */
function baseRateProbs({ h, d, a }: OutcomeCounts): Probs {
  const total = h + d + a + 3; // +3 = one Laplace pseudo-count per class
  return {
    home: (h + 1) / total,
    draw: (d + 1) / total,
    away: (a + 1) / total,
  };
}

/** Increment the running outcome counts for a single observed result. */
function updateCounts(counts: OutcomeCounts, outcome: FeatureRow['outcome']): void {
  if (outcome === 'H') counts.h++;
  else if (outcome === 'D') counts.d++;
  else counts.a++;
}

// ---------------------------------------------------------------------------
// Walk-forward engine
// ---------------------------------------------------------------------------

/**
 * Executes the strict walk-forward evaluation loop.
 *
 * For every test match t (starting at `options.minTrain`):
 *  1. Predict with the current base-rate and rating model.
 *  2. Record predictions and the per-match log-loss delta.
 *  3. Optionally refit the rating model on a rolling training window.
 *  4. Update the running outcome counts with match t's observed result.
 *
 * The order of steps 2 → 4 is intentional: counts are updated AFTER scoring
 * to prevent any form of future leakage into the base-rate estimator.
 */
function runWalkForward(
  rows: FeatureRow[],
  options: WalkForwardOptions,
): WalkForwardAccumulator {
  const acc: WalkForwardAccumulator = {
    scoredBase: [],
    scoredRating: [],
    logLossDeltas: [],
    firstTest: -1,
    lastTest: -1,
    lastTrainEnd: options.minTrain - 1,
  };

  // Seed running counts from the initial training window.
  const counts: OutcomeCounts = { h: 0, d: 0, a: 0 };
  for (let i = 0; i < options.minTrain; i++) {
    updateCounts(counts, rows[i].outcome);
  }

  // Fit the initial rating model on the warm-up window.
  let model = fitOrderedLogit(
    rows.slice(0, options.minTrain),
    ['ratingDiff'],
    options.fitOptions,
  );

  for (let t = options.minTrain; t < rows.length; t++) {
    // Refit rating model periodically on a rolling window.
    const isRefitStep = t > options.minTrain && (t - options.minTrain) % options.refitInterval === 0;
    if (isRefitStep) {
      const trainStart = Math.max(0, t - options.trainWindow);
      model = fitOrderedLogit(rows.slice(trainStart, t), ['ratingDiff'], options.fitOptions);
      acc.lastTrainEnd = t - 1;
    }

    const row = rows[t];

    // --- Score BEFORE updating state ---
    const pBase = baseRateProbs(counts);
    const pRating = predictRow(model, row);

    acc.scoredBase.push({ probs: pBase, outcome: row.outcome });
    acc.scoredRating.push({ probs: pRating, outcome: row.outcome });
    acc.logLossDeltas.push(logLoss(pRating, row.outcome) - logLoss(pBase, row.outcome));

    if (acc.firstTest < 0) acc.firstTest = t;
    acc.lastTest = t;

    // --- Update state AFTER scoring ---
    updateCounts(counts, row.outcome);
  }

  return acc;
}

// ---------------------------------------------------------------------------
// Conclusion helpers
// ---------------------------------------------------------------------------

type Conclusion = 'COMPATIBLE' | 'INCONCLUSIVE' | 'INCOMPATIBLE';

function deriveConclusion(ci95Low: number, ci95High: number): Conclusion {
  if (ci95High < 0) return 'COMPATIBLE';
  if (ci95Low > 0) return 'INCOMPATIBLE';
  return 'INCONCLUSIVE';
}

function deriveRationale(conclusion: Conclusion): string {
  switch (conclusion) {
    case 'COMPATIBLE':
      return (
        'Team strength beats the identity-free base rate out-of-sample, so the ' +
        'richer tests are being read against a baseline that is itself informative.'
      );
    case 'INCOMPATIBLE':
      return (
        'The rating model is WORSE than the identity-free base rate out-of-sample; ' +
        'no conclusion in this report should be read as evidence of structure.'
      );
    case 'INCONCLUSIVE':
      return 'The rating model and the base rate are not separated by this sample.';
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Runs the minimal baseline evaluation for a single league.
 *
 * Returns `null` when there is insufficient data (no matches, too few rows,
 * or too few scored matches after walk-forward).
 *
 * @param seasons  - Full season dataset; only seasons matching `league` are used.
 * @param league   - League identifier to filter by.
 * @param options  - Walk-forward hyper-parameters (defaults to DEFAULT_WALK_FORWARD_OPTIONS).
 */
export function runMinimalBaseline(
  seasons: readonly Season[],
  league: League,
  options: WalkForwardOptions = DEFAULT_WALK_FORWARD_OPTIONS,
): BaselineReport | null {
  const matches = collectLeagueMatches(seasons, league);
  if (matches.length === 0) return null;

  const rows: FeatureRow[] = buildFeatureRows(matches);
  const minRows = options.minTrain + 20;
  if (rows.length <= minRows) return null;

  const acc = runWalkForward(rows, options);
  if (acc.scoredBase.length < MIN_SCORED_MATCHES) return null;

  // Bootstrap the mean log-loss delta and compute significance.
  const deltaLogLoss = bootstrapMeanEffect(
    acc.logLossDeltas,
    options.bootstrapIterations,
    options.seed,
  );
  const rawPValue = signFlipPValue(
    acc.logLossDeltas,
    options.bootstrapIterations,
    options.seed,
  );

  const baseRateMetrics = scoreAll(acc.scoredBase);
  const ratingMetrics = scoreAll(acc.scoredRating);
  const conclusion = deriveConclusion(deltaLogLoss.ci95Low, deltaLogLoss.ci95High);

  return {
    dataset: {
      league,
      seasonCount: seasons.filter((s) => s.league === league).length,
      matchCount: matches.length,
      sampleSize: acc.scoredBase.length,
      seed: options.seed,
    },
    baseRate: baseRateMetrics,
    ratingOnly: ratingMetrics,
    deltaLogLoss,
    leakage: {
      informationCutoff:
        'Base rates and the rating model both see matches < t only; the running ' +
        'frequency counters are updated after match t has been scored.',
      trainingRange: [0, acc.lastTrainEnd],
      testRange: [acc.firstTest, acc.lastTest],
      leakageSafe: true,
    },
    result: {
      conclusion,
      effectLabel: 'OOS ΔLogLoss (rating-only − base rate), negative = rating helps',
      effect: deltaLogLoss,
      rawPValue,
      oosDeltaBrier: ratingMetrics.brier - baseRateMetrics.brier,
      oosDeltaLogLoss: deltaLogLoss.estimate,
      sampleSize: acc.scoredBase.length,
      leakageSafe: true,
      rationale: deriveRationale(conclusion),
    },
  };
}
