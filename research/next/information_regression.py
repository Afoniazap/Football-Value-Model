# Research only. Does a model carry information BEYOND the market? Pooled-outcome logistic regression
#   P(outcome) = sigmoid(a + b_market*logit(market) + b_model*logit(model))
# b_model > 0 with CI above 0 = information beyond the market; b_market ~ 1 = market well calibrated. Matches are resampled (not outcomes).
import json,math,sys,random
D=sys.argv[1]; OUT=sys.argv[2]; random.seed(5)
K=['home','draw','away']
ds=[json.loads(l) for l in open(f'{D}/statistics/dual-shadow.jsonl') if l.strip()]
pred={r['snapshotKey']:r for r in ds if r['type']=='SHADOW_PREDICTION'}; res={r['snapshotKey']:r for r in ds if r['type']=='SHADOW_RESULT'}
rows=[]
for k,r in res.items():
    p=pred.get(k); mb=r.get('marketBenchmark')
    if p and mb and mb['observedAt']<=p['kickoff']:
        m={n:p['models'][n]['probability'] for n in ('production','challenger','v2h')}; m['ensemble']={c:sum(m[n][c] for n in m)/3 for c in K}
        rows.append(dict(kick=p['kickoff'],a=r['actual'],mkt=mb['closingNoVig'],m=m))
rows.sort(key=lambda r:r['kick'])
lg=lambda p:math.log(max(1e-6,p)/max(1e-6,1-p)); sg=lambda z:1/(1+math.exp(-z))
def pts(rs,name):
    return [(1.0,lg(r['mkt'][k]),lg(r['m'][name][k]),1 if r['a']==k else 0) for r in rs for k in K]
def solve(A,b):
    n=len(b);M=[A[i][:]+[b[i]] for i in range(n)]
    for i in range(n):
        p=max(range(i,n),key=lambda r:abs(M[r][i])); M[i],M[p]=M[p],M[i]
        if abs(M[i][i])<1e-12: return None
        for j in range(i+1,n):
            f=M[j][i]/M[i][i]
            for k in range(i,n+1): M[j][k]-=f*M[i][k]
    x=[0]*n
    for i in range(n-1,-1,-1): x[i]=(M[i][n]-sum(M[i][j]*x[j] for j in range(i+1,n)))/M[i][i]
    return x
def fit(P,feat):
    w=[0.0]*len(feat)
    for _ in range(40):
        g=[0.0]*len(feat);H=[[0.0]*len(feat) for _ in feat]
        for x in P:
            f=[x[i] for i in feat]; z=sum(a*b for a,b in zip(w,f)); p=sg(z); y=x[3]
            for i in range(len(f)):
                g[i]+=(y-p)*f[i]
                for j in range(len(f)): H[i][j]+=p*(1-p)*f[i]*f[j]
        s=solve(H,g)
        if s is None: break
        w=[a+b for a,b in zip(w,s)]
        if max(abs(v) for v in s)<1e-8: break
    return w
def ci(rs,name,feat,B=300):
    est=fit(pts(rs,name),feat); bs=[]
    for _ in range(B):
        sm=[random.choice(rs) for _ in rs]; bs.append(fit(pts(sm,name),feat))
    out=[]
    for i in range(len(feat)):
        v=sorted(b[i] for b in bs); out.append({'est':round(est[i],3),'ci95':[round(v[int(.025*B)],3),round(v[int(.975*B)-1],3)]})
    return out
out={'n_matches':len(rows)}
for name in ('production','challenger','v2h','ensemble'):
    r1=ci(rows,name,[0,1,2]); r2=ci(rows,name,[0,2]); r3=ci(rows,'production' if False else name,[0,1])
    third=len(rows)//3
    per=[]
    for lo,hi in ((0,third),(third,2*third),(2*third,len(rows))):
        e=fit(pts(rows[lo:hi],name),[0,1,2]); per.append({'n':hi-lo,'b_market':round(e[1],3),'b_model':round(e[2],3)})
    out[name]={'market+model':{'intercept':r1[0],'b_market':r1[1],'b_model':r1[2]},'model_alone(calibration slope)':{'intercept':r2[0],'b_model':r2[1]},'by_period':per}
json.dump(out,open(OUT,'w'),indent=1)
print(json.dumps(out,indent=1))
