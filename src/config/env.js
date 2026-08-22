import dotenv from "dotenv";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  DEFAULT_HORIZON_HOURS,
  DEFAULT_REQUEST_TIMEOUT_SECONDS
} from "./constants.js";
import { resolveRuntimeRoot } from "../storage/runtime.js";
import { contextConfigFromEnv } from "../context/config.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = path.resolve(__dirname, "../..");
export const PROJECT_ENV_FILE = path.join(ROOT, ".env");
dotenv.config({ path: PROJECT_ENV_FILE, override: true });

function numberFromEnv(name, fallback) {
  const value = Number(process.env[name] || fallback);
  return Number.isFinite(value) ? value : fallback;
}

function requireSecret(name) {
  const value = process.env[name]?.trim();
  if (!value || value.startsWith("PASTE_")) {
    throw new Error(`Заполните ${name} в файле .env`);
  }
  return value;
}

export function loadConfig() {
  const allowedChatIdsRaw = (process.env.ALLOWED_CHAT_IDS || "").trim();
  if (!allowedChatIdsRaw) {
    throw new Error("Заполните ALLOWED_CHAT_IDS в файле .env");
  }

  const oddsFreshMinutes = Math.max(1, numberFromEnv("ODDS_FRESH_MINUTES", 15));
  const oddsStaleMinutes = Math.max(1, numberFromEnv("ODDS_STALE_MINUTES", 60));

  if (oddsFreshMinutes >= oddsStaleMinutes) {
    throw new Error("ODDS_FRESH_MINUTES must be lower than ODDS_STALE_MINUTES");
  }

  return {
    root: ROOT,
    runtimeRoot: resolveRuntimeRoot(ROOT, process.env.FVM_RUNTIME_DIR),
    telegramToken: process.env.TELEGRAM_BOT_TOKEN?.trim() || "",
    footballDataToken: requireSecret("FOOTBALL_DATA_TOKEN"),
    apiFootballKey: process.env.API_FOOTBALL_KEY?.trim() || "",
    sportmonksApiKey: process.env.SPORTMONKS_API_KEY?.trim() || "",
    theStatsApiKey: process.env.THESTATSAPI_KEY?.trim() || "",
    oddsApiKey: process.env.THE_ODDS_API_KEY?.trim() || "",
    oddsRegion: process.env.ODDS_REGION?.trim() || "eu",
    oddsApiIoKey: process.env.ODDS_API_IO_KEY?.trim() || "",
    oddsApiIoBookmakers: process.env.ODDS_API_IO_BOOKMAKERS?.trim() || "",
    oddsApiIoCacheMinutes: Math.max(1, numberFromEnv("ODDS_API_IO_CACHE_MINUTES", 10)),
    oddsApiIoKickoffToleranceMinutes: Math.max(15, numberFromEnv("ODDS_API_IO_KICKOFF_TOLERANCE_MINUTES", 180)),
    apiFootballOddsCacheMinutes: Math.max(5, numberFromEnv("API_FOOTBALL_ODDS_CACHE_MINUTES", 180)),
    injuriesCacheHours: Math.max(1, numberFromEnv("INJURIES_CACHE_HOURS", 6)),
    lineupsEarlyCacheHours: Math.max(1, numberFromEnv("LINEUPS_EARLY_CACHE_HOURS", 6)),
    lineupsPrematchMinutes: Math.max(1, numberFromEnv("LINEUPS_PREMATCH_MINUTES", 90)),
    lineupsPrematchCacheMinutes: Math.max(1, numberFromEnv("LINEUPS_PREMATCH_CACHE_MINUTES", 15)),
    flashscoreEnabled: (process.env.FLASHSCORE_ENABLED || "true").toLowerCase() === "true",
    flashscoreCacheMinutes: Math.max(5, numberFromEnv("FLASHSCORE_CACHE_MINUTES", 15)),
    flashscoreDetailCacheMinutes: Math.max(5, numberFromEnv("FLASHSCORE_DETAIL_CACHE_MINUTES", 30)),
    flashscoreMinHostIntervalMs: Math.max(500, numberFromEnv("FLASHSCORE_MIN_HOST_INTERVAL_MS", 1500)),
    oddsFreshMinutes,
    oddsStaleMinutes,
    oddsRevisionThreshold: Math.max(0.001, numberFromEnv("ODDS_REVISION_THRESHOLD", 0.02)),
    closingWindowMinutes: Math.max(1, numberFromEnv("CLOSING_WINDOW_MINUTES", 30)),
    marketMatchMinConfidence: Math.max(0.5, Math.min(1, numberFromEnv("MARKET_MATCH_MIN_CONFIDENCE", 0.7))),
    minEdgePercent: numberFromEnv("MIN_EDGE_PERCENT", 4),
    minDataQuality: numberFromEnv("MIN_DATA_QUALITY", 65),
    refreshMinutes: Math.max(5, numberFromEnv("REFRESH_MINUTES", 30)),
    requestTimeoutSeconds: Math.max(
      5,
      numberFromEnv("REQUEST_TIMEOUT_SECONDS", DEFAULT_REQUEST_TIMEOUT_SECONDS)
    ),
    horizonHours: Math.max(1, numberFromEnv("HORIZON_HOURS", DEFAULT_HORIZON_HOURS)),
    logDeniedAccess: (process.env.LOG_DENIED_ACCESS || "true").toLowerCase() === "true",
    context: contextConfigFromEnv(process.env),
    allowedChatIds: new Set(
      allowedChatIdsRaw
        .split(",")
        .map(v => v.trim())
        .filter(Boolean)
    )
  };
}
