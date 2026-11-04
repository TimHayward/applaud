import { describe, it, expect, afterAll } from "vitest";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { describeFetchError } from "./post.js";

async function failure(url: string): Promise<string> {
  try {
    await fetch(url, { method: "POST", body: "{}" });
  } catch (err) {
    return describeFetchError(err);
  }
  return "no error";
}

describe("describeFetchError", () => {
  const server = http.createServer((_req, res) => res.end("ok"));
  const ready = new Promise<number>((resolve) =>
    server.listen(0, "127.0.0.1", () => resolve((server.address() as AddressInfo).port)),
  );
  afterAll(() => new Promise<void>((r) => server.close(() => r())));

  it("explains https:// to a plain-http server", async () => {
    const port = await ready;
    expect(await failure(`https://127.0.0.1:${port}/webhook/applaud`)).toMatch(/plain http/);
  });

  it("explains a refused connection", async () => {
    const closed = http.createServer();
    const port = await new Promise<number>((r) =>
      closed.listen(0, "127.0.0.1", () => r((closed.address() as AddressInfo).port)),
    );
    await new Promise<void>((r) => closed.close(() => r()));
    expect(await failure(`http://127.0.0.1:${port}/`)).toMatch(/nothing is listening/);
  });

  it("leaves other errors as they are", () => {
    expect(describeFetchError(new Error("HTTP 404"))).toBe("HTTP 404");
  });
});
