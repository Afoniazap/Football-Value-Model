import fs from "node:fs";
import path from "node:path";

export function createCacheStore(root, initialState) {
  const dataDir = path.join(root, "data");
  const cacheFile = path.join(dataDir, "cache.json");

  function saveCache(state) {
    fs.mkdirSync(dataDir, { recursive: true });
    fs.writeFileSync(cacheFile, JSON.stringify(state, null, 2), "utf8");
  }

  function loadCache() {
    try {
      if (!fs.existsSync(cacheFile)) return initialState;
      const cached = JSON.parse(fs.readFileSync(cacheFile, "utf8"));
      return { ...initialState, ...cached, loading: false };
    } catch (error) {
      console.warn("Не удалось прочитать cache.json:", error.message);
      return initialState;
    }
  }

  return { saveCache, loadCache, cacheFile };
}
