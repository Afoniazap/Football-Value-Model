import json,collections,sqlite3,math,random,sys,re,unicodedata
from datetime import datetime
D=sys.argv[1]; random.seed(11)
def load(p): return [json.loads(l) for l in open(f'{D}/{p}') if l.strip()]
K=['home','draw','away']
mean=lambda x: sum(x)/len(x) if x else None
ll=lambda p,a:-math.log(max(1e-15,p[a])); br=lambda p,a:sum((p[k]-(1 if k==a else 0))**2 for k in K)/3
def boot(xs,n=4000):
    m=sorted(mean([random.choice(xs) for _ in xs]) for _ in range(n)); return [round(m[int(.025*n)],4),round(m[int(.975*n)],4)]
def t(s): return datetime.fromisoformat(s.replace('Z','+00:00'))
pr=load('statistics/predictions.jsonl'); ds=load('statistics/dual-shadow.jsonl'); mbk=load('statistics/market-bets.jsonl')
db=sqlite3.connect(f'file:{D}/history/football.sqlite?mode=ro',uri=True)
scoreById=collections.defaultdict(set)
for pid,hg,ag in db.execute("select providerFixtureId,homeGoals,awayGoals from matches where status='FINISHED'"): scoreById[str(pid)].add((hg,ag))
def norm(s): return re.sub(r'[^a-z0-9 ]','',unicodedata.normalize('NFKD',s.lower()).encode('ascii','ignore').decode())
byDateTeam=collections.defaultdict(set)
for k,hn,an,hg,ag in db.execute("select kickoff,homeTeamNormalized,awayTeamNormalized,homeGoals,awayGoals from matches where status='FINISHED'"): byDateTeam[(k[:10],hn[:5],an[:5])].add((hg,ag))
out={}
sc=collections.defaultdict(set)
for r in pr:
    if r.get('scanId'): sc[r['scanId'][:10]].add(r['scanId'])
out['scan_days']={d:len(sc[d]) for d in sorted(sc) if d>='2026-10-01'}
P={r['snapshotKey']:r for r in mbk if r['recordType']=='PREDICTION'}; R={r['snapshotKey']:r for r in mbk if r['recordType']=='RESULT'}
unver=[];conf=0;dis=[]
for k,r in R.items():
    p=P[k]; s=scoreById.get(str(p['fixtureId'])) or byDateTeam.get((p['kickoff'][:10],norm(p['home'])[:5],norm(p['away'])[:5]))
    if not s: unver.append((p['home'],p['away'],p['kickoff'][:10])); continue
    sc_=(r['score']['home'],r['score']['away']) if r['score'] else None
    if sc_ not in s: dis.append((p['home'],p['away'],sc_,list(s)))
    else: conf+=1
out['score_verification_bets']={'verified_score_equal':conf,'unverifiable':len(unver),'unverifiable_list':unver[:25],'disagreements':dis}
# consensus (bet-driving) vs market, same fixtures
snap={}
for r in pr:
    if r['type']=='SNAPSHOT' and r.get('consensusProbability') and r['createdAt']<r['kickoff']:
        key=r['fixtureKey']
        if key not in snap or r['createdAt']>snap[key]['createdAt']: snap[key]=r
mk={};pk={}
for r in ds:
    if r['type']=='SHADOW_PREDICTION': pk[r['snapshotKey']]=r
for r in ds:
    if r['type']=='SHADOW_MARKET_BENCHMARK' and r['closingCandidate'].get('noVig'):
        pp=pk.get(r['snapshotKey'])
        if not pp: continue
        fk=pp['fixtureId']
        if fk not in mk or r['observedAt']>mk[fk]['observedAt']: mk[fk]=r
rows=[]
for fk,s in snap.items():
    m=mk.get(s['fixtureId'])
    if not m or m['observedAt']>s['kickoff']: continue
    res=scoreById.get(str(s['fixtureId']))
    if not res or len(res)!=1: continue
    h,a=list(res)[0]; act='home' if h>a else 'away' if a>h else 'draw'
    rows.append(dict(cons=s['consensusProbability'],mkt=m['closingCandidate']['noVig'],a=act))
out['consensus_vs_market_n']=len(rows)
if rows:
    out['consensus_vs_market']={n:{'logloss':round(mean([ll(r[n],r['a']) for r in rows]),4),'brier':round(mean([br(r[n],r['a']) for r in rows]),4),'acc':round(mean([1 if max(K,key=lambda k:r[n][k])==r['a'] else 0 for r in rows]),3),'meanTop':round(mean([max(r[n].values()) for r in rows]),3)} for n in ['cons','mkt']}
    d=[ll(r['cons'],r['a'])-ll(r['mkt'],r['a']) for r in rows]; out['consensus_minus_market_logloss']={'mean':round(mean(d),4),'ci95':boot(d)}
lags=sorted((t(pk[r['snapshotKey']]['kickoff'])-t(r['marketBenchmark']['observedAt'])).total_seconds()/3600 for r in ds if r['type']=='SHADOW_RESULT' and r.get('marketBenchmark') and r['snapshotKey'] in pk)
out['market_obs_hours_before_kickoff']={'n':len(lags),'p10':round(lags[len(lags)//10],2),'median':round(lags[len(lags)//2],2),'p90':round(lags[9*len(lags)//10],2)}
# CLV proxy
selkey={'П1':'home','X':'draw','П2':'away'}
byfid={}
byfid=dict(mk)
clv=[]
for k,p in P.items():
    if p['market']!='1X2' or p['fixtureId'] not in byfid: continue
    m=byfid[p['fixtureId']]
    if m['observedAt']<=p['createdAt']: continue
    clv.append(m['closingCandidate']['noVig'][selkey[p['selection']]]-p['fairMarketProbability'])
out['clv_proxy_1x2']={'n':len(clv),'mean_pp':round(100*mean(clv),2) if clv else None,'ci95_pp':[round(100*v,2) for v in boot(clv)] if len(clv)>5 else None,'share_toward':round(mean([1 if x>0 else 0 for x in clv]),3) if clv else None}
# Oct 13
G=dict(minEdge=4,minEv=5,minConf=70,minDQ=70,minStab=70);last={}
for r in sorted(pr,key=lambda r:r.get('createdAt') or ''):
    if r['type']!='SNAPSHOT' or r['kickoff'][:10]!='2026-10-13' or r['createdAt']>=r['kickoff']: continue
    single=r.get('market') in('OU','AH');f=[]
    if r.get('edge') is None: f.append('нет кандидата/рынка')
    else:
        if r['edge']<G['minEdge']: f.append(f"edge {r['edge']:.1f}<4")
        if r['ev']<G['minEv']: f.append(f"EV {r['ev']:.0f}<5")
        if r['confidence']<G['minConf']: f.append(f"conf {r['confidence']}<70")
        if r['dataQuality']<G['minDQ']: f.append(f"DQ {r['dataQuality']}<70")
        if not single and (r.get('stability') is None or r['stability']<G['minStab']): f.append(f"stab {r.get('stability')}<70")
    last[(r['home'],r['away'])]=dict(scan=r['createdAt'][5:16],kick=r['kickoff'][5:16],m=f"{r['home']}-{r['away']}",cat=r['category'],mk=r.get('market'),sel=r.get('selection'),line=r.get('line'),odds=r.get('odds'),edge=r.get('edge') and round(r['edge'],1),ev=r.get('ev') and round(r['ev']),conf=r.get('confidence'),dq=r.get('dataQuality'),stab=r.get('stability'),fails=f)
out['oct13']=list(last.values()); out['oct13_summary']={'fixtures':len(last),'pass_all_gates':sum(1 for x in last.values() if not x['fails']),'fail_by_count':collections.Counter(len(x['fails']) for x in last.values())}
# did any Oct13 fixture have a later (post-scan) record? what happened to results
vb=[]
for k,p in P.items():
    if p['category']!='VALUE': continue
    r=R.get(k); vb.append(dict(match=f"{p['home']}-{p['away']}",kick=p['kickoff'][:16],created=p['createdAt'][5:16],mk=p['market'],sel=p['selection'],odds=p['odds'],bk=p['bookmaker'],model=round(p['modelProbability'],3),fair=round(p['fairMarketProbability'],3),edge=round(p['edge'],1),ev=round(p['ev']),conf=p['confidence'],dq=p['dataQuality'],stab=p['stability'],result=(r['settlement'],r['score'],r['unitProfit']) if r else 'PENDING'))
out['value_bets']=sorted(vb,key=lambda x:x['kick'])
json.dump(out,open(sys.argv[2],'w'),ensure_ascii=False,indent=1,default=str)
print(json.dumps({k:out[k] for k in out if k!='oct13'},ensure_ascii=False,indent=1,default=str))
