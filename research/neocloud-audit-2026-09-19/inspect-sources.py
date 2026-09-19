import os,sys,re
from pathlib import Path
root=Path(os.environ['TEMP'])/'codex-neocloud-audit-20260919'
for item in sys.argv[1:]:
 k,pat=item.split('::',1)
 p=root/(k+'.txt')
 if not p.exists():print(k,'MISSING');continue
 t=p.read_text('utf-8');matches=list(re.finditer(pat,t,re.I))
 print('\n###',k,pat,'matches=',len(matches))
 for m in matches[:4]:print(t[max(0,m.start()-90):m.start()+1000].replace('\n',' '))
