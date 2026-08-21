import fs from "node:fs";
import path from "node:path";

export function expandRuntimeDir(value, env = process.env) {
  const raw = String(value || "").trim();
  if (!raw) return "";
  const home = env.HOME || env.USERPROFILE || "";
  if (raw === "~") return home || raw;
  if (raw.startsWith("~/") || raw.startsWith("~\\")) {
    return home ? path.join(home, raw.slice(2)) : raw;
  }
  return raw
    .replace(/^\$HOME(?=\/|\\|$)/, home)
    .replace(/^\$\{HOME\}(?=\/|\\|$)/, home);
}

export function resolveRuntimeRoot(projectRoot, runtimeDir = process.env.FVM_RUNTIME_DIR, env = process.env) {
  const configured = expandRuntimeDir(runtimeDir, env);
  if (!configured) return path.join(projectRoot, "data");
  return path.resolve(projectRoot, configured);
}

export function ensureRuntimeDir(runtimeRoot) {
  fs.mkdirSync(runtimeRoot, { recursive: true });
  return runtimeRoot;
}

export function copyRuntimeData({ fromRoot, toRuntimeRoot }) {
  const source = path.join(fromRoot, "data");
  const target = ensureRuntimeDir(toRuntimeRoot);
  const copied = [];
  const skipped = [];

  if (!fs.existsSync(source)) {
    return { source, target, copied, skipped, reason: "SOURCE_RUNTIME_DATA_NOT_FOUND" };
  }

  function copyDir(src, dst) {
    fs.mkdirSync(dst, { recursive: true });
    for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
      const srcPath = path.join(src, entry.name);
      const dstPath = path.join(dst, entry.name);
      if (entry.isDirectory()) {
        copyDir(srcPath, dstPath);
        continue;
      }
      if (!entry.isFile()) continue;
      if (fs.existsSync(dstPath)) {
        skipped.push(path.relative(target, dstPath));
        continue;
      }
      fs.mkdirSync(path.dirname(dstPath), { recursive: true });
      fs.copyFileSync(srcPath, dstPath);
      copied.push(path.relative(target, dstPath));
    }
  }

  copyDir(source, target);
  return { source, target, copied, skipped };
}
