import type { Proposal, ProposalState } from '@quorum/shared';
import { useRoom } from '../../store';
import { ProposalDiffButton } from '../Chat/Cards';

const ARCHIVED: ProposalState[] = ['rejected', 'expired', 'superseded', 'abandoned'];
const MERGED: ProposalState[] = ['merged', 'reverted'];

export function groupProposals(proposals: Proposal[]) {
  const open: Proposal[] = [];
  const stale: Proposal[] = [];
  const archived: Proposal[] = [];
  const merged: Proposal[] = [];
  for (const p of proposals) {
    if (MERGED.includes(p.state)) merged.push(p);
    else if (ARCHIVED.includes(p.state)) archived.push(p);
    else if (p.stale) stale.push(p);
    else open.push(p);
  }
  return { open, stale, archived, merged };
}

export function Rail(props: {
  activeOptionId: string | null;
  onViewBranch: (proposalId: string, optionId: string, documentId: string) => void;
}) {
  const { state } = useRoom();
  const g = groupProposals(state.proposals);
  const sections: Array<[string, Proposal[]]> = [
    ['Open', g.open],
    ['Stale', g.stale],
    ['Archived', g.archived],
    ['Merged', g.merged],
  ];
  return (
    <aside className="pane rail" aria-label="Branch rail" data-testid="rail">
      {sections.map(([title, list]) => (
        <section key={title} className="rail-section">
          <h3>
            {title} <span className="muted">({list.length})</span>
          </h3>
          {list.length === 0 && <p className="muted small-text">None</p>}
          {list.map((p) => (
            <div
              key={p.id}
              className={`rail-item state-${p.state}`}
              data-testid={`rail-proposal-${p.id}`}
            >
              <div className="rail-item-head">
                <span className="pill">{p.kind}</span>
                <span className={`pill state-${p.state}`}>{p.state}</span>
                {p.stale && <span className="pill warn">stale</span>}
              </div>
              <div className="rail-title">{p.title}</div>
              <ul className="rail-options">
                {p.options.map((o) => (
                  <li key={o.id} className={props.activeOptionId === o.id ? 'active' : ''}>
                    <button
                      type="button"
                      className="btn small link"
                      data-testid={`rail-option-${o.id}`}
                      aria-pressed={props.activeOptionId === o.id}
                      title={`Show branch ${o.branch} in the canvas`}
                      onClick={() => props.onViewBranch(p.id, o.id, p.documentId)}
                    >
                      {o.label}: <code>{o.branch}</code>
                    </button>
                    {props.activeOptionId === o.id && (
                      <ProposalDiffButton proposal={p} option={o} label="diff vs main" />
                    )}
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </section>
      ))}
    </aside>
  );
}
