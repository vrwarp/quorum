import { useState } from 'react';
import type { FormEvent } from 'react';
import * as api from './api';
import type { Me } from './api';

export function LoginScreen({ onLogin }: { onLogin: (u: Me) => void }) {
  const [displayName, setDisplayName] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      onLogin(await api.login({ displayName: displayName.trim(), password }));
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Login failed');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="center-screen">
      <form className="card-form" onSubmit={submit}>
        <h1>Quorum</h1>
        <label>
          Display name
          <input
            data-testid="login-name"
            value={displayName}
            onChange={(e) => setDisplayName(e.target.value)}
            autoComplete="nickname"
            autoFocus
            required
          />
        </label>
        <label>
          Password
          <input
            data-testid="login-password"
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            autoComplete="current-password"
            required
          />
        </label>
        {error && (
          <p className="error" role="alert">
            {error}
          </p>
        )}
        <button className="btn primary" data-testid="login-submit" type="submit" disabled={busy || !displayName.trim()}>
          Join
        </button>
      </form>
    </div>
  );
}
