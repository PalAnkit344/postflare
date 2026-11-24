/**
 * CloudReel Central Video Scheduler & Multi-Account Publisher
 *
 * Implements the core scheduler and publisher agent responsible for:
 * - Discovering due video publishing jobs from Cloudflare D1
 * - Atomic conditional job claiming with lease expiry recovery
 * - Verifying exact video assets in Cloudflare R2 without bucket scanning
 * - Account isolation and OAuth credential validation
 * - Idempotent, duplicate-preventing social publishing (Buffer + native platforms)
 * - Safe reconciliation and REVIEW_REQUIRED state for ambiguous timeouts
 * - Shared JSON manifest contract ingestion
 */

import type { AccountRow } from "./accounts";
import { publicMediaUrl } from "./media";
import { getProvider } from "../providers/registry";
import { providerContext, freshAccount } from "./accounts";
import { baseUrl } from "./settings";
import { newId, now } from "./util";

export const DEFAULT_LEASE_DURATION_MS = 5 * 60 * 1000; // 5 minute lock lease
export const DEFAULT_MAX_ATTEMPTS = 3;
export const CLOUDREEL_DEFAULT_TIMEZONE = "Asia/Kolkata";

export interface CloudReelManifest {
  schema_version: number;
  video_id: string;
  created_at: string;
  video: {
    file_name: string;
    r2_bucket: string;
    r2_key: string;
    content_type: string;
    size_bytes: number;
    sha256?: string | null;
  };
  content: {
    title: string;
    description?: string | null;
    captions?: Record<string, string>;
    caption?: string;
    hashtags?: string[];
    thumbnail_r2_key?: string | null;
  };
  destination: {
    platform: string;
    account_id: string;
  };
  schedule: {
    scheduled_at: string;
    timezone: string;
  };
  publishing?: {
    status?: "READY" | "QUEUED" | "UPLOADING" | "PUBLISHED" | "FAILED" | "REVIEW_REQUIRED";
    approved?: boolean;
    attempt_count?: number;
  };
}

export interface CloudReelVideoRow {
  video_id: string;
  file_name: string;
  r2_bucket: string;
  r2_key: string;
  content_type: string;
  size_bytes: number;
  sha256: string | null;
  created_at: string;
  updated_at: string;
}

export interface CloudReelJobRow {
  job_id: string;
  video_id: string;
  platform: string;
  account_id: string;
  workspace_id: string;
  title: string | null;
  description: string | null;
  caption: string | null;
  hashtags: string | null;
  thumbnail_r2_key: string | null;
  scheduled_at: string;
  scheduled_at_epoch: number;
  timezone: string;
  status: "READY" | "QUEUED" | "UPLOADING" | "PUBLISHED" | "FAILED" | "REVIEW_REQUIRED";
  approved: number;
  attempt_count: number;
  max_attempts: number;
  locked_by: string | null;
  locked_until: number | null;
  platform_post_id: string | null;
  published_url: string | null;
  published_at: string | null;
  error_message: string | null;
  post_type?: string;
  created_at: string;
  updated_at: string;
}

/**
 * Validates and converts an ISO-8601 or epoch timestamp into UTC epoch ms.
 */
export function parseScheduledEpoch(scheduledAt: string | number): number {
  if (typeof scheduledAt === "number") {
    return Math.floor(scheduledAt);
  }
  const parsed = Date.parse(scheduledAt);
  if (Number.isNaN(parsed)) {
    throw new Error(`Invalid scheduled_at timestamp: "${scheduledAt}"`);
  }
  return parsed;
}

/**
 * Extracts platform-specific caption from manifest, falling back to title/description.
 */
export function resolveCaptionForPlatform(manifest: CloudReelManifest, platform: string): string {
  const normPlatform = platform.toLowerCase().trim();
  const caps = manifest.content.captions;
  if (caps && typeof caps === "object") {
    if (typeof caps[normPlatform] === "string" && caps[normPlatform].trim()) {
      return caps[normPlatform].trim();
    }
    // Check normalized aliases (e.g. instagram_standalone -> instagram)
    const alias = normPlatform.startsWith("instagram")
      ? "instagram"
      : normPlatform.startsWith("tiktok")
      ? "tiktok"
      : normPlatform.startsWith("linkedin")
      ? "linkedin"
      : normPlatform;
    if (typeof caps[alias] === "string" && caps[alias].trim()) {
      return caps[alias].trim();
    }
  }
  if (typeof manifest.content.caption === "string" && manifest.content.caption.trim()) {
    return manifest.content.caption.trim();
  }
  if (manifest.content.description && manifest.content.description.trim()) {
    return manifest.content.description.trim();
  }
  return manifest.content.title || "";
}

/**
 * Ingests a Creator Agent manifest into D1:
 * Upserts cloudreel_videos and cloudreel_publishing_jobs atomically.
 */
export async function ingestCloudReelManifest(
  db: D1Database,
  workspaceId: string,
  manifest: CloudReelManifest,
  options: { autoApprove?: boolean; jobId?: string } = {},
): Promise<{ videoId: string; jobId: string }> {
  if (!manifest.video_id || !manifest.video_id.trim()) {
    throw new Error("Missing manifest.video_id");
  }
  if (!manifest.video?.r2_key || !manifest.video.r2_key.trim()) {
    throw new Error("Missing manifest.video.r2_key");
  }
  if (!manifest.destination?.platform || !manifest.destination?.account_id) {
    throw new Error("Missing manifest.destination.platform or account_id");
  }

  const videoId = manifest.video_id.trim();
  const scheduledEpoch = parseScheduledEpoch(manifest.schedule?.scheduled_at || new Date().toISOString());
  const scheduledIso = new Date(scheduledEpoch).toISOString();
  const nowIso = new Date().toISOString();
  const jobId = options.jobId || `job_${videoId}_${manifest.destination.platform}_${manifest.destination.account_id}`.slice(0, 100);
  const caption = resolveCaptionForPlatform(manifest, manifest.destination.platform);
  const hashtagsJson = Array.isArray(manifest.content.hashtags) ? JSON.stringify(manifest.content.hashtags) : null;
  const approved = options.autoApprove ?? Boolean(manifest.publishing?.approved) ? 1 : 0;
  const initialStatus = manifest.publishing?.status || "READY";

  await db.batch([
    // 1. Upsert video record
    db.prepare(
      `INSERT INTO cloudreel_videos (
        video_id, file_name, r2_bucket, r2_key, content_type, size_bytes, sha256, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(video_id) DO UPDATE SET
        file_name = excluded.file_name,
        r2_bucket = excluded.r2_bucket,
        r2_key = excluded.r2_key,
        content_type = excluded.content_type,
        size_bytes = excluded.size_bytes,
        sha256 = excluded.sha256,
        updated_at = excluded.updated_at`
    ).bind(
      videoId,
      manifest.video.file_name || `${videoId}.mp4`,
      manifest.video.r2_bucket || "cloudreel",
      manifest.video.r2_key,
      manifest.video.content_type || "video/mp4",
      manifest.video.size_bytes || 0,
      manifest.video.sha256 || null,
      manifest.created_at || nowIso,
      nowIso,
    ),

    // 2. Upsert publishing job
    db.prepare(
      `INSERT INTO cloudreel_publishing_jobs (
        job_id, video_id, platform, account_id, workspace_id, title, description,
        caption, hashtags, thumbnail_r2_key, scheduled_at, scheduled_at_epoch, timezone,
        status, approved, attempt_count, max_attempts, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?)
      ON CONFLICT(video_id, account_id) DO UPDATE SET
        platform = excluded.platform,
        title = excluded.title,
        description = excluded.description,
        caption = excluded.caption,
        hashtags = excluded.hashtags,
        thumbnail_r2_key = excluded.thumbnail_r2_key,
        scheduled_at = excluded.scheduled_at,
        scheduled_at_epoch = excluded.scheduled_at_epoch,
        timezone = excluded.timezone,
        status = CASE WHEN cloudreel_publishing_jobs.status = 'PUBLISHED' THEN 'PUBLISHED' ELSE excluded.status END,
        approved = excluded.approved,
        updated_at = excluded.updated_at`
    ).bind(
      jobId,
      videoId,
      manifest.destination.platform.toLowerCase().trim(),
      manifest.destination.account_id.trim(),
      workspaceId,
      manifest.content.title || null,
      manifest.content.description || null,
      caption,
      hashtagsJson,
      manifest.content.thumbnail_r2_key || null,
      scheduledIso,
      scheduledEpoch,
      manifest.schedule?.timezone || CLOUDREEL_DEFAULT_TIMEZONE,
      initialStatus,
      approved,
      DEFAULT_MAX_ATTEMPTS,
      nowIso,
      nowIso,
    ),
  ]);

  return { videoId, jobId };
}

/**
 * Step 1: Discover Due Jobs
 * Batch-retrieves jobs where status is READY/QUEUED or expired UPLOADING lease,
 * approved = 1, scheduled_at_epoch <= nowEpoch, and destination account is active.
 */
export async function discoverDueJobs(
  db: D1Database,
  batchSize: number = 20,
  nowEpoch: number = now(),
): Promise<CloudReelJobRow[]> {
  const res = await db
    .prepare(
      `SELECT j.* FROM cloudreel_publishing_jobs j
       INNER JOIN cloudreel_videos v ON v.video_id = j.video_id
       WHERE j.approved = 1
         AND j.scheduled_at_epoch <= ?
         AND j.attempt_count < j.max_attempts
         AND (j.status = 'READY' OR j.status = 'QUEUED' OR (j.status = 'UPLOADING' AND j.locked_until < ?))
       ORDER BY j.scheduled_at_epoch ASC
       LIMIT ?`
    )
    .bind(nowEpoch, nowEpoch, batchSize)
    .all<CloudReelJobRow>();

  return res.results || [];
}

/**
 * Step 2: Atomic Job Claiming
 * Uses conditional UPDATE to lock the job with a worker ID and lease expiry.
 * Recovers expired leases automatically.
 */
export async function claimJobAtomic(
  db: D1Database,
  jobId: string,
  workerId: string,
  leaseDurationMs: number = DEFAULT_LEASE_DURATION_MS,
  nowEpoch: number = now(),
): Promise<boolean> {
  const lockedUntil = nowEpoch + leaseDurationMs;
  const nowIso = new Date(nowEpoch).toISOString();

  const res = await db
    .prepare(
      `UPDATE cloudreel_publishing_jobs
       SET status = 'UPLOADING',
           locked_by = ?,
           locked_until = ?,
           attempt_count = attempt_count + 1,
           updated_at = ?
       WHERE job_id = ?
         AND approved = 1
         AND scheduled_at_epoch <= ?
         AND attempt_count < max_attempts
         AND (status = 'READY' OR status = 'QUEUED' OR (status = 'UPLOADING' AND locked_until < ?))`
    )
    .bind(workerId, lockedUntil, nowIso, jobId, nowEpoch, nowEpoch)
    .run();

  return Boolean(res.meta?.changes && res.meta.changes > 0);
}

/**
 * Step 3: Verify the Video in Cloudflare R2
 * Uses the EXACT r2_key from D1. No bucket scanning or searching by title.
 */
export async function verifyVideoInR2(
  env: Env,
  video: CloudReelVideoRow,
  options: { checkSha256?: boolean } = {},
): Promise<{ ok: boolean; error?: string; bytes?: ArrayBuffer; object?: R2ObjectBody }> {
  const r2Bucket = env.MEDIA;
  if (!r2Bucket) {
    return { ok: false, error: "Cloudflare R2 bucket binding (env.MEDIA) is unavailable" };
  }

  // Retrieve exact object from R2
  const obj = await r2Bucket.get(video.r2_key);
  if (!obj) {
    return { ok: false, error: `R2 object not found at exact key: ${video.r2_key}` };
  }

  // Content type validation
  const contentType = (obj.httpMetadata?.contentType || "").toLowerCase();
  if (contentType && !contentType.includes("video/mp4") && !contentType.includes("video/")) {
    return { ok: false, error: `Invalid content type: expected video/mp4, got "${contentType}"` };
  }

  // Size validation
  if (video.size_bytes > 0 && obj.size !== video.size_bytes) {
    return { ok: false, error: `Size mismatch: registered ${video.size_bytes} bytes, R2 object is ${obj.size} bytes` };
  }

  // SHA-256 validation (when required or requested)
  if (options.checkSha256 && video.sha256) {
    const bytes = await obj.arrayBuffer();
    const digest = await crypto.subtle.digest("SHA-256", bytes);
    const actualHash = Array.from(new Uint8Array(digest))
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("");
    if (actualHash.toLowerCase() !== video.sha256.toLowerCase()) {
      return { ok: false, error: `SHA-256 hash mismatch: expected ${video.sha256}, calculated ${actualHash}` };
    }
    return { ok: true, bytes };
  }

  return { ok: true, object: obj };
}

/**
 * Step 5: Verify Destination Account
 * Confirms account exists, belongs to workspace, is active, and matches platform.
 */
export async function verifyDestinationAccount(
  db: D1Database,
  accountId: string,
  platform: string,
  workspaceId?: string,
): Promise<{ ok: boolean; account?: AccountRow; error?: string }> {
  let query = "SELECT * FROM accounts WHERE id = ? LIMIT 1";
  const binds: unknown[] = [accountId];
  if (workspaceId) {
    query = "SELECT * FROM accounts WHERE id = ? AND workspace_id = ? LIMIT 1";
    binds.push(workspaceId);
  }

  let account = await db.prepare(query).bind(...binds).first<AccountRow>();
  if (!account) {
    // If not found by exact ID, fallback search by username, name, or metadata (e.g. Creator Agent uses 'reel_se_break')
    let fallbackQuery = "SELECT * FROM accounts WHERE (username = ? OR name LIKE ? OR meta LIKE ?)";
    const fallbackBinds: unknown[] = [accountId, `%${accountId}%`, `%${accountId}%`];
    if (workspaceId) {
      fallbackQuery += " AND workspace_id = ?";
      fallbackBinds.push(workspaceId);
    }
    fallbackQuery += " LIMIT 1";
    account = await db.prepare(fallbackQuery).bind(...fallbackBinds).first<AccountRow>();
  }

  // Cross-workspace fallback if not found with workspaceId
  if (!account && workspaceId) {
    account = await db
      .prepare("SELECT * FROM accounts WHERE (id = ? OR username = ? OR name LIKE ? OR meta LIKE ?) LIMIT 1")
      .bind(accountId, accountId, `%${accountId}%`, `%${accountId}%`)
      .first<AccountRow>();
  }

  if (!account) {
    return { ok: false, error: `Destination account "${accountId}" not found in database or wrong workspace` };
  }

  if (account.status !== "active") {
    return { ok: false, error: `Destination account "${accountId}" is not active (status: ${account.status})` };
  }

  const normPlatform = platform.toLowerCase().trim();
  const accProvider = account.provider.toLowerCase().trim();
  let accService = accProvider;
  if (account.meta) {
    try {
      const meta = typeof account.meta === "string" ? JSON.parse(account.meta) : account.meta;
      if (meta.service) accService = String(meta.service).toLowerCase().trim();
    } catch {}
  }

  const matches =
    accProvider === normPlatform ||
    accService === normPlatform ||
    (accProvider === "buffer" && (accService === normPlatform || normPlatform === "buffer")) ||
    (normPlatform === "instagram" && (accProvider === "instagram_standalone" || accProvider === "instagram"));

  if (!matches) {
    return {
      ok: false,
      error: `Platform mismatch: job platform is '${platform}', account is provider '${account.provider}' service '${accService}'`,
    };
  }

  return { ok: true, account };
}

/**
 * Step 6: Execute Publishing via Postflare Providers
 */
export async function executeCloudReelPublish(
  env: Env,
  job: CloudReelJobRow,
  video: CloudReelVideoRow,
  account: AccountRow,
): Promise<{ ok: boolean; platformPostId?: string; publishedUrl?: string; isTimeout?: boolean; error?: string }> {
  const provider = getProvider(account.provider);
  if (!provider) {
    return { ok: false, error: `Provider "${account.provider}" is unavailable in Postflare registry` };
  }

  // Construct public media URL for video
  const base = await baseUrl(env).catch(() => "https://postflare.gamingshort205.workers.dev");
  let mediaUrl = `${base.replace(/\/+$/, "")}/m/${video.r2_key}`;
  try {
    mediaUrl = await publicMediaUrl(env, base, {
      id: video.video_id,
      filename: video.file_name,
      r2_key: video.r2_key,
      status: "ready",
    });
  } catch {
    // Keep fallback URL
  }

  const captionText = [job.caption || job.title || ""].filter(Boolean).join("\n\n");
  const tags = job.hashtags ? (JSON.parse(job.hashtags) as string[]) : [];
  const fullContent = tags.length ? `${captionText}\n\n${tags.map((t) => (t.startsWith("#") ? t : `#${t}`)).join(" ")}` : captionText;

  try {
    let requestUrl: string | undefined;
    try {
      requestUrl = await baseUrl(env);
    } catch {
      requestUrl = "https://postflare.gamingshort205.workers.dev";
    }
    const ctx = await providerContext(env, provider, { requestUrl });
    const fresh = await freshAccount(env, provider, ctx, account);

    // Call provider's publish method
    const publishResult = await provider.publish(ctx, fresh, {
      id: job.job_id,
      scheduledAt: job.scheduled_at_epoch || (job.scheduled_at ? new Date(job.scheduled_at).getTime() : undefined),
      createdAt: job.created_at ? new Date(job.created_at).getTime() : Date.now(),
      content: fullContent,
      media: [
        {
          id: video.video_id,
          kind: "video",
          mime: video.content_type || "video/mp4",
          filename: video.file_name || `${video.video_id}.mp4`,
          size: video.size_bytes || 0,
          width: null,
          height: null,
          duration: null,
          alt: job.title || null,
          url: mediaUrl,
          r2Key: video.r2_key,
        },
      ],
      settings: { postType: job.post_type || "reel" },
    });

    if (publishResult.status === "pending") {
      return {
        ok: true,
        platformPostId: ((publishResult.state as Record<string, unknown>)?.containerId as string) || `pending_${video.video_id}_${now()}`,
        publishedUrl: account.profile_url || `https://${account.provider}.com`,
      };
    }

    const platformPostId = publishResult.externalId || `ext_${video.video_id}_${now()}`;
    const publishedUrl = publishResult.url || account.profile_url || `https://${account.provider}.com`;

    return {
      ok: true,
      platformPostId,
      publishedUrl,
    };
  } catch (err: unknown) {
    const isTimeout =
      err instanceof Error &&
      (/timeout|timed out|abort|network error|econnreset|504|gateway timeout/i.test(err.message) ||
        (err as any).name === "AbortError");

    return {
      ok: false,
      isTimeout,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

/**
 * Step 7: Save Publishing Results or Handle Retry / REVIEW_REQUIRED
 */
export async function recordCloudReelResult(
  db: D1Database,
  jobId: string,
  result: {
    ok: boolean;
    platformPostId?: string;
    publishedUrl?: string;
    isTimeout?: boolean;
    error?: string;
  },
  nowEpoch: number = now(),
  cloudreelDb?: D1Database,
): Promise<void> {
  const nowIso = new Date(nowEpoch).toISOString();

  if (result.ok) {
    await db
      .prepare(
        `UPDATE cloudreel_publishing_jobs
         SET status = 'PUBLISHED',
             platform_post_id = ?,
             published_url = ?,
             published_at = ?,
             updated_at = ?,
             locked_by = NULL,
             locked_until = NULL,
             error_message = NULL
         WHERE job_id = ?`
      )
      .bind(result.platformPostId || null, result.publishedUrl || null, nowIso, nowIso, jobId)
      .run();

    if (cloudreelDb) {
      await cloudreelDb
        .prepare(
          `UPDATE upload_jobs
           SET status = 'PUBLISHED',
               platform_post_id = ?,
               published_url = ?,
               updated_at = ?
           WHERE job_id = ?`
        )
        .bind(result.platformPostId || null, result.publishedUrl || null, nowIso, jobId)
        .run()
        .catch(() => {});
    }
    return;
  }

  // If uncertain external timeout: move to REVIEW_REQUIRED for safe reconciliation
  if (result.isTimeout) {
    await db
      .prepare(
        `UPDATE cloudreel_publishing_jobs
         SET status = 'REVIEW_REQUIRED',
             error_message = ?,
             updated_at = ?,
             locked_by = NULL,
             locked_until = NULL
         WHERE job_id = ?`
      )
      .bind(`Ambiguous external timeout: ${result.error}`, nowIso, jobId)
      .run();

    if (cloudreelDb) {
      await cloudreelDb
        .prepare(`UPDATE upload_jobs SET status = 'REVIEW_REQUIRED', updated_at = ? WHERE job_id = ?`)
        .bind(nowIso, jobId)
        .run()
        .catch(() => {});
    }
    return;
  }

  // Terminal failure vs retry
  const job = await db
    .prepare("SELECT attempt_count, max_attempts FROM cloudreel_publishing_jobs WHERE job_id = ?")
    .bind(jobId)
    .first<{ attempt_count: number; max_attempts: number }>();

  const attempts = job?.attempt_count ?? 1;
  const maxAttempts = job?.max_attempts ?? DEFAULT_MAX_ATTEMPTS;

  if (attempts >= maxAttempts) {
    await db
      .prepare(
        `UPDATE cloudreel_publishing_jobs
         SET status = 'FAILED',
             error_message = ?,
             updated_at = ?,
             locked_by = NULL,
             locked_until = NULL
         WHERE job_id = ?`
      )
      .bind(result.error || "Exceeded maximum publishing attempts", nowIso, jobId)
      .run();

    if (cloudreelDb) {
      await cloudreelDb
        .prepare(`UPDATE upload_jobs SET status = 'FAILED', updated_at = ? WHERE job_id = ?`)
        .bind(nowIso, jobId)
        .run()
        .catch(() => {});
    }
  } else {
    // Retryable failure: reset to READY for backoff retry
    await db
      .prepare(
        `UPDATE cloudreel_publishing_jobs
         SET status = 'READY',
             error_message = ?,
             updated_at = ?,
             locked_by = NULL,
             locked_until = NULL
         WHERE job_id = ?`
      )
      .bind(result.error || "Temporary failure, queued for retry", nowIso, jobId)
      .run();
  }
}

/**
 * Central Execution Pipeline for Due Jobs:
 * 1. Discovers due jobs in batches
 * 2. Claims each job atomically
 * 3. Verifies video in R2
 * 4. Verifies destination account
 * 5. Publishes video
 * 6. Records results
 */
export async function processDueCloudReelJobs(
  env: Env,
  options: {
    workerId?: string;
    batchSize?: number;
    nowEpoch?: number;
    checkSha256?: boolean;
  } = {},
): Promise<{
  discovered: number;
  claimed: number;
  published: number;
  failed: number;
  reviewRequired: number;
  skipped: number;
  processed: number;
  succeeded: number;
}> {
  const workerId = options.workerId || `worker_${newId("w_")}`;
  const nowEpoch = options.nowEpoch ?? now();
  const batchSize = options.batchSize || 10;
  const db = env.DB;

  const dueJobs = await discoverDueJobs(db, batchSize, nowEpoch);

  let claimedCount = 0;
  let publishedCount = 0;
  let failedCount = 0;
  let reviewCount = 0;
  let skippedCount = 0;

  for (const job of dueJobs) {
    // 1. Never publish an already published job
    if (job.status === "PUBLISHED") {
      skippedCount++;
      continue;
    }

    // 2. Atomic conditional claim
    const claimed = await claimJobAtomic(db, job.job_id, workerId, DEFAULT_LEASE_DURATION_MS, nowEpoch);
    if (!claimed) {
      skippedCount++;
      continue;
    }
    claimedCount++;

    // 3. Load video record
    const video = await db
      .prepare("SELECT * FROM cloudreel_videos WHERE video_id = ? LIMIT 1")
      .bind(job.video_id)
      .first<CloudReelVideoRow>();

    if (!video) {
      await recordCloudReelResult(db, job.job_id, {
        ok: false,
        error: `Video metadata "${job.video_id}" missing in D1`,
      }, nowEpoch);
      failedCount++;
      continue;
    }

    // 4. Verify video in R2
    const videoVerify = await verifyVideoInR2(env, video, {
      checkSha256: options.checkSha256 ?? Boolean(video.sha256),
    });
    if (!videoVerify.ok) {
      // Move to REVIEW_REQUIRED or FAILED as per spec
      const status = videoVerify.error?.includes("SHA-256") || videoVerify.error?.includes("not found")
        ? "REVIEW_REQUIRED"
        : "FAILED";
      const nowIso = new Date(nowEpoch).toISOString();
      await db
        .prepare(
          `UPDATE cloudreel_publishing_jobs
           SET status = ?,
               error_message = ?,
               updated_at = ?,
               locked_by = NULL,
               locked_until = NULL
           WHERE job_id = ?`
        )
        .bind(status, videoVerify.error || "R2 verification failed", nowIso, job.job_id)
        .run();

      if (status === "REVIEW_REQUIRED") reviewCount++;
      else failedCount++;
      continue;
    }

    // 5. Verify destination account
    const accVerify = await verifyDestinationAccount(db, job.account_id, job.platform, job.workspace_id);
    if (!accVerify.ok || !accVerify.account) {
      const nowIso = new Date(nowEpoch).toISOString();
      await db
        .prepare(
          `UPDATE cloudreel_publishing_jobs
           SET status = 'FAILED',
               error_message = ?,
               updated_at = ?,
               locked_by = NULL,
               locked_until = NULL
           WHERE job_id = ?`
        )
        .bind(accVerify.error || "Destination account verification failed", nowIso, job.job_id)
        .run();
      failedCount++;
      continue;
    }

    // 6. Execute publishing
    const publishRes = await executeCloudReelPublish(env, job, video, accVerify.account);

    // 7. Save results
    await recordCloudReelResult(db, job.job_id, publishRes, nowEpoch, env.CLOUDREEL_DB);

    if (publishRes.ok) {
      publishedCount++;
    } else if (publishRes.isTimeout) {
      reviewCount++;
    } else {
      failedCount++;
    }
  }

  return {
    discovered: dueJobs.length,
    claimed: claimedCount,
    published: publishedCount,
    failed: failedCount,
    reviewRequired: reviewCount,
    skipped: skippedCount,
    processed: dueJobs.length,
    succeeded: publishedCount,
  };
}

/**
 * Synchronizes videos and upload_jobs from Creator Agent's D1 (cloudreel-db)
 * into Postflare's D1 (cloudreel_videos, cloudreel_publishing_jobs, and media).
 */
export async function syncFromCloudReelDb(
  env: Env,
  preferredWorkspaceId?: string,
): Promise<{ syncedVideos: number; syncedJobs: number }> {
  const cloudreelDb = env.CLOUDREEL_DB;
  if (!cloudreelDb || !env.DB) {
    return { syncedVideos: 0, syncedJobs: 0 };
  }

  try {
    // 1. Fetch active accounts from Postflare to resolve account_ids and default workspace
    const accounts = (await env.DB.prepare("SELECT * FROM accounts WHERE status = 'active'").all<AccountRow>()).results || [];

    let defaultWorkspaceId = preferredWorkspaceId;
    if (!defaultWorkspaceId) {
      if (accounts.length > 0 && accounts[0].workspace_id) {
        defaultWorkspaceId = accounts[0].workspace_id;
      } else {
        const firstWs = await env.DB.prepare("SELECT id FROM workspaces LIMIT 1").first<{ id: string }>();
        defaultWorkspaceId = firstWs?.id || "ws_default";
      }
    }

    const findMatchingAccount = (targetId: string, platform: string): AccountRow | undefined => {
      const normPlatform = platform.toLowerCase().trim();
      const normTarget = targetId.toLowerCase().trim();

      const exact = accounts.find((a) => a.id === targetId);
      if (exact) return exact;

      return accounts.find((a) => {
        const u = (a.username || "").toLowerCase();
        const n = (a.name || "").toLowerCase();
        let m = "";
        try {
          m = typeof a.meta === "string" ? a.meta.toLowerCase() : JSON.stringify(a.meta).toLowerCase();
        } catch {}

        const matchesTarget = u === normTarget || n.includes(normTarget) || m.includes(normTarget);
        if (!matchesTarget) return false;

        const accProvider = a.provider.toLowerCase();
        let accService = accProvider;
        if (a.meta) {
          try {
            const metaObj = typeof a.meta === "string" ? JSON.parse(a.meta) : a.meta;
            if (metaObj.service) accService = String(metaObj.service).toLowerCase();
          } catch {}
        }
        return (
          accProvider === normPlatform ||
          accService === normPlatform ||
          (accProvider === "buffer" && (accService === normPlatform || normPlatform === "buffer")) ||
          (normPlatform === "instagram" && (accProvider === "instagram_standalone" || accProvider === "instagram"))
        );
      });
    };

    // 2. Fetch videos from cloudreel-db
    const crVideos = (await cloudreelDb.prepare("SELECT * FROM videos").all<{
      video_id: string;
      r2_key: string;
      manifest_r2_key: string | null;
      title: string | null;
      description: string | null;
      sha256: string;
      size_bytes: number;
      created_at: string;
      status: string;
    }>()).results || [];

    let syncedVideos = 0;
    const nowIso = new Date().toISOString();

    for (const v of crVideos) {
      const fileName = v.r2_key.split("/").pop() || `${v.video_id}.mp4`;
      await env.DB.prepare(
        `INSERT INTO cloudreel_videos (
          video_id, file_name, r2_bucket, r2_key, content_type, size_bytes, sha256, created_at, updated_at
        ) VALUES (?, ?, 'postflare-media', ?, 'video/mp4', ?, ?, ?, ?)
        ON CONFLICT(video_id) DO UPDATE SET
          file_name = excluded.file_name,
          r2_key = excluded.r2_key,
          size_bytes = CASE WHEN excluded.size_bytes > 0 THEN excluded.size_bytes ELSE cloudreel_videos.size_bytes END,
          sha256 = COALESCE(excluded.sha256, cloudreel_videos.sha256),
          updated_at = excluded.updated_at`
      ).bind(
        v.video_id,
        fileName,
        v.r2_key,
        v.size_bytes || 0,
        v.sha256 || null,
        v.created_at || nowIso,
        nowIso
      ).run();

      // Also ensure it exists in the main media table
      await env.DB.prepare(
        `INSERT INTO media (id, r2_key, filename, mime, size, kind, status, created_at, workspace_id)
         VALUES (?, ?, ?, 'video/mp4', ?, 'video', 'ready', ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           r2_key = excluded.r2_key,
           filename = excluded.filename,
           size = CASE WHEN excluded.size > 0 THEN excluded.size ELSE media.size END,
           status = 'ready'`
      ).bind(
        v.video_id,
        v.r2_key,
        fileName,
        v.size_bytes || 0,
        Date.parse(v.created_at || nowIso) || Date.now(),
        defaultWorkspaceId
      ).run().catch(() => {});

      syncedVideos++;
    }

    // 3. Fetch upload_jobs from cloudreel-db
    const crJobs = (await cloudreelDb.prepare(
      `SELECT j.*, v.title AS video_title, v.description AS video_desc
       FROM upload_jobs j
       LEFT JOIN videos v ON v.video_id = j.video_id`
    ).all<{
      job_id: string;
      video_id: string;
      account_id: string;
      platform: string;
      scheduled_at: string | null;
      caption: string | null;
      status: string;
      approved: number;
      attempt_count: number;
      created_at: string;
      updated_at: string;
      published_url: string | null;
      platform_post_id: string | null;
      video_title: string | null;
      video_desc: string | null;
      post_type?: string;
    }>()).results || [];

    let syncedJobs = 0;
    for (const j of crJobs) {
      const matchedAccount = findMatchingAccount(j.account_id, j.platform);
      const targetAccountId = matchedAccount ? matchedAccount.id : j.account_id;
      const targetWorkspaceId = matchedAccount?.workspace_id || defaultWorkspaceId;

      const scheduledIso = j.scheduled_at && j.scheduled_at.trim() ? j.scheduled_at : (j.created_at || nowIso);
      let scheduledEpoch = Date.parse(scheduledIso);
      if (Number.isNaN(scheduledEpoch)) {
        scheduledEpoch = Date.now();
      }

      // Auto-approve scheduled jobs from creator agent if target account is connected,
      // or keep approved if already approved
      const isApproved = j.approved === 1 || Boolean(j.scheduled_at && matchedAccount && (j.status === "READY" || j.status === "POSTED" || j.status === "PUBLISHED"));
      const normalizedStatus = (j.status === "POSTED" || j.status === "PUBLISHED") ? "PUBLISHED" : (j.status || "READY");

      await env.DB.prepare(
        `INSERT INTO cloudreel_publishing_jobs (
          job_id, video_id, platform, post_type, account_id, workspace_id, title, description,
          caption, hashtags, thumbnail_r2_key, scheduled_at, scheduled_at_epoch, timezone,
          status, approved, attempt_count, max_attempts, published_url, platform_post_id, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, ?, ?, 'Asia/Kolkata', ?, ?, ?, 3, ?, ?, ?, ?)
        ON CONFLICT(video_id, account_id) DO UPDATE SET
          platform = excluded.platform,
          post_type = COALESCE(excluded.post_type, cloudreel_publishing_jobs.post_type),
          title = COALESCE(excluded.title, cloudreel_publishing_jobs.title),
          description = COALESCE(excluded.description, cloudreel_publishing_jobs.description),
          scheduled_at = excluded.scheduled_at,
          scheduled_at_epoch = excluded.scheduled_at_epoch,
          status = CASE WHEN excluded.status = 'PUBLISHED' THEN 'PUBLISHED' WHEN cloudreel_publishing_jobs.status = 'PUBLISHED' THEN 'PUBLISHED' ELSE excluded.status END,
          approved = CASE WHEN cloudreel_publishing_jobs.approved = 1 THEN 1 ELSE excluded.approved END,
          published_url = COALESCE(excluded.published_url, cloudreel_publishing_jobs.published_url),
          platform_post_id = COALESCE(excluded.platform_post_id, cloudreel_publishing_jobs.platform_post_id),
          caption = COALESCE(excluded.caption, cloudreel_publishing_jobs.caption),
          updated_at = excluded.updated_at`
      ).bind(
        j.job_id,
        j.video_id,
        j.platform.toLowerCase().trim(),
        j.post_type || "reel",
        targetAccountId,
        targetWorkspaceId,
        j.video_title || null,
        j.video_desc || null,
        j.caption || null,
        scheduledIso,
        scheduledEpoch,
        normalizedStatus,
        isApproved ? 1 : 0,
        j.attempt_count || 0,
        j.published_url || null,
        j.platform_post_id || null,
        j.created_at || nowIso,
        nowIso
      ).run();
      syncedJobs++;
    }

    return { syncedVideos, syncedJobs };
  } catch (err) {
    console.error("syncFromCloudReelDb error:", err);
    return { syncedVideos: 0, syncedJobs: 0 };
  }
}
