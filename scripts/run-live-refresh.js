import { refresh, state } from "../src/app.js";

await refresh();
const covered=state.results.filter(row=>row.marketAvailable).length;
console.log(JSON.stringify({
  updatedAt:state.updatedAt,
  fixtures:state.results.length,
  marketCoverage:`${covered}/${state.results.length}`,
  categories:Object.fromEntries(["VALUE","NEAR","WAIT","NO_BET"].map(category=>[category,state.results.filter(row=>row.category===category).length])),
  sourceErrors:state.errors,
  providers:state.providers
},null,2));
