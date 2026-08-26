import { similarity } from "./utils.js";

function fixtureIdForTeam(team,fixture){
  const name=team?.name||"";
  if(similarity(name,fixture.home)>=0.82)return fixture.homeId;
  if(similarity(name,fixture.away)>=0.82)return fixture.awayId;
  return team?.id;
}

export function alignContextTeamIds(context,fixture){
  if(!context)return context;
  const standings=context.standings?{...context.standings,standings:(context.standings.standings||[]).map(group=>({...group,table:(group.table||[]).map(row=>({...row,team:{...row.team,id:fixtureIdForTeam(row.team,fixture)}}))}))}:context.standings;
  const finished=(context.finished||[]).map(match=>({...match,homeTeam:{...match.homeTeam,id:fixtureIdForTeam(match.homeTeam,fixture)},awayTeam:{...match.awayTeam,id:fixtureIdForTeam(match.awayTeam,fixture)}}));
  return {...context,standings,finished};
}
