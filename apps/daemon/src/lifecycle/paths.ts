import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";

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

  if (environment.TEKRION_HOME !== undefined) {
    return resolve(environment.TEKRION_HOME);
  }
  if (environment.BLACKBOX_HOME !== undefined) {
    return resolve(environment.BLACKBOX_HOME);
  }

  let currentHome: string;
  let legacyHome: string;
  if (platform === "darwin") {
    const applicationSupport = join(userHome, "Library", "Application Support");
    currentHome = join(applicationSupport, "Tekrion");
    legacyHome = join(applicationSupport, "BlackBox");
  } else if (platform === "win32") {
    const localAppData = resolve(
      environment.LOCALAPPDATA ?? join(userHome, "AppData", "Local"),
    );
    currentHome = join(localAppData, "Tekrion");
    legacyHome = join(localAppData, "BlackBox");
  } else {
    const dataHome =
      environment.XDG_DATA_HOME !== undefined &&
      isAbsolute(environment.XDG_DATA_HOME)
        ? environment.XDG_DATA_HOME
        : join(userHome, ".local", "share");
    currentHome = join(dataHome, "tekrion");
    legacyHome = join(dataHome, "blackbox");
  }

  const currentDatabase = join(currentHome, "tekrion.sqlite");
  const legacyDatabase = join(legacyHome, "blackbox.sqlite");
  return !pathExists(currentDatabase) && pathExists(legacyDatabase)
    ? legacyHome
    : currentHome;
}

export interface ResolveDaemonPathsOptions {
  readonly pathExists?: (path: string) => boolean;
}

export function resolveDaemonPaths(
  homeDirectory?: string,
  options: ResolveDaemonPathsOptions = {},
): DaemonPaths {
  const pathExists = options.pathExists ?? existsSync;
  const resolvedHome = resolve(
    homeDirectory ?? defaultTekrionHome({ pathExists }),
  );
  const logDirectory = join(resolvedHome, "logs");
  const currentDatabase = join(resolvedHome, "tekrion.sqlite");
  const legacyDatabase = join(resolvedHome, "blackbox.sqlite");
  return {
    homeDirectory: resolvedHome,
    tokenPath: join(resolvedHome, "control.token"),
    lockPath: join(resolvedHome, "daemon.lock"),
    databasePath:
      !pathExists(currentDatabase) && pathExists(legacyDatabase)
        ? legacyDatabase
        : currentDatabase,
    dataDirectory: join(resolvedHome, "data"),
    logDirectory,
    logPath: join(logDirectory, "daemon.log"),
  };
}

export async function ensureInstallLayout(paths: DaemonPaths): Promise<void> {
  await ensurePrivateDirectory(paths.homeDirectory);
  await ensurePrivateDirectory(paths.dataDirectory);
  await ensurePrivateDirectory(paths.logDirectory);
}
