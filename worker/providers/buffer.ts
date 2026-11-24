import { ProviderError } from "./errors";
import { checkedCommit, requestJson, type RequestOptions } from "./http";
import type { AccountRecord, ConnectedAccount, Provider, ProviderContext, PublishPost, PublishResult } from "./types";

const BUFFER_GRAPHQL_API = "https://api.buffer.com";
const BUFFER_REST_API = "https://api.bufferapp.com/1";

interface BufferGraphQLResponse<T = any> {
  data?: T;
  errors?: Array<{ message: string; extensions?: Record<string, unknown> }>;
}

interface BufferChannel {
  id: string;
  name: string;
  displayName?: string | null;
  service?: string | null;
  serviceId?: string | null;
  avatar?: string | null;
  organizationId?: string | null;
  isDisconnected?: boolean | null;
  isLocked?: boolean | null;
  isQueuePaused?: boolean | null;
  externalLink?: string | null;
}

interface BufferOrganization {
  id: string;
  name?: string;
  channels?: BufferChannel[];
}

interface BufferAccountQueryData {
  account?: {
    id: string;
    email?: string;
    name?: string;
    organizations?: BufferOrganization[];
  };
  channels?: BufferChannel[];
}

interface BufferChannelsQueryData {
  channels?: BufferChannel[];
}

interface BufferCreatePostData {
  createPost?: {
    __typename?: string;
    post?: {
      id: string;
      status?: string;
      dueAt?: string | null;
    };
    message?: string;
  };
}

interface BufferPostStatusData {
  post?: {
    id: string;
    status: string;
    dueAt?: string | null;
    sentAt?: string | null;
  };
}

function kindForGraphQLError(errors?: Array<{ message: string; extensions?: Record<string, unknown> }>): "auth" | "rate_limit" | undefined {
  if (!errors?.length) return undefined;
  for (const err of errors) {
    const code = String(err.extensions?.code ?? "").toUpperCase();
    if (code === "UNAUTHENTICATED" || code === "FORBIDDEN") return "auth";
    if (code === "TOO_MANY_REQUESTS" || code === "RATE_LIMIT_EXCEEDED") return "rate_limit";
    if (/unauthorized|invalid token|access token|authentication|unauthenticated/i.test(err.message)) return "auth";
  }
  return undefined;
}

async function bufferGraphql<T = any>(
  ctx: ProviderContext,
  apiKey: string,
  query: string,
  variables?: Record<string, unknown>,
  opts: RequestOptions = {},
): Promise<T> {
  const classify: RequestOptions["classify"] = (status, body) => {
    if (status === 401 || status === 403) return "auth";
    if (status === 429) return "rate_limit";
    const graphKind = kindForGraphQLError(body?.errors);
    if (graphKind) return graphKind;
    const msg = String(body?.message || "");
    if (/unauthorized|invalid token|access token|authentication/i.test(msg)) return "auth";
    return undefined;
  };

  const res = await requestJson<BufferGraphQLResponse<T>>(ctx, BUFFER_GRAPHQL_API, {
    ...opts,
    method: "POST",
    token: apiKey,
    json: { query, variables },
    classify,
  });

  if (res?.errors?.length) {
    if (opts.commit && ctx.commit) ctx.commit.accepted = false;
    const msg = res.errors.map((e) => e.message).join("; ");
    const kind = kindForGraphQLError(res.errors) ?? (/unauthorized|invalid token|access token|authentication/i.test(msg) ? "auth" : "invalid");
    throw new ProviderError(`Buffer: ${msg}`, kind, undefined, res);
  }

  return res?.data as T;
}

async function bufferRest<T = any>(
  ctx: ProviderContext,
  apiKey: string,
  path: string,
  opts: RequestOptions = {},
): Promise<T> {
  const classify: RequestOptions["classify"] = (status, body) => {
    if (status === 401 || status === 403) return "auth";
    if (status === 429) return "rate_limit";
    const msg = String(body?.message || body?.error || "");
    if (/unauthorized|invalid token|access token|authentication/i.test(msg)) return "auth";
    return undefined;
  };

  const res = await requestJson<T>(ctx, `${BUFFER_REST_API}${path}`, {
    ...opts,
    token: apiKey,
    classify,
  });

  if (opts.commit && ctx.commit && ((res as any)?.success === false || (res as any)?.error)) {
    ctx.commit.accepted = false;
    const msg = (res as any)?.message || (res as any)?.error || "REST request failed";
    throw new ProviderError(`Buffer: ${msg}`, "invalid", undefined, res);
  }

  return res;
}

const GET_ACCOUNT_ORGANIZATIONS_QUERY = `
query GetAccountAndOrganizations # GetAccountAndChannels
{
  account {
    id
    email
    name
    organizations {
      id
      name
    }
  }
}
`;

const GET_CHANNELS_QUERY = `
query GetChannels($input: ChannelsInput!) {
  channels(input: $input) {
    id
    name
    displayName
    service
    serviceId
    avatar
    isDisconnected
    isLocked
    isQueuePaused
    externalLink
  }
}
`;

const CREATE_POST_MUTATION = `
mutation CreatePost($input: CreatePostInput!) {
  createPost(input: $input) {
    __typename
    ... on PostActionSuccess {
      post {
        id
        status
        dueAt
      }
    }
    ... on NotFoundError {
      message
    }
    ... on UnauthorizedError {
      message
    }
    ... on UnexpectedError {
      message
    }
    ... on RestProxyError {
      message
    }
    ... on LimitReachedError {
      message
    }
    ... on InvalidInputError {
      message
    }
  }
}
`;

const GET_POST_STATUS_QUERY = `
query GetPostStatus($id: ID!) {
  post(input: { id: $id }) {
    id
    status
    dueAt
    sentAt
  }
}
`;

export const buffer: Provider = {
  id: "buffer",
  name: "Buffer",
  color: "231F20",
  icon: "buffer",
  category: "social",
  auth: "credentials",
  status: "beta",
  hotlinksMedia: true,
  docsUrl: "https://developers.buffer.com",
  setupNotes:
    "Generate an API key on Buffer under **Settings → API** (or Personal Access Tokens) and provide an **Account Tag** to uniquely identify this account in Postflare.",
  appFields: [],
  credentialFields: [
    {
      key: "apiKey",
      label: "API Key / Access Token",
      type: "password",
      required: true,
      placeholder: "Paste Buffer API token or key...",
      help: "Personal Access Token or API Key from Buffer (Settings > API).",
    },
    {
      key: "tag",
      label: "Account Tag / Identifier",
      type: "text",
      required: true,
      placeholder: "e.g. client-alpha-insta or brand-main",
      help: "Unique tag or label to identify this Buffer account across calendars and multi-account selectors.",
    },
  ],
  settingsFields: [
    {
      key: "channelId",
      label: "Channel ID",
      type: "text",
      placeholder: "Buffer channel ID override (optional)",
      help: "Leave empty to use the connected channel, or specify a specific channel ID.",
    },
    {
      key: "pinned",
      label: "Pin to top",
      type: "checkbox",
      default: false,
    },
  ],
  capabilities: {
    maxLength: 5000,
    text: "optional",
    media: {
      images: 4,
      videos: 1,
      mixed: false,
      required: false,
    },
    thread: false,
    mediaNote: "Videos uploaded to Postflare R2 are hotlinked and provided to Buffer via public URLs.",
  },

  async connect(ctx, values): Promise<ConnectedAccount[]> {
    const apiKey = values.apiKey?.trim();
    const tag = values.tag?.trim();
    if (!apiKey) throw new ProviderError("API key / access token is required", "invalid");
    if (!tag) throw new ProviderError("Account tag is required", "invalid");

    let channels: BufferChannel[] = [];
    let organizationId: string | undefined;

    // 1. Try modern GraphQL API
    try {
      const accountData = await bufferGraphql<BufferAccountQueryData>(
        ctx,
        apiKey,
        GET_ACCOUNT_ORGANIZATIONS_QUERY,
      );
      const orgs = accountData?.account?.organizations ?? [];
      for (const org of orgs) {
        if (!org?.id) continue;
        if (Array.isArray(org.channels)) {
          organizationId = org.id;
          for (const ch of org.channels) {
            channels.push({
              ...ch,
              organizationId: org.id,
            });
          }
          continue;
        }
        const channelsData = await bufferGraphql<BufferChannelsQueryData>(
          ctx,
          apiKey,
          GET_CHANNELS_QUERY,
          { input: { organizationId: org.id } },
        );
        if (channelsData?.channels?.length) {
          organizationId = org.id;
          for (const ch of channelsData.channels) {
            channels.push({
              ...ch,
              organizationId: org.id,
            });
          }
        }
      }
    } catch (gqlErr) {
      if (gqlErr instanceof ProviderError && gqlErr.kind === "auth") {
        throw gqlErr;
      }
      // If GraphQL fails or is not supported for this token type, attempt REST fallback
      try {
        const profiles = await bufferRest<any[]>(ctx, apiKey, "/profiles.json");
        if (Array.isArray(profiles)) {
          channels = profiles.map((p) => ({
            id: String(p.id ?? p._id),
            name: p.formatted_username || p.service_username || p.service || "Profile",
            displayName: p.formatted_username || p.service_username,
            service: p.service,
            serviceId: p.service_id ?? p.service_username ?? p.id,
            avatar: p.avatar || p.avatar_https,
          }));
        }
      } catch (restErr) {
        if (restErr instanceof ProviderError && restErr.kind === "auth") {
          throw restErr;
        }
        throw gqlErr;
      }
    }

    // Fallback if no specific channels are configured yet
    if (!channels.length) {
      return [
        {
          externalId: tag,
          name: tag,
          username: tag,
          avatarUrl: null,
          profileUrl: "https://publish.buffer.com",
          credentials: { apiKey, tag },
          meta: {
            tag,
            channelId: "",
            service: null,
            serviceId: null,
          },
        },
      ];
    }

    // Return connected accounts for each channel, with external_id guaranteeing uniqueness
    return channels.map((ch) => {
      const channelLabel = ch.displayName || ch.name || ch.service || "Channel";
      const channelId = String(ch.id);
      const service = ch.service ? String(ch.service).toLowerCase() : null;
      const serviceId = ch.serviceId ? String(ch.serviceId) : null;
      return {
        externalId: `${tag}:${channelId}`,
        name: `${tag} (${channelLabel})`,
        username: tag,
        avatarUrl: ch.avatar ?? null,
        profileUrl: ch.externalLink || `https://publish.buffer.com/profile/${channelId}/tab/queue`,
        credentials: { apiKey, tag },
        meta: {
          tag,
          channelId,
          service,
          serviceId,
          organizationId: ch.organizationId ?? organizationId ?? null,
          isDisconnected: ch.isDisconnected ?? false,
          isLocked: ch.isLocked ?? false,
          isQueuePaused: ch.isQueuePaused ?? false,
          externalLink: ch.externalLink ?? null,
        },
      };
    });
  },

  validate(post: PublishPost): string[] {
    const errors: string[] = [];
    if (!post.content?.trim() && !post.media?.length) {
      errors.push("Buffer: post must contain text or media");
    }
    const unsupportedMedia = post.media?.filter((m) => m.kind !== "image" && m.kind !== "video") ?? [];
    if (unsupportedMedia.length > 0) {
      errors.push("Buffer only supports image and video attachments");
    }
    const videos = post.media?.filter((m) => m.kind === "video") ?? [];
    const images = post.media?.filter((m) => m.kind === "image") ?? [];
    if (videos.length > 1) {
      errors.push("Buffer supports at most 1 video per post");
    }
    if (videos.length > 0 && images.length > 0) {
      errors.push("Buffer does not support mixing images and videos in the same post");
    }
    if (images.length > 4) {
      errors.push("Buffer supports at most 4 images per post");
    }
    return errors;
  },

  async publish(ctx: ProviderContext, account: AccountRecord, post: PublishPost): Promise<PublishResult> {
    const apiKey = String(account.credentials.apiKey ?? account.credentials.accessToken ?? "");
    if (!apiKey) throw new ProviderError("Buffer API key is missing", "auth");

    const channelIdFallback = account.externalId.includes(":")
      ? account.externalId.slice(account.externalId.lastIndexOf(":") + 1)
      : "";
    const channelId = String(
      post.settings.channelId ?? account.meta.channelId ?? channelIdFallback,
    );
    if (!channelId) throw new ProviderError("Buffer channel ID is missing", "invalid");

    const videos = post.media.filter((m) => m.kind === "video");
    const images = post.media.filter((m) => m.kind === "image");

    const assets: Array<Record<string, unknown>> = [];
    if (videos.length > 0) {
      // Hotlink video URL directly from R2 public URL
      assets.push({
        video: {
          url: videos[0].url,
          metadata: { thumbnailOffset: 0 },
        },
      });
    } else if (images.length > 0) {
      for (const img of images) {
        assets.push({
          image: {
            url: img.url,
            alt: img.alt ?? undefined,
          },
        });
      }
    }

    const isScheduled = !!post.scheduledAt && post.scheduledAt > Date.now();
    const mode = isScheduled ? "customScheduled" : "shareNow";
    const dueAt = isScheduled ? new Date(post.scheduledAt!).toISOString() : undefined;

    const useRest = account.meta.rest === true || post.settings.rest === true;

    if (useRest) {
      // REST fallback publish: POST /1/updates/create.json
      const payload: Record<string, unknown> = {
        profile_ids: [channelId],
        text: post.content || "",
        now: !isScheduled,
        shorten: false,
      };
      if (isScheduled && dueAt) {
        payload.scheduled_at = dueAt;
      }
      if (videos.length > 0) {
        payload.media = { video: videos[0].url };
      } else if (images.length > 0) {
        payload.media = { photo: images[0].url };
      }

      const restRes = await checkedCommit(
        ctx,
        () =>
          bufferRest<any>(
            ctx,
            apiKey,
            "/updates/create.json",
            {
              method: "POST",
              json: payload,
              commit: true,
            },
          ),
        (res) => {
          if (res?.success === false && res?.message) {
            throw new ProviderError(`Buffer: ${res.message}`, "invalid");
          }
          const updateId = res?.updates?.[0]?.id ?? res?.id ?? res?.update?.id;
          if (!updateId) {
            throw new ProviderError("Buffer: failed to create post (no update ID returned)", "invalid");
          }
        },
      );

      const updateId = String(restRes?.updates?.[0]?.id ?? restRes?.id ?? restRes?.update?.id);
      return {
        status: "published",
        externalId: updateId,
        url: `https://publish.buffer.com/profile/${channelId}/tab/sent`,
        data: {
          bufferPostId: updateId,
          channelId,
          status: restRes?.updates?.[0]?.status ?? restRes?.status ?? "buffer",
        },
      };
    }

    const isInstagram =
      account.meta?.service === "instagram" ||
      account.name?.toLowerCase().includes("instagram") ||
      account.externalId?.toLowerCase().includes("instagram");

    const metadata: Record<string, unknown> = {};
    if (isInstagram) {
      metadata.instagram = {
        type: videos.length > 0 ? "reel" : "post",
        shouldShareToFeed: true,
      };
    }

    const input: Record<string, unknown> = {
      channelId,
      text: post.content || "",
      mode,
      schedulingType: "automatic",
      needsApproval: false,
      ...(dueAt ? { dueAt } : {}),
      ...(assets.length > 0 ? { assets } : {}),
      ...(Object.keys(metadata).length > 0 ? { metadata } : {}),
      ...(post.settings.pinned ? { pinned: true } : {}),
    };

    // Checked commit: marks commit.sent before request and commit.accepted on success
    const data = await checkedCommit(
      ctx,
      () =>
        bufferGraphql<BufferCreatePostData>(
          ctx,
          apiKey,
          CREATE_POST_MUTATION,
          { input },
          { commit: true },
        ),
      (res) => {
        const payload = res?.createPost;
        if (!payload) {
          if (ctx.commit) ctx.commit.accepted = false;
          throw new ProviderError("Buffer: failed to create post (no response payload)", "invalid");
        }
        const typename = payload.__typename;
        const message = payload.message;
        if (typename === "UnauthorizedError") {
          if (ctx.commit) ctx.commit.accepted = false;
          throw new ProviderError(`Buffer: ${message || "Unauthorized"}`, "auth");
        }
        if (typename === "LimitReachedError") {
          if (ctx.commit) ctx.commit.accepted = false;
          throw new ProviderError(`Buffer: ${message || "Limit reached"}`, "rate_limit");
        }
        if (typename === "UnexpectedError") {
          if (ctx.commit) ctx.commit.accepted = false;
          throw new ProviderError(`Buffer: ${message || "Unexpected error"}`, "transient");
        }
        if (
          typename === "NotFoundError" ||
          typename === "InvalidInputError" ||
          typename === "RestProxyError"
        ) {
          if (ctx.commit) ctx.commit.accepted = false;
          throw new ProviderError(`Buffer: ${message || "Request failed"}`, "invalid");
        }
        if (message) {
          if (ctx.commit) ctx.commit.accepted = false;
          throw new ProviderError(`Buffer: ${message}`, "invalid");
        }
        if (!payload.post?.id) {
          if (ctx.commit) ctx.commit.accepted = false;
          throw new ProviderError("Buffer: failed to create post (no post ID returned)", "invalid");
        }
      },
    );

    const createdPost = data.createPost!.post!;
    return {
      status: "published",
      externalId: createdPost.id,
      url: `https://publish.buffer.com/profile/${channelId}/tab/sent`,
      data: {
        bufferPostId: createdPost.id,
        channelId,
        status: createdPost.status,
        dueAt: createdPost.dueAt,
      },
    };
  },

  async checkStatus(
    ctx: ProviderContext,
    account: AccountRecord,
    state: Record<string, unknown>,
  ): Promise<PublishResult> {
    const apiKey = String(account.credentials.apiKey ?? account.credentials.accessToken ?? "");
    const postId = String(state.updateId ?? state.bufferPostId ?? state.externalId ?? state.id ?? "");
    if (!postId) throw new ProviderError("Buffer checkStatus: missing post ID", "invalid");
    const channelId = String(state.channelId ?? account.meta.channelId ?? "");

    try {
      const data = await bufferGraphql<BufferPostStatusData>(ctx, apiKey, GET_POST_STATUS_QUERY, { id: postId });
      const p = data?.post;
      if (!p) throw new ProviderError(`Buffer post ${postId} not found`, "invalid");

      if (p.status === "sent" || p.status === "published") {
        return {
          status: "published",
          externalId: p.id,
          url: channelId ? `https://publish.buffer.com/profile/${channelId}/tab/sent` : null,
          data: { bufferPostId: p.id, status: p.status, sentAt: p.sentAt },
        };
      }
      if (p.status === "failed" || p.status === "error") {
        throw new ProviderError(`Buffer post ${postId} failed`, "invalid");
      }
      return {
        status: "pending",
        state: { ...state, updateId: p.id, status: p.status },
        retryAfterSeconds: 30,
      };
    } catch (err) {
      if (err instanceof ProviderError) {
        if (err.kind === "auth" || err.kind === "rate_limit") throw err;
        if (err.message.includes("failed")) throw err;
      }
      // REST fallback check: GET /1/updates/:id.json
      const update = await bufferRest<any>(ctx, apiKey, `/updates/${postId}.json`);
      if (update?.status === "sent" || update?.status === "published") {
        return {
          status: "published",
          externalId: String(update.id),
          url: channelId ? `https://publish.buffer.com/profile/${channelId}/tab/sent` : null,
          data: { bufferPostId: String(update.id), status: update.status },
        };
      }
      if (update?.status === "failed" || update?.status === "error") {
        throw new ProviderError(`Buffer update failed: ${update.failure_reason || "unknown error"}`, "invalid");
      }
      return {
        status: "pending",
        state: { ...state, updateId: String(update?.id ?? postId), status: update?.status ?? "buffer" },
        retryAfterSeconds: 30,
      };
    }
  },
};
