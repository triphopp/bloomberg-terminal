"""Reproducible Thai desk review. Values are transcribed/checked; null is never zero."""
from pathlib import Path
import json, re, html, os, sys, shutil
BASE=Path(__file__).resolve().parent
TMP=Path(os.environ['TEMP'])/'codex-neocloud-audit-20260919'
sys.path.insert(0,str(TMP/'pydeps'))
manifest=json.loads((BASE/'primary-manifest.json').read_text('utf-8'))
S={k:v['url'] for k,v in manifest.items()}
S.update({
'CRWVQ2':'https://www.sec.gov/Archives/edgar/data/1769628/000176962826000366/crwv-20260630.htm',
'CORZ':'https://investors.corescientific.com/sec-filings/all-sec-filings/content/0001628280-26-013305/core-20251231.htm',
'CORZ24A':'https://investors.corescientific.com/sec-filings/all-sec-filings/content/0001628280-26-013232/core-20241231.htm',
'CORZ8K':'https://investors.corescientific.com/sec-filings/all-sec-filings/content/0001628280-26-013214/core-20260302.htm',
'BTDRmirror':'https://cdn.yahoofinance.com/prod/sec-filings/0001899123/000121390026049770/ea0282628-20f_bitdeer.htm',
'CHRN':'https://ir.chronoscale.com/financials-filings/all-sec-filings/content/0001628280-26-058018/chrn-20260531.htm',
'CHRNpre':'https://ir.chronoscale.com/financials-filings/all-sec-filings/content/0001437749-26-009267/ekso-20251231.htm',
'MOVE':'https://www.sec.gov/Archives/edgar/data/1734750/000121390026036609/ea0278320-10k_corvex.htm',
'MOVE26':'https://www.sec.gov/Archives/edgar/data/1734750/000121390026090115/ea030200401ex99-1.htm',
'MOVEopco':'https://www.sec.gov/Archives/edgar/data/1734750/000121390026050668/ea028834301ex99-2.htm',
'NBISmirror':'https://cdn.yahoofinance.com/prod/sec-filings/0001513845/000110465926052948/nbis-20251231x20f.htm',
'NDannual':'https://www.sec.gov/Archives/edgar/data/1830081/000121390026043611/ea0270012-05.htm',
'RUMdeal':'https://www.sec.gov/Archives/edgar/data/1830081/000121390026095047/ea0303717-8ka1_rumgroup.htm',
'KC':'https://ir.ksyun.com/static-files/47c93910-2590-4dca-992d-ca3a2779fb16',
'SIFY':'https://www.sec.gov/Archives/edgar/data/1094324/000155485526001437/sify-20260331.htm',
'SIFYmirror':'https://cdn.yahoofinance.com/prod/sec-filings/0001094324/000155485526001437/sify-20260331.htm',
'AKAM':'https://www.ir.akamai.com/static-files/984955f9-2334-48f7-9312-5245579ec14d',
'OVH':'https://corporate.ovhcloud.com/sites/default/files/2025-11/ovh_urd_2025_en_mel_25_11_14.pdf',
'OVH24':'https://corporate.ovhcloud.com/sites/default/files/2024-12/ovh_urd_2024_en_mel_24_12_02_0.pdf',
'IONOS':'https://www.ionos-group.com/fileadmin/Publications/Berichte/FY_2025/IONOS_Annual_Report_2025.pdf',
'IONOS23':'https://www.ionos-group.com/fileadmin/Publications/Berichte/IONOS_Group_SE_Annual_Report_2023.pdf',
'DHH':'https://www.dhh.international/wp-content/uploads/2026/04/FBC31122025_EN.pdf',
'DHH24':'https://www.dhh.international/wp-content/uploads/2025/04/FBC31122024_EN.pdf',
'SAKURA':'https://www.sakura.ad.jp/corporate/wp-content/uploads/2026/04/260427-ir_1.pdf',
'SAKURA25':'https://www.sakura.ad.jp/corporate/wp-content/uploads/2025/04/250428-ir_1.pdf',
'GMO':'https://internet.gmo/pdf/presen/gmointernet_fy2025_full-year_j_financial_report.pdf',
'GMO24':'https://internet.gmo/pdf/shareholder/gmointernet_j_stockholders_20250319_01.pdf',
'DATASECTION':'https://www.datasection.co.jp/en-financial-report/en-ir-20260608001.pdf',
'DATASECTION25':'https://www.datasection.co.jp/en-financial-report/en-ir-20250515004.pdf',
'DATASECTION26annual':'https://regfis.com/reports/20260629_S100YMGV_E31131_null_010_030000_120',
'E2E':'https://e2e-mainsite-ui.objectstore.e2enetworks.net/Financial_Compliance/Financial_Information/Financial_Results/20252026/Audit_financial_Results_for_the_Financial_year_ended_March_31_03_2026.pdf',
'E2E25':'https://e2e-mainsite-ui.objectstore.e2enetworks.net/Financial_Compliance/Financial_Information/Financial_Results/20242025/Audit_financial_Results_for_the_Financial_year_ended_March_31_2025_31_03_2025.pdf',
'UCLOUD':'https://vip.stock.finance.sina.com.cn/corp/view/vCB_AllBulletinDetail.php?id=12394452',
'UCLOUDcorrection':'https://money.finance.sina.com.cn/corp/view/vCB_AllBulletinDetail.php?id=12394451&stockid=688158',
'UCLOUDestimate':'https://vip.stock.finance.sina.com.cn/corp/view/vCB_AllBulletinDetail.php?id=11575513&stockid=688158',
'QING':'https://vip.stock.finance.sina.com.cn/corp/view/vCB_AllBulletinDetail.php?id=12277316',
'QINGpdf':'https://static.cninfo.com.cn/finalpage/2026-04-30/1225257030.PDF',
'CAPITAL':'https://money.finance.sina.com.cn/corp/view/vCB_AllBulletinDetail.php?id=12005520&stockid=300846',
'DUG':'https://dug.com/wp-content/uploads/2026/08/260827_DUG_FY26_Consolidated_Annual_Report_ASX.pdf',
'DUG25':'https://dug.com/wp-content/uploads/2025/08/DUG_Annual_Report_FY25_ASX.pdf',
'RXT':'https://ir.rackspace.com/static-files/0dc12411-3dc0-4989-a5f9-4c17aa51cccb',
'RXTdeal':'https://www.rackspace.com/newsroom/amd-and-rackspace-technology-sign-definitive-agreement-phased-deployment',
'FPT':'https://bctn2025.fpt.com/wp-content/uploads/2026/04/Annual-Report-2025.pdf',
'YTL':'https://www.ytlpowerinternational.com/wp-content/uploads/sites/2/2025/10/YTLPower_AR2025.pdf',
'BSAI':'https://www.sec.gov/Archives/edgar/data/1416090/000149315226014362/form10-k.htm',
})
C=[]
def add(symbol,name,market,category,currency,years,rev,ni,cfo,basis,facts,analysis,watch,sourcekeys=None,coverage='สามปี; ตัวเลขรวมกลุ่ม ไม่ใช่ GPU segment ล้วน'):
 C.append(dict(symbol=symbol,name=name,market=market,category=category,currency=currency,years=years,revenue=rev,net_income=ni,cfo=cfo,basis=basis,facts=facts,analysis=analysis,watch=watch,sources=sourcekeys or [symbol],coverage=coverage))
Y=['2023','2024','2025'];J=['FY2024/03','FY2025/03','FY2026/03'];U=['FY2024/06','FY2025/06','FY2026/06']
add('CRWV','CoreWeave','Nasdaq / สหรัฐฯ','GPU cloud','USD',Y,[229,1915,5131],[-594,-863,-1167],[1833,2749,3058],
'US GAAP; กำไรสุทธิรวมกลุ่ม; FY2023–25 ตาม 10-K ล่าสุด',
'FY2025 Microsoft สร้างรายได้ 67%; CFO 3,058 แต่ซื้อ PP&E ด้วยเงินสด 10,309 ล้าน และมี accrued PP&E purchases 5,196 ล้าน ค่าเสื่อมและตัดจำหน่าย 2,454 ล้าน; บริษัทเปิดเผย material weaknesses ของการควบคุมภายใน ณ สิ้นปี 2025. อายุอุปกรณ์ประมวลผลเปลี่ยนจาก 5 เป็น 6 ปีตั้งแต่ต้นปี 2023 ไม่ใช่การเปลี่ยนใหม่ในปี 2026.',
'จุดเปราะคือวงจรจ่ายค่า GPU ก่อนเก็บเงินตลอดสัญญา ลูกค้ารายใหญ่ช่วยให้มีสัญญายาวแต่กระจายความเสี่ยงไม่ได้ ค่าเสื่อมที่ต่ำลงเพิ่มกำไรตามบัญชีโดยไม่ได้ยืดอายุเชิงเศรษฐกิจโดยอัตโนมัติ CFO บวกยังไม่พอทดแทนการลงทุน และ cash capex ไม่รวมอุปกรณ์ที่ค้างจ่ายทั้งหมด.',
'ตรวจอายุ GPU ตามรุ่น การใช้กำลังผลิตจริง การส่งมอบตามสัญญา ลูกหนี้/เงินรับล่วงหน้า และการแก้ material weaknesses. Q2 2026 ต้องแยกหนี้การเงิน 35.068 พันล้านออกจาก leases 16.540 พันล้าน; ยอดรวม 51.608 พันล้านรวม leases แล้ว.', ['CRWV','CRWVQ2'])
add('NBIS','Nebius Group','Nasdaq / เนเธอร์แลนด์','GPU cloud','USD',Y,[9.8,91.5,529.8],[241.3,-641.4,82.5],[829.8,245.6,384.8],
'รายได้ continuing operations; NI ส่วนผู้ถือหุ้นบริษัทแม่; CFO รวมกิจการต่อเนื่องและเลิกดำเนินงาน จึงห้ามหาร CFO/revenue ตรง ๆ',
'หลังขายธุรกิจรัสเซีย ฐานรายได้ปัจจุบันต่างจาก Yandex เดิมอย่างมาก FY2025 CFO continuing operations 401.9 ล้าน เทียบ FY2024 -269.9 ล้าน; CFO ของ discontinued operations -17.1 และ +515.5 ล้านตามลำดับ FY2025 มีผลกำไรจาก revaluation เงินลงทุน 598.9 ล้าน และซื้อ PP&E/สินทรัพย์ไม่มีตัวตน 4,066 ล้าน.',
'กำไรสุทธิรวมไม่ยืนยันว่าเช่า GPU มีกำไร รายได้ที่โตเร็วต้องประเมินคู่กับอุปกรณ์ที่ติดตั้งจริงและแหล่งเงินทุน โดยแยก Toloka/เงินลงทุน/ธุรกิจที่ขายออกจากโครงสร้างใหม่ ประวัติสามปีตามกฎหมายมีอยู่แต่ไม่ใช่สามปีของ GPU cloud ที่มีขนาดใกล้กัน.',
'สร้าง bridge จากกำไร continuing ไป operating profit ของ AI infrastructure; ตรวจรายได้ที่เริ่มรับรู้แล้วกับ ARR เป้าหมายและสัญญาที่รอเปิดใช้งาน. รายงานนี้อ่านงบ XBRL และ FY2025 results; การทบทวน footnotes ของ 20-F เต็มฉบับยังมีช่องว่างการเข้าถึง.', ['NBIS'], 'สามปีบนฐาน continuing revenue; ความเทียบเคียงต่ำและ notes อ่านได้ไม่ครบ')
add('IREN','IREN','Nasdaq / ออสเตรเลีย','GPU cloud + mining','USD',U,[187.192,501.023,707.007],[-28.920,86.941,-702.621],[52.219,245.886,2100.418],
'ใช้ US GAAP comparatives ล่าสุด; ไม่ต่อ CFO ปีเก่าบน IFRS เข้ากับปีใหม่',
'FY2026 CFO ได้แรงหนุนจากเงินรับล่วงหน้า AI 1,841.7 ล้าน ขณะที่ NI ขาดทุน 702.6 ล้าน มี impairment 638.8 ล้าน ค่าเสื่อม/ตัดจำหน่าย 417.7 ล้าน และ derivative gain 558.5 ล้าน. เงินสด 5,895.6 ล้านแยกจาก restricted cash 1,723.9 ล้าน; capital commitments 13,810 ล้าน ณ สิ้นปี.',
'เงินรับล่วงหน้ามีประโยชน์ต่อ financing แต่แลกกับหน้าที่ส่งมอบและเครดิตค่าบริการในอนาคต การลบเงินรับล่วงหน้าจาก CFO เพื่อดู sensitivity ได้ประมาณ258.7ล้าน ไม่ใช่กำไรปรับปรุงหรือ FCF. ขาดทุนส่วนหนึ่งไม่ใช่เงินสด แต่ impairment เป็นหลักฐานว่าการเปลี่ยนธุรกิจทำให้สินทรัพย์เดิมสูญมูลค่า.',
'ตาม acceptance ของโครงการ Horizon ทีละ tranche, สัญญา Microsoft และการเริ่มตัดเครดิตเงินรับล่วงหน้า; ทดสอบ cash runway หลัง committed capex และเงื่อนไข parent guarantee ของเงินกู้ที่เรียก non-recourse.', ['IREN'])
add('HUT','Hut 8','Nasdaq / สหรัฐฯ','โครงสร้างพื้นฐาน + mining','USD',['2023/07–12 (6 เดือน)','2024','2025'],[60.6,162.385,235.118],[6.208,331.882,-226.149],[-19.621,-68.535,-139.226],
'ปี2023เป็นงวดเปลี่ยนรอบ 6 เดือน; revenue2023ปัดตามยอดรวมที่รายงาน; NI ส่วนบริษัทแม่ ไม่ใช่กำไรทั้งกลุ่ม',
'FY2025 รายได้ส่วน Compute 202.3 ล้านยังมี mining เป็นส่วนสำคัญ กลุ่ม Power 23.2 ล้าน และ Digital Infrastructure 9.6 ล้าน; CFO ติดลบทั้งสามงวด คำว่า cash and Bitcoin รวมสินทรัพย์คริปโตและส่วนของ American Bitcoin ซึ่งมีผู้ถือหุ้นภายนอก.',
'ความเสี่ยงอยู่ที่การเปลี่ยนจากผลตอบแทน Bitcoin เป็นค่าเช่า AI ระยะยาวก่อนโครงการเริ่มรับรายได้ อย่าใช้ราคา Bitcoin ณ วันเดียวแทนเงินสดชำระเจ้าหนี้ และอย่าตีการเพิ่มจากงวด6เดือนเป็น organic growth รายปี.',
'ติดตามการปิด project financing จริง เงื่อนไขเบิกเงินและ contribution ของผู้ถือหุ้นโครงการ ก่อนนำวงเงินคาดหมายมาเป็น liquidity. แยกส่วนที่เป็นของ HUT ออกจาก ABTC และไม่บวกงบแม่ลูกซ้ำ.', ['HUT'], 'สองปีเต็ม + งวดเปลี่ยนรอบ6เดือน; ไม่ใช่สามปีเต็ม')
add('WULF','TeraWulf','Nasdaq / สหรัฐฯ','HPC landlord + mining','USD',Y,[69.229,140.051,168.455],[-73.421,-72.418,-661.416],[4.263,-24.422,-123.180],
'US GAAP; NI รวมกลุ่ม; แยกเงินลงทุน JV และ consolidated projects',
'FY2025 ซื้อ PP&E เงินสด 1,060.189 ล้าน ขณะที่ CFO -123.180 ล้าน มี Google warrant liability มูลค่ายุติธรรม 844.698 ล้าน. เงื่อนไข backstop ของ Google เริ่มเมื่อ lease commencement จึงไม่ใช่การค้ำความเสี่ยงก่อสร้างก่อนส่งมอบทั้งหมด.',
'ขาดทุนจำนวนมากอาจเกิดจาก warrant remeasurement โดยไม่มีเงินสดจ่ายทันที แต่การสร้างศูนย์ใช้เงินจริงและมีความเสี่ยงส่งมอบ คำว่ามี Google ค้ำไม่ทำให้โครงการทุกระยะมีคุณภาพเครดิตเท่า Google.',
'ตรวจ milestone ที่ทำให้การค้ำมีผล, delay damages, เงินทุนสำรองก่อสร้าง, warrant dilution และ cash waterfall ของ JV. อย่านำ warrant liability ไปปนกับหนี้ธนาคารที่ต้องชำระดอกเบี้ยคงที่.', ['WULF'])
add('APLD','Applied Digital','Nasdaq / สหรัฐฯ','HPC landlord + บริษัทแม่ GPU cloud','USD',['FY2024/05','FY2025/05','FY2026/05'],[165.575,228.569,611.311],[-149.671,-231.065,-184.339],[13.794,-115.402,89.685],
'รายได้รวมมีรายได้เช่า; NI ทั้งกลุ่มก่อนจัดสรร preferred/NCI จึงต่างจากกำไร common shareholders; cloud กลับเป็น continuing operations',
'วันที่5พ.ค.2026 แยก Cloud เข้า ChronoScale แต่ยังถือหุ้นประมาณ97% จึงยังรวมงบ มี loss จากการกลับวัดธุรกิจ Cloud เป็น held-and-used 59.7 ล้าน. Preferred financing มีสิทธิรับผลตอบแทน/เงินคืนก่อน common equity ซึ่ง headline EBITDA ไม่สะท้อนทั้งหมด.',
'การแยกชื่อหุ้นไม่ใช่การขายความเสี่ยงออกจากงบ และรายได้ ASC606 อย่างเดียวจะต่ำกว่ารายได้รวมที่มี lease income ต้องใช้ comparative ล่าสุดเดียวกันเพื่อไม่สร้างภาพว่าโตหรือหดจากการเปลี่ยนการนำเสนอ.',
'ตรวจ distributable cash หลังดอกเบี้ย ค่าเช่า preferred distributions และเงินสำรองส่งมอบ; ไม่บวก CHRN ซ้ำกับ APLD. ตรวจ project-level priority และสิทธิถอนทุนของผู้ลงทุนร่วมจากสัญญาจริง.', ['APLD','CHRN'])
add('CIFR','Cipher Digital (เดิม Cipher Mining)','Nasdaq / สหรัฐฯ','HPC landlord + mining','USD',Y,[126.842,151.270,223.942],[-25.777,-44.635,-822.244],[-94.241,-87.511,-207.938],
'US GAAP; รายได้ FY2025 ในตารางยังเป็น Bitcoin mining',
'FY2025 รายได้ 223.942 ล้านไม่ใช่ HPC contracted revenue ในอนาคต ข้อตกลง credit backstop ของ Google แลก warrants ทำให้บันทึก credit-backstop asset 544.5 ล้านในสินทรัพย์ไม่หมุนเวียน และวัด warrant liability ผ่านกำไรขาดทุน.',
'ทรัพย์สินทางบัญชีจากสิทธิการค้ำไม่ใช่เงินสดซื้อเครื่อง และการค้ำแลกหุ้นมีต้นทุนต่อผู้ถือหุ้น ความเสี่ยงจริงจึงอยู่ทั้งการส่งมอบอาคารและภาระตามเงื่อนไข warrants ไม่ใช่มอง net loss แล้วตีว่าเงินสดหายเท่ากัน.',
'ติดตาม HPC commencement และการตัด amortization ของ backstop asset; ตรวจกรณีราคาหุ้นต่ำจนเกิด shortfall/เพิ่มจำนวนหุ้นตามสัญญา รวมทั้ง debt covenants. Financial/ICFR opinions สิ้น2025 ไม่ได้เป็น adverse เพียงเพราะมีขาดทุนสูง.', ['CIFR'])
add('CORZ','Core Scientific','Nasdaq / สหรัฐฯ','HPC landlord + mining','USD',Y,[502.400,510.672,319.019],[-246.487,-1437.874,-288.616],[65.114,42.896,278.250],
'FY2024 ใช้งบแก้ไขแล้ว; bankruptcy/reorganization ทำให้การเทียบโครงสร้างทุนระหว่างปีต้องระวัง',
'10-K/A ที่ยื่น2มี.ค.2026 ลด PP&E ปี2024 ลง122.869ล้านเพราะสินทรัพย์ที่ผูกพันรื้อถอนยังค้างมูลค่าในบัญชี ขาดทุน2024ปรับจาก1,315.005เป็น1,437.874ล้าน รายได้และกระแสเงินสดทั้งสามกิจกรรมไม่เปลี่ยน. บริษัทประกาศ non-reliance หลายงวด2024–25 และ material weakness ที่เกี่ยวข้อง.',
'นี่คือข้อผิดพลาดบัญชีที่ยืนยันแล้ว และตรงกับจุดเสี่ยงของการเปลี่ยนเหมืองเป็น HPC: สินทรัพย์ที่ใช้ไม่ได้ต่อควรถูกประเมินด้อยค่าเมื่อมีข้อบ่งชี้ ไม่ใช่รอรื้อจริง. Adverse ICFR opinion ต้องแยกจากความเห็นต่องบการเงินที่แก้ไขแล้ว; ไม่ใช่หลักฐานเจตนาทุจริต.',
'ตรวจ remediation และ impairment ของโครงการแปลงอื่น ๆ รวมทั้งกำไรจาก warrants ที่ไม่ใช่เงินสด. เคยเข้า Chapter11 ธ.ค.2022 และออกมาม.ค.2024 จึงใช้คำว่าไม่มีประวัติปัญหาหนี้ทั้งกลุ่มไม่ได้.', ['CORZ','CORZ24A','CORZ8K'])
add('GLXY','Galaxy Digital','Nasdaq / สหรัฐฯ','ธุรกิจสินทรัพย์ดิจิทัล + HPC landlord','USD',Y,[51626.779,42596.673,60406.728],[228.514,346.722,-241.349],[-4.079,-205.079,-316.636],
'รายได้หลักเป็น gross digital-asset trading; NI ส่วนบริษัทแม่; ไม่ใช่ recurring cloud sales',
'FY2025 ยอดรายได้กว่า60พันล้านเกิดจากวิธีแสดงธุรกรรมสินทรัพย์ดิจิทัลแบบ gross เป็นหลัก ขณะที่ Helios อยู่ในช่วงเปลี่ยนผ่านไป HPC. เงินสด/สินทรัพย์ลูกค้า collateral และสินทรัพย์ของบริษัทมีสิทธิเรียกร้องต่างกัน.',
'Debt/revenue จะดูต่ำมากอย่างหลอกตาถ้าใช้ trading turnover เป็นฐานเทียบกับค่าเช่า GPU ของผู้อื่น ต้องใช้ operating margin/segment cash flow ของ Data Centers และสิทธิรับกระแสเงินสดตามโครงการ.',
'ตรวจบริการเริ่มส่งมอบจริงของ Helios, cash collections และ project debt แยกธุรกิจ digital assets. ไม่ถือ customer assets เป็นแหล่งสภาพคล่องอิสระของผู้ถือหุ้น.', ['GLXY'])
add('BTDR','Bitdeer','Nasdaq / สิงคโปร์','Mining + ASIC + GPU cloud','USD',Y,[368.554,349.782,620.253],[-56.656,-599.151,65.597],[-271.8,-622.073,-1738.678],
'IFRS; CFO2023ปัด0.1ล้านจาก MD&A; งบฉบับบริษัทอ่านผ่าน filing mirror',
'แม้ปี2025กำไร65.6ล้าน CFO -1,738.7ล้าน: รายได้ที่รับเป็นคริปโตถูกปรับออกจาก CFO และมีเงินจมใน inventories/เงินล่วงหน้าเพื่อ SEALMINER. Gain จาก derivative liabilities 444.9ล้านเป็นรายการสำคัญ.',
'CFO ติดลบไม่เท่ากับ GPU cloud ขาดทุนทั้งหมด เพราะบริษัทมีวงจรผลิตชิป/เครื่องขุดและขายคริปโตซึ่งจัด cash flow อีกประเภท ต้องอ่าน operating กับเงินขายเหรียญร่วมกัน พร้อมไม่ลืมว่าเงินที่จมในสต็อกยังมีความเสี่ยงลดราคาและขายช้า.',
'ตรวจ inventory aging, commitments wafer, customer deposits, impairment ASIC และแยกสัดส่วนรายได้ AI จริงจาก mining. กำไรจากหุ้น/ตราสารแปลงสภาพที่ราคาลดลงไม่ใช่ความได้เปรียบการดำเนินงาน.', ['BTDR','BTDRmirror'])
add('WYFI','WhiteFiber','Nasdaq / สหรัฐฯ','GPU cloud + data centers','USD',['2023 (ก่อนฐานปัจจุบัน)','2024','2025'],[None,47.639,79.164],[None,1.370,-24.683],[None,18.750,45.655],
'สองปีเต็มใน filing ปัจจุบัน; ไม่เติมปี2023เป็นศูนย์; cloud เริ่ม2024/Enovumมีฐานตั้งแต่ปลาย2023',
'FY2025 CFO45.655ล้านเทียบซื้อPP&E268.403ล้าน รายได้เพิ่มแต่เปลี่ยนเป็นขาดทุนสุทธิ บริษัทจดทะเบียนแยกแต่ยังมี Bit Digital เป็นบริษัทแม่ควบคุม.',
'การเร่งลงทุนก่อนเปิด capacity ทำให้รายได้และค่าเสื่อมขึ้นคนละเวลา CFO บวกไม่ยืนยันว่าเติบโตได้โดยไม่เพิ่มทุน ต้องทดสอบสัญญาของลูกค้ารายหลักว่าค้ำระยะเวลาคืนทุนของเครื่องจริงเพียงใด.',
'ขอรายได้/กระแสเงินสดแยก Cloud กับ Enovum พร้อม related-party balances และ ownership ปัจจุบัน. ห้ามรวม WYFI+BTBT เพื่อวัดขนาดตลาด; ประวัติสามปี GPU ที่เทียบกันได้ยังไม่มี.', ['WYFI','BTBT'],'มีสองปีเต็ม; ก่อนหน้ามี predecessor/ระยะเริ่มต้น')
add('BTBT','Bit Digital','Nasdaq / สหรัฐฯ','บริษัทแม่ GPU cloud + crypto treasury','USD',Y,[44.916,108.051,113.560],[-13.893,28.306,-80.317],[1.106,-12.987,-288.924],
'NI ส่วนบริษัทแม่; CFO รวมกลุ่ม; เปลี่ยน mix ธุรกิจและมี NCI ของ WhiteFiber',
'FY2025 ขาดทุนทั้งกลุ่ม84.930ล้าน แต่ส่วนบริษัทแม่80.317ล้าน มีการลงทุน PP&E285.928ล้าน และกระแสเงินสดเกี่ยวกับสินทรัพย์ดิจิทัล/treasury ปนกับ Cloud.',
'ความเสี่ยงหลักคือ shareholder exposure เป็นทั้งราคาคริปโตและการใช้เงินลงทุน Cloud ไม่ใช่หุ้น cloud บริสุทธิ์ การมีหุ้น WYFI จดทะเบียนทำให้มีราคาตลาดของ subsidiary แต่ไม่ได้ทำให้สินทรัพย์ของลูกเป็นเงินสดของแม่ที่เบิกใช้ได้ทันที.',
'ตรวจการจัดประเภทซื้อ/ขายสินทรัพย์ดิจิทัล, เงินโอนระหว่างแม่ลูก, dilution และการจัดสรรผลขาดทุนแก่ NCI. ใช้ segment data ของ WYFI สำหรับ economics ของ GPU.', ['BTBT','WYFI'])
add('HIVE','HIVE Digital / BUZZ','Nasdaq / แคนาดา','Mining + GPU cloud','USD',J,[114.465,115.279,297.791],[26.500,-2.996,-148.448],[9.640,16.634,62.337],
'US GAAP comparative ใน FY2026; ต่างจากกำไรปี2024บน IFRS เดิมอย่างมีนัยสำคัญ',
'รายได้รวมยังมี Bitcoin mining มาก ขณะที่ BUZZ เป็นส่วน GPU cloud บริษัทเปลี่ยนฐานรายงานเป็น US GAAP ทำให้ชุดกำไร/CF เก่าที่ vendor เก็บไว้ไม่ควรถูกต่อรวมโดยไม่ reconcile.',
'hashrate ที่เพิ่มไม่ได้แปลว่ามี AI capacity สร้างกำไรเท่ากัน เช่นเดียวกับการเป็นพันธมิตร/ผู้ให้บริการที่ได้รับเลือกไม่ได้พิสูจน์ minimum contracted volume. กำไรจาก crypto valuation และการเปลี่ยนบัญชีต้องแยกจากผลดำเนินงาน BUZZ.',
'ตรวจ revenue/EBITDA/capex ของ BUZZ โดยตรง และเปรียบ gross margin ของเครื่องรุ่นเดียวกันหลังค่าไฟและ networking. รายงานนี้ใช้ตัวเลข US GAAP ล่าสุดตลอดชุดเพื่อหลีกเลี่ยงกำไรที่เปลี่ยนเพราะฐานบัญชี.', ['HIVE'])
add('DOCN','DigitalOcean / Paperspace','NYSE / สหรัฐฯ','General cloud + GPU cloud','USD',Y,[692.884,780.615,901.427],[19.409,84.492,259.262],[234.942,282.725,309.604],
'US GAAP; กลุ่มรวม SMB cloud ไม่ใช่ Paperspace อย่างเดียว',
'FY2025 มี valuation allowance release ของสินทรัพย์ภาษี69.939ล้าน และ tax benefit สุทธิ52.6ล้าน; CFO309.604ล้าน กับ cash PP&E129.086ล้าน. SBC82.524ล้านยังเป็นต้นทุน dilution แม้ไม่ใช้เงินสดทันที.',
'มีหลักฐานสร้างเงินสดต่อเนื่องมากกว่าผู้เริ่มต้นหลายราย แต่การโตของกำไร259ล้านไม่ควรถูกยกทั้งหมดเป็นการเพิ่มประสิทธิภาพ GPU เพราะผลภาษีและรายการอื่นช่วยด้วย การวัด FCF ต้องรวมวิธีจัดหาอุปกรณ์ผ่าน finance lease.',
'แยก normalized tax กับกำไรดำเนินงาน และติดตาม retention, pricing, receivables ของลูกค้า AI พร้อมหัก lease principal เมื่อวัดเงินที่เหลือผู้ถือหุ้น. กลุ่ม cloud ที่โตไม่ได้พิสูจน์ GPU segment profitable.', ['DOCN'])
add('RUM','Rumble / Northern Data–Taiga','Nasdaq / สหรัฐฯ','Video + cloud; เปลี่ยนกลุ่มด้วย M&A','USD',Y,[80.963,95.488,100.622],[-116.420,-338.363,-81.830],[-92.911,-87.010,-70.430],
'FY2023–25 คือ Rumble เดิม; ยังไม่ใช่งบรวม Northern Data หลังซื้อปี2026',
'Northern Data ถูกซื้อเข้ากลุ่มในเดือนมิถุนายน2026; filingแก้ไข8-K มีข้อมูลกิจการที่ซื้อ การใช้ตัวเลข RUM สามปีอย่างเดียวจึงไม่ใช่การตรวจ Taiga สามปี ปี2025 RUMยังเผาเงินสดจากการดำเนินงาน70.430ล้าน.',
'ความเสี่ยงใหม่คือ purchase price allocation, goodwill, contingent/convertible consideration และธุรกรรมกับผู้ให้ทุนที่เป็นคู่ค้า ภาพรายได้โตหลังควบรวมต้องแยก acquired growth ออกจาก organic utilization.',
'ควรอ่าน audited acquiree statements และ pro forma เต็มชุดควบคู่เมื่อวิเคราะห์ราคา RUM; รายงานนี้ยังไม่ทำ full three-year Taiga reconstruction จึงไม่ให้ verdict คุณภาพงบ Taiga ครบสามปี และไม่บวก Northern Data ซ้ำกับ RUM.', ['RUM','RUMdeal'],'สามปี RUM ครบ; acquiree Taiga/Northern Data ยังตรวจไม่ครบสามปี')
add('SHAZ','SharonAI','Nasdaq / ออสเตรเลีย','GPU cloud ระยะเริ่มต้น','USD',['2023 (ไม่มีชุดเทียบ)','2024','2025'],[None,.438,1.567],[None,-3.905,-39.624],[None,-2.206,-2.639],
'สองปีเต็มในงบปัจจุบัน; NI ส่วนบริษัทแม่; IPOปี2026',
'FY2025 รายได้1.567ล้าน ขาดทุนส่วนบริษัทแม่39.624ล้าน มี material weakness เกี่ยวกับการบัญชีเครื่องมือทางการเงินที่ซับซ้อน และยังต้องพิสูจน์ remediation.',
'ขนาดประกาศลงทุน/กำลังประมวลผลในอนาคตสูงกว่าประวัติรับเงินจริงมาก จึงควรให้ความสำคัญกับเงินสดที่ได้รับแล้วและเงื่อนไขจัดหาเครื่องมากกว่า valuation จากรายได้คาดการณ์ งานควบคุมบัญชีต้องโตตามความซับซ้อนของ financing.',
'ดู cash runway, signed customer acceptance, dilution จาก options/warrants และผลทดสอบ remediation รอบถัดไป; การเปิดเผย material weakness ไม่ใช่ข้อพิสูจน์ว่า revenue ปลอม.', ['SHAZ'],'มีสองปีเต็ม; ไม่ใช่สามปี GPU cloud')
add('MOVE','Corvex (reverse merger กับ Movano)','Nasdaq / สหรัฐฯ','GPU cloud หลังเปลี่ยนกิจการ','USD',Y,[None,1.013,.433],[-29.283,-23.727,-18.285],[-26.177,-22.533,-11.268],
'ตารางคือ Movano เดิมซึ่งขาย wearable; revenue2023ยังไม่ตรวจยืนยันในชุดนี้; ไม่ใช่ Corvex AI track record',
'ควบรวมเสร็จมี.ค.2026; Q2เป็นไตรมาสแรกเต็มของธุรกิจใหม่ เดือนส.ค.รายงาน live compute contracted ARR22ล้าน ซึ่งเป็นอัตรารายได้ต่อปีของ compute ที่เปิดใช้งาน ไม่ใช่ยอดรายได้ตามงบที่รับรู้ครบ22ล้านแล้ว.',
'สามปีของบริษัทจดทะเบียนเดิมตอบได้เรื่องเงินทุน/ขาดทุนก่อนควบรวม แต่ตอบ economics ของ AI ไม่ได้ แม้รายงานก่อนควบรวมมีข้อสงสัย going concern ต้องประเมินใหม่ด้วยเงินทุนและภาระของกลุ่มปัจจุบัน.',
'ขอ audited financials ของ private Corvex predecessor และ bridge ARR → revenue → cash collected; ตรวจ accounting acquirer กับ legal acquirer. ยังไม่สรุปว่าประวัติ GPU สามปีได้รับการตรวจครบ.', ['MOVE','MOVE26'],'ช่องว่างสำคัญ: งบ private Corvex ก่อนควบรวมยังไม่ครบ')
add('CHRN','ChronoScale','Nasdaq / สหรัฐฯ','GPU cloud; ลูกของ APLD','USD',['FY2024/05','FY2025/05','FY2026/05'],[None,84.376,71.604],[None,-72.730,-50.320],[None,-7.222,39.067],
'Cloud accounting predecessor; ไม่ต่อรายได้หุ่นยนต์ Ekso; ปี2024ยังไม่ยกตัวเลขเข้า table จน reconcile งบ carve-out',
'FY2026 Cloudมีลูกค้ารายเดียว และรับรู้รายได้71.604ล้าน ลดลงจาก84.376ล้าน; ลูกหนี้12.542ล้านเทียบ3.788ล้าน. APLDยังถือหุ้นประมาณ97% หลังดีลพ.ค.2026.',
'เป็นตัวอย่างว่าความต้องการ AI ทั้งตลาดเติบโตได้พร้อมกับรายได้ provider รายหนึ่งลดลง การรับประกัน uptime/เงื่อนไขราคา/การย้าย workload มีผลมากกว่าจำนวน GPU ที่ติดตั้งอย่างเดียว CFOบวก39.067ล้านยังต้องอ่าน working capital และ supplier financing.',
'ตรวจอายุและวันหมดสัญญาลูกค้าหลัก การเก็บลูกหนี้หลังวันงบ และแผนทดแทน GPU. สองบริษัทจดทะเบียน APLD กับ CHRN ไม่ใช่สองแหล่งรายได้อิสระ.', ['CHRN','CHRNpre'],'สองปีงบ Cloud ครบ; ปี2024 carve-out ยังไม่ได้ reconcile ทั้งสามงบ')
add('KC','Kingsoft Cloud','Nasdaq / HKEX 3896','General cloud + AI cloud','CNY',Y,[7047.461,7785.180,9558.619],[-2176.340,-1966.680,-936.251],[-169.070,628.419,3801.028],
'US GAAP; CNYล้าน; กำไรส่วนบริษัทแม่; ADRกับ3896.HKคือบริษัทเดียวกัน',
'สัดส่วนรายได้ Xiaomi เพิ่ม12.3%→16.4%→23.4% ใน2023–25 และ Kingsoft3.3%→3.8%→4.0%; เงินกู้ให้ Xiaomi 559.8ล้าน ณสิ้น2025. อายุอุปกรณ์อิเล็กทรอนิกส์3–5ปี แต่อาคาร/โครงสร้างพื้นฐานมีอายุบัญชีต่างกัน.',
'related-party customers อาจช่วยการเติบโต แต่ต้องตรวจราคาค่าบริการ ระยะเวลาเก็บเงิน และการหมุนเงินไปกลับ CFOที่ดีขึ้นอย่างมากต้อง reconcile working capital/การจ่าย capex ไม่ใช่ถือว่าทั้งหมดมาจากกำไร AI.',
'ตรวจ related-party receivables, การชำระเงินจริงหลังวันงบ, arm’s-length pricing และ loans ที่ออกไปในขณะต้องลงทุนเอง. อย่าใช้ค่าเสื่อมอาคารเฉลี่ยแทนอายุ GPU.', ['KC'])
add('OVH','OVHcloud','Euronext Paris','General cloud + GPU cloud','EUR',['FY2023/08','FY2024/08','FY2025/08'],[897.299,993.053,1084.613],[-40.3,-10.3,.4],[330,368.2,419.0],
'IFRS; NI และ CFOปัดตามเอกสารผลประกอบการ; กลุ่มรวม private/public/web cloud',
'FY2025 cash capex excluding acquisitionsประมาณ361.4ล้าน และ net debt excluding leases1,103ล้าน เพิ่มจาก667ล้านในFY2024 ส่วนหนึ่งเกี่ยวข้องกับ share buyback350ล้าน. Company unlevered FCF57.6ล้านมีนิยามต่างจากเงินสดเหลือผู้ถือหุ้น.',
'ธุรกิจสร้าง CFO ได้ต่อเนื่องแต่การคืนทุนผู้ถือหุ้นด้วย buyback เพิ่มภาระหนี้ในช่วงต้องลงทุนแข่งขัน หากใช้ net debt excluding leases ต้องใส่คำนี้เสมอ ไม่เทียบตรงกับ vendor debtที่รวม leases ของ CRWV.',
'ดู maintenance capex จริง, lease principal, cash interest และกำหนด refinancings; แยก GPU usage/pricing ออกจาก public cloud ทั้งหมด. ทดสอบกรณี capexต่อรายได้ยังสูงแม้รายได้โตช้าลง.', ['OVH','OVH24'])
add('IONOS','IONOS Group','Xetra / เยอรมนี','Hosting + general/GPU cloud','EUR',Y,[1423.734,1248.070,1316.894],[174.231,169.666,229.693],[314.496,386.803,391.859],
'FY2023 revenueรวม Sedo; FY2024–25 continuing revenueหลังแยก Sedo; NIส่วนบริษัทแม่และ CFOรวม discontinued ด้วย',
'FY2025 continuing profit202.350ล้าน เทียบ129.552ล้านปี2024 ต่างจากกำไรรวมในตารางเพราะ discontinued operations. Cloud/hostingเดิมมีฐานลูกค้ากระจาย แต่ไม่ได้เปิดกำไร GPU แยกที่ใช้วัดเศรษฐศาสตร์ GPU โดยตรง.',
'การเห็นรายได้2023สูงกว่า2024แล้วสรุปว่าธุรกิจหดเป็นการเทียบคนละขอบเขต ต้องสร้าง continuing series ก่อน อีกจุดคือ related-party funding/cash pooling กับ United Internet ซึ่งต้องดูสิทธิเรียกเงินและต้นทุน.',
'ติดตาม segment Cloud Solutions และการเพิ่ม capacity เทียบยอดใช้จริง; ตรวจ impairment goodwill กับ terminal growth/WACC และ related-party balances. อย่าใช้ลูกค้า hosting จำนวนมากเป็นหลักฐานว่าลูกค้า GPU กระจายเท่ากัน.', ['IONOS','IONOS23'],'สามปี แต่ revenueมีการตัดธุรกิจ; ห้ามคำนวณgrowth2023→24ตรง ๆ')
add('DHH','DHH / Seeweb','Euronext Growth Milan','Regional cloud + GPU cloud','EUR',Y,[33.677297,35.890208,40.304966],[2.210961,3.608781,4.458696],[9.058144,9.179023,11.153636],
'ใช้ net sales ไม่ใช่ total revenueรวมother income; NIส่วนบริษัทแม่; IFRS',
'FY2025 goodwill17.234ล้าน เพิ่มจากการซื้อกิจการราว6.870ล้าน; net cashประมาณ1.275ล้านหลังปี2024เป็นnet debt3.127ล้าน แต่ปี2025ได้รับทุนใหม่7.382ล้านด้วย. มี right-of-use investment4.983ล้านที่ไม่เท่ากับcash capex.',
'ตัวเลขดูเติบโตพร้อมกำไรและCFO แต่ต้องแยก organic/ซื้อกิจการ และไม่ให้การเพิ่มทุนถูกอ่านว่าเงินสดมาจากกำไรทั้งหมด ขนาดเล็กทำให้การสูญเสียลูกค้า GPU รายใหญ่หรือ impairmentของCGUบางตัวมีผลต่อ equity มาก.',
'ตรวจ goodwill sensitivity และสัดส่วน cash capex/lease additions ของ Seeweb; bridge net cash หลังทุนใหม่; ติดตาม receivable concentration. บริษัทนี้มีรายได้ภูมิภาค/บริการอื่นด้วย ไม่ใช่ GPUล้วน.', ['DHH','DHH24'])
add('SAKURA','Sakura Internet','Tokyo 3778','Sovereign/GPU cloud + hosting','JPY',J,[21826,31412,35301.649],[651,2937,216.023],[2884,5787.563,6223.575],
'Japanese GAAP; ใช้ financial results summaries + comparative; summariesไม่ใช่รายงานผู้สอบบัญชีเต็มฉบับ',
'FY2026 operating loss403.654ล้าน แม้รายได้โต; cash PP&E36,336.695ล้านและ intangible1,106.251ล้าน เทียบCFO6,223.575ล้าน เงินอุดหนุนรับ12,346.456ล้านอยู่ใน investing cash flow ไม่ใช่CFO.',
'เงินอุดหนุนช่วยลดเงินลงทุนสุทธิแต่ไม่ได้ยืนยันว่า capacity ทำกำไรได้เอง ต้องแยกเงินรัฐที่ได้รับแล้วกับที่รออนุมัติ และเงื่อนไขคืนเงินเมื่อไม่ผ่าน milestone การโตของรายได้พร้อมoperating lossทำให้ utilizationสำคัญมาก.',
'คำนวณ funding gap หลัง CFO+grant เทียบgrosscapex และ debt/lease repayment; ติดตาม grants receivable, subsidy compliance และค่าเสื่อมของเครื่องที่เริ่มใช้. การเปลี่ยนestimateในปีเก่าต้องอ่านรายละเอียดก่อนกล่าวว่าเป็นGPUlife extension.', ['SAKURA','SAKURA25'],'สามปีตัวเลขผลประกอบการ; auditor opinionฉบับเต็มยังไม่ได้ทบทวน')
add('GMO','GMO Internet','Tokyo 4784','Internet infrastructure + GPU cloud','JPY',Y,[14903.840,12997.730,78548],[40.343,-4.845,5563],[None,6,13669],
'FY2023–24คือฐาน GMO Ad Partners; รับโอนธุรกิจ infrastructureจากบริษัทแม่ต้น2025; CFO2023ยังไม่ยืนยัน',
'รายได้2025กระโดดเพราะการปรับโครงสร้างธุรกิจ ไม่ใช่ organic GPU growthกว่า500%. แหล่งรายได้มี domain/hosting/advertising/infra และทุน/หนี้จากกลุ่มต้องแยกตามนิติบุคคล4784กับ9449.',
'กรณีนี้ชื่อบริษัทชวนให้ใช้ประวัติของบริษัทแม่ผิดตัวมากที่สุด ต้องระบุsecurity codeและscopeของconsolidationทุกครั้ง การเทียบmarginก่อนและหลังรับโอนจึงมีข้อจำกัดแม้ใช้สกุลเงินเดียวกัน.',
'ขอpro formaงบธุรกิจที่โอนย้อนหลัง, related-party transfer pricing, cash poolและปันผลหลังลงทุนGPU; ตรวจ GPU usage จริงแยกจากบริการinternet. ไม่อนุมานคุณภาพGPUจากกำไรของธุรกิจอื่น.', ['GMO','GMO24'],'สามปีคนละbusiness perimeter; CFO2023เป็นช่องว่าง')
add('DATASECTION','Datasection','Tokyo 3905','AI data centers / GPU compute','JPY',J,[2229,2942,33605],[-1261,-654,2801],[333.604,-83.408,None],
'Japanese GAAP; FY2026ตัวเลขจากเอกสารAGMหลังแก้ไข; CFOล่าสุดต้องยืนยันงบต้นทางก่อนใส่',
'ธุรกิจ AI เริ่มรับรู้รายได้ก.ย.2025; FY2026 server usage expense25,154ล้านจากต้นทุนรวม27,208ล้าน รายได้เกี่ยวข้องกับโครงสร้างสัญญาผ่านNOWNOWJapanและลูกค้าcloudรายใหญ่ที่ไม่เปิดชื่อ.',
'ความเสี่ยงบัญชีอยู่ที่ gross versus net: บริษัทควบคุมบริการก่อนส่งต่อจริงหรือเป็นนายหน้า รวมถึง cutoff ที่เริ่มรับรู้รายได้เมื่อcapacityพร้อมตามสัญญา แม้การแสดงgrossถูกต้องก็อาจทำให้รายได้ใหญ่มากโดยmarginต่อรายได้ต่ำ.',
'ตรวจ principal–agent assessment, สัญญาฝ่ายจัดหา/ลูกค้า, receivable collection, ภาระเช่าserverกับยอดสั่งGPU. FY2024–25เป็นธุรกิจข้อมูลเดิมมาก จึงไม่ใช่3ปีAIที่เทียบกันได้.', ['DATASECTION','DATASECTION25','DATASECTION26annual'],'สามปีรายได้/กำไร; เริ่มAIปลาย2025 และต้องตรวจ cash conversion เพิ่ม')
add('E2E','E2E Networks','NSE / อินเดีย','GPU cloud','INR',J,[944.636,1639.608,2455.801],[218.669,474.943,-155.659],[428.633,884.663,1220.568],
'งบต้นทางหน่วย lakh; หาร10เพื่อแสดง INRล้าน; ไม่สับสนcroreกับmillion',
'FY2026 cash fixed-asset capex12,624.503ล้าน เทียบCFO1,220.568ล้านและขาดทุน155.659ล้าน; ปี2025มีinterest income324.654ล้านช่วยกำไร และการออกหุ้นเพิ่มทุนขนาดใหญ่ก่อนนำเงินไปซื้ออุปกรณ์.',
'นี่เป็นรูปแบบที่EBITDAโตแต่กำไรสุทธิเสียหายเมื่อค่าเสื่อมของเครื่องใหม่เริ่มวิ่ง รายได้ดอกเบี้ยบนเงินเพิ่มทุนก่อนลงทุนไม่ใช่marginของGPU เมื่อเงินสดถูกใช้ไปผลดอกเบี้ยดังกล่าวย่อมไม่คงเดิม.',
'ตรวจcashcapexต่อcapacityที่ใช้งานจริง, useful life, utilizationของGPUรุ่นเก่า และcash commitments; แยกเงินฝากจากเงินสดใช้ได้ทันที. ใช้เงินทุนที่ได้รับจริงวางcash runwayโดยไม่ถือEBITDAเป็นFCF.', ['E2E','E2E25'])
add('SIFY','Sify Technologies','Nasdaq / อินเดีย','Network + data centers + cloud','INR',J,[35634,39886,44877],[169,-785,-1366],[5935,8647,7176],
'IFRS; ใช้ชุดFY2026ที่ปัดเป็นINRล้านทั้งสามปี; NIรวมกลุ่ม; cloudอยู่ในหลายบริการ',
'FY2026 CFO7,176ล้านลดจาก8,647ล้านแม้รายได้โต เงินซื้อPP&E11,956ล้านสูงกว่าCFO. Gross trade receivables12,648ล้านและallowance expense164ล้านเป็นcritical audit matterด้านrecoverability; ลูกค้ารายหนึ่งมีรายได้8,809ล้านประมาณ19.6%ของยอดรวม.',
'critical audit matterหมายถึงเรื่องที่ผู้สอบบัญชีต้องใช้ดุลยพินิจมาก ไม่ใช่qualified opinionโดยตัวมันเอง เมื่อขายทั้งnetwork/DC/cloudแก่ลูกค้ารายเดียว ความสัมพันธ์ของreceivablesกับการลงทุนต้องอ่านข้ามsegment.',
'ตรวจaging/รับชำระหลังวันงบ, capexcreditorและleasefinancing, แหล่งเงินระดับSISLและสิทธิผู้ลงทุนก่อนหุ้นสามัญ. อย่าใช้ยอดลูกค้า8,809/44,877เป็นมากกว่า20%โดยไม่ตรวจเลข แม้ข้อความMD&Aจะใช้ถ้อยคำดังกล่าว.', ['SIFY','SIFYmirror'])
add('UCLOUD','UCloud','SSE STAR 688158','General cloud + GPU cloud','CNY',Y,[1515.2789,1502.9720,1699.3570],[-342.7194,-241.0420,-73.5534],[138.0175,122.0969,242.5313],
'PRC GAAP; NIส่วนบริษัทแม่; 万元หาร100เป็นCNYล้าน; ใช้annual filingฉบับแก้ไขผ่านSina',
'ปลาย2025เปลี่ยนอายุGPUจาก4เป็น5ปีแบบprospective และมีgain63.8029ล้านจากการเปลี่ยนการวัดเงินลงทุนHaimaCloudหลังสูญเสียsignificant influence. มิถุนายน2026แก้ไขงบH1/Q3ปี2025เรื่องจังหวะรับรู้รายการดังกล่าวโดยไม่เปลี่ยนผลทั้งปี2025.',
'ต้องแยกสองเรื่อง: useful-life changeเป็นการเปลี่ยนประมาณการที่อาจเหมาะสมหากมีหลักฐาน ส่วนการลงงวดผิดที่แก้ไขเป็นข้อผิดพลาดการรับรู้จริง ขาดทุนที่แคบลงจึงยังไม่พิสูจน์ว่าcorecloudทำกำไร โดยเฉพาะเมื่อnonrecurringgainมีขนาดใหญ่.',
'ตรวจเหตุผลยืดอายุจากข้อมูลขายต่อ/renewalจริง และแสดงnormalizedearningsที่ตัดgainครั้งเดียวพร้อมผลภาษี; ตรวจtimingที่เสียอำนาจมีอิทธิพลตามเอกสารคณะกรรมการ ไม่กล่าวว่าestimatechangeเท่ากับfraud.', ['UCLOUD','UCLOUDcorrection','UCLOUDestimate'])
add('QING','QingCloud','SSE STAR 688316','General cloud + GPU cloud','CNY',Y,[335.693625,272.066179,228.104982],[-170.072433,-95.757721,-66.663125],[-110.469690,-34.537329,-21.455429],
'PRC GAAP; NIส่วนบริษัทแม่; อ่านcompanyannualfilingผ่านmirror',
'รายได้ลดสามปีและCFOติดลบต่อเนื่อง ส่วนผู้ถือหุ้นลดจาก179.481เป็น87.114และ21.513ล้านใน2023–25 ปี2025grossmarginบริการcloud4.89% ต่ำกว่ากลุ่มcloudproducts62.66%มาก.',
'ทุนบางเป็นความเสี่ยงรองรับloss/impairment แต่ยังไม่เท่ากับพิสูจน์liquidityinsolvency ต้องดูcashmaturitiesเพิ่ม EBITDAรวมอาจถูกพยุงด้วยproductlicensesซึ่งไม่สะท้อนผลตอบแทนจากcloudcapacity.',
'ตรวจcashrunway, refinancing/equityraise, ARagingและgoodwill/assetimpairment; วัดcloudservicesgrossprofitแยกproducts. รายงานนี้ไม่ได้ยืนยันgoing-concernqualificationของผู้สอบบัญชี จึงไม่ติดป้ายว่ามีโดยอาศัยขาดทุนอย่างเดียว.', ['QING','QINGpdf'])
add('CAPITAL','Capitalonline','Shenzhen 300846','IDC + GPU/general cloud','CNY',Y,[1243.287334,1396.789414,1236.589073],[-340.078977,-303.144023,-170.034969],[169.048664,240.905308,179.780923],
'PRC GAAP; NIส่วนบริษัทแม่; แยกIDClegacyกับcloud/AIGC',
'FY2025AIGCcustomerrevenue260.903ล้านโต65.88% แต่รายได้รวมลด11.47%; CFO179.781ล้านเทียบcashcapex384.111ล้าน และได้เงินขายfixedassets118.258ล้านในinvestingCF.',
'การเปลี่ยนmixช่วยให้AIโตขณะธุรกิจเดิมหดได้ จึงอย่าคูณAIGCgrowthกับฐานรายได้ทั้งบริษัท เงินขายสินทรัพย์ช่วยสภาพคล่องเพียงครั้งเดียวและอาจลดcapacityเดิม ต้องตรวจว่าขายเพราะเปลี่ยนกลยุทธ์หรือจำเป็นต้องหาเงิน.',
'ติดตามsegmentmarginแทนgrowthอย่างเดียว, assetdisposalราคาขายเทียบbookvalue, capexpayablesและleaseprincipal. ดูว่ารายได้AIแปลงเป็นcashที่เพียงพอชดเชยIDCที่ลดลงเมื่อใด.', ['CAPITAL'])
add('AKAM','Akamai / Linode','Nasdaq / สหรัฐฯ','Security/CDN + cloud compute','USD',Y,[3811.920,3991.168,4208.175],[547.629,504.918,452.031],[1348.439,1519.171,1518.765],
'US GAAP; กลุ่มรวม; revenuecloudcomputeไม่เท่ากับGPUrevenue',
'FY2025CloudCompute708.050ล้านประมาณ16.8%ของกลุ่ม แต่CloudInfrastructureServicesเป็นsubset314ล้าน ขณะที่Security/CDNมีขนาดใหญ่กว่า. CFOบวกมากต่อเนื่องจากหลายธุรกิจ.',
'งบรวมมีความสามารถระดมทุนภายในดีกว่าผู้เริ่มต้นบางราย แต่ไม่สามารถสรุปว่าการเช่าGPUมีกำไรหรือมีmarginเท่ากลุ่มโดยไม่มีallocationของcapex/ค่าเสื่อม/ต้นทุนnetwork.',
'ตรวจsegmentcomputeprofitและincrementalcapexต่อรายได้ใหม่ รวมทั้งการโอนcostระหว่างCDNกับcompute; อย่าให้คุณภาพธุรกิจsecurityกลบunit economicsของAIที่ยังต้องพิสูจน์.', ['AKAM'])
add('DUG','DUG Technology','ASX / ออสเตรเลีย','Scientific HPC as a service','USD',U,[65.501,62.577,86.387],[3.324,-4.408,2.641],[12.113,5.580,20.902],
'รายงานเป็นUSDไม่ใช่AUD; NIรวมNCI; ใช้CFOในprimarycashflowstatement (noteFY2026ต่าง0.001ล้าน)',
'HPCaaSrevenue3.367→2.379→11.488ล้าน หรือ13.3%ของรายได้ล่าสุด ที่เหลือส่วนใหญ่geophysicalservicesและsoftware. FY2026เงินลงทุนPP&E11.508ล้านเทียบCFO20.902ล้าน.',
'อยู่ในขอบเขตแบบadjacentHPCเพราะขายกำลังประมวลผลจริง แต่ไม่ควรตีความอุปสงค์ประมวลผลธรณีฟิสิกส์ว่าเคลื่อนไหวเหมือนLLMtrainingทั้งหมด ลูกค้าและงบลงทุนอุตสาหกรรมพลังงานทำให้cycleต่างออกไป.',
'ตรวจHPCaaSrenewalและcashmarginแยกservices, usefullifeของอุปกรณ์และการลงทุนsoftware. ต้องระวังการนำCFOรวมที่มาจากservicesไปอ้างว่าบริการHPCได้ผลตอบแทนเท่ากัน.', ['DUG','DUG25'])

# RXT is added after reading its latest annual report; no forecast is substituted for sales.
add('RXT','Rackspace Technology','Nasdaq / สหรัฐฯ','Managed cloud + GPU cloud','USD',Y,[None,None,None],[-837.8,-858.2,-225.8],[374.9,39.9,151.4],
'US GAAP; revenueเติมหลังตรวจannualstatement; historicalmanagedcloudไม่ใช่GPUล้วน',
'ปี2023–24มีgoodwillimpairment708.8และ714.9ล้าน ปี2025ไม่มีรายการดังกล่าวจึงทำให้netlossลดลงมาก CFO151.4ล้านเทียบcashPP&E/software60.8ล้าน แต่ยังจ่ายfinanceleaseprincipal56.6ล้านและfinancingobligations15.9ล้าน.',
'ขาดทุนที่ดีขึ้นเมื่อimpairmentหายไปไม่เท่ากับunit economicsพลิกบวก โครงสร้างหนี้อยู่หลายrestrictedgroups ทำให้เงินสดรวมกับเงินสดที่เจ้าหนี้ชุดหนึ่งเรียกร้องได้ต่างกัน.',
'ข้อตกลงAMDมิ.ย.2026วางแผนdeployment30MWปลาย2026–28: แยกfuturecapacityกับrecognizedrevenue ตรวจfundingต่อphase, contractedcustomersและguarantorgroup. อย่าหักแค่cashcapexแล้วเรียกเงินที่เหลือทั้งหมดเป็นFCFผู้ถือหุ้น.', ['RXT','RXTdeal'])

add('NB2','Northern Data / Taiga (acquiree ของ RUM)','เยอรมนี / NB2; ประวัติก่อนควบรวม','GPU cloud + discontinued mining','EUR',Y,[77.527,121.087,80.042],[-151.055,-127.443,-390.173],[-17.601,-58.461,29.213],
'IFRS; FY2024–25รายได้continuingหลังแยกPeakMining; FY2023รายได้รวมเดิมส่วนใหญ่mining; NI/CFOยังรวมdiscontinued จึงห้ามหารCFO/revenueตรง ๆ',
'S-4แนบงบตรวจแล้ว2025/2024และcomparatives2023. FY2025รายได้continuing80.042ล้านลดจาก121.087ล้าน และมีdepreciation/amortization/impairmentของcontinuing380.178ล้าน; CFOรวม29.213ล้านมีworkingcapitalและเงินขายคริปโตจากminingเดิมหนุน ขายPeakMiningทำให้ผลdiscontinuedเป็นบวก92.556ล้าน ขณะที่continuingloss482.729ล้าน.',
'Taigaเป็นตัวอย่างที่capacityลงทุนแล้วไม่ได้รับประกันการโตของรายได้ในทุกปี การขายกิจการและimpairmentเปลี่ยนกำไร/สินทรัพย์อย่างมาก ต้องแยกเงินที่เกิดจากdisposeออกจากเงินให้บริการต่อเนื่อง เมื่อRUMซื้อ85.2%ใน17มิ.ย.2026 การวิเคราะห์เริ่มต้องรวมpurchasepriceallocationและเงินทุนจากคู่ค้าที่เป็นผู้ถือหุ้น.',
'ตรวจrenewal/collectionของTaiga, impairment assumptionsและrelated-partyfinancing; อ่านIFRS→USGAAPproformabridgeก่อนเทียบRUM. งบชุดนี้เป็นส่วนต่อของRUManalysis ไม่ให้นำยอดไปบวกกับRUMหลังacquisitionซ้ำ; ไม่อ้างสถานะdelistingสุดท้ายที่ยังไม่ยืนยัน.', ['NDannual','RUMdeal'],'สามปีงบacquiree; FY2023คนละmixและFY2024recast discontinued')

def fmt(v):return '—' if v is None else f'{v:,.3f}'.rstrip('0').rstrip('.')
def cite(keys):return ' · '.join(f'[{k}]({S[k]})' for k in keys)

INTRO='''# ใครคือ Neocloud และแต่ละเจ้าเสี่ยงอะไร — ตรวจงบย้อนหลังสามปี

**วันที่ตัดข้อมูล: 19 กันยายน 2026 | ภาษาไทย | เอกสารวิจัยจากงบสาธารณะและหมายเหตุประกอบงบ**

ข้อค้นพบที่สำคัญที่สุดคือความเสี่ยงของบริษัทกลุ่มนี้ต่างกันตามสิ่งที่เป็นเจ้าของและภาระที่ต้องจ่าย บางรายเป็นผู้ให้บริการ GPU บางรายให้เช่าอาคารและไฟฟ้า บางรายยังมีรายได้หลักจาก Bitcoin หรือการซื้อขายสินทรัพย์ดิจิทัล การนำหนี้รวมเทียบรายได้แล้วเรียงอันดับเดียวกันจึงให้ข้อสรุปผิดได้

รายงานนี้ต่อยอดบันทึกเดิม “ใครคือ neocloud และแต่ละเจ้าเสี่ยงอะไร” โดยคงสิบรายเดิมและขยายการค้นหาทั่วโลก ได้ **33 บริษัทจดทะเบียนที่จัดทำ profile** รวมบริษัทแม่และบริษัทลูกที่ต้องป้องกันการนับซ้ำ พร้อมทะเบียนผู้ประกอบการใกล้เคียง/เอกชนที่แยกไว้ด้านท้าย เป้าหมายคือสามปีบัญชีล่าสุดที่เผยแพร่แล้ว ไม่ใช่ดึงสามคอลัมน์จากผู้ขายข้อมูลแล้วถือว่าฐานเหมือนกัน

**ขอบเขตความเชื่อมั่น:** เป็น desk review ที่ใช้วิธีคิดทางบัญชี ไม่ใช่งานสอบบัญชีที่มีการยืนยันยอดกับธนาคาร/ลูกค้า ไม่มีสิทธิเข้าถึงสัญญาที่ไม่เปิดเผย และยังมีช่องว่างที่ระบุรายบริษัท เช่น private predecessor ของ Corvex, ประวัติ Taiga ก่อนควบรวม และบางงบ carve-out จึงไม่อ้างว่าตรวจครบทุกบริษัทในโลกหรือครบทุกหมายเหตุสามปีแล้วทุกบริษัท เครื่องหมาย — หมายถึงยังไม่มีข้อมูลที่ยืนยันในรายงานนี้ ไม่ใช่ศูนย์

## 1. ข้อค้นพบที่มีผลต่อการอ่านงบมากที่สุด

1. **Core Scientific มีข้อผิดพลาดบัญชีที่ยืนยันแล้ว:** ปี2024ต้องลดPP&E122.869ล้านดอลลาร์เพราะยังบันทึกมูลค่าสินทรัพย์ที่ผูกพันรื้อถอน ผลขาดทุนเพิ่มเท่ากัน แต่รายได้และกระแสเงินสดไม่เปลี่ยน ให้ใช้งบแก้ไขแทนฉบับเดิม [CORZ24A]
2. **หนี้ CoreWeave ในบันทึกเดิมถูกเสี่ยงนับ lease ซ้ำ:** ณ30มิ.ย.2026 หนี้การเงิน35.068พันล้าน + leases16.540พันล้าน =51.608พันล้านดอลลาร์ ยอด51.608รวมleaseแล้ว การบวกอีกครั้งเป็น68.148ผิด [CRWVQ2]
3. **CFOของIRENไม่ได้มาจากกำไรซ้ำได้ทั้งหมด:** เงินรับล่วงหน้าAI1.8417พันล้านหนุนCFO2.1004พันล้าน แต่สร้างภาระส่งมอบในอนาคต ต้องแยกจากcash earnings [IREN]
4. **การเติบโตของกำไรมีส่วนจากบัญชีและโครงสร้างธุรกิจ:** UCloudเปลี่ยนอายุGPUและมีinvestmentgain; DigitalOceanมีtaxvaluationallowancerelease; Nebiusมีrevaluationและdiscontinuedoperations; GMO4784รับโอนธุรกิจ ไม่ควรอ่านเป็นorganicGPUgrowth [UCLOUD] [DOCN] [NBIS] [GMO]
5. **ผู้ให้เช่าอาคารกับผู้ให้เช่าGPUเสี่ยงคนละจุด:** construction/acceptance/powerconnectionสำคัญต่อWULF/CIFR/CORZ/APLD ส่วนCRWV/CHRN/E2Eเสี่ยงutilization/rentalprice/usefullifeด้วย การมีbackstopชื่อใหญ่ไม่ได้ค้ำก่อนเริ่มสัญญาทุกกรณี [WULF] [CIFR]
6. **รายได้ตลาดรวมอาจถูกนับเกิน:** CHRNยังรวมอยู่ในAPLD และWYFIยังอยู่ในBTBT; หุ้นสองตัวไม่ได้หมายถึงเศรษฐกิจสองชุดอิสระ อย่ารวมRUMกับNorthernDataซ้ำหลังควบรวม [CHRN] [BTBT] [RUMdeal]

## 2. วิธีอ่านตารางและวิธีตรวจ

ตัวเลขทั้งหมดในตารางรายบริษัทเป็น **ล้านหน่วยของสกุลเงินที่กำกับ** เรียงปีเก่า→ใหม่; วงเล็บ/เครื่องหมายลบคือขาดทุนหรือเงินไหลออก CFOคือกระแสเงินสดจากการดำเนินงานตามงบ มิใช่EBITDAหรือFCF NIบางบริษัทเป็นส่วนบริษัทแม่ บางบริษัทเป็นทั้งกลุ่ม มีคำอธิบายใต้ชื่อทุกแห่ง ไม่รวมตัวเลขต่างสกุลเงินเข้าด้วยกันและไม่จัดอันดับdefault probabilityจากตารางนี้

อ่านรายงานประจำปีล่าสุดเพื่อใช้comparativesที่แก้ไขแล้ว และเติมรายงานปีก่อนเมื่อเอกสารล่าสุดแสดงเพียงสองปี ตรวจงบกำไรขาดทุน งบดุล งบกระแสเงินสด และหมายเหตุที่เกี่ยวข้องกับ revenue, capital expenditure, depreciation/impairment, financing/leases, related parties, concentration และinternalcontrols เอกสารSECที่อ่านผ่านcompanyfactsเป็นXBRLจากผู้ออกหลักทรัพย์ แต่tagอาจไม่ครอบคลุมcustomsegments จึงไม่ใช้ชื่อtagเดียวตัดสินทุกราย

ข่าวผลประกอบการใช้ประกอบการอ่าน ไม่แทนความเห็นผู้สอบบัญชี; เอกสารญี่ปุ่นบางฉบับเป็นfinancialresultssummaryที่ระบุว่าไม่ใช่งบที่ถูกตรวจในเอกสารนั้น ต้องแยกจากannualsecuritiesreport เอกสารจีนบนSinaและfilingmirrorเป็นข้อความรายงานบริษัทที่เผยแพร่ซ้ำ ใช้ชื่อเอกสาร/ปี/หัวข้อเป็นตัวตรวจกลับ ไม่ใช้บทวิเคราะห์บุคคลอื่นแทนงบ

|สิ่งที่ตรวจ|เหตุที่ต้องตรวจ|หลักฐานที่ต้องเห็นก่อนสรุป|
|---|---|---|
|รายได้กับARR/RPO/backlog|สัญญาในอนาคตไม่ใช่รายได้ปีนี้|capacityพร้อมให้บริการ, acceptance, serviceperiod, cancellation/credits|
|CFOกับเงินรับล่วงหน้า|ลูกค้าให้ทุนก่อนส่งมอบอาจทำCFOสูง|deferredrevenue+AR+collection+refund/creditterms|
|Capex|ซื้ออุปกรณ์ผ่านlease/ค้างจ่ายไม่อยู่cashcapexทันที|cashPP&E+noncashadditions+lease+supplierpayables+commitments|
|ค่าเสื่อม/ด้อยค่า|อายุบัญชีอาจยาวกว่าอายุทำเงิน|รุ่นGPU, utilization, renewalprice, resale, impairmenttriggers|
|หนี้/เงินสด|restrictedcash, subsidiarycash, warrantมีสิทธิต่างกัน|maturity, recourse, collateral, covenant, entitycashwaterfall|
|กำไรปรับปรุง|ตัดSBC/interest/maintenanceทุกอย่างแล้วอาจดูดีเกินจริง|reconciliationกับGAAPและเงินสดจ่ายจริง|
|รายงานผู้สอบบัญชี|materialweakness/CAM/adverseICFRไม่ใช่คำเดียวกัน|ข้อความopinionแยกงบการเงินกับinternalcontrolsและวันที่แก้ไข|

## 3. แก้ฐานคิดจากบันทึกเดิม

|ข้อความหรือวิธีอ่านเดิม|ผลสอบทาน|วิธีใช้ต่อ|
|---|---|---|
|สิบรายคือผู้กู้ซื้อGPUทั้งหมด|ขอบเขตผสมGPUoperators/landlords/mining/trading|แยกสินทรัพย์ที่รับความเสี่ยงก่อนเทียบ|
|CRWV debt51.608บวกlease16.540อีก|นับซ้ำ; รายละเอียดรวมได้51.608อยู่แล้ว|ใช้debtbridgeด้านล่าง|
|CFO IRENสูงกว่ารายได้อาจเป็นข้อมูลผิด|มีAIcustomerprepaymentsจำนวนมากจริง|วิเคราะห์deliveryobligationsและเงินที่ยังใช้ได้|
|GLXYdebt/revenueต่ำจึงดูปลอดภัย|revenueเป็นgrosstradingturnover|ใช้DCsegmentcashflowและprojectdebt|
|ไม่มีประวัติปัญหาหนี้ในกลุ่ม|CORZเคยChapter11|ใช้ประวัติreorganizationและทุนหลังออกจากศาล|
|GPUcollateralลด60–75%ใช้กับทุกคน|ยังไม่มีฐานข้อมูลรุ่น/สัญญา/วันเดียวกันรองรับ|เก็บเป็นscenarioมีเงื่อนไข ไม่เป็นข้อเท็จจริงทั้งอุตสาหกรรม|
|เงินสด+วงเงินที่ยังไม่เบิกคือเงินพร้อมใช้ทั้งหมด|วงเงินมีconditionsprecedentและบางเงินสดrestricted|คำนวณunrestrictedliquidityตามนิติบุคคล|

**CoreWeave debt bridge, ล้านUSD, ณ30มิ.ย.2026:** recoursecurrent6,235 + nonrecoursecurrent1,278 + recourselongterm25,170 + nonrecourselongterm2,385 =35,068; operatingleases584+15,735=16,319; financeleases7+214=221; รวม35,068+16,319+221=51,608. Cash5,524+marketablesecurities15=5,539 แยกจากrestrictedcash873+507=1,380. การตัดยอดซ้ำไม่ได้ทำให้ความเสี่ยงหนี้หมดไป แต่ทำให้ฐานที่ใช้วิเคราะห์ถูกต้อง [CRWVQ2]

## 4. ทะเบียนบริษัทและผลตรวจรายบริษัท

เลือกผู้ให้GPU/HPCcloudโดยตรง และcloudprovidersที่มีGPU/AIoffering รวมถึงสิบรายเดิมแม้บางรายเป็นlandlord/mining พร้อมบอกข้อยกเว้น DUGเป็นscientificHPCadjacent; บริษัททั่วไปที่AIยังเล็กมากหรือมีเพียงแผนแยกไว้ในทะเบียนท้ายรายงาน คำว่า33หมายถึงผู้ออกหลักทรัพย์33ราย ไม่ใช่33กลุ่มเศรษฐกิจอิสระ
'''

OUTRO='''
## 5. ทะเบียนขอบเขตเพิ่มเติมและสิ่งที่ยังไม่ควรนับเป็น GPU cloud บริสุทธิ์

|ชื่อ/กลุ่ม|สถานะในรายงาน|เหตุผลและงานที่ยังต้องทำ|
|---|---|---|
|FPT / HOSE|listed parent ที่มีAICloud; ภาคผนวก ไม่รวม33profile|ปี2025รายได้AI+Cloud913พันล้านVND ส่วนเล็กของกลุ่ม; ต้องตรวจsegmentAIโดยตรง แทนใช้ITservicesทั้งกลุ่ม [FPT]|
|YTL Power / Bursa6742|listed parent ของโครงการAI; ภาคผนวก|utilities/telecom/DCมีขนาดใหญ่; ประวัติGPUใหม่ไม่ใช่ประวัติสามปีทั้งกลุ่ม ต้องตรวจcommissioningและprojectfinancingเพิ่มเติม [YTL]|
|Northern Data / Taiga|historical listed/acquiree; อยู่ในRUMprofile|ซื้อเข้ากลุ่มปี2026; สถานะdelistingสุดท้ายต้องยืนยันเพิ่ม ไม่อ้างว่าถอนจากตลาดแล้วเพียงเพราะดีลซื้อเสร็จ; ห้ามบวกงบซ้ำ [RUMdeal]|
|BluSky AI / BSAI|OTC / ระยะเริ่มต้น แยกจากexchange-listeduniverse|งบเดิมไม่ใช่สามปีGPUoperatingrecord; FY2025lossประมาณ4.516ล้านUSD ต้องตรวจfunding/commissioningก่อนวัดARR [BSAI]|
|Soluna / SLNH|adjacentpower/hosting|ต้องแยกสัญญาเช่าGPUที่สิ้นสุดกับธุรกิจhostingที่เหลือ; ยังไม่ได้ทำfullthree-yearprofileในฉบับนี้|
|TELUS, Telenor, Indosat, Ooredoo, du, BCE, KT, NHN, NAVER, FreedomHolding|กลุ่มlistedparentsที่อยู่ในขอบเขตค้นหาเพิ่มเติม|อาจมีsubsidiary/พันธมิตรขายAIcloud แต่ยังไม่ยืนยันmaterialityและsegmentfinancialsครบ จึงไม่นำงบtelecom/portalทั้งหมดมาอ้างว่าเป็นGPUcloud|
|AWS, Microsoft, Alphabet, Oracle, Alibaba, Tencent, Baidu|hyperscalers; นอกนิยามneocloudในฉบับนี้|อาจเป็นลูกค้า/คู่แข่ง/ผู้ให้ทุนที่ต้องอ่านสัญญา แต่ไม่เพิ่มเป็นneocloudทุกบริษัท|
|Lambda, Nscale, Crusoe, Fluidstack, Vultr, RunPod, Scaleway/Iliad|ไม่อยู่ในตารางหุ้นจดทะเบียนที่ยืนยันในชุดนี้|ห้ามถือว่าแผนIPO/บริษัทแม่ที่เคยlistedแปลว่าหุ้นGPUentityซื้อขายแล้ว ต้องตรวจสถานะล่าสุดก่อนเพิ่ม|
|Firmusและผู้ประกาศแผนIPO|ยังไม่นับเป็นบริษัทจดทะเบียนที่ยืนยัน|ข่าวเตรียมIPOไม่ใช่หลักฐานlistingเสร็จ|
|NVIDIA, AMD, Netwebและผู้ขายอุปกรณ์|supplier; นอกนิยามproviderหลัก|รายได้ขายเครื่องกับค่าเช่าcomputeมีการรับรู้/ความเสี่ยงต่างกัน|

ทะเบียนนี้ทำให้ขอบเขตตรวจสอบได้ แต่ไม่ใช่การรับประกันว่าครอบคลุมผู้ให้บริการทุกรายในทุกตลาด ภาษาและการเปิดเผยของบริษัทแม่ทำให้ความสมบูรณ์ของuniverseมีข้อจำกัด ชื่อที่ยังไม่มีprofileไม่ถือว่าได้รับการตรวจงบครบแล้ว

## 6. ข้อบกพร่องที่พบ กับคำถามที่ยังต้องพิสูจน์

|ประเภท|กรณีที่มีหลักฐานในงานนี้|ข้อสรุปที่ใช้ได้|ข้อสรุปที่ยังใช้ไม่ได้|
|---|---|---|---|
|ข้อผิดพลาดงบที่แก้ไข|CORZ PP&E/impairment; UCloudinterimtiming|ใช้comparativesที่แก้แล้ว; ตรวจremediation|สรุปว่าทั้งsectorมีfraud|
|ข้อผิดพลาดในบทวิเคราะห์เดิม|CRWVleaseถูกเสี่ยงบวกซ้ำ|แก้debtbridge|สรุปว่าบริษัทมีหนี้ต่ำ|
|การเปลี่ยนestimate|UCloudอายุGPU4→5; CRWV5→6ใน2023|ต้องทดสอบกับeconomiclife|สรุปว่าเปลี่ยนestimateผิดเสมอ|
|คุณภาพกำไร|DOCNtaxbenefit, NBISinvestmentgain, BTDRderivativegain|แยกรายการไม่เกิดซ้ำ/ไม่ใช้เงินสด|ถือว่าGAAPnetincomeคือGPUcashprofit|
|คุณภาพCFO|IRENเงินรับล่วงหน้า; companyworkingcapital|สร้างCFObridgeและdeliverycostforecast|CFOบวกแปลว่าไม่ต้องระดมทุน|
|โครงสร้างทุน|WULF/CIFRwarrants, APLDpreferred/JV|อ่านcashpriorityและdilution|นำliabilityทุกประเภทมาคูณดอกเบี้ยเดียวกัน|
|โครงสร้างข้อมูล|NBIS/GMO/HUT/RUM/MOVE/HIVE|ระบุperimeter/period/GAAPก่อนคำนวณgrowth|ต่อvendorhistoricalseriesโดยไม่ตรวจ|

**รายชื่อที่ควรอ่านก่อนตามประเด็น ไม่ใช่อันดับล้มละลาย:** CORZและUCloudสำหรับrestatement/control; CRWV/IREN/CHRN/E2Eสำหรับcapitalcycleและcashconversion; WULF/CIFR/APLDสำหรับเงื่อนไขค้ำและprojectfinance; QingCloudสำหรับlossต่อเนื่องกับequityที่บาง; RUM/MOVE/GMOสำหรับความเสี่ยงเทียบงบคนละกิจการ การไม่พบข้อผิดพลาดในบริษัทอื่นจากdeskreviewไม่ใช่การรับรองว่างบไม่มีข้อผิดพลาด

## 7. แบบจำลองทดสอบความไว: รายได้โตยังขาดเงินสดได้อย่างไร

ตัวอย่างต่อไปนี้เป็น **สมมติฐานเพื่ออธิบายกลไก** ไม่ใช่ประมาณการของบริษัทใด และไม่ใช้เป็นprice target: ลงทุนเครื่อง100หน่วย ไม่มีมูลค่าซาก อายุบัญชี5ปี ⇒ ค่าเสื่อม20ต่อปี; หากเปลี่ยนเป็น6ปี ค่าเสื่อม16.67 กำไรบัญชีเพิ่ม3.33ต่อปีโดยเงินสดยังไม่เพิ่ม หากใช้ทำเงินจริงได้เพียง3ปี ภาระต้นทุนทางเศรษฐกิจเฉลี่ยจะเป็น33.33ต่อปี

สมมติรายได้เต็มutilization100หน่วย ฐานใช้กำลัง80%จึงมีรายได้80 ค่าใช้จ่ายผันแปร25%ของรายได้ คงที่30 EBITDA=30 หลังหักดอกเบี้ย10และเงินทดแทนอุปกรณ์20 เหลือ0 ก่อนภาษี/workingcapital:

|สถานการณ์สมมติ|ราคาเทียบฐาน|Utilization|รายได้|EBITDA|หลังดอกเบี้ย10+ทดแทน20|
|---|---:|---:|---:|---:|---:|
|ฐาน|100%|80%|80.0|30.0|0.0|
|ราคาเช่าลด20%|80%|80%|64.0|18.0|-12.0|
|ราคาและการใช้งานลด|80%|60%|48.0|6.0|-24.0|
|ความต้องการเพิ่มแต่ราคาอ่อน|90%|90%|81.0|30.75|0.75|

สูตร: Revenue=100×pricefactor×utilization; EBITDA=Revenue×75%−30. เป็นmodelแบบผันแปรตามรายได้เพื่อให้เห็นoperatingleverage; ของจริงค่าไฟขึ้นกับworkload/พลังงานและต้นทุนเครือข่ายอาจคงที่ สัญญาtake-or-payช่วยลดความเสี่ยงปริมาณในช่วงที่บังคับใช้ แต่ต้องทดสอบtermination, uptimecredits, creditworthinessและราคาเมื่อrenew ไม่ควรเอาราคาspotมาปรับรายได้สัญญาระยะยาวทันทีทั้งบริษัท

## 8. สิ่งที่ควรสังเกตเพื่อคาดวัฏจักรธุรกิจ

วัฏจักรของneocloudมักปรากฏในลำดับ **เงินทุนและคำสั่งซื้อ → ติดตั้ง/เชื่อมไฟ → ลูกค้ารับมอบ → utilization/collection → ต่อสัญญา/เปลี่ยนเครื่อง** ไม่ใช่มีรายได้โตแล้วแปลว่าทุกขั้นแข็งแรงเท่ากัน

|สัญญาณ|แหล่งตรวจ|ความหมายที่เป็นไปได้|สิ่งที่อาจทำให้ตีความผิด|
|---|---|---|---|
|เงินรับล่วงหน้าใหม่ลด แต่capexcommitmentsยังสูง|CFstatement/deferredrevenue/commitments|ช่องว่างเงินทุนเริ่มกว้าง|milestoneของดีลใหญ่ไม่ลงทุกไตรมาส|
|ARโตเร็วกว่ารายได้หลายงวด|aging/DSO/contractassets|รับเงินช้าหรือจังหวะbillingเปลี่ยน|invoiceล่วงหน้าทำARและdeferredโตพร้อมกัน|
|RPOโตแต่revenueconversionช้า|contractnotes/projectacceptance|ติดpower/network/ส่งมอบ|RPOมีสัญญายาวขึ้นตามปกติ|
|ราคาเช่ารุ่นเดียวกันและrenewalpriceลด|ประกาศราคา/สัญญาที่เปิดเผย|supplyเริ่มมากกว่าdemandที่ราคาเดิม|ราคาต่อtokenอาจดีขึ้นจากประสิทธิภาพโดยmarginไม่ลด|
|เปลี่ยนอายุสินทรัพย์/impairmentถี่|accountingpolicies/estimates|แรงกดดันต่อผลตอบแทนเครื่องเก่า|เปลี่ยนmixเครื่องและusageอาจทำให้อายุยาวขึ้นจริง|
|supplierpayables/noncashcapexโต|PP&E/lease/cashflownotes|ขยายด้วยเครดิตผู้ขายมากขึ้น|จังหวะรับของปลายปี|
|undrawnfacilityมีเงื่อนไขเพิ่ม/interestspreadสูง|debtamendments|ผู้ให้กู้เข้มงวดขึ้น|อัตราดอกเบี้ยตลาดเปลี่ยนทั้งระบบ|
|อาคารเสร็จแต่customeracceptanceเลื่อน|subsequentevents/earnings|ส่งมอบไม่ทันสร้างต้นทุนก่อนรายได้|แค่เลื่อนเอกสารบางส่วนไม่ใช่เลิกโครงการ|
|leasecommencementแล้วแต่backstopยังมีข้อยกเว้น|creditenhancementcontracts|creditprotectionไม่เต็มมูลค่าสัญญา|ผู้ให้ค้ำชำระได้แต่สิทธิยังไม่ถึงเงื่อนไข|
|capexลดพร้อมcancelledordersและutilizationลด|หลายบริษัท+supplierorders|สัญญาณปลายcycleที่มีน้ำหนักมากขึ้น|capexลดเพราะbuildphaseเสร็จ ไม่ใช่demandทรุด|

อย่ากำหนดจุดกลับตัวจากตัวเดียว ควรเห็นอย่างน้อยหลายมิติที่สอดคล้องกันและยืนยันข้ามบริษัท/คู่ค้า เกณฑ์เช่นDSOเพิ่ม15วันหรือcapexcut20%สามารถใช้เป็นthresholdส่วนตัวได้ แต่ยังไม่ใช่thresholdที่พิสูจน์จากข้อมูลในรายงานนี้

## 9. ความเชื่อมโยงกับ SNDK / NAND: ข้อสังเกต ไม่ใช่คำทำนายราคา

สมมติฐานที่ต้องตรวจคือการเปิดAIclusterเพิ่มทำให้ต้องซื้อstorageมากขึ้น ผ่านOEM/ODMและระบบจัดเก็บ enterpriseSSD คำสั่งGPUที่ประกาศไม่เท่ากับยอดขายNANDของSNDKทันที เพราะสัดส่วนmemory/storageต่อcluster, การใช้เครื่องเดิม, แบรนด์ผู้จัดหาและinventoryในช่องทางต่างกัน รายงานนี้จึงไม่แก้target/stop/convictionของthesisNANDเดิม

**ตัวส่งผ่านที่สนับสนุนupcycle:** customeracceptanceและกำลังไฟพร้อมจริง → ติดตั้งserver/storage → enterpriseSSDshipmentsเพิ่ม → channelinventoryไม่ล้น → pricing/mixดีขึ้น หากneocloudเพียงเพิ่มbacklogแต่เปิดศูนย์ไม่ได้ การส่งผ่านอาจช้ากว่าที่ตลาดราคาไว้

**ตัวส่งผ่านที่เพิ่มdowncyclerisk:** เงินรับล่วงหน้า/financingสะดุดพร้อมกันหลายราย → เลื่อนcapex/ยกเลิกคำสั่งOEM → storageordersชะลอ → inventoryเพิ่มและpricepressure แต่การลดราคาGPUรุ่นเก่าเพียงอย่างเดียวไม่พิสูจน์NANDoversupply เพราะNANDยังมีdemandจากมือถือPCและenterpriseworkloadอื่น รวมถึงsupplydisciplineของผู้ผลิต

รายการติดตามที่เหมาะกับบันทึกเดิมคือ (1) capacityที่ส่งมอบเทียบกำหนด (2) เงินรับล่วงหน้าใหม่เทียบเงินลงทุนผูกพัน (3) การปรับคำสั่งซื้อserver/storage (4) enterpriseSSDmix/ASP/inventoryของผู้ผลิต (5) การเพิ่มกำลังผลิตNAND ใช้แต่ละข้อเป็นหลักฐานแยกแล้วค่อยอัปเดตthesisเมื่อเห็นห่วงโซ่ส่งผ่าน ไม่ใช้ความเสี่ยงneocloudเป็นข้อสรุปซื้อ/ขายSNDKทันที

## 10. ช่องว่างหลักฐานและงานที่ยังไม่อาจให้ความเห็นครบ

1. Corvex: ยังไม่reconcileprivateAIpredecessorสามปีกับreversemerger; ตารางlegacyMovanoใช้แทนไม่ได้
2. Rumble/NorthernData: มีannualRUMและdealfiling แต่ยังไม่ได้ทำTaiga/กิจการที่ซื้อย้อนหลังสามปีเต็มพร้อมpurchaseaccounting
3. WhiteFiber/SharonAI: ประวัติbusinessปัจจุบันสั้นกว่าสามปี ไม่มีเหตุให้สร้างปีที่ไม่มีขึ้นมา; ChronoScaleต้องreconcile2024carve-outเพิ่มเติม
4. GMO4784: สามปีก่อน/หลังรับโอนต่างperimeter และCFO2023ยังไม่ยืนยัน; Hut8ปี2023เป็นหกเดือน
5. Nebius: ตรวจตัวเลขXBRL/ผลประกอบการและการแยกdiscontinuedแล้ว แต่การอ่านหมายเหตุ20-Fทั้งหมดมีช่องว่าง; Japanบางแห่งใช้summariesแทนauditorreportเต็ม
6. เงินสดใช้ได้จริงในแต่ละprojectcompany, lenderborrowingbase, collateralhaircuts, utilizationและrentalrateตามรุ่น: ไม่เปิดเผยครบ จึงไม่สร้างคะแนนdefaultprobabilityหรือคาดวันเงินหมดแบบเที่ยงตรงเกินหลักฐาน
7. บริษัทแม่ที่มีGPUเป็นส่วนเล็กและผู้ให้บริการท้องถิ่นอื่น: อยู่ในcoveragewatchlist ไม่ถือว่าได้รับfullreviewแล้ว ขอบเขตโลกยังเปิดให้เติมเมื่อได้รายชื่อ/segmentfiling

ข้อจำกัดเหล่านี้ไม่ลบล้างข้อผิดพลาดที่ตรวจยืนยันได้ เช่นleasecountingของCRWVและrestatementของCORZ แต่จำกัดการขยายข้อสรุปไปทั้งอุตสาหกรรม

## 11. แหล่งข้อมูลและวิธีตรวจย้อนกลับ

แต่ละprofileมีลิงก์ตรงต้นทางและระบุbasis ตารางnumericเก็บใน `financial-review-data.json`; หลักฐานXBRLที่ดึงจากSECเก็บใน `evidence/` พร้อมaccession/form/period/tag เมื่อมี รายงานไม่ใช้ราคาหุ้นหรือmarketcapที่ไม่ได้ยืนยัน ณวันเดียวกันมาคำนวณranking

เอกสารฉบับนี้บันทึกเป็นanalysispageผ่านBloombergMCPและเชื่อมกับNANDFlashthesis โดยไม่แก้ข้อความthesis สถานะconvictionหรือราคาเป้าหมาย ข้อค้นพบที่ขัดกับKBเก่าเก็บเป็นหลักฐานใหม่และเชื่อมCONTRADICTS/REFINESเพื่อรักษาประวัติ
'''

def replace_refs(t):
 return re.sub(r'\[([A-Z][A-Za-z0-9]+)\](?!\()',lambda m:f'[{m[1]}]({S[m[1]]})' if m[1] in S else m[0],t)

def build():
 # Local overrides are documented with a source in the evidence log, never inferred.
 ov=BASE/'verified-overrides.json'
 if ov.exists():
  updates=json.loads(ov.read_text('utf8'))
  for c in C:
   if c['symbol'] in updates:c.update(updates[c['symbol']])
 intro=INTRO.replace('33 บริษัทจดทะเบียนที่จัดทำ profile','34 profiles: บริษัทจดทะเบียน33รายและ Northern Data ซึ่งเป็นกิจการที่ Rumble ซื้อเข้ากลุ่มอีกหนึ่งชุด').replace('private predecessor ของ Corvex, ประวัติ Taiga ก่อนควบรวม และบางงบ carve-out','บางงบ carve-out และบริษัทที่มีประวัติธุรกิจสั้นกว่าสามปี').replace('คำว่า33หมายถึงผู้ออกหลักทรัพย์33ราย ไม่ใช่33กลุ่มเศรษฐกิจอิสระ','จำนวน34 profilesรวม Northern Data เพื่ออ่านประวัติก่อนควบรวม และรวมบริษัทแม่ลูกบางคู่ จึงไม่ใช่34กลุ่มเศรษฐกิจอิสระ')
 outro=OUTRO.replace('ไม่รวม33profile','ไม่รวม34profiles').replace('ยังไม่ได้ทำfullthree-yearprofileในฉบับนี้','ยังไม่ได้ทำ full three-year profile ในฉบับนี้')
 outro=outro.replace('1. Corvex: ยังไม่reconcileprivateAIpredecessorสามปีกับreversemerger; ตารางlegacyMovanoใช้แทนไม่ได้','1. Corvex: ตรวจงบ audited OpCo แล้วทั้งปี2025และงวดตั้งกิจการ2024; ปี2023ไม่มีเพราะยังไม่ก่อตั้ง จึงไม่มีประวัติสามปีให้ตรวจและไม่ใช้ตัวเลขMovanoมาเติม')
 outro=outro.replace('2. Rumble/NorthernData: มีannualRUMและdealfiling แต่ยังไม่ได้ทำTaiga/กิจการที่ซื้อย้อนหลังสามปีเต็มพร้อมpurchaseaccounting','2. Rumble/NorthernData: ตรวจงบ RUM และงบ acquiree สามปีแยกแล้ว แต่ purchase accounting หลังควบรวมยังต้องติดตามงบรวมถัดไป; งบ Taiga ล้วนไม่เท่ากับงบ Northern Data ที่มี discontinued mining')
 outro=outro.replace('5. Nebius: ตรวจตัวเลขXBRL/ผลประกอบการและการแยกdiscontinuedแล้ว แต่การอ่านหมายเหตุ20-Fทั้งหมดมีช่องว่าง; Japanบางแห่งใช้summariesแทนauditorreportเต็ม','5. Nebius: อ่าน20-Fผ่านfilingmirrorและพบadverseICFRจากPP&E/TripleTen จึงต้องติดตามremediation; Japanบางแห่งยังใช้summariesแทนauditorreportเต็ม')
 out=[replace_refs(intro)]
 out+=['\n|บริษัท|ตลาด|ธุรกิจ|ฐานข้อมูล|\n|---|---|---|---|']
 for c in C:out.append(f"|[{c['name']} ({c['symbol']})](#{c['symbol'].lower()})|{c['market']}|{c['category']}|{c['coverage']}|")
 for i,c in enumerate(C,1):
  out.append(f"\n<a id=\"{c['symbol'].lower()}\"></a>\n\n### 4.{i} {c['name']} — {c['symbol']}\n\n**ตลาด:** {c['market']} · **ประเภท:** {c['category']} · **หน่วย:** ล้าน {c['currency']}\n\n{c['basis']}\n\n|ปีบัญชี|รายได้|กำไร/(ขาดทุน)สุทธิ|CFO|\n|---|---:|---:|---:|")
  for k,y in enumerate(c['years']):out.append(f"|{y}|{fmt(c['revenue'][k])}|{fmt(c['net_income'][k])}|{fmt(c['cfo'][k])}|")
  out.append(f"\n**ข้อเท็จจริงจากงบ:** {c['facts']}\n\n**การตีความทางบัญชี:** {c['analysis']}\n\n**สิ่งที่ต้องตรวจ/สังเกตต่อ:** {c['watch']}\n\n**ความครบถ้วน:** {c['coverage']}\n\n**ต้นทาง:** {cite(c['sources'])}\n")
 out.append(replace_refs(outro))
 out.append('\n### Source register\n\n|รหัส|เอกสารต้นทาง|\n|---|---|')
 for k,u in S.items():out.append(f'|{k}|[{k} — filing / annual report / company release]({u})|')
 md='\n'.join(out)
 (BASE/'neocloud-accounting-review-th.md').write_text(md,encoding='utf8')
 data={'as_of':'2026-09-19','unit':'millions of stated currency','null_means':'not verified / not comparable / no comparable period, NOT zero','companies':C,'sources':S,'profile_count':len(C),'scope':'Original ten plus worldwide listed providers/adjacent infrastructure identified; not a certified global census; gaps explicit'}
 (BASE/'financial-review-data.json').write_text(json.dumps(data,ensure_ascii=False,indent=2),encoding='utf8')
 print('profiles',len(C),'markdown chars',len(md),'missing annual cells',sum(v is None for c in C for k in ['revenue','net_income','cfo'] for v in c[k]))

if __name__=='__main__':build()
