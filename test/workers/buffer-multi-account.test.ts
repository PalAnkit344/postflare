import { env } from "cloudflare:test";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { decryptJson } from "../../worker/lib/crypto";
import { makeCall } from "./app-helpers";
import type { AccountDTO } from "../../shared/types";

const workflowStub = {
  create: async ({ id }: { id: string }) => ({ id }),
  createBatch: async (list: Array<{ id: string }>) => list.map(({ id }) => ({ id })),
  get: async (id: string) => ({ id, status: async () => ({ status: "waiting" }), terminate: async () => {} }),
};

const E = {
  ...env,
  DB: env.DB,
  PUBLISH_WORKFLOW: workflowStub,
  DEMO_MODE: "false",
  PUBLIC_URL: "https://pf.test",
  MEDIA_PUBLIC_URL: undefined,
} as unknown as Env;

const call = makeCall(E);
let owner: { cookie: string };

function mockBufferApi(opts: { emptyChannels?: boolean } = {}) {
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
    const req = new Request(input, init);
    const url = req.url;

    if (url.includes("avatar") || url.includes(".png") || url.includes(".jpg")) {
      return new Response(new Uint8Array([137, 80, 78, 71]), {
        headers: { "content-type": "image/png" },
      });
    }

    if (url.startsWith("https://api.buffer.com")) {
      let body: any = null;
      try {
        body = await req.clone().json();
      } catch {}

      const authHeader = req.headers.get("authorization") || "";
      const query = String(body?.query ?? "");

      if (query.includes("GetAccountAndChannels")) {
        const keySlug = authHeader.replace(/[^a-zA-Z0-9]/g, "_").slice(-16) || "default";
        return Response.json({
          data: {
            account: {
              id: `buf_acc_${keySlug}`,
              name: `Buffer User ${keySlug}`,
              organizations: [
                {
                  id: `org_${keySlug}`,
                  name: `Buffer Org ${keySlug}`,
                  channels: opts.emptyChannels
                    ? []
                    : [
                        {
                          id: `ch_${keySlug}`,
                          name: `Channel ${keySlug}`,
                          displayName: `Channel ${keySlug}`,
                          service: "instagram",
                          serviceId: `srv_${keySlug}`,
                          avatar: "https://buffer.test/avatar.png",
                        },
                      ],
                },
              ],
            },
          },
        });
      }
    }

    return new Response("Not found", { status: 404 });
  });
}

beforeAll(async () => {
  const setup = await call(null, "/api/auth/setup", {
    body: {
      name: "Buffer Multi Admin",
      email: "buffer_multi_m2@example.com",
      password: "password123",
      workspaceName: "Buffer Multi Corp",
    },
  });
  expect(setup.status).toBe(200);
  owner = { cookie: setup.cookie! };
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("Buffer Multi-Account Management & Security (Milestone 2)", () => {
  const TOTAL_ACCOUNTS = 52;
  const connectedAccountIds: string[] = [];
  const tags: string[] = [];
  const apiKeys: string[] = [];

  it("1. adds 50+ distinct Buffer accounts with unique tags and keys", async () => {
    mockBufferApi();

    for (let i = 1; i <= TOTAL_ACCOUNTS; i++) {
      const tag = `brand-acct-${String(i).padStart(3, "0")}`;
      const apiKey = `buf_sec_token_${String(i).padStart(3, "0")}_xyz`;
      tags.push(tag);
      apiKeys.push(apiKey);

      const res = await call(owner, "/api/connect/buffer", {
        body: { values: { apiKey, tag } },
      });

      expect(res.status, `Failed connecting account ${tag}: ${res.text}`).toBe(200);
      expect(res.json.ids).toBeDefined();
      expect(res.json.ids.length).toBe(1);
      connectedAccountIds.push(res.json.ids[0]);
    }

    expect(connectedAccountIds.length).toBe(TOTAL_ACCOUNTS);
    const uniqueIds = new Set(connectedAccountIds);
    expect(uniqueIds.size).toBe(TOTAL_ACCOUNTS);
  });

  it("2. retrieves all 50+ accounts collision-free via GET /api/accounts", async () => {
    const res = await call(owner, "/api/accounts");
    expect(res.status).toBe(200);

    const accounts = res.json as AccountDTO[];
    const bufferAccounts = accounts.filter((a) => a.provider === "buffer");

    expect(bufferAccounts.length).toBe(TOTAL_ACCOUNTS);

    // Verify all unique tags and usernames are preserved
    for (let i = 0; i < TOTAL_ACCOUNTS; i++) {
      const expectedTag = tags[i];
      const match = bufferAccounts.find((a) => a.username === expectedTag);
      expect(match).toBeDefined();
      expect(match?.tag).toBe(expectedTag);
      expect(match?.status).toBe("active");
    }
  });

  it("3. verifies credentials encrypted at rest with AES-GCM (v1.<iv>.<ct>) and zero plaintext leakage", async () => {
    const { results } = await E.DB.prepare(
      "SELECT id, username, credentials_enc, meta FROM accounts WHERE provider = 'buffer'",
    ).all<{ id: string; username: string; credentials_enc: string; meta: string }>();

    expect(results.length).toBe(TOTAL_ACCOUNTS);

    for (const row of results) {
      // Must follow AES-GCM versioned ciphertext format: v1.<iv>.<ct>
      expect(row.credentials_enc).toMatch(/^v1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);

      // Must NEVER contain plaintext secret token
      for (const key of apiKeys) {
        expect(row.credentials_enc).not.toContain(key);
        expect(row.meta).not.toContain(key);
      }

      // Must NOT leak apiKey in D1 meta JSON column
      const meta = JSON.parse(row.meta);
      expect(meta.apiKey).toBeUndefined();
      expect(meta.accessToken).toBeUndefined();
      expect(meta.token).toBeUndefined();
      expect(meta.secret).toBeUndefined();

      // Decrypt credentials using AES-GCM app key and verify authenticity
      const creds = await decryptJson<{ apiKey: string; tag: string }>(E, row.credentials_enc);
      expect(creds.tag).toBe(row.username);
      expect(creds.apiKey).toBeDefined();
      expect(creds.apiKey).toMatch(/^buf_sec_token_\d{3}_xyz$/);
    }
  });

  it("4. guarantees zero credential leakage in GET /api/accounts DTOs", async () => {
    const res = await call(owner, "/api/accounts");
    expect(res.status).toBe(200);

    const bufferAccounts = (res.json as AccountDTO[]).filter((a) => a.provider === "buffer");

    for (const acc of bufferAccounts) {
      expect((acc as any).credentials).toBeUndefined();
      expect((acc as any).credentials_enc).toBeUndefined();
      expect((acc as any).apiKey).toBeUndefined();
      expect((acc as any).accessToken).toBeUndefined();
      if (acc.meta) {
        expect((acc.meta as any).apiKey).toBeUndefined();
        expect((acc.meta as any).accessToken).toBeUndefined();
      }
      expect(acc.tag).toBeDefined();
      expect(acc.tag).toBe(acc.username);
    }
  });

  it("5. verifies fallback connect without channels does NOT leak apiKey in D1 meta (bugfix check)", async () => {
    mockBufferApi({ emptyChannels: true });

    const fallbackTag = "brand-fallback-empty-channels";
    const fallbackApiKey = "buf_fallback_secret_no_leak_999";

    const res = await call(owner, "/api/connect/buffer", {
      body: { values: { apiKey: fallbackApiKey, tag: fallbackTag } },
    });
    expect(res.status).toBe(200);
    const fallbackAccountId = res.json.ids[0];

    const row = await E.DB.prepare(
      "SELECT id, username, credentials_enc, meta FROM accounts WHERE id = ?",
    )
      .bind(fallbackAccountId)
      .first<{ id: string; username: string; credentials_enc: string; meta: string }>();

    expect(row).not.toBeNull();
    expect(row!.meta).not.toContain(fallbackApiKey);
    const meta = JSON.parse(row!.meta);
    expect(meta.apiKey).toBeUndefined();
    expect(meta.tag).toBe(fallbackTag);

    // Clean up
    await call(owner, `/api/accounts/${fallbackAccountId}`, { method: "DELETE" });
  });

  it("6. updates account tag, name, and rotates API key via PATCH /api/accounts/:id", async () => {
    const targetId = connectedAccountIds[0];
    const initialRow = await E.DB.prepare(
      "SELECT credentials_enc FROM accounts WHERE id = ?",
    )
      .bind(targetId)
      .first<{ credentials_enc: string }>();
    const oldEnc = initialRow!.credentials_enc;

    const rotatedKey = "buf_rotated_token_super_secret_42";
    const newTag = "brand-acct-001-renamed";
    const newName = "Alpha Brand Global";

    const patchRes = await call(owner, `/api/accounts/${targetId}`, {
      method: "PATCH",
      body: {
        name: newName,
        tag: newTag,
        apiKey: rotatedKey,
      },
    });

    expect(patchRes.status).toBe(200);
    expect(patchRes.json.id).toBe(targetId);
    expect(patchRes.json.name).toBe(newName);
    expect(patchRes.json.username).toBe(newTag);
    expect(patchRes.json.tag).toBe(newTag);
    expect(patchRes.json.apiKey).toBeUndefined();

    // Verify D1 state: credentials_enc must be re-encrypted with fresh ciphertext
    const updatedRow = await E.DB.prepare(
      "SELECT name, username, credentials_enc, meta, external_id FROM accounts WHERE id = ?",
    )
      .bind(targetId)
      .first<{ name: string; username: string; credentials_enc: string; meta: string; external_id: string }>();

    expect(updatedRow!.name).toBe(newName);
    expect(updatedRow!.username).toBe(newTag);
    expect(updatedRow!.credentials_enc).not.toBe(oldEnc);
    expect(updatedRow!.credentials_enc).toMatch(/^v1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
    expect(updatedRow!.meta).not.toContain(rotatedKey);

    // Verify external_id was synchronized with new tag
    expect(updatedRow!.external_id).toContain(newTag);

    // Verify decrypted credentials contain rotated key and new tag
    const decrypted = await decryptJson<{ apiKey: string; tag: string }>(E, updatedRow!.credentials_enc);
    expect(decrypted.apiKey).toBe(rotatedKey);
    expect(decrypted.tag).toBe(newTag);
  });

  it("7. updates name and tag without passing apiKey, preserving existing key", async () => {
    const targetId = connectedAccountIds[1];
    const rowBefore = await E.DB.prepare(
      "SELECT credentials_enc FROM accounts WHERE id = ?",
    )
      .bind(targetId)
      .first<{ credentials_enc: string }>();
    const credsBefore = await decryptJson<{ apiKey: string; tag: string }>(E, rowBefore!.credentials_enc);

    const updatedTag = "brand-acct-002-v2";
    const updatedName = "Brand Beta 2.0";

    const patchRes = await call(owner, `/api/accounts/${targetId}`, {
      method: "PATCH",
      body: {
        name: updatedName,
        tag: updatedTag,
      },
    });

    expect(patchRes.status).toBe(200);
    expect(patchRes.json.name).toBe(updatedName);
    expect(patchRes.json.username).toBe(updatedTag);

    const rowAfter = await E.DB.prepare(
      "SELECT credentials_enc FROM accounts WHERE id = ?",
    )
      .bind(targetId)
      .first<{ credentials_enc: string }>();

    const credsAfter = await decryptJson<{ apiKey: string; tag: string }>(E, rowAfter!.credentials_enc);
    expect(credsAfter.apiKey).toBe(credsBefore.apiKey); // Key must be preserved
    expect(credsAfter.tag).toBe(updatedTag); // Tag updated in creds
  });

  it("8. resetting apiKey when status is 'reconnect' resets status to 'active' and updates reconnected_at", async () => {
    const targetId = connectedAccountIds[2];

    // Put account in 'reconnect' status with error message
    await E.DB.prepare(
      "UPDATE accounts SET status = 'reconnect', status_message = 'Access token expired or revoked' WHERE id = ?",
    )
      .bind(targetId)
      .run();

    const checkBefore = await call(owner, "/api/accounts");
    const accBefore = (checkBefore.json as AccountDTO[]).find((a) => a.id === targetId);
    expect(accBefore?.status).toBe("reconnect");
    expect(accBefore?.statusMessage).toBe("Access token expired or revoked");

    // Provide new apiKey
    const patchRes = await call(owner, `/api/accounts/${targetId}`, {
      method: "PATCH",
      body: {
        apiKey: "buf_renewed_token_active_now",
      },
    });

    expect(patchRes.status).toBe(200);
    expect(patchRes.json.status).toBe("active");
    expect(patchRes.json.statusMessage).toBeNull();
    expect(patchRes.json.reconnectedAt).toBeGreaterThan(0);

    const rowInDb = await E.DB.prepare(
      "SELECT status, status_message, reconnected_at FROM accounts WHERE id = ?",
    )
      .bind(targetId)
      .first<{ status: string; status_message: string | null; reconnected_at: number }>();

    expect(rowInDb!.status).toBe("active");
    expect(rowInDb!.status_message).toBeNull();
    expect(rowInDb!.reconnected_at).toBeGreaterThan(0);
  });

  it("9. rejects tag collision with 409 Conflict", async () => {
    // Try updating account 3's tag to match account 4's tag
    const sourceAcc = connectedAccountIds[3];
    const targetAcc = connectedAccountIds[4];

    const targetRow = await E.DB.prepare(
      "SELECT username FROM accounts WHERE id = ?",
    )
      .bind(targetAcc)
      .first<{ username: string }>();

    const patchRes = await call(owner, `/api/accounts/${sourceAcc}`, {
      method: "PATCH",
      body: {
        tag: targetRow!.username,
      },
    });

    expect(patchRes.status).toBe(409);
    expect(patchRes.json.error).toMatch(/already exists/i);
  });

  it("10. validates inputs and handles error conditions (400, 404)", async () => {
    const targetId = connectedAccountIds[5];

    // Empty body -> 400
    const emptyRes = await call(owner, `/api/accounts/${targetId}`, {
      method: "PATCH",
      body: {},
    });
    expect(emptyRes.status).toBe(400);

    // Invalid status -> 400
    const invalidStatus = await call(owner, `/api/accounts/${targetId}`, {
      method: "PATCH",
      body: { status: "unknown_status" },
    });
    expect(invalidStatus.status).toBe(400);

    // Empty/blank name -> 400
    const blankName = await call(owner, `/api/accounts/${targetId}`, {
      method: "PATCH",
      body: { name: "   " },
    });
    expect(blankName.status).toBe(400);

    // Empty/blank tag -> 400
    const blankTag = await call(owner, `/api/accounts/${targetId}`, {
      method: "PATCH",
      body: { tag: "   " },
    });
    expect(blankTag.status).toBe(400);

    // Empty/blank apiKey -> 400
    const blankKey = await call(owner, `/api/accounts/${targetId}`, {
      method: "PATCH",
      body: { apiKey: "   " },
    });
    expect(blankKey.status).toBe(400);

    // Non-existent account -> 404
    const notFound = await call(owner, "/api/accounts/acc_nonexistent_xyz", {
      method: "PATCH",
      body: { name: "New Name" },
    });
    expect(notFound.status).toBe(404);
  });

  it("11. removes accounts via DELETE /api/accounts/:id", async () => {
    const deleteId = connectedAccountIds[10];

    const delRes = await call(owner, `/api/accounts/${deleteId}`, {
      method: "DELETE",
    });
    expect(delRes.status).toBe(200);
    expect(delRes.json).toEqual({ ok: true });

    // Verify completely deleted from D1
    const checkRow = await E.DB.prepare(
      "SELECT id FROM accounts WHERE id = ?",
    )
      .bind(deleteId)
      .first();
    expect(checkRow).toBeNull();

    // Verify not returned in accounts list
    const listRes = await call(owner, "/api/accounts");
    const found = (listRes.json as AccountDTO[]).find((a) => a.id === deleteId);
    expect(found).toBeUndefined();

    // Deleting again returns 404
    const delAgain = await call(owner, `/api/accounts/${deleteId}`, {
      method: "DELETE",
    });
    expect(delAgain.status).toBe(404);
  });
});
