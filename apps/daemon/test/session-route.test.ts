import { describe, expect, it } from "vitest";

import {
  parseSessionScopedPath,
  sessionScopedProxyBaseUrl,
  sessionScopedProxyOrigin,
} from "../src/index.js";

describe("session-scoped proxy routes", () => {
  it("round-trips a session identity without exposing it as a provider path", () => {
    const base = new URL(
      sessionScopedProxyBaseUrl(
        "http://127.0.0.1:4141",
        "session-wrapper-fixture",
      ),
    );

    expect(parseSessionScopedPath(`${base.pathname}/responses`)).toEqual({
      sessionId: "session-wrapper-fixture",
      path: "/v1/responses",
    });
  });

  it("provides the unversioned base expected by Anthropic clients", () => {
    const origin = sessionScopedProxyOrigin(
      "http://127.0.0.1:4141",
      "session-wrapper-fixture",
    );

    expect(origin).not.toMatch(/\/v1$/u);
    expect(
      parseSessionScopedPath(`${new URL(origin).pathname}/v1/messages`),
    ).toEqual({
      sessionId: "session-wrapper-fixture",
      path: "/v1/messages",
    });
  });

  it("rejects malformed tokens and non-v1 provider paths", () => {
    expect(
      parseSessionScopedPath("/.tekrion/session/not+base64/v1/responses"),
    ).toBeUndefined();
    expect(
      parseSessionScopedPath("/.tekrion/session/c2Vzc2lvbi0x/private"),
    ).toBeUndefined();
  });

  it("continues to parse pre-rebrand session routes", () => {
    expect(
      parseSessionScopedPath(
        "/.blackbox/session/c2Vzc2lvbi1sZWdhY3k/v1/responses",
      ),
    ).toEqual({
      sessionId: "session-legacy",
      path: "/v1/responses",
    });
  });
});
