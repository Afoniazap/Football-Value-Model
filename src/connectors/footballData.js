import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

const BASE = "https://api.football-data.org/v4";
let runtime={cacheDir:null,now:()=>Date.now(),fetchImpl:(...args)=>fetch(...args)};
export function configureFootballData(options={}){runtime={...runtime,...options};if(runtime.cacheDir)fs.mkdirSync(runtime.cacheDir,{recursive:true});}
function cacheFile(url){return runtime.cacheDir?path.join(runtime.cacheDir,`${crypto.createHash("sha256").update(url).digest("hex")}.json`):null;}
function read(file){try{return JSON.parse(fs.readFileSync(file,"utf8"));}catch{return null;}}
function write(file,data){if(file)fs.writeFileSync(file,JSON.stringify({fetchedAt:runtime.now(),data}),"utf8");}

async function getJson(url, token) {
  const response = await runtime.fetchImpl(url, { headers: { "X-Auth-Token": token } });
  if (!response.ok) throw new Error(`football-data ${response.status}: ${await response.text()}`);
  return response.json();
}

async function getJsonCached(url,token,ttlMs){
  const file=cacheFile(url),cached=read(file);
  if(cached&&runtime.now()-Number(cached.fetchedAt)<=ttlMs)return cached.data;
  const data=await getJson(url,token);write(file,data);return data;
}

export async function getUpcomingMatches(token, horizonHours = 24) {
  const now = new Date();
  const end = new Date(now.getTime() + horizonHours * 3600_000);
  const date = d => d.toISOString().slice(0, 10);
  const url = `${BASE}/matches?dateFrom=${date(now)}&dateTo=${date(end)}`;
  const data = await getJson(url, token);

  return (data.matches || [])
    .filter(m => ["SCHEDULED", "TIMED"].includes(m.status))
    .filter(m => {
      const t = new Date(m.utcDate);
      return t > now && t <= end;
    })
    .map(m => ({
      id: String(m.id),
      competitionCode: m.competition?.code || "",
      competition: m.competition?.name || "Unknown",
      country: m.area?.name || m.competition?.area?.name || null,
      seasonStart: m.season?.startDate,
      matchday: m.matchday,
      utcDate: m.utcDate,
      home: m.homeTeam?.name || "Home",
      away: m.awayTeam?.name || "Away",
      homeId: m.homeTeam?.id,
      awayId: m.awayTeam?.id
    }));
}

export async function getCompetitionContext(token, code) {
  const errors=[];
  const [standings, finished, scheduled] = await Promise.all([
    getJsonCached(`${BASE}/competitions/${code}/standings`,token,6*3600_000).catch(e=>{errors.push(`standings:${e.message}`);return null;}),
    getJsonCached(`${BASE}/competitions/${code}/matches?status=FINISHED`,token,60*60_000).catch(e=>{errors.push(`finished:${e.message}`);return {matches:[]};}),
    getJsonCached(`${BASE}/competitions/${code}/matches?status=SCHEDULED,TIMED`,token,30*60_000).catch(e=>{errors.push(`scheduled:${e.message}`);return {matches:[]};})
  ]);
  return {
    standings,
    finished: (finished?.matches || []).slice(-500),
    scheduled: scheduled?.matches || [],
    contextMeta:{source:"FOOTBALL_DATA",errors}
  };
}
