import { describe, expect, it } from "vitest";
import { DIRECT_SOCIAL_PROVIDERS } from "../shared/providerNames";
import { matchesAccountSearch } from "../src/lib/accountGroups";
import type { AccountDTO } from "../shared/types";

describe("ConnectDialog & Buffer Unified Connector UI Logic", () => {
  it("defines all target native direct social networks to be excluded in favor of Buffer", () => {
    const expectedDirectPlatforms = [
      "instagram",
      "instagram_standalone",
      "facebook",
      "threads",
      "x",
      "tiktok",
      "tiktok_business",
      "youtube",
      "linkedin",
      "linkedin_page",
      "pinterest",
    ];

    for (const platform of expectedDirectPlatforms) {
      expect(DIRECT_SOCIAL_PROVIDERS.has(platform), `Expected ${platform} to be in DIRECT_SOCIAL_PROVIDERS`).toBe(true);
    }
  });

  it("does not exclude non-direct services (like bluesky, mastodon, telegram, webhook)", () => {
    expect(DIRECT_SOCIAL_PROVIDERS.has("buffer")).toBe(false);
    expect(DIRECT_SOCIAL_PROVIDERS.has("bluesky")).toBe(false);
    expect(DIRECT_SOCIAL_PROVIDERS.has("mastodon")).toBe(false);
    expect(DIRECT_SOCIAL_PROVIDERS.has("telegram")).toBe(false);
    expect(DIRECT_SOCIAL_PROVIDERS.has("webhook")).toBe(false);
  });

  it("matches Buffer accounts by #tag, @tag, and un-prefixed tag", () => {
    const acc: AccountDTO = {
      id: "acc_buf_1",
      provider: "buffer",
      externalId: "client-alpha:ch_123",
      name: "client-alpha (Instagram Reels)",
      username: "client-alpha",
      tag: "client-alpha",
      avatarUrl: null,
      profileUrl: null,
      status: "active",
      statusMessage: null,
      expiresAt: null,
      createdAt: 0,
      reconnectedAt: null,
      metricsStatus: { status: "ok", message: null, checkedAt: null, metrics: null },
      groupId: null,
    };

    expect(matchesAccountSearch(acc, "#client-alpha")).toBe(true);
    expect(matchesAccountSearch(acc, "@client-alpha")).toBe(true);
    expect(matchesAccountSearch(acc, "client-alpha")).toBe(true);
    expect(matchesAccountSearch(acc, "instagram")).toBe(true);
    expect(matchesAccountSearch(acc, "reels")).toBe(true);
    expect(matchesAccountSearch(acc, "non-existent")).toBe(false);
  });
});
