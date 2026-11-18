import { useState } from 'react';
import { api } from '../api.js';
import Avatar from './Avatar.jsx';
import Brand from './Brand.jsx';
import { Icon } from './Icons.jsx';
import { formatSubs } from '../format.js';

export default function Onboarding({ me, refresh, logout, authError = '' }) {
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [copied, setCopied] = useState(false);
  const verification = me.verification;
  const taken = me.slots?.taken ?? 0;
  const total = me.slots?.total ?? 100;

  const start = async (event) => {
    event.preventDefault();
    if (busy) return;
    setBusy(true);
    setError('');
    try {
      await api.post('/api/channel/start', { input });
      await refresh();
      setInput('');
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  };

  const verify = async () => {
    if (busy) return;
    setBusy(true);
    setError('');
    try {
      await api.post('/api/channel/verify');
      await refresh();
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  };

  const cancel = async () => {
    if (busy) return;
    setBusy(true);
    setError('');
    try {
      await api.del('/api/channel/pending');
      await refresh();
      setCopied(false);
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  };

  const copyCode = async () => {
    if (!verification?.code) return;
    try {
      await navigator.clipboard.writeText(verification.code);
      setCopied(true);
      setTimeout(() => setCopied(false), 1800);
    } catch {
      setError('Не удалось скопировать — выделите код вручную.');
    }
  };

  return (
    <div className="onboarding">
      <div className="onboarding-bg">
        <div className="orb orb-red" />
        <div className="landing-grid" />
      </div>

      <header className="app-topbar onboarding-topbar">
        <Brand size="md" />
        <div className="topbar-actions">
          <span className="slot-pill">
            <Icon name="users" size={15} />
            {taken} / {total}
          </span>
          <button className="btn btn-ghost btn-sm" onClick={logout} type="button">
            <Icon name="logout" size={16} />
            Выйти
          </button>
        </div>
      </header>

      <main className="onboarding-main">
        <div className="onboarding-intro">
          <span className="eyebrow">Остался один шаг</span>
          <h1>Подтвердите свой канал</h1>
          <p>
            Привет, {me.user.displayName}. Мы проверим, что канал действительно ваш,
            и только тогда засчитаем участие и откроем общий чат.
          </p>

          <ol className="progress-steps">
            <li className="done">
              <span><Icon name="check" size={14} /></span>
              Аккаунт создан
            </li>
            <li className={verification ? 'active' : ''}>
              <span>{verification ? '2' : '2'}</span>
              Канал подтверждён
            </li>
            <li>
              <span>3</span>
              Доступ к чату
            </li>
          </ol>

          <div className="onboarding-facts">
            <div><strong>{taken}</strong><span>мест занято</span></div>
            <div><strong>{Math.max(0, total - taken)}</strong><span>свободно</span></div>
            <div><strong>24 ч</strong><span>обновление статистики</span></div>
          </div>
        </div>

        <div className="onboarding-card">
          {authError && !error && (
            <div className="notice notice-warn">
              <Icon name="info" size={16} />
              <span>{authError}</span>
            </div>
          )}
          {error && (
            <div className="notice notice-error">
              <Icon name="info" size={16} />
              <span>{error}</span>
            </div>
          )}

          {!verification ? (
            <>
              <div className="card-heading">
                <span className="card-icon"><Icon name="user" size={20} /></span>
                <div>
                  <h2>Ссылка на YouTube-канал</h2>
                  <p className="muted">Можно вставить ссылку, @ник или ID канала.</p>
                </div>
              </div>

              <form onSubmit={start} className="channel-form">
                <label className="field">
                  <span>Ваш канал</span>
                  <input
                    value={input}
                    onChange={(event) => setInput(event.target.value)}
                    placeholder="https://youtube.com/@yourchannel"
                    required
                    maxLength={300}
                    autoFocus
                  />
                </label>
                <button className="btn btn-primary btn-block" type="submit" disabled={busy}>
                  {busy ? 'Ищем канал…' : 'Получить код подтверждения'}
                </button>
              </form>

              <div className="info-block">
                <Icon name="lock" size={16} />
                <p>
                  Мы запрашиваем только публичные данные канала через YouTube Data API.
                  Пароль от YouTube не нужен.
                </p>
              </div>

              {me.config?.googleEnabled && (
                <div className="info-block info-block-accent">
                  <Icon name="key" size={16} />
                  <p>
                    В аккаунте есть YouTube-канал? Выйдите и войдите через Google —
                    канал привяжется автоматически, без кода в описании.
                  </p>
                </div>
              )}
            </>
          ) : (
            <>
              <div className="card-heading">
                <span className="card-icon"><Icon name="check" size={20} /></span>
                <div>
                  <h2>Канал найден</h2>
                  <p className="muted">Осталось доказать, что он принадлежит вам.</p>
                </div>
              </div>

              <div className="found-channel">
                <Avatar
                  user={{ channelTitle: verification.channel?.title, avatarUrl: verification.channel?.avatarUrl }}
                  size={56}
                />
                <div className="found-channel-info">
                  <strong>{verification.channel?.title}</strong>
                  <span>
                    {verification.channel?.handle ? `${verification.channel.handle} · ` : ''}
                    {formatSubs(
                      verification.channel?.subscriberCount,
                      verification.channel?.hiddenSubscribers,
                    )}{' '}
                    подписчиков
                  </span>
                </div>
                <a
                  className="icon-btn"
                  href={verification.channel?.channelUrl}
                  target="_blank"
                  rel="noreferrer"
                  title="Открыть канал"
                >
                  <Icon name="external" size={17} />
                </a>
              </div>

              <div className="code-box">
                <div>
                  <span className="muted">Код подтверждения</span>
                  <strong>{verification.code}</strong>
                </div>
                <button className="btn btn-dark btn-sm" type="button" onClick={copyCode}>
                  <Icon name={copied ? 'check' : 'copy'} size={15} />
                  {copied ? 'Скопирован' : 'Копировать'}
                </button>
              </div>

              <ol className="code-instructions">
                <li>
                  Откройте YouTube Studio → <b>Настройки</b> → <b>Информация о канале</b>.
                </li>
                <li>
                  Вставьте код в описание канала целиком и сохраните. Код можно убрать после проверки.
                </li>
                <li>
                  Вернитесь сюда и нажмите «Проверить». YouTube иногда обновляет описание
                  с задержкой до пары минут.
                </li>
              </ol>

              <div className="inline-actions">
                <button className="btn btn-primary" type="button" onClick={verify} disabled={busy}>
                  {busy ? 'Проверяем…' : 'Проверить канал'}
                </button>
                <button className="btn btn-ghost" type="button" onClick={cancel} disabled={busy}>
                  Другой канал
                </button>
              </div>

              <p className="fineprint">
                Если канал скрывает число подписчиков, это не помешает регистрации — в профиле
                будет указано «скрыто».
              </p>
            </>
          )}
        </div>
      </main>
    </div>
  );
}
