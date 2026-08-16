import { accessSync, constants } from "node:fs";
import path from "node:path";

function executableFile(candidate) {
  try {
    accessSync(candidate, constants.X_OK);
    return candidate;
  } catch {
    return null;
  }
}

function executableOnPath(env, platform) {
  for (const directory of (env.PATH || "").split(path.delimiter)) {
    if (!directory) continue;
    if (platform === "win32") {
      const nativeExecutable = executableFile(path.join(directory, "codex.exe"));
      if (nativeExecutable) return nativeExecutable;

      const npmEntry = executableFile(path.join(
        directory,
        "node_modules",
        "@openai",
        "codex",
        "bin",
        "codex.js",
      ));
      if (npmEntry) return npmEntry;
      continue;
    }

    const executable = executableFile(path.join(directory, "codex"));
    if (executable) return executable;
  }
  return null;
}

export function resolveCodexExecutable({
  explicit = process.env.CODEX_EXECUTABLE,
  env = process.env,
  platform = process.platform,
} = {}) {
  if (typeof explicit === "string" && explicit.trim()) return explicit.trim();

  const installedCli = executableOnPath(env, platform);
  if (installedCli) return installedCli;

  return "codex";
}
