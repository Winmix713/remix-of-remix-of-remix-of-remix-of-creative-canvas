/**
 * pipelineRunner — one entry point, two execution strategies.
 *
 * P3 INFRASTRUCTURE
 * -----------------
 * Callers ask for a league pipeline and do not care where it ran. This module
 * prefers the Web Worker (so the UI never drops a frame) and falls back to the
 * in-process walk whenever a Worker cannot be constructed or a run fails.
 *
 * Only the TARGET LEAGUE's seasons cross the thread boundary. On a FULL
 * rebuild their derived per-match forecasts are stripped first — those are
 * recomputed anyway, and shipping them would double the structured-clone cost
 * for nothing. On a RESUME attempt they must be kept: see below.
 */

import { computeLeaguePipeline, type PipelineParams, type PipelineResult } from './pipeline';
import type { Season } from '../types/winmix';
import type { WorkerRequest, WorkerResponse } from '../workers/pipeline.worker';

export type PipelineRunMode = 'worker' | 'inline';

const MAX_WORKERS =
  typeof navigator !== 'undefined'
    ? Math.max(1, Math.min(4, navigator.hardwareConcurrency ?? 2))
    : 2;

const workerPool: Worker[] = [];
let poolIdx = 0;
let requestId = 0;

/**
 * Sticky fallback: once a worker cannot be constructed or a worker execution
 * fails, the current page stops attempting worker execution. This avoids
 * repeatedly paying the structured-clone/worker startup cost after a runtime
 * incompatibility has already been detected.
 */
let workerDisabled = false;

function removeWorker(instance: Worker): void {
  const index = workerPool.indexOf(instance);
  if (index >= 0) workerPool.splice(index, 1);
  try {
    instance.terminate();
  } catch {
    // Best effort only.
  }
}

function getWorker(): Worker | null {
  if (workerDisabled) return null;

  if (workerPool.length < MAX_WORKERS) {
    try {
      const worker = new Worker(
        new URL('../workers/pipeline.worker.ts', import.meta.url),
        { type: 'module' }
      );
      workerPool.push(worker);
      return worker;
    } catch {
      workerDisabled = true;
      return null;
    }
  }

  if (workerPool.length === 0) return null;

  const worker = workerPool[poolIdx % workerPool.length];
  poolIdx = (poolIdx + 1) % Math.max(1, workerPool.length);
  return worker;
}

/** Strips derived forecasts before the structured clone. */
function lighten(seasons: readonly Season[]): Season[] {
  return seasons.map((s) => ({
    ...s,
    matches: s.matches.map(({ pipeline: _pipeline, ...rest }) => rest)
  }));
}

function mergeSeasons(all: readonly Season[], computed: readonly Season[]): Season[] {
  const byId = new Map(computed.map((s) => [s.id, s]));
  return all.map((s) => byId.get(s.id) ?? s);
}

function runInWorker(
instance: Worker,
params: Omit<PipelineParams, 'onProgress'>,
onProgress?: PipelineParams['onProgress'])
: Promise<PipelineResult> {
  return new Promise((resolve, reject) => {
    const id = ++requestId;
    const handleMessage = (event: MessageEvent<WorkerResponse>) => {
      const data = event.data;
      if (!data || data.id !== id) return;
      if (data.type === 'progress') {
        onProgress?.(data.done, data.total);
        return;
      }
      cleanup();
      if (data.type === 'done') resolve(data.result);else
      reject(new Error(data.message));
    };
    const handleError = (event: ErrorEvent) => {
      cleanup();
      reject(
        new Error(
          event.message || 'A pipeline worker váratlanul leállt.'
        )
      );
    };
    const cleanup = () => {
      instance.removeEventListener('message', handleMessage as EventListener);
      instance.removeEventListener('error', handleError as EventListener);
    };
    instance.addEventListener('message', handleMessage as EventListener);
    instance.addEventListener('error', handleError as EventListener);
    const request: WorkerRequest = { id, params };

    try {
      instance.postMessage(request);
    } catch (error) {
      cleanup();
      reject(
        error instanceof Error
          ? error
          : new Error('A pipeline workernek küldött kérés sikertelen.')
      );
    }
  });
}

export interface RunOutcome extends PipelineResult {
  /** Where the walk actually ran, so the UI can be honest about it. */
  mode: PipelineRunMode;
}

/**
 * Runs one league's pipeline, off-thread when possible.
 *
 * `checkpoint` and `forceFullRebuild` are forwarded verbatim to whichever
 * execution strategy wins — the worker and the in-process walk run the same
 * function, so a resume produces the same numbers either way.
 *
 * Switching `historyScope` or an experiment flag always means a full
 * recomputation — there is no partial-invalidation path, by design.
 */
export async function runLeaguePipeline(params: PipelineParams): Promise<RunOutcome> {
  const { onProgress, ...rest } = params;
  const leagueSeasons = params.seasons.filter((s) => s.league === params.league);
  /**
   * PHASE 8 — a resume attempt MUST keep the prefix's forecasts. The pipeline
   * only honours a checkpoint when every match before its cursor already
   * carries one, and it reuses those forecasts verbatim. Stripping them here
   * would fail that check on every run and turn incremental checkpointing into
   * dead code that silently costs a full rebuild instead.
   */
  const resuming = Boolean(rest.checkpoint) && rest.forceFullRebuild !== true;
  const payload = {
    ...rest,
    seasons: resuming ? leagueSeasons : lighten(leagueSeasons)
  };

  const instance = getWorker();
  if (instance) {
    try {
      const result = await runInWorker(instance, payload, onProgress);
      return {
        ...result,
        seasons: mergeSeasons(params.seasons, result.seasons),
        mode: 'worker'
      };
    } catch {
      // Fall through to the in-process walk; identical math, same output.
      // The failed worker is removed so a broken worker cannot be selected
      // again by a later round-robin dispatch.
      workerDisabled = true;
      removeWorker(instance);
    }
  }

  const result = await computeLeaguePipeline({ ...payload, onProgress });
  return {
    ...result,
    seasons: mergeSeasons(params.seasons, result.seasons),
    mode: 'inline'
  };
}

/**
 * Releases all pipeline workers owned by this module.
 *
 * Normally the pool may live for the lifetime of the page because worker
 * startup is expensive. This helper is useful for hot-reload/test teardown
 * and for applications that explicitly unmount the pipeline subsystem.
 */
export function disposePipelineWorkers(): void {
  for (const worker of workerPool.splice(0)) {
    try {
      worker.terminate();
    } catch {
      // Best effort.
    }
  }
  poolIdx = 0;
  workerDisabled = false;
}
