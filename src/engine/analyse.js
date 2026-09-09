import { classifyMatch, teamStrengthModel, formModel, scheduleCongestion, consensus } from "./models.js";
import { evaluateMarkets, decisionMetrics } from "./markets.js";
import { clamp } from "./utils.js";

export function calculateDataQuality(context,oddsData,form,squadData=null){
  const sampleScore=Math.round(clamp(((context?.finished||[]).length/120)*20,0,20));
  const formScore=form?15:0;
  const homeAwayScore=context?.standings?.standings?.some(s=>s.type==="HOME")&&
    context?.standings?.standings?.some(s=>s.type==="AWAY")?15:0;
  const marketScore=oddsData?Math.round(clamp((oddsData.bookmakers?.length||0)*2.5,0,15)):0;
  const freshnessScore=(context?.finished||[]).length?10:0;
  const xgScore=0;
  const injuriesAvailable=!!squadData?.injuriesAvailable;
  const lineupsAvailable=!!squadData?.lineupsAvailable;
  const confirmedLineups=!!squadData?.confirmedLineups;
  const injuryCount=squadData?.injuries?.length||0;
  const squadScore=(injuriesAvailable?3:0)+(lineupsAvailable?3:0)+(confirmedLineups?4:0);
  const components={sampleScore,freshnessScore,homeAwayScore,formScore,marketScore,xgScore,squadScore};
  const dataQuality=Math.round(clamp(Object.values(components).reduce((sum,value)=>sum+value,0),0,100));
  return {dataQuality,dataQualityV2:{
    ...components,
    injuriesAvailable,lineupsAvailable,confirmedLineups,injuryCount,
    xgAvailable:false,
    apiFixtureId:squadData?.apiFixtureId||null
  }};
}

export function analyseFixture(fixture, context, oddsData, config, squadData=null) {
  const stage = {};
  stage.classification = classifyMatch(fixture,context);
  const strength = teamStrengthModel(fixture,context);
  const form = formModel(fixture,context);
  const sci = scheduleCongestion(fixture,context);
  const cons = consensus([strength,form]);
  const {dataQuality,dataQualityV2}=calculateDataQuality(context,oddsData,form,squadData);

  if (!strength || !cons) {
    return {
      ...fixture, category:"WAIT", reason:"Недостаточно реальных данных для независимой модели.",
      dataQuality, dataQualityV2, stability:null, consensusScore:null, modelAgreement:null,
      modelCoverage:0, modelsAvailable:0, sci, markets:[],
      marketAvailable:!!oddsData, marketSource:oddsData?.source || null,
      redFlags:["Недостаточно данных модели",...(!oddsData?["Нет рыночной линии"]:[])]
    };
  }

  const {injuriesAvailable,lineupsAvailable}=dataQualityV2;
  const sciPenalty = sci.known ? Math.min(15,Math.abs(sci.differential)*0.12) : 8;
  const stability = Number.isFinite(cons.agreement)
    ? Math.round(clamp(cons.agreement - sciPenalty,0,100))
    : null;
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
  if (Number.isFinite(cons.agreement) && cons.agreement < 65) redFlags.push("Низкий Consensus");

  const markets = evaluateMarkets(fixture,strength,cons,oddsData);
  const priced = markets.filter(x=>Number.isFinite(x.edge) && Number.isFinite(x.ev));

  // Section 14 sanity/plausibility guards — additive red flags only, no
  // threshold changes. Both lambda clamps hitting the SAME bound at once —
  // either both at the floor (0.25/0.20) or both at the ceiling (3.4/3.1) —
  // is the exact, proven root cause behind implausible readings on
  // thin/degenerate context: the score matrix stops reflecting real team
  // data and collapses to a fixed artifact shared by every fixture in that
  // state (09.09 forensic audit: floor/floor reproduces the reported 67%
  // draw to the decimal — P(draw)=66.99%; ceiling/ceiling reproduces the
  // reported OU "Fair 1.36" to the decimal). Uses the model's own existing
  // clamp constants — not a new invented threshold.
  const bothLambdasAtFloor = strength.lambdas.home <= 0.25 && strength.lambdas.away <= 0.20;
  const bothLambdasAtCeiling = strength.lambdas.home >= 3.4 && strength.lambdas.away >= 3.1;
  const extremeExpectedGoals = bothLambdasAtFloor || bothLambdasAtCeiling;
  if (extremeExpectedGoals)
    redFlags.push("EXTREME_EXPECTED_GOALS: λ на границе клампа — context вырожден");
  // A model priced as near-certain (fairOdds<=1.05) while the market prices
  // the same selection as a longshot (odds>=4, i.e. implied <=25%) is not a
  // value signal — a >4x fair/market gap means model and market are pricing
  // different events (wrong competition/context, degenerate λ, stale odds),
  // documented disagreement threshold per audit section 14.
  if (priced.some(c => Number.isFinite(c.fairOdds) && c.fairOdds <= 1.05 && Number.isFinite(c.odds) && c.odds >= 4))
    redFlags.push("EXTREME_MODEL_MARKET_DISAGREEMENT: модель и рынок расходятся кратно");

  // Section 12: OU/AH totals are priced solely from Team Strength's score
  // matrix — formModel never contributes to it (see models.js), so the
  // blended 1X2 cons.agreement/stability is not evidence about the
  // totals/handicap estimate and must not be borrowed to inflate their
  // confidence. Only 1X2/DNB (genuinely multi-model) use cons.agreement.
  const ouModelCoverage = 1/2; // exactly one model ever produces the totals/AH score matrix
  const ranked = priced.map(c => {
    const singleModelMarket = c.market === "OU" || c.market === "AH";
    const metrics = decisionMetrics(c,dataQuality,
      singleModelMarket ? null : cons.agreement,
      singleModelMarket ? null : stability,
      oddsData?.agreement,redFlags);
    return {...c,...metrics};
  }).sort((a,b)=>b.fds-a.fds);

  // OU/AH are priced entirely from this fixture's score matrix; when both λ
  // are collapsed to the same clamp bound (extremeExpectedGoals) that matrix
  // is a shared degenerate artifact, not a real estimate — such a candidate
  // must never win `best` and dictate category, no matter how attractive its
  // (equally degenerate) edge/EV/FDS look. 1X2 normally blends in formModel,
  // an independent estimate that can correct for a degenerate score matrix —
  // but when modelsAvailable<2 (form absent, e.g. early-season/no-history
  // fixtures) consensus.probability IS the raw degenerate matrix split with
  // nothing to dilute it (09.09 audit: floor/floor produced a bare, unmixed
  // P(draw)=66.99% that won `best` under this exact single-model condition,
  // reproduced end-to-end via analyseFixture). All candidates, degraded or
  // not, stay visible in `markets:ranked` for audit/transparency.
  const degradedSingleModel1x2 = extremeExpectedGoals && cons.modelsAvailable < 2;
  const eligibleForBest = c => !(
    (extremeExpectedGoals && (c.market==="OU"||c.market==="AH")) ||
    (degradedSingleModel1x2 && c.market==="1X2")
  );
  const best = ranked.find(eligibleForBest) || null;
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
    modelAgreement:cons.agreement, modelCoverage:cons.modelCoverage, modelsAvailable:cons.modelsAvailable,
    stabilityV2: {
      consensus: cons.agreement,
      modelAgreement: cons.agreement,
      sciPenalty: Number(sciPenalty.toFixed(1))
    },
    marketAgreement:oddsData?.agreement ?? null,
    ouModelCoverage, ouModelAgreement:null, ouStability:null,
    sci, redFlags, models:cons.models.map(m=>({name:m.name,quality:m.quality,explanation:m.explanation})),
    consensusProbability:cons.probability,
    markets:ranked, marketAvailable:!!oddsData, marketSource:oddsData?.source || null,
    best
  };
}
