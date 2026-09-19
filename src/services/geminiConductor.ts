import type { ConductorDirectives } from '../types/conductor';
import { defaultDirectives } from '../types/conductor';
import { payloadToPromptText, type ConductorPayload } from '../utils/conductorContext';

// Prioritási sorrend: ha az elsődleges 503-at dob, azonnal átvált a tartalék modellekre
const FALLBACK_MODELS = [
  'gemini-3.6-flash',
  'gemini-3.5-flash',
  'gemini-3.5-flash-lite',
];

const BASE_ENDPOINT = 'https://generativelanguage.googleapis.com/v1beta/models';

/**
 * OpenAPI-style schema enforced server-side by Gemini. Guarantees every field
 * is present and correctly typed — no missing `bttsDriftPct` or misspelled status.
 */
const RESPONSE_SCHEMA = {
  type: 'object',
  properties: {
    timestamp: { type: 'string' },
    leagues: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          league: { type: 'string', enum: ['angol', 'spanyol'] },
          status: { type: 'string', enum: ['GREEN', 'YELLOW', 'RED'] },
          bttsDriftPct: { type: 'number' },
          suppressCore1: { type: 'boolean' },
          warningNotice: { type: 'string', nullable: true },
        },
        required: ['league', 'status', 'bttsDriftPct', 'suppressCore1', 'warningNotice'],
      },
    },
    strategy: {
      type: 'object',
      properties: {
        vetoModeActive: { type: 'boolean' },
        allowVolatileSecondary: { type: 'boolean' },
        recommendedMarkets: { type: 'array', items: { type: 'string' } },
        tacticalSummary: { type: 'string' },
      },
      required: ['vetoModeActive', 'allowVolatileSecondary', 'recommendedMarkets', 'tacticalSummary'],
    },
    proposals: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          league: { type: 'string', enum: ['angol', 'spanyol'] },
          teamKey: { type: 'string' },
          metric: { type: 'string' },
          currentValue: { type: 'number' },
          proposedValue: { type: 'number' },
          reason: { type: 'string' },
        },
        required: ['league', 'teamKey', 'metric', 'currentValue', 'proposedValue', 'reason'],
      },
    },
  },
  required: ['timestamp', 'leagues', 'strategy', 'proposals'],
};

const SYSTEM_PROMPT = `Te vagy a WinMix Conductor, egy felügyeleti AI a WinMix futballpredikciós rendszerhez.
A feladatod NEM a közvetlen tippelés, hanem a matematikai motor felügyelete strukturált direktívák formájában.

Három feladatod van:
1. Liga BTTS drift értékelése: hasonlítsd össze a megfigyelt BTTS arányt az átlagos predikcióval.
   - GREEN: drift < 5 százalékpont
   - YELLOW: drift 5-15 százalékpont
   - RED: drift > 15 százalékpont
   A suppressCore1 true, ha RED és a drift negatív (túl sok BTTS nem jött be).
2. Vétó mód meghatározása: vetoModeActive true, ha bármelyik liga RED státuszú,
   vagy a szelvények nyerési rátája 40% alatt van legalább 10 lezárt szelvény esetén.
3. Csapatsúly-eltérés vizsgálata: a kiugró csapatsúlyok és piaci visszajelzés alapján
   javasolj súlykorrekciót, ha indokolt. Maximum 3 javaslat.

A válasz MINDIG magyar nyelvű tacticalSummary-t tartalmazzon (max 2 mondat).
Csak a megadott JSON sémának megfelelő választ add.`;

export interface ConductorResult {
  directives: ConductorDirectives | null;
  error: string | null;
}

/**
 * Fetches conductor directives from Gemini with automatic fallback on 503/429/404 errors.
 */
export async function fetchConductorDirectives(
  payload: ConductorPayload
): Promise<ConductorResult> {
  const apiKey = import.meta.env.VITE_GEMINI_API_KEY;
  if (!apiKey) {
    return { directives: null, error: 'Nincs beállítva API kulcs (VITE_GEMINI_API_KEY).' };
  }

  const promptText = payloadToPromptText(payload);
  const body = {
    contents: [
      {
        role: 'user',
        parts: [{ text: `${SYSTEM_PROMPT}\n\nADATOK:\n${promptText}` }],
      },
    ],
    generationConfig: {
      temperature: 0.1,
      responseMimeType: 'application/json',
      responseSchema: RESPONSE_SCHEMA,
    },
  };

  let lastError = 'Ismeretlen hiba';

  // Végigpróbálja a modelleket, ha túlterheltség (503) vagy kvótahiba (429) történik
  for (const model of FALLBACK_MODELS) {
    try {
      const endpoint = `${BASE_ENDPOINT}/${model}:generateContent?key=${apiKey}`;
      const response = await fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });

      if (!response.ok) {
        const errBody = await response.text().catch(() => '');
        lastError = `[${model}] HTTP ${response.status}: ${errBody.slice(0, 150) || response.statusText}`;
        console.warn(`[Conductor] ${lastError} — Tartalék modell keresése...`);
        // Ha 503 vagy 429 vagy 404, ugorjon a következő modellre a listában
        if (response.status === 503 || response.status === 429 || response.status === 404) {
          continue;
        }
        return { directives: null, error: lastError };
      }

      const data = await response.json();
      const text = data?.candidates?.[0]?.content?.parts?.[0]?.text;
      if (!text) {
        const blockReason = data?.promptFeedback?.blockReason;
        const msg = blockReason
          ? `Gemini válasz blokkolva: ${blockReason}`
          : 'Gemini válasz üres.';
        console.warn(`[Conductor] ${msg}`);
        return { directives: null, error: msg };
      }

      const parsed = JSON.parse(text) as ConductorDirectives;
      const validated = validateDirectives(parsed);
      if (!validated) {
        return { directives: null, error: 'Gemini válasz séma érvénytelen.' };
      }

      // Sikeres hívás
      return { directives: validated, error: null };
    } catch (err) {
      lastError = `Hálózati hiba (${model}): ${err instanceof Error ? err.message : String(err)}`;
      console.warn('[Conductor] Hálózati hiba, váltás a következőre:', err);
    }
  }

  return { directives: null, error: `Minden modell túlterhelt vagy elérhetetlen: ${lastError}` };
}

function validateDirectives(d: unknown): ConductorDirectives | null {
  if (!d || typeof d !== 'object') return null;
  const obj = d as Record<string, unknown>;
  if (!Array.isArray(obj.leagues) || !obj.strategy || !Array.isArray(obj.proposals)) {
    return null;
  }
  return d as ConductorDirectives;
}

export { defaultDirectives };