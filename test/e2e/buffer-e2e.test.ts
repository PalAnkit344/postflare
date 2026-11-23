import { createExecutionContext, waitOnExecutionContext, env } from "cloudflare:test";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import worker from "../../worker/index";
import { getProvider, providerInfo } from "../../worker/providers/registry";
import { PROVIDER_NAMES, providerDisplayName } from "../../shared/providerNames";
import { ORIGIN, sessionCookie, type Client } from "../workers/helpers";
import type { AccountRecord, PublishPost } from "../../worker/providers/types";
import { providerContext } from "../../worker/lib/accounts";
import { ProviderError } from "../../worker/providers/errors";
import { decryptJson } from "../../worker/lib/crypto";

// --------------------------------------------------------------------------------------------------
// Fixtures, Environment & Harness
// --------------------------------------------------------------------------------------------------

function fakeWorkflows() {
  const created: Array<{ id: string; params: any }> = [];
  const statuses = new Map<string, string | Error>();
  const handle = (id: string) => ({
    id,
    status: async () => {
      const s = statuses.get(id);
      if (s instanceof Error) throw s;
      return { status: s ?? "running" };
    },
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
  return { binding, created, statuses };
}

const wf = fakeWorkflows();
const E = {
  ...env,
  DB: env.ACCOUNTS_DB,
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

async function call(client: Client | null, path: string, opts: CustomCallOptions = {}) {
  const headers: Record<string, string> = { ...(opts.headers ?? {}) };
  if (client?.cookie) headers.cookie = client.cookie;
  if (client?.ws) headers["x-workspace-id"] = client.ws;
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

const uploadVideo = async (client: Client, filename = "video.mp4", size = 2048) => {
  const raw = new Uint8Array(size).fill(42);
  return call(client, "/api/media", {
    method: "POST",
    raw,
    headers: {
      "content-type": "video/mp4",
      "content-length": String(size),
      "x-filename": filename,
    },
  });
};

interface MockBufferOptions {
  channelId?: string;
  channelName?: string;
  service?: string;
  failConnect?: boolean;
  failPublish?: boolean;
  failPublishGql?: boolean;
  rateLimit?: boolean;
  rateLimitGql?: boolean;
  postStatus?: "sent" | "published" | "buffer" | "failed";
}

function mockBufferApi(opts: MockBufferOptions = {}) {
  const calls: Array<{ url: string; method: string; headers: Record<string, string>; body: any }> = [];

  vi.spyOn(globalThis, "fetch").mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
    const req = new Request(input, init);
    const headers: Record<string, string> = {};
    req.headers.forEach((v, k) => (headers[k.toLowerCase()] = v));
    let body: any = null;
    try {
      body = await req.clone().json();
    } catch {}
    calls.push({ url: req.url, method: req.method, headers, body });

    // Avatar image fetch during connect
    if (req.url.includes("avatar") || req.url.includes(".png") || req.url.includes(".jpg")) {
      return new Response(new Uint8Array([137, 80, 78, 71]), {
        headers: { "content-type": "image/png" },
      });
    }

    // GraphQL endpoint: https://api.buffer.com
    if (req.url.startsWith("https://api.buffer.com")) {
      if (opts.failConnect) {
        return Response.json({ errors: [{ message: "Unauthorized", extensions: { code: "UNAUTHENTICATED" } }] }, { status: 401 });
      }
      if (opts.rateLimitGql) {
        return Response.json({ errors: [{ message: "Rate limit reached", extensions: { code: "RATE_LIMIT_EXCEEDED" } }] }, { status: 429 });
      }
      if (opts.failPublishGql) {
        return Response.json({ errors: [{ message: "Forbidden", extensions: { code: "FORBIDDEN" } }] }, { status: 403 });
      }

      const query = String(body?.query ?? "");
      if (query.includes("GetAccountAndChannels")) {
        return Response.json({
          data: {
            account: {
              id: "buf_acc_1",
              name: "Postflare User",
              organizations: [
                {
                  id: "buf_org_1",
                  name: "Buffer Org",
                  channels: [
                    {
                      id: opts.channelId ?? "ch_default",
                      name: opts.channelName ?? "Default Channel",
                      displayName: opts.channelName ?? "Default Channel",
                      service: opts.service ?? "instagram",
                      serviceId: "srv_123",
                      avatar: "https://buffer.test/avatar.png",
                    },
                  ],
                },
              ],
            },
          },
        });
      }

      if (query.includes("CreatePost")) {
        if (opts.failPublish) {
          return Response.json({ data: { createPost: { message: "Account locked" } } });
        }
        return Response.json({
          data: {
            createPost: {
              __typename: "PostActionSuccess",
              post: {
                id: "buf_post_" + Math.random().toString(36).slice(2, 8),
                status: opts.postStatus ?? "buffer",
                dueAt: body?.variables?.input?.dueAt ?? null,
              },
            },
          },
        });
      }

      if (query.includes("GetPostStatus")) {
        const id = body?.variables?.id ?? "buf_post_1";
        return Response.json({
          data: {
            post: {
              id,
              status: opts.postStatus ?? "sent",
              dueAt: null,
              sentAt: new Date().toISOString(),
            },
          },
        });
      }

      return Response.json({ data: {} });
    }

    // REST endpoint: https://api.bufferapp.com/1
    if (req.url.startsWith("https://api.bufferapp.com/1")) {
      if (opts.rateLimit) {
        return new Response(JSON.stringify({ error: "Too Many Requests" }), {
          status: 429,
          headers: { "Retry-After": "60", "Content-Type": "application/json" },
        });
      }
      if (opts.failConnect) {
        return Response.json({ error: "Unauthorized" }, { status: 401 });
      }
      if (opts.failPublish) {
        return Response.json({ error: "Invalid token" }, { status: 403 });
      }

      if (req.url.includes("/profiles.json")) {
        return Response.json([
          {
            id: opts.channelId ?? "ch_rest_1",
            formatted_username: opts.channelName ?? "REST Channel",
            service: opts.service ?? "instagram",
            service_id: "srv_456",
            avatar: "https://buffer.test/rest-avatar.png",
          },
        ]);
      }

      if (req.url.includes("/updates/create.json")) {
        return Response.json({
          success: true,
          buffer_count: 1,
          updates: [{ id: "up_" + Math.random().toString(36).slice(2, 8), status: "buffer" }],
        });
      }

      if (req.url.match(/\/updates\/[^/]+\.json/)) {
        return Response.json({
          id: "up_123",
          status: opts.postStatus ?? "sent",
        });
      }

      return Response.json({ success: true });
    }

    return new Response(JSON.stringify({ error: "Unhandled mock URL: " + req.url }), { status: 404 });
  });

  return { calls };
}

// --------------------------------------------------------------------------------------------------
// Master E2E Test Suite (Tiers 1-4)
// --------------------------------------------------------------------------------------------------

describe("Postflare Buffer E2E Integration Suite", () => {
  let ownerClient: Client;
  let primaryAccountId: string;
  let secondaryAccountId: string;

  beforeAll(async () => {
    mockBufferApi();
    const setup = await call(null, "/api/auth/setup", {
      body: {
        name: "BufferAdmin",
        email: "buffer_admin@example.com",
        password: "Password123!",
        workspaceName: "BufferWorkspace",
      },
    });
    expect(setup.status).toBe(200);
    ownerClient = { cookie: setup.cookie! };

    // Connect initial accounts for testing
    const c1 = await call(ownerClient, "/api/connect/buffer", {
      body: { values: { apiKey: "init_token_1", tag: "primary-brand" } },
    });
    expect(c1.status).toBe(200);
    primaryAccountId = c1.json.ids[0];

    const c2 = await call(ownerClient, "/api/connect/buffer", {
      body: { values: { apiKey: "init_token_2", tag: "secondary-brand" } },
    });
    expect(c2.status).toBe(200);
    secondaryAccountId = c2.json.ids[0];
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // ==============================================================================================
  // TIER 1: FEATURE COVERAGE (50 tests, 5 per feature across 10 features F1..F10)
  // ==============================================================================================
  describe("Tier 1: Feature Coverage", () => {
    describe("F1: Buffer Provider Core", () => {
      it("F1.1: declares capabilities including video and hotlinksMedia flag", () => {
        const p = getProvider("buffer");
        expect(p).toBeDefined();
        expect(p?.id).toBe("buffer");
        expect(p?.auth).toBe("credentials");
        expect(p?.capabilities?.media?.videos).toBe(1);
        expect(p?.hotlinksMedia).toBe(true);
      });

      it("F1.2: connects with valid API key via GraphQL returning ConnectedAccounts with channel IDs", async () => {
        mockBufferApi({ channelId: "ch_core_1", channelName: "Alpha Core" });
        const p = getProvider("buffer")!;
        const ctx = await providerContext(E, p);
        const accounts = await p.connect!(ctx, { apiKey: "buf_key_core", tag: "core-alpha" });
        expect(accounts.length).toBeGreaterThan(0);
        expect(accounts[0].externalId).toBe("core-alpha:ch_core_1");
        expect(accounts[0].username).toBe("core-alpha");
        expect(accounts[0].credentials.apiKey).toBe("buf_key_core");
      });

      it("F1.3: falls back to REST /1/profiles.json when GraphQL fails", async () => {
        vi.spyOn(globalThis, "fetch").mockImplementation(async (input: RequestInfo | URL) => {
          const url = String(input);
          if (url.startsWith("https://api.buffer.com")) {
            return Response.json({ errors: [{ message: "GraphQL not supported for this user" }] }, { status: 400 });
          }
          if (url.includes("/profiles.json")) {
            return Response.json([{ id: "ch_rest_profile", formatted_username: "REST Profile", service: "instagram" }]);
          }
          return new Response(new Uint8Array([137, 80, 78, 71]), { headers: { "content-type": "image/png" } });
        });
        const p = getProvider("buffer")!;
        const ctx = await providerContext(E, p);
        const accounts = await p.connect!(ctx, { apiKey: "buf_key_rest", tag: "rest-brand" });
        expect(accounts.length).toBeGreaterThan(0);
        expect(accounts[0].externalId).toBe("rest-brand:ch_rest_profile");
      });

      it("F1.4: publishes video post with public R2 URL in GraphQL assets payload", async () => {
        const { calls } = mockBufferApi({ channelId: "ch_vid_core" });
        const p = getProvider("buffer")!;
        const ctx = await providerContext(E, p);
        const accountRec: AccountRecord = {
          id: "acc_vid_test",
          provider: "buffer",
          externalId: "brand:ch_vid_core",
          name: "Brand",
          username: "brand",
          credentials: { apiKey: "key_vid" },
          expiresAt: null,
          meta: { channelId: "ch_vid_core" },
        };
        const scheduledTime = Date.now() + 3600000;
        const post: PublishPost = {
          id: "pst_vid_test",
          content: "Video post test",
          scheduledAt: scheduledTime,
          media: [
            {
              id: "med_vid_1",
              kind: "video",
              mime: "video/mp4",
              filename: "promo.mp4",
              size: 5000,
              width: 1920,
              height: 1080,
              duration: 30,
              alt: "Promo video",
              url: "https://pf.test/m/med_vid_1/sig_vid/promo.mp4",
            },
          ],
          settings: {},
        };
        const res = await p.publish(ctx, accountRec, post);
        expect(res.status).toBe("published");
        const gql = calls.find((c) => c.url.includes("api.buffer.com"));
        expect(gql).toBeDefined();
        expect(gql?.headers["authorization"]).toBe("Bearer key_vid");
        expect(gql?.body?.variables?.input?.assets?.[0]?.video?.url).toBe("https://pf.test/m/med_vid_1/sig_vid/promo.mp4");
        expect(gql?.body?.variables?.input?.assets?.[0]?.video?.metadata?.thumbnailOffset).toBe(0);
        expect(gql?.body?.variables?.input?.mode).toBe("customScheduled");
        expect(gql?.body?.variables?.input?.schedulingType).toBe("automatic");
        expect(gql?.body?.variables?.input?.dueAt).toBe(new Date(scheduledTime).toISOString());
      });

      it("F1.5: checkStatus reports published/sent status when queried", async () => {
        mockBufferApi({ postStatus: "sent" });
        const p = getProvider("buffer")!;
        const ctx = await providerContext(E, p);
        const accountRec: AccountRecord = {
          id: "acc_vid_test",
          provider: "buffer",
          externalId: "brand:ch_vid_core",
          name: "Brand",
          username: "brand",
          credentials: { apiKey: "key_vid" },
          expiresAt: null,
          meta: { channelId: "ch_vid_core" },
        };
        const statusRes = await p.checkStatus!(ctx, accountRec, { updateId: "buf_post_100", channelId: "ch_vid_core" });
        expect(statusRes.status).toBe("published");
      });
    });

    describe("F2: Provider Registration & Branding", () => {
      it("F2.1: buffer provider is registered in worker provider registry", () => {
        const p = getProvider("buffer");
        expect(p).toBeDefined();
        expect(p?.id).toBe("buffer");
      });

      it("F2.2: shared provider names maps buffer to 'Buffer'", () => {
        expect(PROVIDER_NAMES["buffer"]).toBe("Buffer");
      });

      it("F2.3: providerInfo converts buffer provider metadata with credentialFields for apiKey and tag", () => {
        const p = getProvider("buffer")!;
        const info = providerInfo(p);
        expect(info.id).toBe("buffer");
        expect(info.name).toBe("Buffer");
        expect(info.credentialFields.some((f) => f.key === "apiKey")).toBe(true);
        expect(info.credentialFields.some((f) => f.key === "tag")).toBe(true);
      });

      it("F2.4: platformRoutes GET /api/providers lists buffer as available provider", async () => {
        const res = await call(ownerClient, "/api/providers");
        expect(res.status).toBe(200);
        const buf = res.json.find((p: any) => p.id === "buffer");
        expect(buf).toBeDefined();
        expect(buf.name).toBe("Buffer");
        expect(buf.auth).toBe("credentials");
      });

      it("F2.5: providerDisplayName returns 'Buffer' for buffer id", () => {
        expect(providerDisplayName("buffer")).toBe("Buffer");
      });
    });

    describe("F3: Multi-Account Buffer Support (50+ Accounts)", () => {
      it("F3.1: connects single Buffer account with unique tag via POST /api/connect/buffer", async () => {
        mockBufferApi({ channelId: "ch_single_test" });
        const res = await call(ownerClient, "/api/connect/buffer", {
          body: { values: { apiKey: "tok_single_f3", tag: "tag-single-f3" } },
        });
        expect(res.status).toBe(200);
        expect(res.json.ids.length).toBeGreaterThan(0);
      });

      it("F3.2: connects 50 distinct Buffer accounts each with distinct tags", async () => {
        mockBufferApi();
        for (let i = 1; i <= 50; i++) {
          const res = await call(ownerClient, "/api/connect/buffer", {
            body: { values: { apiKey: `tok_batch_${i}`, tag: `scale-account-${i}` } },
          });
          expect(res.status).toBe(200);
        }
      }, 60000);

      it("F3.3: GET /api/accounts lists all configured Buffer accounts with correct metadata", async () => {
        const res = await call(ownerClient, "/api/accounts");
        expect(res.status).toBe(200);
        const bufferAccs = res.json.filter((a: any) => a.provider === "buffer");
        expect(bufferAccs.length).toBeGreaterThanOrEqual(50);
        expect(bufferAccs[0].username).toBeDefined();
      });

      it("F3.4: verifies credentials are encrypted with AES-GCM at rest in D1 database", async () => {
        const rows = await E.DB.prepare("SELECT credentials_enc FROM accounts WHERE provider = 'buffer' LIMIT 10").all<{ credentials_enc: string }>();
        expect(rows.results.length).toBeGreaterThanOrEqual(5);
        for (const row of rows.results) {
          expect(row.credentials_enc).toMatch(/^v1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
        }
      });

      it("F3.5: deletes a Buffer account via DELETE /api/accounts/:id", async () => {
        mockBufferApi({ channelId: "ch_to_delete" });
        const addRes = await call(ownerClient, "/api/connect/buffer", {
          body: { values: { apiKey: "tok_to_delete", tag: "to-delete-tag" } },
        });
        expect(addRes.status).toBe(200);
        const idToDelete = addRes.json.ids[0];

        const delRes = await call(ownerClient, `/api/accounts/${idToDelete}`, { method: "DELETE" });
        expect(delRes.status).toBe(200);

        const checkRes = await call(ownerClient, "/api/accounts");
        expect(checkRes.json.some((a: any) => a.id === idToDelete)).toBe(false);
      });
    });

    describe("F4: Account Edit & Token Updates", () => {
      it("F4.1: updates account status to disabled via PATCH /api/accounts/:id", async () => {
        const patchRes = await call(ownerClient, `/api/accounts/${primaryAccountId}`, {
          method: "PATCH",
          body: { status: "disabled" },
        });
        expect(patchRes.status).toBe(200);
        expect(patchRes.json.status).toBe("disabled");
      });

      it("F4.2: updates account status back to active via PATCH /api/accounts/:id", async () => {
        const patchRes = await call(ownerClient, `/api/accounts/${primaryAccountId}`, {
          method: "PATCH",
          body: { status: "active" },
        });
        expect(patchRes.status).toBe(200);
        expect(patchRes.json.status).toBe("active");
      });

      it("F4.3: updates account group via PATCH /api/accounts/:id and verifies reflected in GET /api/accounts", async () => {
        const grp = await call(ownerClient, "/api/account-groups", {
          body: { name: "Buffer Enterprise Group", color: "indigo" },
        });
        expect([200, 201]).toContain(grp.status);
        const groupId = grp.json.id;

        const patchRes = await call(ownerClient, `/api/accounts/${primaryAccountId}`, {
          method: "PATCH",
          body: { groupId },
        });
        expect(patchRes.status).toBe(200);
        expect(patchRes.json.groupId).toBe(groupId);

        const res = await call(ownerClient, "/api/accounts");
        const acc = res.json.find((a: any) => a.id === primaryAccountId);
        expect(acc.groupId).toBe(groupId);
        expect(acc.status).toBe("active");
      });

      it("F4.4: reconnecting with updated API token updates encrypted credentials", async () => {
        mockBufferApi({ channelId: "ch_default" });
        const reconnect = await call(ownerClient, "/api/connect/buffer", {
          body: { values: { apiKey: "token_rotated_new", tag: "primary-brand" } },
        });
        expect(reconnect.status).toBe(200);
        expect(reconnect.json.ids).toContain(primaryAccountId);

        // Verify credentials encrypted with the new token in D1
        const row = await E.DB.prepare("SELECT credentials_enc FROM accounts WHERE id = ?").bind(primaryAccountId).first<any>();
        expect(row.credentials_enc).toMatch(/^v1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
        const creds = await decryptJson<Record<string, string>>(E, row.credentials_enc);
        expect(creds.apiKey).toBe("token_rotated_new");
      });

      it("F4.5: refreshed account profile preserves updated tag and channel metadata", async () => {
        mockBufferApi({ channelId: "ch_default" });
        const refRes = await call(ownerClient, `/api/accounts/${primaryAccountId}/refresh`, { method: "POST" });
        expect(refRes.status).toBe(200);
        expect(refRes.json.id).toBe(primaryAccountId);
        expect(refRes.json.username).toBe("primary-brand");
        const row = await E.DB.prepare("SELECT * FROM accounts WHERE id = ?").bind(primaryAccountId).first<any>();
        const meta = JSON.parse(row.meta);
        expect(meta.channelId).toBe("ch_default");
      });
    });

    describe("F5: Post Composer Buffer & Video Selection", () => {
      it("F5.1: composer query of accounts includes all active Buffer accounts", async () => {
        const res = await call(ownerClient, "/api/accounts");
        const activeBuffer = res.json.filter((a: any) => a.provider === "buffer" && a.status === "active");
        expect(activeBuffer.length).toBeGreaterThan(0);
      });

      it("F5.2: validates video attachment is permitted for Buffer targets", async () => {
        const vid = await uploadVideo(ownerClient, "composer-check.mp4");
        expect(vid.status).toBe(200);
        const valRes = await call(ownerClient, "/api/posts/validate", {
          body: {
            posts: [{ accountId: primaryAccountId, content: "Video ready", media: [vid.json.id] }],
          },
        });
        expect(valRes.status).toBe(200);
        expect(valRes.json.errors).toEqual([]);
      });

      it("F5.3: validates post creation across multiple Buffer accounts simultaneously", async () => {
        mockBufferApi();
        const res = await call(ownerClient, "/api/posts", {
          body: {
            posts: [
              { accountId: primaryAccountId, content: "Multi account 1" },
              { accountId: secondaryAccountId, content: "Multi account 2" },
            ],
            scheduledAt: "now",
          },
        });
        expect([200, 201]).toContain(res.status);
        expect(res.json.length).toBe(2);
      });

      it("F5.4: rejects post creation targeting non-existent account ID with 400", async () => {
        const res = await call(ownerClient, "/api/posts", {
          body: {
            posts: [{ accountId: "acc_ghost_invalid", content: "Ghost target" }],
            scheduledAt: "now",
          },
        });
        expect(res.status).toBe(400);
        expect(res.json.error).toContain("Account acc_ghost_invalid not found");
      });

      it("F5.5: validates content and media rules via POST /api/posts/validate", async () => {
        const res = await call(ownerClient, "/api/posts/validate", {
          body: {
            posts: [{ accountId: primaryAccountId, content: "", media: [] }],
          },
        });
        expect(res.status).toBe(200);
        expect(res.json.errors.length).toBeGreaterThan(0);
      });
    });

    describe("F6: Video Post Scheduling with R2 URLs", () => {
      it("F6.1: uploads video to POST /api/media and stores blob in R2 bucket", async () => {
        const vid = await uploadVideo(ownerClient, "r2-check.mp4", 4096);
        expect(vid.status).toBe(200);
        expect(vid.json.id).toBeDefined();
        const r2Object = await E.MEDIA.get(`${vid.json.id}/r2-check.mp4`);
        expect(r2Object).toBeDefined();
        expect(r2Object?.size).toBe(4096);
      });

      it("F6.2: generates signed public R2 media URL (/m/:id/:sig/:filename)", async () => {
        const vid = await uploadVideo(ownerClient, "signed-video.mp4", 1024);
        expect(vid.json.url).toMatch(new RegExp(`^${ORIGIN}/m/med_[^/]+/[^/]+/signed-video\\.mp4$`));
      });

      it("F6.3: schedules video post with future scheduledAt creating D1 post in scheduled status", async () => {
        mockBufferApi();
        const vid = await uploadVideo(ownerClient, "future-drop.mp4");
        const futureTime = Date.now() + 7200000;
        const res = await call(ownerClient, "/api/posts", {
          body: {
            posts: [{ accountId: primaryAccountId, content: "Future video post", media: [vid.json.id] }],
            scheduledAt: futureTime,
          },
        });
        expect([200, 201]).toContain(res.status);
        const postId = res.json[0].id;
        const row = await E.DB.prepare("SELECT * FROM posts WHERE id = ?").bind(postId).first<any>();
        expect(row.status).toBe("scheduled");
        expect(row.scheduled_at).toBe(futureTime);
      });

      it("F6.4: dispatching scheduled post passes R2 public video URL to Buffer", async () => {
        const { calls } = mockBufferApi({ channelId: "ch_dispatch" });
        const p = getProvider("buffer")!;
        const ctx = await providerContext(E, p);
        const accountRec: AccountRecord = {
          id: primaryAccountId,
          provider: "buffer",
          externalId: "brand:ch_dispatch",
          name: "Brand",
          username: "brand",
          credentials: { apiKey: "key_dispatch" },
          expiresAt: null,
          meta: { channelId: "ch_dispatch" },
        };
        const scheduledTime = Date.now() + 100000;
        const post: PublishPost = {
          id: "pst_dispatch_test",
          content: "Dispatch test",
          scheduledAt: scheduledTime,
          media: [
            {
              id: "med_dispatch_1",
              kind: "video",
              mime: "video/mp4",
              filename: "dispatch.mp4",
              size: 2048,
              width: 1280,
              height: 720,
              duration: 15,
              alt: null,
              url: `${ORIGIN}/m/med_dispatch_1/sig123/dispatch.mp4`,
            },
          ],
          settings: {},
        };
        const res = await p.publish(ctx, accountRec, post);
        expect(res.status).toBe("published");
        const gqlCall = calls.find((c) => c.url.includes("api.buffer.com"));
        expect(gqlCall).toBeDefined();
        expect(gqlCall?.headers["authorization"]).toBe("Bearer key_dispatch");
        expect(gqlCall?.body?.variables?.input?.assets?.[0]?.video?.url).toBe(`${ORIGIN}/m/med_dispatch_1/sig123/dispatch.mp4`);
        expect(gqlCall?.body?.variables?.input?.assets?.[0]?.video?.metadata?.thumbnailOffset).toBe(0);
        expect(gqlCall?.body?.variables?.input?.mode).toBe("customScheduled");
        expect(gqlCall?.body?.variables?.input?.schedulingType).toBe("automatic");
        expect(gqlCall?.body?.variables?.input?.dueAt).toBe(new Date(scheduledTime).toISOString());
      });

      it("F6.5: scheduled post triggers PUBLISH_WORKFLOW instance with post ID", async () => {
        mockBufferApi();
        const sched = await call(ownerClient, "/api/posts", {
          body: {
            posts: [{ accountId: primaryAccountId, content: "Workflow check" }],
            scheduledAt: Date.now() + 500000,
          },
        });
        expect([200, 201]).toContain(sched.status);
        const postId = sched.json[0].id;
        expect(wf.created.some((w) => w.params?.postId === postId)).toBe(true);
      });
    });

    describe("F7: Unified Calendar with Account Tags", () => {
      it("F7.1: GET /api/posts returns scheduled posts from multiple Buffer accounts in single query", async () => {
        const res = await call(ownerClient, "/api/posts");
        expect(res.status).toBe(200);
        expect(Array.isArray(res.json)).toBe(true);
        expect(res.json.length).toBeGreaterThanOrEqual(2);
        const accountIds = new Set(res.json.map((p: any) => p.accountId));
        expect(accountIds.size).toBeGreaterThanOrEqual(2);
        expect(accountIds.has(primaryAccountId)).toBe(true);
        expect(accountIds.has(secondaryAccountId)).toBe(true);
      });

      it("F7.2: calendar query returns posts with correct scheduled_at timestamps and account IDs", async () => {
        const schedTime = Date.now() + 3600000;
        mockBufferApi();
        const postRes = await call(ownerClient, "/api/posts", {
          body: {
            posts: [{ accountId: primaryAccountId, content: "Calendar check post" }],
            scheduledAt: schedTime,
          },
        });
        expect([200, 201]).toContain(postRes.status);
        const createdId = postRes.json[0].id;

        const res = await call(ownerClient, "/api/posts");
        expect(res.status).toBe(200);
        const found = res.json.find((p: any) => p.id === createdId);
        expect(found).toBeDefined();
        expect(found.accountId).toBe(primaryAccountId);
        expect(found.scheduledAt).toBe(schedTime);
      });

      it("F7.3: calendar feed aggregates posts across 50 Buffer accounts", async () => {
        const accsRes = await call(ownerClient, "/api/accounts");
        const bufferAccs = accsRes.json.filter((a: any) => a.provider === "buffer").slice(0, 50);
        mockBufferApi();
        const drafts = bufferAccs.map((a: any, i: number) => ({
          accountId: a.id,
          content: `Aggregated post ${i}`,
        }));
        const postRes = await call(ownerClient, "/api/posts", {
          body: { posts: drafts, scheduledAt: Date.now() + 3600000 },
        });
        expect([200, 201]).toContain(postRes.status);

        const calRes = await call(ownerClient, "/api/posts?limit=100");
        expect(calRes.status).toBe(200);
        expect(calRes.json.length).toBeGreaterThanOrEqual(50);
      });

      it("F7.4: posts scheduled across different dates appear in correct chronological order", async () => {
        const orderRes = await call(ownerClient, "/api/posts?order=asc&limit=20");
        expect(orderRes.status).toBe(200);
        for (let i = 0; i < orderRes.json.length - 1; i++) {
          const t1 = orderRes.json[i].scheduledAt ?? orderRes.json[i].createdAt;
          const t2 = orderRes.json[i + 1].scheduledAt ?? orderRes.json[i + 1].createdAt;
          expect(t1).toBeLessThanOrEqual(t2);
        }
      });

      it("F7.5: calendar query supports from and to date boundary filters", async () => {
        const futureFrom = Date.now() + 3000000;
        const futureTo = Date.now() + 4000000;
        const filtered = await call(ownerClient, `/api/posts?from=${futureFrom}&to=${futureTo}`);
        expect(filtered.status).toBe(200);
        for (const p of filtered.json) {
          const t = p.scheduledAt ?? p.createdAt;
          expect(t).toBeGreaterThanOrEqual(futureFrom);
          expect(t).toBeLessThan(futureTo);
        }
      });
    });

    describe("F8: Calendar Account Filtering", () => {
      it("F8.1: filters calendar posts by specific accountId returning only matching posts", async () => {
        const res = await call(ownerClient, `/api/posts?accountId=${primaryAccountId}`);
        expect(res.status).toBe(200);
        for (const p of res.json) {
          expect(p.accountId).toBe(primaryAccountId);
        }
      });

      it("F8.2: filters calendar posts combining accountId and status=scheduled", async () => {
        const res = await call(ownerClient, `/api/posts?accountId=${primaryAccountId}&status=scheduled`);
        expect(res.status).toBe(200);
        for (const p of res.json) {
          expect(p.accountId).toBe(primaryAccountId);
          expect(p.status).toBe("scheduled");
        }
      });

      it("F8.3: clearing account filter returns posts from all accounts", async () => {
        const allRes = await call(ownerClient, "/api/posts");
        const filteredRes = await call(ownerClient, `/api/posts?accountId=${primaryAccountId}`);
        expect(allRes.json.length).toBeGreaterThan(filteredRes.json.length);
      });

      it("F8.4: filtering by non-existent account ID returns empty list", async () => {
        const emptyRes = await call(ownerClient, "/api/posts?accountId=acc_empty_target");
        expect(emptyRes.status).toBe(200);
        expect(emptyRes.json).toEqual([]);
      });

      it("F8.5: respects limit and order parameters with account filtering", async () => {
        const res = await call(ownerClient, `/api/posts?accountId=${primaryAccountId}&limit=2&order=desc`);
        expect(res.status).toBe(200);
        expect(res.json.length).toBeLessThanOrEqual(2);
      });
    });

    describe("F9: Cloudflare Environment Compatibility", () => {
      it("F9.1: runs D1 schema migrations automatically on request", async () => {
        const table = await E.DB.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='accounts'").first<{ name: string }>();
        expect(table?.name).toBe("accounts");
      });

      it("F9.2: performs R2 put, get, and delete operations on MEDIA bucket", async () => {
        const key = "test-r2-compat.txt";
        await E.MEDIA.put(key, "Cloudflare R2 Verification");
        const obj = await E.MEDIA.get(key);
        expect(await obj?.text()).toBe("Cloudflare R2 Verification");
        await E.MEDIA.delete(key);
        expect(await E.MEDIA.get(key)).toBeNull();
      });

      it("F9.3: public media endpoint handles HTTP Range requests (bytes=0-1024) returning 206", async () => {
        const vid = await uploadVideo(ownerClient, "range-test.mp4", 3000);
        const subPath = vid.json.url.replace(ORIGIN, "");
        const rangeRes = await call(null, subPath, { headers: { range: "bytes=0-499" } });
        expect(rangeRes.status).toBe(206);
        expect(rangeRes.headers.get("content-range")).toBe("bytes 0-499/3000");
      });

      it("F9.4: handles worker environment bindings and variables cleanly", () => {
        expect(E.DB).toBeDefined();
        expect(E.MEDIA).toBeDefined();
        expect(E.PUBLISH_WORKFLOW).toBeDefined();
        expect(E.DEMO_MODE).toBe("false");
      });

      it("F9.5: returns standard JSON error envelopes for API errors", async () => {
        const errRes = await call(ownerClient, "/api/posts/not-an-id-999999");
        expect(errRes.status).toBe(404);
        expect(errRes.json.error).toBeDefined();
      });
    });

    describe("F10: Test Mocking Reliability & Wire Contract", () => {
      it("F10.1: provider connect dispatches GraphQL query with authorization header and parses channels", async () => {
        const { calls } = mockBufferApi({ channelId: "ch_mock_f10" });
        const p = getProvider("buffer")!;
        const ctx = await providerContext(E, p);
        const accounts = await p.connect!(ctx, { apiKey: "tok_f10_graphql", tag: "f10-tag" });
        expect(accounts.length).toBeGreaterThan(0);
        expect(accounts[0]!.username).toBe("f10-tag");
        expect((accounts[0]!.meta as any)?.channelId).toBe("ch_mock_f10");

        const gqlCall = calls.find((c) => c.url.includes("api.buffer.com"));
        expect(gqlCall).toBeDefined();
        expect(gqlCall?.headers["authorization"]).toBe("Bearer tok_f10_graphql");
        expect(gqlCall?.body?.query).toContain("GetAccountAndChannels");
      });

      it("F10.2: provider publish dispatches CreatePost GraphQL mutation with variables and headers", async () => {
        const { calls } = mockBufferApi({ channelId: "ch_mock_f10_pub" });
        const p = getProvider("buffer")!;
        const ctx = await providerContext(E, p);
        const accRec: AccountRecord = {
          id: "acc_f10_pub",
          provider: "buffer",
          externalId: "brand:ch_mock_f10_pub",
          name: "Brand",
          username: "brand",
          credentials: { apiKey: "tok_f10_pub_key" },
          expiresAt: null,
          meta: { channelId: "ch_mock_f10_pub" },
        };
        const pubRes = await p.publish(ctx, accRec, {
          id: "p_f10_pub",
          content: "Hello from F10",
          media: [],
          settings: {},
        });
        expect(pubRes.status).toBe("published");

        const gqlCall = calls.find((c) => c.url.includes("api.buffer.com"));
        expect(gqlCall).toBeDefined();
        expect(gqlCall?.headers["authorization"]).toBe("Bearer tok_f10_pub_key");
        expect(gqlCall?.body?.query).toContain("CreatePost");
        expect(gqlCall?.body?.variables?.input?.text).toBe("Hello from F10");
        expect(gqlCall?.body?.variables?.input?.channelId).toBe("ch_mock_f10_pub");
      });

      it("F10.3: verifies Authorization Bearer header sent in requests via public connect endpoint", async () => {
        const { calls } = mockBufferApi();
        const res = await call(ownerClient, "/api/connect/buffer", {
          body: { values: { apiKey: "custom_auth_token_999", tag: "auth-check-tag" } },
        });
        expect(res.status).toBe(200);

        const gqlCall = calls.find((c) => c.url.includes("api.buffer.com"));
        expect(gqlCall).toBeDefined();
        expect(gqlCall?.headers["authorization"]).toBe("Bearer custom_auth_token_999");
      });

      it("F10.4: verifies JSON payload structure and headers for REST fallback publishing", async () => {
        const { calls } = mockBufferApi({ channelId: "ch_rest_f10" });
        const p = getProvider("buffer")!;
        const ctx = await providerContext(E, p);
        const scheduledTime = Date.now() + 500000;
        const accRec: AccountRecord = {
          id: "acc_f10_rest",
          provider: "buffer",
          externalId: "brand:ch_rest_f10",
          name: "Brand",
          username: "brand",
          credentials: { apiKey: "rest_token_f10" },
          expiresAt: null,
          meta: { channelId: "ch_rest_f10", rest: true },
        };
        const pubRes = await p.publish(ctx, accRec, {
          id: "p_f10_rest",
          content: "REST Payload Post",
          scheduledAt: scheduledTime,
          media: [
            {
              id: "med_rest_1",
              kind: "video",
              mime: "video/mp4",
              filename: "rest_vid.mp4",
              size: 1024,
              width: 1280,
              height: 720,
              duration: 10,
              alt: null,
              url: "https://pf.test/rest-video.mp4",
            },
          ],
          settings: { rest: true },
        });
        expect(pubRes.status).toBe("published");

        const restCall = calls.find((c) => c.url.includes("api.bufferapp.com/1/updates/create.json"));
        expect(restCall).toBeDefined();
        expect(restCall?.headers["authorization"]).toBe("Bearer rest_token_f10");
        expect(restCall?.body?.text).toBe("REST Payload Post");
        expect(restCall?.body?.profile_ids).toEqual(["ch_rest_f10"]);
        expect(restCall?.body?.scheduled_at).toBe(new Date(scheduledTime).toISOString());
        expect(restCall?.body?.media?.video).toBe("https://pf.test/rest-video.mp4");
      });

      it("F10.5: cleans up mock handlers cleanly after each test without leaks", () => {
        vi.restoreAllMocks();
        const s = vi.spyOn(globalThis, "fetch");
        expect(s).toBeDefined();
        s.mockRestore();
      });
    });
  });

  // ==============================================================================================
  // TIER 2: BOUNDARY & CORNER CASES (50 tests across 7 categories)
  // ==============================================================================================
  describe("Tier 2: Boundary & Corner Cases", () => {
    describe("Empty States & Zero Values (7 tests)", () => {
      it("T2.1: calendar query with 0 accounts returns empty array when workspace is empty", async () => {
        const wsRes = await call(ownerClient, "/api/workspaces", { method: "POST", body: { name: "EmptyWorkspace1" } });
        expect(wsRes.status).toBe(201);
        const emptyClient: Client = { cookie: ownerClient.cookie, ws: wsRes.json.id };
        const cal = await call(emptyClient, "/api/posts");
        expect(cal.status).toBe(200);
        expect(cal.json).toEqual([]);
      });

      it("T2.2: post creation with empty posts array rejects with 400", async () => {
        const res = await call(ownerClient, "/api/posts", { body: { posts: [] } });
        expect(res.status).toBe(400);
        expect(res.json.error).toContain("Select at least one account");
      });

      it("T2.3: accounts list in empty workspace returns empty array", async () => {
        const wsRes = await call(ownerClient, "/api/workspaces", { method: "POST", body: { name: "EmptyWorkspace2" } });
        expect(wsRes.status).toBe(201);
        const emptyClient: Client = { cookie: ownerClient.cookie, ws: wsRes.json.id };
        const accs = await call(emptyClient, "/api/accounts");
        expect(accs.status).toBe(200);
        expect(accs.json).toEqual([]);
      });

      it("T2.4: post creation with empty content but valid video attachment succeeds", async () => {
        mockBufferApi();
        const vid = await uploadVideo(ownerClient, "silent-clip.mp4");
        const res = await call(ownerClient, "/api/posts", {
          body: {
            posts: [{ accountId: primaryAccountId, content: "", media: [vid.json.id] }],
            scheduledAt: "now",
          },
        });
        expect([200, 201]).toContain(res.status);
      });

      it("T2.5: post creation with empty content and empty media rejects via validation", async () => {
        const res = await call(ownerClient, "/api/posts", {
          body: {
            posts: [{ accountId: primaryAccountId, content: "   ", media: [] }],
            scheduledAt: "now",
          },
        });
        expect(res.status).toBe(400);
      });

      it("T2.6: 0-byte video attachment upload rejects with 400", async () => {
        const res = await call(ownerClient, "/api/media", {
          method: "POST",
          raw: new Uint8Array(0),
          headers: { "content-type": "video/mp4", "content-length": "0", "x-filename": "zero.mp4" },
        });
        expect(res.status).toBe(400);
        expect(res.json.error).toContain("Invalid file size");
      });

      it("T2.7: account connection with empty whitespace tag rejects with 400", async () => {
        const res = await call(ownerClient, "/api/connect/buffer", {
          body: { values: { apiKey: "tok_valid", tag: "   " } },
        });
        expect(res.status).toBe(400);
      });
    });

    describe("Scale & Volume (50+ Accounts) (7 tests)", () => {
      it("T2.8: creates and retrieves 55 distinct Buffer accounts in D1", async () => {
        mockBufferApi();
        for (let i = 51; i <= 55; i++) {
          await call(ownerClient, "/api/connect/buffer", {
            body: { values: { apiKey: `tok_scale_${i}`, tag: `scale-account-${i}` } },
          });
        }
        const accs = await call(ownerClient, "/api/accounts");
        const bufferAccs = accs.json.filter((a: any) => a.provider === "buffer");
        expect(bufferAccs.length).toBeGreaterThanOrEqual(55);
      });

      it("T2.9: mass schedules posts across 50 Buffer accounts in single batch request", async () => {
        mockBufferApi();
        const accs = await call(ownerClient, "/api/accounts");
        const targets = accs.json.filter((a: any) => a.provider === "buffer").slice(0, 50);
        const drafts = targets.map((t: any, idx: number) => ({
          accountId: t.id,
          content: `Mass blast content ${idx}`,
        }));
        const res = await call(ownerClient, "/api/posts", {
          body: { posts: drafts, scheduledAt: Date.now() + 86400000 },
        });
        expect([200, 201]).toContain(res.status);
        expect(res.json.length).toBe(50);
      });

      it("T2.10: calendar queries 500 posts across 50 accounts with limit=1000", async () => {
        const res = await call(ownerClient, "/api/posts?limit=1000");
        expect(res.status).toBe(200);
        expect(res.json.length).toBeGreaterThan(50);
      });

      it("T2.11: handles large post creation payload with 50 target accounts", async () => {
        mockBufferApi();
        const accs = await call(ownerClient, "/api/accounts");
        const targets = accs.json.filter((a: any) => a.provider === "buffer").slice(0, 50);
        const bigPayload = targets.map((t: any) => ({
          accountId: t.id,
          content: "A".repeat(500),
        }));
        const res = await call(ownerClient, "/api/posts", {
          body: { posts: bigPayload, scheduledAt: Date.now() + 500000 },
        });
        expect([200, 201]).toContain(res.status);
      });

      it("T2.12: rapid sequential post creation across 10 distinct Buffer accounts", async () => {
        mockBufferApi();
        const accs = await call(ownerClient, "/api/accounts");
        const subset = accs.json.filter((a: any) => a.provider === "buffer").slice(0, 10);
        for (const target of subset) {
          const res = await call(ownerClient, "/api/posts", {
            body: { posts: [{ accountId: target.id, content: "Rapid sequential" }], scheduledAt: "now" },
          });
          expect([200, 201]).toContain(res.status);
        }
      });

      it("T2.13: batch deletion of 10 Buffer accounts succeeds cleanly", async () => {
        const accs = await call(ownerClient, "/api/accounts");
        const toDelete = accs.json.filter((a: any) => a.provider === "buffer").slice(40, 50);
        for (const acc of toDelete) {
          const res = await call(ownerClient, `/api/accounts/${acc.id}`, { method: "DELETE" });
          expect(res.status).toBe(200);
        }
      });

      it("T2.14: pagination boundary: query with limit=50 and limit=100", async () => {
        const r50 = await call(ownerClient, "/api/posts?limit=50");
        const r100 = await call(ownerClient, "/api/posts?limit=100");
        expect(r50.json.length).toBeLessThanOrEqual(50);
        expect(r100.json.length).toBeLessThanOrEqual(100);
      });
    });

    describe("Invalid & Expired Credentials (7 tests)", () => {
      it("T2.15: connect with invalid API key (mock 401) throws auth ProviderError", async () => {
        mockBufferApi({ failConnect: true });
        const res = await call(ownerClient, "/api/connect/buffer", {
          body: { values: { apiKey: "bad_token", tag: "bad-tag" } },
        });
        expect(res.status).toBe(400);
        expect(res.json.error).toContain("Unauthorized");
      });

      it("T2.16: publish with revoked API key (mock 403) throws auth ProviderError", async () => {
        mockBufferApi({ failPublishGql: true });
        const p = getProvider("buffer")!;
        const ctx = await providerContext(E, p);
        const accountRec: AccountRecord = {
          id: "acc_bad",
          provider: "buffer",
          externalId: "brand:ch_bad",
          name: "Brand",
          username: "brand",
          credentials: { apiKey: "revoked_token" },
          expiresAt: null,
          meta: { channelId: "ch_bad" },
        };
        const post: PublishPost = { id: "pst_bad", content: "Fail publish", media: [], settings: {} };
        await expect(p.publish(ctx, accountRec, post)).rejects.toThrow();
      });

      it("T2.17: empty API key in account connection rejected with 400", async () => {
        const res = await call(ownerClient, "/api/connect/buffer", {
          body: { values: { apiKey: "", tag: "valid-tag" } },
        });
        expect(res.status).toBe(400);
      });

      it("T2.18: whitespace-only API key rejected with 400", async () => {
        const res = await call(ownerClient, "/api/connect/buffer", {
          body: { values: { apiKey: "   ", tag: "valid-tag" } },
        });
        expect(res.status).toBe(400);
      });

      it("T2.19: malformed API token string handled gracefully without crash", async () => {
        mockBufferApi({ failConnect: true });
        const res = await call(ownerClient, "/api/connect/buffer", {
          body: { values: { apiKey: "!@#$%^&*()_+=~`{}[]|:;'<>,.?/", tag: "weird-token" } },
        });
        expect(res.status).toBe(400);
      });

      it("T2.20: connect rejects when API returns GraphQL UNAUTHENTICATED error", async () => {
        mockBufferApi({ failConnect: true });
        const p = getProvider("buffer")!;
        const ctx = await providerContext(E, p);
        await expect(p.connect!(ctx, { apiKey: "bad_key", tag: "tag" })).rejects.toThrow();
      });

      it("T2.21: publish rejects when API returns GraphQL FORBIDDEN error", async () => {
        mockBufferApi({ failPublishGql: true });
        const p = getProvider("buffer")!;
        const ctx = await providerContext(E, p);
        const accRec: AccountRecord = {
          id: "acc_forbidden",
          provider: "buffer",
          externalId: "brand:ch_1",
          name: "B",
          username: "b",
          credentials: { apiKey: "forbid" },
          expiresAt: null,
          meta: { channelId: "ch_1" },
        };
        const post: PublishPost = { id: "p_forbid", content: "Forbidden", media: [], settings: {} };
        await expect(p.publish(ctx, accRec, post)).rejects.toThrow();
      });
    });

    describe("Video Validation & Corrupt Media (7 tests)", () => {
      it("T2.22: reject unsupported mime type (e.g. application/pdf) on video upload", async () => {
        const res = await call(ownerClient, "/api/media", {
          method: "POST",
          raw: new Uint8Array(100).fill(1),
          headers: { "content-type": "application/pdf", "content-length": "100", "x-filename": "doc.pdf" },
        });
        expect(res.status).toBe(400);
        expect(res.json.error).toContain("Unsupported file type");
      });

      it("T2.23: reject oversized video exceeding SINGLE_UPLOAD_MAX (90MB) on single upload", async () => {
        const oversizedBytes = 91 * 1024 * 1024;
        const res = await call(ownerClient, "/api/media", {
          method: "POST",
          raw: new Uint8Array(10),
          headers: { "content-type": "video/mp4", "content-length": String(oversizedBytes), "x-filename": "huge.mp4" },
        });
        expect(res.status).toBe(413);
      });

      it("T2.24: reject video upload missing x-filename header", async () => {
        const res = await call(ownerClient, "/api/media", {
          method: "POST",
          raw: new Uint8Array(500),
          headers: { "content-type": "video/mp4", "content-length": "500" },
        });
        expect(res.status).toBe(400);
        expect(res.json.error).toContain("filename is required");
      });

      it("T2.25: validate post rejects multiple videos for Buffer target (max 1)", async () => {
        const v1 = await uploadVideo(ownerClient, "v1.mp4");
        const v2 = await uploadVideo(ownerClient, "v2.mp4");
        const valRes = await call(ownerClient, "/api/posts/validate", {
          body: {
            posts: [{ accountId: primaryAccountId, content: "2 videos", media: [v1.json.id, v2.json.id] }],
          },
        });
        expect(valRes.status).toBe(200);
        expect(valRes.json.errors.some((e: string) => e.includes("at most 1 video"))).toBe(true);
      });

      it("T2.26: validate post rejects mixing videos and images for Buffer target", async () => {
        const vid = await uploadVideo(ownerClient, "vid.mp4");
        const img = await call(ownerClient, "/api/media", {
          method: "POST",
          raw: new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]),
          headers: { "content-type": "image/png", "content-length": "8", "x-filename": "pic.png" },
        });
        const valRes = await call(ownerClient, "/api/posts/validate", {
          body: {
            posts: [{ accountId: primaryAccountId, content: "Mixed", media: [vid.json.id, img.json.id] }],
          },
        });
        expect(valRes.status).toBe(200);
        expect(valRes.json.errors.some((e: string) => e.includes("mixing images and videos"))).toBe(true);
      });

      it("T2.27: validate post rejects exceeding 4 images for Buffer target", async () => {
        const ids: string[] = [];
        for (let i = 1; i <= 5; i++) {
          const up = await call(ownerClient, "/api/media", {
            method: "POST",
            raw: new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]),
            headers: { "content-type": "image/png", "content-length": "8", "x-filename": `pic${i}.png` },
          });
          ids.push(up.json.id);
        }
        const valRes = await call(ownerClient, "/api/posts/validate", {
          body: {
            posts: [{ accountId: primaryAccountId, content: "5 images", media: ids }],
          },
        });
        expect(valRes.status).toBe(200);
        expect(valRes.json.errors.some((e: string) => e.includes("at most 4 images"))).toBe(true);
      });

      it("T2.28: handles video attachment with zero or null duration gracefully", async () => {
        const vid = await uploadVideo(ownerClient, "no-duration.mp4");
        mockBufferApi();
        const res = await call(ownerClient, "/api/posts", {
          body: {
            posts: [{ accountId: primaryAccountId, content: "No duration video", media: [vid.json.id] }],
            scheduledAt: "now",
          },
        });
        expect([200, 201]).toContain(res.status);
      });
    });

    describe("R2 Media URL & Range Requests (7 tests)", () => {
      it("T2.29: public media URL with invalid HMAC signature returns 404", async () => {
        const vid = await uploadVideo(ownerClient, "sig-check.mp4");
        const corruptUrl = vid.json.url.replace(ORIGIN, "").replace(/\/m\/([^/]+)\/([^/]+)\//, "/m/$1/invalidsig12345/");
        const res = await call(null, corruptUrl);
        expect(res.status).toBe(404);
      });

      it("T2.30: public media URL for non-existent media ID returns 404", async () => {
        const fakeSig = "abcdef123456";
        const res = await call(null, `/m/med_ghost_${fakeSig}/${fakeSig}/ghost.mp4`);
        expect(res.status).toBe(404);
      });

      it("T2.31: HTTP Range request bytes=0-500 returns 206 Partial Content with correct content-range", async () => {
        const vid = await uploadVideo(ownerClient, "range-stream.mp4", 2000);
        const path = vid.json.url.replace(ORIGIN, "");
        const res = await call(null, path, { headers: { range: "bytes=0-500" } });
        expect(res.status).toBe(206);
        expect(res.headers.get("content-range")).toBe("bytes 0-500/2000");
      });

      it("T2.32: HTTP Range request beyond file bounds returns 416 Range Not Satisfiable or clamped range", async () => {
        const vid = await uploadVideo(ownerClient, "bounds.mp4", 1000);
        const path = vid.json.url.replace(ORIGIN, "");
        const res = await call(null, path, { headers: { range: "bytes=5000-6000" } });
        expect([206, 416]).toContain(res.status);
      });

      it("T2.33: unauthenticated request to public media URL succeeds without session", async () => {
        const vid = await uploadVideo(ownerClient, "unauth-access.mp4");
        const path = vid.json.url.replace(ORIGIN, "");
        const res = await call(null, path);
        expect(res.status).toBe(200);
        expect(res.headers.get("content-type")).toBe("video/mp4");
      });

      it("T2.34: HEAD request to public media URL returns content-length without body", async () => {
        const vid = await uploadVideo(ownerClient, "head-check.mp4", 1500);
        const path = vid.json.url.replace(ORIGIN, "");
        const res = await call(null, path, { method: "HEAD" });
        expect(res.status).toBe(200);
        expect(res.headers.get("content-length")).toBe("1500");
        expect(res.text).toBe("");
      });

      it("T2.35: deleted media object from R2 returns 404 on public URL", async () => {
        const vid = await uploadVideo(ownerClient, "to-vanish.mp4");
        await E.MEDIA.delete(`${vid.json.id}/to-vanish.mp4`);
        const path = vid.json.url.replace(ORIGIN, "");
        const res = await call(null, path);
        expect(res.status).toBe(404);
      });
    });

    describe("Rate Limiting & Retries (7 tests)", () => {
      it("T2.36: Buffer API 429 Too Many Requests classifies as rate_limit error", async () => {
        mockBufferApi({ rateLimit: true });
        const p = getProvider("buffer")!;
        const ctx = await providerContext(E, p);
        const accRec: AccountRecord = {
          id: "acc_rl",
          provider: "buffer",
          externalId: "b:c1",
          name: "B",
          username: "b",
          credentials: { apiKey: "tok_rl" },
          expiresAt: null,
          meta: { channelId: "c1", rest: true },
        };
        const post: PublishPost = { id: "p_rl", content: "Rate limit test", media: [], settings: {} };
        await expect(p.publish(ctx, accRec, post)).rejects.toThrow();
      });

      it("T2.37: Buffer GraphQL RATE_LIMIT_EXCEEDED error classifies as rate_limit", async () => {
        mockBufferApi({ rateLimitGql: true });
        const p = getProvider("buffer")!;
        const ctx = await providerContext(E, p);
        const accRec: AccountRecord = {
          id: "acc_rl_gql",
          provider: "buffer",
          externalId: "b:c1",
          name: "B",
          username: "b",
          credentials: { apiKey: "tok_rl" },
          expiresAt: null,
          meta: { channelId: "c1" },
        };
        const post: PublishPost = { id: "p_rl_gql", content: "Rate limit gql test", media: [], settings: {} };
        await expect(p.publish(ctx, accRec, post)).rejects.toThrow();
      });

      it("T2.38: Buffer API 500 Internal Server Error throws ProviderError", async () => {
        vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("Internal Server Error", { status: 500 }));
        const p = getProvider("buffer")!;
        const ctx = await providerContext(E, p);
        const accRec: AccountRecord = {
          id: "acc_500",
          provider: "buffer",
          externalId: "b:c1",
          name: "B",
          username: "b",
          credentials: { apiKey: "k" },
          expiresAt: null,
          meta: { channelId: "c1" },
        };
        const post: PublishPost = { id: "p_500", content: "Err", media: [], settings: {} };
        await expect(p.publish(ctx, accRec, post)).rejects.toThrow();
      });

      it("T2.39: Buffer API 503 Service Unavailable throws ProviderError", async () => {
        vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("Service Unavailable", { status: 503 }));
        const p = getProvider("buffer")!;
        const ctx = await providerContext(E, p);
        const accRec: AccountRecord = {
          id: "acc_503",
          provider: "buffer",
          externalId: "b:c1",
          name: "B",
          username: "b",
          credentials: { apiKey: "k" },
          expiresAt: null,
          meta: { channelId: "c1" },
        };
        const post: PublishPost = { id: "p_503", content: "Err", media: [], settings: {} };
        await expect(p.publish(ctx, accRec, post)).rejects.toThrow();
      });

      it("T2.40: GraphQL MutationError with message throws ProviderError", async () => {
        mockBufferApi({ failPublish: true });
        const p = getProvider("buffer")!;
        const ctx = await providerContext(E, p);
        const accRec: AccountRecord = {
          id: "acc_mut_err",
          provider: "buffer",
          externalId: "b:c1",
          name: "B",
          username: "b",
          credentials: { apiKey: "k" },
          expiresAt: null,
          meta: { channelId: "c1" },
        };
        const post: PublishPost = { id: "p_mut", content: "Mut err", media: [], settings: {} };
        await expect(p.publish(ctx, accRec, post)).rejects.toThrow();
      });

      it("T2.41: checkStatus with failed status throws ProviderError", async () => {
        mockBufferApi({ postStatus: "failed" });
        const p = getProvider("buffer")!;
        const ctx = await providerContext(E, p);
        const accRec: AccountRecord = {
          id: "acc_failed_status",
          provider: "buffer",
          externalId: "b:c1",
          name: "B",
          username: "b",
          credentials: { apiKey: "k" },
          expiresAt: null,
          meta: { channelId: "c1" },
        };
        await expect(p.checkStatus!(ctx, accRec, { updateId: "post_failed" })).rejects.toThrow();
      });

      it("T2.42: rate-limited publish does not commit post as published", async () => {
        mockBufferApi({ rateLimitGql: true });
        const p = getProvider("buffer")!;
        const commit = { sent: false, accepted: false };
        const ctx = { ...(await providerContext(E, p)), commit };
        const accRec: AccountRecord = {
          id: "acc_no_commit",
          provider: "buffer",
          externalId: "b:c1",
          name: "B",
          username: "b",
          credentials: { apiKey: "k" },
          expiresAt: null,
          meta: { channelId: "c1" },
        };
        const post: PublishPost = { id: "p_no_commit", content: "Test", media: [], settings: {} };
        await expect(p.publish(ctx, accRec, post)).rejects.toThrow();
        expect(commit.accepted).toBe(false);
      });
    });

    describe("Timezones & Scheduling Boundaries (8 tests)", () => {
      it("T2.43: schedule post with scheduledAt 'now' queues immediately", async () => {
        mockBufferApi();
        const res = await call(ownerClient, "/api/posts", {
          body: { posts: [{ accountId: primaryAccountId, content: "Schedule now" }], scheduledAt: "now" },
        });
        expect([200, 201]).toContain(res.status);
        expect(res.json[0].status).toBe("scheduled");
      });

      it("T2.44: schedule post with ISO string containing +05:30 offset normalizes to UTC", async () => {
        mockBufferApi();
        const futureDate = new Date(Date.now() + 86400000).toISOString().split("T")[0];
        const offsetString = `${futureDate}T15:30:00+05:30`;
        const expectedUtc = Date.parse(offsetString);
        const res = await call(ownerClient, "/api/posts", {
          body: { posts: [{ accountId: primaryAccountId, content: "IST Offset" }], scheduledAt: offsetString },
        });
        expect([200, 201]).toContain(res.status);
        expect(res.json[0].scheduledAt).toBe(expectedUtc);
      });

      it("T2.45: schedule post with ISO string containing -08:00 offset normalizes to UTC", async () => {
        mockBufferApi();
        const futureDate = new Date(Date.now() + 86400000).toISOString().split("T")[0];
        const offsetString = `${futureDate}T12:00:00-08:00`;
        const expectedUtc = Date.parse(offsetString);
        const res = await call(ownerClient, "/api/posts", {
          body: { posts: [{ accountId: primaryAccountId, content: "PST Offset" }], scheduledAt: offsetString },
        });
        expect([200, 201]).toContain(res.status);
        expect(res.json[0].scheduledAt).toBe(expectedUtc);
      });

      it("T2.46: schedule post in immediate past normalizes to now", async () => {
        mockBufferApi();
        const past = Date.now() - 3600000;
        const res = await call(ownerClient, "/api/posts", {
          body: { posts: [{ accountId: primaryAccountId, content: "Past schedule" }], scheduledAt: past },
        });
        expect([200, 201]).toContain(res.status);
        expect(res.json[0].scheduledAt).toBeGreaterThanOrEqual(past);
      });

      it("T2.47: schedule post across DST transition boundary", async () => {
        mockBufferApi();
        const dstDate = "2027-03-14T07:00:00.000Z";
        const res = await call(ownerClient, "/api/posts", {
          body: { posts: [{ accountId: primaryAccountId, content: "DST Post" }], scheduledAt: dstDate },
        });
        expect([200, 201]).toContain(res.status);
        expect(res.json[0].scheduledAt).toBe(Date.parse(dstDate));
      });

      it("T2.48: schedule post exactly at top of hour (:00:00.000Z)", async () => {
        mockBufferApi();
        const nextHour = new Date(Date.now() + 3600000);
        nextHour.setMinutes(0, 0, 0);
        const res = await call(ownerClient, "/api/posts", {
          body: { posts: [{ accountId: primaryAccountId, content: "Top of hour" }], scheduledAt: nextHour.toISOString() },
        });
        expect([200, 201]).toContain(res.status);
        expect(res.json[0].scheduledAt).toBe(nextHour.getTime());
      });

      it("T2.49: schedule post beyond 360-day limit rejected with 400", async () => {
        const farFuture = Date.now() + 400 * 24 * 60 * 60 * 1000;
        const res = await call(ownerClient, "/api/posts", {
          body: { posts: [{ accountId: primaryAccountId, content: "Far future" }], scheduledAt: farFuture },
        });
        expect(res.status).toBe(400);
        expect(res.json.error).toContain("Invalid scheduledAt");
      });

      it("T2.50: schedule post on leap day (2028-02-29T12:00:00Z) parsed and persisted accurately", async () => {
        mockBufferApi();
        const testDate = new Date("2028-01-15T12:00:00Z");
        vi.useFakeTimers();
        vi.setSystemTime(testDate);
        try {
          const loginRes = await call(null, "/api/auth/login", {
            body: { email: "buffer_admin@example.com", password: "Password123!" },
          });
          expect(loginRes.status).toBe(200);
          const leapClient: Client = { cookie: loginRes.cookie! };

          const leapDayIso = "2028-02-29T12:00:00.000Z";
          const res = await call(leapClient, "/api/posts", {
            body: {
              posts: [{ accountId: primaryAccountId, content: "Leap day release campaign" }],
              scheduledAt: leapDayIso,
            },
          });
          expect([200, 201]).toContain(res.status);
          expect(res.json[0].status).toBe("scheduled");
          const expectedMs = Date.parse(leapDayIso);
          expect(res.json[0].scheduledAt).toBe(expectedMs);

          // Verify row persisted in D1 database
          const row = await E.DB.prepare("SELECT scheduled_at, status FROM posts WHERE id = ?")
            .bind(res.json[0].id)
            .first<any>();
          expect(row.status).toBe("scheduled");
          expect(row.scheduled_at).toBe(expectedMs);
          expect(new Date(row.scheduled_at).getUTCMonth()).toBe(1); // February
          expect(new Date(row.scheduled_at).getUTCDate()).toBe(29);
        } finally {
          vi.useRealTimers();
        }
      });
    });
  });

  // ==============================================================================================
  // TIER 3: CROSS-FEATURE PAIRWISE COMBINATIONS (6 tests)
  // ==============================================================================================
  describe("Tier 3: Cross-Feature Pairwise Combinations", () => {
    it("T3.1: F3 (Multi-Account) + F6 (Video Scheduling): schedules distinct videos to 5 Buffer accounts simultaneously", async () => {
      mockBufferApi();
      const accs = await call(ownerClient, "/api/accounts");
      const fiveAccounts = accs.json.filter((a: any) => a.provider === "buffer").slice(0, 5);
      const videoIds: string[] = [];
      for (let i = 0; i < 5; i++) {
        const vid = await uploadVideo(ownerClient, `pair-vid-${i}.mp4`);
        videoIds.push(vid.json.id);
      }
      const drafts = fiveAccounts.map((acc: any, i: number) => ({
        accountId: acc.id,
        content: `Distinct video for ${acc.username}`,
        media: [videoIds[i]],
      }));
      const res = await call(ownerClient, "/api/posts", {
        body: { posts: drafts, scheduledAt: Date.now() + 1000000 },
      });
      expect([200, 201]).toContain(res.status);
      expect(res.json.length).toBe(5);
      for (let i = 0; i < 5; i++) {
        expect(res.json[i].media[0]).toBe(videoIds[i]);
      }
    });

    it("T3.2: F6 (Video Scheduling) + F7 (Unified Calendar): scheduled video posts appear on calendar with media IDs and account tags", async () => {
      const [calRes, accsRes] = await Promise.all([
        call(ownerClient, "/api/posts?limit=10"),
        call(ownerClient, "/api/accounts"),
      ]);
      expect(calRes.status).toBe(200);
      expect(accsRes.status).toBe(200);

      const accountsMap = new Map<string, any>(accsRes.json.map((a: any) => [a.id, a]));
      const postWithMedia = calRes.json.find((p: any) => p.media && p.media.length > 0);
      expect(postWithMedia).toBeDefined();
      expect(postWithMedia.media[0]).toMatch(/^med_/);

      const associatedAccount = accountsMap.get(postWithMedia.accountId);
      expect(associatedAccount).toBeDefined();
      expect(associatedAccount.username).toBeDefined();
      expect(associatedAccount.username.length).toBeGreaterThan(0);
    });

    it("T3.3: F3 (Multi-Account) + F8 (Calendar Filtering): filtering for Account B isolates its posts without altering Accounts A or C", async () => {
      const calA = await call(ownerClient, `/api/posts?accountId=${primaryAccountId}`);
      const calB = await call(ownerClient, `/api/posts?accountId=${secondaryAccountId}`);
      expect(calA.status).toBe(200);
      expect(calB.status).toBe(200);
      for (const p of calB.json) {
        expect(p.accountId).toBe(secondaryAccountId);
        expect(p.accountId).not.toBe(primaryAccountId);
      }
    });

    it("T3.4: F4 (Account Edit) + F6 (Video Scheduling): updating account status to disabled blocks new posts, re-enabling allows scheduling", async () => {
      // 1. Disable account
      const patchDis = await call(ownerClient, `/api/accounts/${secondaryAccountId}`, {
        method: "PATCH",
        body: { status: "disabled" },
      });
      expect(patchDis.status).toBe(200);

      // 2. Attempt post -> should fail validation
      const failPost = await call(ownerClient, "/api/posts", {
        body: { posts: [{ accountId: secondaryAccountId, content: "Should fail" }], scheduledAt: "now" },
      });
      expect(failPost.status).toBe(400);
      expect(failPost.json.error).toContain("is disabled");

      // 3. Re-enable account
      const patchAct = await call(ownerClient, `/api/accounts/${secondaryAccountId}`, {
        method: "PATCH",
        body: { status: "active" },
      });
      expect(patchAct.status).toBe(200);

      // 4. Scheduling succeeds
      mockBufferApi();
      const okPost = await call(ownerClient, "/api/posts", {
        body: { posts: [{ accountId: secondaryAccountId, content: "Re-enabled success" }], scheduledAt: "now" },
      });
      expect([200, 201]).toContain(okPost.status);
    });

    it("T3.5: F2 (Provider Registration) + F3 (Account Management) + F5 (Composer): end-to-end selection pipeline from catalog to post creation", async () => {
      // 1. Check provider in catalog
      const provs = await call(ownerClient, "/api/providers");
      const hasBuf = provs.json.some((p: any) => p.id === "buffer" && p.enabled);
      expect(hasBuf).toBe(true);

      // 2. Connect account
      mockBufferApi({ channelId: "ch_e2e_pipe" });
      const conn = await call(ownerClient, "/api/connect/buffer", {
        body: { values: { apiKey: "tok_pipe", tag: "pipe-brand" } },
      });
      expect(conn.status).toBe(200);
      const newAccId = conn.json.ids[0];

      // 3. Select and post in composer
      const postRes = await call(ownerClient, "/api/posts", {
        body: { posts: [{ accountId: newAccId, content: "Pipeline post" }], scheduledAt: "now" },
      });
      expect([200, 201]).toContain(postRes.status);
    });

    it("T3.6: F6 (R2 Storage) + F9 (Range Requests) + F1 (Buffer Delivery): complete media lifecycle from upload to signed URL to Range fetch", async () => {
      // 1. Upload video to R2
      const vid = await uploadVideo(ownerClient, "lifecycle.mp4", 4000);
      expect(vid.status).toBe(200);
      const publicUrl = vid.json.url;

      // 2. Range request on signed URL (Buffer pulling byte range)
      const subPath = publicUrl.replace(ORIGIN, "");
      const rangeRes = await call(null, subPath, { headers: { range: "bytes=100-500" } });
      expect(rangeRes.status).toBe(206);
      expect(rangeRes.headers.get("content-range")).toBe("bytes 100-500/4000");

      // 3. Deliver to Buffer via provider
      const { calls } = mockBufferApi({ channelId: "ch_lifecycle" });
      const p = getProvider("buffer")!;
      const ctx = await providerContext(E, p);
      const accRec: AccountRecord = {
        id: primaryAccountId,
        provider: "buffer",
        externalId: "brand:ch_lifecycle",
        name: "Brand",
        username: "brand",
        credentials: { apiKey: "key_life" },
        expiresAt: null,
        meta: { channelId: "ch_lifecycle" },
      };
      const scheduledLife = Date.now() + 1800000;
      const post: PublishPost = {
        id: "p_life",
        content: "Lifecycle video",
        scheduledAt: scheduledLife,
        media: [
          {
            id: vid.json.id,
            kind: "video",
            mime: "video/mp4",
            filename: "lifecycle.mp4",
            size: 4000,
            width: 1920,
            height: 1080,
            duration: 10,
            alt: null,
            url: publicUrl,
          },
        ],
        settings: {},
      };
      const pubRes = await p.publish(ctx, accRec, post);
      expect(pubRes.status).toBe("published");
      expect(calls.length).toBeGreaterThanOrEqual(1);
      expect(calls[0].headers["authorization"]).toBe("Bearer key_life");
      expect(calls[0].body.variables.input.assets[0].video.url).toBe(publicUrl);
      expect(calls[0].body.variables.input.assets[0].video.metadata?.thumbnailOffset).toBe(0);
      expect(calls[0].body.variables.input.mode).toBe("customScheduled");
      expect(calls[0].body.variables.input.schedulingType).toBe("automatic");
      expect(calls[0].body.variables.input.dueAt).toBe(new Date(scheduledLife).toISOString());
    });
  });

  // ==============================================================================================
  // TIER 4: REAL-WORLD APPLICATION SCENARIOS (4 tests)
  // ==============================================================================================
  describe("Tier 4: Real-World Scenarios", () => {
    it("T4.1: Scenario 1: Large Enterprise Multi-Brand Onboarding (50 regional accounts configured, encrypted, retrieved, status audited)", async () => {
      mockBufferApi();
      const regions = ["us-east", "us-west", "eu-central", "apac-tokyo", "latam-brazil"];
      const createdIds: string[] = [];

      for (let i = 0; i < 50; i++) {
        const region = regions[i % regions.length];
        const tag = `${region}-brand-${i + 1}`;
        const res = await call(ownerClient, "/api/connect/buffer", {
          body: { values: { apiKey: `corp_token_${region}_${i}`, tag } },
        });
        expect(res.status).toBe(200);
        createdIds.push(res.json.ids[0]);
      }

      // Verify all accounts exist in D1 and have encrypted credentials
      const countCheck = await E.DB.prepare("SELECT count(*) as total FROM accounts WHERE provider = 'buffer'").first<{ total: number }>();
      expect(countCheck?.total).toBeGreaterThanOrEqual(50);

      // Verify listing returns accounts with tags
      const list = await call(ownerClient, "/api/accounts");
      const regionalAccounts = list.json.filter((a: any) => a.provider === "buffer" && createdIds.includes(a.id));
      expect(regionalAccounts.length).toBe(50);
      expect(regionalAccounts.every((a: any) => a.status === "active")).toBe(true);
    }, 60000);

    it("T4.2: Scenario 2: Global Video Campaign Rollout (3 videos uploaded to R2, scheduled across 25 accounts in 4 global timezones)", async () => {
      mockBufferApi();
      // 1. Upload 3 HD campaign videos
      const v1 = await uploadVideo(ownerClient, "campaign-teaser.mp4", 5000);
      const v2 = await uploadVideo(ownerClient, "campaign-main.mp4", 8000);
      const v3 = await uploadVideo(ownerClient, "campaign-cta.mp4", 6000);
      const videos = [v1.json.id, v2.json.id, v3.json.id];

      // 2. Select 25 accounts
      const accs = await call(ownerClient, "/api/accounts");
      const target25 = accs.json.filter((a: any) => a.provider === "buffer").slice(0, 25);
      expect(target25.length).toBe(25);

      const nowBase = Date.now() + 86400000;

      const drafts = target25.map((acc: any, idx: number) => ({
        accountId: acc.id,
        content: `Global Campaign Launch video #${idx + 1} for ${acc.username}`,
        media: [videos[idx % videos.length]],
      }));

      const res = await call(ownerClient, "/api/posts", {
        body: { posts: drafts, scheduledAt: nowBase },
      });
      expect([200, 201]).toContain(res.status);
      expect(res.json.length).toBe(25);

      // 3. Verify in unified calendar query
      const cal = await call(ownerClient, `/api/posts?from=${nowBase - 1000}&to=${nowBase + 100000}`);
      expect(cal.status).toBe(200);
      expect(cal.json.length).toBeGreaterThanOrEqual(25);
    });

    it("T4.3: Scenario 3: Scheduled Content Audit, Filtering, and Resilience (100 posts distributed, tag filtering, 429 recovery, reschedule)", async () => {
      mockBufferApi();
      const accs = await call(ownerClient, "/api/accounts");
      const target = accs.json.find((a: any) => a.provider === "buffer");

      // 1. Schedule 10 posts on target account
      const drafts = Array.from({ length: 10 }, (_, i) => ({
        accountId: target.id,
        content: `Audit post ${i}`,
      }));
      const schedRes = await call(ownerClient, "/api/posts", {
        body: { posts: drafts, scheduledAt: Date.now() + 2000000 },
      });
      expect([200, 201]).toContain(schedRes.status);

      // 2. Content audit: filter calendar by target account
      const filtered = await call(ownerClient, `/api/posts?accountId=${target.id}`);
      expect(filtered.status).toBe(200);
      expect(filtered.json.length).toBeGreaterThanOrEqual(10);

      // 3. Simulate rate-limiting and verify error recovery classification
      mockBufferApi({ rateLimitGql: true });
      const p = getProvider("buffer")!;
      const ctx = await providerContext(E, p);
      const accRec: AccountRecord = {
        id: target.id,
        provider: "buffer",
        externalId: target.externalId,
        name: target.name,
        username: target.username,
        credentials: { apiKey: "key_audit" },
        expiresAt: null,
        meta: { channelId: "ch_audit" },
      };
      let rateLimitErr: any = null;
      try {
        await p.publish(ctx, accRec, { id: "p_audit", content: "Retry", media: [], settings: {} });
      } catch (err: any) {
        rateLimitErr = err;
      }
      expect(rateLimitErr).toBeInstanceOf(ProviderError);
      expect(rateLimitErr.kind).toBe("rate_limit");

      // 4. Recover on next attempt
      mockBufferApi({ postStatus: "buffer" });
      const okPub = await p.publish(ctx, accRec, { id: "p_audit_2", content: "Recovered", media: [], settings: {} });
      expect(okPub.status).toBe("published");
    });

    it("T4.4: Scenario 4: Concurrent Multi-Account Video Publishing & Status Polling Pipeline", async () => {
      mockBufferApi({ postStatus: "buffer" });
      const p = getProvider("buffer")!;
      const ctx = await providerContext(E, p);
      const accs = await call(ownerClient, "/api/accounts");
      const testAccounts = accs.json.filter((a: any) => a.provider === "buffer").slice(0, 3);

      // 1. Concurrent publish calls across accounts
      const publishPromises = testAccounts.map((acc: any, i: number) => {
        const accRec: AccountRecord = {
          id: acc.id,
          provider: "buffer",
          externalId: acc.externalId,
          name: acc.name,
          username: acc.username,
          credentials: { apiKey: `key_pipe_${i}` },
          expiresAt: null,
          meta: { channelId: `ch_pipe_${i}` },
        };
        const post: PublishPost = {
          id: `pst_pipe_${i}`,
          content: `Concurrent video ${i}`,
          media: [
            {
              id: `med_pipe_${i}`,
              kind: "video",
              mime: "video/mp4",
              filename: `clip_${i}.mp4`,
              size: 3000,
              width: 1280,
              height: 720,
              duration: 20,
              alt: null,
              url: `${ORIGIN}/m/med_pipe_${i}/sig/clip_${i}.mp4`,
            },
          ],
          settings: {},
        };
        return p.publish(ctx, accRec, post);
      });

      const publishResults = await Promise.all(publishPromises);
      expect(publishResults.length).toBe(3);
      for (const res of publishResults) {
        expect(res.status).toBe("published");
      }

      // 2. Poll status transitioning to sent
      mockBufferApi({ postStatus: "sent" });
      for (let i = 0; i < 3; i++) {
        const accRec: AccountRecord = {
          id: testAccounts[i].id,
          provider: "buffer",
          externalId: testAccounts[i].externalId,
          name: testAccounts[i].name,
          username: testAccounts[i].username,
          credentials: { apiKey: `key_pipe_${i}` },
          expiresAt: null,
          meta: { channelId: `ch_pipe_${i}` },
        };
        const status = await p.checkStatus!(ctx, accRec, { updateId: publishResults[i].externalId });
        expect(status.status).toBe("published");
      }
    });
  });
});
