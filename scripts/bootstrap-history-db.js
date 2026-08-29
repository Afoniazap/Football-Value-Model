import "dotenv/config";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { appendLocalHistory, loadRawLocalHistory } from "../src/history/localHistory.js";
import { backfillFromProviderCaches } from "../src/history/cacheBackfill.js";
import { auditHistoryIntegrity, databaseStats, importHistoryMatches, openHistoryDatabase } from "../src/history/sqliteHistory.js";
import { beginFootballDataRefresh, configureFootballData, getFinishedCompetitionSeason, getFootballDataTelemetry } from "../src/connectors/footballData.js";

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),".."),dataDir=path.join(root,"data");
const historyFile=path.join(dataDir,"history","fixtures.jsonl"),legacyFile=path.join(dataDir,"history.json"),dbFile=path.join(dataDir,"history","football.sqlite");
const network=process.argv.includes("--football-data"),maxArg=process.argv.find(value=>value.startsWith("--max-requests="));
const maxRequests=Math.max(0,Number(maxArg?.split("=")[1]||0));
const db=openHistoryDatabase(dbFile);
const cache=backfillFromProviderCaches({dataDir,historyFile});
const local=importHistoryMatches(db,loadRawLocalHistory(historyFile,legacyFile));
const report={cache,local,footballData:{enabled:network,attempts:0,requests:0,cacheHits:0,added:0,errors:[]}};

if(network&&maxRequests&&process.env.FOOTBALL_DATA_TOKEN?.trim()){
  configureFootballData({cacheDir:path.join(dataDir,"football-data-cache")});
  beginFootballDataRefresh();
  const targets=[];
  for(const code of ["PL","PD","BL1","SA","FL1","CL","EL"]){for(const season of [2025,2024,2023,2022,2021])targets.push({code,season});}
  for(const target of targets.slice(0,maxRequests)){
    try{
      const matches=await getFinishedCompetitionSeason(process.env.FOOTBALL_DATA_TOKEN.trim(),target.code,target.season);
      report.footballData.attempts++;
      report.footballData.added+=appendLocalHistory(historyFile,matches,"FOOTBALL_DATA",new Date().toISOString(),rows=>importHistoryMatches(db,rows));
    }catch(error){report.footballData.attempts++;report.footballData.errors.push(`${target.code}/${target.season}: ${error.message}`);}
  }
  Object.assign(report.footballData,getFootballDataTelemetry());
}

report.integrity=auditHistoryIntegrity(db);
report.database=databaseStats(db,dbFile);
console.log(JSON.stringify(report,null,2));
db.close();
