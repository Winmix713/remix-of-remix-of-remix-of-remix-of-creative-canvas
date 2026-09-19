/**
 * implication — the ONE place where a statistical conclusion becomes a
 * MODEL IMPLICATIONS row.
 *
 * The suite reports; it never reconfigures. `automaticConfigurationChange` is
 * therefore a literal `false` on every row, and an INCONCLUSIVE verdict can
 * never produce KEEP or REMOVE.
 */

import type { Conclusion, ImplicationState, ModelImplication, TestResult } from './types';

/**
 * Maps a verdict to a suggested state.
 *
 * @param conclusion - Verdict of the test.
 * @param compatibleMeansKeep - When true (the default) a COMPATIBLE verdict
 *   suggests KEEP: the component carries information. Set it to false when the
 *   hypothesis is "the structure is ABSENT" — there COMPATIBLE means the
 *   component is not needed.
 */
export function suggestedStateFor(
  conclusion: Conclusion,
  compatibleMeansKeep = true,
): ImplicationState {
  if (conclusion === 'INCONCLUSIVE') return 'INCONCLUSIVE';
  const keep = conclusion === 'COMPATIBLE';
  return (compatibleMeansKeep ? keep : !keep) ? 'KEEP' : 'REMOVE';
}

/**
 * Builds a MODEL IMPLICATIONS row from a finished test result.
 *
 * Effect size, CI and both OOS deltas travel with the row, so a reader never
 * sees a KEEP / REMOVE suggestion without the numbers behind it.
 */
export function buildImplication(
  component: string,
  currentSetting: string,
  result: TestResult,
  compatibleMeansKeep = true,
): ModelImplication {
  return {
    component,
    currentSetting,
    suiteResult: result.conclusion,
    effect: result.effect,
    oosDeltaBrier: result.oosDeltaBrier,
    oosDeltaLogLoss: result.oosDeltaLogLoss,
    suggestedState: suggestedStateFor(result.conclusion, compatibleMeansKeep),
    automaticConfigurationChange: false,
  };
}
