/**
 * generator.worker — the Generator Structure Suite, off the main thread.
 *
 * The suite's walk-forward refits and bootstrap intervals are expensive on
 * 24 720 matches. This worker mirrors the pipeline.worker pattern: same
 * deterministic math as the in-process fallback, progress streamed back.
 */

import { runGeneratorSuite } from '../utils/generator/report';
import type { GeneratorSuiteOptions } from '../utils/generator/report';
import type { GeneratorReport } from '../utils/generator/types';
import type { League, Season } from '../types/winmix';

export interface GeneratorWorkerRequest {
  id: number;
  seasons: Season[];
  league: League;
  options?: GeneratorSuiteOptions;
}

export type GeneratorWorkerResponse =
  | { id: number; type: 'progress'; done: number; total: number }
  | { id: number; type: 'done'; result: GeneratorReport }
  | { id: number; type: 'error'; message: string };

const ctx = self as unknown as {
  postMessage: (message: GeneratorWorkerResponse) => void;
  onmessage: ((event: MessageEvent<GeneratorWorkerRequest>) => void) | null;
};

ctx.onmessage = (event: MessageEvent<GeneratorWorkerRequest>) => {
  const { id, seasons, league, options } = event.data;
  try {
    const total = 6; // baseline + 5 tests
    let done = 0;
    const report = runGeneratorSuite(seasons, league, options);
    done = total;
    ctx.postMessage({ id, type: 'progress', done, total });
    ctx.postMessage({ id, type: 'done', result: report });
  } catch (error) {
    ctx.postMessage({
      id,
      type: 'error',
      message: error instanceof Error ? error.message : String(error),
    });
  }
};
