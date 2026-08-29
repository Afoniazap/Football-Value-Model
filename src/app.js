import "dotenv/config";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { beginFootballDataRefresh, getFootballDataTelemetry, getUpcomingMatches, getCompetitionContext, getFinishedFootballDataMatchesForDate, configureFootballData } from "./connectors/footballData.js";
import { getOddsForCompetitionResult, matchOddsEvent, extractMarkets } from "./connectors/odds.js";
import { getOddsApiIoMarkets } from "./connectors/oddsApiIo.js";
import { analyseFixture } from "./engine/analyse.js";
import { alignContextTeamIds } from "./engine/contextIds.js";
import { getUpcomingApiFootballMatches, getFixturesRisk, getFixturesOdds, getApiFootballCompetitionContext, getFinishedFixturesForDate, configureApiFootball, beginApiFootballRefresh, getApiFootballTelemetry } from "./connectors/apiFootball.js";
import { dashboardText, dashboardKeyboard, listText, listKeyboard, cardText, backKeyboard, metricKeyboard, metricText, detailKeyboard, statisticsText } from "./ui/telegram.js";
import { appendLocalHistory, buildLocalHistoryContext, loadRawLocalHistory, mergeWithLocalHistory } from "./history/localHistory.js";
import { backfillFromProviderCaches } from "./history/cacheBackfill.js";
import { discoverFixtures } from "./fixtures/discovery.js";
import { loadPredictionStatistics, updatePredictionHistory } from "./statistics/predictionHistory.js";
import { enforceMarketFreshness, resolveMarketSnapshots } from "./markets/marketSnapshots.js";
import { databaseStats, getTeamLastMatches, hasSourceDate, importHistoryMatches, loadAllHistory, openHistoryDatabase } from "./history/sqliteHistory.js";

const ROOT=path.resolve(path.dirname(fileURLToPath(import.meta.url)),"..");
const DATA=path.join(ROOT,"data");
const LOGS=path.join(ROOT,"logs");
fs.mkdirSync(DATA,{recursive:true}); fs.mkdirSync(LOGS,{recursive:true});
configureApiFootball({cacheDir:path.join(DATA,"api-football-cache")});
configureFootballData({cacheDir:path.join(DATA,"football-data-cache")});
const HISTORY_FILE=path.join(DATA,"history","fixtures.jsonl");
const LEGACY_HISTORY_FILE=path.join(DATA,"history.json");
const PREDICTION_HISTORY_FILE=path.join(DATA,"statistics","predictions.jsonl");
const MARKET_SNAPSHOT_FILE=path.join(DATA,"market-cache","snapshots.json");
const HISTORY_DB_FILE=path.join(DATA,"history","football.sqlite");
const historyDatabase=openHistoryDatabase(HISTORY_DB_FILE);
let historyImported=false;
let cacheBackfillDone=false;

function ensureHistoryDatabase(){
  if(!historyImported){
    importHistoryMatches(historyDatabase,loadRawLocalHistory(HISTORY_FILE,LEGACY_HISTORY_FILE));
    historyImported=true;
  }
}

function fixtureHistory(fixture,limit=20){
  ensureHistoryDatabase();
  const rows=[
    ...getTeamLastMatches(historyDatabase,{name:fixture.home},fixture.utcDate,limit),
    ...getTeamLastMatches(historyDatabase,{name:fixture.away},fixture.utcDate,limit)
  ];
  return [...new Map(rows.map(row=>[row.recordKey,row])).values()];
}

function appendHistory(matches,source,fetchedAt=new Date().toISOString()){
  return appendLocalHistory(HISTORY_FILE,matches,source,fetchedAt,rows=>importHistoryMatches(historyDatabase,rows));
}

const env=process.env;
const DEBUG=/^(1|true|yes)$/i.test(env.DEBUG||"");
const debugLog=(...args)=>{if(DEBUG)console.log(...args);};
for(const key of ["TELEGRAM_BOT_TOKEN","FOOTBALL_DATA_TOKEN","THE_ODDS_API_KEY"]){
  if(!env[key] || env[key].startsWith("PASTE_")){ console.error(`Добавьте ${key} в .env`); process.exit(1); }
}
const TG=`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN.trim()}`;
const allowed=new Set((env.ALLOWED_CHAT_IDS||"").split(",").map(x=>x.trim()).filter(Boolean));
const config={
  horizon:Number(env.HORIZON_HOURS||24),
  minEdge:Number(env.MIN_EDGE_PP||4),
  minEv:Number(env.MIN_EV_PERCENT||5),
  minConfidence:Number(env.MIN_CONFIDENCE||70),
  minDataQuality:Number(env.MIN_DATA_QUALITY||70),
  minStability:Number(env.MIN_STABILITY||70),
  maxRecommendations:Number(env.MAX_RECOMMENDATIONS||5)
};
let offset=0;
function loadSavedState(){
  try{
    const saved=JSON.parse(fs.readFileSync(path.join(DATA,"state.json"),"utf8"));
    return {...saved,loading:false,results:Array.isArray(saved.results)?saved.results:[],errors:Array.isArray(saved.errors)?saved.errors:[],providers:saved.providers||{}};
  }catch{return {loading:false,stage:"0/9",updatedAt:null,results:[],errors:[],providers:{}};}
}
let state=loadSavedState();
state.statistics=loadPredictionStatistics(PREDICTION_HISTORY_FILE);

async function tg(method,body={}){
  const r=await fetch(`${TG}/${method}`,{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify(body)});
  const d=await r.json(); if(!d.ok) throw new Error(`${method}: ${d.description}`); return d.result;
}
function permitted(id){return allowed.size===0||allowed.has(String(id));}
function save(){fs.writeFileSync(path.join(DATA,"state.json"),JSON.stringify(state,null,2),"utf8");}

async function updateLocalHistory(){
  const cacheBackfill=cacheBackfillDone
    ? {added:0,skipped:true}
    : backfillFromProviderCaches({dataDir:DATA,historyFile:HISTORY_FILE});
  cacheBackfillDone=true;
  ensureHistoryDatabase();

  const yesterday=new Date(Date.now()-86400000)
    .toISOString()
    .slice(0,10);

  const apiLoaded=hasSourceDate(historyDatabase,"API_FOOTBALL",yesterday);
  const footballDataLoaded=hasSourceDate(historyDatabase,"FOOTBALL_DATA",yesterday);
  const errors=[];
  let added=0;
  if(!apiLoaded){
    try{
      const finished=await getFinishedFixturesForDate(env.API_FOOTBALL_KEY.trim(),yesterday);
      added+=appendHistory(finished,"API_FOOTBALL");
    }catch(error){errors.push(`API_FOOTBALL:${error.message}`);}
  }
  if(!footballDataLoaded){
    try{
      const finished=await getFinishedFootballDataMatchesForDate(env.FOOTBALL_DATA_TOKEN.trim(),yesterday);
      added+=appendHistory(finished,"FOOTBALL_DATA");
    }catch(error){errors.push(`FOOTBALL_DATA:${error.message}`);}
  }
  const total=databaseStats(historyDatabase,HISTORY_DB_FILE).matches;

  return {
    added,
    total,
    skipped:apiLoaded&&footballDataLoaded,
    cacheBackfill,
    errors
  };
}

async function refresh(){
  debugLog("DEBUG: refresh start");
  if(state.loading)return;
  const timing={started:Date.now()};
  const previousResults=state.results;
  state.loading=true; state.errors=[]; state.stage="1/9 Data Integrity"; beginApiFootballRefresh();beginFootballDataRefresh();
  try{
    debugLog("DEBUG: before history");
    const historyStatus=await updateLocalHistory().catch(e=>{
      state.errors.push(`Local history: ${e.message}`);
      return {added:0,total:0};
    });
    state.providers.history={status:historyStatus.total?"OK":"EMPTY",source:"SQLITE",matches:historyStatus.total,added:historyStatus.added||0};

    debugLog("DEBUG: before fixtures");
    const discovery=await discoverFixtures({
      apiKey:env.API_FOOTBALL_KEY?.trim(),
      footballDataToken:env.FOOTBALL_DATA_TOKEN?.trim(),
      horizonHours:config.horizon,
      previousResults,
      apiFootball:getUpcomingApiFootballMatches,
      footballData:getUpcomingMatches
    });
    const fixtures=discovery.fixtures;
    const discoveryTelemetry=getApiFootballTelemetry();
    if(discoveryTelemetry.dailyLimit&&discovery.health.source==="API_FOOTBALL"){
      discovery.health.status="DEGRADED";
      discovery.health.source="API_FOOTBALL_CACHE";
      discovery.health.reason="DAILY_LIMIT";
    }
    state.providers.fixtures=discovery.health;
    if(discovery.health.status==="DEGRADED"){
      const detail=`API-Football fixtures: ${discovery.health.reason}; fallback ${discovery.health.source||"UNAVAILABLE"}`;
      state.errors.push(detail);
      console.warn(detail);
    }
    timing.fixtures=Date.now()-timing.started;
    debugLog("DEBUG: fixtures loaded", fixtures.length);
    ensureHistoryDatabase();
    state.stage="2/9 Match Classification";
    const codes=[...new Set(fixtures.map(x=>x.competitionCode).filter(Boolean))];
    const contexts={}, odds={}, contextDiagnostics={};
    state.providers.context={fallbacks:[],failures:[]};

    const contextKeys=[...new Set(
      fixtures
        .filter(f=>f.apiFootballLeagueId && f.seasonStart)
        .map(f=>`${f.apiFootballLeagueId}|${f.seasonStart}`)
    )];

    for(const contextKey of contextKeys){
      debugLog("DEBUG: context", contextKey);
      const [leagueId,season]=contextKey.split("|");
      const keyFixtures=fixtures.filter(f =>
        String(f.apiFootballLeagueId)===String(leagueId) &&
        String(f.seasonStart)===String(season)
      );
      const localReady=keyFixtures.length>0 && keyFixtures.every(f => {
        const local=buildLocalHistoryContext(fixtureHistory(f),f);
        return Boolean(local.standings && local.contextMeta.homeMatches>=4 && local.contextMeta.awayMatches>=4);
      });

      if(localReady){
        contexts[contextKey]={standings:null,finished:[],scheduled:[]};
        contextDiagnostics[contextKey]={status:"OK",source:"LOCAL_HISTORY",temporalSafe:true};
        continue;
      }

      state.stage=`3/9 API-Football Context: ${leagueId}`;

      let contextError=null;
      contexts[contextKey]=await getApiFootballCompetitionContext(
        env.API_FOOTBALL_KEY.trim(),
        Number(leagueId),
        season
      ).catch(e=>{
        contextError=e;
        return null;
      });

      if(!contexts[contextKey]){
        const sample=fixtures.find(f =>
          String(f.apiFootballLeagueId)===String(leagueId) &&
          String(f.seasonStart)===String(season)
        );

        if(sample?.competitionCode){
          contexts[contextKey]=await getCompetitionContext(
            env.FOOTBALL_DATA_TOKEN.trim(),
            sample.competitionCode
          ).catch(()=>null);
        }
      }
      if(contexts[contextKey]?.finished?.length){
        appendHistory(contexts[contextKey].finished,contextError?"FOOTBALL_DATA":"API_FOOTBALL");
      }
      const usableContext=Boolean(contexts[contextKey]?.standings||(contexts[contextKey]?.finished||[]).length);
      if(contextError&&usableContext)state.providers.context.fallbacks.push(`${contextKey}:FOOTBALL_DATA`);
      if(contextError&&!usableContext){
        const message=`API-Football context ${contextKey}: ${contextError.message}`;
        state.providers.context.failures.push(message);state.errors.push(message);
      }
      contextDiagnostics[contextKey]=usableContext
        ? {status:"OK",source:contextError?"FOOTBALL_DATA":"API_FOOTBALL",standings:Boolean(contexts[contextKey]?.standings),finished:(contexts[contextKey]?.finished||[]).length}
        : {status:"UNAVAILABLE",source:null,reason:contextError?.message||"NO_STANDINGS_OR_HISTORY",footballDataErrors:contexts[contextKey]?.contextMeta?.errors||[]};
    }

    timing.context=Date.now()-timing.started-timing.fixtures;
    const oddsStarted=Date.now();
    const primaryHealth={status:"NOT_NEEDED",requests:0,cacheHits:0,reasons:[]};
    for(const code of codes){
      const result=await getOddsForCompetitionResult(
        env.THE_ODDS_API_KEY.trim(),env.ODDS_REGION||"eu",code,
        {cacheDir:path.join(DATA,"market-cache","the-odds-api")}
      );
      odds[code]=result.events;
      primaryHealth.requests+=result.requests;primaryHealth.cacheHits+=result.cacheHits;
      if(result.status!=="OK")primaryHealth.reasons.push(`${code}:${result.reason||result.status}`);
      if(primaryHealth.status==="NOT_NEEDED"||result.status==="OK")primaryHealth.status=result.status;
    }
    const primaryCovered=new Set(fixtures.filter(f=>matchOddsEvent(f,odds[f.competitionCode]||[])).map(f=>f.id));
    const oddsApiIo=await getOddsApiIoMarkets({
      apiKey:env.ODDS_API_IO_KEY?.trim(),
      bookmakers:env.ODDS_API_IO_BOOKMAKERS?.trim(),
      fixtures:fixtures.filter(f=>!primaryCovered.has(f.id)),
      cacheDir:path.join(DATA,"market-cache","odds-api-io")
    });
    for(const error of historyStatus.errors||[])state.errors.push(`Daily history: ${error}`);
    const marketErrors=new Set();
    if(primaryHealth.reasons.length)marketErrors.add(`The Odds API: ${primaryHealth.reasons.join(", ")}`);
    if(oddsApiIo.errors.length)marketErrors.add(`odds-api.io: ${oddsApiIo.errors.join(", ")}`);
    state.providers.market={primary:primaryHealth,oddsApiIo:{status:oddsApiIo.status,requests:oddsApiIo.requests,cacheHits:oddsApiIo.cacheHits,supported:oddsApiIo.supported,matched:oddsApiIo.matched},apiFootballOdds:{status:"NOT_NEEDED",attempted:0,requests:0,cacheHits:0,matched:0,reasons:[]}};
    state.stage="4/9 Independent Models";

    // Сначала завершаем весь каскад рынков. Запросы injuries/lineups не должны
    // исчерпать API-Football quota до поиска котировок для оставшихся fixtures.
    const apiFallbackFixtures=fixtures.filter(f=>
      !primaryCovered.has(f.id)&&!oddsApiIo.byFixtureId[f.id]&&f.apiFootballFixtureId
    );
    const beforeOdds=getApiFootballTelemetry();
    let apiFootballMarkets={};
    state.providers.market.apiFootballOdds.attempted=apiFallbackFixtures.length;
    if(apiFallbackFixtures.length&&env.API_FOOTBALL_KEY){
      try{apiFootballMarkets=await getFixturesOdds(env.API_FOOTBALL_KEY.trim(),apiFallbackFixtures);}
      catch(e){state.providers.market.apiFootballOdds.reasons.push(e.message);marketErrors.add(`API-Football odds: ${e.message}`);}
    }
    const afterOdds=getApiFootballTelemetry();
    state.providers.market.apiFootballOdds.requests=afterOdds.requests-beforeOdds.requests;
    state.providers.market.apiFootballOdds.cacheHits=(afterOdds.cacheHits+afterOdds.staleHits)-(beforeOdds.cacheHits+beforeOdds.staleHits);

    const rawMarkets=new Map(),snapshotEntries=[];
    for(const f of fixtures){
      const event=matchOddsEvent(f,odds[f.competitionCode]||[]);
      const oddsApiIoEvent=oddsApiIo.byFixtureId[f.id]||null;
      const apiFootballMarket=apiFootballMarkets[String(f.apiFootballFixtureId)]||null;
      const freshMarket=event?{...extractMarkets(event),source:"THE_ODDS_API"}:oddsApiIoEvent?{...extractMarkets(oddsApiIoEvent),source:"ODDS_API_IO"}:apiFootballMarket?{...apiFootballMarket,source:"API_FOOTBALL"}:null;
      if(apiFootballMarket)state.providers.market.apiFootballOdds.matched++;
      rawMarkets.set(f.id,{event,oddsApiIoEvent,freshMarket});
      snapshotEntries.push({fixture:f,freshMarket});
    }
    const snapshots=resolveMarketSnapshots({filePath:MARKET_SNAPSHOT_FILE,entries:snapshotEntries,staleMs:Number(env.MARKET_STALE_MINUTES||360)*60_000});
    const resolvedMarkets=new Map();
    for(const f of fixtures){
      const {event,oddsApiIoEvent,freshMarket}=rawMarkets.get(f.id);
      const apiFootballReason=freshMarket?null:state.providers.market.apiFootballOdds.reasons[0]||"EMPTY_RESPONSE";
      resolvedMarkets.set(f.id,{event,oddsApiIoEvent,...snapshots.get(f.id),apiFootballReason});
    }
    const apiOdds=state.providers.market.apiFootballOdds;
    apiOdds.status=apiOdds.reasons.some(x=>x.includes("DAILY LIMIT"))?"DAILY_LIMIT":apiOdds.reasons.length?(apiOdds.matched?"PARTIAL":"ERROR"):apiOdds.matched?"OK":apiOdds.attempted?"NO_ODDS":"NOT_NEEDED";

    timing.odds=Date.now()-oddsStarted;
    const riskFixtures=fixtures.filter(f=>{
      const resolved=resolvedMarkets.get(f.id);
      return resolved?.marketData&&resolved.freshness==="FRESH"&&f.apiFootballFixtureId;
    });
    let fixtureRisks={};
    if(env.API_FOOTBALL_KEY&&riskFixtures.length&&!getApiFootballTelemetry().dailyLimit){
      try{fixtureRisks=await getFixturesRisk(env.API_FOOTBALL_KEY.trim(),riskFixtures);}
      catch(e){state.errors.push(`API-Football enrichment: ${e.message}`);}
    }

    const results=[];
    const modelStarted=Date.now();
    for(const f of fixtures){
      debugLog("DEBUG: fixture", f.home, "-", f.away, f.apiFootballFixtureId);
      const {event,oddsApiIoEvent,marketData,apiFootballReason,freshness,fetchedAt}=resolvedMarkets.get(f.id);
      const risk=fixtureRisks[String(f.apiFootballFixtureId)]||null;
      const squadData=risk?{
        apiFixtureId:f.apiFootballFixtureId,
        injuries:risk.injuries||[],
        lineups:risk.lineups||[],
        injuriesAvailable:true,
        lineupsAvailable:(risk.lineups||[]).length>0,
        confirmedLineups:(risk.lineups||[]).length>=2
      }:null;

      const baseContext=alignContextTeamIds(
        contexts[`${f.apiFootballLeagueId}|${f.seasonStart}`] || {
          standings:null,
          finished:[],
          scheduled:[]
        },f);

      const mergedContext=mergeWithLocalHistory(baseContext,fixtureHistory(f),f);
      const localMeta=mergedContext.localHistoryMeta;
      const hasLocalModelContext=Boolean(mergedContext.standings && localMeta?.homeMatches>=4 && localMeta?.awayMatches>=4);
      const fixtureContextDiagnostic=hasLocalModelContext
        ? {status:"OK",source:"LOCAL_HISTORY",finished:mergedContext.finished.length,provenance:localMeta.provenance,temporalSafe:true}
        : contextDiagnostics[`${f.apiFootballLeagueId}|${f.seasonStart}`]||{status:"UNAVAILABLE",reason:"NO_CONTEXT_MAPPING"};

      const fixtureWithMarketDiagnostic={...f,contextDiagnostic:fixtureContextDiagnostic,marketDiagnostic:{
        primary:event?"MATCHED":primaryHealth.status,
        oddsApiIo:oddsApiIoEvent?"MATCHED":oddsApiIo.status,
        apiFootballOdds:marketData?.source==="API_FOOTBALL"?"MATCHED":marketData?"NOT_NEEDED":apiFootballReason||"NO_QUOTES",
        selectedSource:marketData?.source||null,
        freshness,
        fetchedAt,
        normalizedBookmakers:marketData?.bookmakers?.length||0,
        matchConfidence:event?1:oddsApiIoEvent?.matchConfidence??(marketData?.source==="API_FOOTBALL"?1:null)
      }};
      let analysis=analyseFixture(
          fixtureWithMarketDiagnostic,
          mergedContext,
          marketData,
          config,
          squadData
        );
      analysis=enforceMarketFreshness(analysis,freshness);
      analysis.marketFetchedAt=fetchedAt;
      analysis.marketDiagnostic.marketSelection=analysis.markets.length?"CALCULATED":analysis.marketAvailable?"BLOCKED_NO_MODEL_CONTEXT":"NO_QUOTES";
      results.push(analysis);
    }
    timing.model=Date.now()-modelStarted;
    state.errors.push(...marketErrors);
    state.stage="7/9 Recommendation Engine";
    const values=results.filter(x=>x.category==="VALUE").sort((a,b)=>(b.best?.fds||0)-(a.best?.fds||0));
    const allowedIds=new Set(values.slice(0,config.maxRecommendations).map(x=>x.id));
    state.results=results.map(x=>x.category==="VALUE"&&!allowedIds.has(x.id)?{...x,category:"NEAR",reason:"Не вошёл в лимит лучших рекомендаций дня."}:x);
    const storageStarted=Date.now();
    state.statistics=updatePredictionHistory(PREDICTION_HISTORY_FILE,state.results,loadAllHistory(historyDatabase),new Date().toISOString());
    state.providers.apiFootball=getApiFootballTelemetry(env.REFRESH_MINUTES||30);
    state.updatedAt=new Date().toISOString(); state.stage="9/9 Complete";
    timing.storage=Date.now()-storageStarted;
    timing.total=Date.now()-timing.started;
    const footballDataTelemetry=getFootballDataTelemetry();
    state.performance={...timing,httpByProvider:{theOddsApi:primaryHealth.requests,oddsApiIo:oddsApiIo.requests,apiFootball:state.providers.apiFootball.requests,footballData:footballDataTelemetry.requests},httpTotal:primaryHealth.requests+oddsApiIo.requests+state.providers.apiFootball.requests+footballDataTelemetry.requests,cacheHits:primaryHealth.cacheHits+oddsApiIo.cacheHits+state.providers.apiFootball.cacheHits+state.providers.apiFootball.staleHits+footballDataTelemetry.cacheHits};
    save();
    console.log(`API-Football: req ${state.providers.apiFootball.requests} | cache ${state.providers.apiFootball.cacheHits+state.providers.apiFootball.staleHits} | saved ${state.providers.apiFootball.avoided} | est/day ${state.providers.apiFootball.estimatedDailyRequests}`);
    const fresh=state.results.filter(x=>x.marketFreshness==="FRESH").length,stale=state.results.filter(x=>x.marketFreshness==="STALE").length;
    console.log(`Fixtures: ${fixtures.length} | Context: ${results.filter(x=>x.contextDiagnostic?.status==="OK").length}/${fixtures.length} | Quotes: ${results.filter(x=>x.marketAvailable).length}/${fixtures.length} | Models: ${results.filter(x=>x.best).length}/${fixtures.length}`);
    console.log(`Fresh/Stale: ${fresh}/${stale} | HTTP: ${state.performance.httpTotal} | Cache hits: ${state.performance.cacheHits} | Refresh: ${(timing.total/1000).toFixed(1)}s`);
  }catch(e){
    state.providers.apiFootball=getApiFootballTelemetry(env.REFRESH_MINUTES||30);
    if(e?.code==="DAILY_LIMIT")console.error("API-Football: DAILY LIMIT");
    state.errors.push(e.message);console.error(e);save();
  }
  finally{state.loading=false;}
}
async function dashboard(chatId,msgId){
  const body={chat_id:chatId,text:dashboardText(state),parse_mode:"HTML",reply_markup:dashboardKeyboard(state)};
  if(msgId){body.message_id=msgId;try{return await tg("editMessageText",body)}catch{delete body.message_id}}
  return tg("sendMessage",body);
}
async function callback(q){
  const id=q.message?.chat?.id;if(!id||!permitted(id))return;
  await tg("answerCallbackQuery",{callback_query_id:q.id});
  if(q.data==="dashboard")return dashboard(id,q.message.message_id);
  if(q.data==="refresh"){await refresh();return dashboard(id,q.message.message_id)}
  if(q.data==="pipeline")return tg("sendMessage",{chat_id:id,text:`⚙️ <b>Pipeline</b>\n\n${state.stage}\n\n✅ Data Integrity\n✅ Classification\n✅ Team Strength\n✅ Form\n✅ SCI\n✅ Consensus\n✅ Market Value\n✅ Risk Gates\n✅ Recommendation`,parse_mode:"HTML",reply_markup:backKeyboard()});
  if(q.data==="statistics")return tg("sendMessage",{chat_id:id,text:statisticsText(state.statistics),parse_mode:"HTML",reply_markup:backKeyboard()});
  if(q.data.startsWith("list:")){
    const cat=q.data.split(":")[1],items=state.results.filter(x=>x.category===cat);
    return tg("sendMessage",{chat_id:id,text:listText(cat,items),parse_mode:"HTML",reply_markup:listKeyboard(items)});
  }
  if(q.data.startsWith("metric:")){
    const [,code,matchId] = q.data.split(":");
    const x = state.results.find(y=>y.id===matchId);
    if(!x)return;
    return tg("editMessageText",{
      chat_id:id,
      message_id:q.message.message_id,
      text:metricText(code,x),
      parse_mode:"HTML",
      reply_markup:detailKeyboard(matchId)
    });
  }

  if(q.data.startsWith("card:")){
    const x=state.results.find(y=>y.id===q.data.split(":")[1]);if(!x)return;
    return tg("editMessageText",{
      chat_id:id,
      message_id:q.message.message_id,
      text:cardText(x),
      parse_mode:"HTML",
      reply_markup:metricKeyboard(x)
    });
  }
}
async function message(m){
  const id=m.chat.id;if(!permitted(id))return tg("sendMessage",{chat_id:id,text:"Доступ закрыт."}).catch(()=>{});
  const t=m.text?.trim().toLowerCase();
  if(t==="/start"||t==="/dashboard")return dashboard(id);
  if(t==="/refresh"){await tg("sendMessage",{chat_id:id,text:"Запущен полный анализ FVM..."});await refresh();return dashboard(id)}
  if(t==="/id")return tg("sendMessage",{chat_id:id,text:`Ваш chat_id: <code>${id}</code>`,parse_mode:"HTML"});
  if(t==="/stats")return tg("sendMessage",{chat_id:id,text:statisticsText(state.statistics),parse_mode:"HTML",reply_markup:backKeyboard()});
  return tg("sendMessage",{chat_id:id,text:"Команды: /start /refresh /stats /id"});
}
async function main(){
  console.log("FVM Engine v0.5 starting...");
  await refresh();
  setInterval(refresh,Math.max(5,Number(env.REFRESH_MINUTES||30))*60000);
  while(true){
    try{
      const updates=await tg("getUpdates",{offset,timeout:30,allowed_updates:["message","callback_query"]});
      for(const u of updates){offset=u.update_id+1;if(u.message)await message(u.message);if(u.callback_query)await callback(u.callback_query)}
    }catch(e){console.error(e.message);await new Promise(r=>setTimeout(r,3000))}
  }
}
export { refresh, state };

if(process.argv[1] && path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  main();
}
