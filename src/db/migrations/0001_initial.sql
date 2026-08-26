-- Better Auth adapter-compatible identity/session/token tables.
CREATE TABLE IF NOT EXISTS user (id TEXT PRIMARY KEY, name TEXT NOT NULL, email TEXT NOT NULL UNIQUE, emailVerified INTEGER NOT NULL DEFAULT 0, image TEXT, createdAt INTEGER NOT NULL, updatedAt INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS account (id TEXT PRIMARY KEY, issuer TEXT NOT NULL, accountId TEXT NOT NULL, providerId TEXT NOT NULL, userId TEXT NOT NULL REFERENCES user(id) ON DELETE CASCADE, accessToken TEXT, refreshToken TEXT, idToken TEXT, accessTokenExpiresAt INTEGER, refreshTokenExpiresAt INTEGER, scope TEXT, password TEXT, createdAt INTEGER NOT NULL, updatedAt INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS session (id TEXT PRIMARY KEY, expiresAt INTEGER NOT NULL, token TEXT NOT NULL UNIQUE, createdAt INTEGER NOT NULL, updatedAt INTEGER NOT NULL, ipAddress TEXT, userAgent TEXT, userId TEXT NOT NULL REFERENCES user(id) ON DELETE CASCADE);
CREATE TABLE IF NOT EXISTS verification (id TEXT PRIMARY KEY, identifier TEXT NOT NULL, value TEXT NOT NULL, expiresAt INTEGER NOT NULL, createdAt INTEGER NOT NULL, updatedAt INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS pool_registry (pool_id TEXT PRIMARY KEY, normalized_slug TEXT NOT NULL UNIQUE, do_name TEXT NOT NULL UNIQUE, creator_id TEXT NOT NULL REFERENCES user(id), status TEXT NOT NULL CHECK(status IN ('initializing','ready','failed')), command_id TEXT NOT NULL UNIQUE, last_error TEXT, created_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS pool_registry_command_response (command_id TEXT PRIMARY KEY, normalized_slug TEXT NOT NULL, creator_id TEXT NOT NULL, initialization_fingerprint TEXT NOT NULL, response_json TEXT NOT NULL, command_version TEXT NOT NULL, created_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS membership_projection (pool_id TEXT NOT NULL, user_id TEXT NOT NULL, pool_name TEXT NOT NULL, role TEXT NOT NULL, status TEXT NOT NULL, projection_version TEXT NOT NULL, PRIMARY KEY(pool_id, user_id));
CREATE TABLE IF NOT EXISTS season_projection (pool_id TEXT NOT NULL, season_id TEXT NOT NULL, label TEXT NOT NULL, state TEXT NOT NULL, opened_at TEXT, closed_at TEXT, projection_version TEXT NOT NULL, PRIMARY KEY(pool_id, season_id));
CREATE TABLE IF NOT EXISTS sports_event (id TEXT PRIMARY KEY, provider_event_id TEXT NOT NULL UNIQUE, league TEXT NOT NULL, home_team TEXT NOT NULL, away_team TEXT NOT NULL, starts_at TEXT NOT NULL, status TEXT NOT NULL, home_score TEXT, away_score TEXT, correction_version TEXT NOT NULL, finalized_at TEXT, last_polled_at TEXT, omitted_at TEXT, event_name TEXT, postseason INTEGER NOT NULL DEFAULT 0);
CREATE TABLE IF NOT EXISTS market_offer (event_id TEXT NOT NULL REFERENCES sports_event(id), market TEXT NOT NULL, canonical_book TEXT NOT NULL, retrieved_at TEXT NOT NULL, offer_version TEXT NOT NULL, payload_json TEXT NOT NULL, PRIMARY KEY(event_id, market));
CREATE TABLE IF NOT EXISTS odds_ingestion (provider TEXT PRIMARY KEY, cursor TEXT, quota_json TEXT, last_polled_at TEXT, last_success_at TEXT, last_error TEXT, canonical_book_availability_json TEXT NOT NULL DEFAULT '{}');
CREATE TABLE IF NOT EXISTS odds_league_poll (league TEXT PRIMARY KEY, last_discovery_at TEXT, last_success_at TEXT, last_error TEXT);
CREATE TABLE IF NOT EXISTS projection_delivery (event_id TEXT PRIMARY KEY, projection_version TEXT NOT NULL, attempts INTEGER NOT NULL DEFAULT 0, queued_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, attempted_at TEXT, updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, delivered_at TEXT, last_error TEXT);
-- The current version for each disposable projection scope; text comparison is length-aware so versions remain exact beyond SQLite integer range.
CREATE TABLE IF NOT EXISTS projection_state (scope TEXT PRIMARY KEY, projection_version TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS pool_registry_creator ON pool_registry(creator_id);
CREATE UNIQUE INDEX IF NOT EXISTS account_issuer_account_id ON account(issuer, accountId);
CREATE INDEX IF NOT EXISTS account_user_id ON account(userId);
CREATE INDEX IF NOT EXISTS session_user_id ON session(userId);
CREATE INDEX IF NOT EXISTS verification_identifier ON verification(identifier);
CREATE TABLE IF NOT EXISTS backup_cursor (name TEXT PRIMARY KEY, last_pool_id TEXT);
