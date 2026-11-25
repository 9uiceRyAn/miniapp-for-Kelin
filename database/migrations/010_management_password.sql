CREATE TABLE IF NOT EXISTS management_password (
  id INT PRIMARY KEY,
  password_hash VARCHAR(512) CHARACTER SET ascii COLLATE ascii_bin NULL
);
INSERT IGNORE INTO management_password(id) VALUES(1);
