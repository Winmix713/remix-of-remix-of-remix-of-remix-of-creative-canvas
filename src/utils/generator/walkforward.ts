/**
 * walkforward — the ONE strictly out-of-sample comparison engine of the suite.
 *
 * Every predictive test (Independence, Home Advantage, H2H, Stationarity)
 * routes through `walkForwardCompare`, so no two tests can disagree about what
 * "out-of-sample" means. The contract is fixed:
 *
 *   The model that scores match t was fitted exclusively on matches < t, and
 *   every feature in row t was built exclusively from matches < t.
 *
 * A model may be declared FROZEN: it is fitted once on the warm-up window and
 * never refitted. That is how the Stationarity test asks whether the generator
 * drifts — a frozen model degrading against a refitting one IS the drift.
 */

import { brier, logLoss, scoreAll } from '../backtest/metrics';
import type { ScoredPrediction } from '../backtest/metrics';
import { BOOTSTRAP_ITERATIONS, BOOTSTRAP_SEED } from '../constants';
import { bootstrapMeanEffect, mean, permutationTest } from './permutation';
import {
  DEFAULT_FIT_OPTIONS,
  fitOrderedLogit,
  predictRow } from
'./ratings';
import type { FeatureKey, FeatureRow, FitOptions, OrderedLogitModel } from './ratings';
import type { Conclusion, Effect, OosComparison } from './types';

export interface WalkForwardOptions {
  /** Matches used to warm up before the first out-of-sample prediction. */
  minTrain: number;
  /** Refit cadence, in matches. Keeps the walk-forward cost bounded. */
  refitInterval: number;
  /** Maximum number of most-recent matches used for one fit. */
  trainWindow: number;
  bootstrapIterations: number;
  seed: number;
  fitOptions: FitOptions;
}

export const DEFAULT_WALK_FORWARD_OPTIONS: WalkForwardOptions = {
  minTrain: 200,
  refitInterval: 50,
  trainWindow: 1200,
  bootstrapIterations: BOOTSTRAP_ITERATIONS,
  seed: BOOTSTRAP_SEED,
  fitOptions: DEFAULT_FIT_OPTIONS
};

/** Smallest number of scored matches that may carry a conclusion. */
export const MIN_SCORED_MATCHES = 50;

export interface ModelSpec {
  label: string;
  features: FeatureKey[];
  /** Pin the latent intercept (e.g. 0 = no home advantage may be expressed). */
  fixedIntercept?: number | null;
  /** Fit once on the warm-up window and never refit. */
  frozen?: boolean;
}

export interface WalkForwardOutput {
  comparison: OosComparison;
  /** Per-match candidate − baseline differences, in chronological order. */
  brierDeltas: number[];
  logLossDeltas: number[];
}

function fit(
rows: readonly FeatureRow[],
spec: ModelSpec,
options: WalkForwardOptions)
: OrderedLogitModel {
  return fitOrderedLogit(rows, spec.features, {
    ...options.fitOptions,
    fixedIntercept: spec.fixedIntercept ?? null
  });
}

/**
 * Strict walk-forward comparison of two model specifications on one league's
 * feature table. Returns null when the sample cannot support a safe verdict.
 *
 * `requirePriorMatches` skips early rows whose features are not yet defined
 * (e.g. a 5-match form window). Both models see exactly the same scored rows,
 * so the comparison stays paired.
 */
export function walkForwardCompare(
rows: readonly FeatureRow[],
baselineSpec: ModelSpec,
candidateSpec: ModelSpec,
requirePriorMatches = 0,
options: WalkForwardOptions = DEFAULT_WALK_FORWARD_OPTIONS,
rowFilter?: (row: FeatureRow) => boolean)
: WalkForwardOutput | null {
  const { minTrain, refitInterval, trainWindow } = options;
  if (rows.length <= minTrain + 20) return null;

  const scoredBase: ScoredPrediction[] = [];
  const scoredCand: ScoredPrediction[] = [];
  const brierDeltas: number[] = [];
  const logLossDeltas: number[] = [];

  const warmUp = rows.slice(0, minTrain);
  let baseModel = fit(warmUp, baselineSpec, options);
  let candModel = fit(warmUp, candidateSpec, options);
  let firstTest = -1;
  let lastTest = -1;
  let lastTrainEnd = minTrain - 1;

  for (let t = minTrain; t < rows.length; t++) {
    if ((t - minTrain) % refitInterval === 0 && t > minTrain) {
      const train = rows.slice(Math.max(0, t - trainWindow), t);
      if (!baselineSpec.frozen) baseModel = fit(train, baselineSpec, options);
      if (!candidateSpec.frozen) candModel = fit(train, candidateSpec, options);
      lastTrainEnd = t - 1;
    }
    const row = rows[t];
    if (row.priorMatches < requirePriorMatches) continue;
    if (rowFilter && !rowFilter(row)) continue;

    const pb = predictRow(baseModel, row);
    const pc = predictRow(candModel, row);
    scoredBase.push({ probs: pb, outcome: row.outcome });
    scoredCand.push({ probs: pc, outcome: row.outcome });
    brierDeltas.push(brier(pc, row.outcome) - brier(pb, row.outcome));
    logLossDeltas.push(logLoss(pc, row.outcome) - logLoss(pb, row.outcome));

    if (firstTest < 0) firstTest = t;
    lastTest = t;
  }

  if (scoredBase.length < MIN_SCORED_MATCHES) return null;

  return {
    brierDeltas,
    logLossDeltas,
    comparison: {
      baselineLabel: baselineSpec.label,
      candidateLabel: candidateSpec.label,
      baseline: scoreAll(scoredBase),
      candidate: scoreAll(scoredCand),
      deltaBrier: bootstrapMeanEffect(
        brierDeltas,
        options.bootstrapIterations,
        options.seed
      ),
      deltaLogLoss: bootstrapMeanEffect(
        logLossDeltas,
        options.bootstrapIterations,
        options.seed
      ),
      leakage: {
        informationCutoff:
        'Match t is scored by a model fitted exclusively on matches < t; ' +
        'ratings, form and head-to-head features are built from matches < t only.' + (
        baselineSpec.frozen || candidateSpec.frozen ?
        ' One model is frozen on the warm-up window by design.' :
        ''),
        trainingRange: [0, lastTrainEnd],
        testRange: [firstTest, lastTest],
        leakageSafe: true
      }
    }
  };
}

/** Sign-flip permutation p-value for a paired per-match delta series. */
export function signFlipPValue(
deltas: readonly number[],
iterations: number = BOOTSTRAP_ITERATIONS,
seed: number = BOOTSTRAP_SEED)
: number {
  return permutationTest<readonly number[]>(
    deltas,
    (d) => mean(d),
    (d, rand) => d.map((v) => rand() < 0.5 ? -v : v),
    iterations,
    seed
  ).pValue;
}

export interface DeltaVerdictText {
  /** Why a real out-of-sample gain means the hypothesis is compatible. */
  compatible: string;
  /** Why a null result means it is incompatible. */
  incompatible: string;
  inconclusive: string;
}

/**
 * The suite-wide reading of an out-of-sample ΔLogLoss (candidate − baseline).
 * Negative = the candidate predicts better.
 *
 * COMPATIBLE   — the whole 95% interval is on the improving side of the
 *                practical-irrelevance threshold.
 * INCOMPATIBLE — the whole interval is inside the irrelevance band.
 * INCONCLUSIVE — the interval spans both; the sample does not separate them.
 */
export function concludeFromDelta(
deltaLogLoss: Effect,
threshold: number,
text: DeltaVerdictText)
: { conclusion: Conclusion; rationale: string } {
  if (deltaLogLoss.ci95High < -threshold) {
    return { conclusion: 'COMPATIBLE', rationale: text.compatible };
  }
  if (deltaLogLoss.ci95Low > -threshold && deltaLogLoss.ci95High < threshold) {
    return { conclusion: 'INCOMPATIBLE', rationale: text.incompatible };
  }
  return { conclusion: 'INCONCLUSIVE', rationale: text.inconclusive };
}
