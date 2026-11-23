import { useEffect, useMemo, useState, type FormEvent } from "react";
import { useNavigate } from "react-router";
import { ArrowLeft, ArrowRight, FlaskConical, KeyRound, Lock, Search, Settings2, Sparkles } from "lucide-react";
import { api, isPlanLimit } from "../../lib/api";
import { useApp } from "../../lib/app";
import { cn } from "../../lib/format";
import { useSession } from "../../lib/session";
import type { Provider, ProviderCategory } from "../../lib/types";
import { invalidate } from "../../lib/useFetch";
import { Markdown } from "../Markdown";
import { ProviderLogo } from "../ProviderLogo";
import { ProviderStatusBadge } from "../ProviderStatusBadge";
import { SettingsForm, defaultValues, fieldErrors } from "../SettingsForm";
import { Button } from "../ui/Button";
import { Dialog } from "../ui/Dialog";
import { Input } from "../ui/Form";
import { Badge } from "../ui/Misc";
import { useToast } from "../ui/Toast";

export const CATEGORY_LABELS: Record<ProviderCategory, string> = {
  social: "Social networks",
  video: "Video",
  community: "Communities",
  blog: "Blogs & articles",
  messaging: "Messaging & automation",
  newsletter: "Newsletters",
};
export const CATEGORY_ORDER: ProviderCategory[] = ["social", "video", "community", "messaging", "blog", "newsletter"];

import { DIRECT_SOCIAL_PROVIDERS, BUFFER_SEARCH_ALIASES } from "../../../shared/providerNames";
export { DIRECT_SOCIAL_PROVIDERS, BUFFER_SEARCH_ALIASES };

export function ConnectDialog({ open, onClose, initialProvider }: { open: boolean; onClose: () => void; initialProvider?: string | null }) {
  const { providers, providerMap } = useApp();
  const [q, setQ] = useState("");
  const [selected, setSelected] = useState<Provider | null>(null);
  const [redirecting, setRedirecting] = useState<string | null>(null);
  /** Last authorization URL: if the platform's mobile/desktop app hijacks it and fails, it can be pasted into the browser. */
  const [authUrl, setAuthUrl] = useState<string | null>(null);
  const toast = useToast();

  const bufferProvider = useMemo(() => providerMap.get("buffer") ?? providers.find((p) => p.id === "buffer"), [providerMap, providers]);

  useEffect(() => {
    if (!open) return;
    setQ("");
    setRedirecting(null);
    setAuthUrl(null);
    let target = initialProvider ? (providerMap.get(initialProvider) ?? null) : null;
    // If a replaced native direct social provider is requested, automatically route to Buffer
    if (target && DIRECT_SOCIAL_PROVIDERS.has(target.id)) {
      target = bufferProvider ?? providerMap.get("buffer") ?? null;
    }
    setSelected(target);
    if (target && target.id !== "buffer") {
      // Platforms that offer "use a different account" wait on the Continue screen so the choice can be made.
      if (target.enabled && target.allowed !== false && target.auth === "oauth2" && target.configured && !target.switchAccount) void startOAuth(target);
    }
  }, [open, initialProvider, bufferProvider, providerMap]); // eslint-disable-line react-hooks/exhaustive-deps

  async function startOAuth(p: Provider, switchAccount = false) {
    setRedirecting(p.id);
    try {
      const { url } = await api.connect.url(p.id, { switchAccount });
      setAuthUrl(url);
      setSelected(p);
      window.location.href = url;
    } catch (err) {
      toast.error(err);
      setRedirecting(null);
    }
  }

  function pick(p: Provider) {
    if (p.auth === "oauth2" && p.configured && !p.switchAccount) void startOAuth(p);
    else setSelected(p);
  }

  const needle = q.trim().toLowerCase();
  const bufferMatches = useMemo(() => {
    if (!bufferProvider) return false;
    if (!needle) return true;
    return (
      bufferProvider.name.toLowerCase().includes(needle) ||
      bufferProvider.id.includes(needle) ||
      BUFFER_SEARCH_ALIASES.some((alias) => alias.includes(needle) || needle.includes(alias))
    );
  }, [bufferProvider, needle]);

  const groups = useMemo(() => {
    // Direct social networks removed in favor of Buffer; Buffer rendered in prominent hero card
    const list = providers.filter(
      (p) =>
        !DIRECT_SOCIAL_PROVIDERS.has(p.id) &&
        p.id !== "buffer" &&
        p.enabled &&
        p.allowed !== false &&
        (!needle || p.name.toLowerCase().includes(needle) || p.id.includes(needle)),
    );
    return CATEGORY_ORDER.map((c) => ({ category: c, items: list.filter((p) => p.category === c) })).filter((g) => g.items.length);
  }, [providers, needle]);

  return (
    <Dialog
      open={open}
      onClose={onClose}
      size="lg"
      title={selected ? <BackTitle provider={selected} onBack={initialProvider ? undefined : () => setSelected(null)} /> : "Connect an account"}
      description={selected ? undefined : "Choose a platform. Connect social channels via Buffer or choose other platforms below."}
    >
      {selected ? (
        selected.allowed === false ? (
          <NotAllowed provider={selected} onClose={onClose} />
        ) : !selected.enabled ? (
          <ExperimentalDisabled provider={selected} onClose={onClose} />
        ) : !selected.configured ? (
          <NeedsSetup provider={selected} onClose={onClose} />
        ) : selected.auth === "credentials" ? (
          <CredentialsForm provider={selected} onDone={onClose} />
        ) : (
          <div className="p-6 text-center">
            <p className="text-sm text-zinc-500">
              {selected.switchAccount && !redirecting ? `Sign in with ${selected.name} to connect your account.` : `Redirecting to ${selected.name}…`}
            </p>
            <Button className="mt-4" variant="primary" loading={redirecting === selected.id} onClick={() => startOAuth(selected)}>
              Continue with {selected.name}
            </Button>
            {selected.switchAccount && (
              <div className="mx-auto mt-4 max-w-md text-xs text-zinc-500">
                <button
                  type="button"
                  className="font-medium text-zinc-700 underline underline-offset-2 hover:text-zinc-900 disabled:opacity-60 dark:text-zinc-300 dark:hover:text-white"
                  disabled={!!redirecting}
                  onClick={() => startOAuth(selected, true)}
                >
                  {selected.switchAccount.label}
                </button>
                <p className="mt-1">{selected.switchAccount.note}</p>
              </div>
            )}
            {authUrl && (
              <div className="mx-auto mt-6 max-w-md rounded-xl bg-zinc-50 p-4 text-left text-xs text-zinc-600 ring-1 ring-zinc-200 dark:bg-zinc-900 dark:text-zinc-400 dark:ring-zinc-800">
                <p>
                  Did the {selected.name} app open and show an error? Copy the login link and paste it into your browser's address bar
                  instead — typed links stay in the browser.
                </p>
                <Button
                  className="mt-3"
                  size="sm"
                  onClick={() => navigator.clipboard.writeText(authUrl).then(() => toast.success("Login link copied"), (err) => toast.error(err))}
                >
                  Copy login link
                </Button>
              </div>
            )}
          </div>
        )
      ) : (
        <div className="p-5">
          <div className="relative mb-5">
            <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-zinc-400" />
            <Input data-autofocus value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search platforms…" className="pl-9" aria-label="Search platforms" />
          </div>

          {/* Prominently feature Buffer as the Unified Social Media Connector */}
          {bufferProvider && bufferMatches && (
            <div className="mb-6 overflow-hidden rounded-2xl border-2 border-brand-500/30 bg-gradient-to-br from-brand-500/10 via-brand-50/40 to-transparent p-5 shadow-sm transition-all hover:border-brand-500/50 hover:shadow-md dark:border-brand-500/40 dark:from-brand-950/40 dark:via-zinc-900 dark:to-transparent">
              <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
                <div className="flex items-start gap-3.5">
                  <div className="flex size-12 shrink-0 items-center justify-center rounded-xl bg-white p-2 shadow-sm ring-1 ring-zinc-200 dark:bg-zinc-800 dark:ring-zinc-700">
                    <ProviderLogo provider={bufferProvider} size="lg" />
                  </div>
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-2">
                      <h3 className="text-base font-semibold text-zinc-900 dark:text-zinc-100">
                        Buffer (Unified Social Connector)
                      </h3>
                      <Badge tone="brand">Unified Connector</Badge>
                    </div>
                    <p className="mt-1 text-xs leading-relaxed text-zinc-600 dark:text-zinc-300">
                      Connect all your social channels (Instagram, Facebook, X, TikTok, YouTube, Threads, LinkedIn, Pinterest) through Buffer. Supports up to 50 distinct Buffer accounts with independent account tags and channel selection.
                    </p>
                    <div className="mt-2.5 flex flex-wrap items-center gap-1.5 text-[11px] text-zinc-500 dark:text-zinc-400">
                      <span className="font-medium text-zinc-700 dark:text-zinc-300">Connected channels:</span>
                      {["Instagram", "Facebook", "X", "TikTok", "YouTube", "Threads", "LinkedIn", "Pinterest"].map((net) => (
                        <span key={net} className="rounded-md bg-white/80 px-1.5 py-0.5 font-medium text-zinc-700 ring-1 ring-zinc-200/80 dark:bg-zinc-800/80 dark:text-zinc-300 dark:ring-zinc-700">
                          {net}
                        </span>
                      ))}
                    </div>
                  </div>
                </div>
                <div className="shrink-0 sm:self-center">
                  <Button
                    variant="primary"
                    onClick={() => setSelected(bufferProvider)}
                    className="w-full sm:w-auto"
                  >
                    Connect Buffer Account
                  </Button>
                </div>
              </div>
            </div>
          )}

          {!groups.length && !bufferMatches && <p className="py-10 text-center text-sm text-zinc-500">No platform matches “{q}”.</p>}

          <div className="space-y-6">
            {groups.map((g) => (
              <section key={g.category}>
                <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-zinc-400">{CATEGORY_LABELS[g.category]}</h3>
                <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
                  {g.items.map((p) => (
                    <button
                      key={p.id}
                      type="button"
                      onClick={() => pick(p)}
                      disabled={!!redirecting}
                      className="group flex items-center gap-3 rounded-xl p-2.5 text-left ring-1 ring-zinc-200 transition hover:bg-zinc-50 hover:ring-zinc-300 disabled:opacity-60 dark:ring-zinc-800 dark:hover:bg-zinc-800/60 dark:hover:ring-zinc-700"
                    >
                      <ProviderLogo provider={p} size="lg" />
                      <span className="min-w-0 flex-1">
                        <span className="flex items-center gap-1.5">
                          <span className="truncate text-sm font-medium">{p.name}</span>
                          <ProviderStatusBadge provider={p} className="px-1.5 py-0 text-[10px]" />
                        </span>
                        <span className="block text-xs text-zinc-500">
                          {redirecting === p.id ? "Redirecting…" : !p.configured ? "App setup required" : p.auth === "oauth2" ? "Sign in with OAuth" : "Connect with credentials"}
                        </span>
                      </span>
                      {!p.configured ? (
                        <Badge tone="amber">Setup</Badge>
                      ) : (
                        <ArrowRight className="size-4 text-zinc-300 transition group-hover:translate-x-0.5 group-hover:text-zinc-500" />
                      )}
                    </button>
                  ))}
                </div>
              </section>
            ))}
          </div>
        </div>
      )}
    </Dialog>
  );
}

function BackTitle({ provider, onBack }: { provider: Provider; onBack?: () => void }) {
  return (
    <span className="flex items-center gap-2.5">
      {onBack && (
        <button type="button" onClick={onBack} className="-ml-1 rounded-md p-1 text-zinc-500 hover:bg-zinc-100 dark:hover:bg-zinc-800" aria-label="Back">
          <ArrowLeft className="size-4" />
        </button>
      )}
      <ProviderLogo provider={provider} size="md" />
      Connect {provider.name}
      <ProviderStatusBadge provider={provider} />
    </span>
  );
}

function NotAllowed({ provider, onClose }: { provider: Provider; onClose: () => void }) {
  return (
    <div className="p-6">
      <div className="flex gap-4 rounded-xl bg-zinc-50 p-4 ring-1 ring-zinc-200 dark:bg-zinc-800/40 dark:ring-zinc-800">
        <Lock className="mt-0.5 size-5 shrink-0 text-zinc-400" />
        <div className="text-sm">
          <p className="font-medium text-zinc-900 dark:text-zinc-100">{provider.name} is not available in this workspace</p>
          <p className="mt-1 text-zinc-500">Ask the instance admin to enable it for this workspace.</p>
        </div>
      </div>
      <div className="mt-5 flex justify-end">
        <Button onClick={onClose}>Close</Button>
      </div>
    </div>
  );
}

function ExperimentalDisabled({ provider, onClose }: { provider: Provider; onClose: () => void }) {
  const navigate = useNavigate();
  const canManage = useSession().canInstance("instance.settings.manage");
  return (
    <div className="p-6">
      <div className="flex gap-4 rounded-xl bg-amber-50 p-4 ring-1 ring-amber-200 dark:bg-amber-950/30 dark:ring-amber-900">
        <FlaskConical className="mt-0.5 size-5 shrink-0 text-amber-600" />
        <div className="text-sm">
          <p className="font-medium text-amber-900 dark:text-amber-200">{provider.name} is an experimental integration</p>
          <p className="mt-1 text-amber-800/80 dark:text-amber-200/70">
            {provider.statusNote ? `${provider.statusNote}. ` : ""}
            New connections are off on this instance.{" "}
            {canManage ? "You can turn on experimental integrations in Instance settings." : "Ask an instance admin to turn on experimental integrations."}
          </p>
        </div>
      </div>
      <div className="mt-5 flex justify-end gap-2">
        <Button onClick={onClose}>Close</Button>
        {canManage && (
          <Button
            variant="primary"
            onClick={() => {
              onClose();
              navigate("/admin/settings#integrations");
            }}
          >
            Open Instance settings
          </Button>
        )}
      </div>
    </div>
  );
}

function NeedsSetup({ provider, onClose }: { provider: Provider; onClose: () => void }) {
  const navigate = useNavigate();
  const canConfigure = useSession().canInstance("instance.platforms.manage");
  if (!canConfigure) {
    return (
      <div className="p-6">
        <div className="flex gap-4 rounded-xl bg-amber-50 p-4 ring-1 ring-amber-200 dark:bg-amber-950/30 dark:ring-amber-900">
          <Settings2 className="mt-0.5 size-5 shrink-0 text-amber-600" />
          <div className="text-sm">
            <p className="font-medium text-amber-900 dark:text-amber-200">Ask an admin to configure {provider.name}</p>
            <p className="mt-1 text-amber-800/80 dark:text-amber-200/70">
              {provider.name} needs a developer app that an instance admin sets up once on the Platforms page. After that, you can connect your accounts here.
            </p>
          </div>
        </div>
        <div className="mt-5 flex justify-end">
          <Button onClick={onClose}>Close</Button>
        </div>
      </div>
    );
  }
  return (
    <div className="p-6">
      <div className="flex gap-4 rounded-xl bg-amber-50 p-4 ring-1 ring-amber-200 dark:bg-amber-950/30 dark:ring-amber-900">
        <Settings2 className="mt-0.5 size-5 shrink-0 text-amber-600" />
        <div className="text-sm">
          <p className="font-medium text-amber-900 dark:text-amber-200">{provider.name} needs a developer app first</p>
          <p className="mt-1 text-amber-800/80 dark:text-amber-200/70">
            Create an app on {provider.name}'s developer portal and paste its credentials on the Platforms page. It takes a few minutes and is only needed once.
          </p>
        </div>
      </div>
      <div className="mt-5 flex justify-end gap-2">
        <Button onClick={onClose}>Not now</Button>
        <Button
          variant="primary"
          onClick={() => {
            onClose();
            navigate(`/platforms/${provider.id}`);
          }}
        >
          Set up {provider.name}
        </Button>
      </div>
    </div>
  );
}

function CredentialsForm({ provider, onDone }: { provider: Provider; onDone: () => void }) {
  const [values, setValues] = useState<Record<string, unknown>>(() => defaultValues(provider.credentialFields));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [touched, setTouched] = useState(false);
  const toast = useToast();
  const errors = fieldErrors(provider.credentialFields, values);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setTouched(true);
    if (Object.keys(errors).length) return;
    setBusy(true);
    setError(null);
    try {
      const strValues = Object.fromEntries(Object.entries(values).map(([k, v]) => [k, Array.isArray(v) ? v.join(",") : v === undefined ? "" : String(v)]));
      const { ids } = await api.connect.credentials(provider.id, strValues);
      toast.success(`${provider.name} connected`, ids.length > 1 ? `${ids.length} accounts added` : undefined);
      invalidate("accounts");
      onDone();
    } catch (err) {
      if (!isPlanLimit(err)) setError((err as Error).message); // plan limits: PlanLimitDialog
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={submit}>
      <div className="space-y-5 p-6">
        {provider.id === "buffer" && (
          <div className="rounded-xl border border-brand-500/30 bg-brand-50/70 p-4 text-xs text-brand-950 dark:border-brand-500/40 dark:bg-brand-950/30 dark:text-brand-200">
            <div className="flex items-center gap-2 text-sm font-semibold text-brand-900 dark:text-brand-100">
              <Sparkles className="size-4 text-brand-600 dark:text-brand-400" />
              Unified Social Media Connector
            </div>
            <p className="mt-1 leading-relaxed">
              Postflare connects to all your social networks through Buffer. When you connect a Buffer account, all its channels (Instagram, Facebook, X, TikTok, YouTube, Threads, LinkedIn, Pinterest) are automatically discovered and made available for scheduling and publishing.
            </p>
            <div className="mt-2 text-zinc-600 dark:text-zinc-400">
              <strong className="text-zinc-800 dark:text-zinc-200">Multi-Account Tip:</strong> Assign a unique Account Tag (e.g. <span className="font-mono text-brand-700 dark:text-brand-300">brand-alpha</span>, <span className="font-mono text-brand-700 dark:text-brand-300">client-main</span>). You can connect and manage up to 50 distinct Buffer accounts with independent channel selection.
            </div>
          </div>
        )}
        {provider.setupNotes && (
          <div className="rounded-xl bg-zinc-50 p-4 ring-1 ring-zinc-200 dark:bg-zinc-800/40 dark:ring-zinc-800">
            <Markdown source={provider.setupNotes} vars={{ redirectUri: provider.redirectUri, baseUrl: new URL(provider.redirectUri).origin }} />
          </div>
        )}
        <SettingsForm
          className="!grid-cols-1"
          fields={provider.credentialFields}
          values={values}
          onChange={(k, v) => setValues((s) => ({ ...s, [k]: v }))}
          errors={errors}
          showErrors={touched}
        />
        {error && <p className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700 ring-1 ring-red-200 dark:bg-red-950/40 dark:text-red-300 dark:ring-red-900">{error}</p>}
        <p className="flex items-center gap-1.5 text-xs text-zinc-500">
          <KeyRound className="size-3.5" /> Credentials are verified with {provider.name} and stored encrypted.
        </p>
      </div>
      <div className={cn("flex justify-end gap-2 border-t border-zinc-200 bg-zinc-50/60 px-5 py-3 dark:border-zinc-800 dark:bg-zinc-900")}>
        <Button onClick={onDone}>Cancel</Button>
        <Button type="submit" variant="primary" loading={busy}>
          Connect
        </Button>
      </div>
    </form>
  );
}
