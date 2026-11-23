import { Hono } from "hono";
import { authenticate, requirePermission, type AppEnv } from "../lib/auth";
import {
  CreatorResearchAgent,
  CreatorResearchError,
  DEFAULT_CREATOR_RESEARCH_URL,
  getResearchDataFromR2,
  getVideoRecordFromR2,
  listResearchRecordsFromR2,
  saveResearchDataToR2,
  saveVideoRecordToR2,
  syncResearchAndVideosToR2,
  type ResearchDayData,
  type VideoRecord,
} from "../lib/creatorResearch";

export const creatorResearchRoutes = new Hono<AppEnv>();

// Require authentication for all creator research endpoints
creatorResearchRoutes.use("*", async (c, next) => {
  const error = await authenticate(c);
  if (error) return error;
  return next();
});

function getClient(c: any, explicitApiKey?: string, explicitBaseUrl?: string): CreatorResearchAgent {
  const baseUrl = explicitBaseUrl || c.env.CREATOR_RESEARCH_AGENT_URL || DEFAULT_CREATOR_RESEARCH_URL;
  const apiKey = explicitApiKey || c.env.CREATOR_RESEARCH_API_KEY;
  return new CreatorResearchAgent({
    baseUrl,
    apiKey,
    fetchFn: c.env.fetch ? c.env.fetch.bind(c.env) : fetch.bind(globalThis),
  });
}

/**
 * GET /agent/ping
 * Pings the creator research agent service and reports connection and authentication status.
 */
creatorResearchRoutes.get("/agent/ping", requirePermission("posts.read"), async (c) => {
  const explicitUrl = c.req.query("apiUrl");
  const explicitKey = c.req.query("apiKey");
  const client = getClient(c, explicitKey, explicitUrl);

  const result = await client.ping();
  return c.json({
    success: result.reachable,
    ...result,
    configuredUrl: client.baseUrl,
  });
});

/**
 * GET /agent/accounts
 * Queries all active creator research accounts from the agent.
 */
creatorResearchRoutes.get("/agent/accounts", requirePermission("posts.read"), async (c) => {
  try {
    const client = getClient(c);
    const accounts = await client.getAccounts();
    return c.json({ success: true, accounts });
  } catch (err: any) {
    const status = err instanceof CreatorResearchError ? err.statusCode : 500;
    return c.json({ success: false, error: err.message, details: err.responseBody }, status as any);
  }
});

/**
 * GET /agent/day
 * Queries research day, videos, and post drafts from the research agent.
 */
creatorResearchRoutes.get("/agent/day", requirePermission("posts.read"), async (c) => {
  const accountId = c.req.query("account_id") || c.req.query("accountId");
  const date = c.req.query("date") || c.req.query("day_date");

  if (!accountId || !date) {
    return c.json({ success: false, error: "accountId and date query parameters are required" }, 400);
  }

  try {
    const client = getClient(c);
    const data = await client.getResearchDay(accountId, date);
    return c.json({ success: true, ...data });
  } catch (err: any) {
    const status = err instanceof CreatorResearchError ? err.statusCode : 500;
    return c.json({ success: false, error: err.message, details: err.responseBody }, status as any);
  }
});

/**
 * GET /agent/videos
 * Queries videos for an account from the research agent.
 */
creatorResearchRoutes.get("/agent/videos", requirePermission("posts.read"), async (c) => {
  const accountId = c.req.query("account_id") || c.req.query("accountId");
  const limitParam = c.req.query("limit");
  const limit = limitParam ? parseInt(limitParam, 10) : 50;

  if (!accountId) {
    return c.json({ success: false, error: "accountId query parameter is required" }, 400);
  }

  try {
    const client = getClient(c);
    const videos = await client.getVideos(accountId, limit);
    return c.json({ success: true, videos });
  } catch (err: any) {
    const status = err instanceof CreatorResearchError ? err.statusCode : 500;
    return c.json({ success: false, error: err.message, details: err.responseBody }, status as any);
  }
});

/**
 * POST /sync
 * Queries research data and video records from the research agent and syncs them to Cloudflare R2 storage.
 */
creatorResearchRoutes.post("/sync", requirePermission("posts.write"), async (c) => {
  let body: any;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ success: false, error: "Invalid JSON body" }, 400);
  }

  const accountId = body.accountId || body.account_id;
  if (!accountId) {
    return c.json({ success: false, error: "accountId is required" }, 400);
  }

  const date = body.date || body.day_date;
  const videoLimit = body.videoLimit ? parseInt(body.videoLimit, 10) : 50;
  const client = getClient(c, body.apiKey, body.apiUrl);

  try {
    const result = await syncResearchAndVideosToR2(c.env, client, accountId, {
      date,
      videoLimit,
    });

    return c.json({
      success: true,
      message: `Successfully synchronized research data to Cloudflare R2`,
      ...result,
    });
  } catch (err: any) {
    const status = err instanceof CreatorResearchError ? err.statusCode : 500;
    return c.json({ success: false, error: err.message, details: err.responseBody }, status as any);
  }
});

/**
 * GET /r2/research-day
 * Reads research day snapshot from Cloudflare R2 storage.
 */
creatorResearchRoutes.get("/r2/research-day", requirePermission("posts.read"), async (c) => {
  const accountId = c.req.query("account_id") || c.req.query("accountId");
  const date = c.req.query("date") || c.req.query("day_date");

  if (!accountId || !date) {
    return c.json({ success: false, error: "accountId and date query parameters are required" }, 400);
  }

  try {
    const data = await getResearchDataFromR2(c.env, accountId, date);
    if (!data) {
      return c.json({ success: false, error: "Research day not found in R2 storage" }, 404);
    }
    return c.json({ success: true, data });
  } catch (err: any) {
    return c.json({ success: false, error: err.message }, 500);
  }
});

/**
 * POST /r2/research-day
 * Stores research day snapshot into Cloudflare R2 storage.
 */
creatorResearchRoutes.post("/r2/research-day", requirePermission("posts.write"), async (c) => {
  let body: any;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ success: false, error: "Invalid JSON body" }, 400);
  }

  const accountId = body.accountId || body.account_id;
  const date = body.date || body.day_date;
  const data = body.data as ResearchDayData;

  if (!accountId || !date || !data) {
    return c.json({ success: false, error: "accountId, date, and data are required" }, 400);
  }

  try {
    const saved = await saveResearchDataToR2(c.env, accountId, date, data);
    return c.json({ success: true, ...saved });
  } catch (err: any) {
    return c.json({ success: false, error: err.message }, 500);
  }
});

/**
 * GET /r2/videos/:accountId/:videoId
 * Reads a video record from Cloudflare R2 storage.
 */
creatorResearchRoutes.get("/r2/videos/:accountId/:videoId", requirePermission("posts.read"), async (c) => {
  const accountId = c.req.param("accountId");
  const videoId = c.req.param("videoId");

  try {
    const video = await getVideoRecordFromR2(c.env, accountId, videoId);
    if (!video) {
      return c.json({ success: false, error: "Video record not found in R2 storage" }, 404);
    }
    return c.json({ success: true, video });
  } catch (err: any) {
    return c.json({ success: false, error: err.message }, 500);
  }
});

/**
 * POST /r2/videos
 * Stores a video record into Cloudflare R2 storage.
 */
creatorResearchRoutes.post("/r2/videos", requirePermission("posts.write"), async (c) => {
  let body: any;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ success: false, error: "Invalid JSON body" }, 400);
  }

  const video = (body.video || body) as VideoRecord;
  if (!video || !video.account_id || !video.id) {
    return c.json({ success: false, error: "video object with account_id and id is required" }, 400);
  }

  try {
    const saved = await saveVideoRecordToR2(c.env, video);
    return c.json({ success: true, ...saved });
  } catch (err: any) {
    return c.json({ success: false, error: err.message }, 500);
  }
});

/**
 * GET /r2/records
 * Lists research and video records currently stored in Cloudflare R2.
 */
creatorResearchRoutes.get("/r2/records", requirePermission("posts.read"), async (c) => {
  const prefix = c.req.query("prefix") || "research/";
  try {
    const keys = await listResearchRecordsFromR2(c.env, prefix);
    return c.json({ success: true, keys, count: keys.length });
  } catch (err: any) {
    return c.json({ success: false, error: err.message }, 500);
  }
});
