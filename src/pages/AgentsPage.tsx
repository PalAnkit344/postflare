import { useEffect, useState } from "react";
import { Link } from "react-router";
import {
  AlertTriangle,
  Bot,
  CheckCircle2,
  Copy,
  ExternalLink,
  Eye,
  EyeOff,
  KeyRound,
  Play,
  RefreshCw,
  RotateCcw,
  Sparkles,
  Video,
  XCircle,
} from "lucide-react";
import { Button } from "../components/ui/Button";
import { Card, Badge, PageHeader, Skeleton } from "../components/ui/Misc";
import { Field, Input, Select } from "../components/ui/Form";
import { useToast } from "../components/ui/Toast";
import { api } from "../lib/api";
import { useSession } from "../lib/session";
import { cn } from "../lib/format";

const OPENROUTER_MODELS = [
  { value: "anthropic/claude-3.5-sonnet", label: "Claude 3.5 Sonnet (Recommended)" },
  { value: "meta-llama/llama-3.3-70b-instruct", label: "Llama 3.3 70B Instruct" },
  { value: "openai/gpt-4o-mini", label: "GPT-4o Mini" },
  { value: "google/gemini-2.0-flash-001", label: "Gemini 2.0 Flash" },
  { value: "deepseek/deepseek-chat", label: "DeepSeek V3" },
];

export function AgentsPage() {
  const session = useSession();
  const toast = useToast();
  const canManage = session.can("posts.write");

  // OpenRouter state
  const [orConfig, setOrConfig] = useState<{
    configured: boolean;
    defaultModel: string;
    maskedKey: string | null;
    updatedAt: number | null;
  } | null>(null);
  const [apiKeyInput, setApiKeyInput] = useState("");
  const [selectedModel, setSelectedModel] = useState("anthropic/claude-3.5-sonnet");
  const [showKey, setShowKey] = useState(false);
  const [testingKey, setTestingKey] = useState(false);
  const [savingKey, setSavingKey] = useState(false);
  const [testResult, setTestResult] = useState<{ ok: boolean; message: string; label?: string } | null>(null);

  // CloudReel state
  const [jobs, setJobs] = useState<any[]>([]);
  const [loadingJobs, setLoadingJobs] = useState(true);
  const [processingDue, setProcessingDue] = useState(false);
  const [statusFilter, setStatusFilter] = useState<string>("all");
  const [actionBusy, setActionBusy] = useState<string | null>(null);

  // Load OpenRouter config
  const loadOrConfig = async () => {
    try {
      const res = await api.openrouter.getConfig();
      setOrConfig(res);
      if (res.defaultModel) setSelectedModel(res.defaultModel);
    } catch {
      // ignore
    }
  };

  // Load CloudReel jobs
  const loadJobs = async () => {
    setLoadingJobs(true);
    try {
      const filter = statusFilter === "all" ? undefined : statusFilter;
      const res = await api.cloudreel.listJobs({ status: filter, limit: 50 });
      setJobs(res.jobs || []);
    } catch (err) {
      console.error(err);
    } finally {
      setLoadingJobs(false);
    }
  };

  useEffect(() => {
    loadOrConfig();
    loadJobs();
  }, [statusFilter]);

  // Test OpenRouter Connection
  const handleTestOpenRouter = async () => {
    setTestingKey(true);
    setTestResult(null);
    try {
      const res = await api.openrouter.test(apiKeyInput.trim() || undefined);
      setTestResult(res);
      if (res.ok) {
        toast.success("OpenRouter Connected!", res.message);
      } else {
        toast.error("Connection Failed", res.message);
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setTestResult({ ok: false, message: msg });
      toast.error("OpenRouter Test Error", msg);
    } finally {
      setTestingKey(false);
    }
  };

  // Save OpenRouter configuration
  const handleSaveOpenRouter = async () => {
    if (!apiKeyInput.trim() && !orConfig?.configured) {
      toast.error("Please enter an OpenRouter API key");
      return;
    }
    setSavingKey(true);
    try {
      const res = await api.openrouter.saveConfig({
        apiKey: apiKeyInput.trim(),
        defaultModel: selectedModel,
      });
      toast.success("OpenRouter configuration saved");
      setOrConfig(res.config);
      setApiKeyInput("");
      setTestResult(null);
    } catch (err) {
      toast.error("Failed to save OpenRouter config", err instanceof Error ? err.message : String(err));
    } finally {
      setSavingKey(false);
    }
  };

  // Disconnect OpenRouter
  const handleDisconnectOpenRouter = async () => {
    try {
      await api.openrouter.disconnect();
      toast.success("OpenRouter disconnected");
      setOrConfig({ configured: false, defaultModel: "anthropic/claude-3.5-sonnet", maskedKey: null, updatedAt: null });
      setApiKeyInput("");
      setTestResult(null);
    } catch (err) {
      toast.error("Failed to disconnect", err instanceof Error ? err.message : String(err));
    }
  };

  // Process Due CloudReel Jobs
  const handleProcessDue = async () => {
    setProcessingDue(true);
    try {
      const res = await api.cloudreel.processDue();
      const { result } = res;
      toast.success(
        "CloudReel Batch Processed",
        `Discovered: ${result.discovered}, Claimed: ${result.claimed}, Published: ${result.published}, Review: ${result.reviewRequired}`,
      );
      await loadJobs();
    } catch (err) {
      toast.error("Process due jobs failed", err instanceof Error ? err.message : String(err));
    } finally {
      setProcessingDue(false);
    }
  };

  // Approve a job
  const handleApprove = async (jobId: string) => {
    setActionBusy(jobId);
    try {
      await api.cloudreel.approveJob(jobId);
      toast.success("Job approved for publishing");
      await loadJobs();
    } catch (err) {
      toast.error("Approval failed", err instanceof Error ? err.message : String(err));
    } finally {
      setActionBusy(null);
    }
  };

  // Retry a job
  const handleRetry = async (jobId: string) => {
    setActionBusy(jobId);
    try {
      await api.cloudreel.retryJob(jobId);
      toast.success("Job reset to READY for retry");
      await loadJobs();
    } catch (err) {
      toast.error("Retry failed", err instanceof Error ? err.message : String(err));
    } finally {
      setActionBusy(null);
    }
  };

  const copyToClipboard = (text: string, label: string) => {
    navigator.clipboard.writeText(text);
    toast.success(`Copied ${label} to clipboard`);
  };

  // Stats
  const totalJobs = jobs.length;
  const readyJobs = jobs.filter((j) => j.status === "READY" || j.status === "QUEUED").length;
  const publishedJobs = jobs.filter((j) => j.status === "PUBLISHED").length;
  const reviewJobs = jobs.filter((j) => j.status === "REVIEW_REQUIRED").length;
  const failedJobs = jobs.filter((j) => j.status === "FAILED").length;

  return (
    <>
      <PageHeader
        title="AI Agents & Automation"
        description="Connect OpenRouter LLMs, configure external Video Agents, and monitor the CloudReel central scheduler."
      />

      <div className="space-y-6">
        {/* ============================================================ */}
        {/* 1. OpenRouter Integration Section                             */}
        {/* ============================================================ */}
        <Card className="p-6">
          <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
            <div className="flex items-start gap-3">
              <div className="flex size-10 shrink-0 items-center justify-center rounded-xl bg-purple-50 text-purple-600 dark:bg-purple-950/40 dark:text-purple-400">
                <Sparkles className="size-5" />
              </div>
              <div>
                <div className="flex items-center gap-2">
                  <h3 className="text-base font-semibold text-zinc-900 dark:text-zinc-100">
                    OpenRouter AI Connection
                  </h3>
                  {orConfig?.configured ? (
                    <Badge tone="green" dot>
                      Connected
                    </Badge>
                  ) : (
                    <Badge tone="zinc">Not Connected</Badge>
                  )}
                </div>
                <p className="mt-1 text-xs text-zinc-500 dark:text-zinc-400 max-w-xl">
                  Connect your OpenRouter API key so AI agents can generate video captions, optimize scheduling times,
                  and manage social multi-account publishing.
                </p>
              </div>
            </div>

            {orConfig?.configured && canManage && (
              <Button size="sm" variant="ghost" onClick={handleDisconnectOpenRouter} className="text-red-600 hover:text-red-700">
                Disconnect Key
              </Button>
            )}
          </div>

          <div className="mt-6 border-t border-zinc-100 pt-5 dark:border-zinc-800">
            <div className="grid gap-4 sm:grid-cols-2">
              <Field
                label="OpenRouter API Key"
                help={
                  orConfig?.configured && orConfig.maskedKey
                    ? `Current active key: ${orConfig.maskedKey} (Leave blank to keep current)`
                    : "Obtain an API key from openrouter.ai/keys"
                }
              >
                {() => (
                  <div className="relative">
                    <Input
                      type={showKey ? "text" : "password"}
                      value={apiKeyInput}
                      onChange={(e) => setApiKeyInput(e.target.value)}
                      placeholder={orConfig?.configured ? "••••••••••••••••••••••••••••••••" : "sk-or-v1-..."}
                      className="pr-10 font-mono text-xs"
                      disabled={!canManage}
                    />
                    <button
                      type="button"
                      onClick={() => setShowKey(!showKey)}
                      className="absolute right-2.5 top-1/2 -translate-y-1/2 text-zinc-400 hover:text-zinc-600 dark:hover:text-zinc-200"
                    >
                      {showKey ? <EyeOff className="size-4" /> : <Eye className="size-4" />}
                    </button>
                  </div>
                )}
              </Field>

              <Field label="Default Agent Model" help="LLM used for caption generation and scheduler intelligence">
                {() => (
                  <Select
                    value={selectedModel}
                    onChange={(e) => setSelectedModel(e.target.value)}
                    disabled={!canManage}
                  >
                    {OPENROUTER_MODELS.map((m) => (
                      <option key={m.value} value={m.value}>
                        {m.label}
                      </option>
                    ))}
                  </Select>
                )}
              </Field>
            </div>

            {testResult && (
              <div
                className={cn(
                  "mt-4 flex items-center gap-2 rounded-lg p-3 text-xs",
                  testResult.ok
                    ? "bg-emerald-50 text-emerald-800 dark:bg-emerald-950/40 dark:text-emerald-300"
                    : "bg-red-50 text-red-800 dark:bg-red-950/40 dark:text-red-300",
                )}
              >
                {testResult.ok ? <CheckCircle2 className="size-4 shrink-0" /> : <XCircle className="size-4 shrink-0" />}
                <span className="font-medium">{testResult.message}</span>
                {testResult.label && <span className="text-zinc-500">({testResult.label})</span>}
              </div>
            )}

            {canManage && (
              <div className="mt-4 flex flex-wrap items-center gap-2">
                <Button
                  variant="primary"
                  size="sm"
                  loading={savingKey}
                  onClick={handleSaveOpenRouter}
                  disabled={!apiKeyInput.trim() && !orConfig?.configured}
                >
                  Save Configuration
                </Button>
                <Button
                  variant="secondary"
                  size="sm"
                  loading={testingKey}
                  onClick={handleTestOpenRouter}
                  disabled={!apiKeyInput.trim() && !orConfig?.configured}
                >
                  Test Connection
                </Button>
              </div>
            )}
          </div>
        </Card>

        {/* ============================================================ */}
        {/* 2. Ingestion Gateway & Endpoints Card                        */}
        {/* ============================================================ */}
        <Card className="p-6">
          <div className="flex items-start gap-3">
            <div className="flex size-10 shrink-0 items-center justify-center rounded-xl bg-blue-50 text-blue-600 dark:bg-blue-950/40 dark:text-blue-400">
              <Bot className="size-5" />
            </div>
            <div className="flex-1">
              <h3 className="text-base font-semibold text-zinc-900 dark:text-zinc-100">
                AI Agent Ingestion Endpoints
              </h3>
              <p className="mt-1 text-xs text-zinc-500 dark:text-zinc-400">
                External Video Creator Agents (Runway, Sora, CloudReel) send videos or manifests to these endpoints to
                schedule publishing across your connected social accounts.
              </p>
            </div>
          </div>

          <div className="mt-5 space-y-4">
            <div>
              <div className="flex items-center justify-between text-xs font-medium text-zinc-700 dark:text-zinc-300 mb-1.5">
                <span>Direct Video Ingestion Endpoint (POST)</span>
                <button
                  type="button"
                  onClick={() =>
                    copyToClipboard(
                      `${window.location.origin}/api/v1/agent/posts`,
                      "Ingestion Endpoint URL",
                    )
                  }
                  className="inline-flex items-center gap-1 text-brand-600 hover:underline dark:text-brand-400"
                >
                  <Copy className="size-3" /> Copy URL
                </button>
              </div>
              <div className="flex items-center rounded-lg border border-zinc-200 bg-zinc-50 px-3 py-2 font-mono text-xs dark:border-zinc-800 dark:bg-zinc-900/50">
                <span className="text-emerald-600 font-bold mr-2">POST</span>
                <span className="truncate text-zinc-800 dark:text-zinc-200">
                  {window.location.origin}/api/v1/agent/posts
                </span>
              </div>
            </div>

            <div>
              <div className="flex items-center justify-between text-xs font-medium text-zinc-700 dark:text-zinc-300 mb-1.5">
                <span>CloudReel Shared Manifest Endpoint (POST)</span>
                <button
                  type="button"
                  onClick={() =>
                    copyToClipboard(
                      `${window.location.origin}/api/cloudreel/manifest`,
                      "CloudReel Manifest Endpoint URL",
                    )
                  }
                  className="inline-flex items-center gap-1 text-brand-600 hover:underline dark:text-brand-400"
                >
                  <Copy className="size-3" /> Copy URL
                </button>
              </div>
              <div className="flex items-center rounded-lg border border-zinc-200 bg-zinc-50 px-3 py-2 font-mono text-xs dark:border-zinc-800 dark:bg-zinc-900/50">
                <span className="text-emerald-600 font-bold mr-2">POST</span>
                <span className="truncate text-zinc-800 dark:text-zinc-200">
                  {window.location.origin}/api/cloudreel/manifest
                </span>
              </div>
            </div>

            <div className="flex items-center justify-between rounded-lg bg-zinc-50 p-3 text-xs dark:bg-zinc-800/40">
              <div className="flex items-center gap-2 text-zinc-600 dark:text-zinc-300">
                <KeyRound className="size-4 text-brand-600 dark:text-brand-400" />
                <span>
                  Agents authenticate using workspace API keys (Bearer token: <code>pf_...</code>).
                </span>
              </div>
              <Link to="/profile" className="font-semibold text-brand-600 hover:underline dark:text-brand-400">
                Manage API Keys →
              </Link>
            </div>
          </div>
        </Card>

        {/* ============================================================ */}
        {/* 3. CloudReel Central Video Scheduler & Publisher            */}
        {/* ============================================================ */}
        <Card className="p-6">
          <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
            <div className="flex items-start gap-3">
              <div className="flex size-10 shrink-0 items-center justify-center rounded-xl bg-rose-50 text-rose-600 dark:bg-rose-950/40 dark:text-rose-400">
                <Video className="size-5" />
              </div>
              <div>
                <h3 className="text-base font-semibold text-zinc-900 dark:text-zinc-100">
                  CloudReel Central Video Scheduler
                </h3>
                <p className="mt-1 text-xs text-zinc-500 dark:text-zinc-400">
                  Discovers due video jobs from D1, verifies R2 assets atomically, and publishes to destination social
                  accounts.
                </p>
              </div>
            </div>

            {canManage && (
              <div className="flex items-center gap-2 shrink-0">
                <Button
                  variant="primary"
                  size="sm"
                  icon={<Play className={cn("size-3.5", processingDue && "animate-spin")} />}
                  loading={processingDue}
                  onClick={handleProcessDue}
                >
                  Process Due Jobs Now
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  icon={<RefreshCw className={cn("size-3.5", loadingJobs && "animate-spin")} />}
                  onClick={loadJobs}
                />
              </div>
            )}
          </div>

          {/* Quick Metrics */}
          <div className="mt-6 grid grid-cols-2 gap-3 sm:grid-cols-5">
            <div className="rounded-xl border border-zinc-200 bg-white p-3 text-center dark:border-zinc-800 dark:bg-zinc-900">
              <span className="block text-xl font-bold text-zinc-900 dark:text-zinc-100">{totalJobs}</span>
              <span className="text-xs text-zinc-500">Total Jobs</span>
            </div>
            <div className="rounded-xl border border-blue-100 bg-blue-50/40 p-3 text-center dark:border-blue-900/30 dark:bg-blue-950/20">
              <span className="block text-xl font-bold text-blue-600 dark:text-blue-400">{readyJobs}</span>
              <span className="text-xs text-blue-600 dark:text-blue-400">Ready / Queued</span>
            </div>
            <div className="rounded-xl border border-emerald-100 bg-emerald-50/40 p-3 text-center dark:border-emerald-900/30 dark:bg-emerald-950/20">
              <span className="block text-xl font-bold text-emerald-600 dark:text-emerald-400">{publishedJobs}</span>
              <span className="text-xs text-emerald-600 dark:text-emerald-400">Published</span>
            </div>
            <div className="rounded-xl border border-amber-100 bg-amber-50/40 p-3 text-center dark:border-amber-900/30 dark:bg-amber-950/20">
              <span className="block text-xl font-bold text-amber-600 dark:text-amber-400">{reviewJobs}</span>
              <span className="text-xs text-amber-600 dark:text-amber-400">Review Required</span>
            </div>
            <div className="rounded-xl border border-red-100 bg-red-50/40 p-3 text-center dark:border-red-900/30 dark:bg-red-950/20">
              <span className="block text-xl font-bold text-red-600 dark:text-red-400">{failedJobs}</span>
              <span className="text-xs text-red-600 dark:text-red-400">Failed</span>
            </div>
          </div>

          {/* Filter Bar */}
          <div className="mt-5 flex items-center justify-between gap-2">
            <span className="text-xs font-semibold uppercase tracking-wider text-zinc-500">
              Publishing Jobs ({jobs.length})
            </span>
            <div className="flex items-center gap-1.5">
              {["all", "READY", "PUBLISHED", "REVIEW_REQUIRED", "FAILED"].map((st) => (
                <button
                  key={st}
                  type="button"
                  onClick={() => setStatusFilter(st)}
                  className={cn(
                    "rounded-md px-2 py-1 text-xs font-medium transition cursor-pointer",
                    statusFilter === st
                      ? "bg-brand-600 text-white"
                      : "bg-zinc-100 text-zinc-600 hover:bg-zinc-200 dark:bg-zinc-800 dark:text-zinc-300 dark:hover:bg-zinc-700",
                  )}
                >
                  {st === "all" ? "All" : st.replace("_", " ")}
                </button>
              ))}
            </div>
          </div>

          {/* Table */}
          <div className="mt-3 overflow-x-auto rounded-xl border border-zinc-200 dark:border-zinc-800">
            {loadingJobs ? (
              <div className="p-6 space-y-3">
                <Skeleton className="h-8 w-full" />
                <Skeleton className="h-8 w-full" />
                <Skeleton className="h-8 w-full" />
              </div>
            ) : jobs.length === 0 ? (
              <div className="p-8 text-center text-xs text-zinc-500">
                No CloudReel publishing jobs found for this filter.
              </div>
            ) : (
              <table className="min-w-full divide-y divide-zinc-200 text-left text-xs dark:divide-zinc-800">
                <thead className="bg-zinc-50 font-medium text-zinc-500 dark:bg-zinc-900 dark:text-zinc-400">
                  <tr>
                    <th className="px-4 py-3">Video Title / ID</th>
                    <th className="px-4 py-3">Destination</th>
                    <th className="px-4 py-3">Scheduled (UTC)</th>
                    <th className="px-4 py-3">Status</th>
                    <th className="px-4 py-3 text-right">Actions</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-zinc-100 dark:divide-zinc-800/60">
                  {jobs.map((job) => {
                    const isDue = job.scheduled_at_epoch <= Date.now();
                    return (
                      <tr key={job.job_id} className="hover:bg-zinc-50/50 dark:hover:bg-zinc-800/30">
                        <td className="px-4 py-3">
                          <div className="font-semibold text-zinc-900 dark:text-zinc-100">
                            {job.title || job.file_name || job.video_id}
                          </div>
                          <div className="font-mono text-[11px] text-zinc-400">{job.video_id}</div>
                          {job.r2_key && (
                            <div className="font-mono text-[10px] text-zinc-400">R2: {job.r2_key}</div>
                          )}
                        </td>
                        <td className="px-4 py-3">
                          <span className="inline-flex items-center rounded-md bg-zinc-100 px-2 py-0.5 font-semibold text-zinc-800 uppercase text-[10px] dark:bg-zinc-800 dark:text-zinc-200">
                            {job.platform}
                          </span>
                          <div className="text-[11px] text-zinc-500 mt-0.5">
                            {job.account_name || job.account_id}
                          </div>
                        </td>
                        <td className="px-4 py-3">
                          <div className={cn("tabular-nums font-mono text-xs", isDue && "text-emerald-600 font-semibold")}>
                            {job.scheduled_at}
                          </div>
                          <div className="text-[10px] text-zinc-400">{job.timezone}</div>
                        </td>
                        <td className="px-4 py-3">
                          {job.status === "PUBLISHED" ? (
                            <Badge tone="green" dot>
                              Published
                            </Badge>
                          ) : job.status === "UPLOADING" ? (
                            <Badge tone="blue" dot>
                              Uploading
                            </Badge>
                          ) : job.status === "REVIEW_REQUIRED" ? (
                            <Badge tone="amber">
                              <AlertTriangle className="size-3" /> Review
                            </Badge>
                          ) : job.status === "FAILED" ? (
                            <Badge tone="red">Failed</Badge>
                          ) : (
                            <Badge tone="zinc">
                              {job.approved ? "Ready" : "Pending Review"}
                            </Badge>
                          )}
                          {job.error_message && (
                            <div className="text-[10px] text-red-500 mt-1 max-w-xs truncate" title={job.error_message}>
                              {job.error_message}
                            </div>
                          )}
                        </td>
                        <td className="px-4 py-3 text-right">
                          <div className="flex items-center justify-end gap-1.5">
                            {!job.approved && canManage && (
                              <Button
                                size="sm"
                                variant="secondary"
                                loading={actionBusy === job.job_id}
                                onClick={() => handleApprove(job.job_id)}
                              >
                                Approve
                              </Button>
                            )}
                            {(job.status === "FAILED" || job.status === "REVIEW_REQUIRED") && canManage && (
                              <Button
                                size="sm"
                                variant="secondary"
                                icon={<RotateCcw className="size-3" />}
                                loading={actionBusy === job.job_id}
                                onClick={() => handleRetry(job.job_id)}
                              >
                                Retry
                              </Button>
                            )}
                            {job.published_url && (
                              <Button
                                size="sm"
                                variant="ghost"
                                icon={<ExternalLink className="size-3" />}
                                onClick={() => window.open(job.published_url, "_blank", "noopener,noreferrer")}
                              >
                                View
                              </Button>
                            )}
                          </div>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            )}
          </div>
        </Card>
      </div>
    </>
  );
}
