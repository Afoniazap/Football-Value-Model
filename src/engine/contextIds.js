import { similarity } from "./utils.js";

// Literal, known English-football abbreviation expansions only — not a
// fuzzier matching algorithm and not a lower threshold. Without these,
// "QPR" has ~0 bigram overlap with "Queens Park Rangers FC" (no shared
// substrings at all) and "Sheffield Utd" scores 0.72 against "Sheffield
// United FC" (just under the 0.82 bar), so both fail identity alignment
// even though they are genuinely the same club.
function canonical(value){return String(value||"").toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g,"").replace(/\bqpr\b/g,"queens park rangers").replace(/\butd\b/g,"united").replace(/\b(fc|cf|afc|sc|ac|cd|fk|rc|ca|ud|de)\b/g," ").replace(/[^a-z0-9а-яё]+/gi," ").trim().replace(/\s+/g," ");}
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
