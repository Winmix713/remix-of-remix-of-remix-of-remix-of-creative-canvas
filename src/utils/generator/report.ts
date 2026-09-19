/**
 * report — the per-league aggregate of the Generator Structure Suite.
 *
 * Responsibilities, and nothing else:
 *  1. run the five structure tests plus the minimal baseline for ONE league,
 *  2. put every raw p-value through Benjamini–Hochberg so no verdict is read
 *     at an uncorrected alpha,
 *  3. collect the MODEL IMPLICATIONS rows (suggestions only),
 *  4. attach the caveats a reader must carry with every number,
 *  5. serialise the whole thing to deterministic JSON.
 *
 * READ-ONLY. Nothing here writes state, touches the Prediction Engine or
 * changes any configuration.
 */

import type { League, Season } from '../../types/winmix';
import { runGoalDistributionTest } from './goalDistribution';
import type { GoalDistributionOptions } from './goalDistribution';
import { runH2HTest } from './h2h';
import type { H2HOptions } from './h2h';
import { runIndependenceTest } from './independence';
import type { IndependenceOptions } from './independence';
import { runMinimalBaseline } from './baseline';
import { DEFAULT_FDR, benjaminiHochberg } from './multipleTesting';
import { runHomeAdvantageTest } from './homeAdvantage';
import type { HomeAdvantageOptions } from './homeAdvantage';
import { runStationarityTest } from './stationarity';
import type { StationarityOptions } from './stationarity';
import { DEFAULT_GOAL_DISTRIBUTION_OPTIONS } from './goalDistribution';
import { DEFAULT_H2H_OPTIONS } from './h2h';
import { DEFAULT_HOME_ADVANTAGE_OPTIONS } from './homeAdvantage';
import { DEFAULT_INDEPENDENCE_OPTIONS } from './independence';
import { DEFAULT_STATIONARITY_OPTIONS } from './stationarity';
import { collectLeagueMatches } from './independence';
import type {
  GeneratorReport,
  ModelImplication,
  MultiplicityRow,
  TestResult,
} from './types';
import { DEFAULT_WALK_FORWARD_OPTIONS } from './walkforward';
import type { WalkForwardOptions } from './walkforward';

/** Stable, human-readable names of the five hypotheses. */
export const TEST_LABELS = {
  independence: 'Independence / form',
  stationarity: 'Stationarity',
  homeAdvantage: 'Home advantage',
  h2h: 'Head-to-head',
  goalDistribution: 'Goal distribution',
} as const;

export interface GeneratorSuiteOptions {
  walkForward: WalkForwardOptions;
  independence: IndependenceOptions;
  stationarity: StationarityOptions;
  homeAdvantage: HomeAdvantageOptions;
  h2h: H2HOptions;
  goalDistribution: GoalDistributionOptions;
  /** False discovery rate of the Benjamini–Hochberg correction. */
  fdr: number;
}

export const DEFAULT_SUITE_OPTIONS: GeneratorSuiteOptions = {
  walkForward: DEFAULT_WALK_FORWARD_OPTIONS,
  independence: DEFAULT_INDEPENDENCE_OPTIONS,
  stationarity: DEFAULT_STATIONARITY_OPTIONS,
  homeAdvantage: DEFAULT_HOME_ADVANTAGE_OPTIONS,
  h2h: DEFAULT_H2H_OPTIONS,
  goalDistribution: DEFAULT_GOAL_DISTRIBUTION_OPTIONS,
  fdr: DEFAULT_FDR,
};

/** The hard limits that must travel with every number in the report. */
export const SUITE_CAVEATS: string[] = [
  'A teszt soha nem bizonyít: minden válasz COMPATIBLE / INCOMPATIBLE / INCONCLUSIVE.',
  'A rating maga is múltbeli meccsekből épül, ezért a nulla eredmény annyit jelent: ' +
    'ezen a baseline-on nem mérhető TOVÁBBI out-of-sample jel — nem azt, hogy a ' +
    'generátorban nincs ilyen szerkezet.',
  'Öt hipotézis ugyanazon az adaton fut, ezért nyers p-érték önmagában nem olvasható: ' +
    'a döntéshez a Benjamini–Hochberg korrigált érték tartozik.',
  'A MODEL IMPLICATIONS blokk javaslat. A csomag semmilyen beállítást nem módosít ' +
    '(automaticConfigurationChange = false minden soron).',
  'Minden szám egyetlen ligára vonatkozik; a ligák eredményei soha nem összevonhatók.',
  'Minden predikciós összevetés szigorúan walk-forward: a t. meccset kizárólag a ' +
    't-nél korábbi meccseken illesztett modell pontozza.',
];

/**
 * Runs the whole suite for one league.
 *
 * Every test may independently return null (insufficient sample); the report
 * then carries null in that slot and the test simply does not appear in the
 * multiplicity ledger or the implications list.
 */
export function runGeneratorSuite(
  seasons: readonly Season[],
  league: League,
  options: GeneratorSuiteOptions = DEFAULT_SUITE_OPTIONS,
): GeneratorReport {
  const matches = collectLeagueMatches(seasons, league);
  const baseline = runMinimalBaseline(seasons, league, options.walkForward);
  const independence = runIndependenceTest(seasons, league, options.independence);
  const stationarity = runStationarityTest(seasons, league, options.stationarity);
  const homeAdvantage = runHomeAdvantageTest(seasons, league, options.homeAdvantage);
  const h2h = runH2HTest(seasons, league, options.h2h);
  const goalDistribution = runGoalDistributionTest(
    seasons,
    league,
    options.goalDistribution,
  );

  const entries: { test: string; rawPValue: number }[] = [];
  const push = (test: string, result: TestResult | undefined): void => {
    if (result && typeof result.rawPValue === 'number' && result.leakageSafe) {
      entries.push({ test, rawPValue: result.rawPValue });
    }
  };
  push(TEST_LABELS.independence, independence?.result);
  push(TEST_LABELS.stationarity, stationarity?.result);
  push(TEST_LABELS.homeAdvantage, homeAdvantage?.result);
  push(TEST_LABELS.h2h, h2h?.result);
  push(TEST_LABELS.goalDistribution, goalDistribution?.result);

  const multiplicity: MultiplicityRow[] = benjaminiHochberg(entries, options.fdr).map(
    (row) => ({
      test: row.test,
      rawPValue: row.rawPValue,
      adjustedPValue: row.adjustedPValue,
      rejected: row.rejected,
    }),
  );

  // Write the adjusted p-value back onto each result so a report can never show
  // a raw p-value without its correction.
  const adjustedFor = (test: string): number | undefined =>
    multiplicity.find((row) => row.test === test)?.adjustedPValue;
  if (independence) {
    independence.result.adjustedPValue = adjustedFor(TEST_LABELS.independence);
  }
  if (stationarity) {
    stationarity.result.adjustedPValue = adjustedFor(TEST_LABELS.stationarity);
  }
  if (homeAdvantage) {
    homeAdvantage.result.adjustedPValue = adjustedFor(TEST_LABELS.homeAdvantage);
  }
  if (h2h) h2h.result.adjustedPValue = adjustedFor(TEST_LABELS.h2h);
  if (goalDistribution) {
    goalDistribution.result.adjustedPValue = adjustedFor(TEST_LABELS.goalDistribution);
  }

  const implications: ModelImplication[] = [
    independence?.implication,
    stationarity?.implication,
    homeAdvantage?.implication,
    h2h?.implication,
    goalDistribution?.implication,
  ].filter((row): row is ModelImplication => Boolean(row));

  return {
    league,
    dataset: {
      league,
      seasonCount: seasons.filter((s) => s.league === league).length,
      matchCount: matches.length,
      sampleSize: baseline?.baseRate.n ?? 0,
      seed: options.walkForward.seed,
    },
    seed: options.walkForward.seed,
    fdr: options.fdr,
    baseline,
    independence,
    stationarity,
    homeAdvantage,
    h2h,
    goalDistribution,
    multiplicity,
    implications,
    caveats: SUITE_CAVEATS,
  };
}

/** How many of the five tests produced a leakage-safe verdict. */
export function completedTestCount(report: GeneratorReport): number {
  return [
    report.independence,
    report.stationarity,
    report.homeAdvantage,
    report.h2h,
    report.goalDistribution,
  ].filter((test) => test !== null && test.result.leakageSafe).length;
}

/**
 * Deterministic JSON serialisation of the report: same input and seed produce a
 * byte-identical string, so two exports can be diffed.
 */
export function generatorReportToJson(report: GeneratorReport): string {
  return JSON.stringify(
    {
      schema: 'winmix.generator-structure-suite/1',
      ...report,
    },
    null,
    2,
  );
}

/** Suggested download name of an export. Contains no clock-dependent value. */
export function generatorReportFileName(report: GeneratorReport): string {
  return `generator-suite-${report.league}-seed${report.seed}.json`;
}
