import os,sys,re,requests,concurrent.futures
from pathlib import Path
root=Path(os.environ['TEMP'])/'codex-neocloud-audit-20260919';sys.path.insert(0,str(root/'pydeps'))
import pymupdf
from bs4 import BeautifulSoup
urls={
 'IONOS23':'https://www.ionos-group.com/fileadmin/Publications/Berichte/IONOS_Group_SE_Annual_Report_2023.pdf',
 'DATASECTION25':'https://www.datasection.co.jp/en-financial-report/en-ir-20250515004.pdf',
 'CORZ24A':'https://investors.corescientific.com/sec-filings/all-sec-filings/content/0001628280-26-013232/core-20241231.htm',
 'BTDR25annual':'https://cdn.yahoofinance.com/prod/sec-filings/0001899123/000121390026049770/ea0282628-20f_bitdeer.htm',
 'SIFY26annual':'https://cdn.yahoofinance.com/prod/sec-filings/0001094324/000155485526001437/sify-20260331.htm',
 'DATASECTIONindex':'https://www.datasection.co.jp/en/ir/finance'
}
def f(kv):
 k,u=kv
 try:
  r=requests.get(u,timeout=45);r.raise_for_status()
  if r.content[:4]==b'%PDF':
   (root/(k+'.pdf')).write_bytes(r.content);d=pymupdf.open(stream=r.content,filetype='pdf');t='\n'.join(f'\n--- PDF PAGE {i+1} ---\n'+p.get_text(sort=True) for i,p in enumerate(d))
  else:t=BeautifulSoup(r.content,'html.parser').get_text(' ',strip=True)
  (root/(k+'.txt')).write_text(t,encoding='utf-8');return k,len(t)
 except Exception as e:return k,str(e)
print(list(concurrent.futures.ThreadPoolExecutor(5).map(f,urls.items())))
for k,pat in [('CORZ24A','3. RESTATEMENT'),('IONOS23','Cash flow from operating'),('DATASECTION25','operating activities'),('DUG25','Profit for'),('DUG26','Net cash from operating'),('SIFY26annual','7,176'),('BTDR25annual','operating activities')]:
 p=root/(k+'.txt')
 if not p.exists():continue
 t=p.read_text('utf-8');m=list(re.finditer(re.escape(pat),t,re.I))
 print('\n###',k,pat,len(m))
 for x in (m[-2:] if k=='CORZ24A' else m[:3]):print(t[max(0,x.start()-100):x.start()+3000])
