import { describe, expect, it } from "vitest";

import {
  BoundedByteCapture,
  CaptureMemoryBudget,
  ProxyConfigurationError,
  ProxyLoopError,
  UnsafeBindError,
  headersForForwarding,
  headersForPersistence,
  isLoopbackHost,
  resolveProxyConfiguration,
} from "../src/index.js";

describe("bounded capture memory", () => {
  it("shares a strict global budget and retains prefixes only", () => {
    const budget = new CaptureMemoryBudget(64);
    const first = new BoundedByteCapture(64, budget);
    const second = new BoundedByteCapture(64, budget);

    first.append(Buffer.alloc(48, 1));
    second.append(Buffer.alloc(48, 2));
    expect(budget.usedBytes).toBe(64);
    expect(first.retainedBytes).toBe(48);
    expect(second.retainedBytes).toBe(16);
    expect(second.droppedBytes).toBe(32);

    first.release();
    second.append(Buffer.alloc(16, 3));
    expect(second.retainedBytes).toBe(16);
    expect(second.droppedBytes).toBe(48);
    expect(budget.usedBytes).toBe(16);
    second.release();
    expect(budget.usedBytes).toBe(0);
  });
});

describe("proxy configuration safety", () => {
  it("resolves the loopback defaults", () => {
    const configuration = resolveProxyConfiguration();

    expect(configuration.listenHost).toBe("127.0.0.1");
    expect(configuration.listenPort).toBe(4141);
    expect(configuration.upstream.origin).toBe("https://api.openai.com");
  });

  it.each(["127.0.0.1", "127.23.4.5", "::1", "[::1]", "localhost."])(
    "recognizes %s as loopback",
    (host) => {
      expect(isLoopbackHost(host)).toBe(true);
    },
  );

  it("requires explicit consent for non-loopback listeners", () => {
    expect(() => resolveProxyConfiguration({ listenHost: "0.0.0.0" })).toThrow(
      UnsafeBindError,
    );
    expect(
      resolveProxyConfiguration({
        listenHost: "0.0.0.0",
        allowNonLoopback: true,
      }).listenHost,
    ).toBe("0.0.0.0");
  });

  it.each(["127.0.0.1", "localhost", "[::1]"])(
    "rejects a loop through %s",
    (upstreamHost) => {
      expect(() =>
        resolveProxyConfiguration({
          listenHost: "127.0.0.1",
          listenPort: 4141,
          upstream: `http://${upstreamHost}:4141`,
        }),
      ).toThrow(ProxyLoopError);
    },
  );

  it.each([
    "ftp://api.openai.com",
    "https://user:secret@api.openai.com",
    "https://api.openai.com/v1",
    "https://api.openai.com?debug=true",
  ])("rejects unsafe upstream origin %s", (upstream) => {
    expect(() => resolveProxyConfiguration({ upstream })).toThrow(
      ProxyConfigurationError,
    );
  });
});

describe("header forwarding and persistence boundaries", () => {
  const incoming = {
    authorization: "Bearer fixture-secret",
    "anthropic-organization-id": "anthropic-org-fixture-private",
    "chatgpt-account-id": "account-fixture-private",
    "x-api-key": "anthropic-fixture-secret",
    cookie: "session=fixture-cookie",
    host: "127.0.0.1:4141",
    connection: "keep-alive, x-private-hop",
    "keep-alive": "timeout=5",
    "x-private-hop": "drop-me",
    "content-type": "application/json",
    "x-request-id": ["request-1", "request-2"],
  } as const;

  it("forwards credentials in memory but removes hop-by-hop and proxy host fields", () => {
    const forwarded = headersForForwarding(incoming, { dropHost: true });

    expect(forwarded.authorization).toBe("Bearer fixture-secret");
    expect(forwarded["anthropic-organization-id"]).toBe(
      "anthropic-org-fixture-private",
    );
    expect(forwarded["chatgpt-account-id"]).toBe("account-fixture-private");
    expect(forwarded["x-api-key"]).toBe("anthropic-fixture-secret");
    expect(forwarded.cookie).toBe("session=fixture-cookie");
    expect(forwarded.host).toBeUndefined();
    expect(forwarded.connection).toBeUndefined();
    expect(forwarded["keep-alive"]).toBeUndefined();
    expect(forwarded["x-private-hop"]).toBeUndefined();
    expect(forwarded["x-request-id"]).toEqual(["request-1", "request-2"]);
  });

  it("makes credentials structurally absent from persisted headers", () => {
    const persisted = headersForPersistence(incoming);
    const serialized = JSON.stringify(persisted);

    expect(serialized).not.toContain("fixture-secret");
    expect(serialized).not.toContain("anthropic-org-fixture-private");
    expect(serialized).not.toContain("anthropic-fixture-secret");
    expect(serialized).not.toContain("account-fixture-private");
    expect(serialized).not.toContain("fixture-cookie");
    expect(persisted.authorization).toBeUndefined();
    expect(persisted["anthropic-organization-id"]).toBeUndefined();
    expect(persisted["chatgpt-account-id"]).toBeUndefined();
    expect(persisted["x-api-key"]).toBeUndefined();
    expect(persisted.cookie).toBeUndefined();
    expect(persisted["content-type"]).toEqual(["application/json"]);
  });

  it("forwards response cookies to the caller without persisting them", () => {
    const responseHeaders = {
      "set-cookie": ["a=1; HttpOnly", "b=2; Secure"],
      "content-type": "application/json",
      connection: "close",
    };

    expect(headersForForwarding(responseHeaders)["set-cookie"]).toEqual([
      "a=1; HttpOnly",
      "b=2; Secure",
    ]);
    expect(
      headersForPersistence(responseHeaders)["set-cookie"],
    ).toBeUndefined();
  });

  it("supports configured sensitive headers case-insensitively", () => {
    const persisted = headersForPersistence(
      { "x-customer-token": "do-not-store", "x-safe": "keep" },
      ["X-Customer-Token"],
    );

    expect(persisted["x-customer-token"]).toBeUndefined();
    expect(persisted["x-safe"]).toEqual(["keep"]);
  });

  it("preserves prototype-shaped header names as own data properties", () => {
    const prototypeHeader = Object.fromEntries([["__proto__", "header-value"]]);
    const forwarded = headersForForwarding(prototypeHeader);
    const persisted = headersForPersistence(prototypeHeader);

    expect(Object.hasOwn(forwarded, "__proto__")).toBe(true);
    expect(forwarded["__proto__"]).toBe("header-value");
    expect(Object.hasOwn(persisted, "__proto__")).toBe(true);
    expect(persisted["__proto__"]).toEqual(["header-value"]);
  });
});
