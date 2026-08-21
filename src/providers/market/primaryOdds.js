import fs from "node:fs";
import path from "node:path";
import { fetchOddsForSport } from "../odds.js";
import { providerResult, SourceStatus } from "../providerResult.js";
import { resolveRuntimeRoot } from "../../storage/runtime.js";

const QUOTA_BACKOFF_HOURS = 24;

function readBackoff(file) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

function activeBackoff(file, now) {
  const payload = readBackoff(file);
  const until = new Date(payload?.until).getTime();
  return Number.isFinite(until) && until > new Date(now).getTime() ? payload : null;
}

function writeQuotaBackoff(file, now) {
  const setAt = new Date(now);
  const payload = {
    reason: "QUOTA",
    setAt: setAt.toISOString(),
    until: new Date(setAt.getTime() + QUOTA_BACKOFF_HOURS * 3600_000).toISOString()
  };
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(payload, null, 2), "utf8");
  return payload;
}

export async function oddsProviderPrimary({ request, oddsApiKey, oddsRegion, sportKey, root, runtimeRoot, now = new Date() }) {
  const source = sportKey ? `odds.${sportKey}` : "odds";
  const backoffFile = root ? path.join(resolveRuntimeRoot(root, runtimeRoot), "market", "the-odds-api-backoff.json") : null;
  const backoff = backoffFile ? activeBackoff(backoffFile, now) : null;
  if (oddsApiKey && backoff) {
    const result = providerResult({
      status: SourceStatus.QUOTA,
      source,
      data: [],
      error: { code: "QUOTA_BACKOFF", message: `The Odds API quota backoff active until ${backoff.until}` },
      meta: { sportKey, oddsRegion, reason: "QUOTA_BACKOFF", backoffUntil: backoff.until, requestsUsed: 0 }
    });
    return { ...result, events: [] };
  }

  const result = await fetchOddsForSport({ request, oddsApiKey, oddsRegion, sportKey });
  if (result.status === SourceStatus.QUOTA && backoffFile) {
    const saved = writeQuotaBackoff(backoffFile, now);
    result.meta = { ...result.meta, reason: "QUOTA", backoffUntil: saved.until, requestsUsed: 1 };
  }
  return {
    status: result.status,
    source: result.source,
    fetchedAt: result.fetchedAt,
    events: result.data || [],
    meta: result.meta || {},
    error: result.error || null
  };
}
