import { S3Client } from "@aws-sdk/client-s3";
import { describe, expect, it } from "vitest";
import { S3ImageStore } from "./s3-image-store.js";

// Integration-only: needs a real bucket and credentials. Mirrors
// postgres-room-store.test.ts's skipIf pattern for the same reason (CI/local
// coverage of the ImageStore interface already comes from the unit tests
// above against a fake client; this suite just confirms the real SDK calls
// round-trip against S3).
//
// The IAM user this runs under can PutObject/GetObject but not DeleteObject
// (deliberately scoped down), so this can't clean up after itself with a
// fresh key per run the way a delete-capable test suite would. Instead it
// always overwrites one fixed key, leaving a single small object in the
// bucket rather than accumulating one per test run.
const PROBE_KEY = "integration-test/probe";

describe.skipIf(!process.env["S3_BUCKET"])("S3ImageStore (integration)", () => {
  it("round-trips bytes and content type against real S3", async () => {
    const store = new S3ImageStore({
      client: new S3Client({}),
      bucket: process.env["S3_BUCKET"]!,
    });
    const bytes = Buffer.from(`probe-${Date.now()}`, "utf8");
    await store.put(PROBE_KEY, bytes, "text/plain");
    const loaded = await store.get(PROBE_KEY);
    expect(loaded?.bytes).toEqual(bytes);
    expect(loaded?.contentType).toBe("text/plain");
  });

  it("returns null for a key that was never written", async () => {
    const store = new S3ImageStore({
      client: new S3Client({}),
      bucket: process.env["S3_BUCKET"]!,
    });
    expect(await store.get("integration-test/definitely-does-not-exist")).toBeNull();
  });
});
