import { describe, expect, it } from 'vitest';
import {
  SCENARIOS,
  runSyntheticValidationGate,
  type ScenarioResult,
} from '../syntheticGate';
import {
  deterministicRepeatTest,
  datasetFingerprint,
  buildReproducibilityLock,
  reproducibilityLockToJson,
} from '../reproducibility';
import { runGeneratorSuite, DEFAULT_SUITE_OPTIONS } from '../report';
import { makeSyntheticSeason } from './synthetic';

const FAST_OPTS = {
  ...DEFAULT_SUITE_OPTIONS,
  walkForward: {
    ...DEFAULT_SUITE_OPTIONS.walkForward,
    minTrain: 80,
    refitInterval: 80,
    trainWindow: 300,
    bootstrapIterations: 100,
  },
};

describe('Synthetic Validation Gate — Phase 1', () => {
  it('defines all 12 mandatory scenarios', () => {
    expect(SCENARIOS).toHaveLength(12);
    const ids = SCENARIOS.map((s) => s.id);
    expect(ids).toContain('FORM_PRESENT');
    expect(ids).toContain('FORM_ABSENT');
    expect(ids).toContain('DRIFT_PRESENT');
    expect(ids).toContain('DRIFT_ABSENT');
    expect(ids).toContain('HOME_NONE');
    expect(ids).toContain('HOME_GLOBAL');
    expect(ids).toContain('HOME_TEAM_SPECIFIC');
    expect(ids).toContain('H2H_NONE');
    expect(ids).toContain('H2H_PRESENT');
    expect(ids).toContain('POISSON');
    expect(ids).toContain('UNDERDISPERSED');
    expect(ids).toContain('DEPENDENT_GOALS');
  });

  it('each scenario builds a non-empty season array', () => {
    for (const s of SCENARIOS) {
      const seasons = s.build();
      expect(seasons.length).toBeGreaterThan(0);
      expect(seasons[0].matches.length).toBeGreaterThan(0);
    }
  });

  it('each scenario targets a valid test slot', () => {
    const validTests = [
      'independence',
      'stationarity',
      'homeAdvantage',
      'h2h',
      'goalDistribution',
    ];
    for (const s of SCENARIOS) {
      expect(validTests).toContain(s.targetTest);
    }
  });

  it('H2H_PRESENT detects the pair signal (COMPATIBLE or at least negative delta)', () => {
    const seasons = SCENARIOS.find((s) => s.id === 'H2H_PRESENT')!.build();
    const report = runGeneratorSuite(seasons, 'angol', FAST_OPTS);
    if (report.h2h) {
      expect(report.h2h.comparison.deltaLogLoss.estimate).toBeLessThan(0);
    }
  });

  it('H2H_NONE does not produce a COMPATIBLE verdict', () => {
    const seasons = SCENARIOS.find((s) => s.id === 'H2H_NONE')!.build();
    const report = runGeneratorSuite(seasons, 'angol', FAST_OPTS);
    if (report.h2h) {
      expect(report.h2h.result.conclusion).not.toBe('COMPATIBLE');
    }
  });

  it('HOME_NONE does not produce a COMPATIBLE verdict', () => {
    const seasons = SCENARIOS.find((s) => s.id === 'HOME_NONE')!.build();
    const report = runGeneratorSuite(seasons, 'angol', FAST_OPTS);
    if (report.homeAdvantage) {
      expect(report.homeAdvantage.result.conclusion).not.toBe('COMPATIBLE');
    }
  });

  it('POISSON produces a COMPATIBLE goal-distribution verdict', () => {
    const seasons = SCENARIOS.find((s) => s.id === 'POISSON')!.build();
    const report = runGeneratorSuite(seasons, 'angol', FAST_OPTS);
    if (report.goalDistribution) {
      expect(report.goalDistribution.result.conclusion).toBe('COMPATIBLE');
    }
  });

  it('UNDERDISPERSED produces an INCOMPATIBLE goal-distribution verdict', () => {
    const seasons = SCENARIOS.find((s) => s.id === 'UNDERDISPERSED')!.build();
    const report = runGeneratorSuite(seasons, 'angol', FAST_OPTS);
    if (report.goalDistribution) {
      expect(report.goalDistribution.result.conclusion).toBe('INCOMPATIBLE');
    }
  });

  it('the full gate runs without throwing', () => {
    const result = runSyntheticValidationGate();
    expect(result.total).toBe(12);
    expect(result.passed + result.failed).toBe(12);
  });
});

describe('Reproducibility Lock — Phase 0', () => {
  const seasons = [makeSyntheticSeason({ seed: 42, matches: 600 })];

  it('produces a stable dataset fingerprint', () => {
    const a = datasetFingerprint(seasons, 'angol');
    const b = datasetFingerprint(seasons, 'angol');
    expect(a).toBe(b);
    expect(a).toMatch(/^[0-9a-f]+$/);
  });

  it('different data produces a different fingerprint', () => {
    const other = [makeSyntheticSeason({ seed: 99, matches: 600 })];
    expect(datasetFingerprint(seasons, 'angol')).not.toBe(
      datasetFingerprint(other, 'angol'),
    );
  });

  it('builds a complete lock from a report', () => {
    const report = runGeneratorSuite(seasons, 'angol', FAST_OPTS);
    const lock = buildReproducibilityLock(report, seasons);
    expect(lock.league).toBe('angol');
    expect(lock.seed).toBe(FAST_OPTS.walkForward.seed);
    expect(lock.suiteVersion).toContain('generator-structure-suite');
    expect(lock.reproducibilityVersion).toBeGreaterThan(0);
    expect(lock.datasetFingerprint).toMatch(/^[0-9a-f]+$/);
    expect(lock.matchCount).toBeGreaterThan(0);
  });

  it('serialises to deterministic JSON', () => {
    const report = runGeneratorSuite(seasons, 'angol', FAST_OPTS);
    const lock = buildReproducibilityLock(report, seasons);
    const a = reproducibilityLockToJson(lock);
    const b = reproducibilityLockToJson(lock);
    expect(a).toBe(b);
  });

  it('deterministic repeat test passes (byte-identical output)', () => {
    const result = deterministicRepeatTest(seasons, 'angol', 42);
    expect(result.passed).toBe(true);
    expect(result.firstHash).toBe(result.secondHash);
  });
});
