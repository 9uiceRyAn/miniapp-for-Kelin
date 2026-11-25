-- Question bank taxonomy tables and curator confirmation actions.
CREATE TABLE IF NOT EXISTS kl_subjects (
  code VARCHAR(100) PRIMARY KEY,
  label VARCHAR(191) NOT NULL,
  sort_order INT NOT NULL DEFAULT 0,
  enabled BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS kl_collections (
  code VARCHAR(100) PRIMARY KEY,
  subject_code VARCHAR(100) NOT NULL,
  label VARCHAR(191) NOT NULL,
  sort_order INT NOT NULL DEFAULT 0,
  enabled BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  KEY idx_kl_col_subject (subject_code),
  CONSTRAINT fk_kl_col_subject FOREIGN KEY (subject_code) REFERENCES kl_subjects(code) ON DELETE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS kl_taxonomy_tags (
  id VARCHAR(36) PRIMARY KEY,
  collection_code VARCHAR(100) NOT NULL,
  parent_id VARCHAR(36) NULL,
  code VARCHAR(100) NOT NULL,
  label VARCHAR(191) NOT NULL,
  sort_order INT NOT NULL DEFAULT 0,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uq_kl_tax_tag (collection_code, code),
  KEY idx_kl_tax_parent (parent_id),
  CONSTRAINT fk_kl_tax_col FOREIGN KEY (collection_code) REFERENCES kl_collections(code) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS kl_question_actions (
  id VARCHAR(36) PRIMARY KEY,
  conversation_id VARCHAR(36) NOT NULL,
  action_type VARCHAR(48) NOT NULL,
  status VARCHAR(24) NOT NULL DEFAULT 'pending',
  summary TEXT NOT NULL,
  payload JSON NOT NULL,
  result JSON NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  KEY idx_kl_qaction_conv (conversation_id, created_at),
  CONSTRAINT fk_kl_qaction_conv FOREIGN KEY (conversation_id) REFERENCES kl_conversations(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

INSERT IGNORE INTO kl_subjects (code, label)
SELECT DISTINCT v.subject, COALESCE(NULLIF(JSON_UNQUOTE(JSON_EXTRACT(v.data, '$.subject_label')), ''), v.subject)
FROM kl_resources r
JOIN kl_revisions v ON v.id = r.current_revision
WHERE r.type = 'question' AND v.subject <> '';

INSERT IGNORE INTO kl_collections (code, subject_code, label)
SELECT DISTINCT v.collection_code, v.subject, COALESCE(NULLIF(JSON_UNQUOTE(JSON_EXTRACT(v.data, '$.collection_label')), ''), v.collection_code)
FROM kl_resources r
JOIN kl_revisions v ON v.id = r.current_revision
WHERE r.type = 'question' AND v.collection_code <> '' AND v.subject <> '';

INSERT IGNORE INTO kl_taxonomy_tags (id, collection_code, parent_id, code, label)
SELECT UUID(), t.collection_code, NULL, t.code, MAX(t.label)
FROM kl_tags t
GROUP BY t.collection_code, t.code;
