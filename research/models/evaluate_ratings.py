import json,math,sys,random,collections
S=sys.argv[1]; OUT=sys.argv[2]; random.seed(11)
rt=json.load(open(f'{S}/ratings.json')); rep=json.load(open(f'{S}/replay_engine.json'))
K=['home','draw','away']
mean=lambda x:sum(x)/len(x) if x else None
act=lambda m:'home' if m['hg']>m['ag'] else 'away' if m['ag']>m['hg'] else 'draw'
ll=lambda p,a:-math.log(max(1e-12,p[a])); br=lambda p,a:sum((p[k]-(1 if k==a else 0))**2 for k in K)/3
def boot(xs,n=3000):
    b=sorted(mean([random.choice(xs) for _ in xs]) for _ in range(n)); return [round(b[int(.025*n)],4),round(b[int(.975*n)],4)]
R={(r['kick'],r['home'],r['away']):r for r in rep}
E=[]
for m in rt['matches']:
    r=R.get((m['kick'],m['home'],m['away']))
    if not r: continue
    m=dict(m); m['a']=act(m); m['prod']=r['cons']; m['ts']=r['ts']; m['form']=r['form']; m['ch']=r['ch']; m['v2h']=r['v2h']; m['gH']=r['gHome']; m['gA']=r['gAway']; m['nm']=r['nModels']
    if m['ch'] and m['v2h'] and m.get('poisson') and m.get('elo'): E.append(m)
out={'chosen_hyperparameters':rt['chosen'],'elo_chosen':rt['eloChosen'],'n_eval':len(E),'segments':{s:len([m for m in E if m['seg']==s]) for s in 'AB'}}
names=['prod','ch','v2h','poisson','poisson_dc','poisson_split','elo']
def table(rs):
    t={}
    for n in names:
        L=[ll(m[n],m['a']) for m in rs]; B=[br(m[n],m['a']) for m in rs]
        t[n]={'logloss':round(mean(L),4),'brier':round(mean(B),4),'acc':round(mean([1 if max(K,key=lambda k:m[n][k])==m['a'] else 0 for m in rs]),3),
              'meanProb':{k:round(mean([m[n][k] for m in rs]),3) for k in K},'meanTop':round(mean([max(m[n].values()) for m in rs]),3)}
        if n!='prod':
            d=[ll(m[n],m['a'])-ll(m['prod'],m['a']) for m in rs]; t[n]['vs_prod']={'mean':round(mean(d),4),'ci95':boot(d)}
    t['actual']={k:round(mean([1 if m['a']==k else 0 for m in rs]),3) for k in K}
    return t
out['all']=table(E)
for s in 'AB': out[f'seg_{s}']=table([m for m in E if m['seg']==s])
out['early_season_B_games<=10']=table([m for m in E if m['seg']=='B' and min(m['gH'],m['gA'])<=10]) if len([m for m in E if m['seg']=='B' and min(m['gH'],m['gA'])<=10])>30 else None
# calibration of best new model (poisson_dc) by predicted bin and draw quintiles
def cal(n,rs):
    bins=[(0,.15),(.15,.25),(.25,.35),(.35,.5),(.5,.65),(.65,1.01)]
    return {f'{lo}-{hi}':(lambda pts:{'n':len(pts),'pred':round(mean([p for p,_ in pts]),3),'freq':round(mean([y for _,y in pts]),3)})([(m[n][k],1 if m['a']==k else 0) for m in rs for k in K if lo<=m[n][k]<hi]) for lo,hi in bins}
out['calibration']={n:cal(n,E) for n in ('prod','ch','v2h','poisson_dc','elo')}
def dq(n):
    s=sorted(E,key=lambda m:m[n]['draw']); k=len(s); return {f'q{i+1}':{'pred':round(mean([m[n]['draw'] for m in s[i*k//5:(i+1)*k//5]]),3),'freq':round(mean([1 if m['a']=='draw' else 0 for m in s[i*k//5:(i+1)*k//5]]),3)} for i in range(5)}
out['draw_quintiles']={n:dq(n) for n in ('prod','ch','v2h','poisson_dc','elo')}
# rest-days / calendar load: residual of goal difference vs rating model expectation
res=[]
for m in rt['matches']:
    if m.get('lam') and m['rest'][0] is not None and m['rest'][1] is not None and min(m['nH'],m['nA'])>=3:
        res.append(((m['hg']-m['ag'])-(m['lam'][0]-m['lam'][1]), max(-3,min(3,min(m['rest'][0],8)-min(m['rest'][1],8))), 1 if m['rest'][0]<=4 else 0, 1 if m['rest'][1]<=4 else 0))
def ols(x,y):
    mx,my=mean(x),mean(y); sxx=sum((a-mx)**2 for a in x); b=sum((a-mx)*(c-my) for a,c in zip(x,y))/sxx
    return b
def bootb(res_,f,n=1000):
    bs=sorted(f([random.choice(res_) for _ in res_]) for _ in range(n)); return [round(bs[25],3),round(bs[975],3)]
b_rest=ols([r[1] for r in res],[r[0] for r in res])
f=lambda rs:ols([r[1] for r in rs],[r[0] for r in rs])
out['rest_days_effect_on_goal_difference']={'n':len(res),'goal_diff_per_extra_rest_day(home-away,capped)':round(b_rest,4),'ci95':bootb(res,f),'home_short_rest(<=4d)_mean_resid':round(mean([r[0] for r in res if r[2]==1]),3),'n_home_short':sum(r[2] for r in res),'away_short_rest_mean_resid':round(mean([r[0] for r in res if r[3]==1]),3),'n_away_short':sum(r[3] for r in res),'baseline_mean_resid':round(mean([r[0] for r in res]),3)}
# sample support: how much history do ratings have
out['history_support_B']={'median_prior_games_min_side':sorted(min(m['nH'],m['nA']) for m in E if m['seg']=='B')[len([m for m in E if m['seg']=='B'])//2]}
# ---- market subset (427 set): new models vs market on identical matches
ds=[json.loads(l) for l in open(f'{S}/export/fvm-audit-export/data/statistics/dual-shadow.jsonl') if l.strip()]
pred={r['snapshotKey']:r for r in ds if r['type']=='SHADOW_PREDICTION'}; resl={r['snapshotKey']:r for r in ds if r['type']=='SHADOW_RESULT'}
byk={(m['kick'],m['h'],m['a']):m for m in rt['matches']}
MM=[]
for sk,key in rt['dualMap'].items():
    r=resl.get(sk); p=pred.get(sk)
    if not r or not r.get('marketBenchmark') or r['marketBenchmark']['observedAt']>p['kickoff']: continue
    k=tuple(key.split('|')); m=byk.get((k[0],k[1],k[2]))
    if not m or not m.get('poisson_dc') or not m.get('elo') or m['seg']!='B': continue
    MM.append(dict(a=r['actual'],mkt=r['marketBenchmark']['closingNoVig'],prod=p['models']['production']['probability'],ch=p['models']['challenger']['probability'],v2h=p['models']['v2h']['probability'],poisson=m['poisson'],poisson_dc=m['poisson_dc'],poisson_split=m['poisson_split'],elo=m['elo'],nmin=min(m['nH'],m['nA']),kick=p['kickoff']))
out['market_subset']={'n':len(MM)}
msn=['mkt','prod','ch','v2h','poisson','poisson_dc','poisson_split','elo']
for n in msn:
    L=[ll(m[n],m['a']) for m in MM]; out['market_subset'][n]={'logloss':round(mean(L),4),'brier':round(mean([br(m[n],m['a']) for m in MM]),4)}
    if n!='mkt': d=[ll(m[n],m['a'])-ll(m['mkt'],m['a']) for m in MM]; out['market_subset'][n]['vs_market']={'mean':round(mean(d),4),'ci95':boot(d)}
    if n not in('mkt','prod'): d=[ll(m[n],m['a'])-ll(m['prod'],m['a']) for m in MM]; out['market_subset'][n]['vs_prod']={'mean':round(mean(d),4),'ci95':boot(d)}
# information beyond market (pooled outcome logistic)
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
            z=sum(a*b for a,b in zip(w,x[:3]));p=sg(z)
            for i in range(3):
                g[i]+=(x[3]-p)*x[i]
                for j in range(3): H[i][j]+=p*(1-p)*x[i]*x[j]
        s=solve(H,g); w=[a+b for a,b in zip(w,s)]
        if max(abs(v) for v in s)<1e-8: break
    return w
info={}
for n in ('prod','ch','v2h','poisson','poisson_dc','poisson_split','elo'):
    est=fit(MM,n); bs=[fit([random.choice(MM) for _ in MM],n) for _ in range(250)]
    info[n]={'b_market':round(est[1],3),'b_model':round(est[2],3),'b_model_ci95':[round(sorted(b[2] for b in bs)[6],3),round(sorted(b[2] for b in bs)[243],3)]}
out['information_beyond_market']=info
json.dump(out,open(OUT,'w'),ensure_ascii=False,indent=1)
print(json.dumps({k:out[k] for k in ['n_eval','segments','chosen_hyperparameters','elo_chosen']},default=str)[:1500])
for s in ('all','seg_A','seg_B'):
    print('==',s,out[s]['actual'])
    for n in names: 
        v=out[s][n]; print('  ',n.ljust(14),v['logloss'],v['brier'],v['acc'],v['meanProb'],v['meanTop'],v.get('vs_prod'))
print('rest',out['rest_days_effect_on_goal_difference'])
print('market subset',json.dumps(out['market_subset'])); print('info',json.dumps(info))
print(json.dumps(out['draw_quintiles'])); print(json.dumps(out['calibration']['poisson_dc']),json.dumps(out['calibration']['prod']))
