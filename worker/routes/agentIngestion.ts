import { Hono } from "hono";
import { authenticate, requirePermission, wsId, type AppEnv } from "../lib/auth";
import { newId, now } from "../lib/util";
import { safeFilename, publicMediaUrl } from "../lib/media";
import { insertMedia, SINGLE_UPLOAD_MAX, type Meta } from "./media";
import { baseUrl } from "../lib/settings";
import { findPost, logStatement, startWorkflows, workflowInstanceId } from "../lib/posts";
import type { AccountRow } from "../lib/accounts";

export const agentIngestionRoutes = new Hono<AppEnv>();

export interface AgentPostInput {
  content?: string;
  text?: string;
  videoUrl?: string;
  video_url?: string;
  accountTag?: string;
  account_tag?: string;
  accountTags?: string[];
  account_tags?: string[];
  accountId?: string;
  account_id?: string;
  accountIds?: string[];
  account_ids?: string[];
  channelServices?: string[];
  channel_services?: string[];
  scheduledAt?: string | number | null;
  scheduled_at?: string | number | null;
  title?: string;
  filename?: string;
  mediaAlt?: string;
  media_alt?: string;
}

/**
 * Extracts Google Drive file ID from standard Google Drive shareable URLs:
 * - https://drive.google.com/file/d/{id}/view?usp=sharing
 * - https://drive.google.com/open?id={id}
 * - https://drive.google.com/uc?id={id}&export=download
 * - https://drive.usercontent.google.com/download?id={id}
 * Also detects folder URLs so we can reject them with a clear error.
 */
export function extractGoogleDriveId(urlStr: string): { fileId?: string; isFolder?: boolean } {
  try {
    const url = new URL(urlStr);
    const host = url.hostname.toLowerCase();
    if (!host.includes("drive.google.com") && !host.includes("drive.usercontent.google.com")) {
      return {};
    }
    if (url.pathname.includes("/drive/folders/") || url.pathname.includes("/folders/")) {
      return { isFolder: true };
    }
    const fileMatch = url.pathname.match(/\/file\/d\/([a-zA-Z0-9_-]{20,})/);
    if (fileMatch) return { fileId: fileMatch[1] };

    const idParam = url.searchParams.get("id");
    if (idParam && /^[a-zA-Z0-9_-]{20,}$/.test(idParam)) {
      return { fileId: idParam };
    }
  } catch {}
  return {};
}

/** Reads a stream into memory, or returns null (and cancels it) once it exceeds `max` bytes. */
async function readAtMost(stream: ReadableStream<Uint8Array>, max: number): Promise<Uint8Array | null> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > max) {
      await reader.cancel().catch(() => {});
      return null;
    }
    chunks.push(value);
  }
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}

/** Resolves scheduledAt parameter to Postflare post status and timestamp */
function resolveSchedule(scheduledAt: unknown): { status: "draft" | "scheduled"; at: number | null } | null {
  if (scheduledAt === null || scheduledAt === undefined || scheduledAt === "now") {
    return { status: "scheduled", at: now() };
  }
  if (scheduledAt === "draft") {
    return { status: "draft", at: null };
  }
  const at = typeof scheduledAt === "string" ? Date.parse(scheduledAt) : Number(scheduledAt);
  if (!Number.isFinite(at) || at > now() + 360 * 24 * 60 * 60 * 1000) return null;
  return { status: "scheduled", at: Math.max(at, now()) };
}

/** Resolves accounts matching tags, IDs, or default active Buffer accounts */
async function resolveTargetAccounts(
  env: Env,
  workspaceId: string,
  opts: {
    tags: string[];
    accountIds: string[];
    allowedServices?: string[];
  }
): Promise<AccountRow[]> {
  const db = env.DB;
  let rows: AccountRow[] = [];

  if (opts.tags.length > 0) {
    const tagPlaceholders = opts.tags.map(() => "?").join(",");
    const res = await db
      .prepare(
        `SELECT * FROM accounts
         WHERE workspace_id = ? AND status = 'active'
           AND (username IN (${tagPlaceholders}) OR json_extract(meta, '$.tag') IN (${tagPlaceholders}))`
      )
      .bind(workspaceId, ...opts.tags, ...opts.tags)
      .all<AccountRow>();
    rows = res.results;
  } else if (opts.accountIds.length > 0) {
    const idPlaceholders = opts.accountIds.map(() => "?").join(",");
    const res = await db
      .prepare(
        `SELECT * FROM accounts
         WHERE workspace_id = ? AND status = 'active'
           AND id IN (${idPlaceholders})`
      )
      .bind(workspaceId, ...opts.accountIds)
      .all<AccountRow>();
    rows = res.results;
  } else {
    // Default: find active Buffer accounts in the workspace
    const res = await db
      .prepare(
        `SELECT * FROM accounts
         WHERE workspace_id = ? AND status = 'active' AND provider = 'buffer'`
      )
      .bind(workspaceId)
      .all<AccountRow>();
    rows = res.results;

    if (rows.length === 0) {
      const anyRes = await db
        .prepare(
          `SELECT * FROM accounts
           WHERE workspace_id = ? AND status = 'active'`
        )
        .bind(workspaceId)
        .all<AccountRow>();
      rows = anyRes.results;
    }
  }

  if (opts.allowedServices && opts.allowedServices.length > 0) {
    const allowed = opts.allowedServices.map((s) => s.toLowerCase());
    rows = rows.filter((r) => {
      let svc = r.provider.toLowerCase();
      if (r.meta) {
        try {
          const m = typeof r.meta === "string" ? JSON.parse(r.meta) : r.meta;
          if (m.service) svc = String(m.service).toLowerCase();
        } catch {}
      }
      return allowed.includes(svc) || allowed.includes(r.provider.toLowerCase());
    });
  }

  return rows;
}

// Ensure every request to agent routes is authenticated
agentIngestionRoutes.use("*", async (c, next) => {
  const error = await authenticate(c);
  if (error) return error;
  return next();
});

/**
 * POST /posts
 * Accepts programmatic post ingestion from external video generation agents.
 * Downloads video (direct or Google Drive), streams directly to R2, creates media & post records,
 * and schedules the PublishWorkflow.
 */
agentIngestionRoutes.post("/posts", requirePermission("posts.write"), async (c) => {
  let body: AgentPostInput;
  try {
    body = await c.req.json<AgentPostInput>();
  } catch {
    return c.json({ error: "Invalid JSON body" }, 400);
  }

  // 1. Validate content
  const content = (body.content ?? body.text ?? "").trim();
  if (!content) {
    return c.json({ error: "content is required" }, 400);
  }

  // 2. Validate videoUrl
  const videoUrl = (body.videoUrl ?? body.video_url ?? "").trim();
  if (!videoUrl) {
    return c.json({ error: "videoUrl is required" }, 400);
  }

  let parsedUrl: URL;
  try {
    parsedUrl = new URL(videoUrl);
  } catch {
    return c.json({ error: "Invalid videoUrl" }, 400);
  }
  if (parsedUrl.protocol !== "https:" && parsedUrl.protocol !== "http:") {
    return c.json({ error: "videoUrl must use http or https protocol" }, 400);
  }

  // 3. Check for Google Drive folder link
  const gdrive = extractGoogleDriveId(videoUrl);
  if (gdrive.isFolder) {
    return c.json({ error: "URL points to a Google Drive folder, but a direct video file link is required" }, 400);
  }

  // 4. Resolve Target Accounts
  const rawTags: string[] = [];
  if (typeof body.accountTag === "string" && body.accountTag.trim()) rawTags.push(body.accountTag.trim());
  if (typeof body.account_tag === "string" && body.account_tag.trim()) rawTags.push(body.account_tag.trim());
  if (Array.isArray(body.accountTags)) {
    for (const t of body.accountTags) if (typeof t === "string" && t.trim()) rawTags.push(t.trim());
  }
  if (Array.isArray(body.account_tags)) {
    for (const t of body.account_tags) if (typeof t === "string" && t.trim()) rawTags.push(t.trim());
  }

  const rawAccountIds: string[] = [];
  if (typeof body.accountId === "string" && body.accountId.trim()) rawAccountIds.push(body.accountId.trim());
  if (typeof body.account_id === "string" && body.account_id.trim()) rawAccountIds.push(body.account_id.trim());
  if (Array.isArray(body.accountIds)) {
    for (const id of body.accountIds) if (typeof id === "string" && id.trim()) rawAccountIds.push(id.trim());
  }
  if (Array.isArray(body.account_ids)) {
    for (const id of body.account_ids) if (typeof id === "string" && id.trim()) rawAccountIds.push(id.trim());
  }

  const channelServices: string[] = [];
  if (Array.isArray(body.channelServices)) {
    for (const s of body.channelServices) if (typeof s === "string" && s.trim()) channelServices.push(s.trim());
  }
  if (Array.isArray(body.channel_services)) {
    for (const s of body.channel_services) if (typeof s === "string" && s.trim()) channelServices.push(s.trim());
  }

  const workspaceId = wsId(c);
  let targetAccounts: AccountRow[] = [];

  if (rawTags.length > 0) {
    const tagSet = new Set<string>();
    for (const t of rawTags) {
      tagSet.add(t);
      tagSet.add(t.replace(/^#+/, ""));
      tagSet.add(`#${t.replace(/^#+/, "")}`);
    }
    targetAccounts = await resolveTargetAccounts(c.env, workspaceId, {
      tags: [...tagSet],
      accountIds: [],
      allowedServices: channelServices,
    });
    if (targetAccounts.length === 0) {
      return c.json({ error: `No active accounts found for accountTag: ${rawTags.join(", ")}` }, 400);
    }
  } else if (rawAccountIds.length > 0) {
    targetAccounts = await resolveTargetAccounts(c.env, workspaceId, {
      tags: [],
      accountIds: rawAccountIds,
      allowedServices: channelServices,
    });
    if (targetAccounts.length === 0) {
      return c.json({ error: `No active accounts found for accountId: ${rawAccountIds.join(", ")}` }, 400);
    }
  } else {
    targetAccounts = await resolveTargetAccounts(c.env, workspaceId, {
      tags: [],
      accountIds: [],
      allowedServices: channelServices,
    });
    if (targetAccounts.length === 0) {
      return c.json({ error: "No active social accounts found in workspace. Please connect a Buffer account first." }, 400);
    }
  }

  // 5. Google Drive / Remote Video Resolution & Stream Ingestion
  let downloadUrl = videoUrl;
  let defaultFilename = "agent_video.mp4";

  if (gdrive.fileId) {
    downloadUrl = `https://drive.usercontent.google.com/download?id=${gdrive.fileId}&export=download&confirm=t`;
    defaultFilename = `video_${gdrive.fileId}.mp4`;
  } else {
    try {
      const parsed = new URL(videoUrl);
      const lastSeg = parsed.pathname.split("/").filter(Boolean).pop();
      if (lastSeg && /\.(mp4|mov|webm|m4v)$/i.test(lastSeg)) {
        defaultFilename = decodeURIComponent(lastSeg);
      }
    } catch {}
  }

  const filename = body.filename?.trim() || defaultFilename;

  let res: Response;
  try {
    res = await fetch(downloadUrl, { redirect: "follow" });
  } catch (err: any) {
    return c.json({ error: `Failed to fetch video URL: ${err.message || "Network error"}` }, 400);
  }

  if (!res.ok || !res.body) {
    return c.json({ error: `Video download failed with status ${res.status}` }, 400);
  }

  const rawContentType = res.headers.get("content-type") ?? "";
  const contentType = rawContentType.split(";")[0].trim().toLowerCase();

  // Validate that response is not an HTML error or Google login interstitial
  if (contentType.includes("text/html")) {
    await res.body.cancel().catch(() => {});
    if (gdrive.fileId) {
      return c.json(
        { error: "Google Drive file is not publicly accessible. Ensure sharing is set to 'Anyone with the link can view'." },
        400
      );
    }
    return c.json({ error: "URL returned HTML content instead of a video file" }, 400);
  }

  let mime = contentType;
  if (!mime || mime === "application/octet-stream" || !mime.startsWith("video/")) {
    mime = "video/mp4";
  }

  const lengthHeader = res.headers.get("content-length");
  const contentLength = lengthHeader ? Number(lengthHeader) : null;

  const bodyStream = contentLength ? res.body : await readAtMost(res.body, SINGLE_UPLOAD_MAX);
  if (!bodyStream) {
    return c.json(
      { error: `The server did not send a Content-Length and the file is over ${SINGLE_UPLOAD_MAX / 1024 / 1024}MB` },
      413
    );
  }

  const mediaId = newId("med_");
  const r2Key = `${mediaId}/${safeFilename(filename)}`;

  const r2Object = await c.env.MEDIA.put(r2Key, bodyStream, {
    httpMetadata: { contentType: mime },
  });

  const finalSize = r2Object?.size ?? (contentLength || 0);

  const meta: Meta = {
    filename,
    mime,
    size: finalSize,
    alt: (body.mediaAlt ?? body.media_alt) || null,
  };

  await insertMedia(c.env, mediaId, r2Key, meta, "ready", null, {
    workspaceId,
    userId: c.var.user?.id ?? null,
  });

  // 6. Resolve Schedule & Insert Posts
  const schedule = resolveSchedule(body.scheduledAt ?? body.scheduled_at);
  if (!schedule) {
    return c.json({ error: "Invalid scheduledAt timestamp" }, 400);
  }

  const { status, at } = schedule;
  const groupId = newId("grp_");
  const t = now();
  const userId = c.var.user?.id ?? null;
  const title = body.title?.trim() || null;
  const postSettings = title ? { title } : {};

  const createdPosts: Array<{
    id: string;
    accountId: string;
    accountName: string;
    provider: string;
    channelService: string;
    status: string;
    workflowId: string | null;
  }> = [];

  const postRowsToInsert: Array<{ id: string; revision: number; workflowId: string | null }> = [];
  const dbStatements: D1PreparedStatement[] = [];

  const withWorkflow = status === "scheduled" && !c.var.workspace?.demo;
  const logMessage =
    status === "scheduled"
      ? (body.scheduledAt ?? body.scheduled_at) === "now" || !body.scheduledAt
        ? "Queued for immediate publishing via External Agent Ingestion API"
        : `Scheduled for ${new Date(at!).toISOString()} via External Agent Ingestion API`
      : "Draft created via External Agent Ingestion API";

  for (const account of targetAccounts) {
    const postId = newId("pst_");
    const revision = 0;
    const workflowId = withWorkflow ? workflowInstanceId({ id: postId, revision }) : null;

    let channelService = account.provider;
    if (account.meta) {
      try {
        const metaObj = typeof account.meta === "string" ? JSON.parse(account.meta) : account.meta;
        if (metaObj.service) channelService = metaObj.service;
      } catch {}
    }

    dbStatements.push(
      c.env.DB.prepare(
        `INSERT INTO posts (id, group_id, account_id, status, scheduled_at, content, media, settings, thread, attempts, revision, workflow_id, created_at, updated_at, workspace_id, created_by)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 0, ?, ?, ?, ?, ?)`
      ).bind(
        postId,
        groupId,
        account.id,
        status,
        at,
        content,
        JSON.stringify([mediaId]),
        JSON.stringify(postSettings),
        JSON.stringify([]),
        workflowId,
        t,
        t,
        workspaceId,
        userId
      )
    );

    dbStatements.push(logStatement(c.env.DB, postId, "info", logMessage));

    postRowsToInsert.push({ id: postId, revision, workflowId });
    createdPosts.push({
      id: postId,
      accountId: account.id,
      accountName: account.name,
      provider: account.provider,
      channelService,
      status,
      workflowId,
    });
  }

  await c.env.DB.batch(dbStatements);

  if (withWorkflow) {
    try {
      await startWorkflows(c.env, postRowsToInsert);
    } catch (err) {
      console.warn("Failed to dispatch workflow:", err);
    }
  }

  const base = await baseUrl(c.env, c.req.url);
  const mediaPublicUrl = await publicMediaUrl(c.env, base, {
    id: mediaId,
    filename,
    r2_key: r2Key,
    status: "ready",
  });

  const primaryPost = createdPosts[0];

  return c.json(
    {
      success: true,
      postId: primaryPost.id,
      post_id: primaryPost.id,
      groupId,
      group_id: groupId,
      status,
      scheduledAt: at,
      scheduled_at: at,
      scheduledAtIso: at ? new Date(at).toISOString() : null,
      scheduled_at_iso: at ? new Date(at).toISOString() : null,
      mediaId,
      media_id: mediaId,
      accounts: targetAccounts.map((a) => ({
        id: a.id,
        name: a.name,
        provider: a.provider,
        username: a.username,
      })),
      media: {
        id: mediaId,
        filename,
        mime,
        size: finalSize,
        url: mediaPublicUrl,
      },
      posts: createdPosts,
    },
    201
  );
});

/**
 * GET /posts/:id
 * Status inspection endpoint allowing external agents to poll publication progress and logs.
 */
agentIngestionRoutes.get("/posts/:id", requirePermission("posts.read"), async (c) => {
  const id = c.req.param("id");
  const workspaceId = wsId(c);
  const post = await findPost(c.env, workspaceId, id);
  if (!post) {
    return c.json({ error: "Post not found" }, 404);
  }

  const { results: logs } = await c.env.DB.prepare(
    "SELECT level, message, created_at AS createdAt FROM post_logs WHERE post_id = ? ORDER BY created_at ASC"
  )
    .bind(id)
    .all<{ level: string; message: string; createdAt: number }>();

  return c.json({
    id: post.id,
    status: post.status,
    scheduledAt: post.scheduled_at,
    scheduled_at: post.scheduled_at,
    publishedAt: post.published_at,
    published_at: post.published_at,
    externalId: post.external_id,
    external_id: post.external_id,
    externalUrl: post.external_url,
    external_url: post.external_url,
    error: post.error,
    logs: logs.map((l) => ({
      level: l.level,
      message: l.message,
      createdAt: l.createdAt,
      created_at: l.createdAt,
    })),
  });
});
