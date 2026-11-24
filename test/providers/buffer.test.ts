import { describe, expect, it } from "vitest";
import { buffer } from "../../worker/providers/buffer";
import { ProviderError } from "../../worker/providers/errors";
import { hotlinkingProviders } from "../../worker/lib/media-lifecycle";
import { bufferServiceDisplayName, bufferServiceIcon, PROVIDER_NAMES } from "../../shared/providerNames";
import { getProvider } from "../../worker/providers/registry";
import type { CommitState, PublishPost } from "../../worker/providers/types";
import { image, json, mockFetch, testAccount, testContext, video } from "../helpers";

function ctxWith(routes: Parameters<typeof mockFetch>[0]) {
  const m = mockFetch(routes);
  const ctx = testContext(m.fetch);
  const commit: CommitState = { sent: false, accepted: false };
  ctx.commit = commit;
  return { ctx, commit, requests: m.requests };
}

const account = (over = {}) =>
  testAccount({
    provider: "buffer",
    externalId: "brand-main:channel_123",
    name: "brand-main (@brand_insta)",
    username: "brand-main",
    credentials: { apiKey: "BUF_KEY", tag: "brand-main" },
    meta: {
      tag: "brand-main",
      channelId: "channel_123",
      service: "instagram",
      organizationId: "org_1",
    },
    ...over,
  });

const post = (settings: Record<string, any> = {}, media = [] as any[], scheduledAt?: number): PublishPost => ({
  id: "p_buffer_1",
  content: "Scheduled video post for Buffer! #postflare",
  media,
  settings,
  scheduledAt,
});

describe("buffer provider", () => {
  describe("metadata and capabilities", () => {
    it("declares correct metadata and credentials auth", () => {
      expect(buffer.id).toBe("buffer");
      expect(buffer.name).toBe("Buffer");
      expect(buffer.color).toBe("231F20");
      expect(buffer.icon).toBe("buffer");
      expect(buffer.category).toBe("social");
      expect(buffer.auth).toBe("credentials");
      expect(buffer.status).toBe("beta");
      expect(buffer.hotlinksMedia).toBe(true);
      expect(buffer.docsUrl).toBe("https://developers.buffer.com");
    });

    it("declares required credential fields: apiKey and tag", () => {
      expect(buffer.credentialFields).toHaveLength(2);
      const [apiKey, tag] = buffer.credentialFields;
      expect(apiKey).toMatchObject({
        key: "apiKey",
        type: "password",
        required: true,
      });
      expect(tag).toMatchObject({
        key: "tag",
        type: "text",
        required: true,
      });
    });

    it("declares settings fields", () => {
      expect(buffer.settingsFields.some((f) => f.key === "channelId")).toBe(true);
      expect(buffer.settingsFields.some((f) => f.key === "pinned")).toBe(true);
    });

    it("declares capabilities with video support and hotlinking", () => {
      expect(buffer.capabilities.maxLength).toBe(5000);
      expect(buffer.capabilities.text).toBe("optional");
      expect(buffer.capabilities.media?.videos).toBe(1);
      expect(buffer.capabilities.media?.images).toBe(4);
      expect(buffer.capabilities.media?.mixed).toBe(false);
      expect(buffer.capabilities.thread).toBe(false);
      expect(buffer.capabilities.mediaNote).toContain("hotlinked");
    });
  });

  describe("connect", () => {
    it("validates required credential fields", async () => {
      const { ctx } = ctxWith([]);
      await expect(buffer.connect!(ctx, { apiKey: "", tag: "t" })).rejects.toMatchObject({
        kind: "invalid",
      });
      await expect(buffer.connect!(ctx, { apiKey: "k", tag: "" })).rejects.toMatchObject({
        kind: "invalid",
      });
      await expect(buffer.connect!(ctx, { apiKey: "   ", tag: "t" })).rejects.toMatchObject({
        kind: "invalid",
      });
    });

    it("connects and returns channels via GraphQL with unique composite externalId", async () => {
      const { ctx, requests } = ctxWith([
        [
          "POST https://api.buffer.com",
          (req: any) => {
            const query = req.json?.query ?? "";
            if (query.includes("GetChannels") || query.includes("channels(")) {
              return {
                data: {
                  channels: [
                    {
                      id: "ch_insta_1",
                      name: "Instagram Main",
                      displayName: "@brand_insta",
                      service: "instagram",
                      avatar: "https://buf/avatar.jpg",
                    },
                  ],
                },
              };
            }
            return {
              data: {
                account: {
                  id: "acc_999",
                  email: "user@example.com",
                  organizations: [
                    {
                      id: "org_1",
                      name: "Org 1",
                    },
                  ],
                },
              },
            };
          },
        ],
      ]);

      const [conn] = await buffer.connect!(ctx, { apiKey: "BUF_KEY", tag: "brand-main" });
      expect(conn).toMatchObject({
        externalId: "brand-main:ch_insta_1",
        name: "brand-main (@brand_insta)",
        username: "brand-main",
        avatarUrl: "https://buf/avatar.jpg",
        credentials: { apiKey: "BUF_KEY", tag: "brand-main" },
        meta: { tag: "brand-main", channelId: "ch_insta_1", service: "instagram", organizationId: "org_1" },
      });
      expect(requests).toHaveLength(2);
      expect(requests[0].headers.authorization).toBe("Bearer BUF_KEY");
      expect(requests[0].json.query).toContain("GetAccountAndOrganizations");
      expect(requests[1].headers.authorization).toBe("Bearer BUF_KEY");
      expect(requests[1].json.query).toContain("GetChannels");
      expect(requests[1].json.variables).toEqual({ input: { organizationId: "org_1" } });
    });

    it("connects and aggregates channels across multiple organizations", async () => {
      const { ctx, requests } = ctxWith([
        [
          "POST https://api.buffer.com",
          (req: any) => {
            const query = req.json?.query ?? "";
            if (query.includes("GetChannels") || query.includes("channels(")) {
              const orgId = req.json?.variables?.input?.organizationId;
              if (orgId === "org_1") {
                return {
                  data: {
                    channels: [
                      {
                        id: "ch_1",
                        name: "Channel 1",
                        displayName: "@ch1",
                        service: "instagram",
                        avatar: "https://buf/1.jpg",
                      },
                    ],
                  },
                };
              }
              if (orgId === "org_2") {
                return {
                  data: {
                    channels: [
                      {
                        id: "ch_2",
                        name: "Channel 2",
                        displayName: "@ch2",
                        service: "linkedin",
                        avatar: "https://buf/2.jpg",
                      },
                    ],
                  },
                };
              }
              return { data: { channels: [] } };
            }
            return {
              data: {
                account: {
                  id: "acc_multi",
                  email: "multi@example.com",
                  organizations: [
                    { id: "org_1", name: "Org 1" },
                    { id: "org_2", name: "Org 2" },
                  ],
                },
              },
            };
          },
        ],
      ]);

      const conns = await buffer.connect!(ctx, { apiKey: "BUF_KEY", tag: "multi-org" });
      expect(conns).toHaveLength(2);
      expect(conns[0]).toMatchObject({
        externalId: "multi-org:ch_1",
        meta: { tag: "multi-org", channelId: "ch_1", service: "instagram", organizationId: "org_1" },
      });
      expect(conns[1]).toMatchObject({
        externalId: "multi-org:ch_2",
        meta: { tag: "multi-org", channelId: "ch_2", service: "linkedin", organizationId: "org_2" },
      });
      expect(requests).toHaveLength(3);
      expect(requests[1].json.variables).toEqual({ input: { organizationId: "org_1" } });
      expect(requests[2].json.variables).toEqual({ input: { organizationId: "org_2" } });
    });

    it("guarantees uniqueness across multiple accounts with identical channel IDs", async () => {
      const mockGql = (req: any) => {
        const query = req.json?.query ?? "";
        if (query.includes("GetChannels") || query.includes("channels(")) {
          return {
            data: {
              channels: [{ id: "shared_ch", name: "Ch 1" }],
            },
          };
        }
        return {
          data: {
            account: {
              id: "acc_1",
              organizations: [{ id: "o1", name: "O1" }],
            },
          },
        };
      };

      const { ctx: ctx1 } = ctxWith([["POST https://api.buffer.com", mockGql]]);
      const [acc1] = await buffer.connect!(ctx1, { apiKey: "k1", tag: "client-alpha" });

      const { ctx: ctx2 } = ctxWith([["POST https://api.buffer.com", mockGql]]);
      const [acc2] = await buffer.connect!(ctx2, { apiKey: "k2", tag: "client-beta" });

      expect(acc1.externalId).toBe("client-alpha:shared_ch");
      expect(acc2.externalId).toBe("client-beta:shared_ch");
      expect(acc1.externalId).not.toBe(acc2.externalId);
    });

    it("maps GraphQL FORBIDDEN error on channel query to auth error", async () => {
      const { ctx } = ctxWith([
        [
          "POST https://api.buffer.com",
          (req: any) => {
            const query = req.json?.query ?? "";
            if (query.includes("GetChannels") || query.includes("channels(")) {
              return {
                errors: [
                  {
                    message: "You don't have permission to access this resource",
                    extensions: { code: "FORBIDDEN" },
                  },
                ],
              };
            }
            return {
              data: {
                account: {
                  id: "acc_1",
                  organizations: [{ id: "org_forbidden", name: "Forbidden Org" }],
                },
              },
            };
          },
        ],
      ]);

      const err = await buffer.connect!(ctx, { apiKey: "bad_token", tag: "tag" }).catch((e) => e);
      expect(err).toBeInstanceOf(ProviderError);
      expect(err.kind).toBe("auth");
    });

    it("falls back to REST /profiles.json if channel query fails with non-auth error", async () => {
      const { ctx } = ctxWith([
        [
          "POST https://api.buffer.com",
          (req: any) => {
            const query = req.json?.query ?? "";
            if (query.includes("GetChannels") || query.includes("channels(")) {
              return json({ error: "Channel service down" }, 500);
            }
            return {
              data: {
                account: {
                  id: "acc_1",
                  organizations: [{ id: "org_1", name: "Org 1" }],
                },
              },
            };
          },
        ],
        [
          "GET https://api.bufferapp.com/1/profiles.json",
          () => [
            {
              id: "prof_rest_fallback",
              formatted_username: "Fallback Profile",
              service: "twitter",
            },
          ],
        ],
      ]);

      const [conn] = await buffer.connect!(ctx, { apiKey: "BUF_KEY", tag: "fallback-tag" });
      expect(conn).toMatchObject({
        externalId: "fallback-tag:prof_rest_fallback",
        name: "fallback-tag (Fallback Profile)",
      });
    });

    it("falls back to REST /profiles.json if GraphQL fails with non-auth error", async () => {
      const { ctx } = ctxWith([
        ["POST https://api.buffer.com", () => json({ error: "GraphQL unsupported" }, 400)],
        [
          "GET https://api.bufferapp.com/1/profiles.json",
          () => [
            {
              id: "prof_rest_1",
              formatted_username: "REST Profile",
              service: "twitter",
              avatar: "https://buf/rest.jpg",
            },
          ],
        ],
      ]);

      const [conn] = await buffer.connect!(ctx, { apiKey: "BUF_KEY", tag: "rest-tag" });
      expect(conn).toMatchObject({
        externalId: "rest-tag:prof_rest_1",
        name: "rest-tag (REST Profile)",
        username: "rest-tag",
        meta: { tag: "rest-tag", channelId: "prof_rest_1", service: "twitter" },
      });
    });

    it("handles empty channels list gracefully by returning fallback account with tag", async () => {
      const { ctx } = ctxWith([
        ["POST https://api.buffer.com", () => ({ data: { account: { id: "acc_empty", organizations: [] } } })],
      ]);

      const [conn] = await buffer.connect!(ctx, { apiKey: "BUF_KEY", tag: "empty-tag" });
      expect(conn).toMatchObject({
        externalId: "empty-tag",
        name: "empty-tag",
        username: "empty-tag",
        credentials: { apiKey: "BUF_KEY", tag: "empty-tag" },
      });
    });

    it("maps 401 to auth error", async () => {
      const { ctx } = ctxWith([["POST https://api.buffer.com", () => json({ message: "Unauthorized" }, 401)]]);
      const err = await buffer.connect!(ctx, { apiKey: "bad_key", tag: "tag" }).catch((e) => e);
      expect(err).toBeInstanceOf(ProviderError);
      expect(err.kind).toBe("auth");
    });

    it("maps GraphQL UNAUTHENTICATED error to ProviderError 'auth'", async () => {
      const { ctx } = ctxWith([
        [
          "POST https://api.buffer.com",
          () => ({ errors: [{ message: "Invalid API token", extensions: { code: "UNAUTHENTICATED" } }] }),
        ],
      ]);
      const err = await buffer.connect!(ctx, { apiKey: "bad_key", tag: "tag" }).catch((e) => e);
      expect(err).toBeInstanceOf(ProviderError);
      expect(err.kind).toBe("auth");
    });
  });

  describe("publish", () => {
    it("schedules a video post with customScheduled mode, dueAt, and hotlinked R2 media URL", async () => {
      const futureTime = Date.now() + 3600_000;
      const vid = video({ url: "https://pf.example.com/m/vid_1/sig/clip.mp4" });

      const { ctx, commit, requests } = ctxWith([
        [
          "POST https://api.buffer.com",
          () => ({
            data: {
              createPost: {
                __typename: "PostActionSuccess",
                post: {
                  id: "post_buf_789",
                  status: "scheduled",
                  dueAt: new Date(futureTime).toISOString(),
                },
              },
            },
          }),
        ],
      ]);

      const res = await buffer.publish(ctx, account(), post({}, [vid], futureTime));

      expect(res).toEqual({
        status: "published",
        externalId: "post_buf_789",
        url: "https://publish.buffer.com/profile/channel_123/tab/sent",
        data: {
          bufferPostId: "post_buf_789",
          channelId: "channel_123",
          status: "scheduled",
          dueAt: new Date(futureTime).toISOString(),
        },
      });

      expect(commit.sent).toBe(true);
      expect(commit.accepted).toBe(true);

      const reqBody = requests[0].json;
      expect(reqBody.variables.input).toEqual({
        channelId: "channel_123",
        text: "Scheduled video post for Buffer! #postflare",
        mode: "customScheduled",
        schedulingType: "automatic",
        needsApproval: false,
        dueAt: new Date(futureTime).toISOString(),
        assets: [{ video: { url: "https://pf.example.com/m/vid_1/sig/clip.mp4", metadata: { thumbnailOffset: 0 } } }],
        metadata: {
          instagram: {
            type: "reel",
            shouldShareToFeed: true,
          },
        },
      });
    });

    it("publishes immediate text post with shareNow mode", async () => {
      const { ctx, requests } = ctxWith([
        [
          "POST https://api.buffer.com",
          () => ({
            data: {
              createPost: {
                __typename: "PostActionSuccess",
                post: {
                  id: "post_buf_now",
                  status: "sent",
                  dueAt: null,
                },
              },
            },
          }),
        ],
      ]);

      const res = await buffer.publish(ctx, account(), post());
      expect(res.status).toBe("published");
      expect(requests[0].json.variables.input.mode).toBe("shareNow");
      expect(requests[0].json.variables.input.needsApproval).toBe(false);
      expect(requests[0].json.variables.input.dueAt).toBeUndefined();
    });

    it("publishes image attachments correctly", async () => {
      const img = image({ url: "https://pf.example.com/m/img_1/sig/photo.jpg", alt: "Buffer photo" });
      const { ctx, requests } = ctxWith([
        [
          "POST https://api.buffer.com",
          () => ({
            data: {
              createPost: {
                __typename: "PostActionSuccess",
                post: {
                  id: "post_buf_img",
                  status: "sent",
                },
              },
            },
          }),
        ],
      ]);

      const res = await buffer.publish(ctx, account(), post({}, [img]));
      expect(res.status).toBe("published");
      expect(requests[0].json.variables.input.needsApproval).toBe(false);
      expect(requests[0].json.variables.input.assets).toEqual([
        { image: { url: "https://pf.example.com/m/img_1/sig/photo.jpg", alt: "Buffer photo" } },
      ]);
    });

    it("schedules a video post via REST fallback create update endpoint", async () => {
      const futureTime = Date.now() + 7200_000;
      const vid = video({ url: "https://pf.example.com/m/vid_rest/sig/clip.mp4" });

      const restAccount = account({
        meta: { tag: "rest-tag", channelId: "prof_rest_1", rest: true },
      });

      const { ctx, commit, requests } = ctxWith([
        [
          "POST https://api.bufferapp.com/1/updates/create.json",
          () => ({
            success: true,
            updates: [
              {
                id: "up_rest_123",
                status: "buffer",
              },
            ],
          }),
        ],
      ]);

      const res = await buffer.publish(ctx, restAccount, post({}, [vid], futureTime));
      expect(res.status).toBe("published");
      if (res.status === "published") {
        expect(res.externalId).toBe("up_rest_123");
      }
      expect(commit.sent).toBe(true);
      expect(commit.accepted).toBe(true);

      const body = requests[0].json;
      expect(body.profile_ids).toEqual(["prof_rest_1"]);
      expect(body.media).toEqual({ video: "https://pf.example.com/m/vid_rest/sig/clip.mp4" });
      expect(body.scheduled_at).toBe(new Date(futureTime).toISOString());
    });

    it("rejects post when mutation error message is returned and unmarks accepted", async () => {
      const { ctx, commit } = ctxWith([
        [
          "POST https://api.buffer.com",
          () => ({
            data: {
              createPost: {
                __typename: "InvalidInputError",
                message: "Video duration exceeds maximum allowed limit",
              },
            },
          }),
        ],
      ]);

      await expect(buffer.publish(ctx, account(), post({}, [video()]))).rejects.toMatchObject({
        kind: "invalid",
        message: expect.stringContaining("Video duration exceeds maximum allowed limit"),
      });

      expect(commit.sent).toBe(true);
      expect(commit.accepted).toBe(false);
    });

    it("rejects with auth error when createPost returns UnauthorizedError", async () => {
      const { ctx, commit } = ctxWith([
        [
          "POST https://api.buffer.com",
          () => ({
            data: {
              createPost: {
                __typename: "UnauthorizedError",
                message: "Unauthorized channel access",
              },
            },
          }),
        ],
      ]);

      await expect(buffer.publish(ctx, account(), post())).rejects.toMatchObject({
        kind: "auth",
        message: expect.stringContaining("Unauthorized channel access"),
      });

      expect(commit.sent).toBe(true);
      expect(commit.accepted).toBe(false);
    });

    it("rejects with rate_limit when createPost returns LimitReachedError", async () => {
      const { ctx, commit } = ctxWith([
        [
          "POST https://api.buffer.com",
          () => ({
            data: {
              createPost: {
                __typename: "LimitReachedError",
                message: "Daily post limit reached",
              },
            },
          }),
        ],
      ]);

      await expect(buffer.publish(ctx, account(), post())).rejects.toMatchObject({
        kind: "rate_limit",
        message: expect.stringContaining("Daily post limit reached"),
      });

      expect(commit.sent).toBe(true);
      expect(commit.accepted).toBe(false);
    });

    it("rejects with transient when createPost returns UnexpectedError", async () => {
      const { ctx, commit } = ctxWith([
        [
          "POST https://api.buffer.com",
          () => ({
            data: {
              createPost: {
                __typename: "UnexpectedError",
                message: "Buffer internal server error",
              },
            },
          }),
        ],
      ]);

      await expect(buffer.publish(ctx, account(), post())).rejects.toMatchObject({
        kind: "transient",
        message: expect.stringContaining("Buffer internal server error"),
      });

      expect(commit.sent).toBe(true);
      expect(commit.accepted).toBe(false);
    });

    it("rejects with invalid when createPost returns NotFoundError", async () => {
      const { ctx, commit } = ctxWith([
        [
          "POST https://api.buffer.com",
          () => ({
            data: {
              createPost: {
                __typename: "NotFoundError",
                message: "Channel not found",
              },
            },
          }),
        ],
      ]);

      await expect(buffer.publish(ctx, account(), post())).rejects.toMatchObject({
        kind: "invalid",
        message: expect.stringContaining("Channel not found"),
      });

      expect(commit.sent).toBe(true);
      expect(commit.accepted).toBe(false);
    });

    it("rejects with invalid when createPost returns RestProxyError", async () => {
      const { ctx, commit } = ctxWith([
        [
          "POST https://api.buffer.com",
          () => ({
            data: {
              createPost: {
                __typename: "RestProxyError",
                message: "Downstream REST failure",
              },
            },
          }),
        ],
      ]);

      await expect(buffer.publish(ctx, account(), post())).rejects.toMatchObject({
        kind: "invalid",
        message: expect.stringContaining("Downstream REST failure"),
      });

      expect(commit.sent).toBe(true);
      expect(commit.accepted).toBe(false);
    });

    it("rejects with invalid when createPost returns generic error message without typename", async () => {
      const { ctx, commit } = ctxWith([
        [
          "POST https://api.buffer.com",
          () => ({
            data: {
              createPost: {
                message: "Generic mutation failure",
              },
            },
          }),
        ],
      ]);

      await expect(buffer.publish(ctx, account(), post())).rejects.toMatchObject({
        kind: "invalid",
        message: expect.stringContaining("Generic mutation failure"),
      });

      expect(commit.sent).toBe(true);
      expect(commit.accepted).toBe(false);
    });

    it("rejects with invalid when createPost returns no post ID", async () => {
      const { ctx, commit } = ctxWith([
        [
          "POST https://api.buffer.com",
          () => ({
            data: {
              createPost: {
                __typename: "PostActionSuccess",
                post: null,
              },
            },
          }),
        ],
      ]);

      await expect(buffer.publish(ctx, account(), post())).rejects.toMatchObject({
        kind: "invalid",
        message: expect.stringContaining("no post ID returned"),
      });

      expect(commit.sent).toBe(true);
      expect(commit.accepted).toBe(false);
    });

    it("handles network error during publish as ambiguous failure", async () => {
      const { ctx, commit } = ctxWith([
        [
          "POST https://api.buffer.com",
          () => {
            throw new TypeError("fetch failed");
          },
        ],
      ]);

      await expect(buffer.publish(ctx, account(), post())).rejects.toMatchObject({
        kind: "ambiguous",
      });

      expect(commit.sent).toBe(true);
      expect(commit.accepted).toBe(false);
    });

    it("maps HTTP 429 to rate_limit and HTTP 401 to auth during publish", async () => {
      const { ctx: ctx429 } = ctxWith([
        ["POST https://api.buffer.com", () => json({ message: "Rate limit exceeded" }, 429)],
      ]);
      await expect(buffer.publish(ctx429, account(), post())).rejects.toMatchObject({
        kind: "rate_limit",
      });

      const { ctx: ctx401 } = ctxWith([
        ["POST https://api.buffer.com", () => json({ message: "Token expired" }, 401)],
      ]);
      await expect(buffer.publish(ctx401, account(), post())).rejects.toMatchObject({
        kind: "auth",
      });
    });

    it("throws invalid when channel ID is missing", async () => {
      const { ctx } = ctxWith([]);
      const noChannelAccount = account({
        externalId: "tag-only",
        meta: { tag: "tag-only" },
      });
      await expect(buffer.publish(ctx, noChannelAccount, post())).rejects.toMatchObject({
        kind: "invalid",
        message: expect.stringContaining("channel ID is missing"),
      });
    });

    it("unmarks commit accepted when GraphQL returns HTTP 200 with top-level errors during publish", async () => {
      const { ctx, commit } = ctxWith([
        [
          "POST https://api.buffer.com",
          () => json({ errors: [{ message: "Channel not found or inactive", extensions: { code: "NOT_FOUND" } }] }, 200),
        ],
      ]);

      await expect(buffer.publish(ctx, account(), post())).rejects.toMatchObject({
        kind: "invalid",
        message: expect.stringContaining("Channel not found or inactive"),
      });

      expect(commit.sent).toBe(true);
      expect(commit.accepted).toBe(false);
    });

    it("unmarks commit accepted and sets kind auth when GraphQL returns HTTP 200 with UNAUTHENTICATED error during publish", async () => {
      const { ctx, commit } = ctxWith([
        [
          "POST https://api.buffer.com",
          () => json({ errors: [{ message: "Access token is invalid", extensions: { code: "UNAUTHENTICATED" } }] }, 200),
        ],
      ]);

      await expect(buffer.publish(ctx, account(), post())).rejects.toMatchObject({
        kind: "auth",
        message: expect.stringContaining("Access token is invalid"),
      });

      expect(commit.sent).toBe(true);
      expect(commit.accepted).toBe(false);
    });

    it("extracts channel ID from externalId fallback when tag contains colons and meta.channelId is absent", async () => {
      const colonTagAccount = account({
        externalId: "client:tag:with:colons:ch_999",
        meta: { tag: "client:tag:with:colons" },
      });

      const { ctx, requests } = ctxWith([
        [
          "POST https://api.buffer.com",
          () => ({
            data: {
              createPost: {
                __typename: "PostActionSuccess",
                post: {
                  id: "post_buf_colon",
                  status: "sent",
                },
              },
            },
          }),
        ],
      ]);

      const res = await buffer.publish(ctx, colonTagAccount, post());
      expect(res.status).toBe("published");
      expect(requests[0].json.variables.input.channelId).toBe("ch_999");
      expect(requests[0].json.variables.input.needsApproval).toBe(false);
    });
  });

  describe("checkStatus", () => {
    it("returns published when post status is sent", async () => {
      const { ctx } = ctxWith([
        [
          "POST https://api.buffer.com",
          () => ({
            data: {
              post: {
                id: "post_buf_789",
                status: "sent",
                dueAt: null,
                sentAt: "2026-11-22T10:00:00Z",
              },
            },
          }),
        ],
      ]);

      const res = await buffer.checkStatus!(ctx, account(), {
        bufferPostId: "post_buf_789",
        channelId: "channel_123",
      });
      expect(res.status).toBe("published");
      if (res.status === "published") {
        expect(res.externalId).toBe("post_buf_789");
      }
    });

    it("returns pending when post is still scheduled or buffering", async () => {
      const { ctx } = ctxWith([
        [
          "POST https://api.buffer.com",
          () => ({
            data: {
              post: {
                id: "post_buf_789",
                status: "buffering",
                dueAt: "2026-11-22T12:00:00Z",
              },
            },
          }),
        ],
      ]);

      const res = await buffer.checkStatus!(ctx, account(), {
        bufferPostId: "post_buf_789",
        channelId: "channel_123",
      });
      expect(res.status).toBe("pending");
      expect(res).toMatchObject({ retryAfterSeconds: 30 });
    });

    it("throws invalid when status is failed", async () => {
      const { ctx } = ctxWith([
        [
          "POST https://api.buffer.com",
          () => ({
            data: {
              post: {
                id: "post_buf_789",
                status: "failed",
              },
            },
          }),
        ],
      ]);

      await expect(
        buffer.checkStatus!(ctx, account(), { bufferPostId: "post_buf_789", channelId: "channel_123" }),
      ).rejects.toMatchObject({ kind: "invalid" });
    });

    it("checks status via REST fallback if GraphQL fails", async () => {
      const { ctx } = ctxWith([
        ["POST https://api.buffer.com", () => json({ error: "Endpoint not found" }, 404)],
        [
          "GET https://api.bufferapp.com/1/updates/up_rest_456.json",
          () => ({
            id: "up_rest_456",
            status: "sent",
          }),
        ],
      ]);

      const res = await buffer.checkStatus!(ctx, account(), {
        updateId: "up_rest_456",
        channelId: "channel_123",
      });
      expect(res.status).toBe("published");
      if (res.status === "published") {
        expect(res.externalId).toBe("up_rest_456");
      }
    });

    it("maps 401 to auth and 500 to transient during status check", async () => {
      const { ctx: ctx401 } = ctxWith([
        ["POST https://api.buffer.com", () => json({ message: "Invalid token" }, 401)],
      ]);
      await expect(buffer.checkStatus!(ctx401, account(), { bufferPostId: "post_1" })).rejects.toMatchObject({
        kind: "auth",
      });

      const { ctx: ctx500 } = ctxWith([
        ["POST https://api.buffer.com", () => json({ message: "Server error" }, 500)],
        ["GET https://api.bufferapp.com/1/updates/post_1.json", () => json({ message: "Server error" }, 500)],
      ]);
      await expect(buffer.checkStatus!(ctx500, account(), { bufferPostId: "post_1" })).rejects.toMatchObject({
        kind: "transient",
      });
    });
  });

  describe("validate", () => {
    it("rejects empty post without text or media", () => {
      expect(buffer.validate!({ id: "1", content: "", media: [], settings: {} })).toHaveLength(1);
    });

    it("rejects posts with multiple videos", () => {
      expect(buffer.validate!({ id: "1", content: "hi", media: [video(), video()], settings: {} })).toHaveLength(1);
    });

    it("rejects posts with mixed images and videos", () => {
      expect(buffer.validate!({ id: "1", content: "hi", media: [video(), image()], settings: {} })).toHaveLength(1);
    });

    it("rejects posts with more than 4 images", () => {
      expect(
        buffer.validate!({ id: "1", content: "hi", media: [image(), image(), image(), image(), image()], settings: {} }),
      ).toHaveLength(1);
    });

    it("accepts valid scheduled video post", () => {
      expect(buffer.validate!({ id: "1", content: "hi", media: [video()], settings: {} })).toHaveLength(0);
    });

    it("accepts valid video post without text", () => {
      expect(buffer.validate!({ id: "1", content: "", media: [video()], settings: {} })).toHaveLength(0);
    });

    it("rejects unsupported media kinds (document, audio)", () => {
      const doc = image({ id: "m_doc", kind: "document" as any, url: "https://example.com/doc.pdf" });
      const aud = video({ id: "m_aud", kind: "audio" as any, url: "https://example.com/sound.mp3" });

      const docErrors = buffer.validate!({ id: "1", content: "hello", media: [doc], settings: {} });
      expect(docErrors).toContain("Buffer only supports image and video attachments");

      const audErrors = buffer.validate!({ id: "1", content: "", media: [aud], settings: {} });
      expect(audErrors).toContain("Buffer only supports image and video attachments");
    });
  });

  describe("registry and architecture integration", () => {
    it("is registered in provider registry and PROVIDER_NAMES catalog", () => {
      const reg = getProvider("buffer");
      expect(reg).toBeDefined();
      expect(reg?.id).toBe("buffer");
      expect(reg?.name).toBe("Buffer");
      expect(PROVIDER_NAMES["buffer"]).toBe("Buffer");
    });

    it("is included in hotlinkingProviders to protect R2 media assets", () => {
      expect(hotlinkingProviders()).toContain("buffer");
    });
  });

  describe("buffer service helpers", () => {
    it("maps Buffer service codes to human-friendly display names", () => {
      expect(bufferServiceDisplayName("instagram")).toBe("Instagram");
      expect(bufferServiceDisplayName("facebook")).toBe("Facebook");
      expect(bufferServiceDisplayName("threads")).toBe("Threads");
      expect(bufferServiceDisplayName("youtube")).toBe("YouTube");
      expect(bufferServiceDisplayName("tiktok")).toBe("TikTok");
      expect(bufferServiceDisplayName("twitter")).toBe("X (Twitter)");
      expect(bufferServiceDisplayName("x")).toBe("X (Twitter)");
      expect(bufferServiceDisplayName("pinterest")).toBe("Pinterest");
      expect(bufferServiceDisplayName("linkedin")).toBe("LinkedIn");
      expect(bufferServiceDisplayName("linkedin_page")).toBe("LinkedIn Page");
      expect(bufferServiceDisplayName("gmb")).toBe("Google Business Profile");
      expect(bufferServiceDisplayName("googlebusiness")).toBe("Google Business Profile");
      expect(bufferServiceDisplayName(null)).toBe("Buffer");
      expect(bufferServiceDisplayName(undefined)).toBe("Buffer");
      expect(bufferServiceDisplayName("")).toBe("Buffer");
      expect(bufferServiceDisplayName("custom_service")).toBe("Custom_service");
    });

    it("maps Buffer service codes to simple-icon slugs", () => {
      expect(bufferServiceIcon("instagram")).toBe("instagram");
      expect(bufferServiceIcon("facebook")).toBe("facebook");
      expect(bufferServiceIcon("threads")).toBe("threads");
      expect(bufferServiceIcon("youtube")).toBe("youtube");
      expect(bufferServiceIcon("tiktok")).toBe("tiktok");
      expect(bufferServiceIcon("twitter")).toBe("x");
      expect(bufferServiceIcon("x")).toBe("x");
      expect(bufferServiceIcon("pinterest")).toBe("pinterest");
      expect(bufferServiceIcon("linkedin")).toBe("linkedin");
      expect(bufferServiceIcon("linkedin_page")).toBe("linkedin");
      expect(bufferServiceIcon("gmb")).toBe("google");
      expect(bufferServiceIcon(null)).toBe("buffer");
      expect(bufferServiceIcon(undefined)).toBe("buffer");
      expect(bufferServiceIcon("")).toBe("buffer");
    });

    it("ensures connect() properly populates channel metadata and name formatting", async () => {
      const { ctx } = ctxWith([
        [
          "POST https://api.buffer.com",
          (req: any) => {
            const query = req.json?.query ?? "";
            if (query.includes("GetChannels") || query.includes("channels(")) {
              return {
                data: {
                  channels: [
                    {
                      id: "ch_thread_1",
                      name: "Threads Profile",
                      displayName: "@thread_user",
                      service: "threads",
                      serviceId: "svc_threads_99",
                    },
                    {
                      id: "ch_yt_1",
                      name: "YouTube Channel",
                      displayName: null,
                      service: "youtube",
                    },
                  ],
                },
              };
            }
            return {
              data: {
                account: {
                  id: "acc_1",
                  organizations: [{ id: "org_1", name: "Org 1" }],
                },
              },
            };
          },
        ],
      ]);

      const conns = await buffer.connect!(ctx, { apiKey: "API_KEY", tag: "my-brand" });
      expect(conns).toHaveLength(2);

      // Channel 1 with displayName and serviceId
      expect(conns[0].name).toBe("my-brand (@thread_user)");
      expect(conns[0].meta).toEqual({
        tag: "my-brand",
        channelId: "ch_thread_1",
        service: "threads",
        serviceId: "svc_threads_99",
        organizationId: "org_1",
        isDisconnected: false,
        isLocked: false,
        isQueuePaused: false,
        externalLink: null,
      });

      // Channel 2 with name fallback and null serviceId
      expect(conns[1].name).toBe("my-brand (YouTube Channel)");
      expect(conns[1].meta).toEqual({
        tag: "my-brand",
        channelId: "ch_yt_1",
        service: "youtube",
        serviceId: null,
        organizationId: "org_1",
        isDisconnected: false,
        isLocked: false,
        isQueuePaused: false,
        externalLink: null,
      });
    });
  });
});
