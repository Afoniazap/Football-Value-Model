import json,collections,sqlite3,math,random,sys
D=sys.argv[1]
def load(p): return [json.loads(l) for l in open(f'{D}/{p}') if l.strip()]
random.seed(7)
K=['home','draw','away']
def ll(p,a): return -math.log(max(1e-15,p[a]))
def br(p,a): return sum((p[k]-(1 if k==a else 0))**2 for k in K)/3
def mean(x): return sum(x)/len(x) if x else None
def boot(xs,n=4000):
    if len(xs)<5: return None
    m=[mean([random.choice(xs) for _ in xs]) for _ in range(n)]; m.sort(); return [round(m[int(.025*n)],4),round(m[int(.975*n)],4)]
def wil(k,n):
    if not n: return None
    z=1.96;p=k/n;d=1+z*z/n;c=p+z*z/(2*n);h=z*math.sqrt(p*(1-p)/n+z*z/(4*n*n));return [round((c-h)/d,3),round((c+h)/d,3)]
out={}
ds=load('statistics/dual-shadow.jsonl'); mb=load('statistics/market-bets.jsonl'); pr=load('statistics/predictions.jsonl')
db=sqlite3.connect(f'file:{D}/history/football.sqlite?mode=ro',uri=True)
# independent scores by provider fixture id (football-data / api-football ids)
scores={}
for pid,hg,ag,st in db.execute("select providerFixtureId,homeGoals,awayGoals,status from matches"): scores.setdefault(str(pid),[]).append((hg,ag,st))
for pid,hg,ag in db.execute("select providerFixtureId,homeGoals,awayGoals from match_sources"): scores.setdefault(str(pid),[]).append((hg,ag,'SRC'))
def indep(fid):
    v=scores.get(str(fid)); 
    if not v: return None
    s=set((a,b) for a,b,_ in v); return list(s)
# ---------- 1. Production vs market (+challenger, v2h) on identical fixtures
pred={r['snapshotKey']:r for r in ds if r['type']=='SHADOW_PREDICTION'}
res={r['snapshotKey']:r for r in ds if r['type']=='SHADOW_RESULT'}
rows=[];mism=[];noind=0
for k,r in res.items():
    p=pred.get(k); 
    if not p: continue
    a=r['actual']; sc=r['score']
    ind=indep(r['fixtureId'])
    if ind is None: noind+=1
    elif (sc['home'],sc['away']) not in ind: mism.append((k,sc,ind))
    mk=(r.get('marketBenchmark') or {}).get('closingNoVig')
    rows.append(dict(k=k,a=a,kick=p['kickoff'],cat=p['productionCategory'],comp=p['competition'],prod=p['models']['production']['probability'],ch=p['models']['challenger']['probability'],v2h=p['models']['v2h']['probability'],mkt=mk,obs=(r.get('marketBenchmark') or {}).get('observedAt'),src=(r.get('marketBenchmark') or {}).get('source')))
out['results_check']={'dual_results':len(res),'with_prediction':len(rows),'no_independent_source':noind,'score_mismatches':len(mism),'mismatch_examples':mism[:5]}
def ev(rs,key):
    L=[ll(r[key],r['a']) for r in rs];B=[br(r[key],r['a']) for r in rs]
    acc=mean([1 if max(K,key=lambda k:r[key][k])==r['a'] else 0 for r in rs])
    return dict(n=len(rs),logloss=round(mean(L),4),brier=round(mean(B),4),acc=round(acc,3),meanDraw=round(mean([r[key]['draw'] for r in rs]),3),meanTop=round(mean([max(r[key].values()) for r in rs]),3))
rm=[r for r in rows if r['mkt'] and r['obs'] and r['obs']<=r['kick']]
out['market_n_total']=len([r for r in rows if r['mkt']]); out['market_n_prekickoff']=len(rm)
cmp={m:ev(rm,m) for m in ['prod','ch','v2h','mkt']}
out['production_vs_market']=cmp
pd={}
for m in ['prod','ch','v2h']:
    d=[ll(r[m],r['a'])-ll(r['mkt'],r['a']) for r in rm]
    pd[m+'_minus_market_logloss']={'mean':round(mean(d),4),'ci95_boot':boot(d),'share_fixtures_better_than_market':round(mean([1 if x<0 else 0 for x in d]),3)}
    d=[br(r[m],r['a'])-br(r['mkt'],r['a']) for r in rm]
    pd[m+'_minus_market_brier']={'mean':round(mean(d),4),'ci95_boot':boot(d)}
out['paired_vs_market']=pd
# extreme production probabilities
ex={}
for t in (0.7,0.8,0.9):
    s=[r for r in rm if max(r['prod'].values())>=t]
    hit=sum(1 for r in s if max(K,key=lambda k:r['prod'][k])==r['a'])
    sm=[r for r in s if max(K,key=lambda k:r['mkt'][k])==max(K,key=lambda k:r['prod'][k])]
    ex[f'>={t}']={'n':len(s),'meanProdTop':round(mean([max(r['prod'].values()) for r in s]),3) if s else None,'meanMarketProbOnSameSide':round(mean([r['mkt'][max(K,key=lambda k:r['prod'][k])] for r in s]),3) if s else None,'hit':hit,'hitRate':round(hit/len(s),3) if s else None,'ci95':wil(hit,len(s))}
out['production_extremes_vs_market']=ex
# gap model-market on top side vs outcome
gaps=collections.defaultdict(list)
for r in rm:
    side=max(K,key=lambda k:r['prod'][k]);g=r['prod'][side]-r['mkt'][side]
    b='<0' if g<0 else '0-10pp' if g<.1 else '10-20pp' if g<.2 else '20pp+'
    gaps[b].append((1 if side==r['a'] else 0, r['prod'][side], r['mkt'][side]))
out['top_side_gap_buckets']={b:{'n':len(v),'prod':round(mean([x[1] for x in v]),3),'market':round(mean([x[2] for x in v]),3),'hit':round(mean([x[0] for x in v]),3)} for b,v in sorted(gaps.items())}
# by category
bc={}
for c in set(r['cat'] for r in rm):
    s=[r for r in rm if r['cat']==c]
    bc[c]={'n':len(s),'prod_ll':round(mean([ll(r['prod'],r['a']) for r in s]),3),'mkt_ll':round(mean([ll(r['mkt'],r['a']) for r in s]),3)}
out['by_production_category']=bc
# ---------- 2. Market bets
P={r['snapshotKey']:r for r in mb if r['recordType']=='PREDICTION'}
R={r['snapshotKey']:r for r in mb if r['recordType']=='RESULT'}
def settle(p,h,a):
    m,sel,line=p['market'],p['selection'],p['line']
    if m=='1X2': return 'WIN' if ((sel=='П1' and h>a) or (sel=='X' and h==a) or (sel=='П2' and a>h)) else 'LOSS'
    if m=='OU':
        over=sel.startswith('ТБ'); t=h+a
        legs=[line] if (line*2)%1==0 and line%1==0 or (line*2)%1==0 and line%1!=0 else [math.floor(line*2)/2,math.ceil(line*2)/2]
        if line%1==0.5: legs=[line]
        def leg(l):
            x=(t-l) if over else (l-t); return 1 if x>0 else 0 if x==0 else -1
        v=sum(leg(l) for l in legs)/len(legs); return {1:'WIN',.5:'HALF_WIN',0:'PUSH',-.5:'HALF_LOSS',-1:'LOSS'}[v]
    return None
def prof(s,o): return {'WIN':o-1,'HALF_WIN':(o-1)/2,'PUSH':0,'HALF_LOSS':-.5,'LOSS':-1,'VOID':0}[s]
chk=[];det=[]
for k,p in P.items():
    r=R.get(k)
    row=dict(k=k,cat=p['category'],mkt=p['market'],sel=p['selection'],line=p['line'],odds=p['odds'],bk=p['bookmaker'],mp=p['modelProbability'],fm=p['fairMarketProbability'],edge=p['edge'],ev=p['ev'],kick=p['kickoff'],fid=p['fixtureId'],home=p['home'],away=p['away'],comp=p['competition'],created=p['createdAt'])
    if r:
        row['settle']=r['settlement'];row['profit']=r['unitProfit'];row['score']=r['score']
        ind=indep(p['fixtureId'])
        row['indep']=ind
        if ind and len(ind)==1:
            h,a=ind[0]; s2=settle(p,h,a); row['recheck']=s2
            if s2 and s2!=r['settlement']: chk.append((k,r['settlement'],s2,r['score'],ind))
        if r['score'] and ind and (r['score']['home'],r['score']['away']) not in ind: chk.append((k,'SCORE_DIFF',r['score'],ind))
        if abs(prof(r['settlement'],p['odds'])-r['unitProfit'])>1e-9: chk.append((k,'PROFIT_DIFF'))
    det.append(row)
out['bets_check']={'predictions':len(P),'results':len(R),'orphan_results':len(set(R)-set(P)),'recheck_discrepancies':chk}
def roi(rs):
    s=[r for r in rs if r.get('settle') and r['settle']!='VOID']
    if not s: return {'n':0}
    pr_=[r['profit'] for r in s]; m=mean(pr_); sd=math.sqrt(mean([(x-m)**2 for x in pr_]))
    w=sum(1 for r in s if r['settle']=='WIN')
    # market-implied expected roi using fair market prob
    mexp=mean([r['fm']*r['odds']-1 for r in s]); mex=mean([r['mp']*r['odds']-1 for r in s])
    return dict(n=len(s),wins=w,winRate=round(w/len(s),3),winCI=wil(w,len(s)),profit=round(sum(pr_),2),roi=round(m,4),roiSE=round(sd/math.sqrt(len(s)),4),roiBootCI=boot(pr_),avgOdds=round(mean([r['odds'] for r in s]),2),meanModelProb=round(mean([r['mp'] for r in s]),3),meanMarketFairProb=round(mean([r['fm'] for r in s]),3),claimedEV_byModel=round(mex,3),expectedROI_ifMarketFair=round(mexp,3))
out['roi_all']=roi(det)
out['roi_by_category']={c:roi([r for r in det if r['cat']==c]) for c in ['VALUE','NEAR']}
out['roi_by_market']={m:roi([r for r in det if r['mkt']==m]) for m in sorted(set(r['mkt'] for r in det))}
def band(r): 
    o=r['odds']; return '<2' if o<2 else '2-3' if o<3 else '3-5' if o<5 else '5+'
out['roi_by_odds_band']={b:roi([r for r in det if band(r)==b]) for b in ['<2','2-3','3-5','5+']}
def eb(r): e=r['edge']; return '<8' if e<8 else '8-15' if e<15 else '15-30' if e<30 else '30+'
out['roi_by_edge_band']={b:roi([r for r in det if eb(r)==b]) for b in ['<8','8-15','15-30','30+']}
out['roi_by_selection_1x2']={s:roi([r for r in det if r['mkt']=='1X2' and r['sel']==s]) for s in ['П1','X','П2']}
out['roi_by_bookmaker']={b:roi([r for r in det if r['bk']==b]) for b in sorted(set(r['bk'] for r in det))}
# duplicates: same fixture multiple bets
byfx=collections.Counter(r['fid'] for r in det); out['fixtures_with_multiple_bets']=sum(1 for v in byfx.values() if v>1)
# distinct-fixture ROI (first record per fixture) 
seen=set();first=[]
for r in sorted(det,key=lambda r:r['created']):
    if r['fid'] in seen: continue
    seen.add(r['fid']);first.append(r)
out['roi_first_bet_per_fixture']=roi(first)
# VALUE detail
out['value_bets']=[{k:(round(v,3) if isinstance(v,float) else v) for k,v in r.items() if k not in('indep','k')} for r in det if r['cat']=='VALUE']
# 13 Oct window
out['bets_kickoff_oct13']=[ {k:r[k] for k in('cat','home','away','sel','odds','created')} for r in det if r['kick'][:10]=='2026-10-13']
out['bets_created_oct12_14']=[ {k:r[k] for k in('cat','home','away','sel','odds','created','kick')} for r in det if '2026-10-12'<=r['created'][:10]<='2026-10-14']
# calibration of selected side for 1X2 bets vs market-closing for those that have benchmark
json.dump(out,open(sys.argv[2],'w'),ensure_ascii=False,indent=1,default=str)
json.dump(det,open(sys.argv[3],'w'),ensure_ascii=False,default=str)
print(json.dumps({k:out[k] for k in ['results_check','market_n_total','market_n_prekickoff','production_vs_market','paired_vs_market','roi_all','roi_by_category','bets_check']},ensure_ascii=False,indent=1,default=str))
