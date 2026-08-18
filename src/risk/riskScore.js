import { SourceStatus } from "../providers/providerResult.js";
import { redFlag, Severity } from "./redFlags.js";

function lineupsConfirmed(apiFootballResult) {
  const lineups = apiFootballResult?.data?.lineups || [];
  return Array.isArray(lineups) && lineups.length >= 2;
}

function bookmakerOdds(event) {
  const values = [];
  for (const book of event?.bookmakers || []) {
    const market = book.markets?.find(m => m.key === "h2h");
    if (!market) continue;
    const prices = market.outcomes?.map(outcome => outcome.price).filter(Boolean) || [];
    if (prices.length >= 3) values.push(prices);
  }
  return values;
}

function marketSpread(event) {
  const rows = bookmakerOdds(event);
  if (rows.length < 2) return 0;
  const flat = rows.flat();
  return Math.max(...flat) - Math.min(...flat);
}

function modelAgreement(model) {
  if (!model?.components) return 100;
  const values = [
    model.components.ppgH,
    model.components.ppgA,
    model.components.gdH,
    model.components.gdA,
    model.components.formH,
    model.components.formA
  ];
  if (values.some(value => !Number.isFinite(value))) return 100;
  const strengthPart = Math.abs((model.components.ppgH - model.components.ppgA) * 0.65 + (model.components.gdH - model.components.gdA) * 0.22);
  const formPart = Math.abs((model.components.formH - model.components.formA) * 0.75);
  const disagreement = Math.min(100, Math.abs(strengthPart - formPart) * 100);
  return Math.max(0, Math.round(100 - disagreement));
}

export function calculateRisk({ item, oddsEvent, apiFootballResult, providerStatuses = [] }) {
  const flags = [];
  let score = 100;

  if (!lineupsConfirmed(apiFootballResult)) {
    flags.push(redFlag(
      "LINEUPS_NOT_CONFIRMED",
      Severity.INFO,
      "Confirmed lineups are not available.",
      "api-football"
    ));
  }

  const injuries = apiFootballResult?.data?.injuries || [];
  if (injuries.length > 0) {
    flags.push(redFlag(
      "INJURIES_REPORTED",
      Severity.INFO,
      `${injuries.length} injuries/absences reported. No automatic key-player penalty without player importance data.`,
      "api-football"
    ));
  }

  const sourceProblems = providerStatuses.filter(result =>
    [SourceStatus.PARTIAL, SourceStatus.QUOTA, SourceStatus.ERROR].includes(result.status)
  );
  for (const source of sourceProblems) {
    flags.push(redFlag(
      "SOURCE_PARTIAL",
      source.status === SourceStatus.ERROR ? Severity.MEDIUM : Severity.LOW,
      `${source.source}: ${source.status}`,
      source.source
    ));
    score -= source.status === SourceStatus.ERROR ? 12 : 6;
  }

  const agreement = modelAgreement(item.model);
  if (agreement < 70) {
    flags.push(redFlag(
      "MODEL_DISAGREEMENT",
      Severity.MEDIUM,
      `Model components agreement is ${agreement}/100.`,
      "model"
    ));
    score -= 12;
  }

  if (marketSpread(oddsEvent) > 1.5) {
    flags.push(redFlag(
      "MARKET_DISAGREEMENT",
      Severity.LOW,
      "Bookmaker prices differ materially.",
      "odds"
    ));
    score -= 6;
  }

  return {
    score: Math.max(0, Math.min(100, score)),
    redFlags: flags,
    modelAgreement: agreement
  };
}

export function calculateDecisionConfidenceV2({ dataQuality, risk, modelAgreement, marketQuality }) {
  return Math.round(
    dataQuality.scoreNormalized * 0.4 +
    risk.score * 0.3 +
    modelAgreement * 0.2 +
    marketQuality * 0.1
  );
}
