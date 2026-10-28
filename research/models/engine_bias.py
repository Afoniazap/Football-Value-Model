import json,math,sys,collections
R=json.load(open(sys.argv[1])); OUT=sys.argv[2]
K=['home','draw','away']
def act(r): return 'home' if r['hg']>r['ag'] else 'away' if r['ag']>r['hg'] else 'draw'
mean=lambda x:sum(x)/len(x) if x else None
ll=lambda p,a:-math.log(max(1e-12,p[a])); br=lambda p,a:sum((p[k]-(1 if k==a else 0))**2 for k in K)/3
def seg(r): return 'A:2026H1' if '2026-01-01'<=r['kick']<'2026-07-01' else 'B:2026-27' if r['kick']>='2026-08-01' else 'burn:2025H2'
for r in R: r['a']=act(r); r['seg']=seg(r)
# league-season-to-date base-rate model as naive baseline: use running frequencies from prior matches of the league
base=collections.defaultdict(lambda:[0,0,0,0]); 
for r in sorted(R,key=lambda r:r['kick']):
    c=base[r['code']]; n=c[3]
    r['naive']={'home':(c[0]+1)/(n+3),'draw':(c[1]+1)/(n+3),'away':(c[2]+1)/(n+3)}
    c[['home','draw','away'].index(r['a'])]+=1; c[3]+=1
models=['ts','form','cons','ch','v2h','naive']
def ok(r,m): return r.get(m) is not None
out={'n':len(R),'segments':dict(collections.Counter(r['seg'] for r in R))}
def block(rs):
    b={}
    b['actual_rates']={k:round(mean([1 if r['a']==k else 0 for r in rs]),3) for k in K}
    b['actual_goals']={'home':round(mean([r['hg'] for r in rs]),3),'away':round(mean([r['ag'] for r in rs]),3)}
    b['team_strength_lambda']={'home':round(mean([r['lam']['home'] for r in rs]),3),'away':round(mean([r['lam']['away'] for r in rs]),3)}
    for m in models:
        s=[r for r in rs if ok(r,m)]
        if not s: continue
        b[m]={'n':len(s),'meanProb':{k:round(mean([r[m][k] for r in s]),3) for k in K},'actual':{k:round(mean([1 if r['a']==k else 0 for r in s]),3) for k in K},
              'logloss':round(mean([ll(r[m],r['a']) for r in s]),4),'brier':round(mean([br(r[m],r['a']) for r in s]),4),'meanTop':round(mean([max(r[m].values()) for r in s]),3),
              'acc':round(mean([1 if max(K,key=lambda k:r[m][k])==r['a'] else 0 for r in s]),3)}
    return b
out['all']=block(R)
for sname in ('burn:2025H2','A:2026H1','B:2026-27'): out[sname]=block([r for r in R if r['seg']==sname])
# games-played dependence for TS lambda extremes and loglik
def gp(r): return min(r['gHome'],r['gAway'])
out['by_games_played']={}
for lo,hi in ((4,8),(8,15),(15,25),(25,60)):
    rs=[r for r in R if lo<=gp(r)<hi]
    if rs: out['by_games_played'][f'{lo}-{hi}']={'n':len(rs),**{m:round(mean([ll(r[m],r['a']) for r in rs if ok(r,m)]),4) for m in ('ts','cons','ch','v2h','naive')},'ts_lambda_clamped_share':round(mean([1 if (r['lam']['home']<=0.2501 or r['lam']['home']>=3.399 or r['lam']['away']<=0.2001 or r['lam']['away']>=3.099) else 0 for r in rs]),3),'ts_mean_top':round(mean([max(r['ts'].values()) for r in rs]),3),'ts_actual_hit_top':round(mean([1 if max(K,key=lambda k:r['ts'][k])==r['a'] else 0 for r in rs]),3)}
# calibration by predicted prob bins, per outcome pooled, per model
bins=[(0,.1),(.1,.2),(.2,.3),(.3,.4),(.4,.5),(.5,.6),(.6,.75),(.75,1.01)]
cal={}
for m in ('ts','form','cons','ch','v2h'):
    cal[m]={}
    for lo,hi in bins:
        pts=[(r[m][k],1 if r['a']==k else 0,k) for r in R if ok(r,m) for k in K if lo<=r[m][k]<hi]
        if pts: cal[m][f'{lo}-{hi}']={'n':len(pts),'pred':round(mean([p for p,_,_ in pts]),3),'freq':round(mean([y for _,y,_ in pts]),3),'draw_share':round(mean([1 if k=='draw' else 0 for _,_,k in pts]),2)}
out['calibration_pooled_outcomes']=cal
# draw: predicted vs actual by predicted-draw decile (cons) and by |strength gap|
dr=[]
for m in ('ts','cons','ch','v2h'):
    s=sorted([r for r in R if ok(r,m)],key=lambda r:r[m]['draw']); n=len(s); d={}
    for i in range(5):
        c=s[i*n//5:(i+1)*n//5]; d[f'q{i+1}']={'pred':round(mean([r[m]['draw'] for r in c]),3),'freq':round(mean([1 if r['a']=='draw' else 0 for r in c]),3)}
    dr.append((m,d))
out['draw_quintiles']=dict(dr)
# favourite / underdog: model's favourite vs its prob and hit; underdog prob
fv={}
for m in ('ts','cons','ch','v2h'):
    s=[r for r in R if ok(r,m)]
    fv[m]={'fav_pred':round(mean([max(r[m].values()) for r in s]),3),'fav_hit':round(mean([1 if max(K,key=lambda k:r[m][k])==r['a'] else 0 for r in s]),3),
           'underdog_side_pred':round(mean([min(r[m]['home'],r[m]['away']) for r in s]),3),'underdog_side_freq':round(mean([1 if r['a']==('home' if r[m]['home']<r[m]['away'] else 'away') else 0 for r in s]),3)}
out['favourite_underdog']=fv
# home-advantage double counting test: mean lambdas vs mean goals overall and within league-season prior
out['lambda_vs_goals_by_league']={c:{'n':len(rs),'lam_home':round(mean([r['lam']['home'] for r in rs]),3),'goals_home':round(mean([r['hg'] for r in rs]),3),'lam_away':round(mean([r['lam']['away'] for r in rs]),3),'goals_away':round(mean([r['ag'] for r in rs]),3)} for c in sorted(set(r['code'] for r in R)) for rs in [[r for r in R if r['code']==c]]}
# one model only vs two-model consensus
out['consensus_models']={str(k):({'n':len(s),'logloss':round(mean([ll(r['cons'],r['a']) for r in s]),4),'meanTop':round(mean([max(r['cons'].values()) for r in s]),3)} if s else {'n':0}) for k in (1,2) for s in [[r for r in R if r['nModels']==k]]}
json.dump(out,open(OUT,'w'),ensure_ascii=False,indent=1)
for s in ('all','burn:2025H2','A:2026H1','B:2026-27'):
    b=out[s]; print(s,b['actual_rates'],b['actual_goals'],'TSlam',b['team_strength_lambda'])
    for m in ['naive','ts','form','cons','ch','v2h']:
        if m in b: print('  ',m.ljust(6),b[m]['n'],'LL',b[m]['logloss'],'Br',b[m]['brier'],'acc',b[m]['acc'],'meanProb',b[m]['meanProb'],'top',b[m]['meanTop'])
print(json.dumps(out['by_games_played']));print(json.dumps(out['consensus_models']));print(json.dumps(out['favourite_underdog']))
print(json.dumps(out['draw_quintiles']))
print(json.dumps(out['lambda_vs_goals_by_league']))
