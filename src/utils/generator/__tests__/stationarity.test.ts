import { describe, expect, it } from 'vitest';
import {
  DEFAULT_STATIONARITY_OPTIONS,
  computeSeasonSlices,
  outcomeHomogeneity,
  runStationarityTest,
} from '../stationarity';
import { makeSyntheticSeasons } from './synthetic';

const OPTIONS = {
  ...DEFAULT_STATIONARITY_OPTIONS,
  minTrain: 100,
  refitInterval: 100,
  trainWindow: 400,
  bootstrapIterations: 200,
  // The frozen model is fit on only the warm-up window and naturally degrades
  // as more data arrives, so even a stationary generator shows a refit gain of
  // ~0.03. A real drift signal produces ~0.07. The threshold sits between them.
  meaningfulLogLoss: 0.05,
};

const stationary = makeSyntheticSeasons(3, {
  seed: 201,
  matches: 500,
  drift: 0,
});
const drifting = makeSyntheticSeasons(3, {
  seed: 201,
  matches: 500,
  drift: 0.6,
});

describe('Stationarity — synthetic validation gate', () => {
  it('does not flag drift in a stationary generator', () => {
    const report = runStationarityTest(stationary, 'angol', OPTIONS);
    if (!report) throw new Error('report should not be null');
    expect(report.result.leakageSafe).toBe(true);
    // With the threshold set above the natural refit gain, a stationary
    // generator should be COMPATIBLE or INCONCLUSIVE — never INCOMPATIBLE.
    expect(report.result.conclusion).not.toBe('INCOMPATIBLE');
  });

  it('detects drift in a non-stationary generator', () => {
    const report = runStationarityTest(drifting, 'angol', OPTIONS);
    if (!report) throw new Error('report should not be null');
    expect(report.result.leakageSafe).toBe(true);
    expect(report.result.conclusion).toBe('INCOMPATIBLE');
    expect(report.comparison.deltaLogLoss.estimate).toBeLessThan(0);
  });

  it('separates the two generators by OOS delta', () => {
    const a = runStationarityTest(stationary, 'angol', OPTIONS)!;
    const b = runStationarityTest(drifting, 'angol', OPTIONS)!;
    expect(b.comparison.deltaLogLoss.estimate).toBeLessThan(
      a.comparison.deltaLogLoss.estimate,
    );
  });

  it('is deterministic: identical input and seed give identical output', () => {
    const first = runStationarityTest(drifting, 'angol', OPTIONS);
    const second = runStationarityTest(drifting, 'angol', OPTIONS);
    expect(JSON.stringify(first)).toBe(JSON.stringify(second));
  });

  it('returns null when the sample is too small', () => {
    const tiny = makeSyntheticSeasons(1, { seed: 7, matches: 60 });
    const report = runStationarityTest(tiny, 'angol', OPTIONS);
    expect(report).toBeNull();
  });

  it('produces season slices in order with valid rates', () => {
    const slices = computeSeasonSlices(stationary, 'angol');
    expect(slices).toHaveLength(3);
    for (const s of slices) {
      expect(s.matches).toBeGreaterThan(0);
      expect(s.homeWinRate).toBeGreaterThanOrEqual(0);
      expect(s.homeWinRate).toBeLessThanOrEqual(1);
      expect(s.drawRate).toBeGreaterThanOrEqual(0);
      expect(s.drawRate).toBeLessThanOrEqual(1);
      expect(s.goalsPerMatch).toBeGreaterThan(0);
    }
  });

  it('computes outcome homogeneity with valid p-value', () => {
    const h = outcomeHomogeneity(stationary, 'angol');
    expect(h.df).toBeGreaterThan(0);
    expect(h.p).toBeGreaterThan(0);
    expect(h.p).toBeLessThanOrEqual(1);
  });

  it('implication has automaticConfigurationChange = false', () => {
    const report = runStationarityTest(drifting, 'angol', OPTIONS)!;
    expect(report.implication.automaticConfigurationChange).toBe(false);
  });
});
