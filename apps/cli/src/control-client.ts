import { request as httpRequest } from "node:http";

import {
  DaemonStatusSchema,
  isLoopbackHost,
  readControlToken,
  type DaemonLockRecord,
  type DaemonPaths,
  type DaemonStatus,
} from "@blackbox/daemon";
import { IdentifierSchema } from "@blackbox/protocol";

const MAX_CONTROL_RESPONSE_BYTES = 1024 * 1024;

export class UnsafeControlOriginError extends Error {
  constructor(origin: string) {
    super(`Refusing to send the control token to unsafe origin ${origin}.`);
    this.name = "UnsafeControlOriginError";
  }
}

export class ControlRequestError extends Error {
  constructor(
    message: string,
    readonly status?: number,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "ControlRequestError";
  }
}

function safeControlOrigin(origin: string): URL {
  const parsed = new URL(origin);
  if (
    parsed.protocol !== "http:" ||
    !isLoopbackHost(parsed.hostname) ||
    parsed.username !== "" ||
    parsed.password !== "" ||
    parsed.pathname !== "/" ||
    parsed.search !== "" ||
    parsed.hash !== ""
  ) {
    throw new UnsafeControlOriginError(origin);
  }
  return parsed;
}

async function controlRequest(
  record: DaemonLockRecord,
  paths: DaemonPaths,
  path: string,
  method: "GET" | "POST",
  timeoutMilliseconds: number,
): Promise<unknown> {
  if (record.controlOrigin === undefined) {
    throw new ControlRequestError("Daemon lock has no control endpoint.");
  }
  const controlOrigin = safeControlOrigin(record.controlOrigin);
  const token = await readControlToken(paths.tokenPath);

  return new Promise((resolve, reject) => {
    const rejectAndClear = (error: unknown) => {
      clearTimeout(timer);
      reject(error);
    };
    const request = httpRequest(
      new URL(path, controlOrigin),
      {
        method,
        headers: {
          authorization: `Bearer ${token}`,
          connection: "close",
          "content-length": 0,
        },
      },
      (response) => {
        const chunks: Buffer[] = [];
        let receivedBytes = 0;
        response.on("data", (chunk: Buffer) => {
          receivedBytes += chunk.length;
          if (receivedBytes > MAX_CONTROL_RESPONSE_BYTES) {
            response.destroy(
              new ControlRequestError("Control response exceeded 1 MiB."),
            );
            return;
          }
          chunks.push(Buffer.from(chunk));
        });
        response.on("error", rejectAndClear);
        response.on("end", () => {
          clearTimeout(timer);
          const status = response.statusCode ?? 0;
          const body = Buffer.concat(chunks).toString("utf8");
          if (status < 200 || status >= 300) {
            reject(
              new ControlRequestError(
                `Control request failed with HTTP ${status}.`,
                status,
              ),
            );
            return;
          }
          try {
            resolve(JSON.parse(body));
          } catch (error: unknown) {
            reject(
              new ControlRequestError(
                "Control response was not valid JSON.",
                undefined,
                {
                  cause: error,
                },
              ),
            );
          }
        });
      },
    );
    const timer = setTimeout(() => {
      request.destroy(new ControlRequestError("Control request timed out."));
    }, timeoutMilliseconds);
    timer.unref();
    request.on("error", rejectAndClear);
    request.end();
  });
}

export async function requestDaemonStatus(
  record: DaemonLockRecord,
  paths: DaemonPaths,
  timeoutMilliseconds = 2_000,
): Promise<DaemonStatus> {
  const status = DaemonStatusSchema.parse(
    await controlRequest(
      record,
      paths,
      "/v1/control/status",
      "GET",
      timeoutMilliseconds,
    ),
  );
  if (status.instanceId !== record.instanceId || status.pid !== record.pid) {
    throw new ControlRequestError(
      "Control response identity does not match the daemon lock.",
    );
  }
  if (
    record.controlOrigin !== undefined &&
    status.controlOrigin !== record.controlOrigin
  ) {
    throw new ControlRequestError(
      "Control response endpoint does not match the daemon lock.",
    );
  }
  return status;
}

export async function requestDaemonShutdown(
  record: DaemonLockRecord,
  paths: DaemonPaths,
  timeoutMilliseconds = 2_000,
): Promise<void> {
  await controlRequest(
    record,
    paths,
    "/v1/control/shutdown",
    "POST",
    timeoutMilliseconds,
  );
}

export async function requestDaemonSessionSettlement(
  record: DaemonLockRecord,
  paths: DaemonPaths,
  sessionId: string,
  timeoutMilliseconds = 10_000,
): Promise<readonly string[]> {
  const validatedSessionId = IdentifierSchema.parse(sessionId);
  const result = await controlRequest(
    record,
    paths,
    `/v1/control/sessions/${encodeURIComponent(validatedSessionId)}/settle`,
    "POST",
    timeoutMilliseconds,
  );
  if (
    typeof result !== "object" ||
    result === null ||
    !("sessionId" in result) ||
    result.sessionId !== validatedSessionId ||
    !("settledExchangeIds" in result) ||
    !Array.isArray(result.settledExchangeIds) ||
    !result.settledExchangeIds.every(
      (exchangeId) => typeof exchangeId === "string" && exchangeId.length > 0,
    )
  ) {
    throw new ControlRequestError("Session settlement response was invalid.");
  }
  return result.settledExchangeIds;
}
