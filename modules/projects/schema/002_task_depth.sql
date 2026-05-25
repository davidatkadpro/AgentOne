-- modules/projects v0.2.0 — project editability + task depth fields.
--
-- Two changes, both additive:
--
-- 1) Task columns for scheduling, time accounting, and priority. All optional
--    (NULL means "unset") except `spent_minutes` which defaults to 0 so the
--    accumulator is always safe to ADD onto. Priority is constrained at the
--    column level so bad values can't sneak in via raw SQL.
--
-- 2) `task_file` join table — tasks reference project files by a
--    storage-relative path (the same shape as ProjectFilesEntry.relativePath).
--    Multiple labels per file are not allowed; the PK is (task_id, file_path).
--    Cascade on task delete so we never orphan link rows.

ALTER TABLE task ADD COLUMN start_date INTEGER;
ALTER TABLE task ADD COLUMN due_date INTEGER;
ALTER TABLE task ADD COLUMN estimated_minutes INTEGER;
ALTER TABLE task ADD COLUMN spent_minutes INTEGER NOT NULL DEFAULT 0;
ALTER TABLE task ADD COLUMN priority TEXT NOT NULL DEFAULT 'normal'
  CHECK (priority IN ('low', 'normal', 'high', 'urgent'));

CREATE INDEX idx_task_due ON task(due_date) WHERE due_date IS NOT NULL;
CREATE INDEX idx_task_priority ON task(priority);

CREATE TABLE task_file (
  task_id TEXT NOT NULL REFERENCES task(id) ON DELETE CASCADE,
  file_path TEXT NOT NULL,                   -- storage-relative path
  label TEXT,                                -- optional human-friendly name
  created_at INTEGER NOT NULL,
  PRIMARY KEY (task_id, file_path)
);

CREATE INDEX idx_task_file_task ON task_file(task_id);
