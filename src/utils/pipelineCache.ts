/**
 * IndexedDB-backed cache for the full WinMix domain state INCLUDING per-match
 * pipeline output. The regular localStorage snapshot strips pipeline data
 * (it's large and was assumed ephemeral), which forces a full ~8 800-match
 * recompute on every reload. This cache stores the complete seasons array
 * with predictions intact, so a reload that matches the current schema
 * versions restores instantly with zero recompute.
 *
 * The cache is keyed on three version stamps: STORAGE schema, FEATURE schema
 * and PIPELINE contract. Any mismatch discards the blob — exactly like the
 * checkpoint store, never attempting a migration across a dimensionality
 * change.
 */

import {
  FEATURE_SCHEMA_VERSION,
  PIPELINE_CONTRACT_VERSION,
  SCHEMA_VERSION
} from './constants';
import type { CalibrationMap, Season, Slip, FixtureRound, AliasMap, SeasonCounters, WeightMap, WinmixSettings } from '../types/winmix';

const DB_NAME = 'winmix-pipeline-cache';
const DB_VERSION = 1;
const STORE_NAME = 'state';
const RECORD_KEY = 'full-state';

export interface CachedPipelineState {
  schemaVersion: number;
  featureSchemaVersion: number;
  pipelineContractVersion: number;
  savedAt: string;
  seasons: Season[];
  teamWeights: WeightMap;
  teamAliasMap: AliasMap;
  seasonCounters: SeasonCounters;
  calibration: CalibrationMap;
  settings: WinmixSettings;
  round: FixtureRound;
  slips: Slip[];
}

let dbPromise: Promise<IDBDatabase | null> | null = null;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function isCachedPipelineState(value: unknown): value is CachedPipelineState {
  if (!isRecord(value)) return false;

  return (
    typeof value.schemaVersion === 'number' &&
    typeof value.featureSchemaVersion === 'number' &&
    typeof value.pipelineContractVersion === 'number' &&
    typeof value.savedAt === 'string' &&
    Array.isArray(value.seasons) &&
    isRecord(value.teamWeights) &&
    isRecord(value.teamAliasMap) &&
    isRecord(value.seasonCounters) &&
    isRecord(value.calibration) &&
    isRecord(value.settings) &&
    isRecord(value.round) &&
    Array.isArray(value.slips)
  );
}

async function deleteCachedRecord(db: IDBDatabase): Promise<void> {
  try {
    const tx = db.transaction(STORE_NAME, 'readwrite');
    tx.objectStore(STORE_NAME).delete(RECORD_KEY);
    await new Promise<void>((resolve) => {
      tx.oncomplete = () => resolve();
      tx.onerror = () => resolve();
      tx.onabort = () => resolve();
    });
  } catch {
    // Best effort only.
  }
}

function openDB(): Promise<IDBDatabase | null> {
  if (dbPromise) return dbPromise;

  dbPromise = new Promise((resolve) => {
    if (typeof indexedDB === 'undefined') {
      resolve(null);
      return;
    }

    try {
      const request = indexedDB.open(DB_NAME, DB_VERSION);

      request.onupgradeneeded = () => {
        const db = request.result;
        if (!db.objectStoreNames.contains(STORE_NAME)) {
          db.createObjectStore(STORE_NAME);
        }
      };

      request.onsuccess = () => {
        const db = request.result;

        db.onversionchange = () => {
          db.close();
          dbPromise = null;
        };

        resolve(db);
      };

      request.onerror = () => {
        dbPromise = null;
        resolve(null);
      };

      request.onblocked = () => {
        // Another tab is holding an old connection. The cache is optional,
        // so do not make application startup depend on IndexedDB progress.
      };
    } catch {
      dbPromise = null;
      resolve(null);
    }
  });

  return dbPromise;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function isCachedPipelineState(value: unknown): value is CachedPipelineState {
  if (!isRecord(value)) return false;

  return (
    typeof value.schemaVersion === 'number' &&
    typeof value.featureSchemaVersion === 'number' &&
    typeof value.pipelineContractVersion === 'number' &&
    typeof value.savedAt === 'string' &&
    Array.isArray(value.seasons) &&
    isRecord(value.teamWeights) &&
    isRecord(value.teamAliasMap) &&
    isRecord(value.seasonCounters) &&
    isRecord(value.calibration) &&
    isRecord(value.settings) &&
    isRecord(value.round) &&
    Array.isArray(value.slips)
  );
}

async function deleteCachedRecord(db: IDBDatabase): Promise<void> {
  try {
    const tx = db.transaction(STORE_NAME, 'readwrite');
    tx.objectStore(STORE_NAME).delete(RECORD_KEY);
    await new Promise<void>((resolve) => {
      tx.oncomplete = () => resolve();
      tx.onerror = () => resolve();
      tx.onabort = () => resolve();
    });
  } catch {
    // Best effort only.
  }
}

export function isPipelineCacheAvailable(): Promise<boolean> {
  return openDB().then((db) => db !== null);
}

export async function savePipelineCache(state: CachedPipelineState): Promise<void> {
  const db = await openDB();
  if (!db) return;
  try {
    const tx = db.transaction(STORE_NAME, 'readwrite');
    tx.objectStore(STORE_NAME).put(state, RECORD_KEY);
    await new Promise<void>((resolve, reject) => {
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  } catch {
    // Cache is best-effort; a failed write must never break the app.
  }
}

export async function loadPipelineCache(): Promise<CachedPipelineState | null> {
  const db = await openDB();
  if (!db) return null;
  try {
    const tx = db.transaction(STORE_NAME, 'readonly');
    const req = tx.objectStore(STORE_NAME).get(RECORD_KEY);
    const result = await new Promise<CachedPipelineState | null>((resolve) => {
      req.onsuccess = () => resolve(req.result ?? null);
      req.onerror = () => resolve(null);
    });
    if (!isCachedPipelineState(result)) {
      await deleteCachedRecord(db);
      return null;
    }

    if (
      result.schemaVersion !== SCHEMA_VERSION ||
      result.featureSchemaVersion !== FEATURE_SCHEMA_VERSION ||
      result.pipelineContractVersion !== PIPELINE_CONTRACT_VERSION
    ) {
      await deleteCachedRecord(db);
      return null;
    }

    return result;
  } catch {
    return null;
  }
}

export async function clearPipelineCache(): Promise<void> {
  const db = await openDB();
  if (!db) return;
  try {
    const tx = db.transaction(STORE_NAME, 'readwrite');
    tx.objectStore(STORE_NAME).delete(RECORD_KEY);
    await new Promise<void>((resolve) => {
      tx.oncomplete = () => resolve();
      tx.onerror = () => resolve();
    });
  } catch {
    // best-effort
  }
}

/**
 * Returns the cache timestamp without exposing the IndexedDB record itself.
 * Useful for UI diagnostics where the application wants to tell the user
 * whether a restored pipeline is recent.
 */
export async function getPipelineCacheSavedAt(): Promise<string | null> {
  const state = await loadPipelineCache();
  return state?.savedAt ?? null;
}
