import { classifyMatch, teamStrengthModel, formModel, scheduleCongestion, consensus } from "./models.js";
import { evaluateMarkets, decisionMetrics } from "./markets.js";
import { clamp } from "./utils.js";

export function analyseFixture(fixture, context, oddsData, config, squadData=null) {
  const stage = {};
  stage.classification = classifyMatch(fixture,context);
  const strength = teamStrengthModel(fixture,context);
  const form = formModel(fixture,context);
  const sci = scheduleCongestion(fixture,context);
  const cons = consensus([strength,form]);

  if (!strength || !cons) {
    return {
      ...fixture, category:"WAIT", reason:"Недостаточно реальных данных для независимой модели.",
      dataQuality:42, stability:35, consensusScore:0, sci, markets:[]
    };
  }

  const sampleScore = Math.round(
  clamp(((context?.finished || []).length / 120) * 20, 0, 20)
);

const formScore = form ? 15 : 0;

const homeAwayScore =
  context?.standings?.standings?.some(s => s.type === "HOME") &&
  context?.standings?.standings?.some(s => s.type === "AWAY")
    ? 15
    : 0;

const marketScore = oddsData
  ? Math.round(
      clamp((oddsData.bookmakers?.length || 0) * 2.5, 0, 15)
    )
  : 0;

const freshnessScore =
  (context?.finished || []).length ? 10 : 0;

// Настоящий xG пока не подключён.
const xgScore = 0;

// API-Football: травмы и составы.
const injuriesAvailable = !!squadData?.injuriesAvailable;
const lineupsAvailable = !!squadData?.lineupsAvailable;
const confirmedLineups = !!squadData?.confirmedLineups;
const injuryCount = squadData?.injuries?.length || 0;

// Максимум 10 баллов за squad data:
// 3 — API вернул injuries
// 3 — доступны lineups
// 4 — составы обеих команд подтверждены
const squadScore =
  (injuriesAvailable ? 3 : 0) +
  (lineupsAvailable ? 3 : 0) +
  (confirmedLineups ? 4 : 0);

const dataQuality = Math.round(
  clamp(
    sampleScore +
      freshnessScore +
      homeAwayScore +
      formScore +
      marketScore +
      xgScore +
      squadScore,
    0,
    100
  )
);

const dataQualityV2 = {
  sampleScore,
  freshnessScore,
  homeAwayScore,
  formScore,
  marketScore,
  xgScore,
  squadScore,
  injuriesAvailable,
  lineupsAvailable,
  confirmedLineups,
  injuryCount,
  apiFixtureId: squadData?.apiFixtureId || null
};
  const sciPenalty = sci.known ? Math.min(15,Math.abs(sci.differential)*0.12) : 8;
  const stability = Math.round(clamp(cons.agreement - sciPenalty,0,100));
  const redFlags = [];

  if (!squadData)
    redFlags.push("API-Football: матч не сопоставлен");
  else {
    if (!injuriesAvailable)
      redFlags.push("API-Football: injuries N/A");

    if (!lineupsAvailable)
      redFlags.push("API-Football: lineups N/A");
  }

  if (!oddsData) redFlags.push("Нет рыночной линии");
  if (!sci.known) redFlags.push("SCI неполный");
  if (dataQuality < config.minDataQuality) redFlags.push("Data Quality ниже порога");
  if (cons.agreement < 65) redFlags.push("Низкий Consensus");

  const markets = evaluateMarkets(fixture,strength,cons,oddsData);
  const priced = markets.filter(x=>Number.isFinite(x.edge) && Number.isFinite(x.ev));

  const ranked = priced.map(c => {
    const metrics = decisionMetrics(c,dataQuality,cons.agreement,stability,oddsData?.agreement,redFlags);
    return {...c,...metrics};
  }).sort((a,b)=>b.fds-a.fds);

  const best = ranked[0] || null;
  let category = "WAIT", reason = "Нет доступных коэффициентов для подтверждения value.";

  if (best) {
    const passes = best.edge >= config.minEdge &&
      best.ev >= config.minEv &&
      best.confidence >= config.minConfidence &&
      dataQuality >= config.minDataQuality &&
      stability >= config.minStability;

    if (passes) {
      category = "VALUE";
      reason = "Прошёл все пороги FVM v1.0.";
    } else if (
      best.edge >= config.minEdge-2 &&
      best.ev >= config.minEv-3 &&
      best.confidence >= config.minConfidence-8
    ) {
      category = "NEAR";
      reason = "Близок к порогу, но не прошёл все Quality Gates.";
    } else {
      category = "NO_BET";
      reason = "Преимущество или качество решения ниже порогов.";
    }
  }

  return {
    ...fixture, category, reason, classification:stage.classification,
    dataQuality, dataQualityV2, stability, consensusScore:cons.agreement,
    stabilityV2: {
      consensus: cons.agreement,
      sciPenalty: Number(sciPenalty.toFixed(1))
    },
    marketAgreement:oddsData?.agreement ?? null,
    sci, redFlags, models:cons.models.map(m=>({name:m.name,quality:m.quality,explanation:m.explanation})),
    consensusProbability:cons.probability,
    markets:ranked,
    best
  };
}
