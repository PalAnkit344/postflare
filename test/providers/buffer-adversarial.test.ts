import { describe, expect, it } from "vitest";
import { buffer } from "../../worker/providers/buffer";
import { ProviderError } from "../../worker/providers/errors";
import type { CommitState } from "../../worker/providers/types";
import { json, mockFetch, testAccount, testContext } from "../helpers";

function ctxWith(routes: Parameters<typeof mockFetch>[0]) {
  const m = mockFetch(routes);
  const ctx = testContext(m.fetch);
  const commit: CommitState = { sent: false, accepted: false };
  ctx.commit = commit;
  return { ctx, commit, requests: m.requests };
}

describe("buffer adversarial challenge: connect & channel resolution", () => {
  // =========================================================================
  // Challenge 1: Multiple Organizations with Asymmetric Channel Counts
  // =========================================================================
  describe("Challenge 1: Multiple Organizations with Asymmetric Channel Counts", () => {
    it("handles 10 organizations with varying channel counts (0, 1, 5, 0, 12, etc.)", async () => {
      const orgCounts = [0, 1, 5, 0, 12, 3, 0, 0, 2, 7]; // Total = 30 channels across 10 orgs
      const orgs = orgCounts.map((count, idx) => ({
        id: `org_${idx + 1}`,
        name: `Organization ${idx + 1}`,
      }));

      const channelsByOrg: Record<string, any[]> = {};
      let totalExpectedChannels = 0;
      for (let i = 0; i < orgCounts.length; i++) {
        const orgId = `org_${i + 1}`;
        const count = orgCounts[i];
        channelsByOrg[orgId] = [];
        for (let c = 0; c < count; c++) {
          totalExpectedChannels++;
          channelsByOrg[orgId].push({
            id: `ch_${orgId}_${c + 1}`,
            name: `Channel ${orgId}-${c + 1}`,
            displayName: `@disp_${orgId}_${c + 1}`,
            service: c % 2 === 0 ? "instagram" : "linkedin",
            serviceId: `srv_${orgId}_${c + 1}`,
            avatar: `https://buf/avatar_${orgId}_${c + 1}.jpg`,
          });
        }
      }

      const { ctx, requests } = ctxWith([
        [
          "POST https://api.buffer.com",
          (req: any) => {
            const query = req.json?.query ?? "";
            if (query.includes("GetChannels") || query.includes("channels(")) {
              const orgId = req.json?.variables?.input?.organizationId;
              return { data: { channels: channelsByOrg[orgId] ?? [] } };
            }
            return {
              data: {
                account: {
                  id: "acc_multi_stress",
                  email: "multi@example.com",
                  organizations: orgs,
                },
              },
            };
          },
        ],
      ]);

      const conns = await buffer.connect!(ctx, { apiKey: "BUF_STRESS_KEY", tag: "multi-org-stress" });

      expect(conns).toHaveLength(totalExpectedChannels);
      expect(totalExpectedChannels).toBe(30);

      // Verify requests: 1 account query + 10 organization channel queries
      expect(requests).toHaveLength(11);

      // Verify every channel is mapped accurately with correct metadata and organizationId
      for (const conn of conns) {
        expect(conn.externalId.startsWith("multi-org-stress:ch_org_")).toBe(true);
        expect(conn.credentials.apiKey).toBe("BUF_STRESS_KEY");
        expect(conn.meta?.tag).toBe("multi-org-stress");

        const channelOrgId = (conn.meta as any)?.organizationId;
        expect(channelOrgId).toBeDefined();
        expect(conn.externalId).toContain(channelOrgId);
      }
    });

    it("handles organizations array containing null, undefined, or missing IDs gracefully", async () => {
      const { ctx, requests } = ctxWith([
        [
          "POST https://api.buffer.com",
          (req: any) => {
            const query = req.json?.query ?? "";
            if (query.includes("GetChannels") || query.includes("channels(")) {
              const orgId = req.json?.variables?.input?.organizationId;
              if (orgId === "org_valid") {
                return {
                  data: {
                    channels: [
                      {
                        id: "ch_valid_1",
                        name: "Valid Channel",
                        service: "facebook",
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
                  id: "acc_dirty",
                  organizations: [
                    null,
                    undefined,
                    { id: "", name: "Empty ID Org" },
                    { id: "org_valid", name: "Valid Org" },
                    { name: "No ID Org" } as any,
                  ],
                },
              },
            };
          },
        ],
      ]);

      const conns = await buffer.connect!(ctx, { apiKey: "BUF_KEY", tag: "dirty-orgs" });
      expect(conns).toHaveLength(1);
      expect(conns[0].externalId).toBe("dirty-orgs:ch_valid_1");
      // Only 1 channel query should have been sent for org_valid
      expect(requests).toHaveLength(2);
      expect(requests[1].json.variables.input.organizationId).toBe("org_valid");
    });

    it("handles an account with empty organizations array by returning fallback account", async () => {
      const { ctx, requests } = ctxWith([
        [
          "POST https://api.buffer.com",
          () => ({
            data: {
              account: {
                id: "acc_no_orgs",
                organizations: [],
              },
            },
          }),
        ],
      ]);

      const conns = await buffer.connect!(ctx, { apiKey: "BUF_KEY", tag: "empty-orgs" });
      expect(conns).toHaveLength(1);
      expect(conns[0]).toMatchObject({
        externalId: "empty-orgs",
        name: "empty-orgs",
        username: "empty-orgs",
        avatarUrl: null,
        meta: { tag: "empty-orgs" },
      });
      expect(requests).toHaveLength(1);
    });

    it("handles organizations returning empty channel lists without failing", async () => {
      const { ctx, requests } = ctxWith([
        [
          "POST https://api.buffer.com",
          (req: any) => {
            const query = req.json?.query ?? "";
            if (query.includes("GetChannels") || query.includes("channels(")) {
              return { data: { channels: [] } };
            }
            return {
              data: {
                account: {
                  id: "acc_all_empty_channels",
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

      const conns = await buffer.connect!(ctx, { apiKey: "BUF_KEY", tag: "no-channels" });
      expect(conns).toHaveLength(1);
      expect(conns[0].externalId).toBe("no-channels");
      expect(requests).toHaveLength(3); // 1 account + 2 GetChannels
    });
  });

  // =========================================================================
  // Challenge 2: Missing Optional Fields (displayName, avatar, service, etc.)
  // =========================================================================
  describe("Challenge 2: Missing Optional Fields", () => {
    it("gracefully falls back when displayName, avatar, service, and serviceId are null or omitted", async () => {
      const { ctx } = ctxWith([
        [
          "POST https://api.buffer.com",
          (req: any) => {
            const query = req.json?.query ?? "";
            if (query.includes("GetChannels") || query.includes("channels(")) {
              return {
                data: {
                  channels: [
                    // Case A: displayName null, avatar null
                    {
                      id: "ch_nulls",
                      name: "Only Name",
                      displayName: null,
                      avatar: null,
                      service: "twitter",
                      serviceId: null,
                    },
                    // Case B: displayName undefined, name empty, service present
                    {
                      id: "ch_service_fallback",
                      name: "",
                      service: "pinterest",
                    },
                    // Case C: everything missing except id
                    {
                      id: "ch_bare_minimum",
                    },
                  ],
                },
              };
            }
            return {
              data: {
                account: {
                  id: "acc_sparse",
                  organizations: [{ id: "org_sparse", name: "Sparse Org" }],
                },
              },
            };
          },
        ],
      ]);

      const conns = await buffer.connect!(ctx, { apiKey: "BUF_KEY", tag: "sparse-account" });
      expect(conns).toHaveLength(3);

      // Case A: Uses name
      expect(conns[0]).toMatchObject({
        externalId: "sparse-account:ch_nulls",
        name: "sparse-account (Only Name)",
        avatarUrl: null,
        meta: {
          tag: "sparse-account",
          channelId: "ch_nulls",
          service: "twitter",
          serviceId: null,
          organizationId: "org_sparse",
        },
      });

      // Case B: Falls back to service
      expect(conns[1]).toMatchObject({
        externalId: "sparse-account:ch_service_fallback",
        name: "sparse-account (pinterest)",
        avatarUrl: null,
        meta: {
          tag: "sparse-account",
          channelId: "ch_service_fallback",
          service: "pinterest",
          serviceId: null,
          organizationId: "org_sparse",
        },
      });

      // Case C: Falls back to "Channel"
      expect(conns[2]).toMatchObject({
        externalId: "sparse-account:ch_bare_minimum",
        name: "sparse-account (Channel)",
        avatarUrl: null,
        meta: {
          tag: "sparse-account",
          channelId: "ch_bare_minimum",
          service: null,
          serviceId: null,
          organizationId: "org_sparse",
        },
      });
    });

    it("handles REST fallback profiles with missing optional fields", async () => {
      const { ctx } = ctxWith([
        ["POST https://api.buffer.com", () => json({ error: "GraphQL Down" }, 503)],
        [
          "GET https://api.bufferapp.com/1/profiles.json",
          () => [
            {
              id: "rest_ch_1",
              formatted_username: null,
              service_username: null,
              service: null,
              avatar: null,
            },
          ],
        ],
      ]);

      const conns = await buffer.connect!(ctx, { apiKey: "BUF_KEY", tag: "rest-sparse" });
      expect(conns).toHaveLength(1);
      expect(conns[0]).toMatchObject({
        externalId: "rest-sparse:rest_ch_1",
        name: "rest-sparse (Profile)",
        avatarUrl: null,
        meta: { tag: "rest-sparse", channelId: "rest_ch_1" },
      });
    });
  });

  // =========================================================================
  // Challenge 3: Error Classification & Boundary Conditions
  // =========================================================================
  describe("Challenge 3: Error Classification & Boundary Conditions", () => {
    it("maps top-level UNAUTHENTICATED error to 'auth' without falling back to REST", async () => {
      let restCalled = false;
      const { ctx } = ctxWith([
        [
          "POST https://api.buffer.com",
          () => ({
            errors: [
              {
                message: "Authentication failed. Token is invalid or expired.",
                extensions: { code: "UNAUTHENTICATED" },
              },
            ],
          }),
        ],
        [
          "GET https://api.bufferapp.com/1/profiles.json",
          () => {
            restCalled = true;
            return [];
          },
        ],
      ]);

      const err = await buffer.connect!(ctx, { apiKey: "bad_token", tag: "tag" }).catch((e) => e);
      expect(err).toBeInstanceOf(ProviderError);
      expect(err.kind).toBe("auth");
      expect(err.message).toContain("Authentication failed");
      expect(restCalled).toBe(false);
    });

    it("maps organization channel query FORBIDDEN error to 'auth' without falling back to REST", async () => {
      let restCalled = false;
      const { ctx } = ctxWith([
        [
          "POST https://api.buffer.com",
          (req: any) => {
            const query = req.json?.query ?? "";
            if (query.includes("GetChannels") || query.includes("channels(")) {
              return {
                errors: [
                  {
                    message: "User lacks permission to query channels for organization",
                    extensions: { code: "FORBIDDEN" },
                  },
                ],
              };
            }
            return {
              data: {
                account: {
                  id: "acc_1",
                  organizations: [{ id: "org_forbidden", name: "Forbidden Corp" }],
                },
              },
            };
          },
        ],
        [
          "GET https://api.bufferapp.com/1/profiles.json",
          () => {
            restCalled = true;
            return [];
          },
        ],
      ]);

      const err = await buffer.connect!(ctx, { apiKey: "token_no_perm", tag: "tag" }).catch((e) => e);
      expect(err).toBeInstanceOf(ProviderError);
      expect(err.kind).toBe("auth");
      expect(err.message).toContain("User lacks permission");
      expect(restCalled).toBe(false);
    });

    it("falls back to REST if channel query fails with 500 or network error", async () => {
      let restCalled = false;
      const { ctx } = ctxWith([
        [
          "POST https://api.buffer.com",
          (req: any) => {
            const query = req.json?.query ?? "";
            if (query.includes("GetChannels") || query.includes("channels(")) {
              return json({ error: "Internal Channel Service Error" }, 500);
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
          () => {
            restCalled = true;
            return [
              {
                id: "prof_recovered",
                formatted_username: "Recovered Account",
                service: "instagram",
              },
            ];
          },
        ],
      ]);

      const conns = await buffer.connect!(ctx, { apiKey: "BUF_KEY", tag: "recovery" });
      expect(restCalled).toBe(true);
      expect(conns).toHaveLength(1);
      expect(conns[0].externalId).toBe("recovery:prof_recovered");
    });

    it("rethrows original GraphQL error if REST fallback also fails with non-auth error", async () => {
      const { ctx } = ctxWith([
        ["POST https://api.buffer.com", () => json({ error: "GraphQL exploded" }, 500)],
        ["GET https://api.bufferapp.com/1/profiles.json", () => json({ error: "REST exploded too" }, 502)],
      ]);

      const err = await buffer.connect!(ctx, { apiKey: "BUF_KEY", tag: "tag" }).catch((e) => e);
      expect(err).toBeInstanceOf(ProviderError);
      expect(err.message).toContain("GraphQL exploded");
    });

    it("throws 'auth' error if REST fallback returns 401 Unauthorized", async () => {
      const { ctx } = ctxWith([
        ["POST https://api.buffer.com", () => json({ error: "GraphQL 500" }, 500)],
        ["GET https://api.bufferapp.com/1/profiles.json", () => json({ error: "Unauthorized" }, 401)],
      ]);

      const err = await buffer.connect!(ctx, { apiKey: "bad_key", tag: "tag" }).catch((e) => e);
      expect(err).toBeInstanceOf(ProviderError);
      expect(err.kind).toBe("auth");
    });
  });

  // =========================================================================
  // Challenge 4: Composite External IDs: Uniqueness, Special Characters, & Parsing
  // =========================================================================
  describe("Challenge 4: Composite External IDs: Uniqueness & Well-Formedness", () => {
    it("ensures composite externalIds remain unique when channels share IDs across accounts", async () => {
      const makeChannelGql = (channelId: string) => (req: any) => {
        const query = req.json?.query ?? "";
        if (query.includes("GetChannels") || query.includes("channels(")) {
          return { data: { channels: [{ id: channelId, name: "Shared Channel" }] } };
        }
        return { data: { account: { id: "acc_shared", organizations: [{ id: "org_1" }] } } };
      };

      const { ctx: ctxA } = ctxWith([["POST https://api.buffer.com", makeChannelGql("ch_collision")]]);
      const { ctx: ctxB } = ctxWith([["POST https://api.buffer.com", makeChannelGql("ch_collision")]]);

      const [connA] = await buffer.connect!(ctxA, { apiKey: "k_a", tag: "brand_us" });
      const [connB] = await buffer.connect!(ctxB, { apiKey: "k_b", tag: "brand_eu" });

      expect(connA.externalId).toBe("brand_us:ch_collision");
      expect(connB.externalId).toBe("brand_eu:ch_collision");
      expect(connA.externalId).not.toBe(connB.externalId);
    });

    it("preserves integrity and extracts channelId when tag contains multiple colons", async () => {
      const colonTag = "enterprise:brand:region:us-east:client-42";
      const { ctx } = ctxWith([
        [
          "POST https://api.buffer.com",
          (req: any) => {
            const query = req.json?.query ?? "";
            if (query.includes("GetChannels") || query.includes("channels(")) {
              return { data: { channels: [{ id: "ch_deep_colon", name: "Deep Colon Channel" }] } };
            }
            return { data: { account: { id: "acc_colon", organizations: [{ id: "org_colon" }] } } };
          },
        ],
      ]);

      const [conn] = await buffer.connect!(ctx, { apiKey: "k", tag: colonTag });
      expect(conn.externalId).toBe(`${colonTag}:ch_deep_colon`);

      // Verify publishing fallback extracts channel ID correctly even if meta.channelId was lost
      const colonAccount = testAccount({
        provider: "buffer",
        externalId: conn.externalId,
        credentials: { apiKey: "k", tag: colonTag },
        meta: { tag: colonTag }, // channelId deliberately omitted to test fallback
      });

      const { ctx: pubCtx, requests: pubRequests } = ctxWith([
        [
          "POST https://api.buffer.com",
          () => ({
            data: {
              createPost: {
                __typename: "PostActionSuccess",
                post: { id: "post_1", status: "sent" },
              },
            },
          }),
        ],
      ]);

      const pubRes = await buffer.publish(pubCtx, colonAccount, {
        id: "p_col",
        content: "Testing colon extraction",
        media: [],
        settings: {},
      });

      expect(pubRes.status).toBe("published");
      expect(pubRequests[0].json.variables.input.channelId).toBe("ch_deep_colon");
    });

    it("correctly handles tags with spaces and trims whitespace input", async () => {
      const { ctx } = ctxWith([
        [
          "POST https://api.buffer.com",
          (req: any) => {
            const query = req.json?.query ?? "";
            if (query.includes("GetChannels") || query.includes("channels(")) {
              return { data: { channels: [{ id: "ch_trimmed", name: "Trimmed" }] } };
            }
            return { data: { account: { id: "acc_trim", organizations: [{ id: "org_trim" }] } } };
          },
        ],
      ]);

      const [conn] = await buffer.connect!(ctx, { apiKey: "   BUF_TRIMMED_KEY   ", tag: "   my-brand-tag   " });
      expect(conn.externalId).toBe("my-brand-tag:ch_trimmed");
      expect(conn.credentials.apiKey).toBe("BUF_TRIMMED_KEY");
      expect(conn.username).toBe("my-brand-tag");
    });
  });
});
