export const BASELINE_V2_H_MODEL_VERSION="BASELINE_V2_H_SHADOW_2024";
export const BASELINE_V2_H_PARAMETERS=Object.freeze({trainedThroughSeason:2024,shrinkageMatches:10,residualForm:Object.freeze({intercept:-.00619,ppg:.31338,gd:.00489}),draw:Object.freeze({intercept:0,expectedGoalsWeight:.15,strengthPenalty:.20,referenceGoals:2.8})});

function row(context,teamId){return (context?.standings?.standings?.find(x=>x.type==="TOTAL")?.table||[]).find(x=>x.team?.id===teamId)||null;}
function form(context,teamId){
  const games=(context?.finished||context?.matches||[]).filter(x=>x.homeTeam?.id===teamId||x.awayTeam?.id===teamId).sort((a,b)=>new Date(b.utcDate)-new Date(a.utcDate)).slice(0,5);
  let points=0,valid=0;for(const match of games){const home=match.homeTeam?.id===teamId,gf=Number(home?match.score?.fullTime?.home:match.score?.fullTime?.away),ga=Number(home?match.score?.fullTime?.away:match.score?.fullTime?.home);if(!Number.isFinite(gf)||!Number.isFinite(ga))continue;valid++;points+=gf>ga?3:gf===ga?1:0;}return {games:valid,points};
}
function softmax(a,b,c){const max=Math.max(a,b,c),e=[a,b,c].map(x=>Math.exp(x-max)),sum=e.reduce((x,y)=>x+y,0);return {home:e[0]/sum,draw:e[1]/sum,away:e[2]/sum};}

export function buildBaselineV2H(fixture,context,p=BASELINE_V2_H_PARAMETERS){
  const home=row(context,fixture.homeId),away=row(context,fixture.awayId),hf=form(context,fixture.homeId),af=form(context,fixture.awayId);
  if(!home||!away||hf.games<3||af.games<3)return null;
  const hp=Math.max(Number(home.playedGames)||0,1),ap=Math.max(Number(away.playedGames)||0,1);
  const ppg=Number(home.points)/hp-Number(away.points)/ap,gd=Number(home.goalDifference)/hp-Number(away.goalDifference)/ap;
  const rawForm=hf.points/(hf.games*3)-af.points/(af.games*3),expected=p.residualForm.intercept+p.residualForm.ppg*ppg+p.residualForm.gd*gd;
  const rawStrength=ppg*.65+gd*.22+(rawForm-expected)*.75,strength=rawStrength*(Math.min(hp,ap)/(Math.min(hp,ap)+p.shrinkageMatches));
  const goalsHome=(Number(home.goalsFor)+Number(home.goalsAgainst))/hp,goalsAway=(Number(away.goalsFor)+Number(away.goalsAgainst))/ap;
  const expectedGoals=Math.max(1.4,Math.min(4,(goalsHome+goalsAway)/2));
  const draw=p.draw.intercept+p.draw.expectedGoalsWeight*(p.draw.referenceGoals-expectedGoals)-p.draw.strengthPenalty*Math.abs(strength);
  return softmax(.28+strength,draw,-strength);
}
