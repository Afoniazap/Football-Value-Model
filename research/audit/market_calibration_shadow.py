# Research/Shadow only: reads the Termux export, writes nothing into it, touches no signal.
# Compares raw model vs market vs (a) market-blend and (b) disagreement caps on IDENTICAL matches,
# fitting every parameter walk-forward (only matches that finished before each target's kickoff).
import json,math,sys,collections,random
D=sys.argv[1]; random.seed(3)
K=['home','draw','away']
def load(p): return [json.loads(l) for l in open(f'{D}/{p}') if l.strip()]
ds=load('statistics/dual-shadow.jsonl')
pred={r['snapshotKey']:r for r in ds if r['type']=='SHADOW_PREDICTION'}
res={r['snapshotKey']:r for r in ds if r['type']=='SHADOW_RESULT'}
bench=collections.defaultdict(list)
for r in ds:
    if r['type']=='SHADOW_MARKET_BENCHMARK': bench[r['snapshotKey']].append(r)
rows=[]
for k,r in res.items():
    p=pred.get(k); mb=r.get('marketBenchmark')
    if not p or not mb or mb['observedAt']>p['kickoff']: continue
    odds=None
    for b in bench[k]:
        if b['observedAt']==mb['observedAt']: odds=b['closingCandidate'].get('odds')
    rows.append(dict(k=k,kick=p['kickoff'],a=r['actual'],mkt=mb['closingNoVig'],odds=odds,
        models={n:p['models'][n]['probability'] for n in ('production','challenger','v2h')},cat=p['productionCategory']))
rows.sort(key=lambda r:r['kick'])
print('identical matches:',len(rows),rows[0]['kick'][:10],rows[-1]['kick'][:10],file=sys.stderr)
ll=lambda p,a:-math.log(max(1e-12,p[a])); br=lambda p,a:sum((p[k]-(1 if k==a else 0))**2 for k in K)/3
mean=lambda x:sum(x)/len(x)
def norm(p): s=sum(p.values()); return {k:v/s for k,v in p.items()}
def blend(m,q,w): return norm({k:w*m[k]+(1-w)*q[k] for k in K})                   # linear
def lblend(m,q,w): return norm({k:math.exp(w*math.log(max(1e-9,m[k]))+(1-w)*math.log(max(1e-9,q[k]))) for k in K})  # log-linear
def cap(m,q,d):
    c={k:min(q[k]+d,max(q[k]-d,m[k])) for k in K}; return norm(c)                 # |model-market|<=d per outcome
def boot(xs,n=3000):
    b=sorted(mean([random.choice(xs) for _ in xs]) for _ in range(n)); return [round(b[int(.025*n)],4),round(b[int(.975*n)],4)]
WS=[i/20 for i in range(0,21)]
def fit_w(hist,mname,f):
    best=min(WS,key=lambda w:mean([ll(f(h['models'][mname],h['mkt'],w),h['a']) for h in hist])); return best
def ece(ps,as_):
    bins=[[0,0,0] for _ in range(10)]
    for p,a in zip(ps,as_):
        for k in K:
            b=min(9,int(p[k]*10)); bins[b][0]+=1; bins[b][1]+=p[k]; bins[b][2]+=(1 if a==k else 0)
    n=sum(b[0] for b in bins); return sum(b[0]/n*abs(b[1]/b[0]-b[2]/b[0]) for b in bins if b[0])
out={'n_matches':len(rows),'period':[rows[0]['kick'][:10],rows[-1]['kick'][:10]],'note':'closing = last stored pre-kickoff quote (median 5.8h before start). Hypothetical; no real signal affected.'}
START=120   # first 120 matches only train; evaluation on the rest (walk-forward)
ev=rows[START:]
out['n_eval']=len(ev)
def summarize(name,fn):
    ps=[fn(i) for i in range(START,len(rows))]
    L=[ll(p,r['a']) for p,r in zip(ps,ev)]; B=[br(p,r['a']) for p,r in zip(ps,ev)]
    return ps,L,B
res_tab={}
mk_ps=[r['mkt'] for r in ev]; mkL=[ll(p,r['a']) for p,r in zip(mk_ps,ev)]
res_tab['market']={'logloss':round(mean(mkL),4),'brier':round(mean([br(p,r['a']) for p,r in zip(mk_ps,ev)]),4),'ece':round(ece(mk_ps,[r['a'] for r in ev]),4)}
for mname in ('production','challenger','v2h'):
    raw=[r['models'][mname] for r in ev]; rawL=[ll(p,r['a']) for p,r in zip(raw,ev)]
    res_tab[f'{mname}:raw']={'logloss':round(mean(rawL),4),'brier':round(mean([br(p,r['a']) for p,r in zip(raw,ev)]),4),'ece':round(ece(raw,[r['a'] for r in ev]),4),'vs_market_logloss':round(mean(rawL)-mean(mkL),4),'vs_market_ci':boot([a-b for a,b in zip(rawL,mkL)])}
    for tag,f in (('blend_linear_wf',blend),('blend_loglinear_wf',lblend)):
        ps=[];ws=[]
        for i in range(START,len(rows)):
            # training set = matches that FINISHED before this fixture kicked off (result known)
            hist=[h for h in rows[:i] if h['kick']<rows[i]['kick']]
            w=fit_w(hist,mname,f); ws.append(w); ps.append(f(rows[i]['models'][mname],rows[i]['mkt'],w))
        L=[ll(p,r['a']) for p,r in zip(ps,ev)]
        res_tab[f'{mname}:{tag}']={'logloss':round(mean(L),4),'brier':round(mean([br(p,r['a']) for p,r in zip(ps,ev)]),4),'ece':round(ece(ps,[r['a'] for r in ev]),4),'vs_market_logloss':round(mean(L)-mean(mkL),4),'vs_market_ci':boot([a-b for a,b in zip(L,mkL)]),'vs_raw_logloss':round(mean(L)-mean(rawL),4),'vs_raw_ci':boot([a-b for a,b in zip(L,rawL)]),'weight_on_model_median':sorted(ws)[len(ws)//2],'weight_on_model_last':ws[-1]}
    for d in (0.05,0.10,0.15,0.20):
        ps=[cap(r['models'][mname],r['mkt'],d) for r in ev]; L=[ll(p,r['a']) for p,r in zip(ps,ev)]
        res_tab[f'{mname}:cap_{int(d*100)}pp']={'logloss':round(mean(L),4),'brier':round(mean([br(p,r['a']) for p,r in zip(ps,ev)]),4),'ece':round(ece(ps,[r['a'] for r in ev]),4),'vs_market_logloss':round(mean(L)-mean(mkL),4),'vs_raw_logloss':round(mean(L)-mean(rawL),4)}
out['probability_quality_walk_forward']=res_tab
# full-sample descriptive weight (NOT out-of-sample): where does logloss minimise?
desc={}
for mname in ('production','challenger','v2h'):
    for tag,f in (('linear',blend),('loglinear',lblend)):
        w=fit_w(rows,mname,f); desc[f'{mname}:{tag}']={'best_weight_on_model':w,'logloss':round(mean([ll(f(r['models'][mname],r['mkt'],w),r['a']) for r in rows]),4)}
out['descriptive_full_sample_best_weight']=desc
# hypothetical betting on IDENTICAL matches: same selection rule as FVM (edge>=4pp, EV>=5%) with each probability variant, at the stored last-quote odds
def bets(variant):
    P=[];n=0
    for i in range(START,len(rows)):
        r=rows[i]
        if not r['odds']: continue
        p=variant(i)
        c=max(K,key=lambda k:p[k]-r['mkt'][k]); edge=(p[c]-r['mkt'][c])*100; evv=(p[c]*r['odds'][c]-1)*100
        if edge>=4 and evv>=5: P.append(r['odds'][c]-1 if r['a']==c else -1)
    return P
def roi(P): 
    if not P: return {'n':0}
    m=mean(P); sd=math.sqrt(mean([(x-m)**2 for x in P])); return {'n':len(P),'roi':round(m,4),'se':round(sd/math.sqrt(len(P)),3),'ci':boot(P) if len(P)>4 else None}
bt={}
for mname in ('production','challenger','v2h'):
    bt[f'{mname}:raw']=roi(bets(lambda i:rows[i]['models'][mname]))
    for d in (0.05,0.10,0.15):
        bt[f'{mname}:cap_{int(d*100)}pp']=roi(bets(lambda i,d=d:cap(rows[i]['models'][mname],rows[i]['mkt'],d)))
    def wf(i,mname=mname):
        hist=[h for h in rows[:i] if h['kick']<rows[i]['kick']]; w=fit_w(hist,mname,lblend); return lblend(rows[i]['models'][mname],rows[i]['mkt'],w)
    bt[f'{mname}:blend_loglinear_wf']=roi(bets(wf))
out['hypothetical_bets_same_rule_FVM_edge4_ev5']=bt
out['bets_note']='odds = last stored pre-kickoff quote of the SAME snapshot used as market; not the odds at which FVM would have bet; use as a relative comparison only.'
# disagreement buckets on the raw model vs market, walk-forward-free descriptive
bk=collections.defaultdict(list)
for r in ev:
    p=r['models']['production']; c=max(K,key=lambda k:p[k]-r['mkt'][k]); g=(p[c]-r['mkt'][c])*100
    b='<=0' if g<=0 else '0-5' if g<5 else '5-10' if g<10 else '10-20' if g<20 else '20+'
    bk[b].append((1 if r['a']==c else 0,p[c],r['mkt'][c]))
out['production_largest_positive_gap_outcome']={b:{'n':len(v),'model':round(mean([x[1] for x in v]),3),'market':round(mean([x[2] for x in v]),3),'hit':round(mean([x[0] for x in v]),3)} for b,v in sorted(bk.items())}
json.dump(out,open(sys.argv[2],'w'),ensure_ascii=False,indent=1)
print(json.dumps(out,ensure_ascii=False,indent=1))
