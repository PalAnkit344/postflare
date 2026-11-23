/**
 * Display names of the providers, for the moments the catalog (GET /api/providers) has not loaded yet: right after an
 * OAuth redirect the accounts can arrive first, and section headings / toasts would show raw ids ("instagram_standalone").
 * Must match each provider's `name` (test/registry.test.ts).
 */
export const PROVIDER_NAMES: Record<string, string> = {
  bluesky: "Bluesky",
  buffer: "Buffer",
  devto: "DEV",
  discord: "Discord",
  dribbble: "Dribbble",
  facebook: "Facebook Page",
  farcaster: "Farcaster",
  gmb: "Google Business Profile",
  hashnode: "Hashnode",
  instagram: "Instagram (Facebook login)",
  instagram_standalone: "Instagram",
  kick: "Kick",
  lemmy: "Lemmy",
  linkedin: "LinkedIn",
  linkedin_page: "LinkedIn Page",
  listmonk: "Listmonk",
  mastodon: "Mastodon",
  medium: "Medium",
  mewe: "MeWe",
  moltbook: "Moltbook",
  nostr: "Nostr",
  pinterest: "Pinterest",
  reddit: "Reddit",
  skool: "Skool",
  slack: "Slack",
  telegram: "Telegram",
  threads: "Threads",
  tiktok: "TikTok",
  tiktok_business: "TikTok Business",
  tumblr: "Tumblr",
  twitch: "Twitch",
  vk: "VK",
  webhook: "Webhook",
  whop: "Whop",
  wordpress: "WordPress",
  x: "X (Twitter)",
  youtube: "YouTube",
};

/** Display name of a provider: the loaded catalog's, else the built-in fallback, else the id. */
export function providerDisplayName(id: string, catalog?: { get(id: string): { name: string } | undefined }): string {
  return catalog?.get(id)?.name ?? PROVIDER_NAMES[id] ?? id;
}

/**
 * Direct native social and video network connectors replaced by the unified Buffer API connector.
 * All social media channels (Instagram, Facebook, X, TikTok, YouTube, Threads, LinkedIn, Pinterest)
 * are connected and managed through Buffer API keys.
 */
export const DIRECT_SOCIAL_PROVIDERS = new Set<string>([
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
]);

export const BUFFER_SEARCH_ALIASES: string[] = [
  "buffer",
  "instagram",
  "facebook",
  "fb",
  "ig",
  "x",
  "twitter",
  "tweet",
  "threads",
  "tiktok",
  "tik tok",
  "youtube",
  "yt",
  "linkedin",
  "pinterest",
  "pin",
  "social",
  "reels",
  "shorts",
];

export const BUFFER_SERVICE_NAMES: Record<string, string> = {
  instagram: "Instagram",
  facebook: "Facebook",
  threads: "Threads",
  youtube: "YouTube",
  tiktok: "TikTok",
  tiktok_business: "TikTok Business",
  twitter: "X (Twitter)",
  x: "X (Twitter)",
  pinterest: "Pinterest",
  linkedin: "LinkedIn",
  linkedin_page: "LinkedIn Page",
  linkedinpage: "LinkedIn Page",
  googlebusiness: "Google Business Profile",
  gmb: "Google Business Profile",
  google: "Google Business Profile",
  mastodon: "Mastodon",
  bluesky: "Bluesky",
  shopify: "Shopify",
  startpage: "Start Page",
};

export const BUFFER_SERVICE_ICONS: Record<string, string> = {
  instagram: "instagram",
  facebook: "facebook",
  threads: "threads",
  youtube: "youtube",
  tiktok: "tiktok",
  tiktok_business: "tiktok",
  twitter: "x",
  x: "x",
  pinterest: "pinterest",
  linkedin: "linkedin",
  linkedin_page: "linkedin",
  linkedinpage: "linkedin",
  googlebusiness: "google",
  gmb: "google",
  google: "google",
  mastodon: "mastodon",
  bluesky: "bluesky",
  shopify: "shopify",
  startpage: "buffer",
};

/**
 * Maps Buffer channel service code ('instagram', 'facebook', 'threads', 'youtube', 'tiktok', 'twitter', 'x', etc.)
 * to its human-friendly platform display name.
 */
export function bufferServiceDisplayName(service?: string | null | unknown): string {
  if (typeof service !== "string" || !service.trim()) {
    return "Buffer";
  }
  const s = service.trim().toLowerCase();
  return BUFFER_SERVICE_NAMES[s] ?? (s.charAt(0).toUpperCase() + s.slice(1));
}

/**
 * Maps Buffer channel service code to simple-icon slug ('instagram', 'facebook', 'threads', 'youtube', 'tiktok', 'x', 'pinterest', 'linkedin', etc.).
 */
export function bufferServiceIcon(service?: string | null | unknown): string {
  if (typeof service !== "string" || !service.trim()) {
    return "buffer";
  }
  const s = service.trim().toLowerCase();
  return BUFFER_SERVICE_ICONS[s] ?? s;
}
