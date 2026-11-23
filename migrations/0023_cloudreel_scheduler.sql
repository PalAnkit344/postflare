-- CloudReel Central Video Scheduler & Multi-Account Publisher
-- Shared D1 schema for video records and publishing jobs

CREATE TABLE IF NOT EXISTS cloudreel_videos (
  video_id TEXT PRIMARY KEY,
  file_name TEXT NOT NULL,
  r2_bucket TEXT NOT NULL,
  r2_key TEXT NOT NULL,
  content_type TEXT NOT NULL DEFAULT 'video/mp4',
  size_bytes INTEGER NOT NULL DEFAULT 0,
  sha256 TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS cloudreel_publishing_jobs (
  job_id TEXT PRIMARY KEY,
  video_id TEXT NOT NULL REFERENCES cloudreel_videos(video_id),
  platform TEXT NOT NULL,
  account_id TEXT NOT NULL,
  workspace_id TEXT NOT NULL,
  title TEXT,
  description TEXT,
  caption TEXT,
  hashtags TEXT, -- JSON array string
  thumbnail_r2_key TEXT,
  scheduled_at TEXT NOT NULL, -- ISO-8601 UTC string
  scheduled_at_epoch INTEGER NOT NULL, -- UTC epoch ms for fast range scanning
  timezone TEXT NOT NULL DEFAULT 'Asia/Kolkata',
  status TEXT NOT NULL DEFAULT 'READY', -- READY | QUEUED | UPLOADING | PUBLISHED | FAILED | REVIEW_REQUIRED
  approved INTEGER NOT NULL DEFAULT 0, -- 1 = approved, 0 = pending review
  attempt_count INTEGER NOT NULL DEFAULT 0,
  max_attempts INTEGER NOT NULL DEFAULT 3,
  locked_by TEXT, -- Worker instance ID holding the processing lease
  locked_until INTEGER, -- Epoch ms when processing lease expires
  platform_post_id TEXT, -- Returned ID from target platform
  published_url TEXT, -- Live URL of published post
  published_at TEXT, -- ISO-8601 UTC timestamp of confirmed publication
  error_message TEXT, -- Last failure reason
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(video_id, account_id)
);

CREATE INDEX IF NOT EXISTS idx_cr_jobs_due ON cloudreel_publishing_jobs(status, approved, scheduled_at_epoch);
CREATE INDEX IF NOT EXISTS idx_cr_jobs_video ON cloudreel_publishing_jobs(video_id);
CREATE INDEX IF NOT EXISTS idx_cr_jobs_account ON cloudreel_publishing_jobs(account_id);
CREATE INDEX IF NOT EXISTS idx_cr_jobs_workspace ON cloudreel_publishing_jobs(workspace_id);
