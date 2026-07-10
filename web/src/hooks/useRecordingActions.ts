import { useQueryClient } from "@tanstack/react-query";
import { api } from "../api.js";
import { useToast } from "../components/Toast.js";
import { useConfirm } from "../components/ConfirmDialog.js";

/**
 * Shared trash/restore/purge actions with confirmation dialogs, toasts, and
 * query invalidation. Each returns true on success so callers can chain
 * navigation or refetches.
 */
export function useRecordingActions(): {
  moveToTrash: (id: string) => Promise<boolean>;
  restore: (id: string) => Promise<boolean>;
  purgeNow: (id: string, filename?: string) => Promise<boolean>;
  bulkMoveToTrash: (ids: string[]) => Promise<boolean>;
  bulkRestore: (ids: string[]) => Promise<boolean>;
  bulkPurge: (ids: string[]) => Promise<boolean>;
} {
  const qc = useQueryClient();
  const toast = useToast();
  const confirm = useConfirm();

  const invalidateLists = async (id: string): Promise<void> => {
    await qc.invalidateQueries({ queryKey: ["recordings"] });
    await qc.invalidateQueries({ queryKey: ["recordings-trash"] });
    await qc.invalidateQueries({ queryKey: ["recording", id] });
  };

  const moveToTrash = async (id: string): Promise<boolean> => {
    const ok = await confirm({
      title: "Move to Trash?",
      message:
        "Local files stay until automatic purge (~7 days). You can restore from Trash until then. Nothing is deleted in Plaud.",
      confirmLabel: "Move to Trash",
      destructive: true,
    });
    if (!ok) return false;
    try {
      await api.deleteRecording(id);
      await invalidateLists(id);
      toast.success("Moved to Trash.");
      return true;
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
      return false;
    }
  };

  const restore = async (id: string): Promise<boolean> => {
    try {
      await api.restoreRecording(id);
      await invalidateLists(id);
      toast.success("Restored from Trash.");
      return true;
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
      return false;
    }
  };

  const purgeNow = async (id: string, filename?: string): Promise<boolean> => {
    const label = filename && filename.length > 120 ? `${filename.slice(0, 117)}…` : filename;
    const ok = await confirm({
      title: "Permanently delete this recording?",
      message: `${label ? `${label}\n\n` : ""}Local files will be removed immediately and the Plaud id will be added to the sync blocklist (same as after the 7-day wait). This cannot be undone.`,
      confirmLabel: "Delete permanently",
      destructive: true,
    });
    if (!ok) return false;
    try {
      await api.purgeRecordingFromTrash(id);
      await invalidateLists(id);
      await qc.invalidateQueries({ queryKey: ["sync-blocklist"] });
      toast.success("Permanently deleted.");
      return true;
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
      return false;
    }
  };

  /** Run an action over many ids, reporting one summary toast at the end. */
  const runBulk = async (
    ids: string[],
    action: (id: string) => Promise<unknown>,
    successLabel: string,
  ): Promise<boolean> => {
    let okCount = 0;
    let firstError: string | null = null;
    for (const id of ids) {
      try {
        await action(id);
        okCount++;
      } catch (err) {
        if (!firstError) firstError = err instanceof Error ? err.message : String(err);
      }
    }
    await qc.invalidateQueries({ queryKey: ["recordings"] });
    await qc.invalidateQueries({ queryKey: ["recordings-trash"] });
    await qc.invalidateQueries({ queryKey: ["sync-blocklist"] });
    if (okCount === ids.length) {
      toast.success(`${okCount} recording${okCount === 1 ? "" : "s"} ${successLabel}.`);
      return true;
    }
    toast.error(
      `${okCount}/${ids.length} succeeded — first failure: ${firstError ?? "unknown error"}`,
    );
    return false;
  };

  const bulkMoveToTrash = async (ids: string[]): Promise<boolean> => {
    if (ids.length === 0) return false;
    const ok = await confirm({
      title: `Move ${ids.length} recording${ids.length === 1 ? "" : "s"} to Trash?`,
      message:
        "Local files stay until automatic purge (~7 days). You can restore from Trash until then. Nothing is deleted in Plaud.",
      confirmLabel: "Move to Trash",
      destructive: true,
    });
    if (!ok) return false;
    return runBulk(ids, (id) => api.deleteRecording(id), "moved to Trash");
  };

  const bulkRestore = async (ids: string[]): Promise<boolean> => {
    if (ids.length === 0) return false;
    return runBulk(ids, (id) => api.restoreRecording(id), "restored");
  };

  const bulkPurge = async (ids: string[]): Promise<boolean> => {
    if (ids.length === 0) return false;
    const ok = await confirm({
      title: `Permanently delete ${ids.length} recording${ids.length === 1 ? "" : "s"}?`,
      message:
        "Local files will be removed immediately and the Plaud ids will be added to the sync blocklist. This cannot be undone.",
      confirmLabel: "Delete permanently",
      destructive: true,
    });
    if (!ok) return false;
    return runBulk(ids, (id) => api.purgeRecordingFromTrash(id), "permanently deleted");
  };

  return { moveToTrash, restore, purgeNow, bulkMoveToTrash, bulkRestore, bulkPurge };
}
