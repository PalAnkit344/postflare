import { Hono } from "hono";
import { authenticate, requirePermission, wsId, type AppEnv } from "../lib/auth";
import {
  ingestCloudReelManifest,
  processDueCloudReelJobs,
  type CloudReelManifest,
} from "../lib/cloudreel";
import {
  deleteOpenRouterConfig,
  getOpenRouterConfig,
  getOpenRouterConfigDTO,
  saveOpenRouterConfig,
  testOpenRouterKey,
} from "../lib/openrouter";
import { errorMessage } from "../lib/util";

export const cloudreelRoutes = new Hono<AppEnv>();

// Require authentication for all routes
cloudreelRoutes.use("*", async (c, next) => {
  const error = await authenticate(c);
  if (error) return error;
  return next();
});

/**
 * Ingests a CloudReel publishing manifest from the Creator Agent.
 */
cloudreelRoutes.post("/manifest", requirePermission("posts.write"), async (c) => {
  try {
    const manifest = await c.req.json<CloudReelManifest>();
    const workspaceId = wsId(c);
    const autoApprove = c.req.query("autoApprove") === "true";

    const res = await ingestCloudReelManifest(c.env.DB, workspaceId, manifest, { autoApprove });
    return c.json({ ok: true, videoId: res.videoId, jobId: res.jobId });
  } catch (err) {
    return c.json({ error: errorMessage(err) }, 400);
  }
});

/**
 * Lists CloudReel publishing jobs for the current workspace.
 */
cloudreelRoutes.get("/jobs", requirePermission("posts.read"), async (c) => {
  const workspaceId = wsId(c);
  const status = c.req.query("status");
  const limit = Math.min(Number(c.req.query("limit")) || 50, 100);

  let query = `
    SELECT j.*, v.file_name, v.r2_key, v.size_bytes, a.name AS account_name, a.provider AS account_provider
    FROM cloudreel_publishing_jobs j
    LEFT JOIN cloudreel_videos v ON v.video_id = j.video_id
    LEFT JOIN accounts a ON a.id = j.account_id
    WHERE j.workspace_id = ?
  `;
  const binds: unknown[] = [workspaceId];

  if (status) {
    query += " AND j.status = ?";
    binds.push(status);
  }

  query += " ORDER BY j.scheduled_at_epoch ASC LIMIT ?";
  binds.push(limit);

  const { results } = await c.env.DB.prepare(query).bind(...binds).all();
  return c.json({ jobs: results });
});

/**
 * Gets a specific CloudReel job by ID.
 */
cloudreelRoutes.get("/jobs/:id", requirePermission("posts.read"), async (c) => {
  const workspaceId = wsId(c);
  const jobId = c.req.param("id");

  const job = await c.env.DB.prepare(
    `SELECT j.*, v.file_name, v.r2_key, v.r2_bucket, v.content_type, v.size_bytes, v.sha256,
            a.name AS account_name, a.provider AS account_provider, a.status AS account_status
     FROM cloudreel_publishing_jobs j
     LEFT JOIN cloudreel_videos v ON v.video_id = j.video_id
     LEFT JOIN accounts a ON a.id = j.account_id
     WHERE j.job_id = ? AND j.workspace_id = ?
     LIMIT 1`
  )
    .bind(jobId, workspaceId)
    .first();

  if (!job) return c.json({ error: "Job not found" }, 404);
  return c.json(job);
});

/**
 * Approves a CloudReel publishing job.
 */
cloudreelRoutes.post("/jobs/:id/approve", requirePermission("posts.write"), async (c) => {
  const workspaceId = wsId(c);
  const jobId = c.req.param("id");

  const res = await c.env.DB.prepare(
    `UPDATE cloudreel_publishing_jobs
     SET approved = 1, updated_at = ?
     WHERE job_id = ? AND workspace_id = ?`
  )
    .bind(new Date().toISOString(), jobId, workspaceId)
    .run();

  if (!res.meta?.changes) {
    return c.json({ error: "Job not found" }, 404);
  }

  return c.json({ ok: true, approved: true });
});

/**
 * Retries a failed or review_required job.
 */
cloudreelRoutes.post("/jobs/:id/retry", requirePermission("posts.write"), async (c) => {
  const workspaceId = wsId(c);
  const jobId = c.req.param("id");

  const res = await c.env.DB.prepare(
    `UPDATE cloudreel_publishing_jobs
     SET status = 'READY',
         locked_by = NULL,
         locked_until = NULL,
         attempt_count = 0,
         error_message = NULL,
         updated_at = ?
     WHERE job_id = ? AND workspace_id = ?`
  )
    .bind(new Date().toISOString(), jobId, workspaceId)
    .run();

  if (!res.meta?.changes) {
    return c.json({ error: "Job not found" }, 404);
  }

  return c.json({ ok: true, retried: true });
});

/**
 * Triggers batch processing of all due CloudReel publishing jobs.
 */
cloudreelRoutes.post("/process-due", requirePermission("posts.write"), async (c) => {
  try {
    const checkSha256 = c.req.query("checkSha256") === "true";
    const batchSize = Math.min(Number(c.req.query("batchSize")) || 20, 50);

    const result = await processDueCloudReelJobs(c.env, {
      batchSize,
      checkSha256,
    });

    return c.json({ ok: true, result });
  } catch (err) {
    return c.json({ error: errorMessage(err) }, 500);
  }
});

// ==========================================
// OpenRouter AI Agent Configuration Routes
// ==========================================

export const openrouterRoutes = new Hono<AppEnv>();

openrouterRoutes.use("*", async (c, next) => {
  const error = await authenticate(c);
  if (error) return error;
  return next();
});

/**
 * Returns safe OpenRouter configuration state.
 */
openrouterRoutes.get("/config", requirePermission("posts.read"), async (c) => {
  const config = await getOpenRouterConfigDTO(c.env.DB);
  return c.json(config);
});

/**
 * Saves OpenRouter API key & default model.
 */
openrouterRoutes.post("/config", requirePermission("posts.write"), async (c) => {
  try {
    const body = await c.req.json<{ apiKey?: string; defaultModel?: string }>();
    let apiKey = body?.apiKey?.trim();

    // If apiKey is omitted in request, reuse existing stored key
    if (!apiKey) {
      const stored = await getOpenRouterConfig(c.env.DB);
      apiKey = stored?.apiKey;
    }

    if (!apiKey) {
      return c.json({ error: "OpenRouter API key is required" }, 400);
    }

    const saved = await saveOpenRouterConfig(c.env.DB, {
      apiKey,
      defaultModel: body?.defaultModel?.trim(),
    });

    return c.json({ ok: true, config: saved });
  } catch (err) {
    return c.json({ error: errorMessage(err) }, 400);
  }
});

/**
 * Tests an OpenRouter API key (either provided in body or stored in D1).
 */
openrouterRoutes.post("/test", requirePermission("posts.read"), async (c) => {
  const body = await c.req.json<{ apiKey?: string }>().catch(() => ({ apiKey: undefined }));
  let keyToTest = body?.apiKey?.trim();

  if (!keyToTest) {
    const stored = await getOpenRouterConfig(c.env.DB);
    keyToTest = stored?.apiKey;
  }

  if (!keyToTest) {
    return c.json({ ok: false, message: "No OpenRouter API key provided or configured" }, 400);
  }

  const result = await testOpenRouterKey(keyToTest, fetch);
  return c.json(result, result.ok ? 200 : 400);
});

/**
 * Disconnects and deletes OpenRouter API configuration.
 */
openrouterRoutes.delete("/config", requirePermission("posts.write"), async (c) => {
  await deleteOpenRouterConfig(c.env.DB);
  return c.json({ ok: true, disconnected: true });
});
