import { describe, expect, it } from "vitest";
import { parseRedisUrl } from "./bullmq-publisher.js";

describe("parseRedisUrl", () => {
  it("extracts host and port from a bare URL", () => {
    expect(parseRedisUrl("redis://localhost:6379")).toEqual({ host: "localhost", port: 6379 });
  });

  it("defaults the port to 6379 when omitted", () => {
    expect(parseRedisUrl("redis://localhost")).toEqual({ host: "localhost", port: 6379 });
  });

  it("carries username and password through for managed Redis auth", () => {
    // A dropped password doesn't fail fast — ioredis just retries an
    // unauthenticated connection forever, hanging every caller silently.
    expect(parseRedisUrl("redis://default:s3cret@redis.railway.internal:6379")).toEqual({
      host: "redis.railway.internal",
      port: 6379,
      username: "default",
      password: "s3cret",
    });
  });

  it("sets tls for a rediss:// URL", () => {
    expect(parseRedisUrl("rediss://default:s3cret@redis.example.com:6380")).toEqual({
      host: "redis.example.com",
      port: 6380,
      username: "default",
      password: "s3cret",
      tls: {},
    });
  });
});
