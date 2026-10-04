import { useEffect, useMemo, useState } from 'react';
import type { VotingRule } from '@quorum/shared';
import { RoomProvider, useRoom } from './store';
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

export function RoomScreen(props: { roomId: string; you: { userId: string; displayName: string } }) {
  return (
    <RoomProvider roomId={props.roomId} you={props.you}>
      <RoomInner />
    </RoomProvider>
  );
}

function RoomInner() {
  const { state, you, send, roomId, dismissError } = useRoom();
  const [diff, setDiff] = useState<DiffRequest | null>(null);
  const [railOpen, setRailOpen] = useState(true);
  const [selectedDocId, setSelectedDocId] = useState<string | null>(null);
  const [view, setView] = useState<{ proposalId: string; optionId: string } | null>(null);

  const ui = useMemo(() => ({ openDiff: setDiff }), []);

  const branch: BranchView | null = useMemo(() => {
    if (!view) return null;
    const p = state.proposals.find((x) => x.id === view.proposalId);
    const o = p?.options.find((x) => x.id === view.optionId);
    if (!p || !o) return null;
    return { proposalId: p.id, optionId: o.id, documentId: p.documentId, branch: o.branch, label: o.label, headSha: o.headSha };
  }, [view, state.proposals]);

  useEffect(() => {
    document.title = state.room ? `${state.room.name} - Quorum` : 'Quorum';
  }, [state.room]);

  if (!state.loaded || !state.room) {
    return <div className="center-screen">{state.connected ? 'Loading room…' : 'Connecting…'}</div>;
  }
  const room = state.room;

  return (
    <UiContext.Provider value={ui}>
      <div className="room">
        <div className="room-header">
          <h2 data-testid="room-name">{room.name}</h2>
          <span className="spacer" />
          {!state.connected && <span className="pill warn">Reconnecting…</span>}
          {room.ownerId === you.userId ? (
            <label className="rule-select">
              Voting rule
              <select
                data-testid="rule-select"
                value={room.votingRule}
                onChange={(e) => send({ type: 'room.setRule', votingRule: e.target.value as VotingRule })}
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
        {state.agentStatus === 'unavailable' && (
          <div className="banner info" role="status" data-testid="agent-unavailable-banner">
            <span>
              The agent is not signed in.{' '}
              <a
                href="/settings"
                onClick={(e) => {
                  if (e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return;
                  e.preventDefault();
                  navigate('/settings');
                }}
              >
                Sign in to Claude in Settings
              </a>
            </span>
          </div>
        )}
        {state.error && (
          <div className="banner error" role="alert">
            <span>{state.error}</span>
            <button type="button" className="btn small" aria-label="Dismiss error" onClick={dismissError}>
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
        {diff && <DiffDrawer request={diff} onClose={() => setDiff(null)} />}
      </div>
    </UiContext.Provider>
  );
}
