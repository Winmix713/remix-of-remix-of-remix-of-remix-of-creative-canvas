import {
  useCallback,
  useEffect,
  useRef,
  useState,
} from 'react';

import type { ConductorDirectives } from '../types/conductor';
import * as ConductorTypes from '../types/conductor';

import { fetchConductorDirectives } from '../services/geminiConductor';
import type { ConductorPayload } from '../utils/conductorContext';

/* -------------------------------------------------------------------------- */
/* HELPER: RESOLVE DEFAULT DIRECTIVES (Handles object OR factory function)     */
/* -------------------------------------------------------------------------- */
function getDefaultDirectives(): ConductorDirectives {
  const d = (ConductorTypes as Record<string, unknown>).defaultDirectives;
  if (typeof d === 'function') {
    return (d as () => ConductorDirectives)();
  }
  return d as ConductorDirectives;
}

/* -------------------------------------------------------------------------- */
/* CONFIG & TELEMETRY                                                         */
/* -------------------------------------------------------------------------- */

const CACHE_KEY = 'winmix-conductor-cache-v2';
const CACHE_TTL_MS = 30 * 60 * 1000; // 30 minutes
const MAX_CACHE_ENTRIES = 8;

const MIN_REFRESH_INTERVAL_MS = 15_000;
const FORCE_REFRESH_COOLDOWN_MS = 30_000;
const MAX_PENDING_REFETCH_DELAY_MS = 500;

let requestSequence = 0;

function logConductor(event: string, meta?: Record<string, unknown>) {
  const metaStr = meta
    ? ' | ' + Object.entries(meta).map(([k, v]) => `${k}=${v}`).join(' ')
    : '';
  console.log(`[Conductor] ${event}${metaStr}`);
}

/* -------------------------------------------------------------------------- */
/* TYPES                                                                      */
/* -------------------------------------------------------------------------- */

interface CacheEntry {
  payloadHash: string;
  directives: ConductorDirectives;
  cachedAt: number;
}

interface CacheStore {
  version: 2;
  entries: CacheEntry[];
}

export interface UseConductorResult {
  directives: ConductorDirectives;
  loading: boolean;
  error: string | null;
  refresh: (force?: boolean) => void;
}

/* -------------------------------------------------------------------------- */
/* PAYLOAD HASH                                                               */
/* -------------------------------------------------------------------------- */

function hashPayload(payload: ConductorPayload): string {
  const parts = [
    `seasons:${payload.seasonCount}`,
    `leagues:${payload.leagues
      .map((league) =>
        [
          league.league,
          league.sampleSize,
          Number.isFinite(league.observedBttsRate)
            ? league.observedBttsRate.toFixed(4)
            : 'nan',
        ].join(':'),
      )
      .sort()
      .join(',')}`,
    `round:${[
      payload.round.totalMatches,
      payload.round.bttsAbove50,
      payload.round.blowoutRiskCount,
    ].join(':')}`,
    `weights:${payload.weightOutliers
      .map((outlier) =>
        [
          outlier.league,
          outlier.teamKey,
          Number.isFinite(outlier.weight) ? outlier.weight.toFixed(3) : 'nan',
        ].join(':'),
      )
      .sort()
      .join(',')}`,
    `ledger:${[
      payload.ledger.totalSlips,
      payload.ledger.settledSlips,
      payload.ledger.wonSlips,
    ].join(':')}`,
  ];

  return parts.join('|');
}

/* -------------------------------------------------------------------------- */
/* SESSION STORAGE CACHE                                                      */
/* -------------------------------------------------------------------------- */

function readCache(): CacheStore {
  try {
    const raw = sessionStorage.getItem(CACHE_KEY);
    if (!raw) return { version: 2, entries: [] };

    const parsed = JSON.parse(raw) as Partial<CacheStore>;
    if (parsed.version !== 2 || !Array.isArray(parsed.entries)) {
      return { version: 2, entries: [] };
    }

    const now = Date.now();
    const validEntries = parsed.entries.filter(
      (entry): entry is CacheEntry =>
        Boolean(
          entry &&
            typeof entry.payloadHash === 'string' &&
            entry.directives &&
            typeof entry.directives === 'object' &&
            typeof entry.cachedAt === 'number' &&
            now - entry.cachedAt <= CACHE_TTL_MS,
        ),
    );

    return {
      version: 2,
      entries: validEntries.slice(0, MAX_CACHE_ENTRIES),
    };
  } catch {
    return { version: 2, entries: [] };
  }
}

function writeCache(entry: CacheEntry): void {
  try {
    const store = readCache();
    const existingIndex = store.entries.findIndex(
      (item) => item.payloadHash === entry.payloadHash,
    );

    if (existingIndex !== -1) {
      store.entries.splice(existingIndex, 1);
    }

    store.entries.unshift(entry);
    store.entries = store.entries.slice(0, MAX_CACHE_ENTRIES);

    sessionStorage.setItem(CACHE_KEY, JSON.stringify(store));
  } catch {
    // sessionStorage nem elérhető vagy kvóta túllépve
  }
}

function readCachedDirectives(payloadHash: string): ConductorDirectives | null {
  const store = readCache();
  const entry = store.entries.find((item) => item.payloadHash === payloadHash);
  return entry ? entry.directives : null;
}

/* -------------------------------------------------------------------------- */
/* HOOK IMPLEMENTATION                                                        */
/* -------------------------------------------------------------------------- */

export function useWinmixConductor(
  payload: ConductorPayload | null,
): UseConductorResult {
  const [directives, setDirectives] = useState<ConductorDirectives>(getDefaultDirectives);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const payloadRef = useRef<ConductorPayload | null>(payload);
  payloadRef.current = payload;

  const payloadHash = payload ? hashPayload(payload) : null;
  const payloadHashRef = useRef<string | null>(payloadHash);
  payloadHashRef.current = payloadHash;

  const mountedRef = useRef(true);
  const processedHashRef = useRef<string | null>(null);
  const inFlightHashRef = useRef<string | null>(null);

  const lastRefreshAtRef = useRef(0);
  const lastForceRefreshAtRef = useRef(0);
  const requestPromiseRef = useRef<Promise<void> | null>(null);
  const pendingRefetchRef = useRef(false);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const setSafeDirectives = useCallback((val: ConductorDirectives) => {
    if (mountedRef.current) setDirectives(val);
  }, []);

  const setSafeLoading = useCallback((val: boolean) => {
    if (mountedRef.current) setLoading(val);
  }, []);

  const setSafeError = useCallback((val: string | null) => {
    if (mountedRef.current) setError(val);
  }, []);

  /* ------------------------------------------------------------------------ */
  /* FETCH EXECUTOR                                                           */
  /* ------------------------------------------------------------------------ */

  const doFetch = useCallback(
    async (force: boolean, triggerType: 'AUTO' | 'FORCE' | 'PENDING' = 'AUTO'): Promise<void> => {
      const currentPayload = payloadRef.current;
      const currentHash = payloadHashRef.current;

      if (!currentPayload || !currentHash) {
        setSafeDirectives(getDefaultDirectives());
        setSafeLoading(false);
        setSafeError(null);
        processedHashRef.current = null;
        return;
      }

      // Duplikátum kérés szűrése
      if (requestPromiseRef.current) {
        logConductor('IN_FLIGHT_BUSY', { triggerType, currentHash: currentHash.slice(0, 16) });
        pendingRefetchRef.current = true;
        return;
      }

      // Változatlan payload esetén kilépés (kivéve force)
      if (!force && processedHashRef.current === currentHash) {
        return;
      }

      // Cache olvasás
      if (!force) {
        const cached = readCachedDirectives(currentHash);
        if (cached) {
          logConductor('CACHE_HIT', { hash: currentHash.slice(0, 16) });
          processedHashRef.current = currentHash;
          setSafeDirectives(cached);
          setSafeLoading(false);
          setSafeError(null);
          return;
        }
      }

      const now = Date.now();

      // Force refresh cooldown
      if (force && now - lastForceRefreshAtRef.current < FORCE_REFRESH_COOLDOWN_MS) {
        const waitSec = Math.ceil((FORCE_REFRESH_COOLDOWN_MS - (now - lastForceRefreshAtRef.current)) / 1000);
        logConductor('FORCE_RATE_LIMITED', { waitSec });
        setSafeError(`A Conductor kézi frissítése átmenetileg korlátozva van. Várj ${waitSec} másodpercet.`);
        return;
      }

      // Általános rate limit
      if (!force && now - lastRefreshAtRef.current < MIN_REFRESH_INTERVAL_MS) {
        logConductor('AUTO_RATE_LIMITED_DEBOUNCE', { hash: currentHash.slice(0, 16) });
        return;
      }

      const seq = ++requestSequence;
      lastRefreshAtRef.current = now;
      if (force) lastForceRefreshAtRef.current = now;

      inFlightHashRef.current = currentHash;
      pendingRefetchRef.current = false;

      logConductor(`#${seq} START_${triggerType}`, { hash: currentHash.slice(0, 16) });
      setSafeLoading(true);
      setSafeError(null);

      const requestPromise = (async () => {
        try {
          const result = await fetchConductorDirectives(currentPayload);

          if (!mountedRef.current) return;

          const latestHash = payloadHashRef.current;
          const isStillCurrent = latestHash === currentHash;

          if (result.directives) {
            setSafeDirectives(result.directives);

            // KRITIKUS JAVÍTÁS: Csak akkor írjuk a cache-be, ha NEM fallback hibaeredmény!
            if (!result.error) {
              writeCache({
                payloadHash: currentHash,
                directives: result.directives,
                cachedAt: Date.now(),
              });
              if (isStillCurrent) {
                processedHashRef.current = currentHash;
              }
              logConductor(`#${seq} SUCCESS_CACHED`, { hash: currentHash.slice(0, 16) });
            } else {
              logConductor(`#${seq} DEGRADED_FALLBACK_NOT_CACHED`, { error: result.error });
            }

            setSafeError(result.error);
          } else {
            logConductor(`#${seq} FAILED_DIRECTIVES_NULL`, { error: result.error });
            setSafeError(result.error ?? 'Ismeretlen Conductor hiba.');
          }
        } catch (err) {
          if (!mountedRef.current) return;
          const msg = err instanceof Error ? err.message : String(err);
          logConductor(`#${seq} UNCAUGHT_EXCEPTION`, { error: msg });
          setSafeError(`Váratlan Conductor hiba: ${msg}`);
        } finally {
          if (inFlightHashRef.current === currentHash) {
            inFlightHashRef.current = null;
          }
          requestPromiseRef.current = null;
          setSafeLoading(false);

          if (pendingRefetchRef.current && mountedRef.current) {
            pendingRefetchRef.current = false;
            logConductor('PENDING_REFETCH_SCHEDULED');
            window.setTimeout(() => {
              if (mountedRef.current) {
                void doFetch(false, 'PENDING');
              }
            }, MAX_PENDING_REFETCH_DELAY_MS);
          }
        }
      })();

      requestPromiseRef.current = requestPromise;
      await requestPromise;
    },
    [setSafeDirectives, setSafeError, setSafeLoading],
  );

  /* ------------------------------------------------------------------------ */
  /* PUBLIC REFRESH                                                           */
  /* ------------------------------------------------------------------------ */

  const refresh = useCallback(
    (force?: boolean) => {
      void doFetch(force === true, force ? 'FORCE' : 'AUTO');
    },
    [doFetch],
  );

  /* ------------------------------------------------------------------------ */
  /* AUTOMATIC FETCH (KIZÁRÓLAG payloadHash ALAPJÁN)                          */
  /* ------------------------------------------------------------------------ */

  useEffect(() => {
    // 1. Ha nincs hash (nincs adat), alaphelyzetbe állunk
    if (!payloadHash) {
      processedHashRef.current = null;
      setSafeDirectives(getDefaultDirectives());
      setSafeLoading(false);
      setSafeError(null);
      return;
    }

    // 2. Ha a tartalom ujjlenyomata nem változott, NEM futunk le újra
    if (processedHashRef.current === payloadHash) {
      return;
    }

    // 3. Ha már fut egy kérés, megjelöljük a folyamatot
    if (requestPromiseRef.current) {
      pendingRefetchRef.current = true;
      return;
    }

    void doFetch(false, 'AUTO');
  }, [payloadHash, doFetch, setSafeDirectives, setSafeError, setSafeLoading]);

  return {
    directives,
    loading,
    error,
    refresh,
  };
}