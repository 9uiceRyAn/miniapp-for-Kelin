-- Cloud Drive folders and additive columns on files (preserving files.id and user_file_marks).
CREATE TABLE IF NOT EXISTS drive_folders (
  id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  parent_id BIGINT UNSIGNED NULL,
  name VARCHAR(191) NOT NULL,
  owner_id BIGINT UNSIGNED NOT NULL,
  legacy_category CHAR(1) NULL,
  deleted_at TIMESTAMP NULL DEFAULT NULL,
  deleted_by BIGINT UNSIGNED NULL DEFAULT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  KEY idx_drive_parent (parent_id, deleted_at),
  KEY idx_drive_owner (owner_id),
  UNIQUE KEY uq_drive_legacy_cat (legacy_category),
  CONSTRAINT fk_drive_folder_parent FOREIGN KEY (parent_id) REFERENCES drive_folders(id) ON DELETE RESTRICT,
  CONSTRAINT fk_drive_folder_owner FOREIGN KEY (owner_id) REFERENCES users(id) ON DELETE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

ALTER TABLE files
  ADD COLUMN folder_id BIGINT UNSIGNED NULL AFTER category,
  ADD COLUMN deleted_at TIMESTAMP NULL DEFAULT NULL AFTER updated_at,
  ADD COLUMN deleted_by BIGINT UNSIGNED NULL DEFAULT NULL AFTER deleted_at,
  ADD COLUMN ai_resource_id VARCHAR(36) NULL AFTER deleted_by,
  ADD COLUMN ai_index_status VARCHAR(16) NOT NULL DEFAULT 'none' AFTER ai_resource_id,
  ADD COLUMN ai_index_error TEXT NULL AFTER ai_index_status;

INSERT IGNORE INTO drive_folders (parent_id, name, owner_id, legacy_category)
SELECT NULL, CONCAT(cat.code, ' 类资料'), u.id, cat.code
FROM (
  SELECT 'A' AS code UNION ALL SELECT 'B' UNION ALL SELECT 'C' UNION ALL SELECT 'D' UNION ALL SELECT 'E'
) cat
JOIN (
  SELECT id FROM users WHERE role = 'teacher' AND status = 1 ORDER BY id ASC LIMIT 1
) u;

UPDATE files f
JOIN drive_folders d ON d.legacy_category = f.category
SET f.folder_id = d.id
WHERE f.folder_id IS NULL;
