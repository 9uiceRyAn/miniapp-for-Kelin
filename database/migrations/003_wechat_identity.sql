CREATE TABLE IF NOT EXISTS wx_union_users (
 union_id VARCHAR(128) PRIMARY KEY,
 user_id BIGINT UNSIGNED NOT NULL,
 FOREIGN KEY(user_id) REFERENCES users(id)
);
CREATE TABLE IF NOT EXISTS wx_identities (
 app_id VARCHAR(64) NOT NULL,
 open_id VARCHAR(128) NOT NULL,
 union_id VARCHAR(128) NULL,
 user_id BIGINT UNSIGNED NOT NULL,
 PRIMARY KEY(app_id,open_id),
 UNIQUE KEY user_app(user_id,app_id),
 KEY union_lookup(union_id),
 FOREIGN KEY(user_id) REFERENCES users(id)
);
CREATE TABLE IF NOT EXISTS wx_challenges (
 id CHAR(64) PRIMARY KEY,
 app_id VARCHAR(64) NOT NULL,
 open_id VARCHAR(128) NOT NULL,
 union_id VARCHAR(128) NULL,
 attempts INT NOT NULL DEFAULT 0,
 expires_at DATETIME NOT NULL
);
