import {
  useCallback,
  useEffect,
  useRef,
  useState,
} from 'react';

import type { ConductorDirectives } from '../types/conductor';
import { defaultDirectives } from '../types/conductor';

import { fetchConductorDirectives } from '../services/geminiConductor';

import type { ConductorPayload } from '../utils/conductorContext';

/* -------------------------------------------------------------------------- */
/* CONFIG                                                                     */
/* -------------------------------------------------------------------------- */

/**
 * Session-level cache.
 *
 * The previous implementation stored only ONE payload.
 * If payload A -> payload B -> payload A happened, A was no longer cached.
 *
 * We now keep several payloads independently.
 */
const CACHE_KEY = 'winmix-conductor-cache-v2';

const CACHE_TTL_MS =
  30 * 60 * 1000; // 30 minutes

const MAX_CACHE_ENTRIES = 8;

/**
 * Minimum time between manual/automatic hook-level refreshes.
 *
 * The service layer has an additional global rate limiter.
 * This second layer prevents React from repeatedly calling the service.
 */
const MIN_REFRESH_INTERVAL_MS =
  15_000;

/**
 * Force refresh has a separate, longer protection.
 *
 * A button repeatedly clicked by the user must not bypass
 * the rate-limit protection.
 */
const FORCE_REFRESH_COOLDOWN_MS =
  30_000;

/**
 * If the payload changes while another request is active,
 * we do not immediately start another Gemini request.
 *
 * The new payload is remembered and evaluated after the active request
 * finishes.
 */
const MAX_PENDING_REFETCH_DELAY_MS =
  500;

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

/**
 * Creates a deterministic lightweight payload fingerprint.
 *
 * Important:
 * This intentionally contains the information that affects the Conductor
 * decision rather than object identity.
 *
 * Therefore:
 *
 * new object !== old object
 *
 * does NOT automatically mean:
 *
 * new Conductor request required.
 */
function hashPayload(
  payload: ConductorPayload,
): string {
  const parts = [
    `seasons:${payload.seasonCount}`,

    `leagues:${payload.leagues
      .map(
        (league) =>
          [
            league.league,
            league.sampleSize,
            Number.isFinite(
              league.observedBttsRate,
            )
              ? league.observedBttsRate.toFixed(
                  4,
                )
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
      .map(
        (outlier) =>
          [
            outlier.league,
            outlier.teamKey,
            Number.isFinite(
              outlier.weight,
            )
              ? outlier.weight.toFixed(3)
              : 'nan',
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
    const raw =
      sessionStorage.getItem(
        CACHE_KEY,
      );

    if (!raw) {
      return {
        version: 2,
        entries: [],
      };
    }

    const parsed =
      JSON.parse(raw) as Partial<CacheStore>;

    if (
      parsed.version !== 2 ||
      !Array.isArray(parsed.entries)
    ) {
      return {
        version: 2,
        entries: [],
      };
    }

    const now = Date.now();

    const validEntries =
      parsed.entries.filter(
        (entry): entry is CacheEntry =>
          Boolean(
            entry &&
              typeof entry.payloadHash ===
                'string' &&
              entry.directives &&
              typeof entry.directives ===
                'object' &&
              typeof entry.cachedAt ===
                'number' &&
              now - entry.cachedAt <=
                CACHE_TTL_MS,
          ),
      );

    return {
      version: 2,
      entries: validEntries.slice(
        0,
        MAX_CACHE_ENTRIES,
      ),
    };
  } catch {
    return {
      version: 2,
      entries: [],
    };
  }
}

function writeCache(
  entry: CacheEntry,
): void {
  try {
    const store =
      readCache();

    const existingIndex =
      store.entries.findIndex(
        (item) =>
          item.payloadHash ===
          entry.payloadHash,
      );

    if (existingIndex !== -1) {
      store.entries.splice(
        existingIndex,
        1,
      );
    }

    store.entries.unshift(
      entry,
    );

    store.entries =
      store.entries.slice(
        0,
        MAX_CACHE_ENTRIES,
      );

    sessionStorage.setItem(
      CACHE_KEY,
      JSON.stringify(store),
    );
  } catch {
    /*
     * sessionStorage can be unavailable in private browsing,
     * sandboxed environments or when storage quota is exceeded.
     *
     * The Conductor must continue working without it.
     */
  }
}

function readCachedDirectives(
  payloadHash: string,
): ConductorDirectives | null {
  const store =
    readCache();

  const entry =
    store.entries.find(
      (item) =>
        item.payloadHash ===
        payloadHash,
    );

  if (!entry) {
    return null;
  }

  return entry.directives;
}

/* -------------------------------------------------------------------------- */
/* HASH COMPARISON                                                            */
/* -------------------------------------------------------------------------- */

/**
 * We keep the last processed hash separately from the payload reference.
 *
 * This is important because parents may create a new payload object on every
 * render even when the actual Conductor input has not changed.
 */
function usePayloadHash(
  payload: ConductorPayload | null,
): string | null {
  return payload
    ? hashPayload(payload)
    : null;
}

/* -------------------------------------------------------------------------- */
/* HOOK                                                                       */
/* -------------------------------------------------------------------------- */

export function useWinmixConductor(
  payload: ConductorPayload | null,
): UseConductorResult {
  const [directives, setDirectives] =
    useState<ConductorDirectives>(
      defaultDirectives,
    );

  const [loading, setLoading] =
    useState(false);

  const [error, setError] =
    useState<string | null>(null);

  /**
   * Always keep the latest payload available to async callbacks.
   */
  const payloadRef =
    useRef<ConductorPayload | null>(
      payload,
    );

  payloadRef.current =
    payload;

  /**
   * Latest deterministic payload hash.
   */
  const payloadHash =
    usePayloadHash(payload);

  const payloadHashRef =
    useRef<string | null>(
      payloadHash,
    );

  payloadHashRef.current =
    payloadHash;

  /**
   * Prevent state updates after unmount.
   */
  const mountedRef =
    useRef(true);

  /**
   * Last payload that has actually been processed.
   */
  const processedHashRef =
    useRef<string | null>(null);

  /**
   * Hash currently being requested.
   */
  const inFlightHashRef =
    useRef<string | null>(null);

  /**
   * Manual/automatic request timestamps.
   */
  const lastRefreshAtRef =
    useRef(0);

  const lastForceRefreshAtRef =
    useRef(0);

  /**
   * Prevent multiple doFetch() calls from starting simultaneously
   * inside this hook instance.
   */
  const requestPromiseRef =
    useRef<Promise<void> | null>(
      null,
    );

  /**
   * When a payload changes during a request, remember that another
   * evaluation is needed afterwards.
   */
  const pendingRefetchRef =
    useRef(false);

  /* ------------------------------------------------------------------------ */
  /* UNMOUNT                                                                 */
  /* ------------------------------------------------------------------------ */

  useEffect(() => {
    mountedRef.current =
      true;

    return () => {
      mountedRef.current =
        false;
    };
  }, []);

  /* ------------------------------------------------------------------------ */
  /* SAFE STATE HELPERS                                                       */
  /* ------------------------------------------------------------------------ */

  const setSafeDirectives =
    useCallback(
      (
        value: ConductorDirectives,
      ) => {
        if (
          mountedRef.current
        ) {
          setDirectives(value);
        }
      },
      [],
    );

  const setSafeLoading =
    useCallback(
      (value: boolean) => {
        if (
          mountedRef.current
        ) {
          setLoading(value);
        }
      },
      [],
    );

  const setSafeError =
    useCallback(
      (
        value: string | null,
      ) => {
        if (
          mountedRef.current
        ) {
          setError(value);
        }
      },
      [],
    );

  /* ------------------------------------------------------------------------ */
  /* FETCH                                                                    */
  /* ------------------------------------------------------------------------ */

  const doFetch = useCallback(
    async (
      force: boolean,
    ): Promise<void> => {
      const currentPayload =
        payloadRef.current;

      const currentHash =
        payloadHashRef.current;

      if (
        !currentPayload ||
        !currentHash
      ) {
        setSafeDirectives(
          defaultDirectives(),
        );
        setSafeLoading(false);
        setSafeError(null);

        processedHashRef.current =
          null;

        return;
      }

      /* ------------------------------------------------------------------ */
      /* DUPLICATE REQUEST                                                  */
      /* ------------------------------------------------------------------ */

      if (
        requestPromiseRef.current
      ) {
        /*
         * There is already a request in progress.
         *
         * We do not create another Gemini call.
         */
        pendingRefetchRef.current =
          true;

        return;
      }

      /* ------------------------------------------------------------------ */
      /* SAME PAYLOAD                                                       */
      /* ------------------------------------------------------------------ */

      if (
        !force &&
        processedHashRef.current ===
          currentHash
      ) {
        return;
      }

      /* ------------------------------------------------------------------ */
      /* CACHE                                                               */
      /* ------------------------------------------------------------------ */

      if (!force) {
        const cached =
          readCachedDirectives(
            currentHash,
          );

        if (cached) {
          processedHashRef.current =
            currentHash;

          setSafeDirectives(
            cached,
          );

          setSafeLoading(false);
          setSafeError(null);

          return;
        }
      }

      /* ------------------------------------------------------------------ */
      /* FORCE REFRESH RATE LIMIT                                           */
      /* ------------------------------------------------------------------ */

      const now =
        Date.now();

      if (
        force &&
        now -
            lastForceRefreshAtRef.current <
          FORCE_REFRESH_COOLDOWN_MS
      ) {
        setSafeError(
          'A Conductor kézi frissítése átmenetileg korlátozva van. Kérlek, várj néhány másodpercet.',
        );

        return;
      }

      /* ------------------------------------------------------------------ */
      /* GENERAL REFRESH RATE LIMIT                                         */
      /* ------------------------------------------------------------------ */

      if (
        !force &&
        now -
            lastRefreshAtRef.current <
          MIN_REFRESH_INTERVAL_MS
      ) {
        /*
         * Do not show this as a hard error.
         *
         * The user should still see the latest valid directives.
         */
        return;
      }

      /* ------------------------------------------------------------------ */
      /* START REQUEST                                                      */
      /* ------------------------------------------------------------------ */

      lastRefreshAtRef.current =
        now;

      if (force) {
        lastForceRefreshAtRef.current =
          now;
      }

      inFlightHashRef.current =
        currentHash;

      pendingRefetchRef.current =
        false;

      setSafeLoading(true);
      setSafeError(null);

      const requestPromise =
        (async () => {
          try {
            const result =
              await fetchConductorDirectives(
                currentPayload,
              );

            /*
             * The component may have unmounted while Gemini was processing.
             */
            if (
              !mountedRef.current
            ) {
              return;
            }

            /*
             * IMPORTANT:
             *
             * If the payload changed while the request was running,
             * the result belongs to the OLD payload.
             *
             * We may display it temporarily, but we must NOT mark the
             * NEW payload as processed.
             */
            const latestHash =
              payloadHashRef.current;

            const requestStillCurrent =
              latestHash ===
              currentHash;

            if (
              result.directives
            ) {
              setSafeDirectives(
                result.directives,
              );

              writeCache({
                payloadHash:
                  currentHash,
                directives:
                  result.directives,
                cachedAt:
                  Date.now(),
              });

              if (
                requestStillCurrent
              ) {
                processedHashRef.current =
                  currentHash;
              }

              /*
               * A service-level fallback can still contain directives while
               * returning an error. Preserve that distinction.
               */
              setSafeError(
                result.error,
              );
            } else {
              /*
               * Do NOT wipe out the current valid directives merely because
               * Gemini temporarily failed.
               *
               * This is a major behavioral improvement over the old hook.
               */
              setSafeError(
                result.error ??
                  'Ismeretlen Conductor hiba.',
              );
            }
          } catch (err) {
            if (
              !mountedRef.current
            ) {
              return;
            }

            const message =
              err instanceof Error
                ? err.message
                : String(err);

            console.warn(
              '[Conductor] Hiba:',
              err,
            );

            /*
             * Keep the last valid directives.
             * A monitoring service should degrade gracefully.
             */
            setSafeError(
              `Váratlan Conductor hiba: ${message}`,
            );
          } finally {
            if (
              inFlightHashRef.current ===
              currentHash
            ) {
              inFlightHashRef.current =
                null;
            }

            if (
              requestPromiseRef.current
            ) {
              requestPromiseRef.current =
                null;
            }

            setSafeLoading(false);

            /*
             * If a new payload arrived while the request was running,
             * schedule exactly ONE follow-up evaluation.
             */
            if (
              pendingRefetchRef.current &&
              mountedRef.current
            ) {
              pendingRefetchRef.current =
                false;

              window.setTimeout(
                () => {
                  if (
                    !mountedRef.current
                  ) {
                    return;
                  }

                  void doFetch(false);
                },
                MAX_PENDING_REFETCH_DELAY_MS,
              );
            }
          }
        })();

      requestPromiseRef.current =
        requestPromise;

      await requestPromise;
    },
    [
      setSafeDirectives,
      setSafeError,
      setSafeLoading,
    ],
  );

  /* ------------------------------------------------------------------------ */
  /* PUBLIC REFRESH                                                           */
  /* ------------------------------------------------------------------------ */

  const refresh =
    useCallback(
      (force?: boolean) => {
        void doFetch(
          force === true,
        );
      },
      [doFetch],
    );

  /* ------------------------------------------------------------------------ */
  /* AUTOMATIC FETCH                                                          */
  /* ------------------------------------------------------------------------ */

  useEffect(() => {
    if (!payload) {
      processedHashRef.current =
        null;

      setSafeDirectives(
        defaultDirectives(),
      );

      setSafeLoading(false);
      setSafeError(null);

      return;
    }

    /*
     * The effect depends on the deterministic hash rather than merely
     * depending on the payload object.
     *
     * This is critical for React applications where payload objects can
     * be recreated on every render.
     */
    if (
      payloadHash === null
    ) {
      return;
    }

    /*
     * Same logical payload -> nothing to do.
     */
    if (
      processedHashRef.current ===
      payloadHash
    ) {
      return;
    }

    /*
     * A request is already running.
     * Mark the payload as pending; doFetch() will evaluate it afterwards.
     */
    if (
      requestPromiseRef.current
    ) {
      pendingRefetchRef.current =
        true;

      return;
    }

    void doFetch(false);
  }, [
    payloadHash,
    payload,
    doFetch,
    setSafeDirectives,
    setSafeError,
    setSafeLoading,
  ]);

  /* ------------------------------------------------------------------------ */
  /* RETURN                                                                   */
  /* ------------------------------------------------------------------------ */

  return {
    directives,
    loading,
    error,
    refresh,
  };
}