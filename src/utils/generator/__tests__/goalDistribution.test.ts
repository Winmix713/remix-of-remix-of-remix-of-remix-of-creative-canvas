import { describe, expect, it } from 'vitest';
import {
  DEFAULT_GOAL_DISTRIBUTION_OPTIONS,
  bootstrapDispersion,
  buildGoalBins,
  goodnessOfFit,
  bttsIndependence,
  runGoalDistributionTest,
} from '../goalDistribution';
import { makeSyntheticSeason } from './synthetic';

const OPTIONS = {
  ...DEFAULT_GOAL_DISTRIBUTION_OPTIONS,
  bootstrapIterations: 500,
};

const poisson = makeSyntheticSeason({
  seed: 501,
  matches: 1200,
  goalMode: 'poisson',
});
const overdisp = makeSyntheticSeason({
  seed: 501,
  matches: 1200,
  goalMode: 'overdisp',
});

describe('Goal Distribution — synthetic validation gate', () => {
  it('finds Poisson-compatible goals in a Poisson generator', () => {
    const report = runGoalDistributionTest([poisson], 'angol', OPTIONS);
    if (!report) throw new Error('report should not be null');
    expect(report.result.leakageSafe).toBe(true);
    expect(report.result.conclusion).not.toBe('INCOMPATIBLE');
  });

  it('detects over-dispersion in a non-Poisson generator', () => {
    const report = runGoalDistributionTest([overdisp], 'angol', OPTIONS);
    if (!report) throw new Error('report should not be null');
    expect(report.result.leakageSafe).toBe(true);
    expect(report.dispersion.estimate).toBeGreaterThan(1);
  });

  it('separates the two generators by dispersion', () => {
    const a = runGoalDistributionTest([poisson], 'angol', OPTIONS)!;
    const b = runGoalDistributionTest([overdisp], 'angol', OPTIONS)!;
    expect(b.dispersion.estimate).toBeGreaterThan(a.dispersion.estimate);
  });

  it('is deterministic: identical input and seed give identical output', () => {
    const first = runGoalDistributionTest([poisson], 'angol', OPTIONS);
    const second = runGoalDistributionTest([poisson], 'angol', OPTIONS);
    expect(JSON.stringify(first)).toBe(JSON.stringify(second));
  });

  it('returns null when the sample is too small', () => {
    const tiny = makeSyntheticSeason({ seed: 7, matches: 50 });
    const report = runGoalDistributionTest([tiny], 'angol', OPTIONS);
    expect(report).toBeNull();
  });

  it('produces goal bins that sum to the total match count', () => {
    const goals = poisson.matches.map((m) => m.home_score + m.away_score);
    const bins = buildGoalBins(goals, OPTIONS.maxGoals);
    const observedSum = bins.reduce((acc, b) => acc + b.observed, 0);
    expect(observedSum).toBe(goals.length);
  });

  it('goodness-of-fit returns valid structure', () => {
    const goals = poisson.matches.map((m) => m.home_score + m.away_score);
    const bins = buildGoalBins(goals, OPTIONS.maxGoals);
    const gof = goodnessOfFit(bins, OPTIONS.minExpected);
    expect(gof.df).toBeGreaterThanOrEqual(0);
    expect(gof.p).toBeGreaterThanOrEqual(0);
    expect(gof.p).toBeLessThanOrEqual(1);
  });

  it('BTTS independence returns valid p-value', () => {
    const btts = bttsIndependence(poisson.matches);
    expect(btts.df).toBe(1);
    expect(btts.p).toBeGreaterThan(0);
    expect(btts.p).toBeLessThanOrEqual(1);
  });

  it('implication has automaticConfigurationChange = false', () => {
    const report = runGoalDistributionTest([poisson], 'angol', OPTIONS)!;
    expect(report.implication.automaticConfigurationChange).toBe(false);
  });
});
