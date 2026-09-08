import { describe, expect, it } from "vitest";
import { parseRedisUrl } from "./bullmq-publisher.js";

describe("parseRedisUrl", () => {
  it("extracts host and port from a bare URL", () => {
    const result = parseRedisUrl("redis://localhost:6379");
    expect(result.host).toBe("localhost");
    expect(result.port).toBe(6379);
    expect(result.username).toBeUndefined();
    expect(result.password).toBeUndefined();
    expect(result.tls).toBeUndefined();
  });

  it("defaults the port to 6379 when omitted", () => {
    expect(parseRedisUrl("redis://localhost").port).toBe(6379);
  });

  it("carries username and password through for managed Redis auth", () => {
    // A dropped password doesn't fail fast — ioredis just retries an
    // unauthenticated connection forever, hanging every caller silently.
    const result = parseRedisUrl("redis://default:s3cret@redis.railway.internal:6379");
    expect(result.host).toBe("redis.railway.internal");
    expect(result.port).toBe(6379);
    expect(result.username).toBe("default");
    expect(result.password).toBe("s3cret");
  });

  it("sets tls for a rediss:// URL", () => {
    const result = parseRedisUrl("rediss://default:s3cret@redis.example.com:6380");
    expect(result.tls).toEqual({});
  });

  it("bounds the retry strategy instead of retrying forever", () => {
    const { retryStrategy, connectTimeout } = parseRedisUrl("redis://localhost:6379");
    expect(connectTimeout).toBeGreaterThan(0);
    expect(retryStrategy(1)).not.toBeNull();
    expect(retryStrategy(100)).toBeNull();
  });
});
