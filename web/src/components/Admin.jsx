import { useCallback, useEffect, useMemo, useState } from 'react';
import { api } from '../api.js';
import {
  formatBytes,
  formatDateTime,
  formatRelative,
  formatSubs,
} from '../format.js';
import Avatar from './Avatar.jsx';
import { Icon } from './Icons.jsx';

const AUDIT_LABELS = {
  registered: 'Регистрация',
  channel_verified: 'Канал подтверждён',
  google_linked: 'Канал привязан через Google',
  identity_key_replaced: 'Ключ устройства заменён',
  user_banned: 'Пользователь заблокирован',
  user_unbanned: 'Пользователь разблокирован',
  admin_promoted: 'Назначен администратор',
  admin_demoted: 'Снят администратор',
  channel_refreshed: 'Данные канала обновлены',
  message_deleted: 'Сообщение удалено',
};

const STATUS_LABELS = {
  verified: 'участник',
  pending: 'ожидает',
  banned: 'заблокирован',
};

export default function Admin({ me, refresh, onSynced }) {
  const [overview, setOverview] = useState(null);
  const [users, setUsers] = useState([]);
  const [audit, setAudit] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [syncing, setSyncing] = useState(false);
  const [busyId, setBusyId] = useState('');
  const [tab, setTab] = useState('users');
  const [query, setQuery] = useState('');
  const [statusFilter, setStatusFilter] = useState('all');

  const load = useCallback(async () => {
    try {
      const [overviewData, usersData, auditData] = await Promise.all([
        api.get('/api/admin/overview'),
        api.get('/api/admin/users'),
        api.get('/api/admin/audit'),
      ]);
      setOverview(overviewData);
      setUsers(usersData.users || []);
      setAudit(auditData.entries || []);
      setError('');
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
    const timer = setInterval(load, 60_000);
    return () => clearInterval(timer);
  }, [load]);

  const filteredUsers = useMemo(() => {
    const search = query.trim().toLowerCase();
    return users.filter((user) => {
      if (statusFilter !== 'all' && user.status !== statusFilter) return false;
      if (!search) return true;
      return [user.email, user.displayName, user.channelTitle, user.channelHandle]
        .filter(Boolean)
        .some((value) => String(value).toLowerCase().includes(search));
    });
  }, [users, query, statusFilter]);

  const action = async (id, fn, successMessage = '') => {
    setBusyId(id);
    setError('');
    setNotice('');
    try {
      await fn();
      if (successMessage) setNotice(successMessage);
      await load();
      await refresh();
      if (onSynced) onSynced();
    } catch (err) {
      setError(err.message);
    } finally {
      setBusyId('');
    }
  };

  const ban = (user) => {
    const label = user.channelTitle || user.displayName;
    const reason = window.prompt(
      `Заблокировать «${label}»? Укажите причину (необязательно):`,
      '',
    );
    if (reason === null) return;
    action(user.id, () => api.post(`/api/admin/users/${user.id}/ban`, { reason }), 'Пользователь заблокирован');
  };

  const unban = (user) => {
    if (!window.confirm(`Разблокировать «${user.channelTitle || user.displayName}»?`)) return;
    action(user.id, () => api.post(`/api/admin/users/${user.id}/unban`), 'Пользователь разблокирован');
  };

  const toggleAdmin = (user) => {
    const label = user.channelTitle || user.displayName;
    if (
      !window.confirm(
        user.isAdmin
          ? `Снять «${label}» с должности администратора?`
          : `Назначить «${label}» администратором?`,
      )
    ) {
      return;
    }
    action(
      user.id,
      () => api.post(`/api/admin/users/${user.id}/admin`, { value: !user.isAdmin }),
      user.isAdmin ? 'Администратор снят' : 'Администратор назначен',
    );
  };

  const refreshChannel = (user) => {
    action(user.id, () => api.post(`/api/admin/users/${user.id}/refresh-channel`), 'Данные канала обновлены');
  };

  const syncNow = async () => {
    setSyncing(true);
    setError('');
    setNotice('');
    try {
      const result = await api.post('/api/admin/sync');
      setNotice(
        `Синхронизация завершена: ${result.result.updated} обновлено, ` +
          `${result.result.channels} каналов, ${result.result.requests} запрос(а) к YouTube API.`,
      );
      await load();
      if (onSynced) onSynced();
    } catch (err) {
      setError(err.message);
    } finally {
      setSyncing(false);
    }
  };

  if (loading) {
    return (
      <div className="admin-page">
        <div className="page-head">
          <div>
            <span className="eyebrow">Управление</span>
            <h1>Админка</h1>
          </div>
        </div>
        <div className="admin-skeleton">
          <span /><span /><span /><span />
        </div>
      </div>
    );
  }

  const stats = overview?.stats || {};
  const taken = stats.verified ?? 0;
  const total = overview?.slots?.total ?? 100;
  const progress = Math.min(100, Math.round((taken / total) * 100));

  return (
    <div className="admin-page">
      <div className="page-head">
        <div>
          <span className="eyebrow">Управление клубом</span>
          <h1>Админка</h1>
          <p>Участники, блокировки, ключи, синхронизация и журнал действий.</p>
        </div>
        <button className="btn btn-primary" type="button" onClick={syncNow} disabled={syncing}>
          <Icon name="refresh" size={15} />
          {syncing ? 'Синхронизируем…' : 'Обновить подписчиков'}
        </button>
      </div>

      {error && (
        <div className="notice notice-error">
          <Icon name="info" size={16} />
          <span>{error}</span>
        </div>
      )}
      {notice && (
        <div className="notice notice-ok">
          <Icon name="check" size={16} />
          <span>{notice}</span>
        </div>
      )}

      {!overview?.youtubeEnabled && (
        <div className="notice notice-warn">
          <Icon name="info" size={16} />
          <span>YOUTUBE_API_KEY не настроен — привязка новых каналов и синхронизация не работают.</span>
        </div>
      )}
      {!overview?.mediaEnabled && (
        <div className="notice notice-warn">
          <Icon name="info" size={16} />
          <span>S3 не настроен — отправка медиа в чат отключена.</span>
        </div>
      )}

      <div className="admin-stat-grid">
        <div className="admin-stat">
          <span>Места</span>
          <strong>{taken} / {total}</strong>
          <div className="progress small"><span style={{ width: `${progress}%` }} /></div>
        </div>
        <div className="admin-stat">
          <span>Ожидают</span>
          <strong>{stats.pending ?? 0}</strong>
          <small>аккаунтов без канала</small>
        </div>
        <div className="admin-stat">
          <span>Заблокированы</span>
          <strong>{stats.banned ?? 0}</strong>
          <small>не имеют доступа</small>
        </div>
        <div className="admin-stat">
          <span>Онлайн</span>
          <strong>{overview?.online ?? 0}</strong>
          <small>сейчас в сети</small>
        </div>
        <div className="admin-stat">
          <span>Сообщения</span>
          <strong>{stats.messages ?? 0}</strong>
          <small>в общем чате</small>
        </div>
        <div className="admin-stat">
          <span>Медиа</span>
          <strong>{formatBytes(stats.mediaBytes ?? 0)}</strong>
          <small>{stats.media_files ?? 0} файлов в S3</small>
        </div>
        <div className="admin-stat">
          <span>Ключи группы</span>
          <strong>{stats.keys_issued ?? 0}</strong>
          <small>выдано участникам</small>
        </div>
        <div className="admin-stat">
          <span>Администраторы</span>
          <strong>{stats.admins ?? 0}</strong>
          <small>с полным доступом</small>
        </div>
      </div>

      <div className="admin-sync-card">
        <div className="admin-sync-main">
          <span className="card-icon"><Icon name="refresh" size={20} /></span>
          <div>
            <h3>Ежедневная синхронизация</h3>
            <p>
              Пакетный запрос к YouTube API: один запрос обновляет до 50 каналов.
              Для 100 участников достаточно 2 запросов в сутки.
            </p>
          </div>
        </div>
        <div className="admin-sync-meta">
          {overview?.sync ? (
            <>
              <span className={`badge ${overview.sync.ok ? 'badge-ok' : 'badge-danger'}`}>
                {overview.sync.ok ? 'успешно' : 'ошибка'}
              </span>
              <span>{formatRelative(overview.sync.finishedAt || overview.sync.startedAt)}</span>
              <span>{overview.sync.channels} каналов</span>
              <span>{overview.sync.requests} запросов</span>
              {overview.sync.error && <span className="error-text">{overview.sync.error}</span>}
            </>
          ) : (
            <span>Синхронизаций ещё не было</span>
          )}
        </div>
      </div>

      <div className="admin-tabs">
        <button
          type="button"
          className={tab === 'users' ? 'active' : ''}
          onClick={() => setTab('users')}
        >
          <Icon name="users" size={16} /> Пользователи ({users.length})
        </button>
        <button
          type="button"
          className={tab === 'audit' ? 'active' : ''}
          onClick={() => setTab('audit')}
        >
          <Icon name="shield" size={16} /> Журнал действий
        </button>
      </div>

      {tab === 'users' ? (
        <>
          <div className="admin-toolbar">
            <label className="search-field">
              <Icon name="search" size={17} />
              <input
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder="Имя, email, канал…"
              />
            </label>
            <div className="filter-chips">
              {[
                ['all', 'Все'],
                ['verified', 'Участники'],
                ['pending', 'Ожидают'],
                ['banned', 'Блокированные'],
              ].map(([value, label]) => (
                <button
                  key={value}
                  type="button"
                  className={statusFilter === value ? 'active' : ''}
                  onClick={() => setStatusFilter(value)}
                >
                  {label}
                </button>
              ))}
            </div>
          </div>

          <div className="table-wrap">
            <table className="admin-table">
              <thead>
                <tr>
                  <th>Пользователь</th>
                  <th>Статус</th>
                  <th>Канал</th>
                  <th>Ключи</th>
                  <th>Действия</th>
                </tr>
              </thead>
              <tbody>
                {filteredUsers.map((user) => (
                  <tr key={user.id} className={busyId === user.id ? 'busy' : ''}>
                    <td>
                      <div className="table-user">
                        <Avatar user={user} size={38} />
                        <div>
                          <strong>
                            {user.channelTitle || user.displayName}
                            {user.id === me.user.id && <span className="you-badge">вы</span>}
                          </strong>
                          <span>{user.email}</span>
                          {user.isGoogle && <small>Google</small>}
                        </div>
                      </div>
                    </td>
                    <td>
                      <span className={`badge status-${user.status}`}>
                        {user.isAdmin && <Icon name="crown" size={11} />}
                        {STATUS_LABELS[user.status] || user.status}
                      </span>
                      {user.banReason && <small className="ban-reason">{user.banReason}</small>}
                      {user.verification?.code && (
                        <div className="verification-code">
                          <span>Код:</span> <code>{user.verification.code}</code>
                        </div>
                      )}
                    </td>
                    <td>
                      {user.channelTitle ? (
                        <div className="table-channel">
                          <a href={user.channelUrl} target="_blank" rel="noreferrer">
                            {user.channelTitle}
                            <Icon name="external" size={11} />
                          </a>
                          <span>
                            {formatSubs(user.subscriberCount, user.hiddenSubscribers)} подписчиков
                          </span>
                          <small>{user.channelHandle || user.channelId}</small>
                        </div>
                      ) : (
                        <span className="muted">—</span>
                      )}
                    </td>
                    <td>
                      <div className="key-cell">
                        <span className={`status-dot ${user.publicKey ? 'ok' : 'bad'}`} />
                        <span>{user.publicKey ? 'ключ есть' : 'нет ключа'}</span>
                        <small>{user.hasKey ? 'группа выдана' : 'группа не выдана'}</small>
                      </div>
                    </td>
                    <td>
                      <div className="table-actions">
                        {user.status === 'verified' && (
                          <>
                            <button
                              type="button"
                              className="icon-btn"
                              title={user.isAdmin ? 'Снять администратора' : 'Назначить администратором'}
                              onClick={() => toggleAdmin(user)}
                              disabled={busyId === user.id}
                            >
                              <Icon name="crown" size={15} />
                            </button>
                            <button
                              type="button"
                              className="icon-btn"
                              title="Обновить данные канала"
                              onClick={() => refreshChannel(user)}
                              disabled={busyId === user.id}
                            >
                              <Icon name="refresh" size={15} />
                            </button>
                          </>
                        )}
                        {user.status === 'banned' ? (
                          <button
                            type="button"
                            className="icon-btn ok"
                            title="Разблокировать"
                            onClick={() => unban(user)}
                            disabled={busyId === user.id}
                          >
                            <Icon name="check" size={15} />
                          </button>
                        ) : (
                          <button
                            type="button"
                            className="icon-btn danger"
                            title="Заблокировать"
                            onClick={() => ban(user)}
                            disabled={busyId === user.id || user.id === me.user.id}
                          >
                            <Icon name="ban" size={15} />
                          </button>
                        )}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            {filteredUsers.length === 0 && (
              <div className="empty-state compact">
                <Icon name="users" size={24} />
                <p>Пользователи не найдены.</p>
              </div>
            )}
          </div>
        </>
      ) : (
        <div className="audit-list">
          {audit.length === 0 && (
            <div className="empty-state compact">
              <Icon name="shield" size={24} />
              <p>Журнал пуст.</p>
            </div>
          )}
          {audit.map((entry) => (
            <div className="audit-row" key={entry.id}>
              <span className="audit-icon"><Icon name="shield" size={15} /></span>
              <div className="audit-main">
                <strong>{AUDIT_LABELS[entry.action] || entry.action}</strong>
                <span>
                  {entry.actor?.channelTitle || entry.actor?.displayName || 'система'}
                  {entry.details ? ` · ${summarize(entry.details)}` : ''}
                </span>
              </div>
              <time title={formatDateTime(entry.createdAt)}>{formatRelative(entry.createdAt)}</time>
            </div>
          ))}
        </div>
      )}

      <div className="admin-limits">
        <h3>Лимиты медиа</h3>
        <div>
          <span>Изображения <strong>{overview?.limits?.imageMb} МБ</strong></span>
          <span>Видео <strong>{overview?.limits?.videoMb} МБ</strong></span>
          <span>Аудио <strong>{overview?.limits?.audioMb} МБ</strong></span>
          <span>Файлы <strong>{overview?.limits?.fileMb} МБ</strong></span>
        </div>
        <p>Меняются переменными окружения MAX_IMAGE_MB, MAX_VIDEO_MB, MAX_AUDIO_MB, MAX_FILE_MB.</p>
      </div>
    </div>
  );
}

function summarize(details) {
  if (!details || typeof details !== 'object') return String(details || '');
  const parts = [];
  for (const key of ['channelTitle', 'reason', 'userId', 'messageId', 'status']) {
    if (details[key]) parts.push(`${key}: ${details[key]}`);
  }
  return parts.join(', ') || JSON.stringify(details).slice(0, 80);
}
