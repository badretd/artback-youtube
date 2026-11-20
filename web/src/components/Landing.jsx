import { useEffect, useRef, useState } from 'react';
import { api } from '../api.js';
import Brand from './Brand.jsx';
import { Icon } from './Icons.jsx';

function GoogleMark() {
  return (
    <svg width="18" height="18" viewBox="0 0 48 48" aria-hidden="true">
      <path fill="#FFC107" d="M43.6 20.5H42V20H24v8h11.3C33.7 32.7 29.3 36 24 36c-6.6 0-12-5.4-12-12s5.4-12 12-12c3.1 0 5.9 1.2 8 3.1l5.7-5.7C34.1 6.1 29.3 4 24 4 12.9 4 4 12.9 4 24s8.9 20 20 20 20-8.9 20-20c0-1.2-.1-2.4-.4-3.5z" />
      <path fill="#FF3D00" d="m6.3 14.7 6.6 4.8C14.7 15 19 12 24 12c3.1 0 5.9 1.2 8 3.1l5.7-5.7C34.1 6.1 29.3 4 24 4 16.3 4 9.7 8.3 6.3 14.7z" />
      <path fill="#4CAF50" d="M24 44c5.2 0 9.9-2 13.4-5.2l-6.2-5.2C29.2 35.1 26.7 36 24 36c-5.2 0-9.6-3.3-11.2-8l-6.5 5C9.6 39.6 16.3 44 24 44z" />
      <path fill="#1976D2" d="M43.6 20.5H42V20H24v8h11.3c-.8 2.2-2.2 4.1-4.1 5.5l6.2 5.2C36.9 39.2 44 34 44 24c0-1.2-.1-2.4-.4-3.5z" />
    </svg>
  );
}

export default function Landing({ config, authError, onAuth, onClearError }) {
  const [mode, setMode] = useState('login');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [slots, setSlots] = useState(() => ({
    total: config?.maxMembers ?? 100,
    taken: config?.taken ?? 0,
  }));
  const firstFieldRef = useRef(null);

  useEffect(() => {
    if (!config) return;
    setSlots({
      total: config.maxMembers ?? 100,
      taken: config.taken ?? 0,
    });
  }, [config]);

  // Keep the remaining-spots counter fresh while the visitor is on the page.
  useEffect(() => {
    let alive = true;
    const syncSlots = async () => {
      try {
        const next = await api.get('/api/config');
        if (!alive) return;
        setSlots({
          total: next?.maxMembers ?? 100,
          taken: next?.taken ?? 0,
        });
      } catch {
        // Keep the last known counter; the form itself is unaffected.
      }
    };
    const timer = setInterval(syncSlots, 45_000);
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, []);

  const total = Math.max(1, slots.total || 100);
  const taken = Math.max(0, Math.min(slots.taken || 0, total));
  const free = Math.max(0, total - taken);
  const full = free === 0;
  const progress = Math.min(100, Math.round((taken / total) * 100));

  const shownError = authError || error;

  useEffect(() => {
    if (full && mode === 'register') setMode('login');
  }, [full, mode]);

  useEffect(() => {
    // Avoid popping the mobile keyboard open on page load.
    if (!window.matchMedia('(pointer: fine)').matches) return;
    firstFieldRef.current?.focus({ preventScroll: true });
  }, [mode, full]);

  const clearMessages = () => {
    if (error) setError('');
    if (authError && onClearError) onClearError();
  };

  const switchMode = (next) => {
    if (next === mode) return;
    setMode(next);
    setError('');
    setShowPassword(false);
    if (onClearError) onClearError();
  };

  const submit = async (event) => {
    event.preventDefault();
    if (busy) return;
    setBusy(true);
    setError('');
    if (onClearError) onClearError();
    try {
      if (mode === 'register') {
        await api.post('/api/auth/register', {
          email,
          password,
          displayName,
        });
      } else {
        await api.post('/api/auth/login', { email, password });
      }
      await onAuth();
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="auth-page">
      <main className="auth-shell">
        <div className="auth-brand">
          <Brand size="md" />
        </div>

        <div className="slots-card" aria-live="polite">
          <span className="slots-label">
            {full ? 'Свободных мест нет' : 'Осталось мест'}
          </span>
          <div className="slots-value">
            <strong>{free}</strong>
            <span>из {total}</span>
          </div>
          <div className="progress" aria-hidden="true">
            <span style={{ width: `${progress}%` }} />
          </div>
          <span className="slots-hint">
            {full ? 'Регистрация закрыта' : 'Регистрация открыта'}
          </span>
        </div>

        <section className="auth-card" aria-labelledby="auth-title">
          <div className="auth-head">
            <h1 id="auth-title">{mode === 'login' ? 'Вход' : 'Регистрация'}</h1>
            <p className="muted">
              {mode === 'login'
                ? 'Войдите, чтобы открыть общий чат.'
                : 'Создайте аккаунт, затем подтвердите YouTube-канал.'}
            </p>
          </div>

          {shownError && (
            <div className="notice notice-error" role="alert">
              <Icon name="info" size={16} />
              <span>{shownError}</span>
            </div>
          )}

          {!full && (
            <div className="segmented" role="group" aria-label="Вход или регистрация">
              <button
                type="button"
                className={mode === 'login' ? 'active' : ''}
                aria-pressed={mode === 'login'}
                onClick={() => switchMode('login')}
              >
                Вход
              </button>
              <button
                type="button"
                className={mode === 'register' ? 'active' : ''}
                aria-pressed={mode === 'register'}
                onClick={() => switchMode('register')}
              >
                Регистрация
              </button>
            </div>
          )}

          <form onSubmit={submit} className="auth-form" aria-busy={busy}>
            {mode === 'register' && !full && (
              <div className="field">
                <label htmlFor="auth-display-name">Отображаемое имя</label>
                <input
                  id="auth-display-name"
                  ref={firstFieldRef}
                  value={displayName}
                  onChange={(event) => {
                    setDisplayName(event.target.value);
                    clearMessages();
                  }}
                  placeholder="Как вас называть"
                  autoComplete="nickname"
                  minLength={2}
                  maxLength={40}
                  disabled={busy}
                  required
                />
              </div>
            )}
            <div className="field">
              <label htmlFor="auth-email">Email</label>
              <input
                id="auth-email"
                ref={mode === 'login' || full ? firstFieldRef : undefined}
                type="email"
                value={email}
                onChange={(event) => {
                  setEmail(event.target.value);
                  clearMessages();
                }}
                placeholder="you@example.com"
                autoComplete="email"
                inputMode="email"
                autoCapitalize="none"
                spellCheck={false}
                disabled={busy}
                required
              />
            </div>
            <div className="field">
              <label htmlFor="auth-password">Пароль</label>
              <div className="password-wrap">
                <input
                  id="auth-password"
                  type={showPassword ? 'text' : 'password'}
                  value={password}
                  onChange={(event) => {
                    setPassword(event.target.value);
                    clearMessages();
                  }}
                  placeholder={mode === 'register' ? 'Минимум 8 символов' : 'Ваш пароль'}
                  autoComplete={mode === 'register' ? 'new-password' : 'current-password'}
                  minLength={mode === 'register' ? 8 : undefined}
                  disabled={busy}
                  required
                />
                <button
                  className="password-toggle"
                  type="button"
                  onClick={() => setShowPassword((value) => !value)}
                  aria-label={showPassword ? 'Скрыть пароль' : 'Показать пароль'}
                >
                  <Icon name={showPassword ? 'eyeOff' : 'eye'} size={17} />
                </button>
              </div>
            </div>

            <button className="btn btn-primary btn-block" type="submit" disabled={busy}>
              {busy
                ? 'Проверяем…'
                : mode === 'login'
                  ? 'Войти'
                  : 'Создать аккаунт'}
            </button>
          </form>

          {config?.googleEnabled && (
            <>
              <div className="divider"><span>или</span></div>
              <a className="btn btn-google btn-block" href="/api/auth/google">
                <GoogleMark />
                Продолжить с Google
              </a>
            </>
          )}
        </section>
      </main>
    </div>
  );
}
