import { describe, expect, it } from 'vitest';
import {
  DEFAULT_HOME_ADVANTAGE_OPTIONS,
  runHomeAdvantageTest,
} from '../homeAdvantage';
import { makeSyntheticSeason } from './synthetic';

const OPTIONS = {
  ...DEFAULT_HOME_ADVANTAGE_OPTIONS,
  minTrain: 100,
  refitInterval: 100,
  trainWindow: 400,
  bootstrapIterations: 200,
  meaningfulLogLoss: 0.0005,
};

const withHome = makeSyntheticSeason({
  seed: 301,
  matches: 700,
  homeAdvantage: 0.65,
});
const noHome = makeSyntheticSeason({
  seed: 301,
  matches: 700,
  homeAdvantage: 0,
});

describe('Home Advantage — synthetic validation gate', () => {
  it('detects a home effect when the generator contains one', () => {
    const report = runHomeAdvantageTest([withHome], 'angol', OPTIONS);
    if (!report) throw new Error('report should not be null');
    expect(report.result.leakageSafe).toBe(true);
    expect(report.result.conclusion).toBe('COMPATIBLE');
    expect(report.comparison.deltaLogLoss.estimate).toBeLessThan(0);
    expect(report.comparison.deltaLogLoss.ci95High).toBeLessThan(0);
  });

  it('finds no home effect when the generator has none', () => {
    const report = runHomeAdvantageTest([noHome], 'angol', OPTIONS);
    if (!report) throw new Error('report should not be null');
    expect(report.result.leakageSafe).toBe(true);
    expect(report.result.conclusion).not.toBe('COMPATIBLE');
  });

  it('separates the two generators by OOS delta', () => {
    const a = runHomeAdvantageTest([noHome], 'angol', OPTIONS)!;
    const b = runHomeAdvantageTest([withHome], 'angol', OPTIONS)!;
    expect(b.comparison.deltaLogLoss.estimate).toBeLessThan(
      a.comparison.deltaLogLoss.estimate,
    );
  });

  it('is deterministic: identical input and seed give identical output', () => {
    const first = runHomeAdvantageTest([withHome], 'angol', OPTIONS);
    const second = runHomeAdvantageTest([withHome], 'angol', OPTIONS);
    expect(JSON.stringify(first)).toBe(JSON.stringify(second));
  });

  it('returns null when the sample is too small', () => {
    const tiny = makeSyntheticSeason({ seed: 7, matches: 60 });
    const report = runHomeAdvantageTest([tiny], 'angol', OPTIONS);
    expect(report).toBeNull();
  });

  it('reports descriptive home/draw/away rates that sum to ~1', () => {
    const report = runHomeAdvantageTest([withHome], 'angol', OPTIONS)!;
    const sum = report.homeWinRate + report.drawRate + report.awayWinRate;
    expect(sum).toBeCloseTo(1, 6);
    // A home-advantage generator should produce more home wins than away.
    expect(report.homeWinRate).toBeGreaterThan(report.awayWinRate);
  });

  it('reports a positive mean goal difference for a home-advantage generator', () => {
    const report = runHomeAdvantageTest([withHome], 'angol', OPTIONS)!;
    expect(report.meanGoalDiff.estimate).toBeGreaterThan(0);
  });

  it('implication has automaticConfigurationChange = false', () => {
    const report = runHomeAdvantageTest([withHome], 'angol', OPTIONS)!;
    expect(report.implication.automaticConfigurationChange).toBe(false);
  });
});
