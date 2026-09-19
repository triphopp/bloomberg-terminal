import os,sys,json,requests,concurrent.futures
from pathlib import Path
root=Path(os.environ['TEMP'])/'codex-neocloud-audit-20260919'
sys.path.insert(0,str(root/'pydeps'))
import fitz
from bs4 import BeautifulSoup
urls={
'DHH25':'https://www.dhh.international/wp-content/uploads/2026/04/FBC31122025_EN.pdf',
'DHH24':'https://www.dhh.international/wp-content/uploads/2025/04/FBC31122024_EN.pdf',
'IONOS25':'https://www.ionos-group.com/fileadmin/Publications/Berichte/FY_2025/IONOS_Annual_Report_2025.pdf',
'SAKURA26':'https://www.sakura.ad.jp/corporate/wp-content/uploads/2026/04/260427-ir_1.pdf',
'DATASECTION26':'https://www.datasection.co.jp/en-financial-report/en-ir-20260608001.pdf',
'FPT25':'https://bctn2025.fpt.com/wp-content/uploads/2026/04/Annual-Report-2025.pdf',
'YTL25':'https://www.ytlpowerinternational.com/wp-content/uploads/sites/2/2025/10/YTLPower_AR2025.pdf',
'QING25':'https://static.cninfo.com.cn/finalpage/2026-04-30/1225257030.PDF',
'E2E26':'https://e2e-mainsite-ui.objectstore.e2enetworks.net/Financial_Compliance/Financial_Information/Financial_Results/20252026/Audit_financial_Results_for_the_Financial_year_ended_March_31_03_2026.pdf',
'NBIS25results':'https://assets.nebius.com/assets/04f48f4e-48e9-468e-a428-ef16565c3fb5/Financial%20results_Q4%202025_11022026.pdf',
'CHRN26':'https://ir.chronoscale.com/financials-filings/all-sec-filings/content/0001628280-26-058018/chrn-20260531.htm',
'UCLOUD25':'https://vip.stock.finance.sina.com.cn/corp/view/vCB_AllBulletinDetail.php?id=12394452',
'CAPITAL25':'https://money.finance.sina.com.cn/corp/view/vCB_AllBulletinDetail.php?id=12005520&stockid=300846'}
def fetch(kv):
 k,u=kv
 try:
  r=requests.get(u,timeout=60); r.raise_for_status()
  if r.content.startswith(b'%PDF'):
   (root/(k+'.pdf')).write_bytes(r.content)
   doc=fitz.open(stream=r.content,filetype='pdf')
   t='\n'.join(f'\n--- PDF PAGE {i+1} ---\n'+p.get_text(sort=True) for i,p in enumerate(doc))
  else:
   r.encoding=r.apparent_encoding
   soup=BeautifulSoup(r.text,'html.parser')
   for n in soup(['script','style']): n.decompose()
   t=soup.get_text(' ',strip=True)
  (root/(k+'.txt')).write_text(t,encoding='utf-8')
  return k,len(t)
 except Exception as e:return k,str(e)
print(list(concurrent.futures.ThreadPoolExecutor(5).map(fetch,urls.items())))
(root/'regional-source-urls.json').write_text(json.dumps(urls,indent=2),encoding='utf-8')
for k,u in {'E2E':'https://www.e2enetworks.com/investors/financial-information','SAKURA':'https://www.sakura.ad.jp/corporate/ir/library/results/','GMO':'https://internet.gmo/ir/library/presentation/','OVH':'https://corporate.ovhcloud.com/en/investor-relations/urd/','NBIS':'https://nebius.com/sec-filings'}.items():
 try:
  s=BeautifulSoup(requests.get(u,timeout=30).content,'html.parser')
  links=[{'text':a.get_text(' ',strip=True),'url':requests.compat.urljoin(u,a['href'])} for a in s.select('a[href]') if any(x in a['href'].lower() for x in ['.pdf','20f','20-f','report','2025','2026'])]
  (root/(k+'-links.json')).write_text(json.dumps(links,ensure_ascii=False,indent=2),encoding='utf-8')
  print(k,links[:35])
 except Exception as e:print(k,str(e))

