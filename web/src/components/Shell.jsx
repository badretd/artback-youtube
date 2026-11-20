import { useEffect, useRef, useState } from 'react';
import { api } from '../api.js';
import { getSocket } from '../socket.js';
import { getStoredGroupKey, wrapGroupKey } from '../crypto.js';
import Avatar from './Avatar.jsx';
import Brand from './Brand.jsx';
import Chat from './Chat.jsx';
import Members from './Members.jsx';
import Admin from './Admin.jsx';
import Profile from './Profile.jsx';
import { Icon } from './Icons.jsx';

const TABS = [
  { id: 'chat', label: 'Чат', icon: 'send' },
  { id: 'members', label: 'Авторы', icon: 'users' },
  { id: 'admin', label: 'Админка', icon: 'shield', adminOnly: true },
  { id: 'profile', label: 'Профиль', icon: 'user' },
];

export default function Shell({ me, refresh, logout }) {
  const [tab, setTab] = useState('chat');
  const [online, setOnline] = useState([]);
  const [syncTick, setSyncTick] = useState(0);
  const [toast, setToast] = useState(null);
  const toastTimer = useRef(null);

  const showToast = (text, kind = 'info') => {
    setToast({ text, kind });
    clearTimeout(toastTimer.current);
    toastTimer.current = setTimeout(() => setToast(null), 3500);
  };

  useEffect(() => {
    const socket = getSocket();
    const onPresence = ({ ids }) => setOnline(ids || []);
    const onSynced = () => setSyncTick((value) => value + 1);
    const onJoined = (member) => {
      if (member?.id !== me.user.id) {
        showToast(
          `${member?.channelTitle || member?.displayName || 'Новый участник'} присоединился к клубу`,
          'ok',
        );
        setSyncTick((value) => value + 1);
      }
    };
    const onRemoved = () => setSyncTick((value) => value + 1);

    socket.on('presence', onPresence);
    socket.on('members:synced', onSynced);
    socket.on('member:joined', onJoined);
    socket.on('member:removed', onRemoved);

    return () => {
      socket.off('presence', onPresence);
      socket.off('members:synced', onSynced);
      socket.off('member:joined', onJoined);
      socket.off('member:removed', onRemoved);
    };
  }, [me.user.id]);

  useEffect(() => () => clearTimeout(toastTimer.current), []);

  // Distribute the group key to members who don't have it yet, even if the
  // key holder is not currently on the Chat tab.
  useEffect(() => {
    let alive = true;
    const attempted = new Set();
    const socket = getSocket();

    const run = async () => {
      const groupKey = getStoredGroupKey(me.user.id);
      if (!groupKey) return;
      try {
        const response = await api.get('/api/members');
        if (!alive) return;
        for (const member of response.members || []) {
          if (member.id === me.user.id || member.hasKey || !member.publicKey) continue;
          const signature = `${member.id}:${member.publicKey.x}:${member.publicKey.y}:${groupKey.epoch}`;
          if (attempted.has(signature)) continue;
          attempted.add(signature);
          try {
            const wrapped = await wrapGroupKey(groupKey.key, member.publicKey);
            await api.post('/api/keys/share', {
              targetUserId: member.id,
              epoch: groupKey.epoch,
              ...wrapped,
            });
          } catch {
            attempted.delete(signature);
          }
        }
      } catch {
        /* not critical */
      }
    };

    run();
    const timer = setInterval(run, 30_000);
    socket.on('member:joined', run);
    socket.on('member:updated', run);

    return () => {
      alive = false;
      clearInterval(timer);
      socket.off('member:joined', run);
      socket.off('member:updated', run);
    };
  }, [me.user.id]);

  useEffect(() => {
    if (tab === 'admin' && !me.user.isAdmin) setTab('chat');
  }, [tab, me.user.isAdmin]);

  const tabs = TABS.filter((item) => !item.adminOnly || me.user.isAdmin);

  return (
    <div className="app-shell">
      <header className="app-topbar">
        <Brand size="md" />
        <nav className="desktop-nav">
          {tabs.map((item) => (
            <button
              key={item.id}
              className={`nav-btn ${tab === item.id ? 'active' : ''}`}
              onClick={() => setTab(item.id)}
              type="button"
            >
              <Icon name={item.icon} size={17} />
              {item.label}
            </button>
          ))}
        </nav>

        <div className="topbar-actions">
          <span className="online-pill">
            <span className="online-dot" />
            {online.length} онлайн
          </span>
          <button
            type="button"
            className="user-chip"
            onClick={() => setTab('profile')}
          >
            <Avatar user={me.user} size={32} />
            <span className="user-chip-text">
              <strong>{me.user.channelTitle || me.user.displayName}</strong>
              <span>
                {me.user.isAdmin ? 'администратор' : `участник #${me.user.memberNumber}`}
              </span>
            </span>
          </button>
        </div>
      </header>

      <main className="app-content">
        {tab === 'chat' && (
          <Chat me={me} refreshMe={refresh} onOpenProfile={() => setTab('profile')} />
        )}
        {tab === 'members' && <Members me={me} syncTick={syncTick} online={online} />}
        {tab === 'admin' && me.user.isAdmin && (
          <Admin me={me} refresh={refresh} onSynced={() => setSyncTick((value) => value + 1)} />
        )}
        {tab === 'profile' && (
          <Profile me={me} refresh={refresh} logout={logout} onOpenChat={() => setTab('chat')} />
        )}
      </main>

      <nav className="mobile-nav">
        {tabs.map((item) => (
          <button
            key={item.id}
            className={tab === item.id ? 'active' : ''}
            onClick={() => setTab(item.id)}
            type="button"
          >
            <Icon name={item.icon} size={20} />
            <span>{item.label}</span>
          </button>
        ))}
      </nav>

      {toast && (
        <div className={`toast toast-${toast.kind}`}>
          <Icon name="info" size={16} />
          {toast.text}
        </div>
      )}
    </div>
  );
}
