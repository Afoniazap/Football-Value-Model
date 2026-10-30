# Research only. ratings-v1 (the shipped module, run by scripts/ratings-v1-backtest.js) vs Production(k=0), reconstructed k=8,
# existing Challenger/V2H and the market, on IDENTICAL matches. Parameters were fixed BEFORE each evaluated period:
#   segment A (2026-01..06): paramsId trainA (tuned on matches < 2026-01-01);  segment B (2026-08..): paramsId v1.0 (tuned on < 2026-08-01).
import json,math,sys,random,collections
S=sys.argv[1]; R=sys.argv[2]; OUT=sys.argv[3]; random.seed(77)
K=['home','draw','away']; mean=lambda x:sum(x)/len(x) if x else None
ll=lambda p,a:-math.log(max(1e-12,p[a]))
def boot(xs,n=3000):
    if len(xs)<8: return None
    b=sorted(mean([random.choice(xs) for _ in xs]) for _ in range(n)); return [round(b[int(.025*n)],4),round(b[int(.975*n)],4)]
def load(p): return [json.loads(l) for l in open(p) if l.strip()]
rt=json.load(open(f'{S}/ratings.json')); sv={(r['kick'],r['home'],r['away']):r for r in json.load(open(f'{S}/shrink_variants.json'))}
rp={(r['kick'],r['home'],r['away']):r for r in json.load(open(f'{S}/replay_engine.json'))}
names={(m['kick'],m['h'],m['a']):(m['home'],m['away']) for m in rt['matches']}
def rv(name): return {(r['kickoff'],r['homeId'],r['awayId']):r for r in load(f'{R}/{name}.jsonl')}
V={k:rv(k) for k in ('v1_lag0','v1_lag12','v1_lag24','trainA_lag12')}
act=lambda r:'home' if r['hg']>r['ag'] else 'away' if r['ag']>r['hg'] else 'draw'
E=[]
for key,(hn,an) in names.items():
    kick=key[0]; a=sv.get((kick,hn,an)); b=rp.get((kick,hn,an))
    if not a or not b or not b['v2h'] or not a.get('challenger') or key not in V['v1_lag12']: continue
    seg='A' if kick<'2026-07-01' else 'B'
    one=V['trainA_lag12'][key] if seg=='A' else V['v1_lag12'][key]
    E.append(dict(kick=kick,seg=seg,a=act(V['v1_lag12'][key]),k0=a['k0']['cons'],k8=a['k8']['cons'],ch=a['challenger'],v2h=b['v2h'],
                  v1=one['probability'],v1_lag0=(V['trainA_lag12'] if seg=='A' else V['v1_lag0'])[key]['probability'],v1_lag24=(V['trainA_lag12'] if seg=='A' else V['v1_lag24'])[key]['probability'],g=a['g'],flags=one['flags'],key=key,
                  poisson_head=one['heads']['poissonDc'],elo_head=one['heads']['elo']))
out={'n':len(E),'segments':dict(collections.Counter(e['seg'] for e in E)),'paramsA':'trainA (tuned < 2026-01-01)','paramsB':'ratings-v1.0 (tuned < 2026-08-01)'}
names_=['k0','k8','ch','v2h','v1','poisson_head','elo_head']
def block(rs):
    t={n:round(mean([ll(r[n],r['a']) for r in rs]),4) for n in names_}
    cmp={}
    for base in ('k0','k8','ch','v2h'):
        d=[ll(r['v1'],r['a'])-ll(r[base],r['a']) for r in rs]; cmp[f'v1_vs_{base}']={'mean':round(mean(d),4),'ci95':boot(d)}
    return {'n':len(rs),'logloss':t,'paired':cmp}
out['all']=block(E)
for s in 'AB': out[s]=block([r for r in E if r['seg']==s])
B=sorted([r for r in E if r['seg']=='B'],key=lambda r:r['kick']); out['B_first_half']=block(B[:len(B)//2]); out['B_second_half']=block(B[len(B)//2:])
out['games<10']=block([r for r in E if r['g']<10]); out['games>=10']=block([r for r in E if r['g']>=10])
out['no_NEW_TEAM_no_LOW_DEPTH']=block([r for r in E if not r['flags']])
mon=collections.defaultdict(list)
for r in E: mon[r['kick'][:7]].append(r)
out['monthly_v1_minus_k8']={k:{'n':len(v),'mean':round(mean([ll(r['v1'],r['a'])-ll(r['k8'],r['a']) for r in v]),4)} for k,v in sorted(mon.items()) if len(v)>=40}
out['monthly_v1_minus_k0']={k:{'n':len(v),'mean':round(mean([ll(r['v1'],r['a'])-ll(r['k0'],r['a']) for r in v]),4)} for k,v in sorted(mon.items()) if len(v)>=40}
out['months_v1_beats_k8']=[sum(1 for v in out['monthly_v1_minus_k8'].values() if v['mean']<0),len(out['monthly_v1_minus_k8'])]
out['information_lag_sensitivity_logloss']={s:{lag:round(mean([ll(r[k],r['a']) for r in E if r['seg']==s]),4) for lag,k in (('0h','v1_lag0'),('12h','v1'),('24h','v1_lag24'))} for s in 'AB'}
# ---------------- market
ds=load(f'{S}/export/fvm-audit-export/data/statistics/dual-shadow.jsonl')
pred={r['snapshotKey']:r for r in ds if r['type']=='SHADOW_PREDICTION'}; res={r['snapshotKey']:r for r in ds if r['type']=='SHADOW_RESULT'}
byk={(m['kick'],m['h'],m['a']):m for m in rt['matches']}
MM=[]
for sk,key in rt['dualMap'].items():
    r=res.get(sk); p=pred.get(sk)
    if not r or not r.get('marketBenchmark') or r['marketBenchmark']['observedAt']>p['kickoff']: continue
    k=tuple(key.split('|')); m=byk.get(k)
    if not m or m['seg']!='B' or k not in V['v1_lag12']: continue
    v=sv.get((m['kick'],m['home'],m['away']))
    MM.append(dict(a=r['actual'],mkt=r['marketBenchmark']['closingNoVig'],live_prod=p['models']['production']['probability'],live_ch=p['models']['challenger']['probability'],live_v2h=p['models']['v2h']['probability'],k8=v['k8']['cons'] if v else None,k0=v['k0']['cons'] if v else None,v1=V['v1_lag12'][k]['probability'],kick=p['kickoff'],key=k,fid=str(p['fixtureId'])))
def mblock(rs,ns):
    o={'n':len(rs)}
    for n in ns:
        L=[ll(r[n],r['a']) for r in rs]; o[n]={'logloss':round(mean(L),4)}
        if n!='mkt': d=[ll(r[n],r['a'])-ll(r['mkt'],r['a']) for r in rs]; o[n]['vs_market']={'mean':round(mean(d),4),'ci95':boot(d)}
    return o
out['market_B']=mblock(MM,['mkt','live_prod','live_ch','live_v2h','v1'])
d=[ll(r['v1'],r['a'])-ll(r['live_prod'],r['a']) for r in MM]; out['market_B']['v1_vs_live_production']={'mean':round(mean(d),4),'ci95':boot(d)}
d=[ll(r['v1'],r['a'])-ll(r['live_ch'],r['a']) for r in MM]; out['market_B']['v1_vs_live_challenger']={'mean':round(mean(d),4),'ci95':boot(d)}
MK=[r for r in MM if r['k8']]; out['market_B_with_k8']=mblock(MK,['mkt','live_prod','k0','k8','live_ch','live_v2h','v1'])
MM.sort(key=lambda r:r['kick']); h=len(MM)//2
out['market_B_first_half']=mblock(MM[:h],['mkt','live_prod','live_ch','v1']); out['market_B_second_half']=mblock(MM[h:],['mkt','live_prod','live_ch','v1'])
lg=lambda p:math.log(max(1e-6,p)/max(1e-6,1-p)); sg=lambda z:1/(1+math.exp(-z))
def solve(A,b):
    n=len(b);M=[A[i][:]+[b[i]] for i in range(n)]
    for i in range(n):
        p=max(range(i,n),key=lambda r:abs(M[r][i])); M[i],M[p]=M[p],M[i]
        for j in range(i+1,n):
            f=M[j][i]/M[i][i]
            for k in range(i,n+1): M[j][k]-=f*M[i][k]
    x=[0]*n
    for i in range(n-1,-1,-1): x[i]=(M[i][n]-sum(M[i][j]*x[j] for j in range(i+1,n)))/M[i][i]
    return x
def fit(ms,name):
    P=[(1.0,lg(m['mkt'][k]),lg(m[name][k]),1 if m['a']==k else 0) for m in ms for k in K]; w=[0,0,0]
    for _ in range(30):
        g=[0]*3;H=[[0]*3 for _ in range(3)]
        for x in P:
            p=sg(sum(a*b for a,b in zip(w,x[:3])))
            for i in range(3):
                g[i]+=(x[3]-p)*x[i]
                for j in range(3): H[i][j]+=p*(1-p)*x[i]*x[j]
        s=solve(H,g); w=[a+b for a,b in zip(w,s)]
        if max(abs(v) for v in s)<1e-8: break
    return w
info={}
for n in ('live_prod','live_v2h','v1'):
    est=fit(MM,n); bs=sorted(fit([random.choice(MM) for _ in MM],n)[2] for _ in range(250)); info[n]={'b_market':round(est[1],3),'b_model':round(est[2],3),'b_model_ci95':[round(bs[6],3),round(bs[243],3)]}
out['information_beyond_market']=info
# ---------------- VALUE selection on graded 1X2 candidates
pr=[x for x in load(f'{S}/export/fvm-audit-export/data/statistics/predictions.jsonl')]
sn=[r for r in pr if r['type']=='SNAPSHOT']; sres=[r for r in pr if r['type']=='SNAPSHOT_RESULT']
idx=collections.defaultdict(list)
for r in sn: idx[(r['fixtureKey'],r.get('market'),r.get('selection'),r.get('line'))].append(r)
fid2key={}
for sk,key in rt['dualMap'].items():
    p=pred.get(sk)
    if p: fid2key[str(p['fixtureId'])]=tuple(key.split('|'))
KEY={'П1':'home','X':'draw','П2':'away'}; C=[]
for s in sres:
    if s['market']!='1X2': continue
    c=[r for r in idx[(s['fixtureKey'],s['market'],s['selection'],s['line'])] if abs((r.get('odds') or 0)-s['odds'])<1e-9] or idx[(s['fixtureKey'],s['market'],s['selection'],s['line'])]
    r=min(c,key=lambda r:r['createdAt']); k=fid2key.get(str(r['fixtureId']))
    if not k or not r.get('consensusProbability') or k not in V['v1_lag12']: continue
    v=sv.get((k[0],byk[k]['home'],byk[k]['away'])); side=KEY[s['selection']]
    C.append(dict(odds=s['odds'],fair=r['marketProbability'],win=1 if s['settlement']=='WIN' else 0,profit=s['profitLossUnits'],prod=r['consensusProbability'][side],v1=V['v1_lag12'][k]['probability'][side],k8=(v['k8']['cons'][side] if v else None)))
def sel(rs,pk): return [r for r in rs if r[pk] is not None and (r[pk]-r['fair'])*100>=4 and (r[pk]*r['odds']-1)*100>=5]
def srow(rs):
    if not rs: return {'n':0}
    ex=[r['profit']-(r['fair']*r['odds']-1) for r in rs]
    return {'n':len(rs),'hit':round(mean([r['win'] for r in rs]),3),'market':round(mean([r['fair'] for r in rs]),3),'excess_vs_fair':round(mean(ex),3),'excessCI':boot(ex)}
out['value_selection']={'candidates':len(C),**{f'edge>=4&EV>=5 by {pk}':srow(sel(C,pk)) for pk in ('prod','k8','v1')}}
both=[r for r in C if r['k8'] is not None and r in sel(C,'prod') and r in sel(C,'v1')]
out['value_selection']['both prod and v1']=srow(both); out['value_selection']['prod only']=srow([r for r in sel(C,'prod') if r not in sel(C,'v1')]); out['value_selection']['v1 only']=srow([r for r in sel(C,'v1') if r not in sel(C,'prod')])
def fit_c(rs,pk):
    d=[(lg(r[pk])-lg(r['fair']),lg(r['fair']),r['win']) for r in rs]; c=0.0
    for _ in range(50):
        g=sum((y-sg(f+c*x))*x for x,f,y in d); hh=sum(sg(f+c*x)*(1-sg(f+c*x))*x*x for x,f,y in d)
        if hh<1e-9: break
        st=g/hh; c+=st
        if abs(st)<1e-8: break
    return c
def tilt(rs,pk):
    c=fit_c(rs,pk); bs=sorted(fit_c([random.choice(rs) for _ in rs],pk) for _ in range(300)); return {'n':len(rs),'c':round(c,3),'ci95':[round(bs[7],3),round(bs[292],3)]}
out['value_selection']['tilt_c']={pk:tilt(C,pk) for pk in ('prod','v1')}
json.dump(out,open(OUT,'w'),indent=1)
for k in ('all','A','B','B_first_half','B_second_half','games<10','games>=10','no_NEW_TEAM_no_LOW_DEPTH'):
    o=out[k]; print('==',k,o['n'],o['logloss']); print('   ',{x:o['paired'][x] for x in ('v1_vs_k0','v1_vs_k8','v1_vs_ch')})
print(out['monthly_v1_minus_k8'],out['months_v1_beats_k8']); print(out['information_lag_sensitivity_logloss'])
for k in ('market_B','market_B_with_k8','market_B_first_half','market_B_second_half'): print('==',k,json.dumps(out[k]))
print(json.dumps(out['information_beyond_market'])); print(json.dumps(out['value_selection'],indent=0))
