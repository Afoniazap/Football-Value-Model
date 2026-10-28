import json,math,sys,random
R=json.load(open(sys.argv[1])); OUT=sys.argv[2]; random.seed(12)
K=['home','draw','away']; mean=lambda x:sum(x)/len(x)
act=lambda r:'home' if r['hg']>r['ag'] else 'away' if r['ag']>r['hg'] else 'draw'
ll=lambda p,a:-math.log(max(1e-12,p[a]))
def boot(xs,n=3000):
    b=sorted(mean([random.choice(xs) for _ in xs]) for _ in range(n)); return [round(b[int(.025*n)],4),round(b[int(.975*n)],4)]
ks=['k0','k4','k8','k12','k16','k0_noHF','k8_noHF','k8_HF1.0_0.95']
out={'n':len(R),'default_equals_k0':all(r['default_ts']==r['k0']['ts'] for r in R)}
segs={'all':lambda r:True,'A_2026H1':lambda r:'2026-01-01'<=r['kick']<'2026-07-01','B_2026-27':lambda r:r['kick']>='2026-08-01','B1':lambda r:'2026-08-01'<=r['kick']<'2026-09-20','B2':lambda r:r['kick']>='2026-09-20','games4-8':lambda r:r['g']<8,'games8-15':lambda r:8<=r['g']<15,'games15+':lambda r:r['g']>=15}
for sn,f in segs.items():
    rs=[r for r in R if f(r)]
    if len(rs)<30: continue
    base=[ll(r['k0']['cons'],act(r)) for r in rs]; o={'n':len(rs)}
    for k in ks:
        L=[ll(r[k]['cons'],act(r)) for r in rs]; d=[a-b for a,b in zip(L,base)]
        o[k]={'prod_cons_LL':round(mean(L),4),'vs_k0':{'mean':round(mean(d),4),'ci95':boot(d)},'ts_LL':round(mean([ll(r[k]['ts'],act(r)) for r in rs]),4),'lam':[round(mean([r[k]['lam']['home'] for r in rs]),3),round(mean([r[k]['lam']['away'] for r in rs]),3)],'consMeanProb':{x:round(mean([r[k]['cons'][x] for r in rs]),3) for x in K}}
    ch=[r for r in rs if r.get('challenger')]
    if ch:
        d=[ll(r['challenger'],act(r)) - ll(r['k0']['cons'],act(r)) for r in ch]
        o['challenger_live_code_LL']=round(mean([ll(r['challenger'],act(r)) for r in ch]),4); o['challenger_vs_k0']={'mean':round(mean(d),4),'ci95':boot(d)}
        d8=[ll(r['challenger'],act(r)) - ll(r['k8']['cons'],act(r)) for r in ch]; o['challenger_vs_k8']={'mean':round(mean(d8),4),'ci95':boot(d8)}
    o['actual']={x:round(mean([1 if act(r)==x else 0 for r in rs]),3) for x in K}; o['goals']=[round(mean([r['hg'] for r in rs]),3),round(mean([r['ag'] for r in rs]),3)]
    out[sn]=o
json.dump(out,open(OUT,'w'),indent=1)
print('default==k0:',out['default_equals_k0'])
for sn in out:
    if sn in('n','default_equals_k0'): continue
    o=out[sn]; print('==',sn,o['n'],o['actual'])
    for k in ks: x=o[k]; print('  ',k.ljust(4),'cons',x['prod_cons_LL'],'vs k0',x['vs_k0'],'TS',x['ts_LL'],'lam',x['lam'],x['consMeanProb'])
    print('   challenger',o.get('challenger_live_code_LL'),'vs k0',o.get('challenger_vs_k0'),'vs k8',o.get('challenger_vs_k8'))
