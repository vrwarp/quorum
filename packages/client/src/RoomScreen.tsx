import { useCallback, useEffect, useMemo, useState } from 'react';
import type { VotingRule } from '@quorum/shared';
import { needsSignIn } from './agentStatus';
import { RoomProvider, useCommand, useRoom } from './store';
import { UiContext } from './ui';
import type { DiffRequest } from './ui';
import { Chat } from './components/Chat/Chat';
import { Canvas } from './components/Canvas/Canvas';
import type { BranchView } from './components/Canvas/Canvas';
import { Rail } from './components/Rail/Rail';
import { DiffDrawer } from './components/Diff/DiffDrawer';
import { UsageFooter } from './components/UsageFooter';
import { SettingsLink } from './SettingsScreen';
import { navigate } from './router';

export function RoomScreen(props: {
  roomId: string;
  you: { userId: string; displayName: string };
  /** the server no longer accepts this session: back to the login screen */
  onSessionEnded: () => void;
}) {
  return (
    <RoomProvider roomId={props.roomId} you={props.you}>
      <RoomInner onSessionEnded={props.onSessionEnded} />
    </RoomProvider>
  );
}

function AgentBanner({ detail }: { detail: string | null }) {
  return (
    <div className="banner info" role="status" data-testid="agent-unavailable-banner">
      {needsSignIn(detail) ? (
        <span>
          The agent is not signed in.{' '}
          <a
            href="/settings"
            data-testid="agent-banner-settings"
            onClick={(e) => {
              if (e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return;
              e.preventDefault();
              navigate('/settings');
            }}
          >
            Sign in to Claude in Settings
          </a>
        </span>
      ) : (
        <span>The agent is unavailable{detail ? `: ${detail}` : '.'}</span>
      )}
    </div>
  );
}

function BackToRooms() {
  return (
    <a
      href="/rooms"
      onClick={(e) => {
        if (e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return;
        e.preventDefault();
        navigate('/rooms');
      }}
    >
      Back to rooms
    </a>
  );
}

function RoomInner({ onSessionEnded }: { onSessionEnded: () => void }) {
  const { state, you, roomId, dismissError } = useRoom();
  const archiveCmd = useCommand();
  const ruleCmd = useCommand();
  const [diff, setDiff] = useState<DiffRequest | null>(null);
  const [railOpen, setRailOpen] = useState(true);
  const [confirmingArchive, setConfirmingArchive] = useState(false);
  const [selectedDocId, setSelectedDocId] = useState<string | null>(null);
  const [view, setView] = useState<{ proposalId: string; optionId: string } | null>(null);

  const closeDiff = useCallback(() => setDiff(null), []);
  const ui = useMemo(() => ({ openDiff: setDiff }), []);

  const branch: BranchView | null = useMemo(() => {
    if (!view) return null;
    const p = state.proposals.find((x) => x.id === view.proposalId);
    const o = p?.options.find((x) => x.id === view.optionId);
    if (!p || !o) return null;
    return {
      proposalId: p.id,
      optionId: o.id,
      documentId: p.documentId,
      branch: o.branch,
      label: o.label,
      headSha: o.headSha,
    };
  }, [view, state.proposals]);

  useEffect(() => {
    document.title = state.room ? `${state.room.name} - Quorum` : 'Quorum';
  }, [state.room]);

  if (state.fatal === 'unauthorized') {
    return (
      <div className="center-screen" role="alert" data-testid="room-session-ended">
        <div className="stack">
          <p>Your session has ended.</p>
          <button type="button" className="btn primary" onClick={onSessionEnded}>
            Log in again
          </button>
        </div>
      </div>
    );
  }
  if (state.fatal === 'not_found') {
    return (
      <div className="center-screen" data-testid="room-not-found">
        <div className="stack">
          <p>This room does not exist.</p>
          <BackToRooms />
        </div>
      </div>
    );
  }
  if (state.fatal === 'archived' && !state.loaded) {
    return (
      <div className="center-screen" data-testid="room-archived-notice">
        <div className="stack">
          <p>This room is archived and can no longer be joined.</p>
          <BackToRooms />
        </div>
      </div>
    );
  }
  if (!state.loaded || !state.room) {
    return <div className="center-screen">{state.connected ? 'Loading room…' : 'Connecting…'}</div>;
  }
  const room = state.room;
  const isOwner = room.ownerId === you.userId;
  const archived = !!room.archivedAt;

  return (
    <UiContext.Provider value={ui}>
      <div className="room">
        <div className="room-header">
          <h2 data-testid="room-name">{room.name}</h2>
          <span className="spacer" />
          {!state.connected && !state.fatal && <span className="pill warn">Reconnecting…</span>}
          {isOwner ? (
            <label className="rule-select">
              Voting rule
              <select
                data-testid="rule-select"
                value={room.votingRule}
                disabled={archived}
                onChange={(e) =>
                  ruleCmd.run({ type: 'room.setRule', votingRule: e.target.value as VotingRule })
                }
              >
                <option value="unanimous">Unanimous</option>
                <option value="majority">Majority</option>
              </select>
            </label>
          ) : (
            <span className="muted small-text" data-testid="rule-label">
              Rule: {room.votingRule}
            </span>
          )}
          {isOwner && !archived && (
            <button
              type="button"
              className="btn small danger"
              data-testid="room-archive"
              aria-expanded={confirmingArchive}
              onClick={() => setConfirmingArchive((v) => !v)}
            >
              Archive room
            </button>
          )}
          <SettingsLink />
          <button
            type="button"
            className="btn small"
            data-testid="rail-toggle"
            aria-expanded={railOpen}
            aria-label={railOpen ? 'Collapse branch rail' : 'Expand branch rail'}
            onClick={() => setRailOpen((v) => !v)}
          >
            {railOpen ? 'Hide branches' : 'Branches'}
          </button>
        </div>
        {confirmingArchive && isOwner && !archived && (
          <div
            className="banner warn"
            role="group"
            aria-label="Archive this room"
            data-testid="room-archive-confirm"
          >
            <span>
              Archive this room? Everyone can still read it, but nobody can chat, suggest, vote or
              revert any more, and it leaves the rooms list.
            </span>
            <span className="banner-actions">
              <button
                type="button"
                className="btn small danger"
                data-testid="room-archive-yes"
                onClick={() => {
                  if (archiveCmd.run({ type: 'room.archive' }, () => setConfirmingArchive(true)))
                    setConfirmingArchive(false);
                }}
              >
                Archive room
              </button>
              <button
                type="button"
                className="btn small"
                data-testid="room-archive-cancel"
                onClick={() => setConfirmingArchive(false)}
              >
                Cancel
              </button>
            </span>
          </div>
        )}
        {ruleCmd.error && (
          <div className="banner error" role="alert" data-testid="rule-error">
            <span>{ruleCmd.error}</span>
          </div>
        )}
        {archiveCmd.error && (
          <div className="banner error" role="alert" data-testid="room-archive-error">
            <span>{archiveCmd.error}</span>
          </div>
        )}
        {archived && (
          <div className="banner info" role="status" data-testid="room-archived-banner">
            <span>
              This room is archived and read-only: nothing can be added, changed or voted on.
            </span>
            <BackToRooms />
          </div>
        )}
        {state.agentStatus === 'unavailable' && <AgentBanner detail={state.agentDetail} />}
        {state.error && (
          <div className="banner error" role="alert">
            <span>{state.error}</span>
            <button
              type="button"
              className="btn small"
              aria-label="Dismiss error"
              onClick={dismissError}
            >
              ×
            </button>
          </div>
        )}
        <div className={`room-grid${railOpen ? '' : ' rail-closed'}`}>
          <Chat />
          <Canvas
            selectedId={selectedDocId}
            onSelect={(id) => {
              setSelectedDocId(id);
              setView(null);
            }}
            branch={branch}
            onExitBranch={() => setView(null)}
          />
          {railOpen && (
            <Rail
              activeOptionId={view?.optionId ?? null}
              onViewBranch={(proposalId, optionId, documentId) => {
                setSelectedDocId(documentId);
                setView({ proposalId, optionId });
              }}
            />
          )}
        </div>
        <UsageFooter roomId={roomId} />
        {diff && <DiffDrawer request={diff} onClose={closeDiff} />}
      </div>
    </UiContext.Provider>
  );
}
