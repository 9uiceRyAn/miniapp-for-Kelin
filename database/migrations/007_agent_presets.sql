-- Minimal AI Agent presets extension (5-field editor + 3 initial seeded agents).
ALTER TABLE kl_agents
  ADD COLUMN tool_permission VARCHAR(16) NOT NULL DEFAULT 'read_only' AFTER draft_parameters,
  ADD COLUMN audience VARCHAR(16) NOT NULL DEFAULT 'all' AFTER tool_permission,
  ADD COLUMN preset_key VARCHAR(64) NULL UNIQUE AFTER audience,
  ADD COLUMN enabled BOOLEAN NOT NULL DEFAULT TRUE AFTER preset_key,
  ADD COLUMN pinned BOOLEAN NOT NULL DEFAULT FALSE AFTER enabled,
  ADD COLUMN sort_order INT NOT NULL DEFAULT 0 AFTER pinned;
