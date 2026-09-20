import { useCallback, useEffect, useRef, useState } from 'react';
import { Lock, LockOpen, LockKeyhole, Check, Clock, Delete, Key, ArrowLeft } from 'lucide-react';

const PIN_LENGTH = 4;
const MAX_ATTEMPTS = 3;
const LOCKOUT_SECONDS = 5;
const STORAGE_KEY = 'winmix_cloud_pin';
const DEFAULT_PIN = '1234';

type Screen = 'lock' | 'change' | 'panel';
type IconStatus = 'normal' | 'success' | 'error' | 'warning';

function loadPin(): string {
  try {
    return sessionStorage.getItem(STORAGE_KEY) ?? DEFAULT_PIN;
  } catch {
    return DEFAULT_PIN;
  }
}

function savePin(pin: string): void {
  try {
    sessionStorage.setItem(STORAGE_KEY, pin);
  } catch {
    /* ignore */
  }
}

function Dot({ filled, status }: { filled: boolean; status: IconStatus }) {
  return (
    <span
      className={`pin-dot ${
        status === 'success' ? 'pin-dot--success' :
        status === 'error' ? 'pin-dot--error' :
        filled ? 'pin-dot--filled' : ''
      }`}
      aria-hidden="true"
    />
  );
}

function Numpad({
  onKey,
  onDelete,
  disabled,
  prefix
}: {
  onKey: (k: string) => void;
  onDelete: () => void;
  disabled: boolean;
  prefix: 'lock' | 'new';
}) {
  return (
    <div className="pin-numpad" role="group" aria-label="Jelkód numerikus billentyűzet">
      {[1, 2, 3, 4, 5, 6, 7, 8, 9].map((n) => (
        <button
          key={n}
          type="button"
          className={`pin-key ${disabled ? 'pin-key--locked' : ''}`}
          disabled={disabled}
          aria-label={String(n)}
          onClick={() => onKey(String(n))}
        >
          {n}
        </button>
      ))}
      <span className="pin-key pin-key--empty" aria-hidden="true" />
      <button
        type="button"
        className={`pin-key pin-key--del ${disabled ? 'pin-key--locked' : ''}`}
        disabled={disabled}
        aria-label="Utolsó számjegy törlése"
        onClick={onDelete}
      >
        <Delete size={20} aria-hidden="true" />
      </button>
      <button
        type="button"
        className={`pin-key ${disabled ? 'pin-key--locked' : ''}`}
        disabled={disabled}
        aria-label="0"
        onClick={() => onKey('0')}
      >
        0
      </button>
    </div>
  );
}

export function PinGate({ children }: { children: React.ReactNode }) {
  const [screen, setScreen] = useState<Screen>('lock');
  const [pin, setPin] = useState<string>(loadPin);
  const [lockInput, setLockInput] = useState('');
  const [lockStatus, setLockStatus] = useState<IconStatus>('normal');
  const [lockTitle, setLockTitle] = useState('Jelkód megadása');
  const [lockSub, setLockSub] = useState('Add meg a 4 jegyű kódot a belépéshez');
  const [failedAttempts, setFailedAttempts] = useState(0);
  const [lockedOut, setLockedOut] = useState(false);
  const [lockoutRemaining, setLockoutRemaining] = useState(0);

  const [newPinInput, setNewPinInput] = useState('');
  const [newPinFirst, setNewPinFirst] = useState('');
  const [changeStep, setChangeStep] = useState(1);
  const [changeStatus, setChangeStatus] = useState<IconStatus>('normal');
  const [changeTitle, setChangeTitle] = useState('Új jelkód');
  const [changeSub, setChangeSub] = useState('Add meg az új 4 jegyű kódot');
  const [shakeTarget, setShakeTarget] = useState<'lock' | 'change' | null>(null);

  const lockoutTimer = useRef<ReturnType<typeof setInterval> | null>(null);
  const shakeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const transitionTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const triggerShake = useCallback((target: 'lock' | 'change') => {
    setShakeTarget(target);
    if (shakeTimer.current) clearTimeout(shakeTimer.current);
    shakeTimer.current = setTimeout(() => setShakeTarget(null), 500);
  }, []);

  const resetLockScreen = useCallback((msg?: string) => {
    setLockInput('');
    setFailedAttempts(0);
    setLockStatus('normal');
    setLockTitle('Jelkód megadása');
    setLockSub(msg ?? 'Add meg a 4 jegyű kódot a belépéshez');
  }, []);

  const clearTimers = useCallback(() => {
    if (lockoutTimer.current) {
      clearInterval(lockoutTimer.current);
      lockoutTimer.current = null;
    }
    if (transitionTimer.current) {
      clearTimeout(transitionTimer.current);
      transitionTimer.current = null;
    }
  }, []);

  const checkPin = useCallback(() => {
    setLockInput((current) => {
      if (current !== pin) {
        setFailedAttempts((prev) => {
          const next = prev + 1;
          setLockStatus('error');
          triggerShake('lock');
          const remaining = MAX_ATTEMPTS - next;
          if (remaining <= 0) {
            setLockedOut(true);
            setLockStatus('warning');
            setLockTitle('Ideiglenesen zárolva');
            setLockSub('');
            let secs = LOCKOUT_SECONDS;
            setLockoutRemaining(secs);
            lockoutTimer.current = setInterval(() => {
              secs -= 1;
              setLockoutRemaining(secs);
              if (secs <= 0) {
                if (lockoutTimer.current) {
                  clearInterval(lockoutTimer.current);
                  lockoutTimer.current = null;
                }
                setLockedOut(false);
                setLockoutRemaining(0);
                resetLockScreen('A zárolás feloldva. Add meg a 4 jegyű kódot.');
              }
            }, 1000);
            return 0;
          }
          setLockSub(
            remaining === 1
              ? 'Még 1 próbálkozás maradt.'
              : `Még ${remaining} próbálkozás maradt.`
          );
          transitionTimer.current = setTimeout(() => {
            setLockInput('');
            setLockStatus('normal');
          }, 600);
          return next;
        });
        return current;
      }

      setLockStatus('success');
      setLockTitle('Üdvözlet!');
      setLockSub('Belépés a konfigurációs panelre…');
      transitionTimer.current = setTimeout(() => {
        setScreen('panel');
        resetLockScreen();
      }, 500);
      return current;
    });
  }, [pin, resetLockScreen, triggerShake]);

  const enterLockKey = useCallback((key: string) => {
    if (lockedOut) return;
    setLockInput((prev) => {
      if (prev.length >= PIN_LENGTH) return prev;
      const next = prev + key;
      if (next.length === PIN_LENGTH) {
        setTimeout(() => {
          setLockInput((cur) => {
            if (cur === next) checkPin();
            return cur;
          });
        }, 150);
      }
      return next;
    });
  }, [lockedOut, checkPin]);

  const deleteLockKey = useCallback(() => {
    if (lockedOut) return;
    setLockInput((prev) => prev.slice(0, -1));
  }, [lockedOut]);

  const lockPanel = useCallback(() => {
    clearTimers();
    setLockedOut(false);
    resetLockScreen();
    setScreen('lock');
  }, [clearTimers, resetLockScreen]);

  // Change PIN
  const showChangePin = useCallback(() => {
    if (screen !== 'panel') return;
    setNewPinInput('');
    setNewPinFirst('');
    setChangeStep(1);
    setChangeStatus('normal');
    setChangeTitle('Új jelkód');
    setChangeSub('Add meg az új 4 jegyű kódot');
    setScreen('change');
  }, [screen]);

  const processNewPinStep = useCallback(() => {
    if (changeStep === 1) {
      setNewPinFirst(newPinInput);
      setNewPinInput('');
      setChangeStep(2);
      setChangeStatus('normal');
      setChangeTitle('Megerősítés');
      setChangeSub('Írd be újra az új jelkódot');
      return;
    }

    if (changeStep !== 2) return;

    if (newPinInput === newPinFirst) {
      const confirmed = newPinInput;
      setPin(confirmed);
      savePin(confirmed);
      setChangeStatus('success');
      setChangeTitle('Jelkód módosítva');
      setChangeSub('Az új jelkód aktív.');
      setChangeStep(3);
      transitionTimer.current = setTimeout(() => {
        setScreen('panel');
      }, 900);
      return;
    }

    setChangeStatus('error');
    triggerShake('change');
    setChangeSub('A két kód nem egyezik. Próbáld újra.');
    setTimeout(() => {
      setNewPinInput('');
      setNewPinFirst('');
      setChangeStep(1);
      setChangeStatus('normal');
      setChangeTitle('Új jelkód');
      setChangeSub('Add meg az új 4 jegyű kódot');
    }, 800);
  }, [changeStep, newPinInput, newPinFirst, triggerShake]);

  const enterNewPinKey = useCallback((key: string) => {
    setNewPinInput((prev) => {
      if (prev.length >= PIN_LENGTH) return prev;
      const next = prev + key;
      if (next.length === PIN_LENGTH) {
        setTimeout(() => {
          setNewPinInput((cur) => {
            if (cur === next) processNewPinStep();
            return cur;
          });
        }, 150);
      }
      return next;
    });
  }, [processNewPinStep]);

  const deleteNewPinKey = useCallback(() => {
    setNewPinInput((prev) => prev.slice(0, -1));
  }, []);

  const cancelChangePin = useCallback(() => {
    setNewPinInput('');
    setNewPinFirst('');
    setChangeStep(1);
    setScreen('panel');
  }, []);

  // Keyboard support
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      const el = document.activeElement;
      const typing = el && ['INPUT', 'TEXTAREA'].includes(el.tagName);
      if (typing) return;

      if (screen === 'lock') {
        if (/^[0-9]$/.test(e.key)) {
          e.preventDefault();
          enterLockKey(e.key);
        } else if (e.key === 'Backspace') {
          e.preventDefault();
          deleteLockKey();
        }
      } else if (screen === 'change') {
        if (/^[0-9]$/.test(e.key)) {
          e.preventDefault();
          enterNewPinKey(e.key);
        } else if (e.key === 'Backspace') {
          e.preventDefault();
          deleteNewPinKey();
        } else if (e.key === 'Escape') {
          e.preventDefault();
          cancelChangePin();
        }
      } else if (screen === 'panel') {
        if (e.key === 'Escape') {
          e.preventDefault();
          lockPanel();
        }
      }
    };
    document.addEventListener('keydown', handler);
    return () => document.removeEventListener('keydown', handler);
  }, [screen, enterLockKey, deleteLockKey, enterNewPinKey, deleteNewPinKey, cancelChangePin, lockPanel]);

  useEffect(() => () => clearTimers(), [clearTimers]);

  const LockIcon = lockStatus === 'success' ? LockOpen : Lock;
  const ChangeIcon = changeStep === 3 ? Check : changeStep === 2 ? LockKeyhole : LockKeyhole;

  if (screen === 'panel') {
    return (
      <div className="pin-panel-wrapper">
        <div className="pin-panel-topbar">
          <div className="flex items-center gap-2 min-w-0">
            <Lock size={14} className="text-signal shrink-0" aria-hidden="true" />
            <span className="text-ui-sm font-medium tracking-tight text-foreground truncate">
              Felhő tier feloldva
            </span>
          </div>
          <div className="flex items-center gap-1.5">
            <button
              type="button"
              className="btn btn--ghost btn--sm tap gap-1"
              onClick={showChangePin}
            >
              <Key size={12} aria-hidden="true" />
              Jelkód módosítása
            </button>
            <button
              type="button"
              className="btn btn--outline btn--sm tap gap-1"
              onClick={lockPanel}
              aria-label="Panel zárolása"
            >
              <Lock size={12} aria-hidden="true" />
              Zárolás
            </button>
          </div>
        </div>
        {children}
      </div>
    );
  }

  if (screen === 'change') {
    return (
      <div className="pin-screen" role="dialog" aria-label="Jelkód módosítása">
        <div className="pin-step-indicator" aria-label={`Jelkód módosítása: ${changeStep}. lépés a 2-ből`}>
          <span className={`pin-step-dot ${changeStep > 1 ? 'pin-step-dot--done' : 'pin-step-dot--active'}`} aria-hidden="true" />
          <span className={`pin-step-dot ${changeStep === 2 ? 'pin-step-dot--active' : changeStep > 2 ? 'pin-step-dot--done' : ''}`} aria-hidden="true" />
        </div>

        <div className={`pin-icon-wrap pin-icon-wrap--${changeStatus === 'success' ? 'success' : changeStatus === 'error' ? 'error' : 'normal'}`}>
          <ChangeIcon size={24} aria-hidden="true" />
        </div>

        <h1 className="pin-title">{changeTitle}</h1>
        <p className="pin-sub">{changeSub}</p>

        <div
          className={`pin-dots ${shakeTarget === 'change' ? 'pin-dots--shake' : ''}`}
          role="status"
          aria-live="polite"
          aria-atomic="true"
          aria-label={`Új jelkód állapota: ${newPinInput.length} / ${PIN_LENGTH} számjegy megadva.`}
        >
          {Array.from({ length: PIN_LENGTH }).map((_, i) => (
            <Dot key={i} filled={i < newPinInput.length} status={changeStatus} />
          ))}
        </div>

        <Numpad onKey={enterNewPinKey} onDelete={deleteNewPinKey} disabled={false} prefix="new" />

        <button type="button" className="pin-footer-btn" onClick={cancelChangePin}>
          <ArrowLeft size={14} aria-hidden="true" />
          <span>Vissza a panelhez</span>
        </button>
      </div>
    );
  }

  // Lock screen
  return (
    <div className="pin-screen" role="dialog" aria-label="Jelkód megadása">
      <div className={`pin-icon-wrap pin-icon-wrap--${lockStatus}`}>
        {lockStatus === 'warning' ? <Clock size={24} aria-hidden="true" /> : <LockIcon size={24} aria-hidden="true" />}
      </div>

      <h1 className="pin-title">{lockTitle}</h1>
      <p className="pin-sub">{lockSub}</p>

      <div
        className={`pin-dots ${shakeTarget === 'lock' ? 'pin-dots--shake' : ''}`}
        role="status"
        aria-live="polite"
        aria-atomic="true"
        aria-label={`Jelkód állapota: ${lockInput.length} / ${PIN_LENGTH} számjegy megadva.`}
      >
        {Array.from({ length: PIN_LENGTH }).map((_, i) => (
          <Dot key={i} filled={i < lockInput.length} status={lockStatus} />
        ))}
      </div>

      <Numpad onKey={enterLockKey} onDelete={deleteLockKey} disabled={lockedOut} prefix="lock" />

      <div className="pin-lockout-wrap" role="status" aria-live="assertive" aria-atomic="true">
        {lockedOut && (
          <>
            <div className="pin-lockout-bar">
              <div
                className="pin-lockout-fill"
                style={{ width: `${Math.max((lockoutRemaining / LOCKOUT_SECONDS) * 100, 0)}%` }}
              />
            </div>
            <p className="pin-lockout-text">
              {lockoutRemaining > 0 ? `Várj ${lockoutRemaining} másodpercet…` : 'A zárolás feloldva.'}
            </p>
          </>
        )}
      </div>

      <button type="button" className="pin-footer-btn" onClick={showChangePin} disabled={lockedOut}>
        <Key size={14} aria-hidden="true" />
        <span>Jelkód módosítása</span>
      </button>
    </div>
  );
}
