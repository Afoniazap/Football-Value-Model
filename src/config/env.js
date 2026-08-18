import "dotenv/config";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  DEFAULT_HORIZON_HOURS,
  DEFAULT_REQUEST_TIMEOUT_SECONDS
} from "./constants.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = path.resolve(__dirname, "../..");

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

  return {
    root: ROOT,
    telegramToken: requireSecret("TELEGRAM_BOT_TOKEN"),
    footballDataToken: requireSecret("FOOTBALL_DATA_TOKEN"),
    apiFootballKey: process.env.API_FOOTBALL_KEY?.trim() || "",
    oddsApiKey: process.env.THE_ODDS_API_KEY?.trim() || "",
    oddsRegion: process.env.ODDS_REGION?.trim() || "eu",
    minEdgePercent: numberFromEnv("MIN_EDGE_PERCENT", 4),
    minDataQuality: numberFromEnv("MIN_DATA_QUALITY", 65),
    refreshMinutes: Math.max(5, numberFromEnv("REFRESH_MINUTES", 30)),
    requestTimeoutSeconds: Math.max(
      5,
      numberFromEnv("REQUEST_TIMEOUT_SECONDS", DEFAULT_REQUEST_TIMEOUT_SECONDS)
    ),
    horizonHours: Math.max(1, numberFromEnv("HORIZON_HOURS", DEFAULT_HORIZON_HOURS)),
    logDeniedAccess: (process.env.LOG_DENIED_ACCESS || "true").toLowerCase() === "true",
    allowedChatIds: new Set(
      allowedChatIdsRaw
        .split(",")
        .map(v => v.trim())
        .filter(Boolean)
    )
  };
}
