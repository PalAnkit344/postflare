import { createExecutionContext, waitOnExecutionContext, env } from "cloudflare:test";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import worker from "../../worker/index";
import { ORIGIN, sessionCookie } from "../workers/helpers";
import type { PostRow } from "../../worker/lib/posts";
import type { MediaRow } from "../../worker/lib/media";

// --------------------------------------------------------------------------------------------------
// Fixtures & Test Harness
// --------------------------------------------------------------------------------------------------

function fakeWorkflows() {
  const created: Array<{ id: string; params: any }> = [];
  const handle = (id: string) => ({
    id,
    status: async () => ({ status: "running" }),
    terminate: async () => {},
  });
  const binding = {
    create: async (o: { id: string; params: any }) => {
      created.push(o);
      return handle(o.id);
    },
    createBatch: async (list: Array<{ id: string; params: any }>) => {
      created.push(...list);
      return list.map((o) => handle(o.id));
    },
    get: async (id: string) => handle(id),
  };
  return { binding, created };
}

const wf = fakeWorkflows();
const E = {
  ...env,
  DB: env.DB,
  PUBLISH_WORKFLOW: wf.binding,
  DEMO_MODE: "false",
  PUBLIC_URL: ORIGIN,
  MEDIA_PUBLIC_URL: undefined,
} as unknown as Env;

interface CustomCallOptions {
  method?: string;
  body?: unknown;
  headers?: Record<string, string>;
  raw?: BodyInit;
}

async function call(
  client: { cookie?: string; key?: string; ws?: string } | null,
  path: string,
  opts: CustomCallOptions = {}
) {
  const headers: Record<string, string> = { ...(opts.headers ?? {}) };
  if (client?.cookie) headers.cookie = client.cookie;
  if (client?.key) headers.authorization = `Bearer ${client.key}`;
  if (client?.ws && !headers["x-workspace-id"]) headers["x-workspace-id"] = client.ws;
  let body: BodyInit | undefined = opts.raw;
  if (opts.body !== undefined) {
    headers["content-type"] = "application/json";
    body = JSON.stringify(opts.body);
  }
  const ctx = createExecutionContext();
  const req = new Request(`${ORIGIN}${path}`, {
    method: opts.method ?? (body ? "POST" : "GET"),
    headers,
    body,
  });
  const res = await worker.fetch!(req as any, E, ctx);
  await waitOnExecutionContext(ctx);
  const text = await res.text();
  let json: any = null;
  try {
    json = JSON.parse(text);
  } catch {}
  return { status: res.status, json, text, headers: res.headers, cookie: sessionCookie(res.headers) };
}

// --------------------------------------------------------------------------------------------------
// Global Mock Fetch
// --------------------------------------------------------------------------------------------------

const capturedFetchUrls: string[] = [];

function setupMocks() {
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
    const req = new Request(input, init);
    const url = req.url;
    capturedFetchUrls.push(url);

    // 1. Image / Avatar mocks
    if (url.includes("avatar") || url.includes(".png") || url.includes(".jpg")) {
      return new Response(new Uint8Array([137, 80, 78, 71]), {
        headers: { "content-type": "image/png" },
      });
    }

    // 2. Buffer API mock
    if (url.startsWith("https://api.buffer.com")) {
      return Response.json({
        data: {
          account: {
            id: "buf_acc_agent_e2e",
            name: "Agent E2E Buffer User",
            organizations: [
              {
                id: "org_agent_e2e",
                name: "Agent Org",
                channels: [
                  {
                    id: "ch_insta_101",
                    name: "Agent Instagram",
                    displayName: "@agent_insta",
                    service: "instagram",
                    serviceId: "srv_agent_insta",
                    avatar: "https://buffer.test/avatar.png",
                  },
                  {
                    id: "ch_tiktok_102",
                    name: "Agent TikTok",
                    displayName: "@agent_tiktok",
                    service: "tiktok",
                    serviceId: "srv_agent_tiktok",
                    avatar: "https://buffer.test/avatar.png",
                  },
                ],
              },
            ],
          },
        },
      });
    }

    // 3. Google Drive / Usercontent mock
    if (url.includes("drive.usercontent.google.com") || url.includes("drive.google.com")) {
      // Simulate private Google Drive file returning an HTML sign-in page
      if (url.includes("PRIVATE_FILE")) {
        return new Response("<!DOCTYPE html><html><body>Sign in with Google</body></html>", {
          status: 200,
          headers: { "content-type": "text/html; charset=utf-8" },
        });
      }

      // Successful Google Drive video download stream
      const videoBytes = new Uint8Array(250).fill(123);
      return new Response(videoBytes, {
        status: 200,
        headers: {
          "content-type": "video/mp4",
          "content-length": "250",
        },
      });
    }

    // 4. Direct public video URL mock
    if (url.includes("direct_sample.mp4")) {
      const videoBytes = new Uint8Array(120).fill(200);
      return new Response(videoBytes, {
        status: 200,
        headers: {
          "content-type": "video/mp4",
          "content-length": "120",
        },
      });
    }

    // 5. HTML error file mock
    if (url.includes("not_a_video.html")) {
      return new Response("<html><body>404 Not a video</body></html>", {
        status: 200,
        headers: { "content-type": "text/html" },
      });
    }

    return new Response("Not found", { status: 404 });
  });
}

// --------------------------------------------------------------------------------------------------
// Test Suite: External Video Agent Ingestion API (Milestone 3)
// --------------------------------------------------------------------------------------------------

describe("External Video Agent Ingestion API & Architectural Pipeline (Milestone 3)", () => {
  let ownerCookie: string;
  let workspaceId: string;
  let apiKey: string;
  let agentClient: { key: string };
  const targetTag = "client-agent-tag";

  beforeAll(async () => {
    setupMocks();

    // 1. Setup workspace & owner
    const setupRes = await call(null, "/api/auth/setup", {
      body: {
        name: "Agent Test Admin",
        email: "agent_admin_e2e@example.com",
        password: "password123",
        workspaceName: "Agent Ingestion Enterprise",
      },
    });
    expect(setupRes.status).toBe(200);
    ownerCookie = setupRes.cookie!;

    // Retrieve workspace ID
    const meRes = await call({ cookie: ownerCookie }, "/api/me");
    expect(meRes.status).toBe(200);
    workspaceId = meRes.json.currentWorkspaceId;
    expect(workspaceId).toBeDefined();

    // 2. Connect a Buffer account with channels
    const connectRes = await call({ cookie: ownerCookie }, "/api/connect/buffer", {
      body: { values: { apiKey: "buf_pat_agent_test_key", tag: targetTag } },
    });
    expect(connectRes.status, `Connect Buffer failed: ${connectRes.text}`).toBe(200);
    expect(connectRes.json.ids.length).toBe(2);

    // 3. Create Workspace API Key (pf_...)
    const keyRes = await call({ cookie: ownerCookie }, "/api/keys", {
      body: { name: "External Video Agent Key" },
    });
    expect(keyRes.status).toBe(201);
    expect(keyRes.json.token).toMatch(/^pf_/);
    apiKey = keyRes.json.token;
    agentClient = { key: apiKey };
  });

  afterEach(() => {
    capturedFetchUrls.length = 0;
  });

  // ==============================================================================================
  // 1. Authentication Verification
  // ==============================================================================================

  describe("1. Authentication Verification", () => {
    it("rejects requests missing an Authorization header with 401 Unauthorized", async () => {
      const res = await call(null, "/api/v1/agent/posts", {
        method: "POST",
        body: {
          content: "Test video post",
          videoUrl: "https://example.com/direct_sample.mp4",
          accountTag: targetTag,
        },
      });

      expect(res.status).toBe(401);
      expect(res.json.error).toBe("Unauthorized");
    });

    it("rejects requests with an invalid Bearer token format with 401 Unauthorized", async () => {
      const res = await call(null, "/api/v1/agent/posts", {
        method: "POST",
        headers: { authorization: "Bearer invalid_random_token" },
        body: {
          content: "Test video post",
          videoUrl: "https://example.com/direct_sample.mp4",
        },
      });

      expect(res.status).toBe(401);
      expect(res.json.error).toBe("Unauthorized");
    });

    it("rejects requests with a non-existent pf_ token with 401 Unauthorized", async () => {
      const res = await call(null, "/api/v1/agent/posts", {
        method: "POST",
        headers: { authorization: "Bearer pf_00000000000000000000000000000000" },
        body: {
          content: "Test video post",
          videoUrl: "https://example.com/direct_sample.mp4",
        },
      });

      expect(res.status).toBe(401);
      expect(res.json.error).toBe("Unauthorized");
    });

    it("accepts requests with a valid Bearer pf_... workspace API key", async () => {
      const res = await call(agentClient, "/api/v1/agent/posts", {
        method: "POST",
        body: {
          content: "Auth check post copy",
          videoUrl: "https://example.com/direct_sample.mp4",
          accountTag: targetTag,
        },
      });

      expect(res.status).toBe(201);
      expect(res.json.success).toBe(true);
    });
  });

  // ==============================================================================================
  // 2. Request Validation & Error Handling
  // ==============================================================================================

  describe("2. Request Validation & Error Handling", () => {
    it("returns 400 when content/text is missing or empty", async () => {
      const res = await call(agentClient, "/api/v1/agent/posts", {
        method: "POST",
        body: {
          content: "   ",
          videoUrl: "https://example.com/direct_sample.mp4",
          accountTag: targetTag,
        },
      });

      expect(res.status).toBe(400);
      expect(res.json.error).toMatch(/content is required/i);
    });

    it("returns 400 when videoUrl is missing", async () => {
      const res = await call(agentClient, "/api/v1/agent/posts", {
        method: "POST",
        body: {
          content: "Valid copy but missing video",
          accountTag: targetTag,
        },
      });

      expect(res.status).toBe(400);
      expect(res.json.error).toMatch(/videoUrl is required/i);
    });

    it("returns 400 when videoUrl is not a valid URL", async () => {
      const res = await call(agentClient, "/api/v1/agent/posts", {
        method: "POST",
        body: {
          content: "Valid copy",
          videoUrl: "ftp://invalid-protocol.com/video.mp4",
          accountTag: targetTag,
        },
      });

      expect(res.status).toBe(400);
      expect(res.json.error).toMatch(/videoUrl must use http or https protocol/i);
    });

    it("returns 400 when videoUrl points to a Google Drive folder", async () => {
      const res = await call(agentClient, "/api/v1/agent/posts", {
        method: "POST",
        body: {
          content: "Folder test",
          videoUrl: "https://drive.google.com/drive/folders/1ABC_FOLDER_ID_12345",
          accountTag: targetTag,
        },
      });

      expect(res.status).toBe(400);
      expect(res.json.error).toMatch(/folder/i);
    });

    it("returns 400 when accountTag does not match any active accounts", async () => {
      const res = await call(agentClient, "/api/v1/agent/posts", {
        method: "POST",
        body: {
          content: "Unknown tag test",
          videoUrl: "https://example.com/direct_sample.mp4",
          accountTag: "nonexistent-tag-999",
        },
      });

      expect(res.status).toBe(400);
      expect(res.json.error).toMatch(/No active accounts found for accountTag/i);
    });

    it("returns 400 when accountId does not exist", async () => {
      const res = await call(agentClient, "/api/v1/agent/posts", {
        method: "POST",
        body: {
          content: "Unknown accountId test",
          videoUrl: "https://example.com/direct_sample.mp4",
          accountId: "acc_nonexistent_xyz",
        },
      });

      expect(res.status).toBe(400);
      expect(res.json.error).toMatch(/No active accounts found for accountId/i);
    });

    it("returns 400 when scheduledAt is an unparseable timestamp", async () => {
      const res = await call(agentClient, "/api/v1/agent/posts", {
        method: "POST",
        body: {
          content: "Invalid date test",
          videoUrl: "https://example.com/direct_sample.mp4",
          accountTag: targetTag,
          scheduledAt: "invalid-not-a-date",
        },
      });

      expect(res.status).toBe(400);
      expect(res.json.error).toMatch(/Invalid scheduledAt timestamp/i);
    });

    it("returns 400 with a clear error when a private Google Drive link returns HTML", async () => {
      const res = await call(agentClient, "/api/v1/agent/posts", {
        method: "POST",
        body: {
          content: "Private Google Drive test",
          videoUrl: "https://drive.google.com/file/d/1PRIVATE_FILE_XYZ_1234567890/view?usp=sharing",
          accountTag: targetTag,
        },
      });

      expect(res.status).toBe(400);
      expect(res.json.error).toMatch(/Google Drive file is not publicly accessible/i);
    });
  });

  // ==============================================================================================
  // 3. Direct Public Video Ingestion
  // ==============================================================================================

  describe("3. Direct Public Video Ingestion", () => {
    it("successfully downloads direct video URL, streams to R2, and creates scheduled post", async () => {
      const res = await call(agentClient, "/api/v1/agent/posts", {
        method: "POST",
        body: {
          content: "Showcasing our new AI-generated drone reel 🚁 #DroneLife",
          videoUrl: "https://example.com/direct_sample.mp4",
          accountTag: targetTag,
          channelServices: ["instagram"],
          scheduledAt: "now",
          title: "AI Drone Reel",
          filename: "drone_reel_01.mp4",
        },
      });

      expect(res.status).toBe(201);
      const json = res.json;
      expect(json.success).toBe(true);
      expect(json.postId).toBeDefined();
      expect(json.groupId).toBeDefined();
      expect(json.status).toBe("scheduled");
      expect(json.mediaId).toBeDefined();
      expect(json.accounts.length).toBe(1);
      expect(json.accounts[0].name).toContain("@agent_insta");
      expect(json.media.filename).toBe("drone_reel_01.mp4");
      expect(json.media.mime).toBe("video/mp4");
      expect(json.media.size).toBe(120);

      // Verify Cloudflare R2 contains the object
      const r2Key = `${json.mediaId}/drone_reel_01.mp4`;
      const r2Object = await E.MEDIA.get(r2Key);
      expect(r2Object).not.toBeNull();
      expect(r2Object!.httpMetadata?.contentType).toBe("video/mp4");

      // Verify D1 media table row
      const mediaRow = await E.DB.prepare("SELECT * FROM media WHERE id = ?").bind(json.mediaId).first<MediaRow>();
      expect(mediaRow).not.toBeNull();
      expect(mediaRow!.filename).toBe("drone_reel_01.mp4");
      expect(mediaRow!.status).toBe("ready");
      expect(mediaRow!.kind).toBe("video");

      // Verify D1 posts table row
      const postRow = await E.DB.prepare("SELECT * FROM posts WHERE id = ?").bind(json.postId).first<PostRow>();
      expect(postRow).not.toBeNull();
      expect(postRow!.content).toContain("AI-generated drone reel");
      expect(postRow!.status).toBe("scheduled");
      expect(postRow!.workflow_id).toBeDefined();
      expect(postRow!.media).toContain(json.mediaId);

      // Verify PublishWorkflow was triggered
      expect(wf.created.length).toBeGreaterThan(0);
      expect(wf.created.some((w) => w.id.startsWith(json.postId))).toBe(true);
    });
  });

  // ==============================================================================================
  // 4. Google Drive Stream Ingestion & Virus Interstitial Bypass
  // ==============================================================================================

  describe("4. Google Drive Stream Ingestion Pipeline", () => {
    it("parses Google Drive sharing URL, bypasses virus confirmation interstitial (&confirm=t), and streams to R2", async () => {
      const gdriveFileId = "1B2C3D4E5F6G7H8I9J0K1L2M3N4O";
      const gdriveShareUrl = `https://drive.google.com/file/d/${gdriveFileId}/view?usp=sharing`;

      const res = await call(agentClient, "/api/v1/agent/posts", {
        method: "POST",
        body: {
          content: "Automated video from Google Drive! 🎬 #GoogleDrive #Ingestion",
          videoUrl: gdriveShareUrl,
          accountTag: targetTag,
          scheduledAt: "2026-11-25T18:00:00.000Z",
          filename: "custom_gdrive_video.mp4",
        },
      });

      expect(res.status).toBe(201);
      const json = res.json;
      expect(json.success).toBe(true);
      expect(json.media.size).toBe(250);
      expect(json.posts.length).toBe(2); // Posts created for both Instagram and TikTok channels

      // Verify the fetch was called with confirm=t override to bypass virus scan interstitial
      const gdriveFetchCall = capturedFetchUrls.find((u) => u.includes(gdriveFileId));
      expect(gdriveFetchCall).toBeDefined();
      expect(gdriveFetchCall).toContain("confirm=t");
      expect(gdriveFetchCall).toContain("export=download");

      // Verify R2 object existence and size
      const r2Key = `${json.mediaId}/custom_gdrive_video.mp4`;
      const r2Object = await E.MEDIA.get(r2Key);
      expect(r2Object).not.toBeNull();
      expect(r2Object!.size).toBe(250);
    });

    it("supports Google Drive open?id=... and uc?id=... parameter URL formats", async () => {
      const fileId2 = "2C3D4E5F6G7H8I9J0K1L2M3N4O5P";
      const gdriveUcUrl = `https://drive.google.com/uc?id=${fileId2}&export=download`;

      const res = await call(agentClient, "/api/v1/agent/posts", {
        method: "POST",
        body: {
          content: "Testing alternate Google Drive UC url pattern",
          videoUrl: gdriveUcUrl,
          accountTag: targetTag,
          channelServices: ["tiktok"],
        },
      });

      expect(res.status).toBe(201);
      expect(res.json.success).toBe(true);

      const fetchCall = capturedFetchUrls.find((u) => u.includes(fileId2));
      expect(fetchCall).toBeDefined();
      expect(fetchCall).toContain("confirm=t");
    });
  });

  // ==============================================================================================
  // 5. Post Status Inspection Endpoint
  // ==============================================================================================

  describe("5. Post Status Inspection (GET /api/v1/agent/posts/:id)", () => {
    let createdPostId: string;

    beforeAll(async () => {
      const res = await call(agentClient, "/api/v1/agent/posts", {
        method: "POST",
        body: {
          content: "Post for status inspection",
          videoUrl: "https://example.com/direct_sample.mp4",
          accountTag: targetTag,
          channelServices: ["instagram"],
        },
      });
      expect(res.status).toBe(201);
      createdPostId = res.json.postId;
    });

    it("returns 200 with post details, schedule, and logs for a valid post ID", async () => {
      const res = await call(agentClient, `/api/v1/agent/posts/${createdPostId}`);

      expect(res.status).toBe(200);
      const json = res.json;
      expect(json.id).toBe(createdPostId);
      expect(json.status).toBe("scheduled");
      expect(json.scheduledAt).toBeDefined();
      expect(Array.isArray(json.logs)).toBe(true);
      expect(json.logs.length).toBeGreaterThan(0);
      expect(json.logs[0].message).toContain("External Agent Ingestion API");
    });

    it("returns 404 Not Found for a non-existent post ID", async () => {
      const res = await call(agentClient, "/api/v1/agent/posts/pst_nonexistent_12345");

      expect(res.status).toBe(404);
      expect(res.json.error).toBe("Post not found");
    });

    it("reflects updated status when post is marked published with externalUrl", async () => {
      // Simulate workflow marking post published
      const t = Date.now();
      await E.DB.prepare(
        "UPDATE posts SET status = 'published', published_at = ?, external_url = 'https://instagram.com/p/TEST_POST_123' WHERE id = ?"
      )
        .bind(t, createdPostId)
        .run();

      const res = await call(agentClient, `/api/v1/agent/posts/${createdPostId}`);
      expect(res.status).toBe(200);
      expect(res.json.status).toBe("published");
      expect(res.json.publishedAt).toBe(t);
      expect(res.json.externalUrl).toBe("https://instagram.com/p/TEST_POST_123");
    });
  });

  // ==============================================================================================
  // 6. Route Mounting Aliases
  // ==============================================================================================

  describe("6. Route Aliasing & Mounting Verification", () => {
    it("supports the /api/incoming/posts route alias", async () => {
      const res = await call(agentClient, "/api/incoming/posts", {
        method: "POST",
        body: {
          content: "Testing /api/incoming alias",
          videoUrl: "https://example.com/direct_sample.mp4",
          accountTag: targetTag,
        },
      });

      expect(res.status).toBe(201);
      expect(res.json.success).toBe(true);
    });
  });
});
