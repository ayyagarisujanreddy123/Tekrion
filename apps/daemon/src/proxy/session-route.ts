import { IdentifierSchema } from "@tekrion/protocol";

const SESSION_ROUTE_PREFIX = "/.tekrion/session/";
const LEGACY_SESSION_ROUTE_PREFIX = "/.blackbox/session/";
const SESSION_ROUTE_PREFIXES = [
  SESSION_ROUTE_PREFIX,
  LEGACY_SESSION_ROUTE_PREFIX,
] as const;

export interface SessionScopedPath {
  readonly sessionId: string;
  readonly path: string;
}

export function sessionScopedProxyOrigin(
  proxyOrigin: string,
  sessionId: string,
): string {
  const origin = new URL(proxyOrigin);
  if (
    origin.pathname !== "/" ||
    origin.search.length > 0 ||
    origin.hash.length > 0
  ) {
    throw new TypeError(
      "The proxy origin must not contain a path, query, or fragment.",
    );
  }
  const validated = IdentifierSchema.parse(sessionId);
  const encoded = Buffer.from(validated, "utf8").toString("base64url");
  return new URL(`${SESSION_ROUTE_PREFIX}${encoded}/`, origin)
    .toString()
    .replace(/\/$/u, "");
}

export function sessionScopedProxyBaseUrl(
  proxyOrigin: string,
  sessionId: string,
): string {
  return `${sessionScopedProxyOrigin(proxyOrigin, sessionId)}/v1`;
}

export function parseSessionScopedPath(
  path: string,
): SessionScopedPath | undefined {
  const prefix = SESSION_ROUTE_PREFIXES.find((candidate) =>
    path.startsWith(candidate),
  );
  if (prefix === undefined) {
    return undefined;
  }
  const remainder = path.slice(prefix.length);
  const separator = remainder.indexOf("/");
  if (separator <= 0) {
    return undefined;
  }
  const encoded = remainder.slice(0, separator);
  if (!/^[A-Za-z\d_-]+$/u.test(encoded)) {
    return undefined;
  }
  let sessionId: string;
  try {
    sessionId = IdentifierSchema.parse(
      new TextDecoder("utf-8", { fatal: true }).decode(
        Buffer.from(encoded, "base64url"),
      ),
    );
  } catch {
    return undefined;
  }
  const providerPath = remainder.slice(separator);
  if (providerPath !== "/v1" && !providerPath.startsWith("/v1/")) {
    return undefined;
  }
  return { sessionId, path: providerPath };
}

export function hasSessionScopedRoutePrefix(path: string): boolean {
  return SESSION_ROUTE_PREFIXES.some((prefix) => path.startsWith(prefix));
}
