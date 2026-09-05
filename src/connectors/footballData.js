import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

const BASE = "https://api.football-data.org/v4";
let runtime={cacheDir:null,now:()=>Date.now(),fetchImpl:(...args)=>fetch(...args),rateLimitBackoffMs:60_000};
let rateLimitUntil=0,networkQueue=Promise.resolve(),inFlight=new Map();
const freshTelemetry=()=>({requests:0,cacheHits:0,staleHits:0,avoided:0,deduplicated:0,rateLimited:false,degraded:false});
let telemetry=freshTelemetry();
export class FootballDataError extends Error{constructor(code,message){super(message);this.name="FootballDataError";this.code=code;}}
export function configureFootballData(options={}){runtime={...runtime,...options};rateLimitUntil=0;if(runtime.cacheDir)fs.mkdirSync(runtime.cacheDir,{recursive:true});loadBackoff();}
export function beginFootballDataRefresh(){telemetry=freshTelemetry();if(rateLimitUntil>runtime.now()){telemetry.rateLimited=true;telemetry.degraded=true;}}
export function getFootballDataTelemetry(){return {...telemetry};}
function cacheFile(url){return runtime.cacheDir?path.join(runtime.cacheDir,`${crypto.createHash("sha256").update(url).digest("hex")}.json`):null;}
function read(file){try{return JSON.parse(fs.readFileSync(file,"utf8"));}catch{return null;}}
function write(file,data){if(file)fs.writeFileSync(file,JSON.stringify({fetchedAt:runtime.now(),data}),"utf8");}
function backoffFile(){return runtime.cacheDir?path.join(runtime.cacheDir,"rate-limit-backoff.json"):null;}
function loadBackoff(){rateLimitUntil=Number(read(backoffFile())?.until)||0;}
function markRateLimit(response){
  const retryAfter=Number(response?.headers?.get?.("retry-after")),delay=Number.isFinite(retryAfter)&&retryAfter>0?retryAfter*1000:runtime.rateLimitBackoffMs;
  rateLimitUntil=runtime.now()+Math.max(1000,delay);telemetry.rateLimited=true;telemetry.degraded=true;
  const file=backoffFile();if(file)fs.writeFileSync(file,JSON.stringify({until:rateLimitUntil,reason:"RATE_LIMIT"}),"utf8");
}

async function getJson(url, token) {
  if(rateLimitUntil>runtime.now()){telemetry.rateLimited=true;telemetry.degraded=true;telemetry.avoided++;throw new FootballDataError("RATE_LIMIT","Football-Data: RATE LIMIT");}
  telemetry.requests++;
  const response = await runtime.fetchImpl(url, { headers: { "X-Auth-Token": token } });
  if(response.status===429){markRateLimit(response);throw new FootballDataError("RATE_LIMIT","Football-Data: RATE LIMIT");}
  if (!response.ok) throw new FootballDataError(`HTTP_${response.status}`,`football-data ${response.status}: ${await response.text()}`);
  return response.json();
}

function queuedGetJson(url,token){
  const run=networkQueue.then(()=>getJson(url,token));networkQueue=run.catch(()=>{});return run;
}

async function getJsonCached(url,token,ttlMs,staleMs=ttlMs){
  const file=cacheFile(url),cached=read(file);
  const age=cached?runtime.now()-Number(cached.fetchedAt):Infinity;
  if(cached&&age<=ttlMs){telemetry.cacheHits++;return cached.data;}
  if(rateLimitUntil>runtime.now()){
    telemetry.rateLimited=true;telemetry.degraded=true;telemetry.avoided++;
    if(cached&&age<=staleMs){telemetry.staleHits++;return cached.data;}
    throw new FootballDataError("RATE_LIMIT","Football-Data: RATE LIMIT");
  }
  // Fixtures that share a competition context (e.g. several fixtures in the
  // same league) can race to request the same URL before the first request's
  // cache write lands. Reuse the in-flight promise instead of firing a second
  // identical request against the 10 req/min free-tier limit.
  if(inFlight.has(url)){telemetry.deduplicated++;telemetry.avoided++;return inFlight.get(url);}
  const promise=(async()=>{
    try{const data=await queuedGetJson(url,token);write(file,data);return data;}
    catch(error){telemetry.degraded=true;if(cached&&age<=staleMs){telemetry.staleHits++;return cached.data;}throw error;}
    finally{inFlight.delete(url);}
  })();
  inFlight.set(url,promise);
  return promise;
}

export async function getUpcomingMatches(token, horizonHours = 24) {
  const now = new Date();
  const end = new Date(now.getTime() + horizonHours * 3600_000);
  const date = d => d.toISOString().slice(0, 10);
  const url = `${BASE}/matches?dateFrom=${date(now)}&dateTo=${date(end)}`;
  const data = await getJsonCached(url, token, 10*60_000, 2*3600_000);

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

export async function getFinishedFootballDataMatchesForDate(token, date) {
  if (!token || !date) return [];
  const url = `${BASE}/matches?dateFrom=${date}&dateTo=${date}&status=FINISHED`;
  const data = await getJsonCached(url, token, 24 * 3600_000, 7*86400_000);
  return data?.matches || [];
}

export async function getFinishedCompetitionSeason(token,code,season){
  if(!token||!code||!season)return [];
  const url=`${BASE}/competitions/${encodeURIComponent(code)}/matches?season=${encodeURIComponent(season)}&status=FINISHED`;
  const data=await getJsonCached(url,token,30*86400_000,90*86400_000);
  return data?.matches||[];
}

export async function getCompetitionContext(token, code) {
  const errors=[];
  const [standings, finished, scheduled] = await Promise.all([
    getJsonCached(`${BASE}/competitions/${code}/standings`,token,6*3600_000,24*3600_000).catch(e=>{errors.push(`standings:${e.message}`);return null;}),
    getJsonCached(`${BASE}/competitions/${code}/matches?status=FINISHED`,token,60*60_000,24*3600_000).catch(e=>{errors.push(`finished:${e.message}`);return {matches:[]};}),
    getJsonCached(`${BASE}/competitions/${code}/matches?status=SCHEDULED,TIMED`,token,30*60_000,2*3600_000).catch(e=>{errors.push(`scheduled:${e.message}`);return {matches:[]};})
  ]);
  return {
    standings,
    finished: (finished?.matches || []).slice(-500),
    scheduled: scheduled?.matches || [],
    contextMeta:{source:"FOOTBALL_DATA",errors}
  };
}
