import { useRef, useState } from 'react';
import { api } from '../api.js';
import {
  buildKeyBackup,
  getStoredGroupKey,
  getStoredIdentity,
  parseKeyBackup,
  storeGroupKey,
  storeIdentity,
} from '../crypto.js';
import { formatDate, formatSubs } from '../format.js';
import Avatar from './Avatar.jsx';
import { Icon } from './Icons.jsx';

export default function Profile({ me, refresh, logout, onOpenChat }) {
  const { user } = me;
  const [error, setError] = useState('');
  const [info, setInfo] = useState('');
  const [busy, setBusy] = useState(false);
  const importRef = useRef(null);

  const identity = getStoredIdentity(user.id);
  const groupKey = getStoredGroupKey(user.id);

  const downloadBackup = () => {
    setError('');
    setInfo('');
    const currentIdentity = getStoredIdentity(user.id);
    const currentGroupKey = getStoredGroupKey(user.id);
    if (!currentIdentity) {
      setError('На этом устройстве нет приватного ключа. Восстановите копию или откройте чат, чтобы создать ключи.');
      return;
    }
    const backup = buildKeyBackup(user.id, currentIdentity, currentGroupKey);
    const blob = new Blob([JSON.stringify(backup, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `artback-keys-${user.memberNumber || user.id.slice(0, 8)}.json`;
    document.body.appendChild(link);
    link.click();
    link.remove();
    URL.revokeObjectURL(url);
    setInfo('Резервная копия скачана. Храните файл в надёжном месте — он даёт доступ к истории чата.');
  };

  const importBackup = async (event) => {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file) return;
    setError('');
    setInfo('');
    setBusy(true);
    try {
      const text = await file.text();
      const parsed = parseKeyBackup(text, user.id);
      await api.put('/api/keys/public', {
        publicKey: parsed.identity.publicKey,
        replace: true,
      });
      storeIdentity(user.id, parsed.identity);
      if (parsed.groupKey) {
        storeGroupKey(user.id, parsed.groupKey.key, parsed.groupKey.epoch);
      }
      await refresh();
      setInfo('Ключи восстановлены. Перезагружаем страницу…');
      setTimeout(() => window.location.reload(), 600);
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="profile-page">
      <div className="page-head">
        <div>
          <h1>Профиль</h1>
          <p>Ваш канал, статус участника и ключи шифрования.</p>
        </div>
      </div>

      {error && (
        <div className="notice notice-error">
          <Icon name="info" size={16} />
          <span>{error}</span>
        </div>
      )}
      {info && (
        <div className="notice notice-ok">
          <Icon name="check" size={16} />
          <span>{info}</span>
        </div>
      )}

      <div className="profile-grid">
        <section className="profile-card">
          <div className="profile-banner" />
          <div className="profile-main">
            <Avatar user={user} size={84} className="profile-avatar" />
            <div className="profile-title">
              <h2>{user.channelTitle || user.displayName}</h2>
              <a
                href={user.channelUrl || '#'}
                target="_blank"
                rel="noreferrer"
                className="member-handle"
              >
                {user.channelHandle || user.channelTitle || 'YouTube-канал'}
                <Icon name="external" size={12} />
              </a>
              <div className="profile-badges">
                {user.isAdmin && (
                  <span className="badge badge-admin">
                    <Icon name="crown" size={12} /> администратор
                  </span>
                )}
                <span className="badge">участник #{user.memberNumber}</span>
                <span className="badge badge-ok">канал подтверждён</span>
              </div>
            </div>
          </div>

          <div className="profile-stats">
            <div>
              <strong>{formatSubs(user.subscriberCount, user.hiddenSubscribers)}</strong>
              <span>подписчиков</span>
            </div>
            <div>
              <strong>{formatDate(user.verifiedAt)}</strong>
              <span>в клубе с</span>
            </div>
            <div>
              <strong>{user.isAdmin ? 'да' : 'нет'}</strong>
              <span>админ</span>
            </div>
          </div>

          <dl className="profile-details">
            <div>
              <dt>Email</dt>
              <dd>{user.email}</dd>
            </div>
            <div>
              <dt>Способ входа</dt>
              <dd>{user.isGoogle ? 'Google OAuth' : 'Email и пароль'}</dd>
            </div>
            <div>
              <dt>YouTube ID</dt>
              <dd className="mono">{user.channelId}</dd>
            </div>
            <div>
              <dt>Аккаунт создан</dt>
              <dd>{formatDate(user.createdAt)}</dd>
            </div>
          </dl>
        </section>

        <section className="profile-card keys-card">
          <div className="card-heading">
            <span className="card-icon"><Icon name="key" size={20} /></span>
            <div>
              <h2>Ключи шифрования</h2>
              <p className="muted">Приватный ключ не покидает этот браузер.</p>
            </div>
          </div>

          <div className="key-status-list">
            <div className="key-status">
              <span className={`status-dot ${identity ? 'ok' : 'bad'}`} />
              <div>
                <strong>Ключ устройства</strong>
                <span>{identity ? 'найден в этом браузере' : 'не найден — импортируйте копию'}</span>
              </div>
            </div>
            <div className="key-status">
              <span className={`status-dot ${groupKey ? 'ok' : 'bad'}`} />
              <div>
                <strong>Ключ группы</strong>
                <span>
                  {groupKey
                    ? `получен · версия ${groupKey.epoch}`
                    : 'ещё не получен от участников'}
                </span>
              </div>
            </div>
            <div className="key-status">
              <span className={`status-dot ${user.publicKey ? 'ok' : 'bad'}`} />
              <div>
                <strong>Публичный ключ на сервере</strong>
                <span>{user.publicKey ? 'опубликован' : 'появится при первом входе в чат'}</span>
              </div>
            </div>
          </div>

          <div className="key-actions">
            <button className="btn btn-primary" type="button" onClick={downloadBackup} disabled={!identity}>
              <Icon name="download" size={15} /> Скачать бэкап
            </button>
            <button
              className="btn btn-ghost"
              type="button"
              onClick={() => importRef.current?.click()}
              disabled={busy}
            >
              <Icon name="upload" size={15} /> Импортировать
            </button>
            <input
              ref={importRef}
              type="file"
              accept="application/json,.json"
              hidden
              onChange={importBackup}
            />
          </div>

          <div className="info-block info-block-warn">
            <Icon name="info" size={16} />
            <p>
              Файл бэкапа содержит приватный ключ и ключ группы. Любой, кто получит файл,
              сможет читать вашу переписку. Не отправляйте его в мессенджеры.
            </p>
          </div>

          <button className="btn btn-dark btn-block" type="button" onClick={onOpenChat}>
            <Icon name="send" size={15} /> Перейти в чат
          </button>
        </section>
      </div>

      <section className="profile-card security-card">
        <h3><Icon name="shield" size={18} /> Как устроена безопасность</h3>
        <div className="security-grid">
          <div>
            <strong>E2EE в браузере</strong>
            <p>
              Сообщения шифруются AES-256-GCM ключом группы. Ключ каждому участнику
              передаётся отдельно, через ECDH P-256.
            </p>
          </div>
          <div>
            <strong>Сервер видит только шифротекст</strong>
            <p>
              В базе хранится ciphertext, а в S3 — зашифрованные файлы. Метаданные
              (кто и когда отправил) серверу видны.
            </p>
          </div>
          <div>
            <strong>Вы отвечаете за ключ</strong>
            <p>
              Очистка данных браузера или новое устройство без бэкапа означает потерю
              доступа к старой истории. Это цена E2EE.
            </p>
          </div>
        </div>
      </section>

      <div className="profile-danger">
        <div>
          <strong>Выйти из аккаунта</strong>
          <span>Ключи останутся в браузере, но сессия будет закрыта.</span>
        </div>
        <button className="btn btn-danger" type="button" onClick={logout}>
          <Icon name="logout" size={15} /> Выйти
        </button>
      </div>
    </div>
  );
}
