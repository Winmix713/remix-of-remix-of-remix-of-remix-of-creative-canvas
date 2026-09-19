/**
 * multipleTesting — Benjamini–Hochberg false-discovery-rate control.
 *
 * The suite runs five hypotheses on the same data. Reading five raw p-values
 * at alpha = .05 would manufacture a "finding" roughly one run in four, so no
 * p-value leaves the suite unadjusted. BH controls the expected share of false
 * discoveries among the rejected tests, which is the right currency here: the
 * report suggests where to look, it never flips a switch.
 *
 * Deterministic, order-independent, no randomness.
 */

export const DEFAULT_FDR = 0.1;

export interface AdjustedPValue<T extends string = string> {
  test: T;
  rawPValue: number;
  /** BH step-up adjusted p (monotone, clipped to 1). */
  adjustedPValue: number;
  rejected: boolean;
}

/**
 * Benjamini–Hochberg step-up procedure.
 * Input order is preserved in the output; ties are handled by rank order.
 */
export function benjaminiHochberg<T extends string>(
entries: readonly {test: T;rawPValue: number;}[],
fdr: number = DEFAULT_FDR)
: AdjustedPValue<T>[] {
  const m = entries.length;
  if (m === 0) return [];

  const ordered = entries.
  map((e, index) => ({ ...e, index })).
  sort((a, b) => a.rawPValue - b.rawPValue);

  // Step-up: walk from the largest p down, keeping the running minimum.
  const adjusted = new Array<number>(m);
  let runningMin = 1;
  for (let i = m - 1; i >= 0; i--) {
    const value = Math.min(1, ordered[i].rawPValue * m / (i + 1));
    runningMin = Math.min(runningMin, value);
    adjusted[i] = runningMin;
  }

  const out = new Array<AdjustedPValue<T>>(m);
  ordered.forEach((entry, i) => {
    out[entry.index] = {
      test: entry.test,
      rawPValue: entry.rawPValue,
      adjustedPValue: adjusted[i],
      rejected: adjusted[i] <= fdr
    };
  });
  return out;
}
