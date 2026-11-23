import { useState, useEffect, type FormEvent } from "react";
import { Dialog } from "../ui/Dialog";
import { Button } from "../ui/Button";
import { Field, Input } from "../ui/Form";
import { useToast } from "../ui/Toast";
import { api, errorMessage } from "../../lib/api";
import { invalidate } from "../../lib/useFetch";
import type { AccountDTO } from "../../lib/types";

export function EditAccountDialog({
  open,
  account,
  onClose,
}: {
  open: boolean;
  account: AccountDTO | null;
  onClose: () => void;
}) {
  const toast = useToast();
  const [name, setName] = useState("");
  const [tag, setTag] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (account) {
      setName(account.name ?? "");
      setTag(account.tag ?? account.username ?? "");
      setApiKey("");
      setSaving(false);
      setError(null);
    }
  }, [account, open]);

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    if (!account || saving) return;

    const trimmedName = name.trim();
    if (!trimmedName) {
      setError("Account name is required");
      return;
    }

    setSaving(true);
    setError(null);

    try {
      await api.accounts.update(account.id, {
        name: trimmedName,
        tag: tag.trim() || undefined,
        apiKey: apiKey.trim() || undefined,
      });

      toast.success("Account updated", `${trimmedName} details have been saved.`);
      invalidate("accounts");
      onClose();
    } catch (err) {
      const msg = errorMessage(err);
      setError(msg);
      toast.error(err);
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title="Edit Account"
      description={account ? `Update details and credentials for ${account.name}` : undefined}
    >
      <form onSubmit={handleSubmit}>
        <div className="space-y-4 p-5">
          {error && (
            <div className="rounded-lg bg-red-50 p-3 text-sm text-red-700 dark:bg-red-950/40 dark:text-red-300">
              {error}
            </div>
          )}

          <Field label="Account Name" required>
            {(id) => (
              <Input
                id={id}
                data-autofocus
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="e.g. Acme Marketing"
                required
              />
            )}
          </Field>

          <Field
            label={account?.provider === "buffer" ? "Account Tag" : "Username / Tag"}
            help="Unique identifier used across Postflare, multi-account filters, and calendar posts."
          >
            {(id) => (
              <Input
                id={id}
                value={tag}
                onChange={(e) => setTag(e.target.value)}
                placeholder="e.g. brand-instagram"
              />
            )}
          </Field>

          <Field
            label="API Token / Key (optional)"
            help="Leave blank to keep existing token. Enter a new token to rotate credentials."
          >
            {(id) => (
              <Input
                id={id}
                type="password"
                value={apiKey}
                onChange={(e) => setApiKey(e.target.value)}
                placeholder="•••••••••••••••• (leave blank to keep current key)"
                autoComplete="new-password"
              />
            )}
          </Field>
        </div>

        <div className="flex items-center justify-end gap-2 border-t border-zinc-200 bg-zinc-50/60 px-5 py-3 dark:border-zinc-800 dark:bg-zinc-900">
          <Button variant="ghost" type="button" onClick={onClose} disabled={saving}>
            Cancel
          </Button>
          <Button variant="primary" type="submit" loading={saving} disabled={saving || !name.trim()}>
            Save Changes
          </Button>
        </div>
      </form>
    </Dialog>
  );
}
