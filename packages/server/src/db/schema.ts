/**
 * SQLite schema as an ordered list of migrations. `openStorage` applies every migration whose index is
 * greater than `PRAGMA user_version`, each inside a transaction. Never edit a shipped migration; append.
 */
export const migrations: string[] = [
  `
  CREATE TABLE users (
    id TEXT PRIMARY KEY,
    displayName TEXT NOT NULL UNIQUE,
    createdAt TEXT NOT NULL
  );

  CREATE TABLE sessions (
    token TEXT PRIMARY KEY,
    userId TEXT NOT NULL,
    createdAt TEXT NOT NULL
  );

  CREATE TABLE rooms (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    ownerId TEXT NOT NULL,
    votingRule TEXT NOT NULL,
    createdAt TEXT NOT NULL,
    archivedAt TEXT
  );

  CREATE TABLE participants (
    roomId TEXT NOT NULL,
    userId TEXT NOT NULL,
    displayName TEXT NOT NULL,
    role TEXT NOT NULL,
    PRIMARY KEY (roomId, userId)
  );

  CREATE TABLE presence (
    roomId TEXT NOT NULL,
    userId TEXT NOT NULL,
    connected INTEGER NOT NULL,
    lastSeenAt TEXT NOT NULL,
    PRIMARY KEY (roomId, userId)
  );

  CREATE TABLE messages (
    seq INTEGER PRIMARY KEY AUTOINCREMENT,
    id TEXT NOT NULL UNIQUE,
    roomId TEXT NOT NULL,
    author TEXT NOT NULL,
    kind TEXT NOT NULL,
    body TEXT NOT NULL,
    card TEXT,
    anchor TEXT,
    privateTo TEXT,
    inReplyTo TEXT NOT NULL,
    createdAt TEXT NOT NULL
  );
  CREATE INDEX messages_room_seq ON messages (roomId, seq);

  CREATE TABLE documents (
    id TEXT PRIMARY KEY,
    roomId TEXT NOT NULL,
    path TEXT NOT NULL,
    title TEXT NOT NULL,
    status TEXT NOT NULL,
    createdAt TEXT NOT NULL
  );
  CREATE UNIQUE INDEX documents_active_path ON documents (roomId, path) WHERE status = 'active';
  CREATE INDEX documents_room ON documents (roomId);

  CREATE TABLE proposals (
    id TEXT PRIMARY KEY,
    roomId TEXT NOT NULL,
    documentId TEXT NOT NULL,
    kind TEXT NOT NULL,
    state TEXT NOT NULL,
    title TEXT NOT NULL,
    branchBase TEXT NOT NULL,
    windowClosesAt TEXT,
    stale INTEGER NOT NULL DEFAULT 0,
    reconciled INTEGER NOT NULL DEFAULT 0,
    mergedOptionId TEXT,
    mergeSha TEXT,
    triggerMessageIds TEXT NOT NULL,
    cardMessageId TEXT,
    openedAt TEXT,
    closedAt TEXT,
    createdAt TEXT NOT NULL
  );
  CREATE INDEX proposals_room ON proposals (roomId);

  CREATE TABLE options (
    id TEXT PRIMARY KEY,
    proposalId TEXT NOT NULL,
    position INTEGER NOT NULL,
    label TEXT NOT NULL,
    branch TEXT NOT NULL,
    summary TEXT NOT NULL,
    tradeoffs TEXT NOT NULL,
    headSha TEXT
  );
  CREATE INDEX options_proposal ON options (proposalId, position);

  CREATE TABLE votes (
    proposalId TEXT NOT NULL,
    userId TEXT NOT NULL,
    optionId TEXT,
    decision TEXT NOT NULL,
    castAt TEXT NOT NULL,
    PRIMARY KEY (proposalId, userId)
  );

  CREATE TABLE changes (
    sha TEXT PRIMARY KEY,
    roomId TEXT NOT NULL,
    documentId TEXT NOT NULL,
    actor TEXT NOT NULL,
    summary TEXT NOT NULL,
    triggerMessageIds TEXT NOT NULL,
    proposalId TEXT,
    revertsSha TEXT,
    revertedBySha TEXT,
    createdAt TEXT NOT NULL
  );
  CREATE INDEX changes_room ON changes (roomId, createdAt);

  CREATE TABLE usage (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    roomId TEXT NOT NULL,
    sessionId TEXT NOT NULL,
    role TEXT NOT NULL,
    model TEXT NOT NULL,
    inputTokens INTEGER NOT NULL,
    outputTokens INTEGER NOT NULL,
    cacheReadTokens INTEGER NOT NULL,
    costUsd REAL NOT NULL,
    at TEXT NOT NULL
  );
  CREATE INDEX usage_room ON usage (roomId);
  `,
  // 2: the first registered user is the admin (the one who may manage the server's Claude sign-in). Existing
  // deployments promote their oldest user.
  `
  ALTER TABLE users ADD COLUMN admin INTEGER NOT NULL DEFAULT 0;
  UPDATE users SET admin = 1 WHERE rowid = (SELECT MIN(rowid) FROM users);
  `,
  // 3: agent messages carry a short summary shown in chat, with the body behind an expander
  `
  ALTER TABLE messages ADD COLUMN summary TEXT;
  `,
];
