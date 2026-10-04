import { useCallback, useEffect, useState } from 'react';
import * as api from './api';
import type { Me } from './api';
import { navigate, parseRoute, usePath } from './router';
import { LoginScreen } from './LoginScreen';
import { RoomsScreen } from './RoomsScreen';
import { RoomScreen } from './RoomScreen';
import { SettingsScreen } from './SettingsScreen';

export function App() {
  const path = usePath();
  const route = parseRoute(path);
  const [user, setUser] = useState<Me | null>(null);
  const [checked, setChecked] = useState(false);

  useEffect(() => {
    api
      .me()
      .then(setUser)
      .catch(() => setUser(null))
      .finally(() => setChecked(true));
  }, []);

  const onLogin = useCallback((u: Me) => {
    setUser(u);
    if (parseRoute(location.pathname).name === 'home') navigate('/rooms');
  }, []);

  const onLogout = useCallback(async () => {
    try {
      await api.logout();
    } catch {
      /* ignore */
    }
    setUser(null);
    navigate('/', true);
  }, []);

  if (!checked) return <div className="center-screen">Loading…</div>;
  if (!user) return <LoginScreen onLogin={onLogin} />;

  return (
    <div className="app">
      <header className="topbar">
        <a
          className="brand"
          href="/rooms"
          onClick={(e) => {
            e.preventDefault();
            navigate('/rooms');
          }}
        >
          Quorum
        </a>
        <span className="spacer" />
        <span className="whoami" data-testid="whoami">
          {user.displayName}
        </span>
        <button type="button" className="btn small" onClick={onLogout}>
          Log out
        </button>
      </header>
      <main className="app-main">
        {route.name === 'room' ? (
          <RoomScreen key={route.roomId} roomId={route.roomId} you={user} />
        ) : route.name === 'settings' ? (
          <SettingsScreen />
        ) : route.name === 'unknown' ? (
          <div className="center-screen">Page not found.</div>
        ) : (
          <RoomsScreen />
        )}
      </main>
    </div>
  );
}
