const BASE = "https://v3.football.api-sports.io";

async function getJson(path, key) {
  if (!key) return null;
  const response = await fetch(`${BASE}${path}`, {
    headers: { "x-apisports-key": key }
  });
  if (!response.ok) throw new Error(`api-football ${response.status}: ${await response.text()}`);
  return response.json();
}

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

let lastApiCallAt = 0;

async function rateLimitedGetJson(path, key) {
  const minGap = 7000;
  const wait = Math.max(0, minGap - (Date.now() - lastApiCallAt));

  if (wait > 0) {
    await sleep(wait);
  }

  try {
    const result = await getJson(path, key);
    lastApiCallAt = Date.now();
    return result;
  } catch (e) {
    if (String(e.message).includes("429")) {
      await sleep(15000);
      const result = await getJson(path, key);
      lastApiCallAt = Date.now();
      return result;
    }
    throw e;
  }
}

export async function getFixtureRisk(key, apiFootballFixtureId) {
  if (!key || !apiFootballFixtureId) return null;
  const [injuries, lineups] = await Promise.all([
    getJson(`/injuries?fixture=${apiFootballFixtureId}`, key).catch(() => null),
    getJson(`/fixtures/lineups?fixture=${apiFootballFixtureId}`, key).catch(() => null)
  ]);
  return {
    injuries: injuries?.response || [],
    lineups: lineups?.response || []
  };
}

function normName(s="") {
  return s.toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g,"")
    .replace(/\b(fc|cf|afc|sc|ac|cd|fk|club)\b/g,"")
    .replace(/[^a-z0-9а-яё]/gi,"")
    .trim();
}

function nameScore(a,b) {
  const x=normName(a), y=normName(b);
  if(!x || !y) return 0;
  if(x===y) return 1;
  if(x.includes(y) || y.includes(x)) return 0.9;

  const sx=new Set(x);
  let common=0;
  for(const c of new Set(y)) if(sx.has(c)) common++;

  return common / Math.max(new Set([...x,...y]).size,1);
}

export async function findApiFootballFixture(key, fixture) {
  if(!key || !fixture?.utcDate) return null;

  const date=new Date(fixture.utcDate).toISOString().slice(0,10);
  const data=await getJson(`/fixtures?date=${date}`,key);
  const matches=data?.response || [];

  let best=null;
  let bestScore=0;

  for(const m of matches){
    const h=nameScore(fixture.home,m?.teams?.home?.name || "");
    const a=nameScore(fixture.away,m?.teams?.away?.name || "");
    const score=h+a;

    if(score>bestScore){
      bestScore=score;
      best=m;
    }
  }

  return bestScore>=1.45 ? best : null;
}

export async function getUpcomingApiFootballMatches(key, horizonHours = 24) {
  if (!key) return [];

  const now = new Date();
  const end = new Date(now.getTime() + horizonHours * 3600_000);

  const dates = [...new Set([
    now.toISOString().slice(0,10),
    end.toISOString().slice(0,10)
  ])];

  const all = [];

  for (const date of dates) {
    const data = await rateLimitedGetJson(`/fixtures?date=${date}`, key);
    all.push(...(data?.response || []));
  }

  const competitionCode = m => {
    const country = m?.league?.country || "";
    const league = m?.league?.name || "";

    if (league === "UEFA Champions League") return "CL";
    if (league === "UEFA Europa League") return "EL";
    if (league === "CONMEBOL Libertadores") return "CLI";
    if (league === "CONMEBOL Sudamericana") return "SUD";
    if (league === "Leagues Cup") return "LEAGUES";

    if (country === "England" && league === "Premier League") return "PL";
    if (country === "England" && league === "Championship") return "ELC";
    if (country === "Spain" && league === "La Liga") return "PD";
    if (country === "Germany" && league === "Bundesliga") return "BL1";
    if (country === "Italy" && league === "Serie A") return "SA";
    if (country === "France" && league === "Ligue 1") return "FL1";
    if (country === "Netherlands" && league === "Eredivisie") return "DED";
    if (country === "Portugal" && league === "Primeira Liga") return "PPL";
    if (country === "Brazil" && league === "Serie A") return "BSA";
    if (country === "Brazil" && league === "Serie B") return "BSB";
    if (country === "USA" && league === "Major League Soccer") return "MLS";

    return null;
  };

  return all
    .filter(m => {
      const t = new Date(m?.fixture?.date);
      return (
        t > now &&
        t <= end &&
        ["NS","TBD"].includes(m?.fixture?.status?.short)
      );
    })
    .map(m => ({
      id: String(m.fixture.id),
      apiFootballFixtureId: m.fixture.id,
      apiFootballLeagueId: m.league?.id,
      competitionCode: competitionCode(m),
      competition: m.league?.name || "Unknown",
      country: m.league?.country || null,
      seasonStart: String(m.league?.season || ""),
      matchday: m.league?.round || null,
      utcDate: m.fixture.date,
      home: m.teams?.home?.name || "Home",
      away: m.teams?.away?.name || "Away",
      homeId: m.teams?.home?.id,
      awayId: m.teams?.away?.id
    }))
    .filter(m => m.competitionCode);
}

export async function getFixtureOdds(key, fixtureId) {
  if (!key || !fixtureId) return null;

  const data = await rateLimitedGetJson(`/odds?fixture=${fixtureId}`, key);
  const row = data?.response?.[0];
  if (!row) return null;

  const books = [];

  for (const book of row.bookmakers || []) {
    const winner = book.bets?.find(b => b.name === "Match Winner");
    const totals = book.bets?.find(b =>
      ["Goals Over/Under", "Total Goals"].includes(b.name)
    );

    const h2h = { home:null, draw:null, away:null };

    for (const v of winner?.values || []) {
      const odd = Number(v.odd);
      if (!Number.isFinite(odd)) continue;
      if (v.value === "Home") h2h.home = odd;
      if (v.value === "Draw") h2h.draw = odd;
      if (v.value === "Away") h2h.away = odd;
    }

    const totalRows = [];

    for (const v of totals?.values || []) {
      const m = String(v.value).match(/^(Over|Under)\s+([0-9.]+)$/i);
      if (!m) continue;

      const odd = Number(v.odd);
      if (!Number.isFinite(odd)) continue;

      totalRows.push({
        name:m[1][0].toUpperCase()+m[1].slice(1).toLowerCase(),
        point:Number(m[2]),
        odds:odd
      });
    }

    books.push({
      name:book.name,
      lastUpdate:null,
      h2h,
      spreads:[],
      totals:totalRows
    });
  }

  const best={h2h:{},spreads:{},totals:{}};

  for(const b of books){
    for(const side of ["home","draw","away"]){
      const odd=b.h2h[side];
      if(Number.isFinite(odd) &&
         (!best.h2h[side] || odd>best.h2h[side].odds)){
        best.h2h[side]={odds:odd,bookmaker:b.name};
      }
    }

    for(const x of b.totals){
      const k=`${x.name}|${x.point}`;
      if(!best.totals[k] || x.odds>best.totals[k].odds){
        best.totals[k]={
          odds:x.odds,
          bookmaker:b.name,
          point:x.point,
          name:x.name
        };
      }
    }
  }

  return {
    bookmakers:books,
    best,
    agreement:null
  };
}


export async function getApiFootballCompetitionContext(key, leagueId, season) {
  if (!key || !leagueId || !season) return null;

  const data = await rateLimitedGetJson(
    `/fixtures?league=${leagueId}&season=${season}`,
    key
  );

  const raw = data?.response || [];

  const finishedRaw = raw.filter(m =>
    ["FT","AET","PEN"].includes(m?.fixture?.status?.short)
  );

  const finished = finishedRaw.map(m => ({
    id: String(m.fixture.id),
    utcDate: m.fixture.date,
    homeTeam: {
      id: m.teams?.home?.id,
      name: m.teams?.home?.name
    },
    awayTeam: {
      id: m.teams?.away?.id,
      name: m.teams?.away?.name
    },
    score: {
      fullTime: {
        home: Number.isFinite(Number(m.goals?.home))
          ? Number(m.goals.home)
          : null,
        away: Number.isFinite(Number(m.goals?.away))
          ? Number(m.goals.away)
          : null
      }
    }
  })).filter(m =>
    m.homeTeam.id &&
    m.awayTeam.id &&
    Number.isFinite(m.score.fullTime.home) &&
    Number.isFinite(m.score.fullTime.away)
  );

  function buildTable(mode="TOTAL") {
    const teams=new Map();

    function getTeam(id,name){
      if(!teams.has(id)){
        teams.set(id,{
          team:{id,name},
          playedGames:0,
          won:0,
          draw:0,
          lost:0,
          points:0,
          goalsFor:0,
          goalsAgainst:0
        });
      }
      return teams.get(id);
    }

    for(const m of finished){
      const hg=m.score.fullTime.home;
      const ag=m.score.fullTime.away;

      if(mode==="TOTAL" || mode==="HOME"){
        const h=getTeam(m.homeTeam.id,m.homeTeam.name);

        if(mode==="TOTAL" || mode==="HOME"){
          h.playedGames++;
          h.goalsFor+=hg;
          h.goalsAgainst+=ag;

          if(hg>ag){h.won++;h.points+=3;}
          else if(hg===ag){h.draw++;h.points+=1;}
          else h.lost++;
        }
      }

      if(mode==="TOTAL" || mode==="AWAY"){
        const v=getTeam(m.awayTeam.id,m.awayTeam.name);

        v.playedGames++;
        v.goalsFor+=ag;
        v.goalsAgainst+=hg;

        if(ag>hg){v.won++;v.points+=3;}
        else if(ag===hg){v.draw++;v.points+=1;}
        else v.lost++;
      }
    }

    return [...teams.values()]
      .sort((x,y)=>
        y.points-x.points ||
        (y.goalsFor-y.goalsAgainst)-(x.goalsFor-x.goalsAgainst) ||
        y.goalsFor-x.goalsFor
      )
      .map((x,i)=>({...x,position:i+1}));
  }

  return {
    source:"API-Football",
    derivedStandings:true,
    standings:{
      standings:[
        {type:"TOTAL",table:buildTable("TOTAL")},
        {type:"HOME",table:buildTable("HOME")},
        {type:"AWAY",table:buildTable("AWAY")}
      ]
    },
    finished,
    scheduled:[]
  };
}


export async function getFinishedFixturesForDate(key, date) {
  if (!key || !date) return [];

  const data = await rateLimitedGetJson(
    `/fixtures?date=${date}`,
    key
  );

  return (data?.response || [])
    .filter(m =>
      ["FT","AET","PEN"].includes(m?.fixture?.status?.short)
    )
    .map(m => ({
      id: String(m.fixture.id),
      utcDate: m.fixture.date,

      leagueId: m.league?.id || null,
      league: m.league?.name || null,
      country: m.league?.country || null,
      season: m.league?.season || null,

      homeTeam: {
        id: m.teams?.home?.id,
        name: m.teams?.home?.name
      },

      awayTeam: {
        id: m.teams?.away?.id,
        name: m.teams?.away?.name
      },

      score: {
        fullTime: {
          home: Number(m.goals?.home),
          away: Number(m.goals?.away)
        }
      }
    }))
    .filter(m =>
      m.homeTeam.id &&
      m.awayTeam.id &&
      Number.isFinite(m.score.fullTime.home) &&
      Number.isFinite(m.score.fullTime.away)
    );
}
