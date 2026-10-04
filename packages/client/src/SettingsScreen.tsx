import { useCallback, useEffect, useRef, useState } from 'react';
import * as api from './api';
import type { ClaudeStatus, Me } from './api';
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

/**
 * A 4xx on the code (other than the rate limit) means the server has ended that login: the CLI process is gone and
 * the same login cannot be tried again. Anything else (rate limit, network, server trouble) leaves it pending.
 */
export function endsLogin(e: unknown): boolean {
  return e instanceof api.ApiError && e.status >= 400 && e.status < 500 && e.status !== 429;
}

export function SettingsScreen() {
  const [me, setMe] = useState<Me | null>(null);
  const [status, setStatus] = useState<ClaudeStatus | null>(null);
  const [phase, setPhase] = useState<Phase>({ step: 'idle' });
  const [code, setCode] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  /** the last code was rejected, which ended its login: the next step is a new one */
  const [startAgain, setStartAgain] = useState(false);
  /** the login this screen started and has not finished or cancelled; it is cancelled if the screen goes away */
  const pendingLogin = useRef<string | null>(null);

  // Only the first registered user may sign the agent in; /api/me says whether this is them. A server that does not
  // say (isAdmin absent) is left to refuse.
  const isAdmin = me === null ? null : me.isAdmin !== false;

  useEffect(() => {
    let cancelled = false;
    api
      .me()
      .then((m) => !cancelled && setMe(m))
      .catch(() => !cancelled && setMe({ userId: '', displayName: '' }));
    return () => {
      cancelled = true;
    };
  }, []);

  const refresh = useCallback(() => {
    api
      .claudeStatus()
      .then((s) => {
        setStatus(s);
        setError(null);
      })
      .catch((e) => setError(e instanceof Error ? e.message : 'Could not read the Claude status'));
  }, []);
  // The status is the admin's to see: nobody else is asked for it (the server would only refuse).
  useEffect(() => {
    if (isAdmin) refresh();
  }, [isAdmin, refresh]);

  // Leaving the screen (or closing the tab) with a sign-in half done would leave its CLI process running.
  useEffect(() => {
    const cancelPending = () => {
      const id = pendingLogin.current;
      if (!id) return;
      pendingLogin.current = null;
      void api.claudeLoginCancel(id).catch(() => undefined);
    };
    const onHide = () => {
      const id = pendingLogin.current;
      if (id)
        navigator.sendBeacon?.(
          '/api/claude/login/cancel',
          new Blob([JSON.stringify({ loginId: id })], { type: 'application/json' }),
        );
    };
    window.addEventListener('pagehide', onHide);
    return () => {
      window.removeEventListener('pagehide', onHide);
      cancelPending();
    };
  }, []);

  async function begin() {
    setError(null);
    setPhase({ step: 'starting' });
    try {
      const login = await api.claudeLoginStart();
      // Only ever render an https link, so a bad response cannot become a javascript: URL.
      if (!/^https:\/\//i.test(login.url)) {
        void api.claudeLoginCancel(login.loginId).catch(() => undefined);
        throw new Error('The server offered a sign-in link that is not safe to open.');
      }
      pendingLogin.current = login.loginId;
      setStartAgain(false);
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
      pendingLogin.current = null;
      setCode('');
      setStartAgain(false);
      setPhase({ step: 'idle' });
    } catch (e) {
      const message = e instanceof Error ? e.message : 'That code was not accepted';
      if (endsLogin(e)) {
        // the server ended this login with the rejection: only a new one can work
        pendingLogin.current = null;
        setCode('');
        setStartAgain(true);
        setPhase({ step: 'idle' });
      } else {
        setPhase({ step: 'code', loginId, url });
      }
      setError(message);
    }
  }

  function cancel() {
    const id = pendingLogin.current;
    if (id) void api.claudeLoginCancel(id).catch(() => undefined);
    pendingLogin.current = null;
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
        <p className="muted small-text" data-testid="claude-admin-note">
          Only the first registered user can sign the agent in.
          {isAdmin === false && ' That is not you, so the sign-in controls are hidden.'}
        </p>

        {isAdmin !== false && (
          <div className="settings-status">
            <span data-testid="claude-status">
              {status ? describe(status) : error ? 'Status unavailable' : 'Checking…'}
            </span>
          </div>
        )}

        {error && isAdmin !== false && (
          <p className="error" role="alert">
            {error}
          </p>
        )}

        {isAdmin && status && !flowOpen && (
          <div className="settings-actions">
            {!status.signedIn && (
              <button
                type="button"
                className="btn primary"
                data-testid="claude-signin"
                disabled={phase.step === 'starting'}
                onClick={() => void begin()}
              >
                {phase.step === 'starting'
                  ? 'Opening…'
                  : startAgain
                    ? 'Start again'
                    : 'Sign in with Claude'}
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

        {isAdmin && flowOpen && (
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
