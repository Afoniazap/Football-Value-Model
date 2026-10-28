# Research only. Probability-level error analysis + walk-forward improvement variants on IDENTICAL matches.
# Reads the Termux export (never writes into it). Parameters are fitted ONLY on matches finished before each target's kickoff
# and only by log-loss (never by ROI). Evaluation = matches after the first 120 (chronological), reported in 3 equal periods.
import json,math,sys,collections,random
D=sys.argv[1]; OUT=sys.argv[2]; random.seed(2026)
K=['home','draw','away']
def load(p): return [json.loads(l) for l in open(f'{D}/{p}') if l.strip()]
ds=load('statistics/dual-shadow.jsonl')
pred={r['snapshotKey']:r for r in ds if r['type']=='SHADOW_PREDICTION'}
res={r['snapshotKey']:r for r in ds if r['type']=='SHADOW_RESULT'}
rows=[]
for k,r in res.items():
    p=pred.get(k); mb=r.get('marketBenchmark')
    if not p or not mb or mb['observedAt']>p['kickoff']: continue
    m={n:p['models'][n]['probability'] for n in ('production','challenger','v2h')}
    ens={c:sum(m[n][c] for n in m)/3 for c in K}
    m['ensemble']=ens
    rows.append(dict(kick=p['kickoff'],a=r['actual'],mkt=mb['closingNoVig'],m=m,comp=p['competitionCode'],fid=p['fixtureId']))
rows.sort(key=lambda r:r['kick']); N=len(rows); START=120
ll=lambda p,a:-math.log(max(1e-12,p[a])); br=lambda p,a:sum((p[k]-(1 if k==a else 0))**2 for k in K)/3
mean=lambda x:sum(x)/len(x)
def norm(p): s=sum(p.values()); return {k:v/s for k,v in p.items()}
def boot(xs,n=3000):
    b=sorted(mean([random.choice(xs) for _ in xs]) for _ in range(n)); return [round(b[int(.025*n)],4),round(b[int(.975*n)],4)]
def ece(ps,as_):
    bins=[[0,0,0] for _ in range(10)]
    for p,a in zip(ps,as_):
        for k in K:
            b=min(9,int(p[k]*10)); bins[b][0]+=1; bins[b][1]+=p[k]; bins[b][2]+=(1 if a==k else 0)
    n=sum(b[0] for b in bins); return sum(b[0]/n*abs(b[1]/b[0]-b[2]/b[0]) for b in bins if b[0])
out={'matches':N,'period':[rows[0]['kick'][:10],rows[-1]['kick'][:10]],'eval_matches':N-START}
# ---------- 1. error structure (descriptive, all matches)
act=collections.Counter(r['a'] for r in rows)
out['outcome_rates']={'actual':{k:round(act[k]/N,3) for k in K},**{n:{k:round(mean([r['m'][n][k] for r in rows]),3) for k in K} for n in ('production','challenger','v2h','ensemble')},'market':{k:round(mean([r['mkt'][k] for r in rows]),3) for k in K}}
bins=[(0,.15),(.15,.25),(.25,.4),(.4,.6),(.6,1.01)]
cal={}
for name in ('production','challenger','v2h','ensemble','market'):
    cal[name]={}
    for lo,hi in bins:
        pts=[]
        for r in rows:
            q=r['mkt']; pm=r['m'].get(name,r['mkt']) if name!='market' else r['mkt']
            for k in K:
                if lo<=q[k]<hi: pts.append((pm[k],q[k],1 if r['a']==k else 0))
        cal[name][f'mkt[{lo},{hi})']={'n':len(pts),'pred':round(mean([x[0] for x in pts]),3),'marketP':round(mean([x[1] for x in pts]),3),'freq':round(mean([x[2] for x in pts]),3)}
out['by_market_probability_bucket(all outcomes pooled)']=cal
# per outcome class bias in LL terms
byc={}
for name in ('production','challenger','v2h','ensemble'):
    byc[name]={}
    for k in K:
        s=[r for r in rows if r['a']==k]
        byc[name][k]={'n':len(s),'meanProbOnActual':round(mean([r['m'][name][k] for r in s]),3),'marketMeanProbOnActual':round(mean([r['mkt'][k] for r in s]),3)}
out['probability_assigned_to_actual_outcome']=byc
# favourites / underdogs (by market) hit rates
fav={}
for name in ('production','challenger','v2h','ensemble'):
    fs=[r for r in rows]; 
    def side(r,f): return f(r['mkt'],key=lambda k:r['mkt'][k])
    fav[name]={'favourite':{'meanModel':round(mean([r['m'][name][max(K,key=lambda k:r['mkt'][k])] for r in rows]),3),'meanMarket':round(mean([max(r['mkt'].values()) for r in rows]),3),'freq':round(mean([1 if r['a']==max(K,key=lambda k:r['mkt'][k]) else 0 for r in rows]),3)},
               'underdog':{'meanModel':round(mean([r['m'][name][min(K,key=lambda k:r['mkt'][k])] for r in rows]),3),'meanMarket':round(mean([min(r['mkt'].values()) for r in rows]),3),'freq':round(mean([1 if r['a']==min(K,key=lambda k:r['mkt'][k]) else 0 for r in rows]),3)}}
out['favourite_vs_underdog']=fav
# by league and by period (descriptive)
comp=collections.defaultdict(list)
for r in rows: comp[r['comp']].append(r)
out['by_league_logloss_gap_vs_market']={c:{'n':len(v),**{n:round(mean([ll(r['m'][n],r['a'])-ll(r['mkt'],r['a']) for r in v]),3) for n in ('production','v2h')}} for c,v in sorted(comp.items(),key=lambda kv:-len(kv[1])) if len(v)>=15}
# ---------- 2. walk-forward variants
def temp(p,T): return norm({k:max(1e-9,p[k])**(1/T) for k in K})
def drawf(p,f): return norm({'home':p['home'],'draw':p['draw']*f,'away':p['away']})
def cap(p,q,d): return norm({k:min(q[k]+d,max(q[k]-d,p[k])) for k in K})
def lblend(p,q,w): return norm({k:math.exp(w*math.log(max(1e-9,p[k]))+(1-w)*math.log(max(1e-9,q[k]))) for k in K})
TG=[0.6+0.1*i for i in range(20)]; FG=[0.6+0.05*i for i in range(25)]; WG=[i/20 for i in range(21)]
def wf(fitfn,applyfn):
    ps=[]
    for i in range(START,N):
        hist=[h for h in rows[:i] if h['kick']<rows[i]['kick']]
        theta=fitfn(hist); ps.append(applyfn(rows[i],theta))
    return ps
def best(grid,hist,f): return min(grid,key=lambda g:mean([ll(f(h,g),h['a']) for h in hist]))
ev=rows[START:]; thirds=[ev[:len(ev)//3],ev[len(ev)//3:2*len(ev)//3],ev[2*len(ev)//3:]]
variants={}
for mn in ('production','challenger','v2h','ensemble'):
    variants[f'{mn}:raw']=[r['m'][mn] for r in ev]
    variants[f'{mn}:temperature_wf']=wf(lambda h,mn=mn:best(TG,h,lambda x,g:temp(x['m'][mn],g)),lambda r,T,mn=mn:temp(r['m'][mn],T))
    variants[f'{mn}:draw_factor_wf']=wf(lambda h,mn=mn:best(FG,h,lambda x,g:drawf(x['m'][mn],g)),lambda r,f,mn=mn:drawf(r['m'][mn],f))
    variants[f'{mn}:cap5']=[cap(r['m'][mn],r['mkt'],.05) for r in ev]
    variants[f'{mn}:cap10']=[cap(r['m'][mn],r['mkt'],.10) for r in ev]
    variants[f'{mn}:shrink_to_market_wf']=wf(lambda h,mn=mn:best(WG,h,lambda x,g:lblend(x['m'][mn],x['mkt'],g)),lambda r,w,mn=mn:lblend(r['m'][mn],r['mkt'],w))
variants['market']=[r['mkt'] for r in ev]
def stats(name,ps):
    L=[ll(p,r['a']) for p,r in zip(ps,ev)]
    return L
mk=stats('market',variants['market']); pr=stats('prod',variants['production:raw'])
tab={}
for name,ps in variants.items():
    L=stats(name,ps); B=[br(p,r['a']) for p,r in zip(ps,ev)]
    d_m=[a-b for a,b in zip(L,mk)]; d_p=[a-b for a,b in zip(L,pr)]
    per=[]
    for lo,hi in ((0,len(ev)//3),(len(ev)//3,2*len(ev)//3),(2*len(ev)//3,len(ev))):
        per.append({'n':hi-lo,'vs_market':round(mean(d_m[lo:hi]),4),'vs_production_raw':round(mean(d_p[lo:hi]),4)})
    tab[name]={'logloss':round(mean(L),4),'brier':round(mean(B),4),'ece':round(ece(ps,[r['a'] for r in ev]),4),'vs_market':{'mean':round(mean(d_m),4),'ci95':boot(d_m)},'vs_production_raw':{'mean':round(mean(d_p),4),'ci95':boot(d_p)},'periods':per,
        'periods_better_than_market':sum(1 for p in per if p['vs_market']<0),'periods_better_than_production':sum(1 for p in per if p['vs_production_raw']<0)}
out['walk_forward_variants']=tab
# fitted parameter trajectories (last fit)
hist_all=rows
out['fitted_parameters_full_sample(descriptive)']={mn:{'T':round(best(TG,hist_all,lambda x,g,mn=mn:temp(x['m'][mn],g)),2),'draw_factor':round(best(FG,hist_all,lambda x,g,mn=mn:drawf(x['m'][mn],g)),2),'weight_on_model':best(WG,hist_all,lambda x,g,mn=mn:lblend(x['m'][mn],x['mkt'],g))} for mn in ('production','challenger','v2h','ensemble')}
json.dump(out,open(OUT,'w'),ensure_ascii=False,indent=1)
print('done',N,len(ev))
