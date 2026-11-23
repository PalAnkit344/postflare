import { env } from "cloudflare:test";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { ensureSchema } from "../../worker/lib/migrate";
import { encryptJson } from "../../worker/lib/crypto";
import {
  claimJobAtomic,
  discoverDueJobs,
  ingestCloudReelManifest,
  processDueCloudReelJobs,
  verifyDestinationAccount,
  verifyVideoInR2,
  type CloudReelManifest,
} from "../../worker/lib/cloudreel";
import {
  deleteOpenRouterConfig,
  getOpenRouterConfig,
  getOpenRouterConfigDTO,
  saveOpenRouterConfig,
} from "../../worker/lib/openrouter";
import * as registry from "../../worker/providers/registry";

async function sha256Hex(data: Uint8Array | string): Promise<string> {
  const bytes = typeof data === "string" ? new TextEncoder().encode(data) : data;
  const hashBuffer = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(hashBuffer))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

const DB = env.DB;
const MEDIA = env.MEDIA;
const E = { ...env, DB, MEDIA, PUBLIC_URL: "https://pf.test" } as unknown as Env;

describe("CloudReel Central Video Scheduler & Multi-Account Publisher", () => {
  const testWorkspaceId = "ws_cloudreel_test";
  const dummyVideoBytes = new TextEncoder().encode("fake mp4 video content for testing");

  beforeAll(async () => {
    await ensureSchema(DB);
    await DB.prepare("INSERT OR IGNORE INTO workspaces (id, name, created_at) VALUES (?, ?, ?)")
      .bind(testWorkspaceId, "CloudReel Test Workspace", Date.now())
      .run();
  });

  beforeEach(async () => {
    // Clean up test tables
    await DB.prepare("DELETE FROM cloudreel_publishing_jobs").run();
    await DB.prepare("DELETE FROM cloudreel_videos").run();
    await DB.prepare("DELETE FROM accounts WHERE workspace_id = ?").bind(testWorkspaceId).run();
    await deleteOpenRouterConfig(DB);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  async function createAccount(id: string, provider: string, name: string, status = "active") {
    const credsEnc = await encryptJson(E, { token: "token_abc123", apiKey: "token_abc123" });
    await DB.prepare(
      `INSERT INTO accounts (id, workspace_id, provider, external_id, name, username, credentials_enc, profile_url, status, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
      .bind(
        id,
        testWorkspaceId,
        provider,
        `ext_${id}`,
        name,
        name.toLowerCase(),
        credsEnc,
        `https://${provider}.com/${name.toLowerCase()}`,
        status,
        Date.now(),
        Date.now()
      )
      .run();
  }

  // ---------------------------------------------------------------------------
  // SCENARIO 1: One video scheduled for one Instagram account
  // ---------------------------------------------------------------------------
  it("Scenario 1: One video scheduled for one Instagram account - end-to-end publish", async () => {
    const accId = "acc_ig_1";
    await createAccount(accId, "instagram_standalone", "MyInstaBrand");

    const r2Key = "videos/2026/11/video_s1.mp4";
    const hash = await sha256Hex(dummyVideoBytes);
    await MEDIA.put(r2Key, dummyVideoBytes, {
      httpMetadata: { contentType: "video/mp4" },
    });

    const manifest: CloudReelManifest = {
      schema_version: 1,
      video_id: "vid_s1",
      created_at: new Date().toISOString(),
      video: {
        file_name: "vid_s1.mp4",
        r2_bucket: "cloudreel",
        r2_key: r2Key,
        content_type: "video/mp4",
        size_bytes: dummyVideoBytes.length,
        sha256: hash,
      },
      content: {
        title: "Test Single Instagram Video",
        description: "Awesome new video",
        captions: {
          instagram: "Fresh Instagram Reel dropping now!",
        },
        hashtags: ["reels", "viral"],
      },
      destination: {
        platform: "instagram_standalone",
        account_id: accId,
      },
      schedule: {
        scheduled_at: new Date(Date.now() - 1000).toISOString(), // Due now
        timezone: "Asia/Kolkata",
      },
      publishing: {
        status: "READY",
        approved: true,
        attempt_count: 0,
      },
    };

    const ingested = await ingestCloudReelManifest(DB, testWorkspaceId, manifest);
    expect(ingested.videoId).toBe("vid_s1");
    expect(ingested.jobId).toBeDefined();

    // Mock provider publish
    const mockPublish = vi.fn().mockResolvedValue({
      status: "published",
      externalId: "ig_post_99999",
      url: "https://instagram.com/p/ig_post_99999",
    });
    vi.spyOn(registry, "getProvider").mockReturnValue({
      id: "instagram_standalone",
      name: "Instagram",
      capabilities: () => ({ video: true }),
      publish: mockPublish,
    } as any);

    // Run scheduler pipeline
    const result = await processDueCloudReelJobs(E, { workerId: "worker-s1" });
    expect(result.processed).toBe(1);
    expect(result.succeeded).toBe(1);
    expect(result.failed).toBe(0);

    // Verify D1 state updated to PUBLISHED with exact IDs
    const job = await DB.prepare(
      "SELECT * FROM cloudreel_publishing_jobs WHERE video_id = ?"
    )
      .bind("vid_s1")
      .first<any>();

    expect(job).not.toBeNull();
    expect(job.status).toBe("PUBLISHED");
    expect(job.platform_post_id).toBe("ig_post_99999");
    expect(job.published_url).toBe("https://instagram.com/p/ig_post_99999");
    expect(job.locked_by).toBeNull();
    expect(job.locked_until).toBeNull();
  });

  // ---------------------------------------------------------------------------
  // SCENARIO 2: Two videos scheduled for two different accounts
  // ---------------------------------------------------------------------------
  it("Scenario 2: Two videos scheduled for two different accounts (Account Isolation)", async () => {
    const accA = "acc_brand_a";
    const accB = "acc_brand_b";
    await createAccount(accA, "instagram_standalone", "BrandA");
    await createAccount(accB, "facebook", "BrandB");

    const r2KeyA = "videos/2026/11/video_a.mp4";
    const r2KeyB = "videos/2026/11/video_b.mp4";
    await MEDIA.put(r2KeyA, dummyVideoBytes, { httpMetadata: { contentType: "video/mp4" } });
    await MEDIA.put(r2KeyB, dummyVideoBytes, { httpMetadata: { contentType: "video/mp4" } });

    // Video A for Account A
    await ingestCloudReelManifest(
      DB,
      testWorkspaceId,
      {
        schema_version: 1,
        video_id: "vid_a",
        created_at: new Date().toISOString(),
        video: {
          file_name: "vid_a.mp4",
          r2_bucket: "cloudreel",
          r2_key: r2KeyA,
          content_type: "video/mp4",
          size_bytes: dummyVideoBytes.length,
          sha256: null as any,
        },
        content: { title: "Video A", description: "Desc A" },
        destination: { platform: "instagram_standalone", account_id: accA },
        schedule: { scheduled_at: new Date(Date.now() - 2000).toISOString(), timezone: "Asia/Kolkata" },
        publishing: { status: "READY", approved: true },
      }
    );

    // Video B for Account B
    await ingestCloudReelManifest(
      DB,
      testWorkspaceId,
      {
        schema_version: 1,
        video_id: "vid_b",
        created_at: new Date().toISOString(),
        video: {
          file_name: "vid_b.mp4",
          r2_bucket: "cloudreel",
          r2_key: r2KeyB,
          content_type: "video/mp4",
          size_bytes: dummyVideoBytes.length,
          sha256: null as any,
        },
        content: { title: "Video B", description: "Desc B" },
        destination: { platform: "facebook", account_id: accB },
        schedule: { scheduled_at: new Date(Date.now() - 1000).toISOString(), timezone: "Asia/Kolkata" },
        publishing: { status: "READY", approved: true },
      }
    );

    const publishedAccounts: string[] = [];
    vi.spyOn(registry, "getProvider").mockImplementation((p: string) => ({
      id: p,
      name: p,
      capabilities: () => ({ video: true }),
      publish: vi.fn().mockImplementation((_ctx, freshAcc, post) => {
        publishedAccounts.push(freshAcc.id);
        return Promise.resolve({
          status: "published",
          externalId: `pub_${post.id}`,
          url: `https://${p}.com/posts/${post.id}`,
        });
      }),
    } as any));

    const result = await processDueCloudReelJobs(E);
    expect(result.processed).toBe(2);
    expect(result.succeeded).toBe(2);

    // Verify Account Isolation: Account A published Video A, Account B published Video B
    const jobA = await DB.prepare("SELECT * FROM cloudreel_publishing_jobs WHERE video_id = 'vid_a'").first<any>();
    const jobB = await DB.prepare("SELECT * FROM cloudreel_publishing_jobs WHERE video_id = 'vid_b'").first<any>();

    expect(jobA.account_id).toBe(accA);
    expect(jobA.status).toBe("PUBLISHED");
    expect(jobB.account_id).toBe(accB);
    expect(jobB.status).toBe("PUBLISHED");

    expect(publishedAccounts).toContain(accA);
    expect(publishedAccounts).toContain(accB);
  });

  // ---------------------------------------------------------------------------
  // SCENARIO 3: Same video scheduled for Instagram and YouTube
  // ---------------------------------------------------------------------------
  it("Scenario 3: Same video scheduled for Instagram and YouTube (Multi-Destination Manifests)", async () => {
    const igAcc = "acc_multi_ig";
    const ytAcc = "acc_multi_yt";
    await createAccount(igAcc, "instagram_standalone", "MultiIG");
    await createAccount(ytAcc, "youtube", "MultiYT");

    const r2Key = "videos/2026/11/shared_video.mp4";
    await MEDIA.put(r2Key, dummyVideoBytes, { httpMetadata: { contentType: "video/mp4" } });

    const baseManifest: CloudReelManifest = {
      schema_version: 1,
      video_id: "vid_shared_123",
      created_at: new Date().toISOString(),
      video: {
        file_name: "shared.mp4",
        r2_bucket: "cloudreel",
        r2_key: r2Key,
        content_type: "video/mp4",
        size_bytes: dummyVideoBytes.length,
        sha256: null as any,
      },
      content: {
        title: "Cross-Platform Video",
        description: "Shared description across channels",
        captions: {
          instagram: "Instagram special caption #ig",
          youtube: "Full YouTube description with links",
        },
      },
      destination: { platform: "instagram_standalone", account_id: igAcc },
      schedule: {
        scheduled_at: new Date(Date.now() - 500).toISOString(),
        timezone: "Asia/Kolkata",
      },
      publishing: { status: "READY", approved: true },
    };

    const manifestYT: CloudReelManifest = {
      ...baseManifest,
      destination: { platform: "youtube", account_id: ytAcc },
    };

    await ingestCloudReelManifest(DB, testWorkspaceId, baseManifest);
    await ingestCloudReelManifest(DB, testWorkspaceId, manifestYT);

    const publishedCaptions: Record<string, string> = {};
    vi.spyOn(registry, "getProvider").mockImplementation((p: string) => ({
      id: p,
      name: p,
      capabilities: () => ({ video: true }),
      publish: vi.fn().mockImplementation((_ctx, _freshAcc, post) => {
        publishedCaptions[p] = post.content;
        return Promise.resolve({
          status: "published",
          externalId: `pub_${p}_1`,
          url: `https://${p}.com/watch?v=1`,
        });
      }),
    } as any));

    const result = await processDueCloudReelJobs(E);
    expect(result.processed).toBe(2);
    expect(result.succeeded).toBe(2);

    expect(publishedCaptions["instagram_standalone"]).toContain("Instagram special caption");
    expect(publishedCaptions["youtube"]).toContain("Full YouTube description");
  });

  // ---------------------------------------------------------------------------
  // SCENARIO 4: Two publisher workers trying to claim the same job (Race Condition)
  // ---------------------------------------------------------------------------
  it("Scenario 4: Two publisher workers trying to claim the same job (Atomic conditional update)", async () => {
    const accId = "acc_race_test";
    await createAccount(accId, "instagram_standalone", "RaceBrand");

    await ingestCloudReelManifest(
      DB,
      testWorkspaceId,
      {
        schema_version: 1,
        video_id: "vid_race",
        created_at: new Date().toISOString(),
        video: {
          file_name: "race.mp4",
          r2_bucket: "cloudreel",
          r2_key: "videos/race.mp4",
          content_type: "video/mp4",
          size_bytes: 100,
          sha256: null as any,
        },
        content: { title: "Race Video" },
        destination: { platform: "instagram_standalone", account_id: accId },
        schedule: { scheduled_at: new Date(Date.now() - 1000).toISOString(), timezone: "Asia/Kolkata" },
        publishing: { status: "READY", approved: true },
      }
    );

    const jobs = await discoverDueJobs(DB, 10);
    expect(jobs.length).toBe(1);
    const targetJob = jobs[0];

    // Worker 1 and Worker 2 attempt to claim the job concurrently
    const [claim1, claim2] = await Promise.all([
      claimJobAtomic(DB, targetJob.job_id, "worker-alpha"),
      claimJobAtomic(DB, targetJob.job_id, "worker-beta"),
    ]);

    // Exactly one worker must succeed, the other must be rejected
    const successCount = (claim1 ? 1 : 0) + (claim2 ? 1 : 0);
    expect(successCount).toBe(1);

    const winnerWorker = claim1 ? "worker-alpha" : "worker-beta";
    const jobAfter = await DB.prepare("SELECT * FROM cloudreel_publishing_jobs WHERE job_id = ?")
      .bind(targetJob.job_id)
      .first<any>();

    expect(jobAfter.status).toBe("UPLOADING");
    expect(jobAfter.locked_by).toBe(winnerWorker);
    expect(jobAfter.attempt_count).toBe(1);
  });

  // ---------------------------------------------------------------------------
  // SCENARIO 5: Wrong account ID
  // ---------------------------------------------------------------------------
  it("Scenario 5: Wrong account ID - rejected safely without publish", async () => {
    const wrongAccId = "acc_non_existent_999";

    const verify = await verifyDestinationAccount(DB, wrongAccId, "instagram_standalone");
    expect(verify.ok).toBe(false);
    expect(verify.error).toContain("not found");

    // Test inside workflow
    const r2Key = "videos/wrong_acc.mp4";
    await MEDIA.put(r2Key, dummyVideoBytes, { httpMetadata: { contentType: "video/mp4" } });

    await ingestCloudReelManifest(
      DB,
      testWorkspaceId,
      {
        schema_version: 1,
        video_id: "vid_wrong_acc",
        created_at: new Date().toISOString(),
        video: {
          file_name: "wrong.mp4",
          r2_bucket: "cloudreel",
          r2_key: r2Key,
          content_type: "video/mp4",
          size_bytes: dummyVideoBytes.length,
          sha256: null as any,
        },
        content: { title: "Wrong Acc Video" },
        destination: { platform: "instagram_standalone", account_id: wrongAccId },
        schedule: { scheduled_at: new Date(Date.now() - 500).toISOString(), timezone: "Asia/Kolkata" },
        publishing: { status: "READY", approved: true },
      }
    );

    const publishSpy = vi.fn();
    vi.spyOn(registry, "getProvider").mockReturnValue({
      id: "instagram_standalone",
      name: "Instagram",
      capabilities: () => ({ video: true }),
      publish: publishSpy,
    } as any);

    const result = await processDueCloudReelJobs(E);
    expect(result.failed).toBe(1);
    expect(publishSpy).not.toHaveBeenCalled();

    const job = await DB.prepare("SELECT * FROM cloudreel_publishing_jobs WHERE video_id = 'vid_wrong_acc'").first<any>();
    expect(job.status).toBe("FAILED");
    expect(job.error_message).toContain("not found");
  });

  // ---------------------------------------------------------------------------
  // SCENARIO 6: Missing R2 object
  // ---------------------------------------------------------------------------
  it("Scenario 6: Missing R2 object - transitions to REVIEW_REQUIRED", async () => {
    const accId = "acc_r2_missing";
    await createAccount(accId, "instagram_standalone", "MissingR2Brand");

    const nonExistentKey = "videos/never_uploaded.mp4";
    const videoRow = {
      video_id: "vid_missing",
      workspace_id: testWorkspaceId,
      file_name: "missing.mp4",
      r2_bucket: "cloudreel",
      r2_key: nonExistentKey,
      content_type: "video/mp4",
      size_bytes: 5000,
      sha256: null,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    };

    const verify = await verifyVideoInR2(E, videoRow, { checkSha256: true });
    expect(verify.ok).toBe(false);
    expect(verify.error).toContain("R2 object not found");

    // Run in full processDueJobs
    await ingestCloudReelManifest(
      DB,
      testWorkspaceId,
      {
        schema_version: 1,
        video_id: "vid_missing",
        created_at: new Date().toISOString(),
        video: videoRow,
        content: { title: "Missing Video" },
        destination: { platform: "instagram_standalone", account_id: accId },
        schedule: { scheduled_at: new Date(Date.now() - 500).toISOString(), timezone: "Asia/Kolkata" },
        publishing: { status: "READY", approved: true },
      }
    );

    const result = await processDueCloudReelJobs(E);
    expect(result.reviewRequired).toBe(1);

    const job = await DB.prepare("SELECT * FROM cloudreel_publishing_jobs WHERE video_id = 'vid_missing'").first<any>();
    expect(job.status).toBe("REVIEW_REQUIRED");
    expect(job.error_message).toContain("not found");
  });

  // ---------------------------------------------------------------------------
  // SCENARIO 7: Incorrect SHA-256 hash
  // ---------------------------------------------------------------------------
  it("Scenario 7: Incorrect SHA-256 hash - transitions to REVIEW_REQUIRED", async () => {
    const accId = "acc_hash_fail";
    await createAccount(accId, "instagram_standalone", "HashBrand");

    const r2Key = "videos/corrupt.mp4";
    await MEDIA.put(r2Key, dummyVideoBytes, { httpMetadata: { contentType: "video/mp4" } });

    const bogusHash = "0000000000000000000000000000000000000000000000000000000000000000";

    await ingestCloudReelManifest(
      DB,
      testWorkspaceId,
      {
        schema_version: 1,
        video_id: "vid_corrupt_hash",
        created_at: new Date().toISOString(),
        video: {
          file_name: "corrupt.mp4",
          r2_bucket: "cloudreel",
          r2_key: r2Key,
          content_type: "video/mp4",
          size_bytes: dummyVideoBytes.length,
          sha256: bogusHash,
        },
        content: { title: "Corrupt Hash Video" },
        destination: { platform: "instagram_standalone", account_id: accId },
        schedule: { scheduled_at: new Date(Date.now() - 500).toISOString(), timezone: "Asia/Kolkata" },
        publishing: { status: "READY", approved: true },
      }
    );

    const result = await processDueCloudReelJobs(E);
    expect(result.reviewRequired).toBe(1);

    const job = await DB.prepare("SELECT * FROM cloudreel_publishing_jobs WHERE video_id = 'vid_corrupt_hash'").first<any>();
    expect(job.status).toBe("REVIEW_REQUIRED");
    expect(job.error_message).toContain("SHA-256 hash mismatch");
  });

  // ---------------------------------------------------------------------------
  // SCENARIO 8: Duplicate publishing request (Idempotency)
  // ---------------------------------------------------------------------------
  it("Scenario 8: Duplicate publishing request - already PUBLISHED job is never re-published", async () => {
    const accId = "acc_idempotent";
    await createAccount(accId, "instagram_standalone", "IdempotentBrand");

    await ingestCloudReelManifest(
      DB,
      testWorkspaceId,
      {
        schema_version: 1,
        video_id: "vid_already_done",
        created_at: new Date().toISOString(),
        video: {
          file_name: "done.mp4",
          r2_bucket: "cloudreel",
          r2_key: "videos/done.mp4",
          content_type: "video/mp4",
          size_bytes: 100,
          sha256: null as any,
        },
        content: { title: "Done Video" },
        destination: { platform: "instagram_standalone", account_id: accId },
        schedule: { scheduled_at: new Date(Date.now() - 2000).toISOString(), timezone: "Asia/Kolkata" },
        publishing: { status: "READY", approved: true },
      }
    );

    // Manually mark as PUBLISHED
    await DB.prepare(
      "UPDATE cloudreel_publishing_jobs SET status = 'PUBLISHED', platform_post_id = 'existing_123' WHERE video_id = 'vid_already_done'"
    ).run();

    // Check discoverDueJobs ignores it
    const due = await discoverDueJobs(DB, 10);
    expect(due.find((j) => j.video_id === "vid_already_done")).toBeUndefined();

    // Attempt direct claim - must fail
    const target = await DB.prepare("SELECT job_id FROM cloudreel_publishing_jobs WHERE video_id = 'vid_already_done'").first<any>();
    const claim = await claimJobAtomic(DB, target.job_id, "worker-test");
    expect(claim).toBe(false);
  });

  // ---------------------------------------------------------------------------
  // SCENARIO 9: Expired worker lock recovery
  // ---------------------------------------------------------------------------
  it("Scenario 9: Expired worker lock recovery - crash recovery works seamlessly", async () => {
    const accId = "acc_lease_recovery";
    await createAccount(accId, "instagram_standalone", "RecoveryBrand");

    await ingestCloudReelManifest(
      DB,
      testWorkspaceId,
      {
        schema_version: 1,
        video_id: "vid_crashed_worker",
        created_at: new Date().toISOString(),
        video: {
          file_name: "crash.mp4",
          r2_bucket: "cloudreel",
          r2_key: "videos/crash.mp4",
          content_type: "video/mp4",
          size_bytes: 100,
          sha256: null as any,
        },
        content: { title: "Crashed Video" },
        destination: { platform: "instagram_standalone", account_id: accId },
        schedule: { scheduled_at: new Date(Date.now() - 10000).toISOString(), timezone: "Asia/Kolkata" },
        publishing: { status: "READY", approved: true },
      }
    );

    const job = await DB.prepare("SELECT job_id FROM cloudreel_publishing_jobs WHERE video_id = 'vid_crashed_worker'").first<any>();

    // Simulate worker-dead that crashed 10 minutes ago
    const pastEpoch = Date.now() - 600_000;
    await DB.prepare(
      "UPDATE cloudreel_publishing_jobs SET status = 'UPLOADING', locked_by = 'worker-dead', locked_until = ?, attempt_count = 1 WHERE job_id = ?"
    )
      .bind(pastEpoch, job.job_id)
      .run();

    // Now a healthy worker tries to claim the expired lease
    const recoveryClaim = await claimJobAtomic(DB, job.job_id, "worker-alive", 300_000, Date.now());
    expect(recoveryClaim).toBe(true);

    const refreshed = await DB.prepare("SELECT * FROM cloudreel_publishing_jobs WHERE job_id = ?").bind(job.job_id).first<any>();
    expect(refreshed.status).toBe("UPLOADING");
    expect(refreshed.locked_by).toBe("worker-alive");
    expect(refreshed.attempt_count).toBe(2); // Attempt incremented
    expect(refreshed.locked_until).toBeGreaterThan(Date.now());
  });

  // ---------------------------------------------------------------------------
  // SCENARIO 10: External platform timeout after uncertain publishing result
  // ---------------------------------------------------------------------------
  it("Scenario 10: External platform timeout after uncertain publishing result - halts and marks REVIEW_REQUIRED", async () => {
    const accId = "acc_timeout_test";
    await createAccount(accId, "instagram_standalone", "TimeoutBrand");

    const r2Key = "videos/timeout.mp4";
    await MEDIA.put(r2Key, dummyVideoBytes, { httpMetadata: { contentType: "video/mp4" } });

    await ingestCloudReelManifest(
      DB,
      testWorkspaceId,
      {
        schema_version: 1,
        video_id: "vid_timeout",
        created_at: new Date().toISOString(),
        video: {
          file_name: "timeout.mp4",
          r2_bucket: "cloudreel",
          r2_key: r2Key,
          content_type: "video/mp4",
          size_bytes: dummyVideoBytes.length,
          sha256: null as any,
        },
        content: { title: "Timeout Video" },
        destination: { platform: "instagram_standalone", account_id: accId },
        schedule: { scheduled_at: new Date(Date.now() - 500).toISOString(), timezone: "Asia/Kolkata" },
        publishing: { status: "READY", approved: true },
      }
    );

    // Mock provider throwing a network timeout error
    vi.spyOn(registry, "getProvider").mockReturnValue({
      id: "instagram_standalone",
      name: "Instagram",
      capabilities: () => ({ video: true }),
      publish: vi.fn().mockRejectedValue(new Error("Request timed out after 30000ms: 504 Gateway Timeout")),
    } as any);

    const result = await processDueCloudReelJobs(E);
    expect(result.reviewRequired).toBe(1);

    const job = await DB.prepare("SELECT * FROM cloudreel_publishing_jobs WHERE video_id = 'vid_timeout'").first<any>();
    // Must NOT blindly retry, must transition to REVIEW_REQUIRED
    expect(job.status).toBe("REVIEW_REQUIRED");
    expect(job.error_message).toContain("timed out");
    expect(job.locked_by).toBeNull();
  });

  // ---------------------------------------------------------------------------
  // SCENARIO 11: Disabled social account
  // ---------------------------------------------------------------------------
  it("Scenario 11: Disabled social account - rejected safely", async () => {
    const accId = "acc_disabled_brand";
    await createAccount(accId, "instagram_standalone", "DisabledBrand", "disabled");

    const verify = await verifyDestinationAccount(DB, accId, "instagram_standalone");
    expect(verify.ok).toBe(false);
    expect(verify.error).toContain("is not active");

    const r2Key = "videos/disabled_acc.mp4";
    await MEDIA.put(r2Key, dummyVideoBytes, { httpMetadata: { contentType: "video/mp4" } });

    await ingestCloudReelManifest(
      DB,
      testWorkspaceId,
      {
        schema_version: 1,
        video_id: "vid_disabled_account",
        created_at: new Date().toISOString(),
        video: {
          file_name: "disabled.mp4",
          r2_bucket: "cloudreel",
          r2_key: r2Key,
          content_type: "video/mp4",
          size_bytes: dummyVideoBytes.length,
          sha256: null as any,
        },
        content: { title: "Disabled Account Video" },
        destination: { platform: "instagram_standalone", account_id: accId },
        schedule: { scheduled_at: new Date(Date.now() - 500).toISOString(), timezone: "Asia/Kolkata" },
        publishing: { status: "READY", approved: true },
      }
    );

    const result = await processDueCloudReelJobs(E);
    expect(result.failed).toBe(1);

    const job = await DB.prepare("SELECT * FROM cloudreel_publishing_jobs WHERE video_id = 'vid_disabled_account'").first<any>();
    expect(job.status).toBe("FAILED");
    expect(job.error_message).toContain("is not active");
  });

  // ---------------------------------------------------------------------------
  // SCENARIO 12: Future scheduled publishing job
  // ---------------------------------------------------------------------------
  it("Scenario 12: Future scheduled publishing job - skipped until due timestamp", async () => {
    const accId = "acc_future_job";
    await createAccount(accId, "instagram_standalone", "FutureBrand");

    const futureTime = new Date(Date.now() + 3_600_000).toISOString(); // 1 hour in the future

    await ingestCloudReelManifest(
      DB,
      testWorkspaceId,
      {
        schema_version: 1,
        video_id: "vid_future",
        created_at: new Date().toISOString(),
        video: {
          file_name: "future.mp4",
          r2_bucket: "cloudreel",
          r2_key: "videos/future.mp4",
          content_type: "video/mp4",
          size_bytes: 100,
          sha256: null as any,
        },
        content: { title: "Future Video" },
        destination: { platform: "instagram_standalone", account_id: accId },
        schedule: { scheduled_at: futureTime, timezone: "Asia/Kolkata" },
        publishing: { status: "READY", approved: true },
      }
    );

    // Discover due jobs at current time
    const due = await discoverDueJobs(DB, 10, Date.now());
    expect(due.find((j) => j.video_id === "vid_future")).toBeUndefined();

    // Verify job remains in READY state in D1
    const job = await DB.prepare("SELECT * FROM cloudreel_publishing_jobs WHERE video_id = 'vid_future'").first<any>();
    expect(job.status).toBe("READY");
    expect(job.attempt_count).toBe(0);
    expect(job.locked_by).toBeNull();
  });

  // ---------------------------------------------------------------------------
  // OPENROUTER CONFIG TESTS
  // ---------------------------------------------------------------------------
  it("OpenRouter configuration management: saves key, returns masked DTO, and deletes cleanly", async () => {
    // 1. Initially unconfigured
    const initial = await getOpenRouterConfigDTO(DB);
    expect(initial.configured).toBe(false);
    expect(initial.maskedKey).toBeNull();

    // 2. Save configuration
    await saveOpenRouterConfig(DB, {
      apiKey: "sk-or-v1-abcdef1234567890abcdef1234567890",
      defaultModel: "anthropic/claude-3.5-sonnet",
    });

    const config = await getOpenRouterConfig(DB);
    expect(config).not.toBeNull();
    expect(config?.apiKey).toBe("sk-or-v1-abcdef1234567890abcdef1234567890");
    expect(config?.defaultModel).toBe("anthropic/claude-3.5-sonnet");

    // 3. Masked DTO check
    const dto = await getOpenRouterConfigDTO(DB);
    expect(dto.configured).toBe(true);
    expect(dto.defaultModel).toBe("anthropic/claude-3.5-sonnet");
    expect(dto.maskedKey).toContain("sk-or-v");
    expect(dto.maskedKey).toContain("7890");
    expect(dto.maskedKey).not.toContain("abcdef1234567890abcdef");

    // 4. Delete configuration
    await deleteOpenRouterConfig(DB);
    const afterDelete = await getOpenRouterConfigDTO(DB);
    expect(afterDelete.configured).toBe(false);
    expect(afterDelete.maskedKey).toBeNull();
  });

  it("OpenRouter custom model configuration: allows setting and updating any custom model slug", async () => {
    // Save with custom model
    await saveOpenRouterConfig(DB, {
      apiKey: "sk-or-v1-custom1234567890custom1234567890",
      defaultModel: "anthropic/claude-3.7-sonnet",
    });

    let config = await getOpenRouterConfig(DB);
    expect(config?.defaultModel).toBe("anthropic/claude-3.7-sonnet");

    // Update with another custom model (e.g. deepseek/deepseek-r1)
    await saveOpenRouterConfig(DB, {
      apiKey: "sk-or-v1-custom1234567890custom1234567890",
      defaultModel: "deepseek/deepseek-r1",
    });

    config = await getOpenRouterConfig(DB);
    expect(config?.defaultModel).toBe("deepseek/deepseek-r1");

    const dto = await getOpenRouterConfigDTO(DB);
    expect(dto.defaultModel).toBe("deepseek/deepseek-r1");
  });
});
