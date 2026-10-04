import { useCallback, useEffect, useState } from 'react';
import * as api from './api';
import type { ClaudeStatus } from './api';
import { navigate } from './router';

/** Link to /settings, used in the rooms and room headers. */
export function SettingsLink() {
  return (
    <a
      className="btn small"
      href="/settings"
      data-testid="settings-link"
      onClick={(e) => {
        if (e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return;
        e.preventDefault();
        navigate('/settings');
      }}
    >
      Settings
    </a>
  );
}

type Phase =
  | { step: 'idle' }
  | { step: 'starting' }
  | { step: 'code'; loginId: string; url: string }
  | { step: 'finishing' };

function describe(status: ClaudeStatus): string {
  const who = status.account?.email ?? status.account?.organization;
  switch (status.method) {
    case 'oauth_login':
      return `Signed in with a Claude subscription login${who ? ` (${who})` : ''}`;
    case 'oauth_token':
      return 'Signed in with a Claude token (CLAUDE_CODE_OAUTH_TOKEN)';
    case 'api_key':
      return 'Using an Anthropic API key (ANTHROPIC_API_KEY)';
    default:
      return 'Not signed in';
  }
}

export function SettingsScreen() {
  const [status, setStatus] = useState<ClaudeStatus | null>(null);
  const [phase, setPhase] = useState<Phase>({ step: 'idle' });
  const [code, setCode] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const refresh = useCallback(() => {
    api
      .claudeStatus()
      .then((s) => {
        setStatus(s);
        setError(null);
      })
      .catch((e) => setError(e instanceof Error ? e.message : 'Could not read the Claude status'));
  }, []);
  useEffect(refresh, [refresh]);

  async function begin() {
    setError(null);
    setPhase({ step: 'starting' });
    try {
      const login = await api.claudeLoginStart();
      // Only ever render an https link, so a bad response cannot become a javascript: URL.
      if (!/^https:\/\//i.test(login.url))
        throw new Error('The server offered a sign-in link that is not safe to open.');
      setPhase({ step: 'code', loginId: login.loginId, url: login.url });
    } catch (e) {
      setPhase({ step: 'idle' });
      setError(e instanceof Error ? e.message : 'Could not start the sign-in');
    }
  }

  async function finish() {
    if (phase.step !== 'code') return;
    const { loginId, url } = phase;
    setError(null);
    setPhase({ step: 'finishing' });
    try {
      setStatus(await api.claudeLoginCode(loginId, api.normalizeCode(code)));
      setCode('');
      setPhase({ step: 'idle' });
    } catch (e) {
      setPhase({ step: 'code', loginId, url });
      setError(e instanceof Error ? e.message : 'That code was not accepted');
    }
  }

  function cancel() {
    if (phase.step === 'code') void api.claudeLoginCancel(phase.loginId).catch(() => undefined);
    setPhase({ step: 'idle' });
    setCode('');
    setError(null);
  }

  async function signOut() {
    setBusy(true);
    setError(null);
    try {
      setStatus(await api.claudeLogout());
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not sign out');
    } finally {
      setBusy(false);
    }
  }

  const flowOpen = phase.step === 'code' || phase.step === 'finishing';

  return (
    <div className="settings-screen">
      <div className="screen-head">
        <h1>Settings</h1>
        <span className="spacer" />
        <a
          className="btn small"
          href="/rooms"
          onClick={(e) => {
            e.preventDefault();
            navigate('/rooms');
          }}
        >
          Back to rooms
        </a>
      </div>

      <section className="settings-card" aria-labelledby="claude-account-heading">
        <h2 id="claude-account-heading">Claude account</h2>
        <p className="muted small-text">
          The agent runs on this server&apos;s Claude credential. This uses the owner&apos;s
          personal Claude login and must not be offered to other people.
        </p>

        <div className="settings-status">
          <span data-testid="claude-status">
            {status ? describe(status) : error ? 'Status unavailable' : 'Checking…'}
          </span>
        </div>

        {error && (
          <p className="error" role="alert">
            {error}
          </p>
        )}

        {status && !flowOpen && (
          <div className="settings-actions">
            {!status.signedIn && (
              <button
                type="button"
                className="btn primary"
                data-testid="claude-signin"
                disabled={phase.step === 'starting'}
                onClick={() => void begin()}
              >
                {phase.step === 'starting' ? 'Opening…' : 'Sign in with Claude'}
              </button>
            )}
            {status.method === 'oauth_login' && (
              <button
                type="button"
                className="btn"
                data-testid="claude-signout"
                disabled={busy}
                onClick={() => void signOut()}
              >
                Sign out
              </button>
            )}
            {(status.method === 'oauth_token' || status.method === 'api_key') && (
              <span className="muted small-text">
                This credential comes from the server&apos;s environment and is changed there.
              </span>
            )}
          </div>
        )}

        {flowOpen && (
          <div className="settings-flow">
            <ol className="settings-steps">
              <li>
                {phase.step === 'code' ? (
                  <a
                    href={phase.url}
                    target="_blank"
                    rel="noreferrer"
                    data-testid="claude-signin-link"
                  >
                    Open the Claude sign-in page
                  </a>
                ) : (
                  'Open the Claude sign-in page'
                )}{' '}
                in a new tab and approve access.
              </li>
              <li>
                Copy the code it shows you (or the whole address you are sent to) and paste it here.
              </li>
            </ol>
            <input
              data-testid="claude-code"
              aria-label="Claude sign-in code"
              placeholder="Paste the code or the address"
              autoComplete="off"
              spellCheck={false}
              value={code}
              onChange={(e) => setCode(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && code.trim() && phase.step === 'code') void finish();
              }}
            />
            <div className="settings-actions">
              <button
                type="button"
                className="btn primary"
                data-testid="claude-code-submit"
                disabled={!code.trim() || phase.step !== 'code'}
                onClick={() => void finish()}
              >
                {phase.step === 'finishing' ? 'Checking…' : 'Finish'}
              </button>
              <button
                type="button"
                className="btn"
                data-testid="claude-cancel"
                disabled={phase.step === 'finishing'}
                onClick={cancel}
              >
                Cancel
              </button>
            </div>
          </div>
        )}
      </section>
    </div>
  );
}
