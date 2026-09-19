/**
 * TEST 1 — INDEPENDENCE / FORM
 *
 * QUESTION
 * --------
 * Do a team's recent results carry out-of-sample predictive information BEYOND
 * what the rating already encodes?
 *
 * HYPOTHESIS UNDER TEST
 * ---------------------
 * "The generator contains a form component in addition to team strength."
 *   COMPATIBLE   — the data shows a real OOS gain from adding form.
 *   INCOMPATIBLE — the data shows no meaningful OOS gain (CI tight around 0).
 *   INCONCLUSIVE — the interval is too wide, or the test could not run safely.
 *
 * INTERPRETATION LIMIT (spec §7.3)
 * --------------------------------
 * The rating is itself built from past matches. A null result therefore means
 * "no detectable out-of-sample SURPLUS signal under this baseline", never
 * "there is no form in the generator".
 *
 * Every predictive comparison is strict walk-forward: the model scoring match t
 * was fitted only on matches < t.
 */

import type { League, MatchRow, Season } from '../../types/winmix';
import {
  autocorrelation,
  ljungBoxTest,
  median,
  runsTest } from
'../stats';
import { DEFAULT_RATING_CONFIG, buildFeatureRows } from './ratings';
import type { FeatureRow, RatingConfig } from './ratings';
import {
  DEFAULT_WALK_FORWARD_OPTIONS,
  concludeFromDelta,
  signFlipPValue,
  walkForwardCompare } from
'./walkforward';
import type { ModelSpec, WalkForwardOptions, WalkForwardOutput } from './walkforward';
import type {
  Conclusion,
  Effect,
  IndependenceReport,
  SeriesDiagnostics,
  TestResult } from
'./types';

export type { WalkForwardOutput };
export { signFlipPValue };

export interface IndependenceOptions extends WalkForwardOptions {
  ratingConfig: RatingConfig;
  /**
   * Smallest mean log-loss improvement considered practically meaningful.
   * Below this, an effect is noise-floor material regardless of its p-value.
   */
  meaningfulLogLoss: number;
}

export const DEFAULT_INDEPENDENCE_OPTIONS: IndependenceOptions = {
  ...DEFAULT_WALK_FORWARD_OPTIONS,
  ratingConfig: DEFAULT_RATING_CONFIG,
  meaningfulLogLoss: 0.002
};

const MODEL_A: ModelSpec = {
  label: 'Model A — rating only',
  features: ['ratingDiff']
};
const MODEL_B: ModelSpec = {
  label: 'Model B — rating + previous 5 match form',
  features: ['ratingDiff', 'formDiff', 'gdFormDiff']
};

/** Chronological match list of one league, seasons concatenated in order. */
export function collectLeagueMatches(
seasons: readonly Season[],
league: League)
: MatchRow[] {
  return seasons.
  filter((s) => s.league === league).
  slice().
  sort((a, b) => a.seasonIndex - b.seasonIndex).
  flatMap((s) => s.matches);
}

/* ---------------- sequence diagnostics ---------------- */

export function computeSeriesDiagnostics(
matches: readonly MatchRow[],
maxLag = 5)
: SeriesDiagnostics {
  const points = new Map<string, number[]>();
  const wins = new Map<string, boolean[]>();

  const push = (team: string, pts: number, won: boolean) => {
    const p = points.get(team) ?? [];
    p.push(pts);
    points.set(team, p);
    const w = wins.get(team) ?? [];
    w.push(won);
    wins.set(team, w);
  };

  for (const m of matches) {
    push(m.home_team, m.outcome === 'H' ? 3 : m.outcome === 'D' ? 1 : 0, m.outcome === 'H');
    push(m.away_team, m.outcome === 'A' ? 3 : m.outcome === 'D' ? 1 : 0, m.outcome === 'A');
  }

  const acfSums = new Array<number>(maxLag).fill(0);
  let teamsAnalysed = 0;
  let ljungRejects = 0;
  let runsRejects = 0;
  const runsZ: number[] = [];

  points.forEach((series, team) => {
    if (series.length < maxLag + 5) return;
    teamsAnalysed++;
    for (let lag = 1; lag <= maxLag; lag++) {
      acfSums[lag - 1] += autocorrelation(series, lag);
    }
    if (ljungBoxTest(series, maxLag).p < 0.05) ljungRejects++;
    const r = runsTest(wins.get(team) ?? []);
    runsZ.push(r.z);
    if (r.p < 0.05) runsRejects++;
  });

  return {
    teamsAnalysed,
    meanAutocorrelation: acfSums.map((s) => teamsAnalysed > 0 ? s / teamsAnalysed : 0),
    ljungBoxRejectShare: teamsAnalysed > 0 ? ljungRejects / teamsAnalysed : 0,
    runsRejectShare: teamsAnalysed > 0 ? runsRejects / teamsAnalysed : 0,
    medianRunsZ: median(runsZ)
  };
}

/* ---------------- walk-forward OOS comparison ---------------- */

/**
 * Model A (rating only) vs Model B (rating + previous-5 form), through the
 * shared walk-forward engine. Form features are only defined once both sides
 * have a full window, so earlier rows are skipped for BOTH models.
 */
export function walkForwardFormComparison(
rows: readonly FeatureRow[],
options: IndependenceOptions = DEFAULT_INDEPENDENCE_OPTIONS)
: WalkForwardOutput | null {
  return walkForwardCompare(
    rows,
    MODEL_A,
    MODEL_B,
    options.ratingConfig.formWindow,
    options
  );
}

/* ---------------- conclusion contract ---------------- */

export function concludeFormEffect(
deltaLogLoss: Effect,
threshold: number)
: { conclusion: Conclusion; rationale: string } {
  // Negative delta = the form model predicts better out-of-sample.
  return concludeFromDelta(deltaLogLoss, threshold, {
    compatible:
    'Adding previous-5 form improves out-of-sample log-loss by more than the ' +
    'practical threshold, with the whole 95% interval on the improving side.',
    incompatible:
    'The 95% interval of the out-of-sample log-loss change is contained within ' +
    'the practical-irrelevance band, so no surplus form signal is detectable ' +
    'beyond the rating under this baseline.',
    inconclusive:
    'The 95% interval spans both meaningful and negligible effects; the available ' +
    'sample does not separate them.'
  });
}

/* ---------------- entry point ---------------- */

export function runIndependenceTest(
seasons: readonly Season[],
league: League,
options: IndependenceOptions = DEFAULT_INDEPENDENCE_OPTIONS)
: IndependenceReport | null {
  const matches = collectLeagueMatches(seasons, league);
  const seasonCount = seasons.filter((s) => s.league === league).length;
  if (matches.length === 0) return null;

  const rows = buildFeatureRows(matches, options.ratingConfig);
  const series = computeSeriesDiagnostics(matches);
  const wf = walkForwardFormComparison(rows, options);

  const dataset = {
    league,
    seasonCount,
    matchCount: matches.length,
    sampleSize: wf ? wf.comparison.candidate.n : 0,
    seed: options.seed
  };

  if (!wf) {
    const result: TestResult = {
      conclusion: 'INCONCLUSIVE',
      effectLabel: 'OOS ΔLogLoss (rating+form − rating-only)',
      effect: { estimate: 0, ci95Low: 0, ci95High: 0 },
      sampleSize: 0,
      leakageSafe: false,
      rationale:
      'Too few matches for a leakage-safe walk-forward comparison; ' +
      'no MODEL IMPLICATIONS decision may be derived from this run.'
    };
    return {
      dataset,
      series,
      comparison: {
        baselineLabel: 'Model A — rating only',
        candidateLabel: 'Model B — rating + previous 5 match form',
        baseline: { brier: 0, logLoss: 0, ece: 0, n: 0 },
        candidate: { brier: 0, logLoss: 0, ece: 0, n: 0 },
        deltaBrier: { estimate: 0, ci95Low: 0, ci95High: 0 },
        deltaLogLoss: { estimate: 0, ci95Low: 0, ci95High: 0 },
        leakage: {
          informationCutoff: 'not run',
          trainingRange: [0, 0],
          testRange: [0, 0],
          leakageSafe: false
        }
      },
      result,
      implication: {
        component: 'Form (previous 5 matches)',
        currentSetting: 'ACTIVE — form features present in the WinMix design vector',
        suiteResult: 'INCONCLUSIVE',
        effect: { estimate: 0, ci95Low: 0, ci95High: 0 },
        suggestedState: 'INCONCLUSIVE',
        automaticConfigurationChange: false
      }
    };
  }

  const { conclusion, rationale } = concludeFormEffect(
    wf.comparison.deltaLogLoss,
    options.meaningfulLogLoss
  );
  const rawPValue = signFlipPValue(
    wf.logLossDeltas,
    options.bootstrapIterations,
    options.seed
  );

  const result: TestResult = {
    conclusion,
    effectLabel: 'OOS ΔLogLoss (rating+form − rating-only), negative = form helps',
    effect: wf.comparison.deltaLogLoss,
    rawPValue,
    oosDeltaBrier: wf.comparison.deltaBrier.estimate,
    oosDeltaLogLoss: wf.comparison.deltaLogLoss.estimate,
    sampleSize: wf.comparison.candidate.n,
    leakageSafe: true,
    rationale
  };

  return {
    dataset,
    series,
    comparison: wf.comparison,
    result,
    implication: {
      component: 'Form (previous 5 matches)',
      currentSetting: 'ACTIVE — form features present in the WinMix design vector',
      suiteResult: conclusion,
      effect: wf.comparison.deltaLogLoss,
      oosDeltaBrier: wf.comparison.deltaBrier.estimate,
      oosDeltaLogLoss: wf.comparison.deltaLogLoss.estimate,
      suggestedState:
      conclusion === 'COMPATIBLE' ?
      'KEEP' :
      conclusion === 'INCOMPATIBLE' ?
      'REMOVE' :
      'INCONCLUSIVE',
      automaticConfigurationChange: false
    }
  };
}
