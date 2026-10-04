import {
  newId,
  type Card,
  type Change,
  type Document,
  type Message,
  type Participant,
  type Proposal,
  type RoomState,
  type UsageRecord,
} from '@quorum/shared';
import type { RoomActions, RoomRepository } from '../../contracts/index.js';

export interface StubOptions {
  roomId?: string;
  repo: RoomRepository;
  documents?: Array<Pick<Document, 'path' | 'title'> & Partial<Document>>;
  participants?: Array<{ userId: string; displayName: string }>;
}

export interface StubActions {
  actions: RoomActions;
  roomId: string;
  repo: RoomRepository;
  documents: Document[];
  messages: Message[];
  changes: Change[];
  proposals: Proposal[];
  usage: UsageRecord[];
  statuses: Array<{ status: string; detail?: string | null }>;
  /** names of every RoomActions method called, in order */
  calls: string[];
  /** helper: add a human message to the transcript and return it */
  human(userId: string, displayName: string, body: string, extra?: Partial<Message>): Message;
}

/** In-memory RoomActions for unit tests: records everything the runtime does. */
export function createStubActions(opts: StubOptions): StubActions {
  const roomId = opts.roomId ?? 'room_test';
  const calls: string[] = [];
  const messages: Message[] = [];
  const changes: Change[] = [];
  const proposals: Proposal[] = [];
  const usage: UsageRecord[] = [];
  const statuses: StubActions['statuses'] = [];
  const documents: Document[] = (opts.documents ?? []).map((d, i) => ({
    id: d.id ?? `doc_${i + 1}`,
    roomId,
    path: d.path,
    title: d.title,
    status: d.status ?? 'active',
    createdAt: new Date().toISOString(),
  }));
  const participants: Participant[] = (opts.participants ?? []).map((p) => ({
    roomId,
    userId: p.userId,
    displayName: p.displayName,
    role: 'member',
  }));

  const mk = (partial: Partial<Message> & Pick<Message, 'author' | 'body'>): Message => ({
    id: newId('msg'),
    roomId,
    kind: partial.card ? 'card' : 'text',
    card: null,
    anchor: null,
    privateTo: null,
    inReplyTo: [],
    createdAt: new Date().toISOString(),
    ...partial,
  });

  const actions: RoomActions = {
    async postChat(_room, input) {
      calls.push('postChat');
      const m = mk({
        author: { kind: 'agent', role: 'orchestrator' },
        body: input.body,
        card: input.card ?? null,
        anchor: input.anchor ?? null,
        inReplyTo: input.inReplyTo ?? [],
      });
      messages.push(m);
      return m;
    },
    async updateCard(_room, messageId, card: Card) {
      calls.push('updateCard');
      const m = messages.find((x) => x.id === messageId);
      if (!m) throw new Error(`no message ${messageId}`);
      m.card = card;
      return m;
    },
    async sendPrivate(_room, userId, input) {
      calls.push('sendPrivate');
      const m = mk({
        author: { kind: 'agent', role: 'digest' },
        body: input.body,
        card: input.card ?? null,
        privateTo: userId,
      });
      messages.push(m);
      return m;
    },
    async readTranscript(_room, o) {
      calls.push('readTranscript');
      let out = messages.filter((m) => !m.privateTo);
      if (o.ids) out = out.filter((m) => o.ids!.includes(m.id));
      if (o.sinceMessageId) {
        const idx = out.findIndex((m) => m.id === o.sinceMessageId);
        if (idx >= 0) out = out.slice(idx + 1);
      }
      return o.limit ? out.slice(-o.limit) : out;
    },
    async getRoomState(): Promise<RoomState> {
      calls.push('getRoomState');
      const headSha = await opts.repo.headSha('main');
      return {
        room: {
          id: roomId,
          name: 'Test room',
          ownerId: participants[0]?.userId ?? 'user_owner',
          votingRule: 'unanimous',
          createdAt: new Date().toISOString(),
          archivedAt: null,
        },
        participants,
        presence: participants.map((p) => ({
          userId: p.userId,
          displayName: p.displayName,
          connected: true,
          lastSeenAt: new Date().toISOString(),
        })),
        documents: documents.map((d) => ({ ...d, headSha })),
        proposals,
        recentMessages: messages.slice(-200),
        agentStatus: 'idle',
      };
    },
    async getDocument(_room, documentId) {
      calls.push('getDocument');
      return documents.find((d) => d.id === documentId) ?? null;
    },
    async recordChange(_room, change) {
      calls.push('recordChange');
      const full: Change = {
        ...change,
        roomId,
        createdAt: new Date().toISOString(),
        revertedBySha: null,
      };
      changes.push(full);
      return full;
    },
    async openProposal(_room, input) {
      calls.push('openProposal');
      const id = newId('prop');
      const p: Proposal = {
        id,
        roomId,
        documentId: input.documentId,
        kind: input.kind,
        state: 'open',
        title: input.title,
        branchBase: input.branchBase,
        options: input.options.map((o) => ({
          id: newId('opt'),
          proposalId: id,
          label: o.label,
          branch: o.branch,
          summary: o.summary,
          tradeoffs: o.tradeoffs,
          headSha: null,
        })),
        votes: [],
        windowClosesAt: null,
        stale: input.stale ?? false,
        reconciled: false,
        mergedOptionId: null,
        mergeSha: null,
        triggerMessageIds: input.triggerMessageIds,
        cardMessageId: null,
        openedAt: new Date().toISOString(),
        closedAt: null,
        createdAt: new Date().toISOString(),
      };
      proposals.push(p);
      return p;
    },
    async closeProposal(_room, proposalId, reason, note) {
      calls.push('closeProposal');
      const p = proposals.find((x) => x.id === proposalId);
      if (!p) throw new Error(`no proposal ${proposalId}`);
      p.state = reason === 'rejected' ? 'rejected' : reason === 'expired' ? 'expired' : 'abandoned';
      void note;
      return p;
    },
    async requestMerge() {
      calls.push('requestMerge');
    },
    async setAgentStatus(_room, status, detail) {
      calls.push('setAgentStatus');
      statuses.push({ status, detail });
    },
    async recordUsage(record) {
      calls.push('recordUsage');
      usage.push(record);
    },
    async repo() {
      calls.push('repo');
      return opts.repo;
    },
  };

  return {
    actions,
    roomId,
    repo: opts.repo,
    documents,
    messages,
    changes,
    proposals,
    usage,
    statuses,
    calls,
    human(userId, displayName, body, extra = {}) {
      const m = mk({ author: { kind: 'user', userId, displayName }, body, ...extra });
      messages.push(m);
      return m;
    },
  };
}
