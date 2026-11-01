/**
 * The extension popup: pairing, the recordings Plaud is missing names for,
 * and a dry run of each (plan section 5). Phase 2: nothing is written.
 * Every value is set as text, never as HTML.
 */
import type { PlaudWritebackChange, PlaudWritebackRecording } from "@applaud/shared";
import { normaliseApplaudUrl } from "./applaud.js";
import type { DryRunReply, PopupReplies, PopupRequest, Reply, StatusReply } from "./messages.js";

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

function renderPairing(st: StatusReply | null, error: string | null): void {
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
        .then(renderMain, (err: unknown) => {
          pairButton.disabled = false;
          message.replaceChildren(errorLine(err instanceof Error ? err.message : String(err)));
        });
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

function renderDryRun(target: HTMLElement, r: DryRunReply): void {
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
  }
  for (const w of warnings) parts.push(el("p", { className: "muted", text: w }));
  target.replaceChildren(...parts);
}

function recordingItem(r: PlaudWritebackRecording, plaudTab: boolean): HTMLElement {
  const result = el("div", { className: "result" });
  const run = button("Dry run", () => {
    run.disabled = true;
    result.replaceChildren(el("p", { className: "muted", text: "Reading Plaud…" }));
    send({ type: "dryRun", recordingId: r.recordingId }).then(
      (reply) => {
        run.disabled = false;
        renderDryRun(result, reply);
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
      run,
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
              text: `Signed in: ${d.signedIn ? "yes" : "no"} · API: ${d.apiOrigin ?? "not found"}`,
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
  show(
    header,
    ...facts,
    list,
    el("p", {
      className: "muted small",
      text: "Read only: this version shows what would change and never changes anything in Plaud.",
    }),
    check,
    diagnosis,
  );
  if (st.error || !st.applaud) {
    list.replaceChildren();
    return;
  }
  send({ type: "pending" }).then(
    (recordings) =>
      list.replaceChildren(
        ...(recordings.length === 0
          ? [el("li", { className: "muted", text: "Plaud has every name you have confirmed." })]
          : recordings.map((r) => recordingItem(r, st.plaudTab && st.applaud?.enabled === true))),
      ),
    (err: unknown) =>
      list.replaceChildren(errorLine(err instanceof Error ? err.message : String(err))),
  );
}

send({ type: "status" }).then(renderMain, (err: unknown) =>
  renderPairing(null, err instanceof Error ? err.message : String(err)),
);
