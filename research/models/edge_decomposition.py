# Research only. Where do large Edges come from? Decomposes the Edge of every graded 1X2 candidate into model components.
import json,math,sys,collections,random
D=sys.argv[1]; OUT=sys.argv[2]; random.seed(9)
def load(p): return [json.loads(l) for l in open(f'{D}/statistics/{p}') if l.strip()]
pr=load('predictions.jsonl'); ds=load('dual-shadow.jsonl')
snap=[r for r in pr if r['type']=='SNAPSHOT']; sres=[r for r in pr if r['type']=='SNAPSHOT_RESULT']
idx=collections.defaultdict(list)
for r in snap: idx[(r['fixtureKey'],r.get('market'),r.get('selection'),r.get('line'))].append(r)
dual={}
for r in ds:
    if r['type']=='SHADOW_PREDICTION': dual[r['fixtureId']]=r['models']
KEY={'П1':'home','X':'draw','П2':'away'}
mean=lambda x:sum(x)/len(x) if x else None
def boot(xs,n=2000):
    if len(xs)<5: return None
    b=sorted(mean([random.choice(xs) for _ in xs]) for _ in range(n)); return [round(b[int(.025*n)],3),round(b[int(.975*n)],3)]
U=[]
for s in sres:
    if s['market']!='1X2': continue
    c=[r for r in idx[(s['fixtureKey'],s['market'],s['selection'],s['line'])] if abs((r.get('odds') or 0)-s['odds'])<1e-9] or idx[(s['fixtureKey'],s['market'],s['selection'],s['line'])]
    r=min(c,key=lambda r:r['createdAt']); k=KEY[s['selection']]
    if not r.get('teamStrengthProbability') or not r.get('formProbability'): continue
    w=r.get('consensusWeights') or {}
    U.append(dict(sel=s['selection'],k=k,win=1 if s['settlement']=='WIN' else 0,profit=s['profitLossUnits'],odds=s['odds'],fair=r['marketProbability'],cons=r['consensusProbability'][k],ts=r['teamStrengthProbability'][k],fm=r['formProbability'][k],
        wts=w.get('teamStrength',0.5),wf=w.get('form',0.5),edge=r['edge'],lamh=r.get('lambdaHome'),lama=r.get('lambdaAway'),dq=r['dataQuality'],stab=r.get('stability'),agree=r.get('modelAgreement'),
        src=r.get('baselineSource'),fresh=r.get('baselineFreshness'),sample=r.get('baselineSample'),lh=r.get('localHistoryHomeMatches'),la=r.get('localHistoryAwayMatches'),cat=r['category'],flags=r.get('redFlags') or [],
        dual=dual.get(r['fixtureId']),fid=r['fixtureId']))
for u in U:
    u['c_ts']=u['wts']*(u['ts']-u['fair'])*100; u['c_fm']=u['wf']*(u['fm']-u['fair'])*100
    clamp=u['lamh'] is not None and (u['lamh']<=0.2501 or u['lamh']>=3.399 or u['lama']<=0.2001 or u['lama']>=3.099)
    u['clamped']=clamp
out={'n':len(U)}
big=[u for u in U if u['edge']>=15]; small=[u for u in U if 4<=u['edge']<15]; low=[u for u in U if u['edge']<4]
def grp(rs):
    if not rs: return {'n':0}
    ex=[u['profit']-(u['fair']*u['odds']-1) for u in rs]
    return {'n':len(rs),'meanEdge':round(mean([u['edge'] for u in rs]),1),'meanMarket':round(mean([u['fair'] for u in rs]),3),'meanProduction':round(mean([u['cons'] for u in rs]),3),'meanTeamStrength':round(mean([u['ts'] for u in rs]),3),'meanForm':round(mean([u['fm'] for u in rs]),3),
        'edge_from_TeamStrength_pp':round(mean([u['c_ts'] for u in rs]),1),'edge_from_Form_pp':round(mean([u['c_fm'] for u in rs]),1),'TS_above_Form_share':round(mean([1 if u['ts']>u['fm'] else 0 for u in rs]),2),
        'lambda_at_clamp_share':round(mean([1 if u['clamped'] else 0 for u in rs]),2),'prev_season_baseline_share':round(mean([1 if (u['src'] or '').startswith('PREVIOUS') else 0 for u in rs]),2),
        'meanDQ':round(mean([u['dq'] for u in rs]),1),'meanStability':round(mean([u['stab'] for u in rs if u['stab'] is not None]),1),'meanAgreement':round(mean([u['agree'] for u in rs if u['agree'] is not None]),1),
        'selection':dict(collections.Counter(u['sel'] for u in rs)),'hit':round(mean([u['win'] for u in rs]),3),'excess_vs_fair':round(mean(ex),3),'excessCI':boot(ex)}
out['edge>=15']=grp(big); out['edge4-15']=grp(small); out['edge<4']=grp(low)
# which flag text is attached to big edges
fl=collections.Counter(f for u in big for f in u['flags']); out['edge>=15_red_flags']=dict(fl.most_common(8))
# do the other models also see the edge? (dual-shadow has Challenger and V2H on the same fixture)
def other(u,name): 
    d=u['dual']; return d[name]['probability'][u['k']] if d and d.get(name) and d[name].get('probability') else None
S=[u for u in U if u['dual']]
for u in S:
    u['ch']=other(u,'challenger'); u['v2']=other(u,'v2h'); u['ch_edge']=(u['ch']-u['fair'])*100 if u['ch'] is not None else None; u['v2_edge']=(u['v2']-u['fair'])*100 if u['v2'] is not None else None
S=[u for u in S if u['ch'] is not None and u['v2'] is not None]
out['n_with_all_models']=len(S)
def lab(u): 
    n=(1 if u['edge']>=4 else 0)+(1 if u['ch_edge']>=4 else 0)+(1 if u['v2_edge']>=4 else 0); return n
agree=collections.defaultdict(list)
for u in S: agree[lab(u)].append(u)
out['models_seeing_edge>=4pp(of 3: Production,Challenger,V2H)']={str(k):{'n':len(v),'meanProductionEdge':round(mean([u['edge'] for u in v]),1),'meanChallengerEdge':round(mean([u['ch_edge'] for u in v]),1),'meanV2HEdge':round(mean([u['v2_edge'] for u in v]),1),'hit':round(mean([u['win'] for u in v]),3),'market':round(mean([u['fair'] for u in v]),3),'excess_vs_fair':round(mean([u['profit']-(u['fair']*u['odds']-1) for u in v]),3),'excessCI':boot([u['profit']-(u['fair']*u['odds']-1) for u in v])} for k,v in sorted(agree.items())}
bg=[u for u in S if u['edge']>=15]
out['edge>=15_other_models']={'n':len(bg),'meanProductionEdge':round(mean([u['edge'] for u in bg]),1),'meanChallengerEdge':round(mean([u['ch_edge'] for u in bg]),1),'meanV2HEdge':round(mean([u['v2_edge'] for u in bg]),1),'share_challenger_edge_below_4':round(mean([1 if u['ch_edge']<4 else 0 for u in bg]),2),'share_v2h_edge_below_4':round(mean([1 if u['v2_edge']<4 else 0 for u in bg]),2)}
# component-level calibration: which sub-model is closer to truth on the SAME candidates (selected outcome)
def cal(key): 
    return {'meanPred':round(mean([u[key] for u in U]),3),'freq':round(mean([u['win'] for u in U]),3),'logloss(selected outcome)':round(mean([-math.log(max(1e-9,u[key] if u['win'] else 1-u[key])) for u in U]),4)}
out['selected_outcome_calibration']={'market':cal('fair'),'team_strength':cal('ts'),'form':cal('fm'),'production':cal('cons')}
# relationship: correlation of edge with TS component vs Form component
def corr(a,b):
    ma,mb=mean(a),mean(b); sa=math.sqrt(mean([(x-ma)**2 for x in a])); sb=math.sqrt(mean([(x-mb)**2 for x in b])); return round(mean([(x-ma)*(y-mb) for x,y in zip(a,b)])/(sa*sb),3)
out['corr(edge, TS component)']=corr([u['edge'] for u in U],[u['c_ts'] for u in U]); out['corr(edge, Form component)']=corr([u['edge'] for u in U],[u['c_fm'] for u in U])
# filters vs components: the VALUE gate uses agreement/stability; do big edges pass it?
out['big_edge_gate_pass']={'stab>=70':round(mean([1 if (u['stab'] or 0)>=70 else 0 for u in big]),2),'dq>=70':round(mean([1 if u['dq']>=70 else 0 for u in big]),2),'category':dict(collections.Counter(u['cat'] for u in big))}
json.dump(out,open(OUT,'w'),ensure_ascii=False,indent=1)
print(json.dumps(out,ensure_ascii=False,indent=1))
