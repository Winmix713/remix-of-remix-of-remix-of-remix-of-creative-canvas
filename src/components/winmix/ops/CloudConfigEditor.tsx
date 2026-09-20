import { useState } from 'react';
import { Eye, EyeOff, Check, Settings2, AlertCircle, RotateCcw } from 'lucide-react';
import {
  readCloudEnv,
  readCloudOverride,
  readGeminiKeyOverride,
  writeCloudOverride,
  writeGeminiKeyOverride,
  type CloudOverride,
} from '../../../utils/cloudConfig';
import { Panel, PanelHeader, PanelTitle, PanelSubtitle } from '../Panel';

function isValidHttpUrl(value: string): boolean {
  if (!value) return false;
  try {
    const parsed = new URL(value);
    return parsed.protocol === 'https:' || parsed.protocol === 'http:';
  } catch {
    return false;
  }
}

export function CloudConfigEditor({ onSaved }: { onSaved?: () => void }) {
  const baseEnv = readCloudEnv();
  const override = readCloudOverride();
  const geminiOverride = readGeminiKeyOverride();

  const [supaUrl, setSupaUrl] = useState(override?.supabaseUrl ?? baseEnv?.url ?? '');
  const [supaKey, setSupaKey] = useState(override?.supabaseKey ?? baseEnv?.anonKey ?? '');
  const [geminiKey, setGeminiKey] = useState(
    geminiOverride ??
      ((import.meta as unknown as { env?: Record<string, string | undefined> }).env?.VITE_GEMINI_API_KEY ?? '')
  );

  const [showSupaKey, setShowSupaKey] = useState(false);
  const [showGeminiKey, setShowGeminiKey] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const hasOverride = override !== null;
  const hasGeminiOverride = geminiOverride !== null;

  const handleSave = () => {
    setError(null);
    const urlTrim = supaUrl.trim();
    const keyTrim = supaKey.trim();

    if (!urlTrim || !keyTrim) {
      setError('A Supabase URL és anon kulcs megadása kötelező.');
      return;
    }
    if (!isValidHttpUrl(urlTrim)) {
      setError('A Supabase URL formátuma érvénytelen (https://... szükséges).');
      return;
    }

    const newOverride: CloudOverride = { supabaseUrl: urlTrim, supabaseKey: keyTrim };
    writeCloudOverride(newOverride);
    writeGeminiKeyOverride(geminiKey.trim() || null);

    setSaved(true);
    setTimeout(() => setSaved(false), 2800);
    onSaved?.();
  };

  const handleReset = () => {
    writeCloudOverride(null);
    writeGeminiKeyOverride(null);
    setSupaUrl(baseEnv?.url ?? '');
    setSupaKey(baseEnv?.anonKey ?? '');
    setGeminiKey(
      (import.meta as unknown as { env?: Record<string, string | undefined> }).env?.VITE_GEMINI_API_KEY ?? ''
    );
    setError(null);
    setSaved(true);
    setTimeout(() => setSaved(false), 2800);
    onSaved?.();
  };

  return (
    <Panel>
      <PanelHeader>
        <div className="flex min-w-0 flex-col gap-0.5">
          <PanelTitle as="h3">
            <Settings2 className="h-3.5 w-3.5 text-signal" aria-hidden="true" />
            API kulcsok kezelése
          </PanelTitle>
          <PanelSubtitle>
            {hasOverride || hasGeminiOverride
              ? 'Webes felülírás aktív — a módosítások azonnal életbe lépnek'
              : 'Az értékek a .env-ből származnak — módosítás után webes felülírásként mentődnek'}
          </PanelSubtitle>
        </div>
        {(hasOverride || hasGeminiOverride) && (
          <button
            type="button"
            className="btn btn--ghost btn--sm tap gap-1"
            onClick={handleReset}
          >
            <RotateCcw className="h-3.5 w-3.5" aria-hidden="true" />
            Visszaállítás (.env)
          </button>
        )}
      </PanelHeader>

      {error && (
        <div className="flex items-center gap-2 border-b border-border px-3 py-2.5 text-ui-xs text-error sm:px-4">
          <AlertCircle className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
          {error}
        </div>
      )}

      {saved && (
        <div className="flex items-center gap-2 border-b border-border px-3 py-2.5 text-ui-xs text-signal sm:px-4">
          <Check className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
          Konfiguráció elmentve — a változtatások azonnal életbe lépnek.
        </div>
      )}

      <div className="flex flex-col gap-4 px-3 py-4 sm:px-4">
        {/* Supabase section */}
        <div className="flex flex-col gap-2">
          <p className="section-label" style={{ margin: 0 }}>Supabase</p>

          <div className="field-wrap relative flex items-center">
            <input
              type="url"
              className="field font-mono"
              style={{ paddingLeft: '0.75rem', paddingRight: '0.75rem' }}
              value={supaUrl}
              onChange={(e) => setSupaUrl(e.target.value)}
              placeholder="https://xxxx.supabase.co"
              autoComplete="off"
              spellcheck="false"
              aria-label="Supabase URL"
            />
          </div>

          <div className="field-wrap relative flex items-center">
            <input
              type={showSupaKey ? 'text' : 'password'}
              className="field font-mono pr-9"
              value={supaKey}
              onChange={(e) => setSupaKey(e.target.value)}
              placeholder="anon / publishable kulcs"
              autoComplete="off"
              spellcheck="false"
              aria-label="Supabase anon kulcs"
            />
            <button
              type="button"
              className="absolute right-2 flex h-7 w-7 items-center justify-center rounded text-muted-foreground transition hover:text-foreground"
              onClick={() => setShowSupaKey((v) => !v)}
              aria-label={showSupaKey ? 'Kulcs elrejtése' : 'Kulcs megjelenítése'}
              aria-pressed={showSupaKey}
            >
              {showSupaKey ? <EyeOff size={15} /> : <Eye size={15} />}
            </button>
          </div>
        </div>

        {/* Gemini section */}
        <div className="flex flex-col gap-2">
          <p className="section-label" style={{ margin: 0 }}>Gemini API</p>

          <div className="field-wrap relative flex items-center">
            <input
              type={showGeminiKey ? 'text' : 'password'}
              className="field font-mono pr-9"
              value={geminiKey}
              onChange={(e) => setGeminiKey(e.target.value)}
              placeholder="Gemini API key"
              autoComplete="off"
              spellcheck="false"
              aria-label="Gemini API kulcs"
            />
            <button
              type="button"
              className="absolute right-2 flex h-7 w-7 items-center justify-center rounded text-muted-foreground transition hover:text-foreground"
              onClick={() => setShowGeminiKey((v) => !v)}
              aria-label={showGeminiKey ? 'Kulcs elrejtése' : 'Kulcs megjelenítése'}
              aria-pressed={showGeminiKey}
            >
              {showGeminiKey ? <EyeOff size={15} /> : <Eye size={15} />}
            </button>
          </div>
        </div>

        {/* Save button */}
        <button
          type="button"
          className={`btn tap gap-1.5 ${saved ? 'btn--signal' : 'btn--outline'}`}
          onClick={handleSave}
        >
          <Check className="h-3.5 w-3.5" aria-hidden="true" />
          {saved ? 'Mentve' : 'Konfiguráció mentése'}
        </button>

        <p className="text-ui-xs leading-relaxed text-muted-foreground">
          A mentett értékek a böngésző helyi tárolójában tárolódik, és felülírják a
          build-time .env beállításokat. A „Visszaállítás” gomb törli a felülírást és
          visszaáll az eredeti .env konfigurációt.
        </p>
      </div>
    </Panel>
  );
}
