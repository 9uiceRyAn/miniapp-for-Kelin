-- Additive learning platform schema. Existing users/files/marks stay authoritative.
CREATE TABLE IF NOT EXISTS kl_resources (
 id VARCHAR(36) PRIMARY KEY, namespace VARCHAR(100) NOT NULL, source_id VARCHAR(191) NOT NULL,
 type VARCHAR(32) NOT NULL, visibility VARCHAR(16) NOT NULL DEFAULT 'public', owner_id BIGINT UNSIGNED NULL,
 source_file_id BIGINT UNSIGNED NULL, current_revision VARCHAR(36) NULL,
 created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
 UNIQUE KEY uq_kl_source(namespace,source_id), KEY idx_kl_file(source_file_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
CREATE TABLE IF NOT EXISTS kl_revisions (
 id VARCHAR(36) PRIMARY KEY, resource_id VARCHAR(36) NOT NULL, content_hash CHAR(64) NOT NULL,
 data JSON NOT NULL, subject VARCHAR(100) NOT NULL DEFAULT '', collection_code VARCHAR(100) NOT NULL DEFAULT '',
 skill VARCHAR(100) NOT NULL DEFAULT '', quality_status VARCHAR(100) NOT NULL DEFAULT '',
 release_status VARCHAR(32) NOT NULL DEFAULT '', review_required BOOLEAN NOT NULL DEFAULT FALSE,
 search_text MEDIUMTEXT NOT NULL, status VARCHAR(32) NOT NULL DEFAULT 'ready',
 created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
 UNIQUE KEY uq_kl_revision(resource_id,content_hash), KEY idx_kl_filter(subject,collection_code,skill),
 FOREIGN KEY(resource_id) REFERENCES kl_resources(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
CREATE TABLE IF NOT EXISTS kl_tags (
 revision_id VARCHAR(36) NOT NULL, collection_code VARCHAR(100) NOT NULL, code VARCHAR(100) NOT NULL,
 label VARCHAR(191) NOT NULL, PRIMARY KEY(revision_id,collection_code,code),
 KEY idx_kl_tag(collection_code,code), FOREIGN KEY(revision_id) REFERENCES kl_revisions(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
CREATE TABLE IF NOT EXISTS kl_media (
 id VARCHAR(36) PRIMARY KEY, revision_id VARCHAR(36) NOT NULL, kind VARCHAR(32) NOT NULL,
 position INT NOT NULL DEFAULT 0, label VARCHAR(191) NOT NULL, storage_path VARCHAR(500) NULL, mime VARCHAR(100) NOT NULL,
 original_path TEXT NOT NULL, content_hash CHAR(64) NULL,
 FOREIGN KEY(revision_id) REFERENCES kl_revisions(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
CREATE TABLE IF NOT EXISTS kl_chunks (
 revision_id VARCHAR(36) NOT NULL, position INT NOT NULL, label VARCHAR(191) NOT NULL,
 body MEDIUMTEXT NOT NULL, PRIMARY KEY(revision_id,position), FOREIGN KEY(revision_id) REFERENCES kl_revisions(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
CREATE TABLE IF NOT EXISTS kl_imports (
 id VARCHAR(36) PRIMARY KEY, manifest_hash CHAR(64) NOT NULL, report JSON NOT NULL,
 created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
CREATE TABLE IF NOT EXISTS kl_capabilities (
 user_id BIGINT UNSIGNED NOT NULL, capability VARCHAR(64) NOT NULL, PRIMARY KEY(user_id,capability),
 FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
CREATE TABLE IF NOT EXISTS kl_models (
 id VARCHAR(36) PRIMARY KEY, name VARCHAR(191) NOT NULL, gateway_id VARCHAR(191) NOT NULL,
 upstream_model VARCHAR(191) NOT NULL, credential_ref VARCHAR(191) NOT NULL DEFAULT '',
 enabled BOOLEAN NOT NULL DEFAULT TRUE, capabilities JSON NOT NULL, parameters JSON NOT NULL,
 created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP, UNIQUE KEY uq_kl_gateway(gateway_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
CREATE TABLE IF NOT EXISTS kl_prices (
 id VARCHAR(36) PRIMARY KEY, model_id VARCHAR(100) NOT NULL, currency VARCHAR(8) NOT NULL,
 rates JSON NOT NULL, effective_at DATETIME(3) NOT NULL, created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
 KEY idx_kl_price(model_id,effective_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
CREATE TABLE IF NOT EXISTS kl_skills (
 id VARCHAR(36) PRIMARY KEY, agent_id VARCHAR(36) NOT NULL, data JSON NOT NULL, content_hash CHAR(64) NOT NULL,
 created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
CREATE TABLE IF NOT EXISTS kl_agents (
 id VARCHAR(36) PRIMARY KEY, owner_id BIGINT UNSIGNED NOT NULL, name VARCHAR(191) NOT NULL,
 description TEXT NOT NULL, draft_skill_id VARCHAR(36) NULL, draft_model_id VARCHAR(36) NULL,
 draft_parameters JSON NOT NULL, published_version VARCHAR(36) NULL, status VARCHAR(32) NOT NULL DEFAULT 'draft',
 created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP, KEY idx_kl_agent_owner(owner_id),
 FOREIGN KEY(owner_id) REFERENCES users(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
CREATE TABLE IF NOT EXISTS kl_versions (
 id VARCHAR(36) PRIMARY KEY, agent_id VARCHAR(36) NOT NULL, skill_id VARCHAR(36) NOT NULL,
 model JSON NOT NULL, purpose VARCHAR(16) NOT NULL, created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
 FOREIGN KEY(agent_id) REFERENCES kl_agents(id), FOREIGN KEY(skill_id) REFERENCES kl_skills(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
CREATE TABLE IF NOT EXISTS kl_conversations (
 id VARCHAR(36) PRIMARY KEY, owner_id BIGINT UNSIGNED NOT NULL, agent_id VARCHAR(36) NOT NULL,
 mode VARCHAR(16) NOT NULL, snapshot JSON NOT NULL, active_run VARCHAR(36) NULL,
 created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP, updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
 KEY idx_kl_conv_owner(owner_id,updated_at), FOREIGN KEY(owner_id) REFERENCES users(id),
 FOREIGN KEY(agent_id) REFERENCES kl_agents(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
CREATE TABLE IF NOT EXISTS kl_messages (
 id VARCHAR(36) PRIMARY KEY, conversation_id VARCHAR(36) NOT NULL, seq INT NOT NULL,
 role VARCHAR(16) NOT NULL, data JSON NOT NULL, request_id VARCHAR(100) NULL,
 created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
 UNIQUE KEY uq_kl_message_seq(conversation_id,seq), UNIQUE KEY uq_kl_request(conversation_id,request_id),
 FOREIGN KEY(conversation_id) REFERENCES kl_conversations(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
CREATE TABLE IF NOT EXISTS kl_runs (
 id VARCHAR(36) PRIMARY KEY, conversation_id VARCHAR(36) NOT NULL, message_id VARCHAR(36) NOT NULL,
 boundary_seq INT NOT NULL, status VARCHAR(32) NOT NULL DEFAULT 'queued', error TEXT NULL,
 created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP, updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
 UNIQUE KEY uq_kl_run_message(message_id), FOREIGN KEY(conversation_id) REFERENCES kl_conversations(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
CREATE TABLE IF NOT EXISTS kl_events (
 run_id VARCHAR(36) NOT NULL, seq INT NOT NULL, type VARCHAR(40) NOT NULL, data JSON NOT NULL,
 created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP, PRIMARY KEY(run_id,seq), FOREIGN KEY(run_id) REFERENCES kl_runs(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
CREATE TABLE IF NOT EXISTS kl_assets (
 id VARCHAR(36) PRIMARY KEY, conversation_id VARCHAR(36) NOT NULL, resource_id VARCHAR(36) NOT NULL,
 FOREIGN KEY(conversation_id) REFERENCES kl_conversations(id), FOREIGN KEY(resource_id) REFERENCES kl_resources(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
CREATE TABLE IF NOT EXISTS kl_tools (
 id VARCHAR(36) PRIMARY KEY, run_id VARCHAR(36) NOT NULL, name VARCHAR(100) NOT NULL,
 data JSON NOT NULL, status VARCHAR(32) NOT NULL, FOREIGN KEY(run_id) REFERENCES kl_runs(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
CREATE TABLE IF NOT EXISTS kl_citations (
 id VARCHAR(36) PRIMARY KEY, run_id VARCHAR(36) NOT NULL, message_id VARCHAR(36) NULL,
 resource_id VARCHAR(36) NULL, revision_id VARCHAR(36) NULL, data JSON NOT NULL,
 FOREIGN KEY(run_id) REFERENCES kl_runs(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
CREATE TABLE IF NOT EXISTS kl_usage (
 id VARCHAR(36) PRIMARY KEY, operation_key VARCHAR(191) NOT NULL, user_id BIGINT UNSIGNED NOT NULL,
 agent_id VARCHAR(36) NULL, run_id VARCHAR(36) NULL, purpose VARCHAR(32) NOT NULL,
 model_id VARCHAR(100) NOT NULL, provider_request_id VARCHAR(191) NULL, data JSON NOT NULL,
 amount DECIMAL(24,12) NULL, currency VARCHAR(8) NULL, status VARCHAR(32) NOT NULL,
 created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
 UNIQUE KEY uq_kl_operation(operation_key), KEY idx_kl_usage_user(user_id,created_at), KEY idx_kl_usage_agent(agent_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
CREATE TABLE IF NOT EXISTS kl_settings (name VARCHAR(100) PRIMARY KEY, data JSON NOT NULL) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
