import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import express from "express";
import type { Server } from "node:http";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type Database from "better-sqlite3";
import {
  DEFAULT_CONFIG,
  DEFAULT_SPEAKER_CONFIG,
  PLAUD_WRITEBACK_PROTOCOL,
  PLAUD_WRITEBACK_PROTOCOL_HEADER,
  type PlaudDocument,
  type PlaudWritebackPendingResponse,
  type PlaudWritebackPlanResponse,
  type PlaudWritebackRecordingResponse,
} from "@applaud/shared";

const { loadConfig } = vi.hoisted(() => ({ loadConfig: vi.fn() }));
vi.mock("../config.js", () => ({ loadConfig }));
vi.mock("../logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { setupTestDb, teardownTestDb } from "../test/fixtures/db.js";
import { resetAuthFailures } from "../auth/lan-token.js";
import { resetPairingForTests } from "../plaud-writeback/clients.js";
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
