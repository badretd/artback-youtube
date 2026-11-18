import { useEffect, useMemo, useState } from 'react';
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
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const total = config?.maxMembers ?? 100;
  const taken = config?.taken ?? 0;
  const free = Math.max(0, total - taken);
  const full = free === 0;
  const progress = Math.min(100, Math.round((taken / total) * 100));

  const shownError = authError || error;

  useEffect(() => {
    if (full && mode === 'register') setMode('login');
  }, [full, mode]);

  useEffect(() => {
    setError('');
  }, [mode]);

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

  const features = useMemo(
    () => [
      {
        icon: 'shield',
        title: 'Сквозное шифрование',
        text: 'Сервер хранит только шифротекст. Ключ общего чата есть только у участников, а медиа шифруются в браузере до загрузки в S3.',
      },
      {
        icon: 'users',
        title: 'Только 100 авторов',
        text: 'Место занимает тот, кто привязал свой YouTube-канал и подтвердил владение им. Первый участник становится администратором.',
      },
      {
        icon: 'refresh',
        title: 'Подписчики каждый день',
        text: 'Раз в сутки сервер обновляет статистику всех каналов пакетными запросами к YouTube API — всего 2 запроса на 100 участников.',
      },
      {
        icon: 'image',
        title: 'Медиа в вашем S3',
        text: 'Изображения, видео и файлы отправляются в общий чат зашифрованными. Лимиты по размеру настраиваются администратором.',
      },
    ],
    [],
  );

  return (
    <div className="landing">
      <div className="landing-bg">
        <div className="orb orb-red" />
        <div className="orb orb-orange" />
        <div className="landing-grid" />
      </div>

      <header className="landing-header">
        <Brand size="md" />
        <div className="landing-header-right">
          <a href="#how" className="ghost-link">Как это работает</a>
          <a href="#features" className="ghost-link">Возможности</a>
          <a href="#join" className="btn btn-primary btn-sm">Войти в клуб</a>
        </div>
      </header>

      <main className="landing-main">
        <section className="hero">
          <div className="hero-copy">
            <div className="eyebrow">
              <span className="eyebrow-dot" />
              Закрытое сообщество · {total} мест
            </div>
            <h1>
              Комната для ста
              <br />
              <span className="gradient-text">YouTube-авторов</span>
            </h1>
            <p className="hero-sub">
              Привяжите свой канал, подтвердите владение им и попадите в общий
              чат с настоящим сквозным шифрованием. Никаких случайных людей —
              только авторы с подтверждённым каналом.
            </p>

            <div className="hero-stats">
              <div className="slot-card">
                <div className="slot-top">
                  <span>Занято мест</span>
                  <strong>
                    {taken} <span>/ {total}</span>
                  </strong>
                </div>
                <div className="progress">
                  <span style={{ width: `${progress}%` }} />
                </div>
                <div className="slot-bottom">
                  <span>{free > 0 ? `Свободно ${free}` : 'Регистрация закрыта'}</span>
                  <span>{progress}%</span>
                </div>
              </div>
              <div className="hero-mini">
                <div className="mini-icon"><Icon name="lock" size={20} /></div>
                <div>
                  <strong>E2EE</strong>
                  <span>ключи только у вас</span>
                </div>
              </div>
              <div className="hero-mini">
                <div className="mini-icon"><Icon name="crown" size={20} /></div>
                <div>
                  <strong>Первый = админ</strong>
                  <span>управление клубом</span>
                </div>
              </div>
            </div>

            <div className="hero-points">
              <span><Icon name="check" size={16} /> Владение каналом подтверждается кодом или Google</span>
              <span><Icon name="check" size={16} /> Подписчики обновляются автоматически раз в сутки</span>
            </div>
          </div>

          <div className="auth-card" id="join">
            <div className="auth-card-glow" />
            <div className="auth-head">
              <h2>{full ? 'Мест больше нет' : mode === 'login' ? 'С возвращением' : 'Занять место'}</h2>
              <p className="muted">
                {full
                  ? 'Все 100 мест заняты. Вход доступен действующим участникам.'
                  : mode === 'login'
                    ? 'Войдите, чтобы продолжить.'
                    : 'Аккаунт станет участником после подтверждения канала.'}
              </p>
            </div>

            {shownError && (
              <div className="notice notice-error">
                <Icon name="info" size={16} />
                <span>{shownError}</span>
              </div>
            )}

            {!full && (
              <div className="segmented">
                <button
                  type="button"
                  className={mode === 'login' ? 'active' : ''}
                  onClick={() => setMode('login')}
                >
                  Вход
                </button>
                <button
                  type="button"
                  className={mode === 'register' ? 'active' : ''}
                  onClick={() => setMode('register')}
                >
                  Регистрация
                </button>
              </div>
            )}

            <form onSubmit={submit} className="auth-form">
              {mode === 'register' && (
                <label className="field">
                  <span>Как вас называть</span>
                  <input
                    value={displayName}
                    onChange={(event) => setDisplayName(event.target.value)}
                    placeholder="Ваше имя или ник"
                    autoComplete="nickname"
                    minLength={2}
                    maxLength={40}
                    required
                  />
                </label>
              )}
              <label className="field">
                <span>Email</span>
                <input
                  type="email"
                  value={email}
                  onChange={(event) => setEmail(event.target.value)}
                  placeholder="you@example.com"
                  autoComplete="email"
                  required
                />
              </label>
              <label className="field">
                <span>Пароль</span>
                <input
                  type="password"
                  value={password}
                  onChange={(event) => setPassword(event.target.value)}
                  placeholder={mode === 'register' ? 'Минимум 8 символов' : 'Ваш пароль'}
                  autoComplete={mode === 'register' ? 'new-password' : 'current-password'}
                  minLength={mode === 'register' ? 8 : undefined}
                  required
                />
              </label>

              <button className="btn btn-primary btn-block" type="submit" disabled={busy}>
                {busy
                  ? 'Подключаемся…'
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
                <p className="fineprint">
                  При входе через Google канал привязывается автоматически, если он есть в аккаунте.
                </p>
              </>
            )}

            {full && (
              <div className="notice notice-warn">
                <Icon name="info" size={16} />
                <span>
                  Освободившееся место появится здесь автоматически. Следите за обновлением.
                </span>
              </div>
            )}

            <div className="auth-note">
              <Icon name="lock" size={14} />
              <span>Пароль хранится в виде scrypt-хэша. Сайт не читает ваши сообщения.</span>
            </div>
          </div>
        </section>

        <section className="section" id="how">
          <div className="section-head">
            <span className="eyebrow">Как попасть</span>
            <h2>Три шага до общего чата</h2>
            <p>Регистрация считается завершённой только после подтверждения YouTube-канала.</p>
          </div>
          <div className="steps">
            <div className="step-card">
              <span className="step-number">01</span>
              <h3>Создайте аккаунт</h3>
              <p>Email и пароль или вход через Google. Это ещё не участие — место пока не занято.</p>
            </div>
            <div className="step-card">
              <span className="step-number">02</span>
              <h3>Подтвердите канал</h3>
              <p>
                Вставьте ссылку на канал, а затем код <code>ARTBACK-XXXXXX</code> в описание канала.
                Мы проверим его через YouTube API.
              </p>
            </div>
            <div className="step-card">
              <span className="step-number">03</span>
              <h3>Получите ключ</h3>
              <p>
                После подтверждения вы становитесь участником. Другой участник передаст вам ключ
                шифрования группы прямо в браузер.
              </p>
            </div>
          </div>
        </section>

        <section className="section" id="features">
          <div className="section-head">
            <span className="eyebrow">Внутри</span>
            <h2>Не просто чат</h2>
            <p>Инфраструктура, рассчитанная на закрытое сообщество авторов.</p>
          </div>
          <div className="feature-grid">
            {features.map((feature) => (
              <article className="feature-card" key={feature.title}>
                <div className="feature-icon"><Icon name={feature.icon} size={22} /></div>
                <h3>{feature.title}</h3>
                <p>{feature.text}</p>
              </article>
            ))}
          </div>
          <div className="admin-strip">
            <div>
              <h3><Icon name="shield" size={20} /> Административные функции</h3>
              <p>
                Блокировка и разблокировка участников, назначение администраторов,
                удаление сообщений, ручная синхронизация подписчиков и журнал действий.
              </p>
            </div>
            <div className="admin-strip-badge">
              <Icon name="crown" size={18} />
              Первый подтверждённый участник
            </div>
          </div>
        </section>

        <section className="cta-section">
          <div>
            <h2>Осталось {free > 0 ? `${free} ${free === 1 ? 'место' : 'мест'}` : 'ноль мест'}</h2>
            <p>Подтверждённый канал — ваш пропуск. Всё остальное написано кодом.</p>
          </div>
          <a href="#join" className="btn btn-primary">{full ? 'Войти' : 'Занять место'}</a>
        </section>
      </main>

      <footer className="landing-footer">
        <Brand size="sm" />
        <div className="footer-meta">
          <span>E2EE · YouTube API · S3</span>
          <span>© {new Date().getFullYear()} ARTBACK</span>
        </div>
      </footer>
    </div>
  );
}
