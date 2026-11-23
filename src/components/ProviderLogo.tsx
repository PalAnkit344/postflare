import { useState } from "react";
import { Linkedin, Webhook } from "lucide-react";
import {
  siBluesky,
  siBuffer,
  siDevdotto,
  siDiscord,
  siDribbble,
  siFacebook,
  siFarcaster,
  siGoogle,
  siGooglemaps,
  siHashnode,
  siInstagram,
  siKick,
  siLemmy,
  siListmonk,
  siMastodon,
  siMedium,
  siMewe,
  siPinterest,
  siReddit,
  siTelegram,
  siThreads,
  siTiktok,
  siTumblr,
  siTwitch,
  siVk,
  siWordpress,
  siX,
  siYoutube,
  type SimpleIcon,
} from "simple-icons";
import type { AccountDTO, ProviderInfo } from "../lib/types";
import { bufferServiceDisplayName, bufferServiceIcon } from "@shared/providerNames";
import { cn } from "../lib/format";

/** Only the icons our providers use, so the bundle does not ship all of simple-icons. */
const ICONS: Record<string, SimpleIcon> = Object.fromEntries(
  [
    siBluesky, siBuffer, siDevdotto, siDiscord, siDribbble, siFacebook, siFarcaster, siGoogle, siGooglemaps, siHashnode, siInstagram,
    siKick, siLemmy, siListmonk, siMastodon, siMedium, siMewe, siPinterest, siReddit, siTelegram, siThreads, siTiktok,
    siTumblr, siTwitch, siVk, siWordpress, siX, siYoutube,
  ].map((i) => [i.slug, i]),
);

/** Fallback by provider id when the provider has no (known) icon slug. */
const BY_ID: Record<string, string> = { gmb: "google", tiktok_business: "tiktok", instagram_standalone: "instagram", linkedin_page: "" };

export const BUFFER_SERVICE_COLORS: Record<string, string> = {
  instagram: "E4405F",
  facebook: "0866FF",
  threads: "000000",
  youtube: "FF0000",
  tiktok: "000000",
  tiktok_business: "000000",
  twitter: "000000",
  x: "000000",
  pinterest: "BD081C",
  linkedin: "0A66C2",
  linkedin_page: "0A66C2",
  linkedinpage: "0A66C2",
  googlebusiness: "4285F4",
  gmb: "4285F4",
  google: "4285F4",
  mastodon: "6364FF",
  bluesky: "0285FF",
  shopify: "95BF47",
  buffer: "231F20",
};

export type LogoProvider = Pick<ProviderInfo, "id" | "name" | "color" | "icon">;

const SIZES = { xs: "size-4 rounded", sm: "size-5 rounded-md", md: "size-7 rounded-lg", lg: "size-9 rounded-lg", xl: "size-11 rounded-xl" };
const INNER = { xs: "size-2.5", sm: "size-3", md: "size-4", lg: "size-5", xl: "size-6" };
const TEXT = { xs: "text-[9px]", sm: "text-[10px]", md: "text-xs", lg: "text-sm", xl: "text-base" };

export function ProviderLogo({
  provider,
  service,
  size = "md",
  className,
}: {
  provider: LogoProvider | undefined;
  service?: string | null;
  size?: keyof typeof SIZES;
  className?: string;
}) {
  if (!provider) return <span className={cn("inline-block bg-zinc-300 dark:bg-zinc-700", SIZES[size], className)} />;
  
  const effectiveIconSlug = service ? bufferServiceIcon(service) : (provider.icon ?? "");
  const icon = ICONS[effectiveIconSlug] ?? ICONS[BY_ID[provider.id] ?? ""];
  const color = service
    ? `#${BUFFER_SERVICE_COLORS[effectiveIconSlug] ?? BUFFER_SERVICE_COLORS[service.toLowerCase()] ?? (provider.color || "71717a")}`
    : `#${provider.color || "71717a"}`;
  const displayName = service ? bufferServiceDisplayName(service) : provider.name;

  return (
    <span
      className={cn("inline-flex shrink-0 items-center justify-center text-white ring-1 ring-black/5 dark:ring-white/10", SIZES[size], className)}
      style={{ backgroundColor: color }}
      title={displayName}
    >
      {icon ? (
        <svg viewBox="0 0 24 24" className={INNER[size]} fill="currentColor" aria-hidden>
          <path d={icon.path} />
        </svg>
      ) : effectiveIconSlug === "linkedin" || provider.id === "linkedin" || provider.id === "linkedin_page" ? (
        <Linkedin className={INNER[size]} />
      ) : provider.id === "webhook" ? (
        <Webhook className={INNER[size]} />
      ) : (
        <span className={cn("font-semibold leading-none", TEXT[size])}>{displayName.charAt(0).toUpperCase()}</span>
      )}
    </span>
  );
}

const AVATAR = { xs: "size-5", sm: "size-7", md: "size-9", lg: "size-11", xl: "size-14" };
const BADGE = { xs: "xs", sm: "xs", md: "xs", lg: "sm", xl: "sm" } as const;
const INITIALS = { xs: "text-[8px]", sm: "text-[10px]", md: "text-xs", lg: "text-sm", xl: "text-base" };

export function AccountAvatar({
  account,
  provider,
  size = "md",
  showProvider = true,
  className,
}: {
  account: (Pick<AccountDTO, "name" | "avatarUrl"> & Partial<Pick<AccountDTO, "provider" | "meta">>) | undefined;
  provider?: LogoProvider;
  size?: keyof typeof AVATAR;
  showProvider?: boolean;
  className?: string;
}) {
  // Per URL: a refreshed avatar (copied to our storage) gets another chance after the old link failed.
  const [failedUrl, setFailedUrl] = useState<string | null>(null);
  const failed = !!account?.avatarUrl && failedUrl === account.avatarUrl;
  const name = account?.name ?? "?";
  const initials = name
    .split(/\s+/)
    .map((w) => w.charAt(0))
    .join("")
    .slice(0, 2)
    .toUpperCase();

  const isBuffer = account?.provider === "buffer" || provider?.id === "buffer";
  const service = isBuffer && account?.meta && typeof account.meta.service === "string" ? account.meta.service : undefined;

  let underlyingProvider: LogoProvider | undefined = undefined;
  if (service) {
    const iconSlug = bufferServiceIcon(service);
    const platformName = bufferServiceDisplayName(service);
    const platformColor = BUFFER_SERVICE_COLORS[iconSlug] ?? BUFFER_SERVICE_COLORS[service.toLowerCase()] ?? provider?.color ?? "231F20";
    underlyingProvider = {
      id: service,
      name: platformName,
      color: platformColor,
      icon: iconSlug,
    };
  }

  return (
    <span className={cn("relative inline-flex shrink-0", AVATAR[size], className)}>
      {account?.avatarUrl && !failed ? (
        <img
          src={account.avatarUrl}
          alt=""
          className="size-full rounded-full object-cover ring-1 ring-black/5 dark:ring-white/10"
          onError={() => setFailedUrl(account.avatarUrl)}
          referrerPolicy="no-referrer"
        />
      ) : (
        <span
          className={cn("flex size-full items-center justify-center rounded-full font-semibold text-white", INITIALS[size])}
          style={{ backgroundColor: `#${(underlyingProvider ?? provider)?.color || "71717a"}` }}
        >
          {initials}
        </span>
      )}
      {showProvider && (provider || underlyingProvider) && (
        <>
          {underlyingProvider ? (
            <>
              <ProviderLogo
                provider={underlyingProvider}
                size={BADGE[size]}
                className="absolute -bottom-1 -right-1 ring-2 ring-white dark:ring-zinc-900"
              />
              <span
                className={cn(
                  "absolute -top-1 -right-1 flex items-center justify-center rounded-full bg-[#231F20] text-white ring-1.5 ring-white dark:ring-zinc-900 shadow-sm",
                  size === "xs" || size === "sm" ? "size-3" : "size-4"
                )}
                title={`Buffer channel (${underlyingProvider.name})`}
              >
                <svg viewBox="0 0 24 24" className={size === "xs" || size === "sm" ? "size-1.5" : "size-2.5"} fill="currentColor" aria-hidden>
                  <path d={siBuffer.path} />
                </svg>
              </span>
            </>
          ) : (
            provider && (
              <ProviderLogo provider={provider} size={BADGE[size]} className="absolute -bottom-1 -right-1 ring-2 ring-white dark:ring-zinc-900" />
            )
          )}
        </>
      )}
    </span>
  );
}
