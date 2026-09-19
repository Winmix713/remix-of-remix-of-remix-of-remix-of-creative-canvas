/**
 * Generator Structure Suite — shared type contract.
 *
 * READ-ONLY MODULE FAMILY. Nothing under src/utils/generator/ may write state,
 * touch the Prediction Engine, alter ratings, gates, ranking, calibration or
 * feature flags. It consumes Season[] / MatchRow[] and emits a report.
 *
 * VOCABULARY. A test never "proves" anything. Every statistical answer is one
 * of COMPATIBLE / INCOMPATIBLE / INCONCLUSIVE. KEEP / REMOVE exist only in the
 * MODEL IMPLICATIONS layer, and only alongside effect size, CI and OOS deltas.
 */

import type { League } from '../../types/winmix';

/**
 * Verdict on a generator hypothesis.
 * - COMPATIBLE   — the hypothesis is compatible with what the data shows.
 * - INCOMPATIBLE — observation and hypothesis differ materially (effect + OOS).
 * - INCONCLUSIVE — validity, sample or uncertainty forbids a verdict.
 */
export type Conclusion = 'COMPATIBLE' | 'INCOMPATIBLE' | 'INCONCLUSIVE';

/** Suggested state in the MODEL IMPLICATIONS block. Never applied automatically. */
export type ImplicationState = 'KEEP' | 'REMOVE' | 'INCONCLUSIVE';

/** A point estimate with its 95% interval. Never report one without the other. */
export interface Effect {
  estimate: number;
  ci95Low: number;
  ci95High: number;
}

/** What information a predictive test was allowed to see. */
export interface LeakageAudit {
  /** Human-readable description of the cutoff rule, e.g. "matches 1..t-1". */
  informationCutoff: string;
  /** Inclusive 0-based index range used for fitting. */
  trainingRange: [number, number];
  /** Inclusive 0-based index range scored out-of-sample. */
  testRange: [number, number];
  leakageSafe: boolean;
}

/** Dataset provenance — a report without this block is not interpretable. */
export interface DatasetInfo {
  league: League;
  seasonCount: number;
  matchCount: number;
  sampleSize: number;
  seed: number;
}

/** The canonical result shape of every statistical test in the suite. */
export interface TestResult {
  conclusion: Conclusion;
  /** What the effect measures, in words, so the number is never read blind. */
  effectLabel: string;
  effect: Effect;
  rawPValue?: number;
  adjustedPValue?: number;
  oosDeltaBrier?: number;
  oosDeltaLogLoss?: number;
  sampleSize: number;
  leakageSafe: boolean;
  /** Why the conclusion is what it is, in one sentence. */
  rationale: string;
}

/** Out-of-sample metrics of one model over one test range. */
export interface OosMetrics {
  brier: number;
  logLoss: number;
  ece: number;
  n: number;
}

/** A strict walk-forward comparison of a baseline and a richer model. */
export interface OosComparison {
  baselineLabel: string;
  candidateLabel: string;
  baseline: OosMetrics;
  candidate: OosMetrics;
  /** candidate − baseline. Negative means the candidate predicts better. */
  deltaBrier: Effect;
  deltaLogLoss: Effect;
  leakage: LeakageAudit;
}

/**
 * One MODEL IMPLICATIONS row. `automaticConfigurationChange` is always false —
 * the suite reports, it never reconfigures.
 */
export interface ModelImplication {
  component: string;
  currentSetting: string;
  suiteResult: Conclusion;
  effect: Effect;
  oosDeltaBrier?: number;
  oosDeltaLogLoss?: number;
  suggestedState: ImplicationState;
  automaticConfigurationChange: false;
}

/** Per-league Independence (form) test output. */
export interface IndependenceReport {
  dataset: DatasetInfo;
  /** Autocorrelation / Ljung–Box / runs diagnostics, aggregated over teams. */
  series: SeriesDiagnostics;
  /** Model A (rating-only) vs Model B (rating + previous-5 form). */
  comparison: OosComparison;
  result: TestResult;
  implication: ModelImplication;
}

/** Aggregated per-team sequence diagnostics. */
export interface SeriesDiagnostics {
  teamsAnalysed: number;
  /** Mean autocorrelation across teams, index 0 = lag 1 … index 4 = lag 5. */
  meanAutocorrelation: number[];
  /** Share of teams whose Ljung–Box test rejects independence at alpha = .05. */
  ljungBoxRejectShare: number;
  /** Share of teams whose Wald–Wolfowitz runs test rejects at alpha = .05. */
  runsRejectShare: number;
  /** Median runs-test z across teams. Negative = streaky, positive = alternating. */
  medianRunsZ: number;
}

/* ---------------- PHASE 2 — the remaining structure tests ---------------- */

/** Per-season descriptive slice used by the Stationarity test. */
export interface SeasonSlice {
  seasonIndex: number;
  name: string;
  matches: number;
  homeWinRate: number;
  drawRate: number;
  goalsPerMatch: number;
}

/**
 * TEST 2 — STATIONARITY. Hypothesis: "the generator does not drift across
 * seasons". A refitting model beating a frozen one out-of-sample IS drift.
 */
export interface StationarityReport {
  dataset: DatasetInfo;
  seasons: SeasonSlice[];
  /** Chi-square homogeneity of the H/D/A distribution across seasons. */
  outcomeHomogeneity: { statistic: number; df: number; p: number };
  /** Spread of the per-season home-win rate (max − min). */
  homeWinRateSpread: number;
  /** Frozen warm-up model as baseline, rolling refit as candidate. */
  comparison: OosComparison;
  result: TestResult;
  implication: ModelImplication;
}

/**
 * TEST 3 — HOME ADVANTAGE. Hypothesis: "the generator contains a home
 * advantage". Baseline is structurally unable to express one (intercept = 0).
 */
export interface HomeAdvantageReport {
  dataset: DatasetInfo;
  homeWinRate: number;
  awayWinRate: number;
  drawRate: number;
  /** Mean goal difference (home − away) with a bootstrap 95% interval. */
  meanGoalDiff: Effect;
  comparison: OosComparison;
  result: TestResult;
  implication: ModelImplication;
}

/**
 * TEST 4 — HEAD-TO-HEAD. Hypothesis: "prior meetings of the same pair carry
 * out-of-sample information beyond rating and form".
 */
export interface H2HReport {
  dataset: DatasetInfo;
  /** Matches scored, i.e. those with at least `minPriorMeetings` history. */
  pairsWithHistory: number;
  meanPriorMeetings: number;
  comparison: OosComparison;
  result: TestResult;
  implication: ModelImplication;
}

/** One observed-vs-expected bin of the total-goals distribution. */
export interface GoalBin {
  goals: number;
  observed: number;
  expectedPoisson: number;
}

/**
 * TEST 5 — GOAL DISTRIBUTION. Hypothesis: "total goals per match follow a
 * Poisson law". Descriptive only: no predictive model is compared, so the
 * verdict rests on dispersion and goodness of fit, never on OOS deltas.
 */
export interface GoalDistributionReport {
  dataset: DatasetInfo;
  meanGoals: number;
  varianceGoals: number;
  /** variance / mean. 1 = Poisson, > 1 over-dispersed, < 1 under-dispersed. */
  dispersion: Effect;
  bins: GoalBin[];
  chiSquare: { statistic: number; df: number; p: number };
  /** Chi-square independence of "home scored" vs "away scored". */
  bttsIndependence: { statistic: number; df: number; p: number };
  result: TestResult;
  implication: ModelImplication;
}

/**
 * The minimal baseline every other number is read against: a walk-forward
 * league base-rate predictor that uses no team identity at all.
 */
export interface BaselineReport {
  dataset: DatasetInfo;
  /** Walk-forward base rates (frequencies of matches < t). */
  baseRate: OosMetrics;
  /** The rating-only model over the same scored matches. */
  ratingOnly: OosMetrics;
  /** ratingOnly − baseRate. Negative means team strength is worth something. */
  deltaLogLoss: Effect;
  leakage: LeakageAudit;
  result: TestResult;
}

/** One row of the multiple-testing ledger. */
export interface MultiplicityRow {
  test: string;
  rawPValue: number;
  adjustedPValue: number;
  /** Benjamini–Hochberg rejection at the report's FDR level. */
  rejected: boolean;
}

/** The whole suite for ONE league. Never merged across leagues. */
export interface GeneratorReport {
  /** ISO date of the data snapshot is NOT stored: the report must be pure. */
  league: League;
  dataset: DatasetInfo;
  seed: number;
  /** False discovery rate used by the Benjamini–Hochberg correction. */
  fdr: number;
  baseline: BaselineReport | null;
  independence: IndependenceReport | null;
  stationarity: StationarityReport | null;
  homeAdvantage: HomeAdvantageReport | null;
  h2h: H2HReport | null;
  goalDistribution: GoalDistributionReport | null;
  multiplicity: MultiplicityRow[];
  implications: ModelImplication[];
  /** Hard limits a reader must carry with every number above. */
  caveats: string[];
}
