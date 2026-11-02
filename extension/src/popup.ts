/**
 * The extension popup: pairing, the recordings Plaud is missing names for,
 * and a dry run of each (plan section 5). Phase 2: nothing is written.
 * Every value is set as text, never as HTML.
 */
import type {
  PlaudWritebackChange,
  PlaudWritebackRecording,
  PlaudWritebackUndoable,
} from "@applaud/shared";
import { normaliseApplaudUrl } from "./applaud.js";
import { MAX_BATCH, type BatchEntry, type BatchState } from "./batch.js";
import type {
  ApplyReply,
  DryRunReply,
  PopupReplies,
  PopupRequest,
  Reply,
  StatusReply,
} from "./messages.js";

async function send<K extends PopupRequest["type"]>(
  req: Extract<PopupRequest, { type: K }>,
): Promise<PopupReplies[K]> {
  const reply = (await chrome.runtime.sendMessage(req)) as Reply<PopupReplies[K]> | undefined;
  if (!reply) throw new Error("The extension didn't answer");
  if (!reply.ok) throw new Error(reply.error);
  return reply.value;
}

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  props: { className?: string; text?: string } = {},
  ...children: (Node | null)[]
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (props.className) node.className = props.className;
  if (props.text !== undefined) node.textContent = props.text;
  for (const c of children) if (c) node.append(c);
  return node;
}

function button(text: string, onClick: () => void, className = "btn"): HTMLButtonElement {
  const b = el("button", { className, text });
  b.type = "button";
  b.addEventListener("click", onClick);
  return b;
}

const root = document.getElementById("app")!;

function show(...nodes: (Node | null)[]): void {
  root.replaceChildren(...nodes.filter((n): n is Node => n !== null));
}

function errorLine(message: string): HTMLElement {
  return el("p", { className: "error", text: message });
}

function browserName(): string {
  const ua = navigator.userAgent;
  if (/Edg\//.test(ua)) return "Edge";
  if (/Brave/.test(ua)) return "Brave";
  if (/Chrome\//.test(ua)) return "Chrome";
  return "Browser";
}

/**
 * Pairing runs in a normal tab, not the toolbar popup: Edge and Chrome close
 * the popup when the permission prompt for Applaud's address appears, which
 * loses what was typed.
 */
const IN_TAB = new URLSearchParams(location.search).has("tab");
if (IN_TAB) document.body.classList.add("tab");

function renderPairing(st: StatusReply | null, error: string | null): void {
  if (!IN_TAB) {
    show(
      el("h1", { text: "Pair with Applaud" }),
      el("p", {
        className: "muted",
        text: "Pairing opens in a tab, because your browser will ask permission for the extension to reach Applaud.",
      }),
      button(
        "Pair with Applaud",
        () => {
          void chrome.tabs
            .create({ url: chrome.runtime.getURL("popup.html?tab=1") })
            .then(() => window.close());
        },
        "btn primary",
      ),
      error ? errorLine(error) : null,
    );
    return;
  }
  const address = el("input");
  address.placeholder = "http://192.168.1.20:44471";
  address.value = st?.applaudUrl ?? "";
  const code = el("input");
  code.placeholder = "ABCD-EFGH";
  code.autocomplete = "off";
  const message = el("div");
  const pairButton = button(
    "Pair",
    () => {
      const origin = normaliseApplaudUrl(address.value);
      if (!origin) {
        message.replaceChildren(
          errorLine("Enter Applaud's address, for example http://192.168.1.20:44471"),
        );
        return;
      }
      pairButton.disabled = true;
      // Asked on the click itself: only Applaud's own address, nothing wider (W9).
      chrome.permissions
        .request({ origins: [`${origin}/*`] })
        .then((granted) => {
          if (!granted) throw new Error(`The extension needs permission to reach ${origin}`);
          return send({
            type: "pair",
            applaudUrl: origin,
            code: code.value,
            name: `${browserName()} extension`,
          });
        })
        .then(
          (paired) => {
            if (!paired.paired) {
              renderMain(paired);
              return;
            }
            show(
              el("h1", { text: "Paired" }),
              el("p", {
                className: "ok",
                text: `The extension is paired with ${paired.applaudUrl}. Close this tab and use the Applaud button in the toolbar.`,
              }),
              button("Close this tab", () => window.close(), "btn primary"),
            );
          },
          (err: unknown) => {
            pairButton.disabled = false;
            message.replaceChildren(errorLine(err instanceof Error ? err.message : String(err)));
          },
        );
    },
    "btn primary",
  );
  show(
    el("h1", { text: "Pair with Applaud" }),
    el("p", {
      className: "muted",
      text: "In Applaud, open Settings → Speaker identification → Send names to Plaud, choose Pair an extension, and enter the code here.",
    }),
    el("label", { text: "Applaud address" }, address),
    el("label", { text: "Pairing code" }, code),
    pairButton,
    message,
    error ? errorLine(error) : null,
  );
}

function changeLine(c: PlaudWritebackChange): HTMLElement {
  const where = c.segment
    ? `${Math.floor(c.segment.startMs / 60000)}:${String(Math.floor((c.segment.startMs % 60000) / 1000)).padStart(2, "0")} `
    : "";
  const count = c.segment ? "" : ` · ${c.segments} line${c.segments === 1 ? "" : "s"}`;
  return el("li", { text: `${where}${c.from} → ${c.to}${count}` });
}

const KIND_NAME = { transcript: "transcript", polished: "polished transcript", summary: "summary" };

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** A button that asks once more before it acts. */
function confirmButton(
  text: string,
  confirmText: string,
  act: (b: HTMLButtonElement) => void,
): HTMLButtonElement {
  let armed = false;
  const b = button(text, () => {
    if (!armed) {
      armed = true;
      b.textContent = confirmText;
      return;
    }
    act(b);
  });
  return b;
}

function renderUndo(target: HTMLElement, recordingId: string): HTMLButtonElement {
  return confirmButton("Undo", "Confirm undo", (b) => {
    b.disabled = true;
    target.replaceChildren(
      el("p", { className: "muted", text: "Restoring Plaud's previous version…" }),
    );
    send({ type: "undo", recordingId }).then(
      (reply) => renderApply(target, reply, recordingId, true),
      (err: unknown) => target.replaceChildren(errorLine(message(err))),
    );
  });
}

function renderApply(
  target: HTMLElement,
  r: ApplyReply,
  recordingId: string,
  isUndo = false,
): void {
  const parts: Node[] = [];
  if (r.status === "applied") {
    parts.push(
      el("p", {
        className: "ok",
        text: isUndo
          ? "Plaud is back as it was before the last send. Applaud will list these names again after its next sync."
          : `Sent: ${r.results.map((x) => KIND_NAME[x.kind]).join(", ")}. Applaud's next sync confirms it in Plaud.`,
      }),
    );
  } else if (r.status === "nothing") {
    parts.push(el("p", { className: "ok", text: r.reason ?? "Plaud already has these names." }));
  } else if (r.status === "stale") {
    parts.push(
      errorLine(
        `Nothing was written: ${r.reason ?? "Plaud changed since Applaud last synced"}. Try again after Applaud's next sync.`,
      ),
    );
  } else {
    const done = r.results.filter((x) => x.outcome === "applied").map((x) => KIND_NAME[x.kind]);
    parts.push(
      errorLine(
        `${r.status === "partial" ? `Stopped part-way after the ${done.join(", ")}` : "Nothing was written"}${r.reason ? `: ${r.reason}` : ""}. ${isUndo ? "Undo again to finish." : "Sending again completes it."}`,
      ),
    );
  }
  if (!r.reported) {
    parts.push(
      errorLine(
        "Applaud couldn't be told about this. The extension keeps the result and tells Applaud next time it can.",
      ),
    );
  }
  if (!isUndo && (r.status === "applied" || r.status === "partial"))
    parts.push(renderUndo(target, recordingId));
  target.replaceChildren(...parts);
}

function renderDryRun(
  target: HTMLElement,
  r: DryRunReply,
  recordingId: string,
  canWrite: boolean,
): void {
  const { plan, warnings } = r;
  const parts: Node[] = [];
  if (plan.status === "stale") {
    parts.push(
      errorLine(
        `Not ready: ${plan.reason ?? "Plaud changed since Applaud last synced"}. Try again after Applaud's next sync.`,
      ),
    );
  } else if (plan.status === "nothing") {
    parts.push(el("p", { className: "ok", text: plan.reason ?? "Plaud already has these names." }));
  } else {
    const docs = plan.documents.map(
      (d) =>
        ({ transcript: "transcript", polished: "polished transcript", summary: "summary" })[d.kind],
    );
    parts.push(
      el("p", {
        className: "ok",
        text: `Would change ${plan.changedSegments} line${plan.changedSegments === 1 ? "" : "s"}${
          plan.summaryReplacements
            ? ` and ${plan.summaryReplacements} mention${plan.summaryReplacements === 1 ? "" : "s"} in the summary`
            : ""
        }, writing the ${docs.join(", ")}.`,
      }),
      el("ul", {}, ...plan.changes.map(changeLine)),
    );
    if (canWrite) {
      const go = button(
        "Send to Plaud",
        () => {
          go.disabled = true;
          target.replaceChildren(el("p", { className: "muted", text: "Sending to Plaud…" }));
          send({ type: "apply", recordingId }).then(
            (reply) => renderApply(target, reply, recordingId),
            (err: unknown) => target.replaceChildren(errorLine(message(err))),
          );
        },
        "btn primary",
      );
      parts.push(go);
    }
  }
  for (const w of warnings) parts.push(el("p", { className: "muted", text: w }));
  target.replaceChildren(...parts);
}

function recordingItem(
  r: PlaudWritebackRecording,
  plaudTab: boolean,
  canWrite: boolean,
): HTMLElement {
  const result = el("div", { className: "result" });
  const run = button("Dry run", () => {
    run.disabled = true;
    result.replaceChildren(el("p", { className: "muted", text: "Reading Plaud…" }));
    send({ type: "dryRun", recordingId: r.recordingId }).then(
      (reply) => {
        run.disabled = false;
        renderDryRun(result, reply, r.recordingId, canWrite);
      },
      (err: unknown) => {
        run.disabled = false;
        result.replaceChildren(errorLine(err instanceof Error ? err.message : String(err)));
      },
    );
  });
  run.disabled = !plaudTab;
  const state =
    r.state === "sent"
      ? " · sent, awaiting sync"
      : r.state === "partial"
        ? " · stopped part-way"
        : r.state === "stale"
          ? " · changed in Plaud"
          : "";
  return el(
    "li",
    { className: "recording" },
    el(
      "div",
      { className: "row" },
      el(
        "div",
        {},
        el("strong", { text: r.title }),
        el("span", {
          className: "muted",
          text: ` · ${r.pendingSegments} line${r.pendingSegments === 1 ? "" : "s"}${state}`,
        }),
      ),
      el(
        "div",
        { className: "actions" },
        run,
        // A send that went through can be undone from here until Applaud's sync confirms it.
        canWrite && (r.state === "sent" || r.state === "partial")
          ? renderUndo(result, r.recordingId)
          : null,
      ),
    ),
    result,
  );
}

function renderMain(st: StatusReply): void {
  if (!st.paired) {
    renderPairing(st, null);
    return;
  }
  const header = el(
    "div",
    { className: "row" },
    el("h1", { text: "Names to send to Plaud" }),
    button(
      "Unpair",
      () => {
        send({ type: "unpair" }).then(
          (s) => renderPairing(s, null),
          (err: unknown) => show(errorLine(String(err))),
        );
      },
      "link",
    ),
  );
  const facts: Node[] = [el("p", { className: "muted", text: `Applaud: ${st.applaudUrl}` })];
  if (st.error) facts.push(errorLine(st.error));
  else if (st.applaud && !st.applaud.speakersEnabled)
    facts.push(errorLine("Speaker identification is off in Applaud."));
  else if (st.applaud && !st.applaud.enabled)
    facts.push(
      errorLine("Sending names to Plaud is off in Applaud (Settings → Speaker identification)."),
    );
  if (!st.plaudTab)
    facts.push(errorLine("Open Plaud (web.plaud.ai) in a tab and sign in to check recordings."));

  const diagnosis = el("div");
  const check = button(
    "Check the Plaud tab",
    () => {
      send({ type: "diagnose" }).then(
        (d) =>
          diagnosis.replaceChildren(
            el("p", {
              className: "muted",
              text: `Signed in: ${d.signedIn ? `yes (${d.tokenSource})` : "no"} · API: ${d.apiOrigin ?? "not found"} · device id: ${d.deviceId ? "found" : "not found"} · workspace: ${d.workspace ? "found" : "not found"}`,
            }),
            el("p", {
              className: "muted",
              text: `Storage keys: ${d.relevantKeys.join(", ") || "none"}`,
            }),
          ),
        (err: unknown) =>
          diagnosis.replaceChildren(errorLine(err instanceof Error ? err.message : String(err))),
      );
    },
    "link",
  );
  check.disabled = !st.plaudTab;

  const list = el(
    "ul",
    { className: "recordings" },
    el("li", { className: "muted", text: "Loading…" }),
  );
  if (st.unreported > 0) {
    facts.push(
      errorLine(
        `${st.unreported} earlier result${st.unreported === 1 ? "" : "s"} still to be recorded in Applaud.`,
      ),
    );
  }
  const recent = el("div");
  const batchBox = el("div");
  const canWrite = st.plaudTab && st.applaud?.enabled === true;
  show(
    header,
    ...facts,
    batchBox,
    recent,
    list,
    el("p", {
      className: "muted small",
      text: "Dry run shows exactly what would change. Nothing is written to Plaud until you choose Send to Plaud or Send all.",
    }),
    check,
    diagnosis,
  );
  if (st.error || !st.applaud) {
    list.replaceChildren();
    return;
  }
  send({ type: "pending" }).then(
    (recordings) => {
      list.replaceChildren(
        ...(recordings.length === 0
          ? [el("li", { className: "muted", text: "Plaud has every name you have confirmed." })]
          : recordings.map((r) => recordingItem(r, st.plaudTab, canWrite))),
      );
      void showBatch(batchBox, recordings, canWrite, st);
    },
    (err: unknown) =>
      list.replaceChildren(errorLine(err instanceof Error ? err.message : String(err))),
  );
  send({ type: "undoable" }).then(
    (items) => renderRecent(recent, items, st.plaudTab && st.applaud?.enabled === true),
    (err: unknown) =>
      recent.replaceChildren(errorLine(`Couldn't load recently sent recordings: ${message(err)}`)),
  );
}

const ENTRY_TEXT: Record<BatchEntry["status"], string> = {
  applied: "sent",
  partial: "stopped part-way",
  stale: "skipped: changed in Plaud since Applaud's last sync",
  nothing: "skipped: Plaud already has these names",
  failed: "not sent",
  error: "not sent",
};

function entryLine(e: BatchEntry): HTMLElement {
  const ok = e.status === "applied";
  const reason =
    e.reason && !ok && e.status !== "stale" && e.status !== "nothing" ? `: ${e.reason}` : "";
  return el("li", {
    className: ok ? "" : e.status === "stale" || e.status === "nothing" ? "muted" : "error",
    text: `${e.title} · ${ENTRY_TEXT[e.status]}${reason}`,
  });
}

/** Where the batch stands: progress while it runs, the outcome after. */
function renderBatchState(target: HTMLElement, state: BatchState, onDone: () => void): void {
  const sent = state.done.filter((e) => e.status === "applied").length;
  const skipped = state.done.filter((e) => e.status === "stale" || e.status === "nothing").length;
  const failed = state.done.length - sent - skipped;
  const parts: (Node | null)[] = [];
  if (state.running) {
    const at = Math.min(state.done.length + 1, state.items.length);
    parts.push(
      el("p", {
        className: "ok",
        text: `Sending ${at} of ${state.items.length}${state.current ? `: ${state.current.title}` : ""}…`,
      }),
      el("p", { className: "muted small", text: "You can close this popup; sending carries on." }),
      button("Stop after this one", () => {
        void send({ type: "stopBatch" });
      }),
    );
  } else {
    parts.push(
      el("p", {
        className: failed > 0 || state.stoppedBecause ? "error" : "ok",
        text: `Sent ${sent} of ${state.items.length}${skipped ? `, skipped ${skipped}` : ""}${failed ? `, ${failed} not sent` : ""}.${
          state.stoppedBecause === "stopped"
            ? " Stopped as you asked."
            : state.stoppedBecause
              ? ` Stopped: ${state.stoppedBecause}.`
              : ""
        }`,
      }),
      button("Done", onDone, "btn primary"),
    );
  }
  if (state.done.length > 0)
    parts.push(el("ul", { className: "batch-log" }, ...state.done.map(entryLine)));
  target.replaceChildren(el("section", { className: "batch" }, ...parts));
}

/**
 * The Send all bar, or the batch in progress. A finished batch stays on show
 * until Done, so its outcome isn't missed.
 */
async function showBatch(
  target: HTMLElement,
  recordings: PlaudWritebackRecording[],
  canWrite: boolean,
  st: StatusReply,
): Promise<void> {
  const refresh = (): void => {
    void send({ type: "status" }).then(renderMain);
  };
  const done = (state: BatchState): void => {
    void chrome.storage.session.set({ batchDismissed: state.startedAt }).then(refresh);
  };
  const follow = (state: BatchState): void => {
    renderBatchState(target, state, () => done(state));
    if (!state.running) return;
    const timer = setInterval(() => {
      void send({ type: "batchStatus" }).then((s) => {
        if (!s) return;
        renderBatchState(target, s, () => done(s));
        if (!s.running) clearInterval(timer);
      });
    }, 1000);
  };

  const state = await send({ type: "batchStatus" }).catch(() => null);
  const dismissed = (
    (await chrome.storage.session.get("batchDismissed")) as { batchDismissed?: number }
  ).batchDismissed;
  if (state && (state.running || state.startedAt !== dismissed)) {
    follow(state);
    return;
  }

  const eligible = recordings.filter((r) => r.state === "to_send" || r.state === "partial");
  if (!canWrite || eligible.length === 0) {
    target.replaceChildren();
    return;
  }
  const batch = eligible.slice(0, MAX_BATCH);
  const lines = batch.reduce((n, r) => n + r.pendingSegments, 0);
  const confirmBox = (): void => {
    target.replaceChildren(
      el(
        "section",
        { className: "batch" },
        el("p", {
          text: `Send names for ${batch.length} recording${batch.length === 1 ? "" : "s"} (${lines} line${lines === 1 ? "" : "s"})?${
            eligible.length > batch.length
              ? ` The first ${MAX_BATCH} of ${eligible.length}; send the rest afterwards.`
              : ""
          }`,
        }),
        el("p", {
          className: "muted small",
          text: "Each recording is read from Plaud again first. Any that changed since Applaud's last sync are skipped, and every send can be undone.",
        }),
        el(
          "div",
          { className: "row-start" },
          button(
            `Send ${batch.length} recording${batch.length === 1 ? "" : "s"}`,
            () => {
              send({
                type: "sendAll",
                items: batch.map((r) => ({ recordingId: r.recordingId, title: r.title })),
              }).then(follow, (err: unknown) => target.replaceChildren(errorLine(message(err))));
            },
            "btn primary",
          ),
          button("Cancel", () => void showBatch(target, recordings, canWrite, st), "link"),
        ),
      ),
    );
  };
  target.replaceChildren(
    el(
      "div",
      { className: "row" },
      el("span", {
        className: "muted",
        text: `${eligible.length} recording${eligible.length === 1 ? "" : "s"} with names to send`,
      }),
      button(`Send all (${batch.length})`, confirmBox, "btn primary"),
    ),
  );
}

/** Sends that can still be undone, newest first: collapsed at the top. */
function renderRecent(
  target: HTMLElement,
  items: PlaudWritebackUndoable[],
  canWrite: boolean,
): void {
  if (items.length === 0) {
    target.replaceChildren();
    return;
  }
  const shown = items.slice(0, 10);
  target.replaceChildren(
    el(
      "details",
      { className: "recent" },
      // Collapsed to start: the popup is for sending names; undo is the exception.
      el("summary", { text: `Recently sent (${items.length})` }),
      canWrite
        ? null
        : el("p", { className: "muted small", text: "Open Plaud in a tab to undo a send." }),
      el(
        "ul",
        { className: "recordings" },
        ...shown.map((u) => {
          const result = el("div", { className: "result" });
          return el(
            "li",
            { className: "recording" },
            el(
              "div",
              { className: "row" },
              el(
                "div",
                {},
                el("strong", { text: u.title }),
                el("span", {
                  className: "muted",
                  text: ` · ${new Date(u.sentAt).toLocaleString()}`,
                }),
              ),
              canWrite ? renderUndo(result, u.recordingId) : null,
            ),
            result,
          );
        }),
      ),
      items.length > shown.length
        ? el("p", { className: "muted small", text: `and ${items.length - shown.length} more` })
        : null,
    ),
  );
}

send({ type: "status" }).then(renderMain, (err: unknown) =>
  renderPairing(null, err instanceof Error ? err.message : String(err)),
);
