import os,json,re,sys
from pathlib import Path
p=Path(os.environ['TEMP'])/'codex-neocloud-audit-20260919'
qs={'IONOS25':r'net income for the period|net cash.*operating|total revenue|Net cash provided',
'KC25':r'Total revenues|Net cash.*operating activities|Net loss attributable|capital expenditures of|Xiaomi accounted',
'E2E26':r'Net cash flow from operating|Profit/.*year|Net cash|Purchase of fixed|Depreciation and amort',
'DATASECTION26':r'Status of Assets and Profit|Net Sales|Ordinary Profit|Profit Attributable to Owners',
'NBIS25results':r'Net cash|Provided by|continuing operations',
'OVH25':r'Net cash flows from operating|Net income|Revenue.*1,08|1,084|519.1',
'DUG26':r'Revenue|Net cash.*operating|Profit for|Loss for'}
for k,pat in qs.items():
 print('\n###',k)
 ls=(p/(k+'.txt')).read_text('utf-8').splitlines()
 matches=[i for i,l in enumerate(ls) if re.search(pat,l,re.I)]
 for i in matches[:16]:print(' '.join(ls[max(0,i-1):i+3])[:600])

