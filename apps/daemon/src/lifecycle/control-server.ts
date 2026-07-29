import { timingSafeEqual } from "node:crypto";
import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import type { AddressInfo } from "node:net";

import { IdentifierSchema } from "@tekrion/protocol";
import { z } from "zod";

import { isLoopbackHost } from "../proxy/config.js";
import type { EvidenceQueryService } from "../query/evidence-query-service.js";
import { EvidenceQueryRouter } from "../query/evidence-query-router.js";
import { sendJson } from "../query/http-response.js";
import type { LiveEventStreamConfiguration } from "../query/live-event-stream.js";
import { ControlTokenSchema } from "./control-token.js";
import type { DaemonStatus } from "./status.js";
import type { ViewerAssets } from "../viewer/viewer-assets.js";

const ControlPortSchema = z.number().int().min(0).max(65_535);

export interface ControlServerOptions {
  readonly token: string;
  readonly status: () => DaemonStatus | Promise<DaemonStatus>;
  readonly shutdown: () => void | Promise<void>;
  readonly settleSession?: (
    sessionId: string,
  ) => readonly string[] | Promise<readonly string[]>;
  readonly listenHost?: string;
  readonly listenPort?: number;
  readonly allowedOrigins?: readonly string[];
  readonly query?: EvidenceQueryService;
  readonly maximumQueryPayloadBytes?: number;
  readonly liveQuery?: LiveEventStreamConfiguration;
  readonly viewerAssets?: ViewerAssets;
}

export interface ControlAddress {
  readonly host: string;
  readonly port: number;
  readonly origin: string;
}

export class UnsafeControlBindError extends Error {
  constructor(host: string) {
    super(`The daemon control API may only bind to loopback, not ${host}.`);
    this.name = "UnsafeControlBindError";
  }
}

function normalizeAllowedOrigin(origin: string): string {
  const parsed = new URL(origin);
  if (
    !new Set(["http:", "https:"]).has(parsed.protocol) ||
    !isLoopbackHost(parsed.hostname) ||
    parsed.username !== "" ||
    parsed.password !== "" ||
    parsed.pathname !== "/" ||
    parsed.search !== "" ||
    parsed.hash !== ""
  ) {
    throw new Error(
      `Control origin must be a loopback HTTP(S) origin: ${origin}`,
    );
  }
  return parsed.origin;
}

function tokenMatches(header: string | undefined, expected: string): boolean {
  if (header === undefined || !header.startsWith("Bearer ")) {
    return false;
  }
  const candidate = Buffer.from(header.slice("Bearer ".length), "utf8");
  const expectedBytes = Buffer.from(expected, "utf8");
  return (
    candidate.length === expectedBytes.length &&
    timingSafeEqual(candidate, expectedBytes)
  );
}

export class ControlServer {
  private readonly server: Server;
  private readonly allowedOrigins: ReadonlySet<string>;
  private addressValue?: ControlAddress;
  private shutdownRequested = false;
  private readonly queryRouter: EvidenceQueryRouter | undefined;

  constructor(private readonly options: ControlServerOptions) {
    ControlTokenSchema.parse(options.token);
    const listenHost = options.listenHost ?? "127.0.0.1";
    if (!isLoopbackHost(listenHost)) {
      throw new UnsafeControlBindError(listenHost);
    }
    ControlPortSchema.parse(options.listenPort ?? 4142);
    this.allowedOrigins = new Set(
      (options.allowedOrigins ?? []).map(normalizeAllowedOrigin),
    );
    this.queryRouter =
      options.query === undefined
        ? undefined
        : new EvidenceQueryRouter({
            query: options.query,
            status: options.status,
            ...(options.maximumQueryPayloadBytes === undefined
              ? {}
              : { maximumPayloadBytes: options.maximumQueryPayloadBytes }),
            ...(options.liveQuery === undefined
              ? {}
              : { liveStream: options.liveQuery }),
          });
    this.server = createServer((request, response) => {
      void this.handle(request, response).catch(() => {
        if (!response.headersSent) {
          sendJson(response, 500, { error: "internal_control_error" });
        } else {
          response.destroy();
        }
      });
    });
    this.server.requestTimeout = 15_000;
    this.server.headersTimeout = 10_000;
    this.server.keepAliveTimeout = 2_000;
    this.server.maxHeadersCount = 100;
  }

  async start(): Promise<ControlAddress> {
    if (this.addressValue !== undefined) {
      return this.addressValue;
    }
    await new Promise<void>((resolve, reject) => {
      const onError = (error: Error) => {
        this.server.off("listening", onListening);
        reject(error);
      };
      const onListening = () => {
        this.server.off("error", onError);
        resolve();
      };
      this.server.once("error", onError);
      this.server.once("listening", onListening);
      this.server.listen(
        this.options.listenPort ?? 4142,
        this.options.listenHost ?? "127.0.0.1",
      );
    });
    const address = this.server.address() as AddressInfo;
    const displayHost =
      address.family === "IPv6" ? `[${address.address}]` : address.address;
    this.addressValue = {
      host: address.address,
      port: address.port,
      origin: `http://${displayHost}:${address.port}`,
    };
    return this.addressValue;
  }

  address(): ControlAddress | undefined {
    return this.addressValue;
  }

  async close(graceMilliseconds = 1_000): Promise<void> {
    if (!this.server.listening) {
      delete this.addressValue;
      return;
    }
    const closePromise = new Promise<void>((resolve, reject) => {
      this.server.close((error) => {
        if (error === undefined) {
          resolve();
        } else {
          reject(error);
        }
      });
    });
    const timer = setTimeout(() => {
      this.server.closeAllConnections();
    }, graceMilliseconds);
    timer.unref();
    try {
      await closePromise;
    } finally {
      clearTimeout(timer);
      delete this.addressValue;
    }
  }

  private requestHostIsSafe(request: IncomingMessage): boolean {
    const address = this.addressValue;
    const host = request.headers.host;
    if (address === undefined || host === undefined) {
      return false;
    }
    try {
      const parsed = new URL(`http://${host}`);
      const port = parsed.port === "" ? 80 : Number(parsed.port);
      return (
        isLoopbackHost(parsed.hostname) &&
        port === address.port &&
        parsed.username === "" &&
        parsed.password === "" &&
        parsed.pathname === "/" &&
        parsed.search === "" &&
        parsed.hash === ""
      );
    } catch {
      return false;
    }
  }

  private requestOriginIsSafe(request: IncomingMessage): boolean {
    const origin = request.headers.origin;
    if (origin === undefined) {
      return true;
    }
    try {
      const normalized = normalizeAllowedOrigin(origin);
      return (
        normalized === this.addressValue?.origin ||
        this.allowedOrigins.has(normalized)
      );
    } catch {
      return false;
    }
  }

  private async handle(
    request: IncomingMessage,
    response: ServerResponse,
  ): Promise<void> {
    if (
      !this.requestHostIsSafe(request) ||
      !this.requestOriginIsSafe(request)
    ) {
      request.resume();
      sendJson(response, 403, { error: "forbidden_origin" });
      return;
    }

    const url = new URL(request.url ?? "/", "http://tekrion.invalid");
    if (this.options.viewerAssets?.handle(request, response, url) === true) {
      return;
    }
    if (!tokenMatches(request.headers.authorization, this.options.token)) {
      request.resume();
      sendJson(
        response,
        401,
        { error: "unauthorized" },
        { "www-authenticate": "Bearer" },
      );
      return;
    }
    const path = url.pathname;
    if (
      this.queryRouter !== undefined &&
      (await this.queryRouter.handle(request, response, url))
    ) {
      return;
    }
    if (path === "/v1/control/status") {
      request.resume();
      if (request.method !== "GET") {
        sendJson(
          response,
          405,
          { error: "method_not_allowed" },
          { allow: "GET" },
        );
        return;
      }
      sendJson(response, 200, await this.options.status());
      return;
    }
    const sessionSettlement = path.match(
      /^\/v1\/control\/sessions\/([^/]+)\/settle$/u,
    );
    if (sessionSettlement !== null) {
      request.resume();
      if (request.method !== "POST") {
        sendJson(
          response,
          405,
          { error: "method_not_allowed" },
          { allow: "POST" },
        );
        return;
      }
      let sessionId: string;
      try {
        sessionId = IdentifierSchema.parse(
          decodeURIComponent(sessionSettlement[1] as string),
        );
      } catch {
        sendJson(response, 400, { error: "invalid_session_id" });
        return;
      }
      if (this.options.settleSession === undefined) {
        sendJson(response, 503, { error: "session_settlement_unavailable" });
        return;
      }
      const settledExchangeIds = await this.options.settleSession(sessionId);
      sendJson(response, 200, { sessionId, settledExchangeIds });
      return;
    }
    if (path === "/v1/control/shutdown") {
      request.resume();
      if (request.method !== "POST") {
        sendJson(
          response,
          405,
          { error: "method_not_allowed" },
          { allow: "POST" },
        );
        return;
      }
      if (this.shutdownRequested) {
        sendJson(
          response,
          202,
          { status: "stopping" },
          { connection: "close" },
        );
        return;
      }
      this.shutdownRequested = true;
      sendJson(response, 202, { status: "stopping" }, { connection: "close" });
      setImmediate(() => {
        void Promise.resolve(this.options.shutdown()).catch(() => undefined);
      });
      return;
    }

    request.resume();
    sendJson(response, 404, { error: "not_found" });
  }
}
