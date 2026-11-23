import { Hono } from "hono";
import { forbidInDemoWorkspace, requirePermission, wsId, type AppEnv } from "../lib/auth";
import {
  AccountElsewhereError,
  accountDto,
  findAccount,
  freshAccount,
  providerContext,
  refreshAvatars,
  removeAccounts,
  saveConnectedAccounts,
  type AccountRow,
} from "../lib/accounts";
import { PlanLimitError, enforce } from "../billing/entitlements";
import { decryptJson, encryptJson, pkceChallenge } from "../lib/crypto";
import { connectBlocked } from "../lib/settings";
import { demoOptions } from "../lib/demo";
import { errorMessage, now, parseJson, randomToken } from "../lib/util";
import { ProviderError } from "../providers/errors";
import { findGroup } from "./accountGroups";
import { getProvider } from "../providers/registry";

export const accountRoutes = new Hono<AppEnv>();

accountRoutes.get("/accounts", requirePermission("accounts.read"), async (c) => {
  const { results } = await c.env.DB.prepare("SELECT * FROM accounts WHERE workspace_id = ? ORDER BY provider, name")
    .bind(wsId(c))
    .all<AccountRow>();
  return c.json(results.map(accountDto));
});

/** `{ status?: "active" | "disabled", groupId?: string | null, name?: string, tag?: string, username?: string, apiKey?: string }` */
accountRoutes.patch("/accounts/:id", requirePermission("accounts.manage"), async (c) => {
  const input = (await c.req.json<{
    status?: unknown;
    groupId?: unknown;
    name?: unknown;
    tag?: unknown;
    username?: unknown;
    apiKey?: unknown;
  }>().catch(() => null)) ?? {};

  const { status, groupId } = input;
  const hasStatus = "status" in input;
  const hasGroup = "groupId" in input;
  const hasName = "name" in input;
  const hasTag = "tag" in input || "username" in input;
  const hasApiKey = "apiKey" in input;

  if (!hasStatus && !hasGroup && !hasName && !hasTag && !hasApiKey) {
    return c.json({ error: "Nothing to change (status, groupId, name, tag, or apiKey)" }, 400);
  }

  if (hasStatus && status !== "active" && status !== "disabled") {
    return c.json({ error: "Invalid status" }, 400);
  }

  if (hasGroup && groupId !== null && typeof groupId !== "string") {
    return c.json({ error: "groupId must be a group id or null" }, 400);
  }

  const trimmedName = typeof input.name === "string" ? input.name.trim() : null;
  if (hasName && (!trimmedName || trimmedName.length > 200)) {
    return c.json({ error: "Invalid name" }, 400);
  }

  const rawTag = input.tag !== undefined ? input.tag : input.username;
  const trimmedTag = typeof rawTag === "string" ? rawTag.trim() : null;
  if (hasTag && (!trimmedTag || trimmedTag.length > 100)) {
    return c.json({ error: "Invalid tag/username" }, 400);
  }

  const trimmedApiKey = typeof input.apiKey === "string" ? input.apiKey.trim() : null;
  if (hasApiKey && !trimmedApiKey) {
    return c.json({ error: "Invalid API key" }, 400);
  }

  const ws = wsId(c);
  if (typeof groupId === "string" && !(await findGroup(c.env.DB, ws, groupId))) {
    return c.json({ error: "Group not found" }, 404);
  }

  const current = await findAccount(c.env, ws, c.req.param("id"));
  if (!current) return c.json({ error: "Not found" }, 404);

  // Re-enabling a disabled account counts against the plan's account limit again.
  if (status === "active" && current.status === "disabled") {
    await enforce(c, { accounts: 1 });
  }

  const sets: string[] = [];
  const binds: unknown[] = [];

  if (hasStatus) {
    sets.push("status = ?");
    binds.push(status);
  }

  if (hasGroup) {
    sets.push("group_id = ?");
    binds.push(groupId);
  }

  if (hasName && trimmedName) {
    sets.push("name = ?");
    binds.push(trimmedName);
  }

  // Handle meta updates
  let metaObj = parseJson<Record<string, unknown>>(current.meta, {});
  delete metaObj.apiKey; // ensure no secret in meta
  delete metaObj.accessToken;
  delete metaObj.token;
  delete metaObj.secret;
  let metaChanged = current.meta.includes('"apiKey"') || current.meta.includes('"accessToken"');

  if (hasTag && trimmedTag) {
    sets.push("username = ?");
    binds.push(trimmedTag);
    metaObj.tag = trimmedTag;
    metaChanged = true;

    // Buffer external_id synchronization & tag/external_id collision check
    if (current.provider === "buffer") {
      let newExternalId = trimmedTag;
      if (typeof metaObj.channelId === "string" && metaObj.channelId) {
        newExternalId = `${trimmedTag}:${metaObj.channelId}`;
      } else if (current.external_id.includes(":")) {
        const [, channelId] = current.external_id.split(":");
        newExternalId = `${trimmedTag}:${channelId}`;
      }

      if (newExternalId !== current.external_id || trimmedTag !== current.username) {
        const conflict = await c.env.DB.prepare(
          "SELECT id FROM accounts WHERE provider = 'buffer' AND (external_id = ? OR (workspace_id = ? AND username = ?)) AND id != ?",
        )
          .bind(newExternalId, ws, trimmedTag, current.id)
          .first<{ id: string }>();
        if (conflict) {
          return c.json({ error: "An account with this tag already exists" }, 409);
        }
        if (newExternalId !== current.external_id) {
          sets.push("external_id = ?");
          binds.push(newExternalId);
        }
      }
    }
  }

  if (metaChanged) {
    sets.push("meta = ?");
    binds.push(JSON.stringify(metaObj));
  }

  // Handle credentials update (apiKey and/or tag)
  if ((hasApiKey && trimmedApiKey) || (hasTag && trimmedTag)) {
    const creds = await decryptJson<Record<string, unknown>>(c.env, current.credentials_enc);
    if (hasApiKey && trimmedApiKey) {
      creds.apiKey = trimmedApiKey;
      if (creds.accessToken !== undefined) creds.accessToken = trimmedApiKey;
    }
    if (hasTag && trimmedTag) {
      creds.tag = trimmedTag;
    }
    const newEnc = await encryptJson(c.env, creds);
    sets.push("credentials_enc = ?");
    binds.push(newEnc);

    if (hasApiKey && trimmedApiKey) {
      if (!hasStatus && current.status === "reconnect") {
        sets.push("status = 'active'");
        sets.push("status_message = NULL");
      }
      sets.push("reconnected_at = ?");
      binds.push(now());
    }
  }

  sets.push("updated_at = ?");
  binds.push(now());

  await c.env.DB.prepare(
    `UPDATE accounts SET ${sets.join(", ")} WHERE id = ? AND workspace_id = ?`,
  )
    .bind(...binds, current.id, ws)
    .run();

  const row = await findAccount(c.env, ws, current.id);
  return row ? c.json(accountDto(row)) : c.json({ error: "Not found" }, 404);
});

accountRoutes.delete("/accounts/:id", requirePermission("accounts.manage"), async (c) => {
  const row = await findAccount(c.env, wsId(c), c.req.param("id"));
  if (!row) return c.json({ error: "Not found" }, 404);
  await removeAccounts(c.env, [row.id]);
  return c.json({ ok: true });
});

/** Force a token refresh (also a quick "is this account still working" check), then re-copy the avatar. */
accountRoutes.post("/accounts/:id/refresh", requirePermission("accounts.manage"), async (c) => {
  const row = await findAccount(c.env, wsId(c), c.req.param("id"));
  const provider = row && getProvider(row.provider);
  if (!row || !provider) return c.json({ error: "Not found" }, 404);
  // Demo workspace: the tokens are fake, there is nothing to refresh.
  if (c.var.workspace?.demo) return c.json(accountDto(row));
  if (provider.refresh) {
    try {
      const ctx = await providerContext(c.env, provider, { requestUrl: c.req.url });
      await freshAccount(c.env, provider, ctx, row, { force: true });
    } catch (err) {
      return c.json({ error: errorMessage(err) }, 400);
    }
  }
  const fresh = (await findAccount(c.env, wsId(c), row.id))!;
  if (provider.profile || fresh.avatar_url) {
    await refreshAvatars(c.env, { rows: [fresh] });
    return c.json(accountDto((await findAccount(c.env, wsId(c), row.id)) ?? fresh));
  }
  return c.json(accountDto(fresh));
});

/** GET /api/accounts/:id/composer-info: what the platform says about posting right now (TikTok creator_info). */
accountRoutes.get("/accounts/:id/composer-info", requirePermission("posts.write"), async (c) => {
  const row = await findAccount(c.env, wsId(c), c.req.param("id"));
  const provider = row && getProvider(row.provider);
  if (!row || !provider) return c.json({ error: "Not found" }, 404);
  if (!provider.composerInfo || c.var.workspace?.demo) return c.json({});
  try {
    const ctx = await providerContext(c.env, provider, { requestUrl: c.req.url });
    const account = await freshAccount(c.env, provider, ctx, row);
    return c.json(await provider.composerInfo(ctx, account));
  } catch (err) {
    return c.json({ error: errorMessage(err) }, err instanceof ProviderError && err.kind === "auth" ? 409 : 400);
  }
});

// Used by the composer to fill dynamic settings fields (boards, channels...), so it needs posts.write.
accountRoutes.get("/accounts/:id/options/:key", requirePermission("posts.write"), async (c) => {
  const row = await findAccount(c.env, wsId(c), c.req.param("id"));
  const provider = row && getProvider(row.provider);
  if (!row || !provider) return c.json({ error: "Not found" }, 404);
  if (!provider.options) return c.json([]);
  // Demo workspace: a small fake list instead of asking the platform.
  if (c.var.workspace?.demo) return c.json(demoOptions(provider.id, c.req.param("key")));
  try {
    const ctx = await providerContext(c.env, provider, { requestUrl: c.req.url });
    const account = await freshAccount(c.env, provider, ctx, row);
    const settings = parseJson<Record<string, unknown>>(c.req.query("settings"), {});
    return c.json(await provider.options(ctx, account, c.req.param("key"), settings));
  } catch (err) {
    return c.json({ error: errorMessage(err) }, err instanceof ProviderError && err.kind === "auth" ? 409 : 400);
  }
});

/** Connect with credentials (app passwords, bot tokens, API keys). */
accountRoutes.post("/connect/:provider", requirePermission("accounts.manage"), forbidInDemoWorkspace("Connecting accounts"), async (c) => {
  const provider = getProvider(c.req.param("provider"));
  if (!provider?.connect) return c.json({ error: "This platform connects with OAuth" }, 400);
  const blocked = await connectBlocked(c.env.DB, provider, c.var.workspace?.allowedProviders);
  if (blocked) return c.json({ error: blocked }, 403);
  const { values } = await c.req.json<{ values: Record<string, string> }>();
  for (const f of provider.credentialFields) {
    if (f.required && !values?.[f.key]?.trim()) return c.json({ error: `${f.label} is required` }, 400);
  }
  try {
    const ctx = await providerContext(c.env, provider, { requestUrl: c.req.url });
    const accounts = await provider.connect(ctx, values);
    const ids = await saveConnectedAccounts(c.env, provider.id, accounts, { workspaceId: wsId(c), userId: c.var.user.id }, (adding) => enforce(c, { accounts: adding }));
    return c.json({ ids });
  } catch (err) {
    if (err instanceof PlanLimitError) throw err;
    return c.json({ error: errorMessage(err) }, err instanceof AccountElsewhereError ? 409 : 400);
  }
});

/** Sync channels for a Buffer account tag using saved credentials. */
accountRoutes.post("/accounts/buffer/sync", requirePermission("accounts.manage"), forbidInDemoWorkspace("Connecting accounts"), async (c) => {
  const { tag, accountId } = await c.req.json<{ tag?: string; accountId?: string }>().catch(() => ({ tag: undefined, accountId: undefined }));
  const ws = wsId(c);
  let row: AccountRow | null = null;
  if (accountId) {
    row = await findAccount(c.env, ws, accountId);
  } else if (tag) {
    const normalizedTag = tag.trim().replace(/^#/, "");
    row = await c.env.DB.prepare(
      "SELECT * FROM accounts WHERE provider = 'buffer' AND workspace_id = ? AND (username = ? OR json_extract(meta, '$.tag') = ?) LIMIT 1",
    )
      .bind(ws, normalizedTag, normalizedTag)
      .first<AccountRow>();
  } else {
    // If neither is provided, find any connected Buffer account for this workspace
    row = await c.env.DB.prepare(
      "SELECT * FROM accounts WHERE provider = 'buffer' AND workspace_id = ? LIMIT 1",
    )
      .bind(ws)
      .first<AccountRow>();
  }
  if (!row) return c.json({ error: "Buffer account not found" }, 404);
  const provider = getProvider("buffer");
  if (!provider?.connect) return c.json({ error: "Buffer provider unavailable" }, 500);

  const creds = await decryptJson<{ apiKey?: string; tag?: string }>(c.env, row.credentials_enc);
  if (!creds?.apiKey) return c.json({ error: "API key missing in credentials" }, 400);
  const accountTag = creds.tag || row.username || tag || "Buffer";

  try {
    const ctx = await providerContext(c.env, provider, { requestUrl: c.req.url });
    const accounts = await provider.connect(ctx, { apiKey: creds.apiKey, tag: accountTag });
    const ids = await saveConnectedAccounts(c.env, "buffer", accounts, { workspaceId: ws, userId: c.var.user.id }, (adding) => enforce(c, { accounts: adding }));
    const { results } = await c.env.DB.prepare(
      "SELECT * FROM accounts WHERE workspace_id = ? AND provider = 'buffer' AND (username = ? OR json_extract(meta, '$.tag') = ?)",
    )
      .bind(ws, accountTag, accountTag)
      .all<AccountRow>();
    return c.json({ ok: true, ids, accounts: results.map(accountDto) });
  } catch (err) {
    if (err instanceof PlanLimitError) throw err;
    return c.json({ error: errorMessage(err) }, err instanceof AccountElsewhereError ? 409 : 400);
  }
});

/**
 * Start an OAuth flow: returns the platform authorization URL. `?switchAccount=1` asks the platform to show its login
 * again so another account can be picked (only providers with `switchAccount`; ignored by the others).
 */
accountRoutes.get("/connect/:provider/url", requirePermission("accounts.manage"), forbidInDemoWorkspace("Connecting accounts"), async (c) => {
  const provider = getProvider(c.req.param("provider"));
  if (!provider?.authorize) return c.json({ error: "This platform connects with credentials" }, 400);
  const blocked = await connectBlocked(c.env.DB, provider, c.var.workspace?.allowedProviders);
  if (blocked) return c.json({ error: blocked }, 403);
  try {
    const ctx = await providerContext(c.env, provider, { requestUrl: c.req.url });
    const state = randomToken(24);
    const codeVerifier = randomToken(48);
    const switchAccount = !!provider.switchAccount && ["1", "true"].includes(c.req.query("switchAccount") ?? "");
    const url = await provider.authorize(ctx, { state, codeVerifier, codeChallenge: await pkceChallenge(codeVerifier), switchAccount });
    // The callback saves into this workspace, and only for this user.
    await c.env.DB.prepare(
      "INSERT INTO oauth_states (state, provider, code_verifier, user_id, workspace_id, created_at) VALUES (?, ?, ?, ?, ?, ?)",
    )
      .bind(state, provider.id, codeVerifier, c.var.user.id, wsId(c), now())
      .run();
    return c.json({ url });
  } catch (err) {
    return c.json({ error: errorMessage(err) }, 400);
  }
});
