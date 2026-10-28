import json,math,sys,random
S=sys.argv[1]; OUT=sys.argv[2]; random.seed(3)
exec(open(sys.argv[3]).read().split("out['market_subset']")[0].split("out={'chosen")[0]) if False else None
K=['home','draw','away']; mean=lambda x:sum(x)/len(x)
rt=json.load(open(f'{S}/ratings.json')); rep={(r['kick'],r['home'],r['away']):r for r in json.load(open(f'{S}/replay_engine.json'))}
ll=lambda p,a:-math.log(max(1e-12,p[a]))
def boot(xs,n=3000):
    b=sorted(mean([random.choice(xs) for _ in xs]) for _ in range(n)); return [round(b[int(.025*n)],4),round(b[int(.975*n)],4)]
def ens(*ps): return {k:mean([p[k] for p in ps]) for k in K}
E=[]
for m in rt['matches']:
    r=rep.get((m['kick'],m['home'],m['away']))
    if not r or not m.get('poisson_dc') or not m.get('elo') or not r['v2h'] or not r['ch']: continue
    a='home' if m['hg']>m['ag'] else 'away' if m['ag']>m['hg'] else 'draw'
    E.append(dict(a=a,seg=m['seg'],prod=r['cons'],v2h=r['v2h'],ch=r['ch'],dc=m['poisson_dc'],elo=m['elo'],ens3=ens(m['poisson_dc'],m['elo'],r['v2h']),ens2=ens(m['poisson_dc'],m['elo'])))
out={'n':len(E)}
for seg in ('A','B','all'):
    rs=[e for e in E if seg=='all' or e['seg']==seg]
    out[seg]={n:round(mean([ll(e[n],e['a']) for e in rs]),4) for n in ('prod','ch','v2h','dc','elo','ens2','ens3')}
    d=[ll(e['ens3'],e['a'])-ll(e['prod'],e['a']) for e in rs]; out[seg]['ens3_vs_prod']={'mean':round(mean(d),4),'ci95':boot(d)}
ds=[json.loads(l) for l in open(f'{S}/export/fvm-audit-export/data/statistics/dual-shadow.jsonl') if l.strip()]
res={r['snapshotKey']:r for r in ds if r['type']=='SHADOW_RESULT'}; pred={r['snapshotKey']:r for r in ds if r['type']=='SHADOW_PREDICTION'}
byk={(m['kick'],m['h'],m['a']):m for m in rt['matches']}
MM=[]
for sk,key in rt['dualMap'].items():
    r=res.get(sk); p=pred.get(sk)
    if not r or not r.get('marketBenchmark') or r['marketBenchmark']['observedAt']>p['kickoff']: continue
    m=byk.get(tuple(key.split('|')))
    if not m or m['seg']!='B' or not m.get('poisson_dc') or not m.get('elo'): continue
    v=p['models']['v2h']['probability']
    MM.append(dict(a=r['actual'],mkt=r['marketBenchmark']['closingNoVig'],ens3=ens(m['poisson_dc'],m['elo'],v),prod=p['models']['production']['probability']))
out['market_n']=len(MM)
for n in ('mkt','prod','ens3'): out[f'market_{n}_LL']=round(mean([ll(e[n],e['a']) for e in MM]),4)
d=[ll(e['ens3'],e['a'])-ll(e['mkt'],e['a']) for e in MM]; out['ens3_vs_market']={'mean':round(mean(d),4),'ci95':boot(d)}
# information beyond market for ensemble (pooled logistic, 2 features)
lg=lambda p:math.log(max(1e-6,p)/max(1e-6,1-p)); sg=lambda z:1/(1+math.exp(-z))
def fit(ms):
    P=[(1.0,lg(m['mkt'][k]),lg(m['ens3'][k]),1 if m['a']==k else 0) for m in ms for k in K]; w=[0,0,0]
    for _ in range(30):
        g=[0]*3;H=[[0]*3 for _ in range(3)]
        for x in P:
            p=sg(sum(a*b for a,b in zip(w,x[:3])))
            for i in range(3):
                g[i]+=(x[3]-p)*x[i]
                for j in range(3): H[i][j]+=p*(1-p)*x[i]*x[j]
        # solve 3x3
        M=[H[i][:]+[g[i]] for i in range(3)]
        for i in range(3):
            pv=max(range(i,3),key=lambda r:abs(M[r][i])); M[i],M[pv]=M[pv],M[i]
            for j in range(i+1,3):
                f=M[j][i]/M[i][i]
                for k in range(i,4): M[j][k]-=f*M[i][k]
        s=[0]*3
        for i in range(2,-1,-1): s[i]=(M[i][3]-sum(M[i][j]*s[j] for j in range(i+1,3)))/M[i][i]
        w=[a+b for a,b in zip(w,s)]
        if max(abs(v) for v in s)<1e-8: break
    return w
est=fit(MM); bs=sorted(fit([random.choice(MM) for _ in MM])[2] for _ in range(250))
out['ens3_info_beyond_market']={'b_market':round(est[1],3),'b_model':round(est[2],3),'ci95':[round(bs[6],3),round(bs[243],3)]}
json.dump(out,open(sys.argv[2],'w'),indent=1); print(json.dumps(out,indent=1))
