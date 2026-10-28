# Research only. Identical-match comparison: Production (k=0), Production with shrinkage k=8 (reconstruction of the Termux option),
# existing Challenger/V2H, rating models, market. Independent periods, monthly stability, VALUE-selection quality.
import json,math,sys,random,collections
S=sys.argv[1]; OUT=sys.argv[2]; random.seed(31)
K=['home','draw','away']; mean=lambda x:sum(x)/len(x) if x else None
ll=lambda p,a:-math.log(max(1e-12,p[a]))
def boot(xs,n=3000):
    if len(xs)<8: return None
    b=sorted(mean([random.choice(xs) for _ in xs]) for _ in range(n)); return [round(b[int(.025*n)],4),round(b[int(.975*n)],4)]
rt=json.load(open(f'{S}/ratings.json')); sv={(r['kick'],r['home'],r['away']):r for r in json.load(open(f'{S}/shrink_variants.json'))}
rp={(r['kick'],r['home'],r['away']):r for r in json.load(open(f'{S}/replay_engine.json'))}
act=lambda m:'home' if m['hg']>m['ag'] else 'away' if m['ag']>m['hg'] else 'draw'
ens=lambda *ps:{k:mean([p[k] for p in ps]) for k in K}
E=[]
for m in rt['matches']:
    key=(m['kick'],m['home'],m['away']); a=sv.get(key); b=rp.get(key)
    if not a or not b or not m.get('poisson_dc') or not m.get('elo') or not b['v2h'] or not a.get('challenger'): continue
    E.append(dict(kick=m['kick'],seg=m['seg'],a=act(m),k0=a['k0']['cons'],k8=a['k8']['cons'],ch=a['challenger'],v2h=b['v2h'],dc=m['poisson_dc'],elo=m['elo'],ens=ens(m['poisson_dc'],m['elo'],b['v2h']),g=a['g'],key=key))
out={'n':len(E)}
names=['k0','k8','ch','v2h','dc','elo','ens']
def block(rs):
    t={n:round(mean([ll(r[n],r['a']) for r in rs]),4) for n in names}
    cmp={}
    for n in ('dc','elo','ens'):
        for base in ('k0','k8','ch'):
            d=[ll(r[n],r['a'])-ll(r[base],r['a']) for r in rs]; cmp[f'{n}_vs_{base}']={'mean':round(mean(d),4),'ci95':boot(d)}
    return {'n':len(rs),'logloss':t,'paired':cmp}
out['all']=block(E)
for s in ('A','B'): out[s]=block([r for r in E if r['seg']==s])
B=[r for r in E if r['seg']=='B']; B.sort(key=lambda r:r['kick'])
out['B_first_half']=block(B[:len(B)//2]); out['B_second_half']=block(B[len(B)//2:])
out['games<10']=block([r for r in E if r['g']<10]); out['games>=10']=block([r for r in E if r['g']>=10])
# monthly stability of ens vs k8 and vs k0
mon=collections.defaultdict(list)
for r in E: mon[r['kick'][:7]].append(r)
out['monthly_ens_minus_k8']={k:{'n':len(v),'mean':round(mean([ll(r['ens'],r['a'])-ll(r['k8'],r['a']) for r in v]),4)} for k,v in sorted(mon.items()) if len(v)>=40}
out['monthly_ens_minus_k0']={k:{'n':len(v),'mean':round(mean([ll(r['ens'],r['a'])-ll(r['k0'],r['a']) for r in v]),4)} for k,v in sorted(mon.items()) if len(v)>=40}
out['periods_where_ens_beats_k8']=sum(1 for v in out['monthly_ens_minus_k8'].values() if v['mean']<0),len(out['monthly_ens_minus_k8'])
# ---------- market comparison on identical matches (live recorded Production/Challenger/V2H + replay k8 + ratings)
ds=[json.loads(l) for l in open(f'{S}/export/fvm-audit-export/data/statistics/dual-shadow.jsonl') if l.strip()]
pred={r['snapshotKey']:r for r in ds if r['type']=='SHADOW_PREDICTION'}; res={r['snapshotKey']:r for r in ds if r['type']=='SHADOW_RESULT'}
byk={(m['kick'],m['h'],m['a']):m for m in rt['matches']}
MM=[]
for sk,key in rt['dualMap'].items():
    r=res.get(sk); p=pred.get(sk)
    if not r or not r.get('marketBenchmark') or r['marketBenchmark']['observedAt']>p['kickoff']: continue
    m=byk.get(tuple(key.split('|')))
    if not m or m['seg']!='B' or not m.get('poisson_dc') or not m.get('elo'): continue
    v=sv.get((m['kick'],m['home'],m['away']))
    MM.append(dict(a=r['actual'],mkt=r['marketBenchmark']['closingNoVig'],live_prod=p['models']['production']['probability'],live_ch=p['models']['challenger']['probability'],live_v2h=p['models']['v2h']['probability'],k8=v['k8']['cons'] if v else None,k0=v['k0']['cons'] if v else None,dc=m['poisson_dc'],elo=m['elo'],ens=ens(m['poisson_dc'],m['elo'],p['models']['v2h']['probability']),kick=p['kickoff']))
def mblock(rs,names2):
    o={'n':len(rs)}
    for n in names2:
        L=[ll(r[n],r['a']) for r in rs]; o[n]={'logloss':round(mean(L),4)}
        if n!='mkt': d=[ll(r[n],r['a'])-ll(r['mkt'],r['a']) for r in rs]; o[n]['vs_market']={'mean':round(mean(d),4),'ci95':boot(d)}
    return o
out['market_all_B']=mblock(MM,['mkt','live_prod','live_ch','live_v2h','dc','elo','ens'])
MK=[r for r in MM if r['k8']]
out['market_B_with_replay_k8']=mblock(MK,['mkt','live_prod','k0','k8','live_ch','live_v2h','dc','elo','ens'])
MM.sort(key=lambda r:r['kick']); h=len(MM)//2
out['market_B_first_half']=mblock(MM[:h],['mkt','live_prod','live_ch','dc','elo','ens']); out['market_B_second_half']=mblock(MM[h:],['mkt','live_prod','live_ch','dc','elo','ens'])
# ---------- VALUE-selection quality using each model's probabilities on the graded 1X2 candidates
pr=[json.loads(l) for l in open(f'{S}/export/fvm-audit-export/data/statistics/predictions.jsonl') if l.strip()]
sn=[r for r in pr if r['type']=='SNAPSHOT']; sres=[r for r in pr if r['type']=='SNAPSHOT_RESULT']
idx=collections.defaultdict(list)
for r in sn: idx[(r['fixtureKey'],r.get('market'),r.get('selection'),r.get('line'))].append(r)
fid2key={}
for sk,key in rt['dualMap'].items():
    p=pred.get(sk)
    if p: fid2key[str(p['fixtureId'])]=tuple(key.split('|'))
KEY={'П1':'home','X':'draw','П2':'away'}
C=[]
for s in sres:
    if s['market']!='1X2': continue
    c=[r for r in idx[(s['fixtureKey'],s['market'],s['selection'],s['line'])] if abs((r.get('odds') or 0)-s['odds'])<1e-9] or idx[(s['fixtureKey'],s['market'],s['selection'],s['line'])]
    r=min(c,key=lambda r:r['createdAt']); k=fid2key.get(str(r['fixtureId']))
    if not k or not r.get('consensusProbability'): continue
    m=byk.get(k)
    if not m or m['seg']!='B' or not m.get('poisson_dc') or not m.get('elo'): continue
    v=sv.get((m['kick'],m['home'],m['away'])); p=pred[[sk for sk,kk in rt['dualMap'].items() if tuple(kk.split('|'))==k][0]]['models']
    side=KEY[s['selection']]; ensP=ens(m['poisson_dc'],m['elo'],p['v2h']['probability'])
    C.append(dict(side=side,odds=s['odds'],fair=r['marketProbability'],win=1 if s['settlement']=='WIN' else 0,profit=s['profitLossUnits'],prod=r['consensusProbability'][side],ens=ensP[side],dc=m['poisson_dc'][side],elo=m['elo'][side],k8=(v['k8']['cons'][side] if v else None),cat=r['category'],edge_prod=r['edge']))
out['value_selection']={'candidates_with_ratings':len(C)}
def sel(rs,pk,thr=4,evthr=5): return [r for r in rs if r[pk] is not None and (r[pk]-r['fair'])*100>=thr and (r[pk]*r['odds']-1)*100>=evthr]
def srow(rs):
    if not rs: return {'n':0}
    ex=[r['profit']-(r['fair']*r['odds']-1) for r in rs]
    return {'n':len(rs),'hit':round(mean([r['win'] for r in rs]),3),'market':round(mean([r['fair'] for r in rs]),3),'excess_vs_fair':round(mean(ex),3),'excessCI':boot(ex)}
for pk in ('prod','k8','ens','dc','elo'):
    out['value_selection'][f'edge>=4&EV>=5 by {pk}']=srow(sel(C,pk))
both=[r for r in C if r['k8'] is not None and (r['prod']-r['fair'])*100>=4 and (r['ens']-r['fair'])*100>=4 and (r['prod']*r['odds']-1)*100>=5 and (r['ens']*r['odds']-1)*100>=5]
out['value_selection']['both Production and ratings-ensemble edge>=4']=srow(both)
prod_only=[r for r in sel(C,'prod') if (r['ens']-r['fair'])*100<4]; ens_only=[r for r in sel(C,'ens') if (r['prod']-r['fair'])*100<4]
out['value_selection']['Production only (ratings do not see edge)']=srow(prod_only); out['value_selection']['ratings only']=srow(ens_only)
lg=lambda p:math.log(max(1e-6,p)/max(1e-6,1-p)); sg=lambda z:1/(1+math.exp(-z))
def fit_c(rs,pk):
    d=[(lg(r[pk])-lg(r['fair']),lg(r['fair']),r['win']) for r in rs]; c=0.0
    for _ in range(50):
        g=sum((y-sg(f+c*x))*x for x,f,y in d); hh=sum(sg(f+c*x)*(1-sg(f+c*x))*x*x for x,f,y in d)
        if hh<1e-9: break
        st=g/hh; c+=st
        if abs(st)<1e-8: break
    return c
def tilt(rs,pk):
    if len(rs)<40: return {'n':len(rs)}
    c=fit_c(rs,pk); bs=sorted(fit_c([random.choice(rs) for _ in rs],pk) for _ in range(300)); return {'n':len(rs),'c':round(c,3),'ci95':[round(bs[7],3),round(bs[292],3)]}
out['value_selection']['model_tilt_c (0=market right, 1=model right)']={pk:tilt(C,pk) for pk in ('prod','ens','dc','elo')}
json.dump(out,open(OUT,'w'),indent=1)
def pr_(t,d): print(t,json.dumps(d))
for k in ('all','A','B','B_first_half','B_second_half','games<10','games>=10'): print('==',k,out[k]['n'],out[k]['logloss']); print('    ens vs k8',out[k]['paired']['ens_vs_k8'],'ens vs k0',out[k]['paired']['ens_vs_k0'],'dc vs k8',out[k]['paired']['dc_vs_k8'],'elo vs k8',out[k]['paired']['elo_vs_k8'])
print(out['monthly_ens_minus_k8']);print(out['periods_where_ens_beats_k8'])
for k in ('market_all_B','market_B_with_replay_k8','market_B_first_half','market_B_second_half'): print('==',k,json.dumps(out[k]))
print(json.dumps(out['value_selection'],indent=1))
