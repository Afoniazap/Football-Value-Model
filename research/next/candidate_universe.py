# Research only. Candidate-level (VALUE-selection) audit on the 375 fixtures whose best candidate FVM graded itself
# (SNAPSHOT_RESULT), regardless of category. All filters below are pre-specified from the error structure, none tuned on ROI.
import json,math,sys,collections,random
D=sys.argv[1]; OUT=sys.argv[2]; random.seed(77)
def load(p): return [json.loads(l) for l in open(f'{D}/{p}') if l.strip()]
pr=load('statistics/predictions.jsonl')
snap=[r for r in pr if r['type']=='SNAPSHOT']; sres=[r for r in pr if r['type']=='SNAPSHOT_RESULT']
idx=collections.defaultdict(list)
for r in snap: idx[(r['fixtureKey'],r.get('market'),r.get('selection'),r.get('line'))].append(r)
U=[]
for s in sres:
    c=[r for r in idx[(s['fixtureKey'],s['market'],s['selection'],s['line'])] if abs((r.get('odds') or 0)-s['odds'])<1e-9]
    if not c: c=idx[(s['fixtureKey'],s['market'],s['selection'],s['line'])]
    r=min(c,key=lambda r:r['createdAt'])
    U.append(dict(key=s['fixtureKey'],kick=r['kickoff'],made=r['createdAt'],mkt=s['market'],sel=s['selection'],odds=s['odds'],settle=s['settlement'],profit=s['profitLossUnits'],
        mp=r['modelProbability'],fair=r['marketProbability'],edge=r['edge'],ev=r['ev'],conf=r['confidence'],dq=r['dataQuality'],stab=r.get('stability'),fds=r['fds'],cat=r['category'],comp=r['competition'],isFirst=r['isFirstSeen']))
U.sort(key=lambda r:r['kick'])
mean=lambda x:sum(x)/len(x) if x else None
def boot(xs,n=3000):
    if len(xs)<5: return None
    b=sorted(mean([random.choice(xs) for _ in xs]) for _ in range(n)); return [round(b[int(.025*n)],3),round(b[int(.975*n)],3)]
def wil(k,n):
    if not n: return None
    z=1.96;p=k/n;d=1+z*z/n;c=p+z*z/(2*n);h=z*math.sqrt(p*(1-p)/n+z*z/(4*n*n));return [round((c-h)/d,3),round((c+h)/d,3)]
def summ(rs,name=None):
    if not rs: return {'n':0}
    # excess over the market-fair expectation is defined for plain win/lose markets (1X2); other markets use plain ROI
    one=[r for r in rs if r['mkt']=='1X2']
    out={'n':len(rs),'roi':round(mean([r['profit'] for r in rs]),3),'roiCI':boot([r['profit'] for r in rs]),'wins':sum(1 for r in rs if r['settle']=='WIN')}
    if one:
        ex=[r['profit']-(r['fair']*r['odds']-1) for r in one]
        out['n1x2']=len(one);out['hit1x2']=round(mean([1 if r['settle']=='WIN' else 0 for r in one]),3);out['hitCI']=wil(sum(1 for r in one if r['settle']=='WIN'),len(one))
        out['meanModelP']=round(mean([r['mp'] for r in one]),3);out['meanMarketFairP']=round(mean([r['fair'] for r in one]),3)
        out['expectedROI_ifMarketFair']=round(mean([r['fair']*r['odds']-1 for r in one]),3)
        out['excessROI_vs_fair']=round(mean(ex),3);out['excessCI']=boot(ex)
    return out
out={'n_universe':len(U),'period':[U[0]['kick'][:10],U[-1]['kick'][:10]],'categories':dict(collections.Counter(r['cat'] for r in U)),'markets':dict(collections.Counter(r['mkt'] for r in U))}
out['overall']=summ(U); out['overall_1x2_only']=summ([r for r in U if r['mkt']=='1X2'])
out['by_category']={c:summ([r for r in U if r['cat']==c]) for c in ('VALUE','NEAR','NO_BET','WAIT') if any(r['cat']==c for r in U)}
one=[r for r in U if r['mkt']=='1X2']
def bucket(rs,fn,order): 
    g=collections.defaultdict(list)
    for r in rs:
        k=fn(r)
        if k is not None: g[k].append(r)
    return {k:summ(g[k]) for k in order if k in g}
out['1x2_by_edge_pp']=bucket(one,lambda r:'<4' if r['edge']<4 else '4-8' if r['edge']<8 else '8-15' if r['edge']<15 else '15-25' if r['edge']<25 else '25+',['<4','4-8','8-15','15-25','25+'])
out['1x2_by_odds']=bucket(one,lambda r:'<2' if r['odds']<2 else '2-3' if r['odds']<3 else '3-5' if r['odds']<5 else '5+',['<2','2-3','3-5','5+'])
out['1x2_by_selection']=bucket(one,lambda r:r['sel'],['П1','X','П2'])
out['1x2_by_model_prob']=bucket(one,lambda r:'<0.25' if r['mp']<.25 else '0.25-0.4' if r['mp']<.4 else '0.4-0.6' if r['mp']<.6 else '0.6+',['<0.25','0.25-0.4','0.4-0.6','0.6+'])
out['1x2_by_dq']=bucket(one,lambda r:'<60' if r['dq']<60 else '60-70' if r['dq']<70 else '70-80' if r['dq']<80 else '80+',['<60','60-70','70-80','80+'])
out['1x2_by_stability']=bucket(one,lambda r:None if r['stab'] is None else '<30' if r['stab']<30 else '30-60' if r['stab']<60 else '60-80' if r['stab']<80 else '80+',['<30','30-60','60-80','80+'])
out['1x2_by_confidence']=bucket(one,lambda r:'<40' if r['conf']<40 else '40-60' if r['conf']<60 else '60-70' if r['conf']<70 else '70+',['<40','40-60','60-70','70+'])
out['1x2_by_fds']=bucket(one,lambda r:'<40' if r['fds']<40 else '40-60' if r['fds']<60 else '60-80' if r['fds']<80 else '80+',['<40','40-60','60-80','80+'])
lg=collections.Counter(r['comp'] for r in one)
out['1x2_by_league(n>=15)']=bucket(one,lambda r:r['comp'] if lg[r['comp']]>=15 else None,[c for c,_ in lg.most_common()])
# logistic tilt: P(win)=sigmoid(logit(fair)+c*(logit(model)-logit(fair))) ; c=0 market right, c=1 model right
lg_=lambda p:math.log(max(1e-6,p)/max(1e-6,1-p)); sg=lambda z:1/(1+math.exp(-z))
def fit_c(rs):
    d=[(lg_(r['mp'])-lg_(r['fair']),lg_(r['fair']),1 if r['settle']=='WIN' else 0) for r in rs]; c=0.0
    for _ in range(50):
        g=sum((y-sg(f+c*x))*x for x,f,y in d); h=sum(sg(f+c*x)*(1-sg(f+c*x))*x*x for x,f,y in d)
        if h<1e-9: break
        step=g/h; c+=step
        if abs(step)<1e-8: break
    return c
def tilt(rs):
    if len(rs)<30: return {'n':len(rs)}
    c=fit_c(rs); bs=sorted(fit_c([random.choice(rs) for _ in rs]) for _ in range(400))
    return {'n':len(rs),'c':round(c,3),'ci95':[round(bs[10],3),round(bs[389],3)]}
out['model_tilt_c(1X2 candidates)']={'all':tilt(one),'edge>=4':tilt([r for r in one if r['edge']>=4]),'edge>=4&ev>=5':tilt([r for r in one if r['edge']>=4 and r['ev']>=5]),'underdog/draw(fair<0.4)':tilt([r for r in one if r['fair']<0.4]),'favourite(fair>=0.4)':tilt([r for r in one if r['fair']>=0.4])}
n=len(one); thirds=[one[:n//3],one[n//3:2*n//3],one[2*n//3:]]
out['model_tilt_c_by_period']=[tilt(t) for t in thirds]
# ---------- pre-specified filters (VALUE gate recomputed from stored fields) + variants
def gate(r): return r['edge']>=4 and r['ev']>=5 and r['conf']>=70 and r['dq']>=70 and (r['mkt']!='1X2' or (r['stab'] or 0)>=70)
FILTERS={
 'F0 current gate (edge>=4,EV>=5,conf>=70,DQ>=70,stab>=70)':gate,
 'F1 gate + edge<=15pp (cap extreme divergence)':lambda r:gate(r) and r['edge']<=15,
 'F2 gate + odds<=3.5 (no long shots)':lambda r:gate(r) and r['odds']<=3.5,
 'F3 gate + not draw':lambda r:gate(r) and r['sel']!='X',
 'F4 gate + candidate is market favourite or co-favourite (fair>=0.35)':lambda r:gate(r) and r['fair']>=0.35,
 'F5 gate + |model-market|<=10pp':lambda r:gate(r) and abs(r['mp']-r['fair'])<=0.10,
 'F6 relaxed gate (edge>=4,EV>=5 only, no conf/DQ/stab)':lambda r:r['edge']>=4 and r['ev']>=5,
 'F7 relaxed gate + edge<=15pp':lambda r:r['edge']>=4 and r['ev']>=5 and r['edge']<=15,
}
fl={}
for name,f in FILTERS.items():
    sel=[r for r in one if f(r)]
    if not sel: fl[name]={'n':0}; continue
    s=summ(sel); s['periods']=[summ([r for r in t if f(r)]) for t in thirds]
    s['periods']=[{k:p.get(k) for k in ('n','roi','excessROI_vs_fair','hit1x2')} for p in s['periods']]
    fl[name]=s
out['filters_1x2']=fl
out['recorded_VALUE_universe']=[{k:r[k] for k in ('kick','key','sel','odds','mp','fair','edge','ev','conf','dq','stab','fds','settle','profit')} for r in U if r['cat']=='VALUE']
out['gate_vs_recorded_category(1X2 candidates)']={'gate_true_but_not_VALUE':sum(1 for r in one if gate(r) and r['cat']!='VALUE'),'VALUE_but_gate_false':sum(1 for r in one if r['cat']=='VALUE' and not gate(r)),'gate_true':sum(1 for r in one if gate(r)),'VALUE':sum(1 for r in one if r['cat']=='VALUE')}
# composition of candidates: how often is the chosen side an underdog/draw ?
out['candidate_composition_1x2']={'draw_share':round(mean([1 if r['sel']=='X' else 0 for r in one]),3),'fair<0.3_share':round(mean([1 if r['fair']<.3 else 0 for r in one]),3),'median_odds':sorted(r['odds'] for r in one)[len(one)//2],'mean_model_minus_market_pp':round(100*mean([r['mp']-r['fair'] for r in one]),2)}
json.dump(out,open(OUT,'w'),ensure_ascii=False,indent=1)
print('ok',len(U),len(one))
