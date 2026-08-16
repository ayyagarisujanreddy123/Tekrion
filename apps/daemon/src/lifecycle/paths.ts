import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { posix, win32 } from "node:path";

import { ensurePrivateDirectory } from "./private-files.js";

export interface DaemonPaths {
  readonly homeDirectory: string;
  readonly tokenPath: string;
  readonly lockPath: string;
  readonly databasePath: string;
  readonly dataDirectory: string;
  readonly logDirectory: string;
  readonly logPath: string;
}

export interface DefaultHomeOptions {
  readonly environment?: NodeJS.ProcessEnv;
  readonly platform?: NodeJS.Platform;
  readonly userHome?: string;
  readonly pathExists?: (path: string) => boolean;
}

export function defaultTekrionHome(options: DefaultHomeOptions = {}): string {
  const environment = options.environment ?? process.env;
  const platform = options.platform ?? process.platform;
  const userHome = options.userHome ?? homedir();
  const pathExists = options.pathExists ?? existsSync;
  const path = platform === "win32" ? win32 : posix;

  if (environment.TEKRION_HOME !== undefined) {
    return path.resolve(environment.TEKRION_HOME);
  }
  if (environment.BLACKBOX_HOME !== undefined) {
    return path.resolve(environment.BLACKBOX_HOME);
  }

  let currentHome: string;
  let legacyHome: string;
  if (platform === "darwin") {
    const applicationSupport = path.join(
      userHome,
      "Library",
      "Application Support",
    );
    currentHome = path.join(applicationSupport, "Tekrion");
    legacyHome = path.join(applicationSupport, "BlackBox");
  } else if (platform === "win32") {
    const localAppData = path.resolve(
      environment.LOCALAPPDATA ?? path.join(userHome, "AppData", "Local"),
    );
    currentHome = path.join(localAppData, "Tekrion");
    legacyHome = path.join(localAppData, "BlackBox");
  } else {
    const dataHome =
      environment.XDG_DATA_HOME !== undefined &&
      path.isAbsolute(environment.XDG_DATA_HOME)
        ? environment.XDG_DATA_HOME
        : path.join(userHome, ".local", "share");
    currentHome = path.join(dataHome, "tekrion");
    legacyHome = path.join(dataHome, "blackbox");
  }

  const currentDatabase = path.join(currentHome, "tekrion.sqlite");
  const legacyDatabase = path.join(legacyHome, "blackbox.sqlite");
  return !pathExists(currentDatabase) && pathExists(legacyDatabase)
    ? legacyHome
    : currentHome;
}

export interface ResolveDaemonPathsOptions {
  readonly pathExists?: (path: string) => boolean;
  readonly platform?: NodeJS.Platform;
}

export function resolveDaemonPaths(
  homeDirectory?: string,
  options: ResolveDaemonPathsOptions = {},
): DaemonPaths {
  const pathExists = options.pathExists ?? existsSync;
  const platform = options.platform ?? process.platform;
  const path = platform === "win32" ? win32 : posix;
  const resolvedHome = path.resolve(
    homeDirectory ?? defaultTekrionHome({ pathExists, platform }),
  );
  const logDirectory = path.join(resolvedHome, "logs");
  const currentDatabase = path.join(resolvedHome, "tekrion.sqlite");
  const legacyDatabase = path.join(resolvedHome, "blackbox.sqlite");
  return {
    homeDirectory: resolvedHome,
    tokenPath: path.join(resolvedHome, "control.token"),
    lockPath: path.join(resolvedHome, "daemon.lock"),
    databasePath:
      !pathExists(currentDatabase) && pathExists(legacyDatabase)
        ? legacyDatabase
        : currentDatabase,
    dataDirectory: path.join(resolvedHome, "data"),
    logDirectory,
    logPath: path.join(logDirectory, "daemon.log"),
  };
}

export async function ensureInstallLayout(paths: DaemonPaths): Promise<void> {
  await ensurePrivateDirectory(paths.homeDirectory);
  await ensurePrivateDirectory(paths.dataDirectory);
  await ensurePrivateDirectory(paths.logDirectory);
}
