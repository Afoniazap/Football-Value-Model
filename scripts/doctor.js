import "dotenv/config";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),"..");
const required=["TELEGRAM_BOT_TOKEN","FOOTBALL_DATA_TOKEN","API_FOOTBALL_KEY"];
const market=["THE_ODDS_API_KEY","ODDS_API_IO_KEY"];
let failed=false;
for(const name of required){const ok=Boolean(process.env[name]?.trim());console.log(`${name}: ${ok?"CONFIGURED":"MISSING"}`);if(!ok)failed=true;}
for(const name of market)console.log(`${name}: ${process.env[name]?.trim()?"CONFIGURED":"OPTIONAL/MISSING"}`);
const dataDir=path.join(root,"data");
try{fs.mkdirSync(dataDir,{recursive:true});fs.accessSync(dataDir,fs.constants.R_OK|fs.constants.W_OK);console.log("DATA_DIR: OK");}catch{console.log("DATA_DIR: ERROR");failed=true;}
await import("../src/connectors/odds.js");
await import("../src/connectors/oddsApiIo.js");
await import("../src/connectors/apiFootball.js");
console.log("MARKET_CONNECTORS: OK");
console.log(failed?"DOCTOR: FAIL":"DOCTOR: PASS");
if(failed)process.exitCode=1;
