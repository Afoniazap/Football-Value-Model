import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { canonicalTeamName, sameTeamIdentity, teamIdentityEvidence, teamSearchAliases } from "./teamAliases.js";

const FINISHED=new Set(["FT","AET","PEN","FINISHED"]);

const numberOrNull=value=>{
  if(value===null||value===undefined||value==="")return null;
  const number=Number(String(value).replace("%",""));
  return Number.isFinite(number)?number:null;
};

function statisticValue(statistics,names){
  if(!statistics)return null;
  const wanted=new Set(names.map(name=>name.toLowerCase()));
  if(Array.isArray(statistics)){
    for(const group of statistics){
      for(const row of group?.statistics||group?.stats||[]){
        if(wanted.has(String(row.type||row.name||"").toLowerCase()))return numberOrNull(row.value);
      }
    }
  }
  if(typeof statistics==="object"){
    for(const [name,value] of Object.entries(statistics)){
      if(wanted.has(name.toLowerCase()))return numberOrNull(value);
    }
  }
  return null;
}

function identity(row){
  return `${String(row.playedAt).slice(0,16)}|${canonicalTeamName(row.homeTeam?.name)}|${canonicalTeamName(row.awayTeam?.name)}`;
}

function sourceSport(row){return String(row.sport||row.provenance?.sport||"FOOTBALL").toUpperCase();}

export function openHistoryDatabase(filePath){
  fs.mkdirSync(path.dirname(filePath),{recursive:true});
  const db=new DatabaseSync(filePath);
  db.exec("PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL; PRAGMA foreign_keys=ON;");
  db.exec(`
    CREATE TABLE IF NOT EXISTS matches (
      id INTEGER PRIMARY KEY,
      identityKey TEXT NOT NULL UNIQUE,
      providerFixtureId TEXT,
      source TEXT NOT NULL,
      competition TEXT,
      competitionCode TEXT,
      season TEXT,
      kickoff TEXT NOT NULL,
      homeTeamId TEXT,
      homeTeam TEXT NOT NULL,
      homeTeamNormalized TEXT NOT NULL,
      awayTeamId TEXT,
      awayTeam TEXT NOT NULL,
      awayTeamNormalized TEXT NOT NULL,
      homeGoals INTEGER NOT NULL,
      awayGoals INTEGER NOT NULL,
      status TEXT NOT NULL,
      venue TEXT,
      shots REAL,
      shotsOnTarget REAL,
      possession REAL,
      corners REAL,
      cards REAL,
      xG REAL,
      statistics TEXT,
      provenance TEXT NOT NULL,
      fetchedAt TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS match_sources (
      matchId INTEGER NOT NULL REFERENCES matches(id) ON DELETE CASCADE,
      source TEXT NOT NULL,
      providerFixtureId TEXT NOT NULL,
      homeGoals INTEGER NOT NULL,
      awayGoals INTEGER NOT NULL,
      fetchedAt TEXT NOT NULL,
      provenance TEXT NOT NULL,
      PRIMARY KEY(source,providerFixtureId)
    );
    CREATE INDEX IF NOT EXISTS idx_matches_kickoff ON matches(kickoff);
    CREATE INDEX IF NOT EXISTS idx_matches_competition_season ON matches(competitionCode,season);
    CREATE INDEX IF NOT EXISTS idx_matches_home_team_id ON matches(homeTeamId);
    CREATE INDEX IF NOT EXISTS idx_matches_away_team_id ON matches(awayTeamId);
    CREATE INDEX IF NOT EXISTS idx_matches_home_normalized ON matches(homeTeamNormalized,kickoff DESC);
    CREATE INDEX IF NOT EXISTS idx_matches_away_normalized ON matches(awayTeamNormalized,kickoff DESC);
    CREATE INDEX IF NOT EXISTS idx_matches_provider_fixture ON matches(providerFixtureId);
    CREATE INDEX IF NOT EXISTS idx_matches_source ON matches(source);
    CREATE INDEX IF NOT EXISTS idx_sources_match ON match_sources(matchId);
  `);
  return db;
}

function insertRow(db,row){
  if(!row?.playedAt||!row.homeTeam?.name||!row.awayTeam?.name)return {inserted:0,rejected:"INVALID_IDENTITY"};
  if(!FINISHED.has(String(row.status||"FINISHED").toUpperCase()))return {inserted:0,rejected:"NOT_FINISHED"};
  if(sourceSport(row)!=="FOOTBALL"&&sourceSport(row)!=="SOCCER")return {inserted:0,rejected:"WRONG_SPORT"};
  const homeGoals=numberOrNull(row.score?.fullTime?.home),awayGoals=numberOrNull(row.score?.fullTime?.away);
  if(homeGoals===null||awayGoals===null)return {inserted:0,rejected:"MISSING_SCORE"};
  const kickoff=new Date(row.playedAt).toISOString(),source=String(row.provenance?.source||"UNKNOWN").toUpperCase();
  if(source==="THESPORTSDB"){
    for(const team of [row.homeTeam,row.awayTeam]){
      const evidence=teamIdentityEvidence(team.name);
      if(evidence?.source==="THESPORTSDB"&&team.id!=null&&String(team.id)!==String(evidence.teamId))return {inserted:0,rejected:"IDENTITY_MISMATCH"};
    }
  }
  const providerFixtureId=String(row.sourceFixtureId||row.fixtureId||row.recordKey||identity(row));
  const rawSeason=row.competition?.season;
  const season=typeof rawSeason==="object"?rawSeason?.startDate??rawSeason?.year??null:rawSeason;
  const provenance=JSON.stringify({...row.provenance,source,sources:[...new Set([...(row.provenance?.sources||[]),source])]});
  const statistics=row.statistics?JSON.stringify(row.statistics):null;
  const info=db.prepare(`INSERT OR IGNORE INTO matches (
    identityKey,providerFixtureId,source,competition,competitionCode,season,kickoff,
    homeTeamId,homeTeam,homeTeamNormalized,awayTeamId,awayTeam,awayTeamNormalized,
    homeGoals,awayGoals,status,venue,shots,shotsOnTarget,possession,corners,cards,xG,
    statistics,provenance,fetchedAt
  ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
    identity(row),providerFixtureId,source,row.competition?.name??null,row.competition?.code??null,
    season!=null?String(season):null,kickoff,
    row.homeTeam.id!=null?String(row.homeTeam.id):null,row.homeTeam.name,canonicalTeamName(row.homeTeam.name),
    row.awayTeam.id!=null?String(row.awayTeam.id):null,row.awayTeam.name,canonicalTeamName(row.awayTeam.name),
    homeGoals,awayGoals,String(row.status||"FINISHED").toUpperCase(),row.venue??null,
    statisticValue(row.statistics,["shots","total shots"]),statisticValue(row.statistics,["shots on goal","shots on target"]),
    statisticValue(row.statistics,["ball possession","possession"]),statisticValue(row.statistics,["corner kicks","corners"]),
    statisticValue(row.statistics,["yellow cards","cards"]),statisticValue(row.statistics,["expected goals","xg"]),
    statistics,provenance,row.fetchedAt||new Date().toISOString()
  );
  const match=db.prepare("SELECT id,provenance FROM matches WHERE identityKey=?").get(identity(row));
  db.prepare("INSERT OR IGNORE INTO match_sources(matchId,source,providerFixtureId,homeGoals,awayGoals,fetchedAt,provenance) VALUES(?,?,?,?,?,?,?)")
    .run(match.id,source,providerFixtureId,homeGoals,awayGoals,row.fetchedAt||new Date().toISOString(),provenance);
  const stored=JSON.parse(match.provenance||"{}");
  const sources=[...new Set([...(stored.sources||[]),source])];
  if(sources.length!==(stored.sources||[]).length)db.prepare("UPDATE matches SET provenance=? WHERE id=?").run(JSON.stringify({...stored,sources}),match.id);
  return {inserted:Number(info.changes)>0?1:0,rejected:null};
}

export function importHistoryMatches(db,rows=[]){
  const report={seen:0,inserted:0,duplicates:0,rejected:{}};
  db.exec("BEGIN IMMEDIATE");
  try{
    for(const row of rows){
      report.seen++;
      try{
        const result=insertRow(db,row);
        report.inserted+=result.inserted;
        if(!result.inserted&&!result.rejected)report.duplicates++;
        if(result.rejected)report.rejected[result.rejected]=(report.rejected[result.rejected]||0)+1;
      }catch(error){report.rejected[error.code||"IMPORT_ERROR"]=(report.rejected[error.code||"IMPORT_ERROR"]||0)+1;}
    }
    db.exec("COMMIT");
  }catch(error){db.exec("ROLLBACK");throw error;}
  return report;
}

function decode(row){
  if(!row)return null;
  return {
    schemaVersion:1,recordKey:`SQLITE:${row.id}`,sourceFixtureId:row.providerFixtureId,
    fixtureId:row.source==="API_FOOTBALL"?row.providerFixtureId:null,playedAt:row.kickoff,status:row.status,
    competition:{name:row.competition,code:row.competitionCode,season:row.season},
    homeTeam:{id:row.homeTeamId,name:row.homeTeam},awayTeam:{id:row.awayTeamId,name:row.awayTeam},
    score:{fullTime:{home:row.homeGoals,away:row.awayGoals}},statistics:row.statistics?JSON.parse(row.statistics):null,
    provenance:JSON.parse(row.provenance),fetchedAt:row.fetchedAt
  };
}

function teamWhere(team){
  const name=typeof team==="string"?team:team?.name||"";
  const normalized=[...new Set(teamSearchAliases(name).map(canonicalTeamName).filter(Boolean))];
  if(!normalized.length)throw new Error("team name is required for safe SQLite identity matching");
  const placeholders=normalized.map(()=>"?").join(",");
  return {name,normalized,placeholders,sql:`(homeTeamNormalized IN (${placeholders}) OR awayTeamNormalized IN (${placeholders}))`,args:[...normalized,...normalized]};
}

export function getTeamLastMatches(db,team,before,limit=20){
  const where=teamWhere(team);
  return db.prepare(`SELECT * FROM matches WHERE ${where.sql} AND kickoff < ? ORDER BY kickoff DESC LIMIT ?`).all(...where.args,new Date(before).toISOString(),limit).map(decode);
}
export function getTeamHomeMatches(db,team,before,limit=20){const w=teamWhere(team);return db.prepare(`SELECT * FROM matches WHERE homeTeamNormalized IN (${w.placeholders}) AND kickoff < ? ORDER BY kickoff DESC LIMIT ?`).all(...w.normalized,new Date(before).toISOString(),limit).map(decode);}
export function getTeamAwayMatches(db,team,before,limit=20){const w=teamWhere(team);return db.prepare(`SELECT * FROM matches WHERE awayTeamNormalized IN (${w.placeholders}) AND kickoff < ? ORDER BY kickoff DESC LIMIT ?`).all(...w.normalized,new Date(before).toISOString(),limit).map(decode);}
export function getCompetitionSeasonMatches(db,competition,season,before="9999-12-31T23:59:59.999Z",limit=1000){return db.prepare("SELECT * FROM matches WHERE (competitionCode=? OR competition=?) AND season=? AND kickoff < ? ORDER BY kickoff DESC LIMIT ?").all(competition,competition,String(season),new Date(before).toISOString(),limit).map(decode);}
export function getHeadToHead(db,home,away,before,limit=20){const h=teamWhere(home),a=teamWhere(away);return db.prepare(`SELECT * FROM matches WHERE ((homeTeamNormalized IN (${h.placeholders}) AND awayTeamNormalized IN (${a.placeholders})) OR (homeTeamNormalized IN (${a.placeholders}) AND awayTeamNormalized IN (${h.placeholders}))) AND kickoff < ? ORDER BY kickoff DESC LIMIT ?`).all(...h.normalized,...a.normalized,...a.normalized,...h.normalized,new Date(before).toISOString(),limit).map(decode);}

export function getTeamForm(db,team,before,limit=5){
  const name=teamWhere(team).name,matches=getTeamLastMatches(db,team,before,limit);
  if(!matches.length)return null;
  let points=0,goalsFor=0,goalsAgainst=0;
  for(const match of matches){const home=sameTeamIdentity(match.homeTeam.name,name),gf=home?match.score.fullTime.home:match.score.fullTime.away,ga=home?match.score.fullTime.away:match.score.fullTime.home;goalsFor+=gf;goalsAgainst+=ga;points+=gf>ga?3:gf===ga?1:0;}
  return {matches:matches.length,points,ppg:points/matches.length,goalsFor,goalsAgainst};
}

export function loadAllHistory(db){return db.prepare("SELECT * FROM matches ORDER BY kickoff").all().map(decode);}
export function hasSourceDate(db,source,date){return Boolean(db.prepare("SELECT 1 found FROM match_sources s JOIN matches m ON m.id=s.matchId WHERE s.source=? AND substr(m.kickoff,1,10)=? LIMIT 1").get(String(source).toUpperCase(),date));}

export function auditHistoryIntegrity(db,targetKickoff=null){
  const duplicates=db.prepare("SELECT COUNT(*) count FROM (SELECT identityKey FROM matches GROUP BY identityKey HAVING COUNT(*)>1)").get().count;
  const missingScores=db.prepare("SELECT COUNT(*) count FROM matches WHERE status IN ('FT','AET','PEN','FINISHED') AND (homeGoals IS NULL OR awayGoals IS NULL)").get().count;
  const suspiciousIdentity=db.prepare("SELECT COUNT(*) count FROM matches WHERE lower(homeTeam) GLOB '* u[0-9][0-9]*' OR lower(awayTeam) GLOB '* u[0-9][0-9]*' OR lower(homeTeam) LIKE '%reserve%' OR lower(awayTeam) LIKE '%reserve%'").get().count;
  const conflicts=db.prepare("SELECT COUNT(*) count FROM (SELECT matchId FROM match_sources GROUP BY matchId HAVING COUNT(DISTINCT homeGoals || ':' || awayGoals)>1)").get().count;
  const futureLeakage=targetKickoff?db.prepare("SELECT COUNT(*) count FROM matches WHERE kickoff >= ?").get(new Date(targetKickoff).toISOString()).count:0;
  return {duplicates,missingScores,suspiciousIdentity,conflictingProviderRecords:conflicts,futureLeakage};
}

export function databaseStats(db,filePath){
  try{db.exec("PRAGMA wal_checkpoint(PASSIVE)");}catch{}
  const pageCount=db.prepare("PRAGMA page_count").get().page_count,pageSize=db.prepare("PRAGMA page_size").get().page_size;
  const matches=db.prepare("SELECT COUNT(*) count FROM matches").get().count;
  const seasons=db.prepare("SELECT competitionCode,season,COUNT(*) matches FROM matches WHERE season IS NOT NULL GROUP BY competitionCode,season ORDER BY competitionCode,season").all();
  let indexBytes=null;
  try{indexBytes=Number(db.prepare("SELECT COALESCE(SUM(pgsize),0) bytes FROM dbstat WHERE name LIKE 'idx_%' OR name LIKE 'sqlite_autoindex_%'").get().bytes);}catch{}
  const totalBytes=Number(pageCount)*Number(pageSize);
  return {matches,seasons,fileBytes:fs.existsSync(filePath)?fs.statSync(filePath).size:0,indexBytes,dataBytes:indexBytes===null?null:totalBytes-indexBytes,indexAndDataBytes:totalBytes,estimatedBytesPer100k:matches?Math.round(totalBytes/matches*100000):null};
}
