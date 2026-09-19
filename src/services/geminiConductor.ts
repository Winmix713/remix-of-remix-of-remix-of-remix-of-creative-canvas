import type { ConductorDirectives } from '../types/conductor';
import { defaultDirectives } from '../types/conductor';
import {
  payloadToPromptText,
  type ConductorPayload,
} from '../utils/conductorContext';

/* -------------------------------------------------------------------------- */
/* CONFIG                                                                     */
/* -------------------------------------------------------------------------- */

const GEMINI_MODEL = 'gemini-3.6-flash-lite';

const GEMINI_ENDPOINT =
  `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent`;

/**
 * Maximum number of RETRIES after the initial request.
 *
 * 0 = initial request
 * 1 = retry
 * 2 = retry
 *
 * Total maximum attempts = 3.
 */
const MAX_RETRIES = 2;

/**
 * Exponential retry base.
 *
 * attempt 0 -> ~1200 ms
 * attempt 1 -> ~2400 ms
 */
const RETRY_BASE_DELAY_MS = 1200;

/**
 * Maximum retry-after delay accepted from Gemini.
 *
 * We intentionally cap this because an API response should never be able
 * to freeze the frontend for an uncontrolled amount of time.
 */
const MAX_RETRY_AFTER_MS = 15_000;

/**
 * Minimum time between TWO DIFFERENT Gemini requests.
 *
 * This is the most important protection against the current 429 storm.
 *
 * Even if React causes several payload changes in quick succession,
 * Gemini will not receive those requests back-to-back.
 */
const MIN_REQUEST_INTERVAL_MS = 30_000;

/**
 * After a 429 response we temporarily close the Conductor circuit.
 *
 * This prevents:
 *
 * request
 * -> 429
 * -> retry
 * -> 429
 * -> retry
 * -> 429
 *
 * and then another component immediately doing the same thing.
 */
const RATE_LIMIT_COOLDOWN_MS = 30_000;

/**
 * Network/server errors receive a shorter cooldown.
 */
const TEMPORARY_ERROR_COOLDOWN_MS = 5_000;

/**
 * Frontend request timeout.
 *
 * Gemini should normally respond much faster than this.
 */
const REQUEST_TIMEOUT_MS = 45_000;

/**
 * Keep a small in-memory cache of successful payloads.
 *
 * This is deliberately separate from sessionStorage.
 * It protects against rapid React rerenders within the same page session.
 */
const MEMORY_CACHE_TTL_MS = 10 * 60 * 1000;

const MEMORY_CACHE_MAX_ENTRIES = 8;

/**
 * HTTP statuses that can reasonably be retried.
 */
const RETRYABLE_STATUS_CODES = new Set([
  408,
  429,
  500,
  502,
  503,
  504,
]);

/* -------------------------------------------------------------------------- */
/* RESPONSE SCHEMA                                                            */
/* -------------------------------------------------------------------------- */

const RESPONSE_SCHEMA = {
  type: 'object',
  properties: {
    timestamp: {
      type: 'string',
    },

    leagues: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          league: {
            type: 'string',
            enum: ['angol', 'spanyol'],
          },

          status: {
            type: 'string',
            enum: ['GREEN', 'YELLOW', 'RED'],
          },

          bttsDriftPct: {
            type: 'number',
          },

          suppressCore1: {
            type: 'boolean',
          },

          warningNotice: {
            type: 'string',
            nullable: true,
          },
        },

        required: [
          'league',
          'status',
          'bttsDriftPct',
          'suppressCore1',
          'warningNotice',
        ],
      },
    },

    strategy: {
      type: 'object',
      properties: {
        vetoModeActive: {
          type: 'boolean',
        },

        allowVolatileSecondary: {
          type: 'boolean',
        },

        recommendedMarkets: {
          type: 'array',
          items: {
            type: 'string',
          },
        },

        tacticalSummary: {
          type: 'string',
        },
      },

      required: [
        'vetoModeActive',
        'allowVolatileSecondary',
        'recommendedMarkets',
        'tacticalSummary',
      ],
    },

    proposals: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          league: {
            type: 'string',
            enum: ['angol', 'spanyol'],
          },

          teamKey: {
            type: 'string',
          },

          metric: {
            type: 'string',
          },

          currentValue: {
            type: 'number',
          },

          proposedValue: {
            type: 'number',
          },

          reason: {
            type: 'string',
          },
        },

        required: [
          'league',
          'teamKey',
          'metric',
          'currentValue',
          'proposedValue',
          'reason',
        ],
      },
    },
  },

  required: [
    'timestamp',
    'leagues',
    'strategy',
    'proposals',
  ],
};

/* -------------------------------------------------------------------------- */
/* SYSTEM PROMPT                                                              */
/* -------------------------------------------------------------------------- */

const SYSTEM_PROMPT = `Te vagy a WinMix Conductor, egy felügyeleti AI a WinMix futballpredikciós rendszerhez.

A feladatod NEM a közvetlen tippelés, hanem a matematikai motor felügyelete strukturált direktívák formájában.

Három feladatod van:

1. Liga BTTS drift értékelése:
   hasonlítsd össze a megfigyelt BTTS arányt az átlagos predikcióval.

   - GREEN: drift < 5 százalékpont
   - YELLOW: drift 5-15 százalékpont
   - RED: drift > 15 százalékpont

   A suppressCore1 true, ha RED és a drift negatív
   (túl sok BTTS nem jött be).

2. Vétó mód meghatározása:
   vetoModeActive true, ha bármelyik liga RED státuszú,
   vagy a szelvények nyerési rátája 40% alatt van legalább
   10 lezárt szelvény esetén.

3. Csapatsúly-eltérés vizsgálata:
   a kiugró csapatsúlyok és piaci visszajelzés alapján
   javasolj súlykorrekciót, ha indokolt.

   Maximum 3 javaslat.

A válasz MINDIG magyar nyelvű tacticalSummary-t tartalmazzon,
maximum 2 mondatban.

Csak a megadott JSON sémának megfelelő választ add.`;

/* -------------------------------------------------------------------------- */
/* TYPES                                                                      */
/* -------------------------------------------------------------------------- */

export interface ConductorResult {
  directives: ConductorDirectives | null;
  error: string | null;
}

interface MemoryCacheEntry {
  key: string;
  directives: ConductorDirectives;
  createdAt: number;
}

interface RequestFlight {
  key: string;
  promise: Promise<ConductorResult>;
}

/* -------------------------------------------------------------------------- */
/* MODULE STATE                                                               */
/* -------------------------------------------------------------------------- */

/**
 * Module-level request state is intentional.
 *
 * React components may mount more than once and multiple components may use
 * the same Conductor service. Keeping this state outside the hook prevents
 * every component from independently hammering Gemini.
 */
let lastRequestStartedAt = 0;

let rateLimitBlockedUntil = 0;

let temporaryErrorBlockedUntil = 0;

let activeRequest: RequestFlight | null = null;

let lastSuccessfulDirectives: ConductorDirectives | null = null;

const memoryCache: MemoryCacheEntry[] = [];

/* -------------------------------------------------------------------------- */
/* PUBLIC API                                                                 */
/* -------------------------------------------------------------------------- */

/**
 * Fetches conductor directives from Gemini.
 *
 * Guarantees:
 * - never throws
 * - same payload = single-flight
 * - different payloads are globally rate-limited
 * - 429 activates a cooldown
 * - temporary errors use bounded retries
 * - successful responses are cached
 * - previous successful directives can be used as fallback
 */
export async function fetchConductorDirectives(
  payload: ConductorPayload,
): Promise<ConductorResult> {
  const apiKey = import.meta.env.VITE_GEMINI_API_KEY;

  if (!apiKey) {
    return {
      directives: null,
      error:
        'Nincs beállítva API kulcs (VITE_GEMINI_API_KEY).',
    };
  }

  const promptText = payloadToPromptText(payload);

  const requestKey = createRequestKey(promptText);

  /* ---------------------------------------------------------------------- */
  /* MEMORY CACHE                                                          */
  /* ---------------------------------------------------------------------- */

  const cached = readMemoryCache(requestKey);

  if (cached) {
    return {
      directives: cached,
      error: null,
    };
  }

  /* ---------------------------------------------------------------------- */
  /* SINGLE-FLIGHT                                                          */
  /* ---------------------------------------------------------------------- */

  if (activeRequest?.key === requestKey) {
    return activeRequest.promise;
  }

  /* ---------------------------------------------------------------------- */
  /* RATE-LIMIT CIRCUIT                                                     */
  /* ---------------------------------------------------------------------- */

  const now = Date.now();

  if (now < rateLimitBlockedUntil) {
    return createFallbackResult(
      'A Gemini Conductor átmenetileg szünetel a korábbi 429 kéréslimit miatt.',
    );
  }

  if (now < temporaryErrorBlockedUntil) {
    return createFallbackResult(
      'A Gemini Conductor átmenetileg szünetel egy korábbi szolgáltatási hiba miatt.',
    );
  }

  /* ---------------------------------------------------------------------- */
  /* GLOBAL REQUEST INTERVAL                                                */
  /* ---------------------------------------------------------------------- */

  const elapsed = now - lastRequestStartedAt;

  if (
    lastRequestStartedAt > 0 &&
    elapsed < MIN_REQUEST_INTERVAL_MS
  ) {
    const remaining =
      MIN_REQUEST_INTERVAL_MS - elapsed;

    return createFallbackResult(
      `A Conductor rate-limit védelme aktív. ` +
      `Új Gemini-kérés körülbelül ${Math.ceil(
        remaining / 1000,
      )} mp múlva indítható.`,
    );
  }

  /* ---------------------------------------------------------------------- */
  /* START SINGLE REQUEST                                                   */
  /* ---------------------------------------------------------------------- */

  const promise = executeConductorRequest(
    apiKey,
    promptText,
  );

  activeRequest = {
    key: requestKey,
    promise,
  };

  try {
    return await promise;
  } finally {
    if (activeRequest?.key === requestKey) {
      activeRequest = null;
    }
  }
}

/* -------------------------------------------------------------------------- */
/* REQUEST EXECUTION                                                          */
/* -------------------------------------------------------------------------- */

async function executeConductorRequest(
  apiKey: string,
  promptText: string,
): Promise<ConductorResult> {
  const body = {
    contents: [
      {
        role: 'user',
        parts: [
          {
            text:
              `${SYSTEM_PROMPT}\n\nADATOK:\n${promptText}`,
          },
        ],
      },
    ],

    generationConfig: {
      temperature: 0.1,
      responseMimeType: 'application/json',
      responseSchema: RESPONSE_SCHEMA,
    },
  };

  let lastError =
    'Ismeretlen Gemini hiba.';

  for (
    let attempt = 0;
    attempt <= MAX_RETRIES;
    attempt += 1
  ) {
    /*
     * Record the start of the actual network request.
     *
     * This is intentionally updated immediately before fetch().
     */
    lastRequestStartedAt = Date.now();

    try {
      const response =
        await fetchWithTimeout(
          `${GEMINI_ENDPOINT}?key=${encodeURIComponent(apiKey)}`,
          {
            method: 'POST',

            headers: {
              'Content-Type': 'application/json',
            },

            body: JSON.stringify(body),
          },
          REQUEST_TIMEOUT_MS,
        );

      /* ------------------------------------------------------------------ */
      /* SUCCESS                                                            */
      /* ------------------------------------------------------------------ */

      if (response.ok) {
        const result =
          await parseGeminiResponse(response);

        if (result.directives) {
          storeMemoryCache(
            createRequestKey(promptText),
            result.directives,
          );

          lastSuccessfulDirectives =
            result.directives;
        }

        return result;
      }

      /* ------------------------------------------------------------------ */
      /* ERROR BODY                                                         */
      /* ------------------------------------------------------------------ */

      const errBody =
        await safeReadResponseText(response);

      const retryable =
        RETRYABLE_STATUS_CODES.has(
          response.status,
        );

      lastError =
        createHttpErrorMessage(
          response.status,
          response.statusText,
          errBody,
        );

      /* ------------------------------------------------------------------ */
      /* NON-RETRYABLE ERROR                                                */
      /* ------------------------------------------------------------------ */

      if (!retryable) {
        console.warn(
          `[Conductor] Gemini request failed: ${lastError}`,
        );

        return createFallbackResult(
          lastError,
        );
      }

      /* ------------------------------------------------------------------ */
      /* 429 CIRCUIT BREAKER                                                */
      /* ------------------------------------------------------------------ */

      if (response.status === 429) {
        /*
         * A 429 is stronger evidence of rate limiting than a generic 5xx.
         *
         * We therefore close the circuit immediately instead of allowing
         * several components to continue sending requests.
         */
        const retryAfterMs =
          parseRetryAfter(
            response.headers.get(
              'Retry-After',
            ),
          );

        const cooldownMs =
          Math.max(
            RATE_LIMIT_COOLDOWN_MS,
            retryAfterMs ?? 0,
          );

        rateLimitBlockedUntil =
          Date.now() + cooldownMs;

        console.warn(
          `[Conductor] Gemini 429. ` +
          `Conductor cooldown: ${cooldownMs}ms.`,
        );

        /*
         * IMPORTANT:
         *
         * Do not immediately execute the normal retry loop after 429.
         * The old implementation did exactly that and could amplify
         * the rate-limit problem.
         */
        return createFallbackResult(
          createTemporaryFailureMessage(
            429,
          ),
        );
      }

      /* ------------------------------------------------------------------ */
      /* RETRY EXHAUSTED                                                    */
      /* ------------------------------------------------------------------ */

      if (attempt >= MAX_RETRIES) {
        temporaryErrorBlockedUntil =
          Date.now() +
          TEMPORARY_ERROR_COOLDOWN_MS;

        console.warn(
          `[Conductor] Gemini temporary error persisted after ` +
          `${attempt + 1} attempt(s): ${lastError}`,
        );

        return createFallbackResult(
          createTemporaryFailureMessage(
            response.status,
          ),
        );
      }

      /* ------------------------------------------------------------------ */
      /* RETRY WAIT                                                         */
      /* ------------------------------------------------------------------ */

      const retryAfterMs =
        parseRetryAfter(
          response.headers.get(
            'Retry-After',
          ),
        );

      const backoffMs =
        Math.max(
          MIN_REQUEST_INTERVAL_MS,
          retryAfterMs ??
            calculateBackoff(attempt),
        );

      console.warn(
        `[Conductor] Gemini ${response.status}. ` +
        `Retry ${attempt + 1}/${MAX_RETRIES} ` +
        `in ${backoffMs}ms.`,
      );

      await sleep(backoffMs);
    } catch (err) {
      /* ------------------------------------------------------------------ */
      /* NETWORK / TIMEOUT ERROR                                            */
      /* ------------------------------------------------------------------ */

      lastError =
        `Hálózati hiba: ${
          err instanceof Error
            ? err.message
            : String(err)
        }`;

      if (attempt < MAX_RETRIES) {
        const backoffMs =
          Math.max(
            MIN_REQUEST_INTERVAL_MS,
            calculateBackoff(attempt),
          );

        console.warn(
          `[Conductor] Gemini hálózati hiba. ` +
          `Retry ${attempt + 1}/${MAX_RETRIES} ` +
          `in ${backoffMs}ms.`,
        );

        await sleep(backoffMs);

        continue;
      }

      temporaryErrorBlockedUntil =
        Date.now() +
        TEMPORARY_ERROR_COOLDOWN_MS;

      console.warn(
        '[Conductor] Gemini request failed:',
        lastError,
      );

      return createFallbackResult(
        lastError,
      );
    }
  }

  return createFallbackResult(
    lastError,
  );
}

/* -------------------------------------------------------------------------- */
/* RESPONSE PARSING                                                           */
/* -------------------------------------------------------------------------- */

/**
 * Converts a successful Gemini HTTP response into validated
 * ConductorDirectives.
 */
async function parseGeminiResponse(
  response: Response,
): Promise<ConductorResult> {
  try {
    const data =
      await response.json();

    const text =
      data?.candidates?.[0]
        ?.content?.parts?.[0]?.text;

    if (!text) {
      const blockReason =
        data?.promptFeedback?.blockReason;

      const finishReason =
        data?.candidates?.[0]
          ?.finishReason;

      const msg = blockReason
        ? `Gemini válasz blokkolva: ${blockReason}`
        : finishReason
          ? `Gemini válasz nem készült el: ${finishReason}`
          : 'Gemini válasz üres.';

      console.warn(
        `[Conductor] ${msg}`,
      );

      return {
        directives: null,
        error: msg,
      };
    }

    let parsed: unknown;

    try {
      parsed = JSON.parse(text);
    } catch {
      console.warn(
        '[Conductor] Gemini érvénytelen JSON választ adott.',
      );

      return {
        directives: null,
        error:
          'Gemini érvénytelen JSON választ adott.',
      };
    }

    const validated =
      validateDirectives(parsed);

    if (!validated) {
      console.warn(
        '[Conductor] Gemini válasz séma érvénytelen.',
        parsed,
      );

      return {
        directives: null,
        error:
          'Gemini válasz séma érvénytelen.',
      };
    }

    return {
      directives: validated,
      error: null,
    };
  } catch (err) {
    const msg =
      `Gemini válasz feldolgozási hiba: ${
        err instanceof Error
          ? err.message
          : String(err)
      }`;

    console.warn(
      '[Conductor] Response parsing failed:',
      err,
    );

    return {
      directives: null,
      error: msg,
    };
  }
}

/* -------------------------------------------------------------------------- */
/* VALIDATION                                                                 */
/* -------------------------------------------------------------------------- */

function validateDirectives(
  value: unknown,
): ConductorDirectives | null {
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value)
  ) {
    return null;
  }

  const obj =
    value as Record<string, unknown>;

  if (!Array.isArray(obj.leagues)) {
    return null;
  }

  if (
    !obj.strategy ||
    typeof obj.strategy !== 'object' ||
    Array.isArray(obj.strategy)
  ) {
    return null;
  }

  if (!Array.isArray(obj.proposals)) {
    return null;
  }

  if (
    typeof obj.timestamp !== 'string'
  ) {
    return null;
  }

  const strategy =
    obj.strategy as Record<
      string,
      unknown
    >;

  if (
    typeof strategy.vetoModeActive !==
      'boolean' ||
    typeof strategy.allowVolatileSecondary !==
      'boolean' ||
    !Array.isArray(
      strategy.recommendedMarkets,
    ) ||
    typeof strategy.tacticalSummary !==
      'string'
  ) {
    return null;
  }

  if (
    strategy.recommendedMarkets.some(
      (market) =>
        typeof market !== 'string',
    )
  ) {
    return null;
  }

  for (const league of obj.leagues) {
    if (
      !league ||
      typeof league !== 'object' ||
      Array.isArray(league)
    ) {
      return null;
    }

    const item =
      league as Record<string, unknown>;

    if (
      item.league !== 'angol' &&
      item.league !== 'spanyol'
    ) {
      return null;
    }

    if (
      item.status !== 'GREEN' &&
      item.status !== 'YELLOW' &&
      item.status !== 'RED'
    ) {
      return null;
    }

    if (
      typeof item.bttsDriftPct !==
        'number' ||
      !Number.isFinite(
        item.bttsDriftPct,
      )
    ) {
      return null;
    }

    if (
      typeof item.suppressCore1 !==
      'boolean'
    ) {
      return null;
    }

    if (
      item.warningNotice !== null &&
      typeof item.warningNotice !==
        'string'
    ) {
      return null;
    }
  }

  for (const proposal of obj.proposals) {
    if (
      !proposal ||
      typeof proposal !== 'object' ||
      Array.isArray(proposal)
    ) {
      return null;
    }

    const item =
      proposal as Record<string, unknown>;

    if (
      item.league !== 'angol' &&
      item.league !== 'spanyol'
    ) {
      return null;
    }

    if (
      typeof item.teamKey !== 'string' ||
      typeof item.metric !== 'string' ||
      typeof item.currentValue !==
        'number' ||
      !Number.isFinite(
        item.currentValue,
      ) ||
      typeof item.proposedValue !==
        'number' ||
      !Number.isFinite(
        item.proposedValue,
      ) ||
      typeof item.reason !== 'string'
    ) {
      return null;
    }
  }

  /**
   * The Conductor contract explicitly allows maximum 3 proposals.
   */
  if (obj.proposals.length > 3) {
    return null;
  }

  return value as ConductorDirectives;
}

/* -------------------------------------------------------------------------- */
/* MEMORY CACHE                                                               */
/* -------------------------------------------------------------------------- */

function readMemoryCache(
  key: string,
): ConductorDirectives | null {
  const index =
    memoryCache.findIndex(
      (entry) => entry.key === key,
    );

  if (index === -1) {
    return null;
  }

  const entry =
    memoryCache[index];

  if (
    Date.now() - entry.createdAt >
    MEMORY_CACHE_TTL_MS
  ) {
    memoryCache.splice(index, 1);
    return null;
  }

  /*
   * Move the entry to the front.
   * This gives us a tiny LRU-style cache.
   */
  memoryCache.splice(index, 1);
  memoryCache.unshift(entry);

  return entry.directives;
}

function storeMemoryCache(
  key: string,
  directives: ConductorDirectives,
): void {
  const existingIndex =
    memoryCache.findIndex(
      (entry) => entry.key === key,
    );

  if (existingIndex !== -1) {
    memoryCache.splice(
      existingIndex,
      1,
    );
  }

  memoryCache.unshift({
    key,
    directives,
    createdAt: Date.now(),
  });

  if (
    memoryCache.length >
    MEMORY_CACHE_MAX_ENTRIES
  ) {
    memoryCache.length =
      MEMORY_CACHE_MAX_ENTRIES;
  }
}

/* -------------------------------------------------------------------------- */
/* REQUEST KEY                                                                */
/* -------------------------------------------------------------------------- */

/**
 * Stable lightweight hash.
 *
 * We do not use crypto.subtle here because the request gate must work
 * synchronously before the request starts and without requiring an async
 * hash operation.
 */
function createRequestKey(
  value: string,
): string {
  let hash = 2166136261;

  for (
    let index = 0;
    index < value.length;
    index += 1
  ) {
    hash ^=
      value.charCodeAt(index);

    hash +=
      (hash << 1) +
      (hash << 4) +
      (hash << 7) +
      (hash << 8) +
      (hash << 24);
  }

  return (
    (hash >>> 0).toString(16) +
    `:${value.length}`
  );
}

/* -------------------------------------------------------------------------- */
/* FETCH TIMEOUT                                                              */
/* -------------------------------------------------------------------------- */

async function fetchWithTimeout(
  input: RequestInfo | URL,
  init: RequestInit,
  timeoutMs: number,
): Promise<Response> {
  const controller =
    new AbortController();

  const timeoutId =
    window.setTimeout(
      () => controller.abort(),
      timeoutMs,
    );

  try {
    return await fetch(
      input,
      {
        ...init,
        signal: controller.signal,
      },
    );
  } catch (error) {
    if (
      error instanceof DOMException &&
      error.name === 'AbortError'
    ) {
      throw new Error(
        `A Gemini kérés időtúllépés miatt megszakadt (${Math.round(
          timeoutMs / 1000,
        )} mp).`,
      );
    }

    throw error;
  } finally {
    window.clearTimeout(timeoutId);
  }
}

/* -------------------------------------------------------------------------- */
/* RETRY HELPERS                                                              */
/* -------------------------------------------------------------------------- */

function calculateBackoff(
  attempt: number,
): number {
  const exponential =
    RETRY_BASE_DELAY_MS *
    Math.pow(2, attempt);

  const jitter =
    Math.floor(
      Math.random() * 400,
    );

  return exponential + jitter;
}

function parseRetryAfter(
  value: string | null,
): number | null {
  if (!value) {
    return null;
  }

  const seconds =
    Number(value);

  if (
    Number.isFinite(seconds) &&
    seconds >= 0
  ) {
    return Math.min(
      seconds * 1000,
      MAX_RETRY_AFTER_MS,
    );
  }

  const dateMs =
    Date.parse(value);

  if (!Number.isNaN(dateMs)) {
    const delay =
      Math.max(
        0,
        dateMs - Date.now(),
      );

    return Math.min(
      delay,
      MAX_RETRY_AFTER_MS,
    );
  }

  return null;
}

function sleep(
  ms: number,
): Promise<void> {
  return new Promise(
    (resolve) => {
      window.setTimeout(
        resolve,
        ms,
      );
    },
  );
}

/* -------------------------------------------------------------------------- */
/* ERROR HELPERS                                                              */
/* -------------------------------------------------------------------------- */

async function safeReadResponseText(
  response: Response,
): Promise<string> {
  try {
    return await response.text();
  } catch {
    return '';
  }
}

function createHttpErrorMessage(
  status: number,
  statusText: string,
  body: string,
): string {
  let apiMessage = '';

  if (body) {
    try {
      const parsed =
        JSON.parse(body);

      if (
        typeof parsed?.error
          ?.message === 'string'
      ) {
        apiMessage =
          parsed.error.message;
      }
    } catch {
      /*
       * Ignore malformed error bodies.
       */
    }
  }

  if (status === 408) {
    return (
      'Gemini API 408: a kérés időtúllépés miatt nem készült el.'
    );
  }

  if (status === 429) {
    return (
      'Gemini API 429: túl sok kérés érkezett. ' +
      'A Conductor átmeneti rate-limit védelembe lépett.'
    );
  }

  if (status === 503) {
    return (
      'Gemini API 503: a modell átmenetileg túlterhelt ' +
      'vagy nem érhető el.'
    );
  }

  return (
    `Gemini API ${status}: ` +
    `${
      apiMessage ||
      statusText ||
      'ismeretlen hiba'
    }`
  );
}

function createTemporaryFailureMessage(
  status: number,
): string {
  if (status === 429) {
    return (
      'A Gemini Conductor kéréslimitbe ütközött (429). ' +
      'A Conductor átmenetileg szünetel, hogy ne terhelje tovább az API-t.'
    );
  }

  if (status === 503) {
    return (
      'A Gemini Conductor jelenleg átmenetileg nem érhető el ' +
      '(503). A WinMix az utolsó érvényes direktívákkal vagy ' +
      'alapértelmezett módban folytatható.'
    );
  }

  return (
    `A Gemini Conductor átmeneti szolgáltatási hibát adott ` +
    `(${status}). A WinMix fallback módban folytatható.`
  );
}

/* -------------------------------------------------------------------------- */
/* FALLBACK                                                                   */
/* -------------------------------------------------------------------------- */

/**
 * Prefer the last known-good directives.
 *
 * This is important for a monitoring/oversight service:
 * a temporary Gemini outage should not unnecessarily erase the last
 * valid Conductor state from the UI.
 */
function createFallbackResult(
  error: string,
): ConductorResult {
  if (lastSuccessfulDirectives) {
    return {
      directives:
        lastSuccessfulDirectives,
      error,
    };
  }

  return {
    directives:
      defaultDirectives(),
    error,
  };
}

/* -------------------------------------------------------------------------- */
/* EXPORTS                                                                    */
/* -------------------------------------------------------------------------- */

export { defaultDirectives };