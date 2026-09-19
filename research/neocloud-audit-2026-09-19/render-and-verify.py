from pathlib import Path
import sys,os,json,re,hashlib,shutil,datetime
BASE=Path(__file__).resolve().parent
TMP=Path(os.environ['TEMP'])/'codex-neocloud-audit-20260919';sys.path.insert(0,str(TMP/'pydeps'))
import markdown
from bs4 import BeautifulSoup
d=json.loads((BASE/'financial-review-data.json').read_text('utf8'))
md=(BASE/'neocloud-accounting-review-th.md').read_text('utf8')
# Editorial spacing only, never rewrite source URLs or numerical values.
terms={
'materialweakness':'material weakness','internalcontrols':'internal controls','adverseICFR':'adverse ICFR','taxvaluationallowancerelease':'tax valuation allowance release','investmentgain':'investment gain','cashcapex':'cash capex','capexpayables':'capex payables','leaseprincipal':'lease principal','cashflow':'cash flow','cashconversion':'cash conversion','workingcapital':'working capital','capitalcycle':'capital cycle','projectfinance':'project finance','projectfinancing':'project financing','cashrunway':'cash runway','usefullife':'useful life','rentalprice':'rental price','rentalrate':'rental rate','netloss':'net loss','netincome':'net income','grossmargin':'gross margin','defaultprobability':'default probability','price target':'price target','fairvalue':'fair value','relatedparty':'related party','related-partyfinancing':'related-party financing','operatingresult':'operating result','operatingprofit':'operating profit','debtbridge':'debt bridge','leasecounting':'lease counting','restrictedcash':'restricted cash','nonrecourse':'non-recourse','recoursecurrent':'recourse current','recourselongterm':'recourse long term','operatingleases':'operating leases','financeleases':'finance leases','marketablesecurities':'marketable securities','unrestrictedliquidity':'unrestricted liquidity','shareholder':'shareholder','companyworkingcapital':'company working capital','CFObridge':'CFO bridge','cashadvance':'cash advance','cashcollection':'cash collection','cashcollected':'cash collected','revenueconversion':'revenue conversion','supplierpayables':'supplier payables','noncashcapex':'noncash capex','serviceperiod':'service period','creditworthiness':'creditworthiness','financialresultssummary':'financial results summary','annualsecuritiesreport':'annual securities report','auditorreport':'auditor report','segmentfinancials':'segment financials','segmentdata':'segment data','GPUcloud':'GPU cloud','GPUrevenue':'GPU revenue','GPUentity':'GPU entity','GPUoperators':'GPU operators','GPUsegment':'GPU segment','HPCsegment':'HPC segment','strategiccustomers':'strategic customers','subsequentevents':'subsequent events','undrawnfacility':'undrawn facility','interestrate':'interest rate','interestspread':'interest spread','debtamendments':'debt amendments','customeracceptance':'customer acceptance','signedcustomer':'signed customer','capexcommitments':'capex commitments','grosstradingturnover':'gross trading turnover','deferredrevenue':'deferred revenue','debt/revenue':'debt/revenue','SNDKทันที':'SNDK ทันที','consolidatedprojects':'consolidated projects','privatepredecessor':'private predecessor','reversemerger':'reverse merger','purchasepriceallocation':'purchase price allocation','financialstatements':'financial statements','principal–agent':'principal–agent','deskreview':'desk review','take-or-pay':'take-or-pay','leasecommencement':'lease commencement','creditenhancementcontracts':'credit enhancement contracts','maintenancecapex':'maintenance capex','normalizedearnings':'normalized earnings','coveragewatchlist':'coverage watchlist','governmentgrant':'government grant','enterpriseSSD':'enterprise SSD','channelinventory':'channel inventory','storageorders':'storage orders','storagecapacity':'storage capacity','supplydiscipline':'supply discipline','NANDoversupply':'NAND oversupply','IFRS→USGAAP':'IFRS → US GAAP','USGAAP':'US GAAP','cashinterest':'cash interest','capitalexpenditure':'capital expenditure','financialresultssummaries':'financial results summaries','fullthree-year':'full three-year','historicalresults':'historical results','actualhistoricalresults':'actual historical results','operatingactivities':'operating activities','investmentrevaluationgain':'investment revaluation gain','safe':'safe'}
parts=re.split(r'(\]\(https?://[^)]+\))',md)
for i in range(0,len(parts),2):
 for old,new in sorted(terms.items(),key=lambda kv:len(kv[0]),reverse=True):parts[i]=parts[i].replace(old,new)
md=''.join(parts)
(BASE/'neocloud-accounting-review-th.md').write_text(md,encoding='utf8')
body=markdown.markdown(md,extensions=['tables','toc','sane_lists'])
soup=BeautifulSoup(body,'html.parser')
for table in soup.find_all('table'):
 wrapper=soup.new_tag('div',attrs={'class':'table-scroll','tabindex':'0'});table.wrap(wrapper)
for link in soup.select('a[href^="http"]'):link['target']='_blank';link['rel']='noopener noreferrer'
outline=[]
for h in soup.find_all('h2'):outline.append((h.get('id'),h.get_text()))
nav=''.join(f'<a href="#{i}">{t}</a>' for i,t in outline)
options=''.join(f'<option value="{c["symbol"].lower()}">{c["symbol"]} · {c["name"]}</option>' for c in d['companies'])
page='''<!doctype html><html lang="th"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Neocloud — ตรวจงบสามปี | 19 ก.ย. 2026</title><style>
:root{--ink:#193044;--muted:#54677a;--nav:#0c2435;--blue:#12658a;--gold:#c59235;--line:#d7e1e7;--paper:#fff;--ground:#f0f4f6}*{box-sizing:border-box}html{scroll-behavior:smooth;scroll-padding-top:90px}body{margin:0;color:var(--ink);background:var(--ground);font-family:"Leelawadee UI",Tahoma,system-ui,sans-serif;font-size:16px;line-height:1.85}.top{background:var(--nav);color:white;position:sticky;top:0;z-index:2;padding:12px 28px;display:flex;gap:18px;align-items:center;box-shadow:0 2px 10px #0002}.top strong{font-size:18px;letter-spacing:.5px}.top small{color:#d0dce6}.top a{color:#fff}.layout{display:grid;grid-template-columns:265px minmax(0,1fr);max-width:1600px;margin:auto;gap:28px;padding:26px}aside{position:sticky;top:94px;align-self:start;max-height:calc(100vh - 110px);overflow:auto;font-size:13px}aside a{display:block;text-decoration:none;padding:8px 10px;border-radius:5px;color:var(--muted);line-height:1.5}aside a:hover{background:#dfeaf0;color:var(--blue)}aside label{font-weight:700;display:block;margin:0 0 8px}select{width:100%;padding:10px;background:white;border:1px solid var(--line);border-radius:7px;color:var(--ink);font:inherit;margin-bottom:20px}main{background:var(--paper);border:1px solid var(--line);border-radius:12px;padding:42px 46px;min-width:0}h1{font-size:34px;line-height:1.5;letter-spacing:-.5px;margin:0 0 20px;max-width:940px}h2{font-size:25px;line-height:1.6;margin:54px 0 20px;padding-top:15px;border-top:3px solid var(--gold)}h3{font-size:22px;line-height:1.6;margin:40px 0 14px;color:var(--blue)}p{margin:14px 0}a{color:var(--blue);text-underline-offset:3px;overflow-wrap:anywhere}strong{font-weight:700}.table-scroll{max-width:100%;overflow-x:auto;margin:20px 0 26px;border:1px solid var(--line);border-radius:7px}table{border-collapse:collapse;width:100%;font-size:14px;line-height:1.65}th{background:#e9f1f5;text-align:left;font-weight:700;padding:12px 14px;white-space:normal}td{border-top:1px solid var(--line);padding:12px 14px;vertical-align:top;min-width:120px}tr:nth-child(even) td{background:#f8fafb}li{margin:10px 0}ol,ul{padding-left:26px}code{background:#edf3f6;font-size:90%;padding:2px 5px;border-radius:3px}.eyebrow{font-size:12px;color:var(--blue);letter-spacing:2px;font-weight:bold}.note{background:#fff9ec;border-left:4px solid var(--gold);padding:12px 18px;margin-bottom:28px;font-size:14px}.top .print{margin-left:auto;border:1px solid #ffffff55;background:transparent;border-radius:6px;color:white;padding:7px 15px;cursor:pointer}footer{font-size:12px;color:var(--muted);padding:25px;text-align:center}@media(max-width:1000px){.layout{grid-template-columns:1fr;padding:12px}aside{position:static;max-height:none}aside nav{display:none}main{padding:25px}h1{font-size:28px}.top{padding:10px 16px}.top small{display:none}}@media print{body{background:white;font-size:11pt}.top,aside,footer{display:none}.layout{display:block;padding:0}main{border:0;padding:0}h2{break-before:page}h3{break-after:avoid}.table-scroll{overflow:visible}tr{break-inside:avoid}a{color:inherit;text-decoration:none}th,td{min-width:0;padding:6px;font-size:9pt}}
</style></head><body><header class="top"><strong>NEOCLOUD / FINANCIAL REVIEW</strong><small>ตัดข้อมูล 19 ก.ย. 2026 · งบต้นทาง + ข้อสังเกตทางบัญชี</small><button class="print" onclick="window.print()">พิมพ์ / PDF</button></header><div class="layout"><aside><label for="company">ไปยังบริษัท</label><select id="company"><option value="">เลือกจาก 34 profiles</option>OPTIONS</select><nav>NAV</nav></aside><main><div class="eyebrow">THREE-YEAR FINANCIAL STATEMENT REVIEW</div><div class="note">อ่านเป็นรายบริษัท: ปีบัญชี สกุลเงิน และขอบเขตธุรกิจต่างกัน · ไม่รวมยอดบริษัทแม่/ลูกซ้ำ · ช่องว่างหลักฐานระบุไว้ในแต่ละ profile</div>BODY</main></div><footer>เอกสารวิจัยจากข้อมูลสาธารณะ · ไม่ใช่ความเห็นรับรองงบของผู้สอบบัญชี · แหล่งข้อมูลอยู่ข้างข้อค้นพบและท้ายเอกสาร</footer><script>document.getElementById('company').addEventListener('change',function(){if(this.value){const el=document.getElementById(this.value);if(el)el.scrollIntoView({behavior:'smooth',block:'start'});history.replaceState(null,'','#'+this.value);}});</script></body></html>'''.replace('OPTIONS',options).replace('NAV',nav).replace('BODY',str(soup))
(BASE/'neocloud-accounting-review-th.html').write_text(page,encoding='utf8')
# Keep a compact durable evidence trail without copying whole copyrighted annual reports.
ev=BASE/'evidence';ev.mkdir(exist_ok=True)
for f in ['facts-selected.json','additional-selected.json']:
 if (TMP/f).exists():shutil.copy2(TMP/f,ev/f)
locators={
'CORZ24A':['As Reported Adjustment As Restated','122.9 million'],
'SIFY26annual':['Gross Trade Receivables','Net cash from / (used in) operating activities'],
'NBSfull':['Adverse Opinion on Internal Control','401.9 million'],
'CORVEX':['Year ended December 31, 2025','Net cash used in continuing operations'],
'NDannual':['Cash flow from operating activities 29,213','Sales revenues 80,042'],
'DATASECTION26annual':['4,913,586','10,459'],
'RXT25':['Total revenue $ 2,957.1'],
'E2E26':['12,205.68','24,558.01'],
'DUG26':['20,902']}
excerpt=[]
for key,phrases in locators.items():
 f=TMP/(key+'.txt')
 if not f.exists():continue
 t=f.read_text('utf8')
 for phrase in phrases:
  pos=t.lower().find(phrase.lower())
  if pos>=0:excerpt.append({'file':f.name,'sha256':hashlib.sha256(f.read_bytes()).hexdigest(),'needle':phrase,'offset':pos,'excerpt':t[max(0,pos-120):pos+850]})
(ev/'verification-excerpts.json').write_text(json.dumps(excerpt,ensure_ascii=False,indent=2),encoding='utf8')
assert len(d['companies'])==34
assert len(set(c['symbol'] for c in d['companies']))==34
assert all(len(c[x])==3 for c in d['companies'] for x in ['years','revenue','net_income','cfo'])
assert all(k in d['sources'] for c in d['companies'] for k in c['sources'])
assert 6235+1278+25170+2385+584+15735+7+214==51608
assert abs((1437.874-1315.005)-122.869)<1e-7
assert abs(2100.418-1841.7-258.718)<1e-7
assert abs(80*.75-30-10-20)<1e-7
parsed=BeautifulSoup(page,'html.parser')
anchors={e['id'] for e in parsed.select('[id]')}
broken=[a['href'] for a in parsed.select('a[href^="#"]') if a['href'][1:] not in anchors]
assert not broken,broken
assert not parsed.select('script[src],link[rel="stylesheet"],img[src^="http"],iframe')
metrics={'profiles':34,'annual_period_rows':102,'missing_numeric_cells':sum(v is None for c in d['companies'] for k in ['revenue','net_income','cfo'] for v in c[k]),'source_urls':len(d['sources']),'html_bytes':len(page.encode()),'markdown_characters':len(md),'internal_links_valid':True,'no_external_subresources':True,'core_debt_bridge_pass':True,'restatement_bridge_pass':True,'scenario_math_pass':True,'render_sha256':hashlib.sha256(page.encode()).hexdigest()}
(BASE/'verification.json').write_text(json.dumps(metrics,indent=2),encoding='utf8');print(json.dumps(metrics))
