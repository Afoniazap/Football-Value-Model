import "dotenv/config";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { getUpcomingMatches, getCompetitionContext } from "./connectors/footballData.js";
import { getOddsForCompetition, matchOddsEvent, extractMarkets } from "./connectors/odds.js";
import { analyseFixture } from "./engine/analyse.js";
import { dashboardText, dashboardKeyboard, listText, listKeyboard, cardText, backKeyboard, metricKeyboard, metricText } from "./ui/telegram.js";

const ROOT=path.resolve(path.dirname(fileURLToPath(import.meta.url)),"..");
const DATA=path.join(ROOT,"data");
const LOGS=path.join(ROOT,"logs");
fs.mkdirSync(DATA,{recursive:true}); fs.mkdirSync(LOGS,{recursive:true});

const env=process.env;
for(const key of ["TELEGRAM_BOT_TOKEN","FOOTBALL_DATA_TOKEN","THE_ODDS_API_KEY"]){
  if(!env[key] || env[key].startsWith("PASTE_")){ console.error(`Добавьте ${key} в .env`); process.exit(1); }
}
const TG=`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN.trim()}`;
const allowed=new Set((env.ALLOWED_CHAT_IDS||"").split(",").map(x=>x.trim()).filter(Boolean));
const config={
  horizon:Number(env.HORIZON_HOURS||24),
  minEdge:Number(env.MIN_EDGE_PP||4),
  minEv:Number(env.MIN_EV_PERCENT||5),
  minConfidence:Number(env.MIN_CONFIDENCE||70),
  minDataQuality:Number(env.MIN_DATA_QUALITY||70),
  minStability:Number(env.MIN_STABILITY||70),
  maxRecommendations:Number(env.MAX_RECOMMENDATIONS||5)
};
let offset=0;
let state={loading:false,stage:"0/9",updatedAt:null,results:[],errors:[]};

async function tg(method,body={}){
  const r=await fetch(`${TG}/${method}`,{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify(body)});
  const d=await r.json(); if(!d.ok) throw new Error(`${method}: ${d.description}`); return d.result;
}
function permitted(id){return allowed.size===0||allowed.has(String(id));}
function save(){fs.writeFileSync(path.join(DATA,"state.json"),JSON.stringify(state,null,2),"utf8");}

async function refresh(){
  if(state.loading)return;
  state.loading=true; state.errors=[]; state.stage="1/9 Data Integrity";
  try{
    const fixtures=await getUpcomingMatches(env.FOOTBALL_DATA_TOKEN.trim(),config.horizon);
    state.stage="2/9 Match Classification";
    const codes=[...new Set(fixtures.map(x=>x.competitionCode).filter(Boolean))];
    const contexts={}, odds={};
    for(const code of codes){
      state.stage=`3/9 Collectors: ${code}`;
      contexts[code]=await getCompetitionContext(env.FOOTBALL_DATA_TOKEN.trim(),code);
      odds[code]=await getOddsForCompetition(env.THE_ODDS_API_KEY.trim(),env.ODDS_REGION||"eu",code).catch(e=>{state.errors.push(e.message);return[]});
    }
    state.stage="4/9 Independent Models";
    const results=[];
    for(const f of fixtures){
      const event=matchOddsEvent(f,odds[f.competitionCode]||[]);
      const marketData=event?extractMarkets(event):null;
      results.push(analyseFixture(f,contexts[f.competitionCode],marketData,config));
    }
    state.stage="7/9 Recommendation Engine";
    const values=results.filter(x=>x.category==="VALUE").sort((a,b)=>(b.best?.fds||0)-(a.best?.fds||0));
    const allowedIds=new Set(values.slice(0,config.maxRecommendations).map(x=>x.id));
    state.results=results.map(x=>x.category==="VALUE"&&!allowedIds.has(x.id)?{...x,category:"NEAR",reason:"Не вошёл в лимит лучших рекомендаций дня."}:x);
    state.updatedAt=new Date().toISOString(); state.stage="9/9 Complete"; save();
    console.log(`FVM: ${state.results.length} matches | VALUE ${state.results.filter(x=>x.category==="VALUE").length}`);
  }catch(e){state.errors.push(e.message);console.error(e);save();}
  finally{state.loading=false;}
}
async function dashboard(chatId,msgId){
  const body={chat_id:chatId,text:dashboardText(state),parse_mode:"HTML",reply_markup:dashboardKeyboard(state)};
  if(msgId){body.message_id=msgId;try{return await tg("editMessageText",body)}catch{delete body.message_id}}
  return tg("sendMessage",body);
}
async function callback(q){
  const id=q.message?.chat?.id;if(!id||!permitted(id))return;
  await tg("answerCallbackQuery",{callback_query_id:q.id});
  if(q.data==="dashboard")return dashboard(id,q.message.message_id);
  if(q.data==="refresh"){await refresh();return dashboard(id,q.message.message_id)}
  if(q.data==="pipeline")return tg("sendMessage",{chat_id:id,text:`⚙️ <b>Pipeline</b>\n\n${state.stage}\n\n✅ Data Integrity\n✅ Classification\n✅ Team Strength\n✅ Form\n✅ SCI\n✅ Consensus\n✅ Market Value\n✅ Risk Gates\n✅ Recommendation`,parse_mode:"HTML",reply_markup:backKeyboard()});
  if(q.data.startsWith("list:")){
    const cat=q.data.split(":")[1],items=state.results.filter(x=>x.category===cat);
    return tg("sendMessage",{chat_id:id,text:listText(cat,items),parse_mode:"HTML",reply_markup:listKeyboard(items)});
  }
  if(q.data.startsWith("metric:")){
    const [,code,matchId] = q.data.split(":");
    const x = state.results.find(y=>y.id===matchId);
    if(!x)return;
    return tg("sendMessage",{
      chat_id:id,
      text:metricText(code,x),
      parse_mode:"HTML",
      reply_markup:{
        inline_keyboard:[[
          {text:"⬅️ Назад к матчу",callback_data:`card:${matchId}`}
        ]]
      }
    });
  }

  if(q.data.startsWith("card:")){
    const x=state.results.find(y=>y.id===q.data.split(":")[1]);if(!x)return;
    return tg("sendMessage",{chat_id:id,text:cardText(x),parse_mode:"HTML",reply_markup:metricKeyboard(x)});
  }
}
async function message(m){
  const id=m.chat.id;if(!permitted(id))return tg("sendMessage",{chat_id:id,text:"Доступ закрыт."}).catch(()=>{});
  const t=m.text?.trim().toLowerCase();
  if(t==="/start"||t==="/dashboard")return dashboard(id);
  if(t==="/refresh"){await tg("sendMessage",{chat_id:id,text:"Запущен полный анализ FVM..."});await refresh();return dashboard(id)}
  if(t==="/id")return tg("sendMessage",{chat_id:id,text:`Ваш chat_id: <code>${id}</code>`,parse_mode:"HTML"});
  return tg("sendMessage",{chat_id:id,text:"Команды: /start /refresh /id"});
}
async function main(){
  console.log("FVM Engine v0.5 starting...");
  await refresh();
  setInterval(refresh,Math.max(5,Number(env.REFRESH_MINUTES||30))*60000);
  while(true){
    try{
      const updates=await tg("getUpdates",{offset,timeout:30,allowed_updates:["message","callback_query"]});
      for(const u of updates){offset=u.update_id+1;if(u.message)await message(u.message);if(u.callback_query)await callback(u.callback_query)}
    }catch(e){console.error(e.message);await new Promise(r=>setTimeout(r,3000))}
  }
}
main();
