# Flow Toxicity — บรรณานุกรมและความเชื่อมโยงกับวรรณกรรม

เอกสารนี้รวบรวมงานอ้างอิงที่เกี่ยวข้อง พร้อมระบุ **อย่างชัดเจนว่า implementation ในระบบนี้ตรงหรือไม่ตรงกับแต่ละงานอย่างไร** เพื่อไม่ให้เกิดการอ้างอิงเกินจริง

---

## 1. สายทฤษฎี Order Flow Toxicity

### 1.1 PIN — ต้นกำเนิดแนวคิด

> Easley, D., Kiefer, N. M., O'Hara, M., & Paperman, J. B. (1996). **Liquidity, Information, and Infrequently Traded Stocks.** *The Journal of Finance*, 51(4), 1405–1436.
> [Wiley](https://onlinelibrary.wiley.com/doi/abs/10.1111/j.1540-6261.1996.tb04074.x) · [SSRN](https://papers.ssrn.com/sol3/papers.cfm?abstract_id=7881)

เสนอ **Probability of Informed Trading (PIN)** เป็นครั้งแรก ประมาณสัดส่วนของ trade ที่มาจากผู้มีข้อมูลภายใน ผลเชิงประจักษ์สำคัญคือ PIN ต่ำกว่าในหุ้นที่มี volume สูง

**ความเกี่ยวข้องกับระบบนี้:** เป็นรากของแนวคิด "toxicity" เท่านั้น ระบบนี้**ไม่ได้ประมาณ PIN** และไม่มีการ estimate พารามิเตอร์ใดๆ ของโมเดล

---

### 1.2 VPIN — งานที่ indicator นี้ตั้งชื่อตาม

> Easley, D., López de Prado, M. M., & O'Hara, M. (2012). **Flow Toxicity and Liquidity in a High-frequency World.** *The Review of Financial Studies*, 25(5), 1457–1493.
> [Oxford Academic](https://academic.oup.com/rfs/article-abstract/25/5/1457/1569929) · [SSRN](https://papers.ssrn.com/sol3/papers.cfm?abstract_id=1695596) · [PDF (NYU Stern)](https://www.stern.nyu.edu/sites/default/files/assets/documents/con_035928.pdf)

เสนอ **VPIN (Volume-Synchronized Probability of Informed Trading)** สาระสำคัญ:

- คำนวณใน **volume time** — แบ่งเป็น bucket ที่มี volume เท่ากัน ไม่ใช่ช่วงเวลาเท่ากัน
- ไม่ต้อง estimate พารามิเตอร์ที่สังเกตไม่ได้ ไม่ต้องใช้ numerical method
- รวมแบบ $\text{VPIN} = \dfrac{\sum_{\tau=1}^{n} \lvert V^{buy}_\tau - V^{sell}_\tau \rvert}{n \cdot V}$ — **ผลรวมของค่าสัมบูรณ์รายbucket**
- แสดงหลักฐานว่า VPIN สูงขึ้นในชั่วโมงก่อน flash crash 6 พ.ค. 2010 และเชื่อมโยงกับการถอนสภาพคล่องของ market maker

**ความเกี่ยวข้องกับระบบนี้ — ตรงบางส่วนเท่านั้น:**

| ประเด็น | VPIN ตามบทความ | ระบบนี้ |
|---------|----------------|---------|
| หน่วยเวลา | equal-volume buckets | **time bars** ❌ |
| การรวม | $\sum \lvert \cdot \rvert$ ต่อ bucket | $\sum \lvert \cdot \rvert$ ต่อแท่ง ✅ (ตรงกันหลังการแก้ไข) |
| Classifier | BVC (ดู §1.3) | Close Location Value ❌ |
| Normalization | หารด้วย $n \cdot V$ | weighted average ด้วย volume ✅ (สมมูล) |

การรวมแบบค่าสัมบูรณ์คือจุดที่ implementation เดิม**ทำผิด** (ใช้ $\lvert \sum \cdot \rvert$ แทน $\sum \lvert \cdot \rvert$) ทำให้แรงซื้อขายที่สลับทิศหักล้างกันหมด ปัจจุบันแก้แล้ว

---

### 1.3 BVC — วิธีจำแนกฝั่ง trade จากข้อมูลรวม

> Easley, D., López de Prado, M. M., & O'Hara, M. (2016). **Discerning Information from Trade Data.** *Journal of Financial Economics*, 120(2), 269–285.
> [ScienceDirect](https://www.sciencedirect.com/science/article/abs/pii/S0304405X16000246) · [SSRN](https://papers.ssrn.com/sol3/papers.cfm?abstract_id=1989555) · [RePEc](https://econpapers.repec.org/RePEc:eee:jfinec:v:120:y:2016:i:2:p:269-285)

เปรียบเทียบ **Bulk Volume Classification (BVC)** กับ Tick Rule และ Aggregated Tick Rule พบว่า tick rule จำแนก aggressor side ได้แม่นกว่า แต่ **BVC เชื่อมโยงกับ proxy ของ information-based trading ได้ดีกว่า**

BVC จำแนกโดยใช้ CDF ของการเปลี่ยนแปลงราคาระหว่างช่วง:

$$V^{buy}_\tau = V_\tau \cdot Z\!\left(\frac{P_\tau - P_{\tau-1}}{\sigma_{\Delta P}}\right)$$

โดย $Z$ คือ CDF ของ standard normal หรือ Student-t

**ความเกี่ยวข้องกับระบบนี้ — ไม่ตรง:** ระบบนี้ใช้ตำแหน่ง close ภายในช่วง high–low ของแท่ง ไม่ใช่ CDF ของ $\Delta P$ จึงเป็นคนละ classifier กัน docstring เวอร์ชันเก่าอ้างว่าใช้ BVC ซึ่งไม่ถูกต้อง และได้แก้ไขแล้ว

อย่างไรก็ตาม การ anchor ด้วย $close_{i-1}$ ที่เพิ่มเข้ามาภายหลัง (ดู [calculation.md §2.1](calculation.md#21-การ-anchor-ด้วย-previous-close)) ทำให้สูตร**ขยับเข้าใกล้เจตนาของ BVC มากขึ้น** ตรงที่เริ่มคำนึงถึงการเคลื่อนไหวระหว่างแท่ง ไม่ใช่แค่ภายในแท่ง

---

### 1.4 ข้อวิพากษ์ VPIN

> Andersen, T. G., & Bondarenko, O. (2014). **VPIN and the Flash Crash.** *Journal of Financial Markets*, 17(1), 1–46.
> [SSRN](https://papers.ssrn.com/sol3/papers.cfm?abstract_id=1881731) · [Northwestern Scholars](https://www.scholars.northwestern.edu/en/publications/vpin-and-the-flash-crash-2)

ใช้ tick data ของ S&P 500 futures พบว่า:

- VPIN เป็นตัวทำนายความผันผวนระยะสั้นที่**ไม่ดี**
- ค่าสูงสุดตลอดกาลเกิด**หลัง** flash crash ไม่ใช่ก่อน
- VPIN สหสัมพันธ์กับ trading volume และ return volatility **โดยโครงสร้างของสูตรเอง** (by construction)

บทความนี้จุดชนวนการโต้แย้งทางวิชาการ มีทั้งการตอบโต้จากผู้พัฒนา VPIN และบทสังเคราะห์ตามมา:

> Andersen, T. G., & Bondarenko, O. (2013). **Reflecting on the VPIN Dispute.** *Journal of Financial Markets*.
> [PDF (CREATES)](https://repec.econ.au.dk/repec/creates/rp/13/rp13_42.pdf)

> Easley, D., López de Prado, M. M., & O'Hara, M. (2017). **An Improved Version of the Volume-Synchronized Probability of Informed Trading.** *Critical Finance Review*, 6, 377–379.
> [PDF](https://cfr.ivo-welch.info/published/papers/easley2017improved.pdf)

**ความเกี่ยวข้องกับระบบนี้ — สำคัญมาก:** ข้อวิพากษ์นี้ใช้กับระบบนี้**ยิ่งกว่า** VPIN ตัวจริง เพราะระบบนี้เป็นเพียงค่าประมาณจากรูปทรงแท่ง ไม่ควรใช้เป็นสัญญาณทำนายโดยลำพัง

---

## 2. สายการจำแนกทิศทาง Trade

> Lee, C. M. C., & Ready, M. J. (1991). **Inferring Trade Direction from Intraday Data.** *The Journal of Finance*, 46(2), 733–746.
> [Wiley](https://onlinelibrary.wiley.com/doi/full/10.1111/j.1540-6261.1991.tb02683.x)

อัลกอริทึมมาตรฐานสำหรับจำแนกว่า trade เป็น buy หรือ sell จาก intraday data โดยเทียบราคากับ quote ที่มีผลและราคาก่อนหน้า (tick test) รายงานความแม่นยำราว 85% บนข้อมูลต้นทศวรรษ 1990

**ความเกี่ยวข้องกับระบบนี้:** เป็น**สิ่งที่ระบบนี้ทำไม่ได้** เพราะไม่มี tick/quote data ทั้งหมดที่ทำได้คือประมาณจาก OHLCV ซึ่งหยาบกว่ามาก ใช้เป็นจุดอ้างอิงว่าความแม่นยำที่แท้จริงควรอยู่ระดับไหน

---

## 3. สายทฤษฎี Market Microstructure

> Kyle, A. S. (1985). **Continuous Auctions and Insider Trading.** *Econometrica*, 53(6), 1315–1335.
> [Econometric Society](https://www.econometricsociety.org/publications/econometrica/1985/11/01/continuous-auctions-and-insider-trading)

โมเดลพลวัตของ insider trading ที่มีผู้เล่นสามประเภท (insider, noise traders, market makers) ให้กำเนิด **Kyle's lambda** ($\lambda$) — ตัววัด price impact ที่แปรผกผันกับสภาพคล่อง โดย $\Delta p = \lambda \cdot v$ เมื่อ $v$ คือ signed volume

**ความเกี่ยวข้องกับระบบนี้:** ให้กรอบทฤษฎีว่าเหตุใด **order flow imbalance จึงเชื่อมโยงกับ price impact และต้นทุนการเทรด** — เป็นเหตุผลเชิงทฤษฎีที่รองรับการใช้ indicator นี้เป็นเครื่องมืออ่าน execution cost มากกว่าใช้ทำนายทิศทาง

---

## 4. สายเทคนิคอล (ที่สูตรตรงกับของจริง)

### 4.1 Accumulation/Distribution Line และ Close Location Value

พัฒนาโดย **Marc Chaikin** แนวคิดหลักคือ *ระดับที่ close ปิดเทียบกับ high–low ของช่วง บ่งบอกแรงซื้อหรือแรงขาย*

Close Location Value (เรียกอีกชื่อว่า Money Flow Multiplier):

$$\text{CLV} = \frac{(C - L) - (H - C)}{H - L} \in [-1, +1]$$

- [StockCharts ChartSchool — Accumulation/Distribution Line](https://chartschool.stockcharts.com/table-of-contents/technical-indicators-and-overlays/technical-indicators/accumulation-distribution-line)
- [TradingView — Accumulation Distribution (ADL)](https://www.tradingview.com/support/solutions/43000501770-accumulation-distribution-adl/)

### 4.2 Chaikin Money Flow (CMF)

พัฒนาโดย Marc Chaikin ในทศวรรษ 1980 คือผลรวมของ Money Flow Volume หารด้วยผลรวม volume ตลอด $n$ ช่วง:

$$\text{CMF}_n = \frac{\sum_{i=1}^{n} \text{CLV}_i \cdot V_i}{\sum_{i=1}^{n} V_i}$$

- [StockCharts ChartSchool — Chaikin Money Flow](https://chartschool.stockcharts.com/table-of-contents/technical-indicators-and-overlays/technical-indicators/chaikin-money-flow-cmf)
- [TradingView — Chaikin Money Flow](https://www.tradingview.com/support/solutions/43000501974-chaikin-money-flow-cmf/)
- [Corporate Finance Institute — CMF](https://corporatefinanceinstitute.com/resources/equities/chaikin-money-flow-cmf/)

**ความเกี่ยวข้องกับระบบนี้ — ตรงทุกประการ:**

ปริมาณ `netFlow` ($N$) ของ indicator นี้ **เท่ากับ CMF ทางคณิตศาสตร์** เมื่อไม่มี gap เพราะ

$$2 \cdot buyFrac - 1 = 2\frac{C-L}{H-L} - 1 = \frac{2C - L - H}{H-L} = \frac{(C-L)-(H-C)}{H-L} = \text{CLV}$$

ตรวจสอบเชิงตัวเลขแล้ว: ต่างกันสูงสุด $8.8 \times 10^{-16}$ บน 451 แท่ง (คือ floating-point noise ล้วนๆ)

**ข้อสรุปที่สำคัญ:** งานอ้างอิงที่ตรงกับสูตรจริงของ `netFlow` คือสายของ Chaikin ไม่ใช่สายของ Easley/López de Prado/O'Hara ส่วนที่ยืมมาจากสาย VPIN จริงๆ คือ *วิธีรวมแบบค่าสัมบูรณ์* ที่ใช้สร้าง `toxicity` เท่านั้น

---

## 5. สรุปการอ้างอิงอย่างซื่อตรง

| ส่วนประกอบ | อ้างอิงที่ถูกต้อง | อ้างอิงที่**ไม่ควร**อ้าง |
|-----------|-------------------|--------------------------|
| Classifier (CLV + gap anchor) | Chaikin (A/D Line); แนวคิด True Range | BVC ของ Easley et al. (2016) |
| `netFlow` ($N$) | Chaikin Money Flow | VPIN |
| `toxicity` ($T$) | วิธีรวมแบบ VPIN (Easley et al., 2012) — เฉพาะการรวม | VPIN เต็มรูปแบบ (ต่างที่ volume bucket + classifier) |
| เหตุผลว่าทำไม imbalance สำคัญ | Kyle (1985); Easley et al. (1996) | — |
| ข้อควรระวังเรื่อง predictive power | Andersen & Bondarenko (2014) | — |

> **หลักการ:** เมื่ออธิบาย indicator นี้ให้ผู้อื่น ควรเรียกว่า *"CMF-based order-flow one-sidedness ที่ยืมวิธีรวมแบบ VPIN"* ไม่ควรเรียกว่า *"VPIN"* เฉยๆ เพราะจะทำให้เข้าใจผิดทั้งเรื่องระเบียบวิธีและเรื่องความน่าเชื่อถือเชิงประจักษ์
