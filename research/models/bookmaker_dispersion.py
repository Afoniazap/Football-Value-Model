# Research only. Model-free test: do price differences BETWEEN bookmakers contain exploitable "errors"?
# For every fixture snapshot: consensus no-vig probability from the OTHER bookmakers (leave-one-out), best offered price,
# expected value = p_consensus * best_odds - 1. Realised outcomes come from stored results. No model probability is used.
import json,math,random,sys,collections
D=sys.argv[1]; OUT=sys.argv[2]; random.seed(21)
K=['home','draw','away']; mean=lambda x:sum(x)/len(x) if x else None
snaps=json.load(open(f'{D}/market-cache/snapshots.json'))['snapshots']
def load(p): return [json.loads(l) for l in open(f'{D}/statistics/{p}') if l.strip()]
actual={}
for r in load('dual-shadow.jsonl'):
    if r['type']=='SHADOW_RESULT': actual[str(r['fixtureId'])]=r['actual']
for r in load('predictions.jsonl'):
    if r['type']=='RESULT' and r.get('actual'): actual.setdefault(str(r['fixtureId']),r['actual'])
def novig(h): 
    raw=[1/h['home'],1/h['draw'],1/h['away']]; s=sum(raw); return {k:r/s for k,r in zip(K,raw)}
def boot(xs,n=3000):
    if len(xs)<10: return None
    b=sorted(mean([random.choice(xs) for _ in xs]) for _ in range(n)); return [round(b[int(.025*n)],3),round(b[int(.975*n)],3)]
bets=[]; fx=0; nb=[]
for key,s in snaps.items():
    fid=str(s['fixtureId']); a=actual.get(fid)
    books=[b for b in s['data']['bookmakers'] if b.get('h2h') and all(isinstance(b['h2h'].get(k),(int,float)) and b['h2h'][k]>1 for k in K)]
    if not a or len(books)<5 or s['fetchedAt']>=s['kickoff']: continue
    fx+=1; nb.append(len(books))
    for k in K:
        best=max(books,key=lambda b:b['h2h'][k]); others=[b for b in books if b is not best]
        p=mean([novig(b['h2h'])[k] for b in others]); sharp=[b for b in others if b['name'].lower().startswith('pinnacle')]
        ps=novig(sharp[0]['h2h'])[k] if sharp else None
        o=best['h2h'][k]; ev=p*o-1
        bets.append(dict(fid=fid,k=k,odds=o,ev=ev,ev_sharp=(ps*o-1) if ps else None,win=1 if a==k else 0,profit=(o-1) if a==k else -1,book=best['name'],spread=max(b['h2h'][k] for b in books)-min(b['h2h'][k] for b in books),fetched=s['fetchedAt'],kick=s['kickoff'],p=p))
out={'fixtures':fx,'median_bookmakers':sorted(nb)[len(nb)//2]}
def row(rs):
    if not rs: return {'n':0}
    return {'n':len(rs),'meanExpectedEV':round(mean([r['ev'] for r in rs]),4),'realisedROI':round(mean([r['profit'] for r in rs]),4),'roiCI':boot([r['profit'] for r in rs]),'excess_realised_minus_expected':round(mean([r['profit']-r['ev'] for r in rs]),4),'excessCI':boot([r['profit']-r['ev'] for r in rs]),'hit':round(mean([r['win'] for r in rs]),3),'consensusP':round(mean([r['p'] for r in rs]),3),'avgOdds':round(mean([r['odds'] for r in rs]),2)}
out['all_outcomes_best_price']=row(bets)
for t in (0.0,0.02,0.04,0.06,0.10): out[f'expected_EV>={t}']=row([r for r in bets if r['ev']>=t])
sh=[r for r in bets if r['ev_sharp'] is not None]
out['pinnacle_present_fixtures_outcomes']=len(sh)
for t in (0.0,0.02,0.04): out[f'vs_Pinnacle_EV>={t}']=row([dict(r,ev=r['ev_sharp']) for r in sh if r['ev_sharp']>=t])
# time split: first half vs second half of the chronological sample (independence)
bets.sort(key=lambda r:r['kick']); h=len(bets)//2
for name,part in (('first_half',bets[:h]),('second_half',bets[h:])): out[f'EV>=0.04_{name}']=row([r for r in part if r['ev']>=0.04])
# outcome-type split
for k in K: out[f'EV>=0.04_{k}']=row([r for r in bets if r['k']==k and r['ev']>=0.04])
# which books provide the outlier prices
out['books_offering_EV>=0.04']=dict(collections.Counter(r['book'] for r in bets if r['ev']>=0.04).most_common(8))
json.dump(out,open(OUT,'w'),ensure_ascii=False,indent=1); print(json.dumps(out,ensure_ascii=False,indent=1))
