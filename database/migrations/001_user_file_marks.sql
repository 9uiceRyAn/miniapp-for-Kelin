CREATE TABLE IF NOT EXISTS user_file_marks (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  user_id BIGINT UNSIGNED NOT NULL,
  file_id BIGINT UNSIGNED NOT NULL,
  marked_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_user_file_mark (user_id, file_id),
  KEY idx_user_marked_at (user_id, marked_at),
  KEY idx_file_id (file_id),
  CONSTRAINT fk_user_file_marks_user
    FOREIGN KEY (user_id)
    REFERENCES users(id)
    ON DELETE CASCADE,
  CONSTRAINT fk_user_file_marks_file
    FOREIGN KEY (file_id)
    REFERENCES files(id)
    ON DELETE CASCADE
) ENGINE=InnoDB
  DEFAULT CHARSET=utf8mb4
  COLLATE=utf8mb4_unicode_ci;
