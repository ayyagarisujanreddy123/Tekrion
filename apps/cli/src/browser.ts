import { spawn } from "node:child_process";

import { ControlTokenSchema, isLoopbackHost } from "@tekrion/daemon";

export type BrowserOpener = (url: URL) => Promise<void>;

function browserCommand(url: URL): {
  readonly executable: string;
  readonly arguments: readonly string[];
} {
  if (process.platform === "darwin") {
    return { executable: "open", arguments: [url.href] };
  }
  if (process.platform === "win32") {
    return {
      executable: "rundll32.exe",
      arguments: ["url.dll,FileProtocolHandler", url.href],
    };
  }
  return { executable: "xdg-open", arguments: [url.href] };
}

export const openSystemBrowser: BrowserOpener = async (url) => {
  const command = browserCommand(url);
  const child = spawn(command.executable, command.arguments, {
    detached: true,
    stdio: "ignore",
    windowsHide: true,
  });
  await new Promise<void>((resolve, reject) => {
    const onError = (error: Error) => reject(error);
    child.once("error", onError);
    setImmediate(() => {
      child.off("error", onError);
      resolve();
    });
  });
  child.unref();
};

export function createViewerUrl(
  controlOrigin: string,
  token: string,
  sessionId?: string,
): URL {
  const origin = new URL(controlOrigin);
  if (
    !new Set(["http:", "https:"]).has(origin.protocol) ||
    !isLoopbackHost(origin.hostname) ||
    origin.username !== "" ||
    origin.password !== "" ||
    origin.pathname !== "/" ||
    origin.search !== "" ||
    origin.hash !== ""
  ) {
    throw new Error(
      `Refusing to open a non-loopback Tekrion control origin: ${controlOrigin}`,
    );
  }
  const fragment = new URLSearchParams({
    token: ControlTokenSchema.parse(token),
    ...(sessionId === undefined ? {} : { session: sessionId }),
  });
  origin.hash = fragment.toString();
  return origin;
}
