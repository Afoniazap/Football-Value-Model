import json,math,sys,random
R=json.load(open(sys.argv[1])); OUT=sys.argv[2]; random.seed(4)
K=['home','draw','away']; mean=lambda x:sum(x)/len(x)
act=lambda r:'home' if r['hg']>r['ag'] else 'away' if r['ag']>r['hg'] else 'draw'
ll=lambda p,a:-math.log(max(1e-12,p[a]))
def boot(xs,n=3000):
    b=sorted(mean([random.choice(xs) for _ in xs]) for _ in range(n)); return [round(b[int(.025*n)],4),round(b[int(.975*n)],4)]
V=[k for k in R[0] if k.startswith('V')]
out={'n':len(R)}
for seg,f in (('all',lambda r:True),('A_2026H1',lambda r:'2026-01-01'<=r['kick']<'2026-07-01'),('B_2026-27',lambda r:r['kick']>='2026-08-01'),('early_games4-8',lambda r:r['g']<8)):
    rs=[r for r in R if f(r)]; o={'n':len(rs),'actual':{k:round(mean([1 if act(r)==k else 0 for r in rs]),3) for k in K},'goals':{'home':round(mean([r['hg'] for r in rs]),3),'away':round(mean([r['ag'] for r in rs]),3)}}
    base=[ll(r['V0_original']['cons'],act(r)) for r in rs]
    for v in V:
        L_ts=[ll(r[v]['ts'],act(r)) for r in rs]; L_c=[ll(r[v]['cons'],act(r)) for r in rs]
        d=[a-b for a,b in zip(L_c,base)]
        o[v]={'lambda':{'home':round(mean([r[v]['lam']['home'] for r in rs]),3),'away':round(mean([r[v]['lam']['away'] for r in rs]),3)},
              'TS_meanProb':{k:round(mean([r[v]['ts'][k] for r in rs]),3) for k in K},'TS_logloss':round(mean(L_ts),4),
              'Production_consensus_meanProb':{k:round(mean([r[v]['cons'][k] for r in rs]),3) for k in K},'Production_consensus_logloss':round(mean(L_c),4),'vs_original_production':{'mean':round(mean(d),4),'ci95':boot(d)}}
    out[seg]=o
json.dump(out,open(OUT,'w'),indent=1)
for seg in ('all','A_2026H1','B_2026-27','early_games4-8'):
    print('==',seg,out[seg]['n'],out[seg]['actual'],out[seg]['goals'])
    for v in V: x=out[seg][v]; print('  ',v.ljust(30),'lam',x['lambda'],'TS LL',x['TS_logloss'],'Prod LL',x['Production_consensus_logloss'],'vsOrig',x['vs_original_production'],x['Production_consensus_meanProb'])
