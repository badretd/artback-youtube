import { useCallback, useEffect, useState } from 'react';
import { api, AUTH_ERRORS } from './api.js';
import { connectSocket, disconnectSocket } from './socket.js';
import Brand from './components/Brand.jsx';
import Landing from './components/Landing.jsx';
import Onboarding from './components/Onboarding.jsx';
import Shell from './components/Shell.jsx';

export default function App() {
  const [me, setMe] = useState(null);
  const [config, setConfig] = useState(null);
  const [loading, setLoading] = useState(true);
  const [bootError, setBootError] = useState('');
  const [authError, setAuthError] = useState('');

  const refresh = useCallback(async () => {
    const cfg = await api.get('/api/config');
    setConfig(cfg);
    try {
      const data = await api.get('/api/me');
      setMe(data);
      return data;
    } catch (error) {
      if (error.status === 401) {
        setMe(null);
        return null;
      }
      throw error;
    }
  }, []);

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const errorCode = params.get('auth_error');
    if (errorCode) {
      setAuthError(AUTH_ERRORS[errorCode] || 'Не удалось войти. Попробуйте ещё раз.');
      params.delete('auth_error');
    }
    params.delete('auth_ok');
    const query = params.toString();
    window.history.replaceState(
      {},
      '',
      `${window.location.pathname}${query ? `?${query}` : ''}${window.location.hash}`,
    );

    refresh()
      .catch((error) => setBootError(error.message || 'Не удалось подключиться к серверу'))
      .finally(() => setLoading(false));
  }, [refresh]);

  useEffect(() => {
    if (me?.user?.status === 'verified') connectSocket();
    else disconnectSocket();
  }, [me]);

  const logout = useCallback(async () => {
    await api.post('/api/auth/logout').catch(() => {});
    disconnectSocket();
    setMe(null);
    setAuthError('');
  }, []);

  const onAuth = useCallback(async () => {
    setAuthError('');
    await refresh();
  }, [refresh]);

  if (loading) {
    return (
      <div className="boot-screen">
        <Brand size="lg" />
        <div className="boot-loader">
          <span />
          <span />
          <span />
        </div>
        <p className="muted">Проверяем сессию и загружаем сообщество…</p>
      </div>
    );
  }

  if (bootError) {
    return (
      <div className="boot-screen">
        <Brand size="lg" />
        <div className="notice notice-error" style={{ maxWidth: 520, marginTop: 24 }}>
          {bootError}
        </div>
        <button className="btn btn-primary" style={{ marginTop: 18 }} onClick={() => window.location.reload()}>
          Повторить
        </button>
      </div>
    );
  }

  if (!me) {
    return (
      <Landing
        config={config}
        authError={authError}
        onAuth={onAuth}
        onClearError={() => setAuthError('')}
      />
    );
  }

  if (me.user.status === 'pending') {
    return <Onboarding me={me} refresh={refresh} logout={logout} authError={authError} />;
  }

  return <Shell me={me} refresh={refresh} logout={logout} />;
}
