# Flow Toxicity — วิธีคำนวณ

เอกสารนี้อธิบายนิยามทางคณิตศาสตร์ของ indicator พร้อมการพิสูจน์เอกลักษณ์ที่ใช้รองรับการตีความใน [interpretation.md](interpretation.md)

Implementation: [`components/bloomberg/chart/indicators/flow-toxicity.ts`](../../components/bloomberg/chart/indicators/flow-toxicity.ts)

---

## ขั้นตอนที่ 1: Input

```
รับ: OHLCV bars (OhlcvBar[]) — time, open, high, low, close, volume?
พารามิเตอร์: window W (default 50), hotThreshold θ (default 0.15)
```

`volume` เป็น optional field ตาม type definition — การจัดการกรณีไม่มี volume อยู่ในหัวข้อ [Edge Cases](#edge-cases)

---

## ขั้นตอนที่ 2: Per-bar Classifier

### 2.1 การ anchor ด้วย previous close

ปัญหาของการใช้เฉพาะ high/low ของแท่งเดียวคือ **มองไม่เห็น gap** แท่งที่ gap ลง 10% แล้วปิดใกล้ high ของตัวเองจะถูกจัดเป็นแรงซื้อสูงสุด ทั้งที่วันนั้นราคาพังยับ

จึงขยายช่วงให้ครอบ close ก่อนหน้า (แนวคิดเดียวกับ True Range):

$$hi_i = \max(high_i,\ close_{i-1}) \qquad lo_i = \min(low_i,\ close_{i-1})$$

### 2.2 Buy fraction และ flow

$$buyFrac_i = \frac{close_i - lo_i}{hi_i - lo_i} \in [0, 1]$$

$$flow_i = 2 \cdot buyFrac_i - 1 = \frac{2 \cdot close_i - hi_i - lo_i}{hi_i - lo_i} \in [-1, 1]$$

- $flow_i = +1$ → ปิดที่จุดสูงสุดของช่วง = แรงซื้อล้วน
- $flow_i = -1$ → ปิดที่จุดต่ำสุดของช่วง = แรงขายล้วน
- $flow_i = 0$ → ปิดกลางช่วง = สมดุล

### 2.3 คุณสมบัติ backward compatibility

เมื่อ $close_{i-1} \in [low_i,\ high_i]$ (กรณีไม่มี gap ซึ่งเป็นส่วนใหญ่) จะได้ $hi_i = high_i$ และ $lo_i = low_i$ ทำให้สูตร**ลดรูปกลับเป็น close-position weighting แบบเดิมพอดี**

ตรวจสอบเชิงตัวเลขแล้ว: บนแท่งที่ไม่ gap ค่าต่างจากสูตรเดิม = `0.000e+0` (400 แท่ง)

ผลคือยังคง consistent กับ classifier ของ Volume Profile delta mode ([`volume-profile.ts:148-154`](../../components/bloomberg/chart/indicators/volume-profile.ts)) ในทุกกรณีที่ไม่ใช่ gap

---

## ขั้นตอนที่ 3: Rolling Aggregation

### 3.1 น้ำหนัก

ให้ $w_i$ = volume ของแท่ง $i$ และ normalize บนหน้าต่างขนาด $W$:

$$p_i = \frac{w_i}{\sum_{j \in \text{window}} w_j} \qquad \text{โดย} \sum_i p_i = 1,\quad p_i \ge 0$$

$\{p_i\}$ จึงเป็น probability distribution — ทำให้เขียนทั้งสองปริมาณเป็น expectation ได้

### 3.2 นิยามสองปริมาณหลัก

$$\boxed{N = \sum_i p_i \cdot flow_i = \mathbb{E}[flow]} \qquad \in [-1, 1]$$

$$\boxed{T = \sum_i p_i \cdot \lvert flow_i \rvert = \mathbb{E}\big[\lvert flow \rvert\big]} \qquad \in [0, 1]$$

| ปริมาณ | ชื่อในโค้ด | แสดงผลเป็น |
|--------|-----------|-----------|
| $N$ | `netFlow` | histogram (ความสูง $\lvert N \rvert$, สีตามเครื่องหมาย) |
| $T$ | `toxicity` | เส้นสีม่วง |

**หมายเหตุเชิงวรรณกรรม:** $N$ เทียบเท่า Chaikin Money Flow ทุกประการเมื่อไม่มี gap เพราะ Money Flow Multiplier ของ CMF คือ $\frac{(C-L)-(H-C)}{H-L}$ ซึ่งเท่ากับ $2 \cdot buyFrac - 1$ พอดี (ตรวจสอบแล้ว: ต่างกันสูงสุด $8.8 \times 10^{-16}$ บน 451 แท่ง)

ส่วน $T$ ใช้วิธีรวมค่าสัมบูรณ์ก่อนเฉลี่ย ซึ่งเป็น aggregation แบบเดียวกับ VPIN

### 3.3 Sliding window implementation

คำนวณแบบ incremental เพื่อให้ได้ $O(n)$ แทน $O(n \cdot W)$:

```
sumW      += w[i];         ถ้า i >= W:  sumW      -= w[i-W]
sumFlow   += w[i]*flow[i];              sumFlow   -= w[i-W]*flow[i-W]
sumAbsFlow+= w[i]*|flow[i]|;            sumAbsFlow-= w[i-W]*|flow[i-W]|
```

ที่ index $i \ge W-1$ และ `sumW > 0` จึงคำนวณ $N = \frac{\text{sumFlow}}{\text{sumW}}$, $T = \frac{\text{sumAbsFlow}}{\text{sumW}}$

ตรวจสอบแล้วว่า sliding sum ให้ผลตรงกับการ recompute แบบ brute force ทุกจุด

---

## ขั้นตอนที่ 4: การแยกส่วน (Decomposition)

นี่คือหัวใจที่ทำให้ตีความได้ แยก flow เป็นแรงซื้อและแรงขาย:

$$B = \sum_{flow_i > 0} p_i \cdot flow_i \ \ge 0 \qquad\qquad S = \sum_{flow_i < 0} p_i \cdot \lvert flow_i \rvert \ \ge 0$$

จากนิยามได้ทันที:

$$\boxed{T = B + S} \qquad\qquad \boxed{N = B - S}$$

> **เส้นม่วงคือแรงรวมของทั้งสองฝั่ง ส่วนแท่งคือผลต่าง**

---

## ขั้นตอนที่ 5: เอกลักษณ์ที่ใช้ตีความ

### 5.1 ช่องว่างระหว่างเส้นม่วงกับแท่ง

จาก $\lvert B-S \rvert = \max(B,S) - \min(B,S)$ และ $B+S = \max(B,S) + \min(B,S)$:

$$\boxed{\text{gap} = T - \lvert N \rvert = 2\min(B, S)}$$

> **ช่องว่าง = สองเท่าของแรงฝั่งที่แพ้**

นี่คือเหตุผลเชิงคณิตศาสตร์ที่ทำให้ "ช่องว่างแคบ = ฝั่งเดียวคุมเกม" เป็นข้อความที่แม่นยำ ไม่ใช่การเปรียบเปรย

### 5.2 สมการงบประมาณ

$$\boxed{\underbrace{\lvert N \rvert}_{\text{แรงที่รอดจากการหักล้าง}} + \underbrace{2\min(B,S)}_{\text{แรงที่หักล้างกันไป}} = \underbrace{T}_{\text{แรงทั้งหมด}} \le 1}$$

ผลตามมา: ความสูงของแท่งกับความกว้างของช่องว่าง **แลกกันเสมอ** ภายใต้งบ $T$ ที่มีจำกัด

### 5.3 อสมการสามเหลี่ยม

$$\lvert N \rvert = \lvert \mathbb{E}[flow] \rvert \ \le\ \mathbb{E}\big[\lvert flow \rvert\big] = T$$

เท่ากันก็ต่อเมื่อ $\min(B,S) = 0$ นั่นคือ **ทุกแท่งในหน้าต่างเอียงไปทางเดียวกันหมด**

ทดสอบกรณีนี้แล้ว: หน้าต่างที่ทุกแท่งปิดที่ high ได้ $\lvert N \rvert = T = 1.000000$, gap $= 0.00 \times 10^0$

### 5.4 Directional Efficiency

นิยามอัตราส่วนไร้หน่วย:

$$D = \frac{\lvert N \rvert}{T} \in [0, 1] \qquad (T > 0)$$

พลิกกลับได้เป็นสัดส่วนและอัตราต่อรอง:

$$\frac{\max(B,S)}{T} = \frac{1+D}{2} \qquad\qquad \frac{\max(B,S)}{\min(B,S)} = \frac{1+D}{1-D}$$

$D$ ตอบคำถามว่า *"แรงทั้งหมดที่เกิดขึ้น มีสัดส่วนเท่าไหร่ที่ดึงไปทางเดียวกัน"* — ดูการนำไปใช้ใน [interpretation.md](interpretation.md#directional-efficiency)

> **หมายเหตุ:** $D$ ยังไม่ได้ implement ในโค้ดปัจจุบัน เป็นปริมาณอนุพัทธ์ที่คำนวณได้จากสองชุดที่แสดงอยู่แล้ว

---

## การตรวจสอบเอกลักษณ์

ทดสอบทั้งหมดบน 5,853 หน้าต่าง ครอบคลุม 3 regime (flat / uptrend / downtrend) ด้วย window = 50

| # | เอกลักษณ์ | ผล |
|---|-----------|-----|
| ID-1 | $T = B + S$ | 5853/5853 |
| ID-2 | $N = B - S$ | 5853/5853 |
| ID-3 | $\text{gap} = T - \lvert N \rvert = 2\min(B,S)$ | 5853/5853 |
| ID-4 | $\lvert N \rvert + \text{gap} = T$ | 5853/5853 |
| ID-5 | $\max(B,S)/T = (1+D)/2$ | 5853/5853 |
| ID-6 | $\max(B,S)/\min(B,S) = (1+D)/(1-D)$ | 5853/5853 |
| ID-7 | $D \in [0,1]$ | 5853/5853 |

tolerance $= 10^{-12}$

**ข้อควรระวัง:** การทดสอบเหล่านี้ยืนยัน *ความถูกต้องเชิงพีชคณิต* ของ implementation เท่านั้น ไม่ได้ยืนยันว่า indicator มีคุณค่าเชิงทำนายในตลาดจริง (ดู [ข้อจำกัด](README.md#ข้อจำกัดสำคัญ-อ่านก่อนใช้))

---

## Edge Cases

| กรณี | การจัดการ | เหตุผล |
|------|-----------|--------|
| $hi_i - lo_i = 0$ | $flow_i = 0$ | แท่งกับ close ก่อนหน้าเป็นราคาเดียวกัน = ไม่มีข้อมูลจริง จึงถือว่าสมดุลแทนการเดา |
| แท่งแรก ($close_{i-1}$ ไม่มี) | ใช้ $high_i, low_i$ ตรงๆ | ไม่มี anchor ให้ใช้ |
| `volume` undefined ทั้งชุด | fallback เป็น $w_i = 1$ ทุกแท่ง | ป้องกัน pane ว่างเปล่าแบบเงียบๆ ในฟีดที่ไม่มี volume (index/FX) — degrade เป็นค่าเฉลี่ยรูปทรงราคาแบบไม่ถ่วงน้ำหนัก |
| แท่งเดี่ยว volume = 0 ในฟีดที่มี volume | ไม่นับ (น้ำหนัก 0) | ถูกต้องตามนิยาม weighted average |
| `sumW` = 0 | คืน `toxicity: null` | ป้องกันหารด้วยศูนย์ |
| $i < W-1$ (warm-up) | คืน `toxicity: null` | ยังไม่ครบหน้าต่าง |

`null` จะไม่ถูก push เข้า series ทำให้ chart แสดงช่องว่างแทนค่าปลอม

---

## ความซับซ้อน

| ด้าน | ค่า |
|------|-----|
| เวลา | $O(n)$ — sliding window, ไม่ขึ้นกับ $W$ |
| หน่วยความจำ | $O(n)$ — เก็บ 3 array ความยาว $n$ |

`compute()` เป็น pure function ตาม contract ของ `ChartIndicator` (stateless, deterministic)
