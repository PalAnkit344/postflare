/**
 * Creator Research Agent Integration & Cloudflare R2 Storage Service.
 *
 * Connects Postflare to the creator research agent (default:
 * https://creator-research-db.gamingshort205.workers.dev) and manages
 * storing, retrieving, and syncing creator research and video records in Cloudflare R2.
 */

export const DEFAULT_CREATOR_RESEARCH_URL = "https://creator-research-db.gamingshort205.workers.dev";

export interface CreatorAccount {
  id: string;
  platform: string;
  username: string;
  display_name?: string | null;
  niche: string;
  app?: string | null;
  status: string;
  created_at?: string;
}

export interface ResearchDay {
  id: number;
  account_id: string;
  day_date: string;
  platform: string;
  videos_found: number;
  status: string;
  notes?: string | null;
  created_at?: string;
}

export interface VideoRecord {
  id: number;
  research_day_id: number;
  account_id: string;
  platform: string;
  source_url: string;
  creator_handle?: string | null;
  creator_name?: string | null;
  title?: string | null;
  hook?: string | null;
  hook_type?: string | null;
  topic?: string | null;
  niche?: string | null;
  likes?: number;
  comments_count?: number;
  views?: number;
  shares?: number;
  velocity?: number;
  transcript?: string | null;
  posted_at?: string | null;
  discovered_at?: string;
}

export interface ResearchPost {
  id: number;
  account_id: string;
  day_date: string;
  platform: string;
  video_id?: number | null;
  post_text: string;
  hashtags?: string | null;
  status: string;
  created_at?: string;
}

export interface ResearchDayData {
  day: ResearchDay | null;
  videos: VideoRecord[];
  posts: ResearchPost[];
}

export interface ResearchSyncResult {
  accountId: string;
  date?: string;
  researchDaySaved: boolean;
  videosSynced: number;
  r2Keys: string[];
}

export class CreatorResearchError extends Error {
  constructor(
    message: string,
    public readonly statusCode: number = 500,
    public readonly responseBody?: unknown,
  ) {
    super(message);
    this.name = "CreatorResearchError";
  }
}

export interface CreatorResearchClientOptions {
  baseUrl?: string;
  apiKey?: string;
  fetchFn?: typeof fetch;
}

/**
 * Client for interacting with the Creator Research Agent service at
 * https://creator-research-db.gamingshort205.workers.dev.
 */
export class CreatorResearchAgent {
  public readonly baseUrl: string;
  public readonly apiKey?: string;
  private readonly fetcher: typeof fetch;

  constructor(options: CreatorResearchClientOptions = {}) {
    this.baseUrl = (options.baseUrl || DEFAULT_CREATOR_RESEARCH_URL).replace(/\/+$/, "");
    this.apiKey = options.apiKey;
    this.fetcher = options.fetchFn || fetch.bind(globalThis);
  }

  private authHeaders(): Record<string, string> {
    const headers: Record<string, string> = {
      "Accept": "application/json",
    };
    if (this.apiKey) {
      headers["Authorization"] = `Bearer ${this.apiKey}`;
    }
    return headers;
  }

  /**
   * Pings the research agent service to check endpoint reachability and authentication status.
   */
  async ping(): Promise<{
    reachable: boolean;
    status: number;
    authenticated: boolean;
    message?: string;
  }> {
    try {
      const res = await this.fetcher(`${this.baseUrl}/research/accounts`, {
        method: "GET",
        headers: this.authHeaders(),
      });

      if (res.status === 200) {
        return { reachable: true, status: 200, authenticated: true };
      }
      if (res.status === 401) {
        return {
          reachable: true,
          status: 401,
          authenticated: false,
          message: "Unauthorized: Invalid or missing API key",
        };
      }
      return {
        reachable: true,
        status: res.status,
        authenticated: false,
        message: `HTTP status ${res.status}`,
      };
    } catch (err: any) {
      return {
        reachable: false,
        status: 0,
        authenticated: false,
        message: err?.message || String(err),
      };
    }
  }

  /**
   * Retrieves all active research accounts from the agent.
   */
  async getAccounts(): Promise<CreatorAccount[]> {
    const res = await this.fetcher(`${this.baseUrl}/research/accounts`, {
      method: "GET",
      headers: this.authHeaders(),
    });

    if (!res.ok) {
      let errBody: any;
      try {
        errBody = await res.json();
      } catch {
        errBody = await res.text();
      }
      throw new CreatorResearchError(
        `Failed to fetch accounts from creator research agent: ${res.statusText || res.status}`,
        res.status,
        errBody,
      );
    }

    const data = await res.json<any>();
    if (!data || !data.ok || !Array.isArray(data.accounts)) {
      throw new CreatorResearchError("Invalid response payload from creator research agent", 502, data);
    }
    return data.accounts;
  }

  /**
   * Retrieves research day details, associated videos, and proposed posts for a given account and date.
   */
  async getResearchDay(accountId: string, date: string): Promise<ResearchDayData> {
    if (!accountId) throw new CreatorResearchError("accountId is required", 400);
    if (!date) throw new CreatorResearchError("date is required", 400);

    const url = `${this.baseUrl}/research/day?account_id=${encodeURIComponent(accountId)}&date=${encodeURIComponent(date)}`;
    const res = await this.fetcher(url, {
      method: "GET",
      headers: this.authHeaders(),
    });

    if (!res.ok) {
      let errBody: any;
      try {
        errBody = await res.json();
      } catch {
        errBody = await res.text();
      }
      throw new CreatorResearchError(
        `Failed to fetch research day from creator research agent: ${res.statusText || res.status}`,
        res.status,
        errBody,
      );
    }

    const data = await res.json<any>();
    if (!data || !data.ok) {
      throw new CreatorResearchError(data?.error || "Failed to retrieve research day data", 502, data);
    }

    return {
      day: data.day ?? null,
      videos: Array.isArray(data.videos) ? data.videos : [],
      posts: Array.isArray(data.posts) ? data.posts : [],
    };
  }

  /**
   * Retrieves videos for a specific account, ordered by discovery and velocity.
   */
  async getVideos(accountId: string, limit: number = 50): Promise<VideoRecord[]> {
    if (!accountId) throw new CreatorResearchError("accountId is required", 400);

    const boundedLimit = Math.max(1, Math.min(200, limit));
    const url = `${this.baseUrl}/research/videos?account_id=${encodeURIComponent(accountId)}&limit=${boundedLimit}`;
    const res = await this.fetcher(url, {
      method: "GET",
      headers: this.authHeaders(),
    });

    if (!res.ok) {
      let errBody: any;
      try {
        errBody = await res.json();
      } catch {
        errBody = await res.text();
      }
      throw new CreatorResearchError(
        `Failed to fetch videos from creator research agent: ${res.statusText || res.status}`,
        res.status,
        errBody,
      );
    }

    const data = await res.json<any>();
    if (!data || !data.ok || !Array.isArray(data.videos)) {
      throw new CreatorResearchError(data?.error || "Failed to retrieve videos", 502, data);
    }

    return data.videos;
  }

  /**
   * Submits/records a research day to the agent database.
   */
  async saveResearchDay(day: {
    account_id: string;
    day_date: string;
    platform: string;
    videos_found?: number;
    status?: string;
    notes?: string | null;
  }): Promise<{ ok: boolean; id: number | null }> {
    const res = await this.fetcher(`${this.baseUrl}/research/day`, {
      method: "POST",
      headers: {
        ...this.authHeaders(),
        "Content-Type": "application/json",
      },
      body: JSON.stringify(day),
    });

    if (!res.ok) {
      let errBody: any;
      try {
        errBody = await res.json();
      } catch {
        errBody = await res.text();
      }
      throw new CreatorResearchError(`Failed to save research day: ${res.status}`, res.status, errBody);
    }

    return await res.json();
  }

  /**
   * Submits/records a discovered video to the agent database.
   */
  async saveVideo(video: {
    research_day_id: number;
    account_id: string;
    platform: string;
    source_url: string;
    creator_handle?: string | null;
    creator_name?: string | null;
    title?: string | null;
    hook?: string | null;
    hook_type?: string | null;
    topic?: string | null;
    niche?: string | null;
    likes?: number;
    comments_count?: number;
    views?: number;
    shares?: number;
    velocity?: number;
    transcript?: string | null;
    posted_at?: string | null;
  }): Promise<{ ok: boolean; id: number | null; inserted: boolean }> {
    const res = await this.fetcher(`${this.baseUrl}/research/video`, {
      method: "POST",
      headers: {
        ...this.authHeaders(),
        "Content-Type": "application/json",
      },
      body: JSON.stringify(video),
    });

    if (!res.ok) {
      let errBody: any;
      try {
        errBody = await res.json();
      } catch {
        errBody = await res.text();
      }
      throw new CreatorResearchError(`Failed to save video: ${res.status}`, res.status, errBody);
    }

    return await res.json();
  }

  /**
   * Submits/records a post generated from research to the agent database.
   */
  async savePost(post: {
    account_id: string;
    day_date: string;
    platform: string;
    video_id?: number | null;
    post_text: string;
    hashtags?: string | null;
    status?: string;
  }): Promise<{ ok: boolean; id: number | null }> {
    const res = await this.fetcher(`${this.baseUrl}/research/post`, {
      method: "POST",
      headers: {
        ...this.authHeaders(),
        "Content-Type": "application/json",
      },
      body: JSON.stringify(post),
    });

    if (!res.ok) {
      let errBody: any;
      try {
        errBody = await res.json();
      } catch {
        errBody = await res.text();
      }
      throw new CreatorResearchError(`Failed to save post: ${res.status}`, res.status, errBody);
    }

    return await res.json();
  }
}

// ============================================================================
// Cloudflare R2 Storage Operations
// ============================================================================

/**
 * Resolves the Cloudflare R2 bucket for research data storage.
 * Prioritizes `RESEARCH_STORAGE` if bound, falling back to Postflare's `MEDIA` bucket.
 */
export function getResearchR2Bucket(env: Env): R2Bucket {
  const bucket = env.RESEARCH_STORAGE || env.MEDIA;
  if (!bucket) {
    throw new Error("No Cloudflare R2 bucket found (neither RESEARCH_STORAGE nor MEDIA is bound in Env)");
  }
  return bucket;
}

/** R2 key path for daily research snapshot JSON */
export function researchDataKey(accountId: string, date: string): string {
  const safeAccount = accountId.replace(/[^a-zA-Z0-9_-]/g, "_");
  const safeDate = date.replace(/[^0-9-]/g, "");
  return `research/data/${safeAccount}/${safeDate}.json`;
}

/** R2 key path for an individual video record JSON */
export function researchVideoRecordKey(accountId: string, videoId: string | number): string {
  const safeAccount = accountId.replace(/[^a-zA-Z0-9_-]/g, "_");
  const safeId = String(videoId).replace(/[^a-zA-Z0-9_-]/g, "_");
  return `research/videos/${safeAccount}/${safeId}.json`;
}

/** R2 key path for video media binary (MP4, etc.) */
export function researchVideoMediaKey(
  accountId: string,
  videoId: string | number,
  filename: string,
): string {
  const safeAccount = accountId.replace(/[^a-zA-Z0-9_-]/g, "_");
  const safeId = String(videoId).replace(/[^a-zA-Z0-9_-]/g, "_");
  const safeFile = filename.replace(/[^a-zA-Z0-9_.-]/g, "_");
  return `research/media/${safeAccount}/${safeId}/${safeFile}`;
}

/** R2 key path for cached accounts list */
export function researchAccountsKey(): string {
  return "research/accounts/accounts.json";
}

/**
 * Saves research day data (including video & post lists) into Cloudflare R2.
 */
export async function saveResearchDataToR2(
  env: Env,
  accountId: string,
  date: string,
  data: ResearchDayData,
): Promise<{ key: string; size: number }> {
  const bucket = getResearchR2Bucket(env);
  const key = researchDataKey(accountId, date);
  const jsonContent = JSON.stringify(data, null, 2);
  const bytes = new TextEncoder().encode(jsonContent);

  await bucket.put(key, bytes, {
    httpMetadata: {
      contentType: "application/json",
    },
    customMetadata: {
      type: "research-day",
      accountId,
      date,
      videosCount: String(data.videos?.length || 0),
      syncedAt: new Date().toISOString(),
    },
  });

  return { key, size: bytes.byteLength };
}

/**
 * Retrieves research day data from Cloudflare R2.
 */
export async function getResearchDataFromR2(
  env: Env,
  accountId: string,
  date: string,
): Promise<ResearchDayData | null> {
  const bucket = getResearchR2Bucket(env);
  const key = researchDataKey(accountId, date);
  const obj = await bucket.get(key);
  if (!obj) return null;

  const text = await obj.text();
  try {
    return JSON.parse(text) as ResearchDayData;
  } catch (e) {
    throw new Error(`Corrupted JSON in R2 object at key ${key}`);
  }
}

/**
 * Saves a single video record (metadata) into Cloudflare R2.
 */
export async function saveVideoRecordToR2(
  env: Env,
  video: VideoRecord,
): Promise<{ key: string; size: number }> {
  const bucket = getResearchR2Bucket(env);
  const key = researchVideoRecordKey(video.account_id, video.id);
  const jsonContent = JSON.stringify(video, null, 2);
  const bytes = new TextEncoder().encode(jsonContent);

  await bucket.put(key, bytes, {
    httpMetadata: {
      contentType: "application/json",
    },
    customMetadata: {
      type: "video-record",
      accountId: video.account_id,
      videoId: String(video.id),
      platform: video.platform,
      velocity: String(video.velocity || 0),
      syncedAt: new Date().toISOString(),
    },
  });

  return { key, size: bytes.byteLength };
}

/**
 * Retrieves a single video record from Cloudflare R2.
 */
export async function getVideoRecordFromR2(
  env: Env,
  accountId: string,
  videoId: string | number,
): Promise<VideoRecord | null> {
  const bucket = getResearchR2Bucket(env);
  const key = researchVideoRecordKey(accountId, videoId);
  const obj = await bucket.get(key);
  if (!obj) return null;

  const text = await obj.text();
  try {
    return JSON.parse(text) as VideoRecord;
  } catch {
    throw new Error(`Corrupted JSON in R2 object at key ${key}`);
  }
}

/**
 * Saves binary video content (or audio/video stream) into Cloudflare R2 under research storage.
 */
export async function saveVideoMediaToR2(
  env: Env,
  accountId: string,
  videoId: string | number,
  filename: string,
  body: ReadableStream | ArrayBuffer | Uint8Array,
  contentType: string = "video/mp4",
): Promise<{ key: string; size?: number }> {
  const bucket = getResearchR2Bucket(env);
  const key = researchVideoMediaKey(accountId, videoId, filename);

  const res = await bucket.put(key, body, {
    httpMetadata: {
      contentType,
    },
    customMetadata: {
      type: "video-media",
      accountId,
      videoId: String(videoId),
      filename,
      storedAt: new Date().toISOString(),
    },
  });

  return { key, size: res.size };
}

/**
 * Retrieves a binary video object from Cloudflare R2.
 */
export async function getVideoMediaFromR2(
  env: Env,
  accountId: string,
  videoId: string | number,
  filename: string,
): Promise<R2ObjectBody | null> {
  const bucket = getResearchR2Bucket(env);
  const key = researchVideoMediaKey(accountId, videoId, filename);
  return await bucket.get(key);
}

/**
 * Lists keys stored in Cloudflare R2 under the research namespace.
 */
export async function listResearchRecordsFromR2(
  env: Env,
  prefix: string = "research/",
): Promise<string[]> {
  const bucket = getResearchR2Bucket(env);
  const keys: string[] = [];
  let cursor: string | undefined;

  do {
    const list = await bucket.list({ prefix, cursor, limit: 1000 });
    for (const obj of list.objects) {
      keys.push(obj.key);
    }
    cursor = list.truncated ? list.cursor : undefined;
  } while (cursor);

  return keys;
}

/**
 * Synchronizes research data and video records from the Creator Research Agent
 * into Cloudflare R2 storage.
 */
export async function syncResearchAndVideosToR2(
  env: Env,
  client: CreatorResearchAgent,
  accountId: string,
  options: {
    date?: string;
    videoLimit?: number;
  } = {},
): Promise<ResearchSyncResult> {
  const r2Keys: string[] = [];
  let researchDaySaved = false;

  // 1. Sync research day if a date was specified
  if (options.date) {
    const dayData = await client.getResearchDay(accountId, options.date);
    const daySaved = await saveResearchDataToR2(env, accountId, options.date, dayData);
    r2Keys.push(daySaved.key);
    researchDaySaved = true;

    // Also persist each individual video from that day
    for (const v of dayData.videos) {
      const vSaved = await saveVideoRecordToR2(env, v);
      r2Keys.push(vSaved.key);
    }
  }

  // 2. Sync video records for this account
  const limit = options.videoLimit || 50;
  const videos = await client.getVideos(accountId, limit);
  let videosSynced = 0;

  for (const v of videos) {
    const vSaved = await saveVideoRecordToR2(env, v);
    if (!r2Keys.includes(vSaved.key)) {
      r2Keys.push(vSaved.key);
    }
    videosSynced++;
  }

  return {
    accountId,
    date: options.date,
    researchDaySaved,
    videosSynced,
    r2Keys,
  };
}
