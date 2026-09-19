/**
 * baseline — the minimal reference every other number is read against.
 *
 * The base-rate model uses NO team identity: match t is predicted by the
 * H/D/A frequencies of matches < t (Laplace-smoothed). If a richer model
 * cannot beat this out-of-sample, its extra structure buys nothing.
 *
 * Strict walk-forward, no randomness beyond the seeded bootstrap.
 */

import type { League, Season } from '../../types/winmix';
import { brier, logLoss, scoreAll } from '../backtest/metrics';
import type { ScoredPrediction } from '../backtest/metrics';
import type { Probs } from '../../types/winmix';
import { bootstrapMeanEffect } from './permutation';
import { buildFeatureRows, fitOrderedLogit, predictRow } from './ratings';
import type { FeatureRow } from './ratings';
import { collectLeagueMatches } from './independence';
import {
  DEFAULT_WALK_FORWARD_OPTIONS,
  MIN_SCORED_MATCHES,
  signFlipPValue } from
'./walkforward';
import type { WalkForwardOptions } from './walkforward';
import type { BaselineReport, RatingConfigless } from './types';

/** Laplace-smoothed running frequencies of the three outcomes. */
function baseRateProbs(h: number, d: number, a: number): Probs {
  const total = h + d + a + 3;
  return { home: (h + 1) / total, draw: (d + 1) / total, away: (a + 1) / total };
}

export function runMinimalBaseline(
seasons: readonly Season[],
league: League,
options: WalkForwardOptions = DEFAULT_WALK_FORWARD_OPTIONS)
: BaselineReport | null {
  const matches = collectLeagueMatches(seasons, league);
  if (matches.length === 0) return null;
  const rows: FeatureRow[] = buildFeatureRows(matches);
  if (rows.length <= options.minTrain + 20) return null;

  const scoredBase: ScoredPrediction[] = [];
  const scoredRating: ScoredPrediction[] = [];
  const logLossDeltas: number[] = [];

  let h = 0, d = 0, a = 0;
  for (let i = 0; i < options.minTrain; i++) {
    const o = rows[i].outcome;
    if (o === 'H') h++;else if (o === 'D') d++;else a++;
  }

  let model = fitOrderedLogit(rows.slice(0, options.minTrain), ['ratingDiff'], options.fitOptions);
  let firstTest = -1;
  let lastTest = -1;
  let lastTrainEnd = options.minTrain - 1;

  for (let t = options.minTrain; t < rows.length; t++) {
    if ((t - options.minTrain) % options.refitInterval === 0 && t > options.minTrain) {
      const train = rows.slice(Math.max(0, t - options.trainWindow), t);
      model = fitOrderedLogit(train, ['ratingDiff'], options.fitOptions);
      lastTrainEnd = t - 1;
    }
    const row = rows[t];
    const pBase = baseRateProbs(h, d, a);
    const pRating = predictRow(model, row);
    scoredBase.push({ probs: pBase, outcome: row.outcome });
    scoredRating.push({ probs: pRating, outcome: row.outcome });
    logLossDeltas.push(logLoss(pRating, row.outcome) - logLoss(pBase, row.outcome));
    if (firstTest < 0) firstTest = t;
    lastTest = t;

    // Update the running frequencies AFTER scoring — never before.
    if (row.outcome === 'H') h++;else if (row.outcome === 'D') d++;else a++;
  }

  if (scoredBase.length < MIN_SCORED_MATCHES) return null;

  const deltaLogLoss = bootstrapMeanEffect(
    logLossDeltas,
    options.bootstrapIterations,
    options.seed
  );
  const rawPValue = signFlipPValue(
    logLossDeltas,
    options.bootstrapIterations,
    options.seed
  );

  return {
    dataset: {
      league,
      seasonCount: seasons.filter((s) => s.league === league).length,
      matchCount: matches.length,
      sampleSize: scoredBase.length,
      seed: options.seed
    },
    baseRate: scoreAll(scoredBase),
    ratingOnly: scoreAll(scoredRating),
    deltaLogLoss,
    leakage: {
      informationCutoff:
      'Base rates and the rating model both see matches < t only; the running ' +
      'frequency counters are updated after match t has been scored.',
      trainingRange: [0, lastTrainEnd],
      testRange: [firstTest, lastTest],
      leakageSafe: true
    },
    result: {
      conclusion:
      deltaLogLoss.ci95High < 0 ?
      'COMPATIBLE' :
      deltaLogLoss.ci95Low > 0 ?
      'INCOMPATIBLE' :
      'INCONCLUSIVE',
      effectLabel: 'OOS ΔLogLoss (rating-only − base rate), negative = rating helps',
      effect: deltaLogLoss,
      rawPValue,
      oosDeltaBrier:
      scoreAll(scoredRating).brier - scoreAll(scoredBase).brier,
      oosDeltaLogLoss: deltaLogLoss.estimate,
      sampleSize: scoredBase.length,
      leakageSafe: true,
      rationale:
      deltaLogLoss.ci95High < 0 ?
      'Team strength beats the identity-free base rate out-of-sample, so the ' +
      'richer tests are being read against a baseline that is itself informative.' :
      deltaLogLoss.ci95Low > 0 ?
      'The rating model is WORSE than the identity-free base rate out-of-sample; ' +
      'no conclusion in this report should be read as evidence of structure.' :
      'The rating model and the base rate are not separated by this sample.'
    }
  };
}

/** Per-match Brier of a single scored set — exported for the report table. */
export function brierOf(rows: readonly ScoredPrediction[]): number[] {
  return rows.map((r) => brier(r.probs, r.outcome));
}

export type { RatingConfigless };
