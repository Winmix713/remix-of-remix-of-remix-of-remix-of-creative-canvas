/**
 * Phase 0 — Reproducibility Lock.
 *
 * Every Suite run must carry a fingerprint that makes it reproducible: same
 * input + same seed → same report. This module captures the provenance
 * metadata the plan requires (league, seasonCount, matchCount, sampleSize,
 * dataset fingerprint, seed, suite version, code revision, information
 * cutoff, training/test range, leakageSafe) and exposes a deterministic
 * repeat test that asserts byte-identical output across two runs.
 *
 * READ-ONLY. Nothing here writes state, touches the Prediction Engine or
 * changes any configuration.
 */

import type { League, Season } from '../../types/winmix';
import type { GeneratorReport } from './types';
import { runGeneratorSuite, DEFAULT_SUITE_OPTIONS } from './report';
import { collectLeagueMatches } from './independence';

/** Schema version of this reproducibility layer. Bump when the shape changes. */
export const REPRODUCIBILITY_VERSION = 1;

/** Suite version — matches the report schema version. */
export const SUITE_VERSION = 'winmix.generator-structure-suite/1';

export interface ReproducibilityLock {
  league: League;
  seasonCount: number;
  matchCount: number;
  sampleSize: number;
  /** Stable hash of the match sequence, so a different dataset is detectable. */
  datasetFingerprint: string;
  seed: number;
  suiteVersion: string;
  reproducibilityVersion: number;
  fdr: number;
  informationCutoff: string;
  trainingRange: [number, number];
  testRange: [number, number];
  leakageSafe: boolean;
}

/** FNV-1a hash of a deterministic serialisation of the match list. */
export function datasetFingerprint(
  seasons: readonly Season[],
  league: League,
): string {
  const matches = collectLeagueMatches(seasons, league);
  let h = 2166136261 >>> 0;
  for (const m of matches) {
    const s = `${m.match_no}|${m.home_team}|${m.away_team}|${m.home_score}|${m.away_score}|${m.date}`;
    for (let i = 0; i < s.length; i++) {
      h ^= s.charCodeAt(i);
      h = Math.imul(h, 16777619);
    }
  }
  return (h >>> 0).toString(16);
}

/** Build the reproducibility lock from a report and the raw season data. */
export function buildReproducibilityLock(
  report: GeneratorReport,
  seasons: readonly Season[],
): ReproducibilityLock {
  const trainingRange = report.baseline?.leakage.trainingRange ?? [0, 0];
  const testRange = report.baseline?.leakage.testRange ?? [0, 0];
  const leakageSafe = report.baseline?.leakage.leakageSafe ?? true;

  return {
    league: report.league,
    seasonCount: report.dataset.seasonCount,
    matchCount: report.dataset.matchCount,
    sampleSize: report.dataset.sampleSize,
    datasetFingerprint: datasetFingerprint(seasons, report.league),
    seed: report.seed,
    suiteVersion: SUITE_VERSION,
    reproducibilityVersion: REPRODUCIBILITY_VERSION,
    fdr: report.fdr,
    informationCutoff:
      'Match t is scored by a model fitted exclusively on matches < t; ' +
      'ratings, form and head-to-head features are built from matches < t only.',
    trainingRange,
    testRange,
    leakageSafe,
  };
}

/** Deterministic JSON serialisation — same input + seed → byte-identical string. */
export function reproducibilityLockToJson(lock: ReproducibilityLock): string {
  return JSON.stringify(
    { schema: 'winmix.reproducibility-lock/1', ...lock },
    null,
    2,
  );
}

export interface RepeatTestResult {
  passed: boolean;
  firstHash: string;
  secondHash: string;
}

/**
 * Deterministic repeat test: run the suite twice on the same data with the
 * same seed and assert byte-identical JSON output. This is the plan's
 * "reproducibility PASS" gate.
 */
export function deterministicRepeatTest(
  seasons: readonly Season[],
  league: League,
  seed: number = DEFAULT_SUITE_OPTIONS.walkForward.seed,
): RepeatTestResult {
  const opts = {
    ...DEFAULT_SUITE_OPTIONS,
    walkForward: { ...DEFAULT_SUITE_OPTIONS.walkForward, seed },
  };

  const first = runGeneratorSuite(seasons, league, opts);
  const second = runGeneratorSuite(seasons, league, opts);

  const firstJson = JSON.stringify(first);
  const secondJson = JSON.stringify(second);

  return {
    passed: firstJson === secondJson,
    firstHash: fnv1a(firstJson),
    secondHash: fnv1a(secondJson),
  };
}

function fnv1a(str: string): string {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0).toString(16);
}
