import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from '../api.js';
import { getSocket } from '../socket.js';
import {
  clearGroupKey,
  decryptFile,
  decryptMessage,
  encryptFile,
  encryptMessage,
  generateGroupKey,
  generateIdentity,
  getStoredGroupKey,
  getStoredIdentity,
  samePublicKey,
  storeGroupKey,
  storeIdentity,
  unwrapGroupKey,
  wrapGroupKey,
} from '../crypto.js';
import { formatBytes, formatDate, formatTime, kindForFile } from '../format.js';
import Avatar from './Avatar.jsx';
import { Icon } from './Icons.jsx';

const mediaCache = new Map();

function AttachmentView({ attachment }) {
  const [url, setUrl] = useState(() => mediaCache.get(attachment.s3Key) || '');
  const [status, setStatus] = useState(url ? 'ready' : 'loading');
  const [playbackError, setPlaybackError] = useState(false);

  useEffect(() => {
    if (url) return undefined;
    let alive = true;
    (async () => {
      try {
        const response = await fetch(`/api/media/${attachment.s3Key}`, {
          credentials: 'include',
        });
        if (!response.ok) throw new Error('Файл недоступен');
        const encrypted = await response.arrayBuffer();
        const plain = await decryptFile(encrypted, attachment.key, attachment.iv);
        const objectUrl = URL.createObjectURL(
          new Blob([plain], { type: attachment.mime || 'application/octet-stream' }),
        );
        mediaCache.set(attachment.s3Key, objectUrl);
        if (alive) {
          setUrl(objectUrl);
          setStatus('ready');
        }
      } catch {
        if (alive) setStatus('error');
      }
    })();
    return () => {
      alive = false;
    };
  }, [attachment.s3Key, attachment.key, attachment.iv, attachment.mime, url]);

  if (status === 'loading') {
    return (
      <div className="attachment loading">
        <Icon name="lock" size={16} />
        Расшифровываем «{attachment.name}»…
      </div>
    );
  }
  if (status === 'error') {
    return (
      <div className="attachment error">
        <Icon name="info" size={16} />
        Не удалось расшифровать медиа
      </div>
    );
  }

  const kind = attachment.kind || (attachment.mime?.startsWith('video/') ? 'video' : 'image');

  if (kind === 'image') {
    return (
      <figure className="attachment image-attachment">
        <a href={url} target="_blank" rel="noreferrer">
          <img src={url} alt={attachment.name} loading="lazy" />
        </a>
        <figcaption>
          <Icon name="image" size={13} /> {attachment.name} · {formatBytes(attachment.size)}
        </figcaption>
      </figure>
    );
  }
  if (kind === 'video' || kind === 'audio') {
    return (
      <div className="attachment media-attachment">
        {kind === 'video' ? (
          playbackError ? (
            <a href={url} target="_blank" rel="noreferrer" className="btn btn-dark btn-sm">
              <Icon name="download" size={14} /> Открыть видео
            </a>
          ) : (
            <video
              src={url}
              controls
              preload="metadata"
              onError={() => setPlaybackError(true)}
            />
          )
        ) : (
          <audio src={url} controls preload="metadata" />
        )}
        <span className="attachment-caption">
          <Icon name={kind === 'video' ? 'video' : 'file'} size={13} />
          {attachment.name} · {formatBytes(attachment.size)}
        </span>
      </div>
    );
  }

  return (
    <a className="attachment file-attachment" href={url} download={attachment.name}>
      <span className="file-icon"><Icon name="file" size={20} /></span>
      <span>
        <strong>{attachment.name}</strong>
        <small>{formatBytes(attachment.size)}</small>
      </span>
      <Icon name="download" size={17} />
    </a>
  );
}

function renderText(text) {
  const parts = String(text || '').split(/(https?:\/\/[^\s]+)/g);
  return parts.map((part, index) => {
    if (/^https?:\/\//.test(part)) {
      return (
        <a key={index} href={part} target="_blank" rel="noreferrer">
          {part}
        </a>
      );
    }
    return <span key={index}>{part}</span>;
  });
}

const ATTACHMENT_LABEL = {
  image: 'Изображение',
  video: 'Видео',
  audio: 'Аудио',
  file: 'Файл',
};

export default function Chat({ me, refreshMe, onOpenProfile }) {
  const { user } = me;
  const [identity, setIdentity] = useState(null);
  const [groupKey, setGroupKey] = useState(null);
  const [keyState, setKeyState] = useState('loading');
  const [messages, setMessages] = useState([]);
  const [members, setMembers] = useState([]);
  const [online, setOnline] = useState([]);
  const [text, setText] = useState('');
  const [files, setFiles] = useState([]);
  const [sending, setSending] = useState(false);
  const [uploadStatus, setUploadStatus] = useState('');
  const [error, setError] = useState('');
  const [loadingMessages, setLoadingMessages] = useState(true);
  const [hasMore, setHasMore] = useState(false);
  const [loadingOlder, setLoadingOlder] = useState(false);

  const identityRef = useRef(null);
  const groupKeyRef = useRef(null);
  const meRef = useRef(me);
  const attempted = useRef(new Set());
  const listRef = useRef(null);
  const bottomRef = useRef(null);
  const fileInputRef = useRef(null);

  useEffect(() => {
    meRef.current = me;
  }, [me]);

  useEffect(() => {
    identityRef.current = identity;
  }, [identity]);

  useEffect(() => {
    groupKeyRef.current = groupKey;
  }, [groupKey]);

  const nearBottom = () => {
    const element = listRef.current;
    if (!element) return true;
    return element.scrollHeight - element.scrollTop - element.clientHeight < 220;
  };

  const scrollBottom = (smooth = false) => {
    requestAnimationFrame(() => {
      bottomRef.current?.scrollIntoView({ behavior: smooth ? 'smooth' : 'auto' });
    });
  };

  const loadGroupKey = useCallback(async (identityArg) => {
    let local = getStoredGroupKey(user.id);

    if (!local) {
      const response = await api.get('/api/keys/me');
      if (response.key) {
        try {
          const bytes = await unwrapGroupKey(response.key, identityArg.privateKey);
          storeGroupKey(user.id, bytes, response.key.epoch);
          local = { key: bytes, epoch: response.key.epoch };
        } catch {
          setError(
            'Ключ группы не подошёл к текущему устройству. Импортируйте резервную копию в профиле.',
          );
        }
      }
    }

    if (!local) {
      const current = meRef.current;
      if (current.canBootstrapKey) {
        const bytes = generateGroupKey();
        storeGroupKey(user.id, bytes, 1);
        local = { key: bytes, epoch: 1 };
      }
    }

    if (local) {
      groupKeyRef.current = local;
      setGroupKey(local);
      setKeyState('ready');
      return true;
    }
    setKeyState('waiting');
    return false;
  }, [user.id]);

  const shareTo = useCallback(
    async (member) => {
      const currentKey = groupKeyRef.current;
      if (!currentKey || !member?.publicKey || member.id === user.id) return;
      if (member.hasKey) return;
      const signature = `${member.id}:${member.publicKey.x}:${member.publicKey.y}:${currentKey.epoch}`;
      if (attempted.current.has(signature)) return;
      attempted.current.add(signature);
      try {
        const wrapped = await wrapGroupKey(currentKey.key, member.publicKey);
        await api.post('/api/keys/share', {
          targetUserId: member.id,
          epoch: currentKey.epoch,
          ...wrapped,
        });
      } catch {
        attempted.current.delete(signature);
      }
    },
    [user.id],
  );

  const decryptOne = useCallback(
    async (message) => {
      const currentKey = groupKeyRef.current;
      if (!currentKey || message.epoch !== currentKey.epoch) {
        return { ...message, content: null };
      }
      try {
        const content = await decryptMessage(
          message.ciphertext,
          message.iv,
          currentKey.key,
        );
        if (!content || typeof content.text !== 'string' || !Array.isArray(content.attachments)) {
          throw new Error('bad payload');
        }
        return { ...message, content };
      } catch {
        return { ...message, content: null };
      }
    },
    [],
  );

  const loadMessages = useCallback(
    async ({ before = null, initial = false } = {}) => {
      if (initial) setLoadingMessages(true);
      else setLoadingOlder(true);
      try {
        const query = new URLSearchParams({ limit: '50' });
        if (before) query.set('before', String(before));
        const response = await api.get(`/api/messages?${query.toString()}`);
        const decrypted = await Promise.all(response.messages.map(decryptOne));
        setHasMore(response.messages.length === 50);
        if (initial) {
          setMessages(decrypted);
          scrollBottom();
        } else {
          setMessages((previous) => [...decrypted, ...previous]);
          const element = listRef.current;
          if (element) element.scrollTop += 200;
        }
      } catch (err) {
        setError(err.message);
      } finally {
        setLoadingMessages(false);
        setLoadingOlder(false);
      }
    },
    [decryptOne],
  );

  const syncMembers = useCallback(async () => {
    try {
      const response = await api.get('/api/members');
      setMembers(response.members);
      setOnline(response.online || []);
      const currentKey = groupKeyRef.current;
      if (currentKey) {
        for (const member of response.members) {
          await shareTo(member);
        }
      }
    } catch {
      /* members list is not critical for chat */
    }
  }, [shareTo]);

  // 1. Identity key bootstrap (private key never leaves this browser).
  useEffect(() => {
    let alive = true;
    (async () => {
      setKeyState('loading');
      try {
        let stored = getStoredIdentity(user.id);

        if (stored && user.publicKey && !samePublicKey(stored.publicKey, user.publicKey)) {
          if (alive) setKeyState('need_identity');
          return;
        }
        if (!stored && user.publicKey) {
          if (alive) setKeyState('need_identity');
          return;
        }
        if (!stored) {
          stored = await generateIdentity();
          await api.put('/api/keys/public', { publicKey: stored.publicKey });
          storeIdentity(user.id, stored);
          identityRef.current = stored;
          if (alive) setIdentity(stored);
          await refreshMe();
        } else if (!user.publicKey) {
          await api.put('/api/keys/public', { publicKey: stored.publicKey });
          await refreshMe();
        }

        if (!alive) return;
        identityRef.current = stored;
        setIdentity(stored);
        await loadGroupKey(stored);
      } catch (err) {
        if (alive) {
          setError(err.message);
          setKeyState('error');
        }
      }
    })();
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user.id]);

  // 2. Wait for a group key from another member.
  useEffect(() => {
    if (keyState !== 'waiting' || !identity) return undefined;
    const timer = setInterval(() => {
      loadGroupKey(identity).catch(() => {});
    }, 4000);
    return () => clearInterval(timer);
  }, [keyState, identity, loadGroupKey]);

  // 3. Load chat and share the key with members who do not have it yet.
  useEffect(() => {
    if (keyState !== 'ready') return undefined;
    loadMessages({ initial: true });
    syncMembers();
    const timer = setInterval(() => syncMembers(), 60_000);
    return () => clearInterval(timer);
  }, [keyState, loadMessages, syncMembers]);

  // 4. Real-time events.
  useEffect(() => {
    const socket = getSocket();

    const onNew = (message) => {
      const shouldScroll = nearBottom();
      decryptOne(message).then((decrypted) => {
        setMessages((previous) => {
          if (previous.some((item) => item.id === decrypted.id)) return previous;
          return [...previous, decrypted];
        });
        if (shouldScroll) scrollBottom(true);
      });
    };
    const onDeleted = ({ id }) => {
      setMessages((previous) => previous.filter((message) => message.id !== id));
    };
    const onPresence = ({ ids }) => setOnline(ids || []);
    const onKeyShared = () => {
      const currentIdentity = identityRef.current;
      if (currentIdentity) loadGroupKey(currentIdentity).catch(() => {});
    };
    const onMemberJoined = (member) => {
      setMembers((previous) => {
        if (!member?.id || previous.some((item) => item.id === member.id)) return previous;
        return [...previous, { ...member, hasKey: false }];
      });
      if (member) shareTo({ ...member, hasKey: false });
    };
    const onMemberUpdated = (member) => {
      if (!member?.id) return;
      setMembers((previous) =>
        previous.map((item) =>
          item.id === member.id
            ? { ...item, ...member, hasKey: member.hasKey ?? item.hasKey }
            : item,
        ),
      );
      if (member.publicKey) shareTo({ ...member, hasKey: false });
    };

    socket.on('message:new', onNew);
    socket.on('message:deleted', onDeleted);
    socket.on('presence', onPresence);
    socket.on('key:shared', onKeyShared);
    socket.on('member:joined', onMemberJoined);
    socket.on('member:updated', onMemberUpdated);

    return () => {
      socket.off('message:new', onNew);
      socket.off('message:deleted', onDeleted);
      socket.off('presence', onPresence);
      socket.off('key:shared', onKeyShared);
      socket.off('member:joined', onMemberJoined);
      socket.off('member:updated', onMemberUpdated);
    };
  }, [decryptOne, loadGroupKey, shareTo]);

  const createNewIdentity = async () => {
    if (
      !window.confirm(
        'Создать новые ключи? Старые сообщения на этом устройстве станут недоступны. ' +
          'Продолжайте только если у вас нет резервной копии.',
      )
    ) {
      return;
    }
    setKeyState('loading');
    setError('');
    try {
      const fresh = await generateIdentity();
      await api.put('/api/keys/public', { publicKey: fresh.publicKey, replace: true });
      storeIdentity(user.id, fresh);
      clearGroupKey(user.id);
      identityRef.current = fresh;
      setIdentity(fresh);
      await refreshMe();
      await loadGroupKey(fresh);
    } catch (err) {
      setError(err.message);
      setKeyState('need_identity');
    }
  };

  const addFiles = (selected) => {
    const limits = me.config?.limits || {};
    const limitFor = {
      image: limits.imageMb || 8,
      video: limits.videoMb || 50,
      audio: limits.audioMb || 15,
      file: limits.fileMb || 10,
    };
    const maxCount = limits.maxAttachments || 4;
    const next = [...files];
    for (const file of selected) {
      if (next.length >= maxCount) {
        setError(`Можно прикрепить не больше ${maxCount} файлов`);
        break;
      }
      const kind = kindForFile(file);
      const maxMb = limitFor[kind];
      if (file.size > maxMb * 1024 * 1024) {
        setError(`«${file.name}» больше ${maxMb} МБ (${ATTACHMENT_LABEL[kind]})`);
        continue;
      }
      if (file.size === 0) {
        setError(`«${file.name}» пустой`);
        continue;
      }
      next.push(file);
    }
    setFiles(next);
  };

  const removeFile = (index) => {
    setFiles((previous) => previous.filter((_, itemIndex) => itemIndex !== index));
  };

  const send = async () => {
    if (sending || !groupKey) return;
    const trimmed = text.trim();
    if (!trimmed && files.length === 0) return;
    setSending(true);
    setError('');
    try {
      const attachments = [];
      for (const file of files) {
        setUploadStatus(`Шифруем и загружаем «${file.name}»…`);
        const buffer = await file.arrayBuffer();
        const encrypted = await encryptFile(new Uint8Array(buffer));
        const kind = kindForFile(file);
        const query = new URLSearchParams({
          kind,
          size: String(file.size),
        });
        const uploaded = await api.upload(`/api/media/upload?${query.toString()}`, encrypted.ciphertext);
        attachments.push({
          s3Key: uploaded.key,
          key: encrypted.key,
          iv: encrypted.iv,
          name: file.name,
          mime: file.type || 'application/octet-stream',
          size: file.size,
          kind,
        });
      }

      setUploadStatus('Шифруем сообщение…');
      const payload = { text: trimmed, attachments };
      const encrypted = await encryptMessage(payload, groupKey.key);
      const body = {
        ...encrypted,
        epoch: groupKey.epoch,
        mediaKeys: attachments.map((attachment) => attachment.s3Key),
      };

      let response;
      const socket = getSocket();
      if (socket.connected) {
        response = await new Promise((resolve) => {
          const timer = setTimeout(
            () => resolve({ error: 'Сервер не ответил. Попробуйте ещё раз.' }),
            20_000,
          );
          socket.emit('message:send', body, (result) => {
            clearTimeout(timer);
            resolve(result || {});
          });
        });
      } else {
        try {
          const result = await api.post('/api/messages', body);
          response = { ok: true, message: result.message };
        } catch (err) {
          response = { error: err.message };
        }
      }

      if (response.error) throw new Error(response.error);

      if (response.message) {
        const decrypted = await decryptOne(response.message);
        setMessages((previous) =>
          previous.some((item) => item.id === decrypted.id) ? previous : [...previous, decrypted],
        );
      }
      setText('');
      setFiles([]);
      scrollBottom(true);
    } catch (err) {
      setError(err.message);
    } finally {
      setSending(false);
      setUploadStatus('');
    }
  };

  const removeMessage = async (id) => {
    if (!window.confirm('Удалить это сообщение у всех участников?')) return;
    try {
      await api.del(`/api/messages/${id}`);
      setMessages((previous) => previous.filter((message) => message.id !== id));
    } catch (err) {
      setError(err.message);
    }
  };

  const onComposerKeyDown = (event) => {
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      send();
    }
  };

  const onPickFiles = (event) => {
    addFiles([...event.target.files]);
    event.target.value = '';
  };

  const loadingKey = keyState === 'loading';
  const canWrite = keyState === 'ready' && Boolean(groupKey);

  return (
    <div className="chat-page">
      <section className="chat-panel">
        <div className="chat-header">
          <div className="chat-title">
            <span className="chat-avatar"><Icon name="send" size={20} /></span>
            <div>
              <h1>Общий чат</h1>
              <span>
                <Icon name="lock" size={12} /> Сквозное шифрование · {members.length || me.slots?.taken || 0}{' '}
                участников
              </span>
            </div>
          </div>
          <div className="chat-header-right">
            <span className="online-pill"><span className="online-dot" />{online.length} онлайн</span>
            <span className="e2ee-pill"><Icon name="shield" size={14} /> E2EE</span>
          </div>
        </div>

        {error && (
          <div className="notice notice-error chat-notice">
            <Icon name="info" size={16} />
            <span>{error}</span>
            <button className="notice-close" type="button" onClick={() => setError('')}>
              <Icon name="x" size={14} />
            </button>
          </div>
        )}

        {!canWrite && !loadingKey && (
          <div className="key-gate">
            {keyState === 'need_identity' && (
              <div className="key-gate-card">
                <span className="key-gate-icon"><Icon name="key" size={26} /></span>
                <h2>На этом устройстве нет ключей</h2>
                <p>
                  Приватный ключ не покидает браузер, поэтому на новом устройстве его нужно
                  восстановить из резервной копии. Если копии нет — можно создать новые ключи,
                  но старые сообщения останутся недоступны.
                </p>
                <div className="inline-actions">
                  <button className="btn btn-primary" type="button" onClick={onOpenProfile}>
                    <Icon name="upload" size={15} /> Восстановить из профиля
                  </button>
                  <button className="btn btn-ghost" type="button" onClick={createNewIdentity}>
                    Создать новые ключи
                  </button>
                </div>
              </div>
            )}

            {keyState === 'waiting' && (
              <div className="key-gate-card">
                <span className="key-gate-icon pulse"><Icon name="lock" size={26} /></span>
                <h2>Ожидаем ключ шифрования</h2>
                <p>
                  Ключ группы передают только участники — сервер его не знает. Как только
                  кто-то из участников с ключом будет онлайн, доступ откроется автоматически.
                  Это обычно занимает несколько секунд.
                </p>
                <button
                  className="btn btn-primary"
                  type="button"
                  onClick={() => identity && loadGroupKey(identity).catch(() => {})}
                >
                  <Icon name="refresh" size={15} /> Проверить снова
                </button>
              </div>
            )}

            {keyState === 'error' && (
              <div className="key-gate-card">
                <span className="key-gate-icon"><Icon name="info" size={26} /></span>
                <h2>Не удалось подготовить ключи</h2>
                <p>{error || 'Проверьте соединение и обновите страницу.'}</p>
                <button className="btn btn-primary" type="button" onClick={() => window.location.reload()}>
                  Обновить
                </button>
              </div>
            )}
          </div>
        )}

        {loadingKey && (
          <div className="key-gate">
            <div className="key-gate-card">
              <div className="boot-loader"><span /><span /><span /></div>
              <p>Готовим ключи шифрования…</p>
            </div>
          </div>
        )}

        {canWrite && (
          <>
            <div className="message-list" ref={listRef}>
              {hasMore && (
                <button
                  className="load-older"
                  type="button"
                  disabled={loadingOlder}
                  onClick={() => loadMessages({ before: messages[0]?.id })}
                >
                  {loadingOlder ? 'Загружаем…' : 'Загрузить более ранние сообщения'}
                </button>
              )}

              {loadingMessages ? (
                <div className="message-skeleton">
                  <span /><span /><span />
                </div>
              ) : messages.length === 0 ? (
                <div className="empty-chat">
                  <span className="empty-icon"><Icon name="lock" size={28} /></span>
                  <h3>Пока тихо</h3>
                  <p>
                    Напишите первое сообщение. Оно зашифруется в вашем браузере,
                    и сервер увидит только набор байтов.
                  </p>
                </div>
              ) : (
                messages.map((message, index) => {
                  const previous = messages[index - 1];
                  const newDay =
                    !previous ||
                    new Date(previous.createdAt).toDateString() !==
                      new Date(message.createdAt).toDateString();
                  return (
                    <div key={message.id}>
                      {newDay && (
                        <div className="day-divider">
                          <span>{formatDate(message.createdAt)}</span>
                        </div>
                      )}
                      <article className={`message ${message.userId === user.id ? 'own' : ''}`}>
                        <Avatar user={message.user} size={36} />
                        <div className="message-body">
                          <div className="message-meta">
                            <strong>{message.user?.channelTitle || message.user?.displayName}</strong>
                            {message.user?.isAdmin && (
                              <span className="admin-badge" title="Администратор">
                                <Icon name="crown" size={12} />
                              </span>
                            )}
                            {message.userId === user.id && <span className="you-badge">вы</span>}
                            <time>{formatTime(message.createdAt)}</time>
                            {(message.userId === user.id || user.isAdmin) && (
                              <button
                                className="message-delete"
                                type="button"
                                title="Удалить сообщение"
                                onClick={() => removeMessage(message.id)}
                              >
                                <Icon name="trash" size={13} />
                              </button>
                            )}
                          </div>

                          {message.content ? (
                            <>
                              {message.content.text && (
                                <p className="message-text">{renderText(message.content.text)}</p>
                              )}
                              {message.content.attachments?.length > 0 && (
                                <div className="message-attachments">
                                  {message.content.attachments.map((attachment, attachmentIndex) => (
                                    <AttachmentView
                                      key={`${message.id}-${attachmentIndex}`}
                                      attachment={attachment}
                                    />
                                  ))}
                                </div>
                              )}
                            </>
                          ) : (
                            <p className="message-broken">
                              <Icon name="lock" size={13} />
                              Сообщение зашифровано недоступным ключом
                            </p>
                          )}
                        </div>
                      </article>
                    </div>
                  );
                })
              )}
              <div ref={bottomRef} />
            </div>

            <div className="composer">
              {files.length > 0 && (
                <div className="file-chips">
                  {files.map((file, index) => (
                    <span className="file-chip" key={`${file.name}-${index}`}>
                      <Icon name={kindForFile(file)} size={14} />
                      <span>{file.name}</span>
                      <small>{formatBytes(file.size)}</small>
                      <button type="button" onClick={() => removeFile(index)} title="Убрать">
                        <Icon name="x" size={12} />
                      </button>
                    </span>
                  ))}
                </div>
              )}

              {uploadStatus && (
                <div className="upload-status">
                  <span className="spinner" /> {uploadStatus}
                </div>
              )}

              <div className="composer-row">
                <input
                  ref={fileInputRef}
                  type="file"
                  multiple
                  accept="image/*,video/*,audio/*,.pdf,.zip,.txt,.doc,.docx"
                  hidden
                  onChange={onPickFiles}
                />
                <button
                  className="composer-attach"
                  type="button"
                  title="Прикрепить файл"
                  onClick={() => fileInputRef.current?.click()}
                  disabled={sending || !me.config?.mediaEnabled}
                >
                  <Icon name="paperclip" size={20} />
                </button>
                <textarea
                  rows={1}
                  value={text}
                  maxLength={4000}
                  placeholder="Сообщение для всех участников…"
                  onChange={(event) => setText(event.target.value)}
                  onKeyDown={onComposerKeyDown}
                  disabled={sending}
                />
                <button
                  className="composer-send"
                  type="button"
                  onClick={send}
                  disabled={sending || (!text.trim() && files.length === 0)}
                  title="Отправить (Enter)"
                >
                  {sending ? <span className="spinner light" /> : <Icon name="send" size={19} />}
                </button>
              </div>
              <div className="composer-foot">
                <span><Icon name="lock" size={12} /> Шифруется на этом устройстве</span>
                <span>Enter — отправить · Shift+Enter — новая строка</span>
              </div>
            </div>
          </>
        )}
      </section>

      <aside className="chat-sidebar">
        <div className="sidebar-card">
          <div className="sidebar-head">
            <h3>В сети</h3>
            <span>{online.length}</span>
          </div>
          <div className="online-list">
            {members
              .filter((member) => online.includes(member.id))
              .slice(0, 12)
              .map((member) => (
                <div className="online-member" key={member.id}>
                  <span className="online-avatar">
                    <Avatar user={member} size={32} />
                    <span className="online-dot" />
                  </span>
                  <div>
                    <strong>{member.channelTitle || member.displayName}</strong>
                    <span>{member.isAdmin ? 'админ' : member.channelHandle || 'автор'}</span>
                  </div>
                </div>
              ))}
            {online.length === 0 && <p className="muted small">Пока никого нет онлайн.</p>}
          </div>
        </div>

        <div className="sidebar-card sidebar-note">
          <Icon name="shield" size={20} />
          <h3>Только участники</h3>
          <p>
            Сообщения и медиа зашифрованы ключом группы. Сервер хранит шифротекст и не может
            прочитать содержимое. Не передавайте ключи третьим лицам.
          </p>
        </div>

        <div className="sidebar-card sidebar-note">
          <Icon name="key" size={20} />
          <h3>Бэкап ключей</h3>
          <p>
            Приватный ключ хранится в этом браузере. Сделайте резервную копию в профиле,
            иначе при очистке данных доступ к истории будет потерян.
          </p>
          <button className="btn btn-dark btn-sm" type="button" onClick={onOpenProfile}>
            Открыть профиль
          </button>
        </div>
      </aside>
    </div>
  );
}
