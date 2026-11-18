import { useEffect, useMemo, useState } from 'react';
import { api } from '../api.js';
import { formatDate, formatSubs, formatSubsFull } from '../format.js';
import Avatar from './Avatar.jsx';
import { Icon } from './Icons.jsx';

export default function Members({ me, syncTick = 0, online = [] }) {
  const [members, setMembers] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [query, setQuery] = useState('');

  useEffect(() => {
    let alive = true;
    setLoading(true);
    api
      .get('/api/members')
      .then((response) => {
        if (alive) {
          setMembers(response.members || []);
          setError('');
        }
      })
      .catch((err) => {
        if (alive) setError(err.message);
      })
      .finally(() => {
        if (alive) setLoading(false);
      });
    return () => {
      alive = false;
    };
  }, [syncTick]);

  const filtered = useMemo(() => {
    const search = query.trim().toLowerCase();
    if (!search) return members;
    return members.filter((member) =>
      [member.channelTitle, member.displayName, member.channelHandle]
        .filter(Boolean)
        .some((value) => value.toLowerCase().includes(search)),
    );
  }, [members, query]);

  return (
    <div className="members-page">
      <div className="page-head">
        <div>
          <span className="eyebrow">Каталог клуба</span>
          <h1>Авторы ARTBACK</h1>
          <p>
            {members.length} из {me.slots?.total ?? 100} мест занято. Здесь только каналы,
            подтвердившие владение.
          </p>
        </div>
        <div className="page-head-stats">
          <div>
            <strong>{members.length}</strong>
            <span>авторов</span>
          </div>
          <div>
            <strong>{online.length}</strong>
            <span>онлайн</span>
          </div>
        </div>
      </div>

      <div className="members-toolbar">
        <label className="search-field">
          <Icon name="search" size={17} />
          <input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Поиск по имени или @нику"
          />
        </label>
        <span className="toolbar-hint">
          <Icon name="lock" size={14} /> Статистика обновляется раз в сутки
        </span>
      </div>

      {error && (
        <div className="notice notice-error">
          <Icon name="info" size={16} />
          <span>{error}</span>
        </div>
      )}

      {loading ? (
        <div className="member-grid">
          {Array.from({ length: 8 }).map((_, index) => (
            <div className="member-card skeleton-card" key={index}>
              <span className="skeleton-avatar" />
              <span className="skeleton-line" />
              <span className="skeleton-line short" />
            </div>
          ))}
        </div>
      ) : filtered.length === 0 ? (
        <div className="empty-state">
          <Icon name="users" size={28} />
          <h3>Никого не нашли</h3>
          <p>Попробуйте изменить запрос.</p>
        </div>
      ) : (
        <div className="member-grid">
          {filtered.map((member) => {
            const isOnline = online.includes(member.id);
            const isMe = member.id === me.user.id;
            return (
              <article className={`member-card ${isMe ? 'is-me' : ''}`} key={member.id}>
                <div className="member-top">
                  <span className="member-avatar">
                    <Avatar user={member} size={64} />
                    {isOnline && <span className="online-dot" title="Онлайн" />}
                  </span>
                  <div className="member-badges">
                    {member.isAdmin && (
                      <span className="badge badge-admin">
                        <Icon name="crown" size={12} /> админ
                      </span>
                    )}
                    {isMe && <span className="badge">это вы</span>}
                  </div>
                </div>

                <h3>{member.channelTitle || member.displayName}</h3>
                <a
                  className="member-handle"
                  href={member.channelUrl || '#'}
                  target="_blank"
                  rel="noreferrer"
                >
                  {member.channelHandle || member.channelTitle}
                  <Icon name="external" size={12} />
                </a>

                <div className="member-stats">
                  <div>
                    <strong title={member.hiddenSubscribers ? 'Скрыто' : formatSubsFull(member.subscriberCount)}>
                      {formatSubs(member.subscriberCount, member.hiddenSubscribers)}
                    </strong>
                    <span>подписчиков</span>
                  </div>
                  <div>
                    <strong>#{member.memberNumber}</strong>
                    <span>в клубе</span>
                  </div>
                </div>

                <div className="member-foot">
                  <span>{formatDate(member.verifiedAt)}</span>
                  <span className={isOnline ? 'status-online' : 'status-offline'}>
                    {isOnline ? 'онлайн' : 'офлайн'}
                  </span>
                </div>
              </article>
            );
          })}
        </div>
      )}

      <div className="members-note">
        <Icon name="info" size={16} />
        <p>
          Число подписчиков приходит из YouTube Data API и обновляется ежедневно.
          Если автор скрыл статистику, показывается «скрыто».
        </p>
      </div>
    </div>
  );
}
