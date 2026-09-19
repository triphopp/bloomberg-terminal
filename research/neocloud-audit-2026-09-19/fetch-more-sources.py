import os,sys,json,requests,concurrent.futures,re
from pathlib import Path
root=Path(os.environ['TEMP'])/'codex-neocloud-audit-20260919';sys.path.insert(0,str(root/'pydeps'))
import pymupdf
from bs4 import BeautifulSoup
urls={
'OVH25':'https://corporate.ovhcloud.com/sites/default/files/2025-11/ovh_urd_2025_en_mel_25_11_14.pdf',
'OVH24':'https://corporate.ovhcloud.com/sites/default/files/2024-12/ovh_urd_2024_en_mel_24_12_02_0.pdf',
'KC25':'https://ir.ksyun.com/static-files/47c93910-2590-4dca-992d-ca3a2779fb16',
'AKAM25':'https://www.ir.akamai.com/static-files/984955f9-2334-48f7-9312-5245579ec14d',
'CORZ25':'https://investors.corescientific.com/sec-filings/all-sec-filings/content/0001628280-26-013305/core-20251231.htm',
'BTDR25release':'https://ir.bitdeer.com/news-releases/news-release-details/bitdeer-reports-unaudited-financial-results-fourth-quarter-and-0',
'HUT25release':'https://www.hut8.com/news-insights/press-releases/hut-8-reports-fourth-quarter-and-full-year-2025-results',
'GLXY25release':'https://investor.galaxy.com/news-releases/news-release-details/galaxy-announces-fourth-quarter-and-full-year-2025-financial',
'QING25':'https://vip.stock.finance.sina.com.cn/corp/view/vCB_AllBulletinDetail.php?id=12277316'
}
for k,pattern in [('E2E25','Audit_financial_Results_for_the_Financial_year_ended_March_31_2025'),('SAKURA25','250428-ir_1'),('GMO25','fy2025_full-year_j_financial_report')]:
 base='E2E' if k.startswith('E2E') else 'SAKURA' if k.startswith('SAKURA') else 'GMO'
 arr=json.loads((root/(base+'-links.json')).read_text('utf-8'))
 for a in arr:
  if pattern in a['url']:urls[k]=a['url'];break
def fetch(kv):
 k,u=kv
 if (root/(k+'.txt')).exists():return k,'cached'
 try:
  r=requests.get(u,timeout=55);r.raise_for_status()
  if r.content.startswith(b'%PDF'):
   (root/(k+'.pdf')).write_bytes(r.content);doc=pymupdf.open(stream=r.content,filetype='pdf')
   t='\n'.join(f'\n--- PDF PAGE {i+1} ---\n'+p.get_text(sort=True) for i,p in enumerate(doc))
  else:
   r.encoding=r.apparent_encoding;s=BeautifulSoup(r.text,'html.parser')
   for n in s(['script','style']):n.decompose()
   t=s.get_text(' ',strip=True)
  (root/(k+'.txt')).write_text(t,encoding='utf-8');return k,len(t)
 except Exception as e:return k,str(e)
print(list(concurrent.futures.ThreadPoolExecutor(5).map(fetch,urls.items())))
u=json.loads((root/'regional-source-urls.json').read_text('utf-8'));u.update(urls)
(root/'regional-source-urls.json').write_text(json.dumps(u,indent=2),encoding='utf-8')

