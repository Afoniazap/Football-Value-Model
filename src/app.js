import { loadConfig } from "./config/env.js";
import { MODEL_VERSION, SPORT_KEYS } from "./config/constants.js";
import { fetchCompetitionContext, fetchFixtures } from "./providers/footballData.js";
import { fetchOddsForSport } from "./providers/odds.js";
import { buildModel } from "./model/probability.js";
import { findOddsEvent } from "./market/oddsMatching.js";
import { classify } from "./decision/classify.js";
import { createCacheStore } from "./storage/cache.js";
import { createHistoryStore } from "./storage/history.js";
import { createSourceHealth } from "./diagnostics/sourceHealth.js";
import { createTelegramUi } from "./ui/telegram.js";

function createInitialState() {
  return {
    updatedAt: null,
    loading: false,
    fixtures: [],
    value: [],
    near: [],
    wait: [],
    rejected: [],
    errors: [],
    sourceHealth: {}
  };
}

function createRequest(timeoutSeconds) {
  const timeoutMs = timeoutSeconds * 1000;

  return async function request(url, options = {}) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const response = await fetch(url, { ...options, signal: controller.signal });
      if (!response.ok) {
        const text = await response.text();
        throw new Error(`${response.status}: ${text.slice(0, 220)}`);
      }
      return response.json();
    } catch (error) {
      if (error.name === "AbortError") {
        throw new Error(`Request timeout after ${timeoutSeconds}s`);
      }
      throw error;
    } finally {
      clearTimeout(timeout);
    }
  };
}

function createTelegramRequest(config, request) {
  const tgApi = `https://api.telegram.org/bot${config.telegramToken}`;

  return async function tg(method, body = {}) {
    const data = await request(`${tgApi}/${method}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body)
    });
    if (!data.ok) throw new Error(`${method}: ${data.description}`);
    return data.result;
  };
}

function providerErrorMessages(results) {
  return results
    .filter(result => result?.error)
    .map(result => `${result.source}: ${result.error.message}`);
}

function createAnalysisId(date = new Date()) {
  return `${date.toISOString().replace(/[-:.TZ]/g, "")}-${Math.random().toString(36).slice(2, 8)}`;
}

export async function main() {
  let config;
  try {
    config = loadConfig();
  } catch (error) {
    console.error("Ошибка конфигурации:", error.message);
    process.exit(1);
  }

  const request = createRequest(config.requestTimeoutSeconds);
  const tg = createTelegramRequest(config, request);
  const cacheStore = createCacheStore(config.root, createInitialState());
  const historyStore = createHistoryStore(config.root);
  const stateRef = { current: cacheStore.loadCache() };

  async function refreshData() {
    if (stateRef.current.loading) return;
    stateRef.current.loading = true;
    stateRef.current.errors = [];

    const providerResults = [];
    const analysedAt = new Date();
    const horizonStart = analysedAt.toISOString();
    const horizonEnd = new Date(analysedAt.getTime() + config.horizonHours * 3600_000).toISOString();
    const analysisId = createAnalysisId(analysedAt);

    try {
      const fixturesResult = await fetchFixtures({
        request,
        token: config.footballDataToken,
        horizonHours: config.horizonHours
      });
      providerResults.push(fixturesResult);

      const fixtures = fixturesResult.data || [];
      const competitionCodes = [...new Set(fixtures.map(f => f.competitionCode).filter(Boolean))];

      const contexts = {};
      for (const code of competitionCodes) {
        const contextResult = await fetchCompetitionContext({
          request,
          token: config.footballDataToken,
          code
        });
        providerResults.push(contextResult);
        contexts[code] = contextResult.data;
      }

      const oddsByCode = {};
      for (const code of competitionCodes) {
        const sportKey = SPORT_KEYS[code];
        const oddsResult = await fetchOddsForSport({
          request,
          oddsApiKey: config.oddsApiKey,
          oddsRegion: config.oddsRegion,
          sportKey
        });
        providerResults.push(oddsResult);
        oddsByCode[code] = oddsResult.data || [];
      }

      const processed = fixtures.map(fixture => {
        const modelled = buildModel(fixture, contexts[fixture.competitionCode]);
        const oddsEvent = findOddsEvent(
          fixture,
          oddsByCode[fixture.competitionCode] || []
        );
        return classify(modelled, oddsEvent, config);
      });

      stateRef.current = {
        ...stateRef.current,
        fixtures: processed,
        value: processed.filter(x => x.category === "value"),
        near: processed.filter(x => x.category === "near"),
        wait: processed.filter(x => x.category === "wait"),
        rejected: processed.filter(x => x.category === "rejected"),
        updatedAt: analysedAt.toISOString(),
        errors: providerErrorMessages(providerResults),
        sourceHealth: createSourceHealth(providerResults)
      };

      cacheStore.saveCache(stateRef.current);
      historyStore.appendAnalysis({
        analysisId,
        analysedAt: analysedAt.toISOString(),
        horizonStart,
        horizonEnd,
        fixtures: processed.length,
        providerStatuses: stateRef.current.sourceHealth,
        modelVersion: MODEL_VERSION
      });
      historyStore.appendSignals({
        analysisId,
        analysedAt: analysedAt.toISOString(),
        items: processed
      });

      console.log(
        `Обновлено ${processed.length} матчей | VALUE ${stateRef.current.value.length} | Near ${stateRef.current.near.length} | WAIT ${stateRef.current.wait.length} | NO BET ${stateRef.current.rejected.length}`
      );
    } catch (error) {
      stateRef.current.errors.push(error.message);
      console.error("Refresh error:", error.message);
      cacheStore.saveCache(stateRef.current);
    } finally {
      stateRef.current.loading = false;
    }
  }

  const ui = createTelegramUi({ config, tg, stateRef, refreshData });
  let offset = 0;

  console.log("FVM v1.0 CLEAN запускается...");
  console.log(`Рабочая папка: ${config.root}`);

  await refreshData();
  setInterval(refreshData, config.refreshMinutes * 60_000);

  while (true) {
    try {
      const updates = await tg("getUpdates", {
        offset,
        timeout: 30,
        allowed_updates: ["message", "callback_query"]
      });

      for (const update of updates) {
        offset = update.update_id + 1;
        if (update.message) await ui.handleMessage(update.message);
        if (update.callback_query) await ui.handleCallback(update.callback_query);
      }
    } catch (error) {
      console.error(new Date().toISOString(), error.message);
      await new Promise(resolve => setTimeout(resolve, 3000));
    }
  }
}

main();
