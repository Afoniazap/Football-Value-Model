import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildLocalHistoryContext, loadLocalHistory } from "../src/history/localHistory.js";
import { databaseStats, getTeamLastMatches, importHistoryMatches, openHistoryDatabase } from "../src/history/sqliteHistory.js";

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),".."),data=path.join(root,"data");
const jsonl=path.join(data,"history","fixtures.jsonl"),legacy=path.join(data,"history.json"),dbFile=path.join(data,"history","football.sqlite");
const state=JSON.parse(fs.readFileSync(path.join(data,"state.json"),"utf8")),fixtures=state.results||[],db=openHistoryDatabase(dbFile);
const rows=loadLocalHistory(jsonl,legacy);importHistoryMatches(db,rows);
const repeats=3,measure=fn=>{const started=performance.now();for(let i=0;i<repeats;i++)fn();return (performance.now()-started)/repeats;};
const beforeMs=measure(()=>{const history=loadLocalHistory(jsonl,legacy);for(const fixture of fixtures)buildLocalHistoryContext(history,fixture);});
const afterMs=measure(()=>{for(const fixture of fixtures){const relevant=[...getTeamLastMatches(db,fixture.home,fixture.utcDate,20),...getTeamLastMatches(db,fixture.away,fixture.utcDate,20)];buildLocalHistoryContext(relevant,fixture);}});
const readyKeys=new Set();
for(const fixture of fixtures){const relevant=[...getTeamLastMatches(db,fixture.home,fixture.utcDate,20),...getTeamLastMatches(db,fixture.away,fixture.utcDate,20)],context=buildLocalHistoryContext(relevant,fixture);if(context.standings)readyKeys.add(`${fixture.apiFootballLeagueId||fixture.competitionCode}|${fixture.seasonStart||""}`);}
console.log(JSON.stringify({fixtures:fixtures.length,matches:rows.length,repeats,beforeMs,afterMs,speedup:afterMs?beforeMs/afterMs:null,externalContextRequestsAvoidedPerRefresh:readyKeys.size,database:databaseStats(db,dbFile)},null,2));
db.close();
