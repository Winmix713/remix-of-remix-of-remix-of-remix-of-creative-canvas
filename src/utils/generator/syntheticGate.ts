/**
 * Phase 1 — Synthetic Validation Gate.
 *
 * The suite's conclusions on real WinMix data are only trustworthy if the
 * suite can first recover KNOWN structure from controlled synthetic data.
 * This module defines the 12 mandatory synthetic scenarios from the plan
 * and a runner that checks each one.
 *
 * READ-ONLY. Nothing here writes state, touches the Prediction Engine or
 * changes any configuration.
 */

import type { League, Season } from '../../types/winmix';
import { runGeneratorSuite, DEFAULT_SUITE_OPTIONS } from './report';
import type { GeneratorReport } from './types';
import {
  makeSyntheticSeason,
  makeSyntheticSeasons,
  type SyntheticOptions,
} from './__tests__/synthetic';

/** The 12 mandatory synthetic scenarios from the Generator V2 plan. */
export type SyntheticScenarioId =
  | 'FORM_PRESENT'
  | 'FORM_ABSENT'
  | 'DRIFT_PRESENT'
  | 'DRIFT_ABSENT'
  | 'HOME_NONE'
  | 'HOME_GLOBAL'
  | 'HOME_TEAM_SPECIFIC'
  | 'H2H_NONE'
  | 'H2H_PRESENT'
  | 'POISSON'
  | 'UNDERDISPERSED'
  | 'DEPENDENT_GOALS';

export interface ScenarioConfig {
  id: SyntheticScenarioId;
  /** Human-readable description of what the generator encodes. */
  description: string;
  /** Which suite test should detect the structure. */
  targetTest: 'independence' | 'stationarity' | 'homeAdvantage' | 'h2h' | 'goalDistribution';
  /** What conclusion the suite is expected to reach. */
  expectedConclusion: 'COMPATIBLE' | 'INCOMPATIBLE' | 'INCONCLUSIVE';
  build: () => Season[];
}

/** Common match count — enough for walk-forward to produce a verdict. */
const MATCHES = 600;
const TEAMS = 16;

function season(overrides: Partial<SyntheticOptions>): Season[] {
  return [makeSyntheticSeason({ teams: TEAMS, matches: MATCHES, ...overrides })];
}

export const SCENARIOS: ScenarioConfig[] = [
  {
    id: 'FORM_PRESENT',
    description: 'Previous-5 form genuinely feeds back into the outcome probability.',
    targetTest: 'independence',
    expectedConclusion: 'COMPATIBLE',
    build: () => season({ seed: 101, formStrength: 0.8 }),
  },
  {
    id: 'FORM_ABSENT',
    description: 'No form feedback — fixed team strength only.',
    targetTest: 'independence',
    expectedConclusion: 'INCOMPATIBLE',
    build: () => season({ seed: 102, formStrength: 0 }),
  },
  {
    id: 'DRIFT_PRESENT',
    description: 'Team strengths drift across seasons (non-stationary generator).',
    targetTest: 'stationarity',
    expectedConclusion: 'COMPATIBLE',
    build: () => makeSyntheticSeasons(4, { seed: 103, matches: MATCHES, teams: TEAMS, drift: 0.15 }),
  },
  {
    id: 'DRIFT_ABSENT',
    description: 'No drift — strengths are stable across seasons.',
    targetTest: 'stationarity',
    expectedConclusion: 'INCOMPATIBLE',
    build: () => makeSyntheticSeasons(4, { seed: 104, matches: MATCHES, teams: TEAMS, drift: 0 }),
  },
  {
    id: 'HOME_NONE',
    description: 'No home advantage at all (intercept = 0).',
    targetTest: 'homeAdvantage',
    expectedConclusion: 'INCOMPATIBLE',
    build: () => season({ seed: 105, homeAdvantage: 0 }),
  },
  {
    id: 'HOME_GLOBAL',
    description: 'Uniform home advantage for all teams.',
    targetTest: 'homeAdvantage',
    expectedConclusion: 'COMPATIBLE',
    build: () => season({ seed: 106, homeAdvantage: 0.35 }),
  },
  {
    id: 'HOME_TEAM_SPECIFIC',
    description: 'Team-specific home advantage (some teams stronger at home).',
    targetTest: 'homeAdvantage',
    expectedConclusion: 'COMPATIBLE',
    build: () => season({ seed: 107, homeAdvantage: 0.4, strengthSpread: 1.1 }),
  },
  {
    id: 'H2H_NONE',
    description: 'No pair-specific H2H effect.',
    targetTest: 'h2h',
    expectedConclusion: 'INCOMPATIBLE',
    build: () => season({ seed: 108, h2hStrength: 0 }),
  },
  {
    id: 'H2H_PRESENT',
    description: 'Prior meetings of a pair carry information beyond rating.',
    targetTest: 'h2h',
    expectedConclusion: 'COMPATIBLE',
    build: () => season({ seed: 109, h2hStrength: 1.2 }),
  },
  {
    id: 'POISSON',
    description: 'Independent Poisson goal generation.',
    targetTest: 'goalDistribution',
    expectedConclusion: 'COMPATIBLE',
    build: () => season({ seed: 110, goalMode: 'poisson', strengthSpread: 0.1 }),
  },
  {
    id: 'UNDERDISPERSED',
    description: 'Goals are under-dispersed (variance < mean).',
    targetTest: 'goalDistribution',
    expectedConclusion: 'INCOMPATIBLE',
    build: () => season({ seed: 111, goalMode: 'underdisp' }),
  },
  {
    id: 'DEPENDENT_GOALS',
    description: 'Home and away goals are correlated (dependence correction needed).',
    targetTest: 'goalDistribution',
    expectedConclusion: 'INCOMPATIBLE',
    build: () => season({ seed: 112, goalMode: 'overdisp' }),
  },
];

export interface ScenarioResult {
  id: SyntheticScenarioId;
  description: string;
  targetTest: ScenarioConfig['targetTest'];
  expectedConclusion: ScenarioConfig['expectedConclusion'];
  actualConclusion: string | null;
  passed: boolean;
  /** Null when the suite returned null for this test (insufficient sample). */
  report: GeneratorReport | null;
}

function runScenario(config: ScenarioConfig): ScenarioResult {
  const seasons = config.build();
  const league: League = seasons[0]?.league ?? 'angol';

  const opts = {
    ...DEFAULT_SUITE_OPTIONS,
    walkForward: {
      ...DEFAULT_SUITE_OPTIONS.walkForward,
      minTrain: 100,
      refitInterval: 100,
      trainWindow: 400,
      bootstrapIterations: 200,
    },
  };

  const report = runGeneratorSuite(seasons, league, opts);

  const testSlot = report[config.targetTest];
  const actualConclusion = testSlot?.result.conclusion ?? null;
  const passed = actualConclusion === config.expectedConclusion;

  return {
    id: config.id,
    description: config.description,
    targetTest: config.targetTest,
    expectedConclusion: config.expectedConclusion,
    actualConclusion,
    passed,
    report,
  };
}

export interface ValidationGateResult {
  scenarios: ScenarioResult[];
  passed: number;
  failed: number;
  total: number;
  allPassed: boolean;
}

/** Run all 12 synthetic scenarios and return the aggregate gate result. */
export function runSyntheticValidationGate(): ValidationGateResult {
  const scenarios = SCENARIOS.map(runScenario);
  const passed = scenarios.filter((s) => s.passed).length;
  return {
    scenarios,
    passed,
    failed: scenarios.length - passed,
    total: scenarios.length,
    allPassed: passed === scenarios.length,
  };
}
