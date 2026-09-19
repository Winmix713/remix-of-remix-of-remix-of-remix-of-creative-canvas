import { describe, expect, it } from 'vitest';
import {
  DEFAULT_H2H_OPTIONS,
  runH2HTest,
} from '../h2h';
import { makeSyntheticSeason } from './synthetic';

const OPTIONS = {
  ...DEFAULT_H2H_OPTIONS,
  minTrain: 100,
  refitInterval: 100,
  trainWindow: 400,
  bootstrapIterations: 200,
  minPriorMeetings: 2,
};

const noH2H = makeSyntheticSeason({
  seed: 401,
  matches: 700,
  h2hStrength: 0,
});
const withH2H = makeSyntheticSeason({
  seed: 401,
  matches: 700,
  h2hStrength: 1.2,
});

describe('Head-to-Head — synthetic validation gate', () => {
  it('finds no H2H signal when the generator has no pair effect', () => {
    const report = runH2HTest([noH2H], 'angol', OPTIONS);
    if (!report) throw new Error('report should not be null');
    expect(report.result.leakageSafe).toBe(true);
    expect(report.result.conclusion).not.toBe('COMPATIBLE');
  });

  it('detects the H2H signal when pair history is informative', () => {
    const report = runH2HTest([withH2H], 'angol', OPTIONS);
    if (!report) throw new Error('report should not be null');
    expect(report.result.leakageSafe).toBe(true);
    expect(report.comparison.deltaLogLoss.estimate).toBeLessThan(0);
  });

  it('separates the two generators by OOS delta', () => {
    const a = runH2HTest([noH2H], 'angol', OPTIONS)!;
    const b = runH2HTest([withH2H], 'angol', OPTIONS)!;
    expect(b.comparison.deltaLogLoss.estimate).toBeLessThan(
      a.comparison.deltaLogLoss.estimate,
    );
  });

  it('is deterministic: identical input and seed give identical output', () => {
    const first = runH2HTest([withH2H], 'angol', OPTIONS);
    const second = runH2HTest([withH2H], 'angol', OPTIONS);
    expect(JSON.stringify(first)).toBe(JSON.stringify(second));
  });

  it('returns null when the sample is too small', () => {
    const tiny = makeSyntheticSeason({ seed: 7, matches: 60 });
    const report = runH2HTest([tiny], 'angol', OPTIONS);
    expect(report).toBeNull();
  });

  it('reports pairs with history and mean prior meetings', () => {
    const report = runH2HTest([withH2H], 'angol', OPTIONS)!;
    expect(report.pairsWithHistory).toBeGreaterThan(0);
    expect(report.meanPriorMeetings).toBeGreaterThanOrEqual(
      OPTIONS.minPriorMeetings,
    );
  });

  it('implication has automaticConfigurationChange = false', () => {
    const report = runH2HTest([withH2H], 'angol', OPTIONS)!;
    expect(report.implication.automaticConfigurationChange).toBe(false);
  });
});
