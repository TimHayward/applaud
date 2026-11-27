import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import express from "express";
import type { Server } from "node:http";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type Database from "better-sqlite3";
import {
  DEFAULT_CONFIG,
  DEFAULT_SPEAKER_CONFIG,
  PLAUD_AUTOMATION_FEATURES,
  PLAUD_AUTOMATION_FEATURES_HEADER,
  PLAUD_WRITEBACK_PROTOCOL,
  PLAUD_WRITEBACK_PROTOCOL_HEADER,
  type PlaudDocument,
  type PlaudWritebackPendingResponse,
  type PlaudWritebackPlanResponse,
  type PlaudWritebackRecordingResponse,
} from "@applaud/shared";

const { loadConfig, updateConfig } = vi.hoisted(() => {
  const loadConfig = vi.fn();
  const updateConfig = vi.fn((patch: Record<string, unknown>) => {
    const next = { ...loadConfig(), ...patch };
    loadConfig.mockReturnValue(next);
    return next;
  });
  return { loadConfig, updateConfig };
});
vi.mock("../config.js", () => ({ loadConfig, updateConfig }));
vi.mock("../logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { setupTestDb, teardownTestDb } from "../test/fixtures/db.js";
import { resetAuthFailures } from "../auth/lan-token.js";
import { resetPairingForTests } from "../plaud-writeback/clients.js";
import { RETRY_BACKOFF_MS, setAutomationDirForTests } from "../plaud-writeback/automation.js";
import { setConfirmationForTests } from "../plaud-writeback/confirm.js";
import { writeApplaudTranscript } from "../speakers/outputs.js";
import {
  plaudWritebackPairRouter,
  plaudWritebackRouter,
  resetPairFailures,
} from "./plaud-writeback.js";

const LAN = "lan-token-for-tests-0123456789";
const confirmed: string[] = [];
setConfirmationForTests((id) => confirmed.push(id));

// Synthetic, shaped like Plaud's documents (plan Appendix A.8).
const seg = (uid: string, label: string, speaker: string, start: number) => ({
  segment_uid: uid,
  start_time: start,
  end_time: start + 1000,
  content: `Line ${uid}.`,
  speaker,
  original_speaker: label,
});
const plaudTranscript = () => [
  seg("u1", "Speaker 1", "Speaker 1", 0),
  seg("u2", "Speaker 2", "Speaker 2", 1000),
  seg("u3", "Speaker 2", "Speaker 2", 2000),
];

describe("plaudWritebackRouter", () => {
  let db: Database.Database;
  let server: Server;
  let baseUrl: string;
  let dir: string;

  const configure = (over: Partial<typeof DEFAULT_SPEAKER_CONFIG> = {}): void => {
    loadConfig.mockReturnValue({
      ...DEFAULT_CONFIG,
      lanToken: LAN,
      recordingsDir: dir,
      speakers: {
        ...DEFAULT_SPEAKER_CONFIG,
        enabled: true,
        activeModelId: "m@1",
        sendToPlaud: true,
        ...over,
      },
    });
  };

  const call = (
    method: string,
    url: string,
    opts: { token?: string; body?: unknown; protocol?: number | null } = {},
  ) =>
    fetch(`${baseUrl}${url}`, {
      method,
      headers: {
        "content-type": "application/json",
        ...(opts.token ? { authorization: `Bearer ${opts.token}` } : {}),
        ...(opts.protocol !== null
          ? { [PLAUD_WRITEBACK_PROTOCOL_HEADER]: String(opts.protocol ?? PLAUD_WRITEBACK_PROTOCOL) }
          : {}),
      },
      ...(opts.body !== undefined ? { body: JSON.stringify(opts.body) } : {}),
    });

  const pairExtension = async (): Promise<string> => {
    const code = (await (await call("POST", "/pairing-code", { token: LAN })).json()) as {
      code: string;
    };
    const res = await call("POST", "/pair", { body: { code: code.code, name: "Edge" } });
    expect(res.status).toBe(200);
    return ((await res.json()) as { token: string }).token;
  };

  const docs = (transcript = plaudTranscript()): PlaudDocument[] => [
    {
      kind: "transcript",
      objectId: "o_t",
      contentId: "c_t",
      version: 100,
      content: JSON.stringify(transcript),
    },
    {
      kind: "polished",
      objectId: "o_p",
      contentId: "c_p",
      version: 200,
      content: JSON.stringify(transcript),
    },
    {
      kind: "summary",
      objectId: "o_s",
      contentId: "c_s",
      version: 300,
      content: "Speaker 2 will book it.",
    },
  ];

  beforeEach(async () => {
    db = setupTestDb();
    resetAuthFailures();
    resetPairFailures();
    resetPairingForTests();
    dir = mkdtempSync(path.join(tmpdir(), "applaud-writeback-route-"));
    mkdirSync(path.join(dir, "f1"));
    writeFileSync(path.join(dir, "f1", "transcript.json"), JSON.stringify(plaudTranscript()));
    configure();
    db.prepare(
      `INSERT INTO recordings (id, filename, start_time, end_time, duration_ms, filesize_bytes, serial_number, folder,
         audio_filename, audio_downloaded_at, transcript_downloaded_at, speakers_processed_at)
       VALUES ('f_1', 'Planning', 0, 1, 3000, 1, 'S', 'f1', 'audio.ogg', 1, 1, 1)`,
    ).run();
    db.prepare(
      "INSERT INTO speakers (id, name, is_owner, created_at, updated_at) VALUES (1, 'Ben Example', 0, 0, 0)",
    ).run();
    db.prepare(
      `INSERT INTO recording_speakers (recording_id, plaud_label, plaud_name, speaker_id, status, assigned_by, updated_at)
       VALUES ('f_1', 'Speaker 2', 'Speaker 2', 1, 'confirmed', 'user', 0)`,
    ).run();
    writeApplaudTranscript(dir, "f_1");

    const app = express();
    app.use(express.json({ limit: "16mb" }));
    app.use("/api/plaud-writeback", plaudWritebackPairRouter);
    app.use("/api/plaud-writeback", plaudWritebackRouter);
    await new Promise<void>((resolve) => {
      server = app.listen(0, "127.0.0.1", () => resolve());
    });
    const addr = server.address();
    baseUrl = `http://127.0.0.1:${typeof addr === "object" && addr ? addr.port : 0}/api/plaud-writeback`;
  });

  afterEach(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    teardownTestDb(db);
    rmSync(dir, { recursive: true, force: true });
    if (automationDir) rmSync(automationDir, { recursive: true, force: true });
    automationDir = null;
    setAutomationDirForTests(undefined);
  });

  // ── Automatic Plaud sync ──

  let automationDir: string | null = null;

  const enableAutomation = async (over: Record<string, unknown> = {}): Promise<string> => {
    automationDir = mkdtempSync(path.join(tmpdir(), "applaud-automation-"));
    setAutomationDirForTests(automationDir);
    const res = await call("PUT", "/automation", { token: LAN, body: { enabled: true, ...over } });
    expect(res.status).toBe(200);
    const file = JSON.parse(readFileSync(path.join(automationDir, "client.json"), "utf8")) as {
      token: string;
      applaudUrl: string;
    };
    expect(file.applaudUrl).toBe("http://applaud.internal:44471");
    return file.token;
  };

  const heartbeat = (token: string, over: Record<string, unknown> = {}) =>
    call("POST", "/automation/heartbeat", {
      token,
      body: {
        plaudSignedIn: true,
        ran: false,
        sent: 0,
        conflicts: 0,
        failed: 0,
        cards: 0,
        ...over,
      },
    });

  /** A check-in from the current automation extension, which lists its features. */
  const nextRun = async (
    token: string,
    features: string | null = PLAUD_AUTOMATION_FEATURES.join(","),
  ) =>
    (await (
      await fetch(`${baseUrl}/automation/next`, {
        headers: {
          authorization: `Bearer ${token}`,
          [PLAUD_WRITEBACK_PROTOCOL_HEADER]: String(PLAUD_WRITEBACK_PROTOCOL),
          ...(features !== null ? { [PLAUD_AUTOMATION_FEATURES_HEADER]: features } : {}),
        },
      })
    ).json()) as {
      enabled: boolean;
      due: boolean;
      paused: string | null;
      test?: boolean;
    };

  it("won't turn automatic sync on without the shared folder", async () => {
    setAutomationDirForTests(null);
    const res = await call("PUT", "/automation", { token: LAN, body: { enabled: true } });
    expect(res.status).toBe(409);
    const status = (await (await call("GET", "/automation/status", { token: LAN })).json()) as {
      available: boolean;
      enabled: boolean;
    };
    expect(status).toMatchObject({ available: false, enabled: false });
  });

  it("stays off when it can't write the browser's credential", async () => {
    automationDir = mkdtempSync(path.join(tmpdir(), "applaud-automation-"));
    // A file where the folder should be: the credential can't be written.
    const blocked = path.join(automationDir, "blocked");
    writeFileSync(blocked, "");
    setAutomationDirForTests(path.join(blocked, "sub"));
    const res = await call("PUT", "/automation", { token: LAN, body: { enabled: true } });
    expect(res.status).toBe(500);
    expect(((await res.json()) as { error: string }).error).toMatch(/could not write/);
    const status = (await (await call("GET", "/automation/status", { token: LAN })).json()) as {
      enabled: boolean;
    };
    expect(status.enabled).toBe(false);
  });

  it("gives the automation browser a credential while it is on, and revokes it when off", async () => {
    const token = await enableAutomation();
    expect(await nextRun(token)).toMatchObject({ enabled: true, due: true, paused: null });

    // Its routes are its own; Settings routes and pairing management are not.
    const extension = await pairExtension();
    expect((await call("GET", "/automation/next", { token: extension })).status).toBe(403);
    expect((await call("GET", "/automation/next", { token: LAN })).status).toBe(403);
    expect((await call("GET", "/automation/status", { token })).status).toBe(403);
    expect((await call("PUT", "/automation", { token, body: { enabled: false } })).status).toBe(
      403,
    );
    // The paired-extensions list looks as it did, and can't revoke the browser.
    const clients = (await (await call("GET", "/clients", { token: LAN })).json()) as {
      clients: { name: string }[];
    };
    expect(clients.clients.map((c) => c.name)).toEqual(["Edge"]);

    const off = await call("PUT", "/automation", { token: LAN, body: { enabled: false } });
    expect(off.status).toBe(200);
    expect(existsSync(path.join(automationDir!, "client.json"))).toBe(false);
    expect((await call("GET", "/automation/next", { token })).status).toBe(401);
    // The paired extension carries on as before.
    expect((await call("GET", "/pending", { token: extension })).status).toBe(200);
  });

  it("lets the automation browser send names and save cards only while those options are on", async () => {
    const token = await enableAutomation({ names: false });
    const body = { recordingId: "f_1", documents: docs() };
    expect((await call("POST", "/plan", { token, body })).status).toBe(409);
    expect(
      ((await (await call("GET", "/automation/pending", { token })).json()) as { recordings: [] })
        .recordings,
    ).toEqual([]);

    await call("PUT", "/automation", { token: LAN, body: { names: true, cards: false } });
    expect((await call("POST", "/plan", { token, body })).status).toBe(200);
    expect((await call("POST", "/cards/f_1", { token, body: { status: "none" } })).status).toBe(
      409,
    );
    expect((await call("POST", "/undo/f_1", { token })).status).toBe(403);

    // "Send names to Plaud" still applies on top.
    configure({ sendToPlaud: false });
    loadConfig.mockReturnValue({
      ...loadConfig(),
      plaudAutomation: { enabled: true, names: true, cards: true, viewerUrl: "" },
    });
    expect((await call("POST", "/plan", { token, body })).status).toBe(409);
  });

  it("offers the automation browser only recordings ready to send, backing off after a failure", async () => {
    const token = await enableAutomation();
    const pending = async () =>
      (
        (await (await call("GET", "/automation/pending", { token })).json()) as {
          recordings: { recordingId: string }[];
        }
      ).recordings.map((r) => r.recordingId);
    expect(await pending()).toEqual(["f_1"]);

    const plan = (await (
      await call("POST", "/plan", { token, body: { recordingId: "f_1", documents: docs() } })
    ).json()) as PlaudWritebackPlanResponse;
    await call("POST", "/results", {
      token,
      body: { planId: plan.planId, results: [{ kind: "transcript", outcome: "conflict" }] },
    });
    expect(await pending()).toEqual([]);
    // The extension's own list is unchanged by the back-off.
    const all = (await (
      await call("GET", "/pending", { token: LAN })
    ).json()) as PlaudWritebackPendingResponse;
    expect(all.recordings.map((r) => r.recordingId)).toEqual(["f_1"]);

    db.prepare("UPDATE plaud_writeback SET last_attempt_at = ? WHERE recording_id = 'f_1'").run(
      Date.now() - RETRY_BACKOFF_MS - 1000,
    );
    expect(await pending()).toEqual(["f_1"]);
  });

  it("asks the browser for a connection test and keeps its answer, without moving the run cadence", async () => {
    const token = await enableAutomation();
    await heartbeat(token, { ran: true, plaudSignedIn: true, sent: 2 });
    expect((await nextRun(token)).due).toBe(false);

    // Run now, then a test: the test goes first and the run still follows.
    expect((await call("POST", "/automation/run", { token: LAN })).status).toBe(200);
    expect((await call("POST", "/automation/test", { token: LAN })).status).toBe(200);
    expect(await nextRun(token)).toMatchObject({ due: false, test: true });
    type Status = {
      plaudSignedIn: boolean | null;
      last: { sent: number } | null;
      test: {
        requestedAt: number | null;
        last: { plaudSignedIn: boolean | null; error: string | null } | null;
      };
    };
    const status = async () =>
      (await (await call("GET", "/automation/status", { token: LAN })).json()) as Status;
    expect((await status()).test.requestedAt).not.toBeNull();

    await heartbeat(token, { test: true, plaudSignedIn: false, error: "signed out" });
    const s = await status();
    expect(s.test).toMatchObject({
      requestedAt: null,
      last: { plaudSignedIn: false, error: "signed out" },
    });
    expect(s).toMatchObject({ plaudSignedIn: false, last: { sent: 2 } });
    expect(await nextRun(token)).toMatchObject({ due: true });
    expect((await nextRun(token)).test).toBeUndefined();
  });

  it("spots a browser older than Applaud, fails its test at once and keeps it running", async () => {
    const token = await enableAutomation();
    await heartbeat(token, { ran: true, plaudSignedIn: true });
    // Asked for while the browser hadn't checked in yet, so allowed.
    expect((await call("POST", "/automation/test", { token: LAN })).status).toBe(200);
    // An old build sends no features: the test fails and a due run isn't held back.
    expect((await call("POST", "/automation/run", { token: LAN })).status).toBe(200);
    expect(await nextRun(token, null)).toMatchObject({ due: true });
    type Status = {
      browser: { outdated: boolean } | null;
      test: { requestedAt: number | null; last: { error: string | null } | null };
    };
    const s = (await (await call("GET", "/automation/status", { token: LAN })).json()) as Status;
    expect(s.browser).toMatchObject({ outdated: true });
    expect(s.test.requestedAt).toBeNull();
    expect(s.test.last?.error).toMatch(/older build/);
    const res = await call("POST", "/automation/test", { token: LAN });
    expect(res.status).toBe(409);

    // The current build clears the warning.
    await nextRun(token);
    const after = (await (
      await call("GET", "/automation/status", { token: LAN })
    ).json()) as Status;
    expect(after.browser).toMatchObject({ outdated: false });
  });

  it("runs on Applaud's cadence or on Run now, and pauses on a shape it doesn't recognise", async () => {
    const token = await enableAutomation();
    expect((await nextRun(token)).due).toBe(true);
    expect((await heartbeat(token)).status).toBe(200);
    expect((await nextRun(token)).due).toBe(false);

    expect((await call("POST", "/automation/run", { token: LAN })).status).toBe(200);
    expect((await nextRun(token)).due).toBe(true);
    await heartbeat(token, { ran: true, plaudSignedIn: false });
    expect((await nextRun(token)).due).toBe(false);

    type Status = {
      plaudSignedIn: boolean | null;
      needsAttention: string | null;
      paused: string | null;
      lastRunAt: number | null;
      lastSeenAt: number | null;
    };
    const status = async () =>
      (await (await call("GET", "/automation/status", { token: LAN })).json()) as Status;
    expect(await status()).toMatchObject({ plaudSignedIn: false, needsAttention: "signed_out" });
    expect((await status()).lastRunAt).not.toBeNull();
    expect((await status()).lastSeenAt).not.toBeNull();

    // An idle check-in that finds no Plaud tab keeps the known sign-in state;
    // one that finds the tab signed in clears it, and keeps the last run's figures.
    await heartbeat(token, { ran: true, plaudSignedIn: true, sent: 3 });
    await heartbeat(token, { plaudSignedIn: false });
    await heartbeat(token, { plaudSignedIn: null });
    expect(await status()).toMatchObject({ plaudSignedIn: false, needsAttention: "signed_out" });
    await heartbeat(token, { plaudSignedIn: true });
    expect(await status()).toMatchObject({
      plaudSignedIn: true,
      needsAttention: null,
      last: { sent: 3 },
    });

    await heartbeat(token, { ran: true, shapeError: true, error: "files/detail: no data" });
    expect(await status()).toMatchObject({
      paused: "files/detail: no data",
      needsAttention: "paused",
    });
    expect(await nextRun(token)).toMatchObject({ due: false, paused: "files/detail: no data" });

    await call("POST", "/automation/resume", { token: LAN });
    expect(await nextRun(token)).toMatchObject({ due: true, paused: null });
  });

  it("lists what Plaud is missing, behind the LAN token", async () => {
    expect((await call("GET", "/pending")).status).toBe(401);
    const res = await call("GET", "/pending", { token: LAN });
    expect(res.status).toBe(200);
    const body = (await res.json()) as PlaudWritebackPendingResponse;
    expect(body).toMatchObject({ enabled: true, protocol: PLAUD_WRITEBACK_PROTOCOL });
    expect(body.recordings).toEqual([
      expect.objectContaining({
        recordingId: "f_1",
        title: "Planning",
        pendingSegments: 2,
        state: "to_send",
        changes: [
          {
            plaudLabel: "Speaker 2",
            from: "Speaker 2",
            to: "Ben Example",
            segments: 2,
            segment: null,
          },
        ],
      }),
    ]);
  });

  it("pairs once per code and keeps the extension out of UI-only routes", async () => {
    const code = (await (await call("POST", "/pairing-code", { token: LAN })).json()) as {
      code: string;
    };
    expect((await call("POST", "/pair", { body: { code: "WRONG-CODE", name: "x" } })).status).toBe(
      401,
    );
    const ok = await call("POST", "/pair", {
      body: { code: code.code.toLowerCase(), name: "Edge" },
    });
    expect(ok.status).toBe(200);
    const { token } = (await ok.json()) as { token: string };
    expect((await call("POST", "/pair", { body: { code: code.code, name: "again" } })).status).toBe(
      401,
    );

    expect((await call("GET", "/pending", { token })).status).toBe(200);
    expect((await call("POST", "/pairing-code", { token })).status).toBe(403);
    expect((await call("GET", "/clients", { token })).status).toBe(403);
    const clients = (await (await call("GET", "/clients", { token: LAN })).json()) as {
      clients: { id: number; name: string }[];
    };
    expect(clients.clients).toEqual([expect.objectContaining({ name: "Edge" })]);

    await call("DELETE", `/clients/${clients.clients[0]!.id}`, { token: LAN });
    expect((await call("GET", "/pending", { token })).status).toBe(401);
  });

  it("answers an unknown route itself instead of refusing the extension's token", async () => {
    const token = await pairExtension();
    const res = await call("GET", "/not-a-route", { token });
    expect(res.status).toBe(404);
    expect(((await res.json()) as { error: string }).error).toMatch(/Update Applaud/);
  });

  it("takes a summary card from the extension and links it from the summary", async () => {
    const token = await pairExtension();
    db.prepare("UPDATE recordings SET summary_downloaded_at = 1 WHERE id = 'f_1'").run();
    writeFileSync(path.join(dir, "f1", "summary.md"), "## Summary\nIt went well.");
    const needed = async () =>
      (
        (await (await call("GET", "/cards/needed", { token })).json()) as {
          recordings: { recordingId: string }[];
        }
      ).recordings.map((r) => r.recordingId);
    expect(await needed()).toEqual(["f_1"]);

    expect(
      (await call("POST", "/cards/f_1", { token: LAN, body: { status: "none" } })).status,
    ).toBe(403);
    const notPng = Buffer.from("<svg/>").toString("base64");
    expect(
      (await call("POST", "/cards/f_1", { token, body: { status: "found", png: notPng } })).status,
    ).toBe(400);

    const png = Buffer.concat([
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      Buffer.from("rest"),
    ]);
    const res = await call("POST", "/cards/f_1", {
      token,
      body: { status: "found", png: png.toString("base64") },
    });
    expect(res.status).toBe(200);
    expect(readFileSync(path.join(dir, "f1", "summary_card.png"))).toEqual(png);
    expect(readFileSync(path.join(dir, "f1", "summary.md"), "utf8")).toBe(
      "![](summary_card.png)\n\n## Summary\nIt went well.",
    );
    expect(await needed()).toEqual([]);
  });

  it("stops asking for a card Plaud doesn't have, until the summary changes", async () => {
    const token = await pairExtension();
    db.prepare("UPDATE recordings SET summary_downloaded_at = 1 WHERE id = 'f_1'").run();
    await call("POST", "/cards/f_1", { token, body: { status: "none" } });
    const needed = async () =>
      ((await (await call("GET", "/cards/needed", { token })).json()) as { recordings: unknown[] })
        .recordings;
    expect(await needed()).toEqual([]);
    db.prepare("UPDATE recordings SET summary_downloaded_at = ? WHERE id = 'f_1'").run(
      Date.now() + 1000,
    );
    expect(await needed()).toHaveLength(1);
  });

  it("plans only for a paired extension speaking the same protocol, with writing switched on", async () => {
    const token = await pairExtension();
    const body = { recordingId: "f_1", documents: docs() };
    expect((await call("POST", "/plan", { token: LAN, body })).status).toBe(403);
    expect((await call("POST", "/plan", { token, body, protocol: null })).status).toBe(426);
    expect((await call("POST", "/plan", { token, body, protocol: 99 })).status).toBe(426);
    configure({ sendToPlaud: false });
    expect((await call("POST", "/plan", { token, body })).status).toBe(409);
    configure();
    const res = await call("POST", "/plan", { token, body });
    expect(res.status).toBe(200);
    const plan = (await res.json()) as PlaudWritebackPlanResponse;
    expect(plan).toMatchObject({ status: "ready", changedSegments: 2, summaryReplacements: 1 });
    expect(plan.documents.map((d) => [d.kind, d.originVersion])).toEqual([
      ["transcript", 100],
      ["polished", 200],
      ["summary", 300],
    ]);
    expect(plan.documents[2]!.content).toBe("Ben Example will book it.");
  });

  it("shows a dry run without recording anything", async () => {
    const token = await pairExtension();
    const res = await call("POST", "/plan", {
      token,
      body: { recordingId: "f_1", documents: docs(), dryRun: true },
    });
    const plan = (await res.json()) as PlaudWritebackPlanResponse;
    expect(plan).toMatchObject({ status: "ready", planId: null, changedSegments: 2 });
    expect(plan.documents.map((d) => d.kind)).toEqual(["transcript", "polished", "summary"]);
    const rec = (await (
      await call("GET", "/recordings/f_1", { token: LAN })
    ).json()) as PlaudWritebackRecordingResponse;
    expect(rec.history).toEqual([]);
    expect(rec.recording?.state).toBe("to_send");
  });

  it("records results, then marks the recording sent until the next sync", async () => {
    const token = await pairExtension();
    const plan = (await (
      await call("POST", "/plan", { token, body: { recordingId: "f_1", documents: docs() } })
    ).json()) as PlaudWritebackPlanResponse;
    const results = plan.documents.map((d, i) => ({
      kind: d.kind,
      outcome: "applied",
      newVersion: 1000 + i,
    }));
    confirmed.length = 0;
    expect(
      (await call("POST", "/results", { token, body: { planId: plan.planId, results } })).status,
    ).toBe(200);
    // Applaud re-reads the recording from Plaud to confirm the send (W7).
    expect(confirmed).toEqual(["f_1"]);
    expect(
      (await call("POST", "/results", { token, body: { planId: plan.planId, results } })).status,
    ).toBe(409);

    const rec = (await (
      await call("GET", "/recordings/f_1", { token: LAN })
    ).json()) as PlaudWritebackRecordingResponse;
    expect(rec.recording?.state).toBe("sent");
    expect(rec.history.map((h) => [h.kind, h.outcome])).toEqual([
      ["summary", "applied"],
      ["polished", "applied"],
      ["transcript", "applied"],
    ]);

    // Applaud's next sync shows the names in Plaud (W7).
    writeFileSync(
      path.join(dir, "f1", "transcript.json"),
      JSON.stringify(
        plaudTranscript().map((s) =>
          s.original_speaker === "Speaker 2" ? { ...s, speaker: "Ben Example" } : s,
        ),
      ),
    );
    db.prepare("UPDATE recordings SET transcript_downloaded_at = ? WHERE id = 'f_1'").run(
      Date.now() + 1000,
    );
    writeApplaudTranscript(dir, "f_1");
    const after = (await (
      await call("GET", "/recordings/f_1", { token: LAN })
    ).json()) as PlaudWritebackRecordingResponse;
    expect(after.recording).toMatchObject({ state: "in_plaud", pendingSegments: 0 });
    const pending = (await (
      await call("GET", "/pending", { token: LAN })
    ).json()) as PlaudWritebackPendingResponse;
    expect(pending.recordings).toEqual([]);
  });

  it("stays sent until a count is taken from a transcript downloaded after the send", async () => {
    const token = await pairExtension();
    const plan = (await (
      await call("POST", "/plan", { token, body: { recordingId: "f_1", documents: docs() } })
    ).json()) as PlaudWritebackPlanResponse;
    await call("POST", "/results", {
      token,
      body: {
        planId: plan.planId,
        results: plan.documents.map((d) => ({ kind: d.kind, outcome: "applied", newVersion: 5 })),
      },
    });
    const state = async (): Promise<string | undefined> =>
      (
        (await (
          await call("GET", "/recordings/f_1", { token: LAN })
        ).json()) as PlaudWritebackRecordingResponse
      ).recording?.state;

    // A newer download whose count hasn't been worked out yet changes nothing.
    db.prepare("UPDATE recordings SET transcript_downloaded_at = ? WHERE id = 'f_1'").run(
      Date.now() + 1000,
    );
    expect(await state()).toBe("sent");

    // Counted from that download, and Plaud still has the old names: send again.
    writeApplaudTranscript(dir, "f_1");
    expect(await state()).toBe("to_send");
  });

  it("marks a write that stopped part-way as partial", async () => {
    const token = await pairExtension();
    const plan = (await (
      await call("POST", "/plan", { token, body: { recordingId: "f_1", documents: docs() } })
    ).json()) as PlaudWritebackPlanResponse;
    await call("POST", "/results", {
      token,
      body: {
        planId: plan.planId,
        results: [
          { kind: "transcript", outcome: "applied", newVersion: 101 },
          { kind: "polished", outcome: "conflict" },
        ],
      },
    });
    const rec = (await (
      await call("GET", "/recordings/f_1", { token: LAN })
    ).json()) as PlaudWritebackRecordingResponse;
    expect(rec.recording).toMatchObject({
      state: "partial",
      lastError: expect.stringContaining("polished"),
    });
    expect(Object.fromEntries(rec.history.map((h) => [h.kind, h.outcome]))).toEqual({
      transcript: "applied",
      polished: "conflict",
      summary: "abandoned",
    });
  });

  it("refuses to plan when Plaud changed since Applaud synced", async () => {
    const token = await pairExtension();
    const changed = plaudTranscript().map((s) =>
      s.segment_uid === "u3" ? { ...s, speaker: "Someone Else" } : s,
    );
    const plan = (await (
      await call("POST", "/plan", { token, body: { recordingId: "f_1", documents: docs(changed) } })
    ).json()) as PlaudWritebackPlanResponse;
    expect(plan).toMatchObject({ status: "stale", planId: null, documents: [] });
    const rec = (await (
      await call("GET", "/recordings/f_1", { token: LAN })
    ).json()) as PlaudWritebackRecordingResponse;
    expect(rec.recording?.state).toBe("stale");
  });

  it("undoes the last write with the versions Plaud gave it", async () => {
    const token = await pairExtension();
    expect((await call("POST", "/undo/f_1", { token })).status).toBe(404);
    const original = docs();
    const plan = (await (
      await call("POST", "/plan", { token, body: { recordingId: "f_1", documents: original } })
    ).json()) as PlaudWritebackPlanResponse;
    await call("POST", "/results", {
      token,
      body: {
        planId: plan.planId,
        results: plan.documents.map((d, i) => ({
          kind: d.kind,
          outcome: "applied",
          newVersion: 1000 + i,
        })),
      },
    });

    const before = (await (await call("GET", "/undoable", { token })).json()) as {
      recordings: { recordingId: string }[];
    };
    expect(before.recordings.map((r) => r.recordingId)).toEqual(["f_1"]);
    const undo = (await (
      await call("POST", "/undo/f_1", { token })
    ).json()) as PlaudWritebackPlanResponse;
    expect(undo.documents.map((d) => [d.kind, d.originVersion, d.content])).toEqual(
      original.map((d, i) => [d.kind, 1000 + i, d.content]),
    );
    await call("POST", "/results", {
      token,
      body: {
        planId: undo.planId,
        results: undo.documents.map((d) => ({
          kind: d.kind,
          outcome: "applied",
          newVersion: 2000,
        })),
      },
    });
    const rec = (await (
      await call("GET", "/recordings/f_1", { token: LAN })
    ).json()) as PlaudWritebackRecordingResponse;
    expect(rec.history.filter((h) => !h.undo).every((h) => h.undone)).toBe(true);
    expect((await call("POST", "/undo/f_1", { token })).status).toBe(404);
    const after = (await (await call("GET", "/undoable", { token })).json()) as {
      recordings: unknown[];
    };
    expect(after.recordings).toEqual([]);
  });
});
