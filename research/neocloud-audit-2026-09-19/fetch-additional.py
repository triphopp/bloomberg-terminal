import os,sys,json,requests,concurrent.futures
from pathlib import Path
root=Path(os.environ['TEMP'])/'codex-neocloud-audit-20260919';sys.path.insert(0,str(root/'pydeps'))
import pymupdf
urls={'DUG26':'https://dug.com/wp-content/uploads/2026/08/260827_DUG_FY26_Consolidated_Annual_Report_ASX.pdf','DUG25':'https://dug.com/wp-content/uploads/2025/08/DUG_Annual_Report_FY25_ASX.pdf'}
def f(kv):
 k,u=kv
 r=requests.get(u,timeout=60);r.raise_for_status();(root/(k+'.pdf')).write_bytes(r.content);d=pymupdf.open(stream=r.content,filetype='pdf');t='\n'.join(f'\n--- PDF PAGE {i+1} ---\n'+p.get_text(sort=True) for i,p in enumerate(d));(root/(k+'.txt')).write_text(t,encoding='utf-8');return k,len(t)
print(list(concurrent.futures.ThreadPoolExecutor(2).map(f,urls.items())))
for k,c in {'SIFY':1094324,'MOVE':1734750,'BSAI':1416090,'AKAM':1086222,'KC':1795589}.items():
 for typ,url in [('facts',f'https://data.sec.gov/api/xbrl/companyfacts/CIK{c:010}.json'),('submissions',f'https://data.sec.gov/submissions/CIK{c:010}.json')]:
  r=requests.get(url,headers={'User-Agent':'FinancialStatementReview/1.0 (research assistant)'},timeout=40)
  if r.status_code==200:(root/(k+'-'+typ+'.json')).write_bytes(r.content)
  if typ=='submissions' and r.status_code==200:
   a=r.json()['filings']['recent'];print(k,[{x:a[x][i] for x in ['accessionNumber','primaryDocument','form','reportDate']} for i,v in enumerate(a['form']) if v in ['20-F','10-K','10-K/A']][:3])

