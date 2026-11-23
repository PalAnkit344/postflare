import { useEffect, useState } from "react";
import { AlertTriangle, ExternalLink, Layers, Lock, PauseCircle, RefreshCw } from "lucide-react";
import { Dialog } from "../ui/Dialog";
import { Button } from "../ui/Button";
import { Badge } from "../ui/Misc";
import { AccountAvatar, ProviderLogo } from "../ProviderLogo";
import { bufferServiceDisplayName, bufferServiceIcon } from "@shared/providerNames";
import { useToast } from "../ui/Toast";
import { api } from "../../lib/api";
import { invalidate } from "../../lib/useFetch";
import { cn } from "../../lib/format";
import type { AccountDTO } from "../../lib/types";

export function BufferOverviewDialog({
  open,
  tag,
  accounts,
  onClose,
  onFilterTag,
}: {
  open: boolean;
  tag: string | null;
  accounts: AccountDTO[];
  onClose: () => void;
  onFilterTag?: (tag: string) => void;
}) {
  const toast = useToast();
  const [syncing, setSyncing] = useState(false);

  if (!tag || !open) return null;

  const normalizedTag = tag.trim().replace(/^#/, "");
  const channels = accounts.filter(
    (a) =>
      a.provider === "buffer" &&
      (a.tag?.replace(/^#/, "") === normalizedTag ||
        (typeof a.meta?.tag === "string" && a.meta.tag.replace(/^#/, "") === normalizedTag) ||
        a.username?.replace(/^#/, "") === normalizedTag),
  );

  const activeCount = channels.filter(
    (c) => c.status === "active" && !c.meta?.isDisconnected && !c.meta?.isLocked,
  ).length;
  const inactiveCount = channels.length - activeCount;

  const handleSync = async () => {
    setSyncing(true);
    try {
      const res = await api.accounts.syncBuffer({ tag: normalizedTag });
      toast.success("Buffer channels synchronized", `${res.ids.length} channel(s) updated`);
      invalidate("accounts");
    } catch (err) {
      toast.error("Failed to sync Buffer channels", err instanceof Error ? err.message : String(err));
    } finally {
      setSyncing(false);
    }
  };

  useEffect(() => {
    if (open && normalizedTag) {
      // Auto-sync in background when overview dialog opens so newly added channels on Buffer show up automatically
      api.accounts.syncBuffer({ tag: normalizedTag })
        .then(() => invalidate("accounts"))
        .catch(() => {});
    }
  }, [open, normalizedTag]);

  const handleOpenBufferConnect = () => {
    window.open("https://publish.buffer.com/manage/channels", "_blank", "noopener,noreferrer");
  };

  return (
    <Dialog
      open={open}
      onClose={onClose}
      size="lg"
      title={
        <div className="flex items-center gap-2.5">
          <ProviderLogo provider={{ id: "buffer", name: "Buffer", color: "231F20", icon: "buffer" }} size="sm" />
          <span>Buffer Account Overview</span>
          <span className="inline-flex items-center rounded-md bg-zinc-100 px-2 py-0.5 font-mono text-xs font-semibold text-zinc-800 ring-1 ring-inset ring-zinc-500/10 dark:bg-zinc-800 dark:text-zinc-200">
            #{normalizedTag}
          </span>
        </div>
      }
      description="All social platforms and channels connected under this Buffer API key."
      footer={
        <div className="flex w-full flex-wrap items-center justify-between gap-2">
          {onFilterTag && (
            <Button
              variant="secondary"
              onClick={() => {
                onFilterTag(normalizedTag);
                onClose();
              }}
            >
              Filter view to this account
            </Button>
          )}
          <div className="flex-1" />
          <Button variant="ghost" onClick={onClose}>
            Close
          </Button>
        </div>
      }
    >
      <div className="space-y-4 p-5">
        {/* Connection Management Banner */}
        <div className="flex flex-col gap-3 rounded-xl border border-zinc-200 bg-zinc-50/80 p-4 sm:flex-row sm:items-center sm:justify-between dark:border-zinc-800 dark:bg-zinc-800/50">
          <div className="space-y-1">
            <h4 className="text-sm font-semibold text-zinc-900 dark:text-zinc-100">
              Manage Channels on Buffer
            </h4>
            <p className="text-xs text-zinc-500 dark:text-zinc-400">
              Connect or disconnect Instagram, Threads, Facebook, YouTube, X, or other platforms in Buffer, then click Sync.
            </p>
          </div>
          <div className="flex items-center gap-2 shrink-0">
            <Button
              variant="primary"
              size="sm"
              icon={<ExternalLink className="size-3.5" />}
              onClick={handleOpenBufferConnect}
            >
              Connect on Buffer
            </Button>
            <Button
              variant="secondary"
              size="sm"
              icon={<RefreshCw className={cn("size-3.5", syncing && "animate-spin")} />}
              disabled={syncing}
              onClick={handleSync}
            >
              {syncing ? "Syncing…" : "Sync Channels"}
            </Button>
          </div>
        </div>

        {/* Summary stats */}
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
          <div className="rounded-xl border border-zinc-200 bg-white p-3 text-center dark:border-zinc-800 dark:bg-zinc-900">
            <span className="block text-xl font-bold text-zinc-900 dark:text-zinc-100">{channels.length}</span>
            <span className="text-xs text-zinc-500 dark:text-zinc-400">Total Channels</span>
          </div>
          <div className="rounded-xl border border-emerald-100 bg-emerald-50/50 p-3 text-center dark:border-emerald-900/40 dark:bg-emerald-950/20">
            <span className="block text-xl font-bold text-emerald-600 dark:text-emerald-400">{activeCount}</span>
            <span className="text-xs text-emerald-700/80 dark:text-emerald-400/80">Active & Ready</span>
          </div>
          <div className="rounded-xl border border-amber-100 bg-amber-50/50 p-3 text-center dark:border-amber-900/40 dark:bg-amber-950/20">
            <span className="block text-xl font-bold text-amber-600 dark:text-amber-400">{inactiveCount}</span>
            <span className="text-xs text-amber-700/80 dark:text-amber-400/80">Inactive / Disconnected</span>
          </div>
        </div>

        {/* Channel list */}
        <div className="space-y-3">
          <div className="flex items-center justify-between">
            <h3 className="text-xs font-semibold uppercase tracking-wider text-zinc-500 dark:text-zinc-400">
              Connected Channels ({channels.length})
            </h3>
            <span className="text-xs text-zinc-400">
              Click channel to open in Buffer
            </span>
          </div>

          {channels.length === 0 ? (
            <div className="rounded-xl border border-dashed border-zinc-200 p-8 text-center dark:border-zinc-800">
              <Layers className="mx-auto size-8 text-zinc-400" />
              <p className="mt-2 text-sm font-medium text-zinc-700 dark:text-zinc-300">
                No channels found for #{normalizedTag}
              </p>
              <p className="mt-1 text-xs text-zinc-500">
                Click &quot;Connect on Buffer&quot; to link your social accounts, then click &quot;Sync Channels&quot;.
              </p>
              <div className="mt-4 flex justify-center gap-2">
                <Button variant="primary" size="sm" onClick={handleOpenBufferConnect}>
                  Connect on Buffer
                </Button>
                <Button variant="secondary" size="sm" onClick={handleSync} disabled={syncing}>
                  Sync Channels
                </Button>
              </div>
            </div>
          ) : (
            channels.map((channel) => {
              const service = typeof channel.meta?.service === "string" ? channel.meta.service : null;
              const platformDisplayName = bufferServiceDisplayName(service);
              const iconSlug = bufferServiceIcon(service);
              const channelId = (channel.meta?.channelId as string) || channel.externalId;
              const isDisconnected = Boolean(channel.meta?.isDisconnected);
              const isLocked = Boolean(channel.meta?.isLocked);
              const isQueuePaused = Boolean(channel.meta?.isQueuePaused);
              const externalLink = typeof channel.meta?.externalLink === "string" ? channel.meta.externalLink : null;
              const bufferManageUrl = `https://publish.buffer.com/profile/${channelId}/tab/queue`;

              return (
                <div
                  key={channel.id}
                  className={cn(
                    "flex flex-col gap-3 rounded-xl border p-4 transition shadow-sm sm:flex-row sm:items-center sm:justify-between",
                    isDisconnected || channel.status === "disabled"
                      ? "border-zinc-200 bg-zinc-50/70 dark:border-zinc-800 dark:bg-zinc-900/40 opacity-80"
                      : "border-zinc-200 bg-white dark:border-zinc-800 dark:bg-zinc-900/70",
                  )}
                >
                  <div className="flex items-center gap-3.5 min-w-0">
                    <AccountAvatar account={channel} size="md" />
                    <div className="min-w-0">
                      <div className="flex items-center gap-2">
                        <h4 className="truncate text-sm font-semibold text-zinc-900 dark:text-zinc-100">
                          {channel.name}
                        </h4>

                        {/* Status Badges */}
                        {isDisconnected ? (
                          <Badge tone="red">
                            <AlertTriangle className="size-3" /> Disconnected on Buffer
                          </Badge>
                        ) : isLocked ? (
                          <Badge tone="amber">
                            <Lock className="size-3" /> Locked
                          </Badge>
                        ) : isQueuePaused ? (
                          <Badge tone="zinc">
                            <PauseCircle className="size-3" /> Paused
                          </Badge>
                        ) : channel.status === "active" ? (
                          <Badge tone="green" dot>
                            Connected & Active
                          </Badge>
                        ) : channel.status === "disabled" ? (
                          <Badge tone="zinc">Disabled</Badge>
                        ) : (
                          <Badge tone="amber">
                            <AlertTriangle className="size-3" /> Reconnect
                          </Badge>
                        )}
                      </div>

                      <div className="mt-1 flex flex-wrap items-center gap-x-2 text-xs text-zinc-500">
                        <span className="inline-flex items-center gap-1 font-semibold text-zinc-800 dark:text-zinc-200">
                          <ProviderLogo provider={{ id: service ?? "buffer", name: platformDisplayName, color: "71717a", icon: iconSlug }} size="xs" />
                          {platformDisplayName}
                        </span>

                        {channel.username && (
                          <>
                            <span>·</span>
                            <span>@{channel.username.replace(/^@/, "")}</span>
                          </>
                        )}

                        {externalLink && (
                          <>
                            <span>·</span>
                            <a
                              href={externalLink}
                              target="_blank"
                              rel="noreferrer"
                              className="inline-flex items-center gap-0.5 text-brand-600 hover:underline dark:text-brand-400"
                            >
                              Public Profile
                              <ExternalLink className="size-2.5" />
                            </a>
                          </>
                        )}
                      </div>

                      <div className="mt-1 text-[11px] font-mono text-zinc-400">
                        Channel ID: <span className="text-zinc-600 dark:text-zinc-300">{channelId}</span>
                      </div>
                    </div>
                  </div>

                  <div className="flex items-center gap-2 justify-end sm:shrink-0">
                    <Button
                      variant="ghost"
                      size="sm"
                      icon={<ExternalLink className="size-3" />}
                      onClick={() => window.open(bufferManageUrl, "_blank", "noopener,noreferrer")}
                    >
                      Open in Buffer
                    </Button>
                  </div>
                </div>
              );
            })
          )}

          {channels.length > 0 && (
            <button
              type="button"
              onClick={handleOpenBufferConnect}
              className="flex w-full items-center justify-center gap-2 rounded-xl border border-dashed border-zinc-200 py-3 text-xs font-medium text-zinc-500 transition hover:border-brand-400 hover:bg-brand-50/50 hover:text-brand-700 dark:border-zinc-800 dark:hover:border-brand-700 dark:hover:bg-brand-950/20 dark:hover:text-brand-300 cursor-pointer"
            >
              <ExternalLink className="size-3.5" />
              Connect another channel on Buffer (Facebook, YouTube, TikTok, etc.)
            </button>
          )}
        </div>
      </div>
    </Dialog>
  );
}
