import os,sys,json,datetime
from pathlib import Path
p=Path(os.environ['TEMP'])/'codex-neocloud-audit-20260919'
keys=['RevenueFromContractWithCustomerExcludingAssessedTax','Revenues','Revenue','SalesRevenueNet','NetIncomeLoss','ProfitLoss','NetCashProvidedByUsedInOperatingActivities','CashFlowsFromUsedInOperatingActivities','PaymentsToAcquirePropertyPlantAndEquipment']
out={}
for sym in ['SIFY','MOVE','BSAI','AKAM','KC','HUT']:
 j=json.loads((p/(sym+'-facts.json')).read_text());out[sym]={}
 for ns,fs in j['facts'].items():
  for k in keys:
   if k not in fs:continue
   a=[]
   for unit,vs in fs[k]['units'].items():
    if unit not in ['USD','INR','CNY','RMB']:continue
    for v in vs:
     if v.get('form') not in ['10-K','10-KT','10-K/A','20-F','20-F/A'] or v.get('filed','')>'2026-09-19' or not v.get('start') or v['end']<'2023-01-01':continue
     duration=(datetime.date.fromisoformat(v['end'])-datetime.date.fromisoformat(v['start'])).days
     if duration<300 and not (sym=='HUT' and v['end']=='2023-12-31'):continue
     a.append({**v,'unit':unit,'namespace':ns,'tag':k})
   d={}
   for x in sorted(a,key=lambda x:x['filed']):d[(x['start'],x['end'],x['unit'])]=x
   vals=sorted(d.values(),key=lambda x:x['end'],reverse=True)[:3]
   out[sym][k]=vals
   print(sym,k,[(x['start'],x['end'],x['unit'],round(x['val']/1e6,3)) for x in vals])
(p/'additional-selected.json').write_text(json.dumps(out,indent=2),encoding='utf-8')

