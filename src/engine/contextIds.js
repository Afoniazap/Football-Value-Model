import { similarity } from "./utils.js";

function canonical(value){return String(value||"").toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g,"").replace(/\b(fc|cf|afc|sc|ac|cd|fk|rc|ca|ud|de)\b/g," ").replace(/[^a-z0-9а-яё]+/gi," ").trim().replace(/\s+/g," ");}
function teamSimilarity(a,b){const x=canonical(a),y=canonical(b);if(x&&x===y)return 1;return similarity(x,y);}

function fixtureIdForTeam(team,fixture){
  const name=team?.name||"";
  if(teamSimilarity(name,fixture.home)>=0.82)return fixture.homeId;
  if(teamSimilarity(name,fixture.away)>=0.82)return fixture.awayId;
  return team?.id;
}

export function alignContextTeamIds(context,fixture){
  if(!context)return context;
  const standings=context.standings?{...context.standings,standings:(context.standings.standings||[]).map(group=>({...group,table:(group.table||[]).map(row=>({...row,team:{...row.team,id:fixtureIdForTeam(row.team,fixture)}}))}))}:context.standings;
  const finished=(context.finished||[]).map(match=>({...match,homeTeam:{...match.homeTeam,id:fixtureIdForTeam(match.homeTeam,fixture)},awayTeam:{...match.awayTeam,id:fixtureIdForTeam(match.awayTeam,fixture)}}));
  return {...context,standings,finished};
}
