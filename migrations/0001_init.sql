CREATE TABLE repos (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT,
  public_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  provisioned_at INTEGER,
  deleted_at INTEGER
);
CREATE UNIQUE INDEX repos_name ON repos(name);

CREATE TABLE invites (
  id TEXT PRIMARY KEY,
  label TEXT NOT NULL,
  code_hash TEXT NOT NULL UNIQUE,
  clone_password_hash TEXT UNIQUE,
  access_ms INTEGER,
  redeem_by_at INTEGER NOT NULL,
  all_repos_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  redeemed_at INTEGER,
  access_expires_at INTEGER,
  revoked_at INTEGER,
  deleted_at INTEGER
);

CREATE TABLE invite_repos (
  invite_id TEXT NOT NULL REFERENCES invites(id),
  repo_id TEXT NOT NULL REFERENCES repos(id),
  created_at INTEGER NOT NULL,
  deleted_at INTEGER,
  PRIMARY KEY (invite_id, repo_id)
);
CREATE INDEX invite_repos_repo ON invite_repos(repo_id);

CREATE TABLE push_tokens (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  token_hash TEXT NOT NULL UNIQUE,
  expires_at INTEGER,
  all_repos_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  last_used_at INTEGER,
  revoked_at INTEGER,
  deleted_at INTEGER
);

CREATE TABLE push_token_repos (
  push_token_id TEXT NOT NULL REFERENCES push_tokens(id),
  repo_id TEXT NOT NULL REFERENCES repos(id),
  created_at INTEGER NOT NULL,
  deleted_at INTEGER,
  PRIMARY KEY (push_token_id, repo_id)
);

CREATE TABLE webhooks (
  id TEXT PRIMARY KEY,
  repo_id TEXT NOT NULL REFERENCES repos(id),
  url TEXT NOT NULL,
  branch TEXT,
  secret TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  deleted_at INTEGER
);
CREATE INDEX webhooks_repo ON webhooks(repo_id);
