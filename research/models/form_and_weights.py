import json,math,sys,itertools
R=json.load(open(sys.argv[1])); OUT=sys.argv[2]
K=['home','draw','away']; mean=lambda x:sum(x)/len(x)
act=lambda r:'home' if r['hg']>r['ag'] else 'away' if r['ag']>r['hg'] else 'draw'
ll=lambda p,a:-math.log(max(1e-12,p[a]))
for r in R:
    wT=max(55,min(88,round(55+r['g']*1.2))); r['wT']=wT
    v0=r['V0_original']; r['form']={k:((wT+66)*v0['cons'][k]-wT*v0['ts'][k])/66 for k in K}
    r['a']=act(r)
def s_of(f): return (math.log(f['home']/f['away'])-0.25)/2
def form_p(s,a,b,c):
    e=[math.exp(a+s),math.exp(b-c*abs(s)),math.exp(-s)]; t=sum(e); return {'home':e[0]/t,'draw':e[1]/t,'away':e[2]/t}
for r in R: r['s']=s_of(r['form'])
def blend(ts,fm,wt,wf): 
    return {k:(wt*ts[k]+wf*fm[k])/(wt+wf) for k in K}
seg={'A':(lambda r:'2026-01-01'<=r['kick']<'2026-07-01'),'B':(lambda r:r['kick']>='2026-08-01')}
train={'A':(lambda r:r['kick']<'2026-01-01'),'B':(lambda r:r['kick']<'2026-08-01')}
out={}
for sname in 'AB':
    T=[r for r in R if train[sname](r)]; E=[r for r in R if seg[sname](r)]
    best=min(itertools.product([-0.1,0,0.1,0.2,0.3,0.4,0.5],[-0.2,-0.1,0,0.1,0.2],[0.1,0.25,0.5,0.75]),key=lambda p:mean([ll(form_p(r['s'],*p),r['a']) for r in T]))
    o={'train_n':len(T),'test_n':len(E),'form_params(home,draw,drawSlope)':best}
    o['form_original_LL']=round(mean([ll(r['form'],r['a']) for r in E]),4); o['form_refit_LL']=round(mean([ll(form_p(r['s'],*best),r['a']) for r in E]),4)
    o['form_original_meanProb']={k:round(mean([r['form'][k] for r in E]),3) for k in K}; o['form_refit_meanProb']={k:round(mean([form_p(r['s'],*best)[k] for r in E][0:0] or [mean([form_p(r['s'],*best)[k] for r in E])]),3) for k in K}
    o['actual']={k:round(mean([1 if r['a']==k else 0 for r in E]),3) for k in K}
    # consensus variants
    def cons(r,ts_key,form,wmode):
        ts=r[ts_key]['ts']; wt=r['wT'] if wmode=='orig' else wmode
        return blend(ts,form,wt,66)
    for name,tsk in (('TS_original','V0_original'),('TS_fixed(split,shrink8)','V3_split_normalised_shrink8')):
        o[name+'+form_original(orig weights)']=round(mean([ll(cons(r,tsk,r['form'],'orig'),r['a']) for r in E]),4)
        o[name+'+form_refit(orig weights)']=round(mean([ll(cons(r,tsk,form_p(r['s'],*best),'orig'),r['a']) for r in E]),4)
    # weight of TS chosen on TRAIN only (fixed TS fixed + refit form)
    bw=min([0,10,25,50,66,100,150,300],key=lambda w:mean([ll(blend(r['V3_split_normalised_shrink8']['ts'],form_p(r['s'],*best),w,66),r['a']) for r in T]))
    o['TS_weight_chosen_on_train(vs form weight 66)']=bw
    o['TS_fixed+form_refit+train_weight']=round(mean([ll(blend(r['V3_split_normalised_shrink8']['ts'],form_p(r['s'],*best),bw,66),r['a']) for r in E]),4)
    o['form_alone_vs_TSfixed_alone']={'form_refit':o['form_refit_LL'],'TS_fixed':round(mean([ll(r['V3_split_normalised_shrink8']['ts'],r['a']) for r in E]),4)}
    out[sname]=o
json.dump(out,open(OUT,'w'),indent=1); print(json.dumps(out,indent=1))
