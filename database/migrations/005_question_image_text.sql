CREATE TABLE IF NOT EXISTS kl_question_image_text (
  revision_id VARCHAR(36) NOT NULL,
  media_id VARCHAR(36) NOT NULL,
  model_id VARCHAR(36) NOT NULL,
  body MEDIUMTEXT NOT NULL,
  PRIMARY KEY (revision_id, media_id, model_id),
  FOREIGN KEY (media_id) REFERENCES kl_media(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
