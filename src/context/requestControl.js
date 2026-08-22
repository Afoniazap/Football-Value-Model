export function mapWithConcurrency(items, limit, mapper) {
  const results = new Array(items.length);
  let cursor = 0;
  async function worker() {
    while (cursor < items.length) {
      const index = cursor++;
      results[index] = await mapper(items[index], index);
    }
  }
  return Promise.all(Array.from({ length: Math.min(Math.max(1, limit), items.length) }, worker)).then(() => results);
}

export function createContextHttpClient({
  fetchImpl = fetch,
  timeoutSeconds = 15,
  minHostIntervalMs = 1_000,
  nowMs = () => Date.now(),
  wait = ms => new Promise(resolve => setTimeout(resolve, ms))
} = {}) {
  const lastByHost = new Map();

  async function fetchText(url, { retry = 1, userAgent = "FVM-Context/1.0 (+respectful cached research)" } = {}) {
    const host = new URL(url).host;
    const elapsed = nowMs() - (lastByHost.get(host) || 0);
    if (elapsed < minHostIntervalMs) await wait(minHostIntervalMs - elapsed);
    let lastError;
    for (let attempt = 0; attempt <= retry; attempt += 1) {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), timeoutSeconds * 1_000);
      try {
        lastByHost.set(host, nowMs());
        const response = await fetchImpl(url, { headers: { "User-Agent": userAgent, Accept: "text/html,application/rss+xml,application/atom+xml" }, signal: controller.signal });
        if (!response.ok) {
          const error = new Error(`HTTP ${response.status}`);
          error.code = `HTTP_${response.status}`;
          error.status = response.status;
          throw error;
        }
        return await response.text();
      } catch (error) {
        lastError = error;
        if (error.status && error.status < 500) break;
      } finally { clearTimeout(timeout); }
    }
    throw lastError;
  }

  return { fetchText };
}
