import fs from "node:fs";
import path from "node:path";

export function createContextCache(runtimeRoot, { debug = false } = {}) {
  const file = path.join(runtimeRoot, "context", "cache.json");
  function read() {
    try { return fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8")) : {}; } catch { return {}; }
  }
  function get(key, ttlMinutes, now = new Date()) {
    const row = read()[key];
    const fresh = row && now.getTime() - new Date(row.fetchedAt).getTime() <= ttlMinutes * 60_000;
    if (debug) console.debug(`[context-cache] ${fresh ? "hit" : "miss"} ${key}`);
    return fresh ? row.data : null;
  }
  function set(key, data, now = new Date()) {
    try {
      const state = read();
      state[key] = { fetchedAt: now.toISOString(), data };
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, JSON.stringify(state, null, 2), "utf8");
    } catch (error) {
      if (debug) console.debug(`[context-cache] write failed: ${error.message}`);
    }
  }
  return { get, set, file };
}
