# การวิเคราะห์และตีความ Sector Regime Detection

**เวอร์ชัน:** 2.0  
**วันที่ปรับปรุง:** 2026-06-04  
**ระบบ:** Bloomberg Terminal — Sector Regime Panel (MKT View)

---

## บทคัดย่อ

เอกสารนี้อธิบายหลักการทางคณิตศาสตร์ วิธีการตีความ และแนวทางการนำผลการวิเคราะห์ไปใช้ในการตัดสินใจลงทุน สำหรับระบบ Sector Regime Detection ที่ใช้ข้อมูลผลตอบแทนรายวันของ US Sector SPDR ETFs จำนวน 11 กองทุน ระบบบูรณาการสองแนวทางเชิงคณิตศาสตร์ ได้แก่ (1) CORR Mode ซึ่งวัดความสัมพันธ์เฉลี่ยแบบคู่ (average pairwise correlation) โดยมีการปรับ threshold ด้วย Markov Regime Switching (Hamilton, 1989; Ang & Bekaert, 2002) และ (2) GEOM Mode ซึ่งวัดปริมาตรเชิงเรขาคณิตของ return vector space โดยอาศัยกรอบของ Random Matrix Theory (Laloux et al., 1999; Plerou et al., 2002) ทั้งสองแนวทางให้ข้อมูลเชิงโครงสร้างที่แตกต่างกัน และให้ผลการตีความที่สมบูรณ์ที่สุดเมื่อนำมาพิจารณาร่วมกัน

---

## สารบัญ

1. [โครงสร้างการแสดงผล](#1-โครงสร้างการแสดงผล)
2. [CORR Mode: การวิเคราะห์ด้วย Pearson Correlation](#2-corr-mode)
3. [GEOM Mode: การวิเคราะห์ด้วย Geometric Volume](#3-geom-mode)
4. [ทฤษฎีเชิงคณิตศาสตร์](#4-ทฤษฎีเชิงคณิตศาสตร์)
5. [การจำแนก Regime และ Label](#5-การจำแนก-regime-และ-label)
6. [Trend Strip: การวิเคราะห์ Regime Momentum](#6-trend-strip)
7. [การ Calibrate Threshold](#7-การ-calibrate-threshold)
8. [การรวม Δ กับ MRS Transition Probabilities](#8-การรวม-delta-กับ-mrs)
9. [RMT Supplementary Analysis: k_signal และ factor_regime](#9-rmt-supplementary)
10. [กรณีศึกษาเชิงประวัติศาสตร์](#10-กรณีศึกษา)
11. [ข้อจำกัดของระบบ](#11-ข้อจำกัด)
12. [สรุปแนวทางการตัดสินใจ](#12-สรุป)
13. [บรรณานุกรม](#13-บรรณานุกรม)

---

## 1. โครงสร้างการแสดงผล

### 1.1 การอ่านค่าหลัก

Regime Panel แสดงผลในรูปแบบดังนี้:

```
◉ TRENDING  0.427
   ↑            ↑
 label       score
```

**score** แสดงถึงความรุนแรงของ regime ในเชิงต่อเนื่อง ไม่ใช่ค่าแบบ binary โดย score ที่อยู่ใกล้ขอบเขต threshold มีนัยสำคัญต่างจาก score ที่อยู่กึ่งกลางของช่วง

**label** เป็นการแปลง score ให้อยู่ในรูปของหมวดหมู่ discrete สี่ระดับ (DIVERGENT, TRENDING/MIXED, RISK-OFF, CRISIS/CORRELATED) เพื่อความสะดวกในการตีความ

### 1.2 Lookback Period และผลต่อ Score

ระบบรองรับการวิเคราะห์ใน 4 ช่วงเวลา ซึ่งให้มุมมองที่แตกต่างกัน:

| Period | ลักษณะ | การใช้งานที่เหมาะสม |
|--------|--------|-------------------|
| 1M (1 เดือน) | Responsive สูง แต่มี noise มาก | ตรวจจับการเปลี่ยนแปลง regime ระยะสั้น |
| 3M (3 เดือน) | สมดุลระหว่าง responsiveness และ stability | ค่า default สำหรับการวิเคราะห์ทั่วไป |
| 6M (6 เดือน) | Smooth กว่า มี lag มากกว่า | ยืนยัน trend ระยะกลาง |
| 1Y (1 ปี) | ภาพรวม structural regime | กำหนด baseline ระยะยาว |

เมื่อ 1M และ 1Y ให้ label ที่แตกต่างกัน แสดงว่า regime กำลังอยู่ในช่วง transition ซึ่งต้องพิจารณาร่วมกับ Trend Strip (ดูหัวข้อ 6)

---

## 2. CORR Mode

### 2.1 การอ่าน Correlation Matrix

Matrix ในมุมมอง CORR แสดง Pearson correlation coefficient (ρ) ระหว่างทุกคู่ sector โดยแต่ละ cell แทนความสัมพันธ์ระหว่าง sector ในแถวและคอลัมน์นั้น

**รหัสสี:**
- แดง/ส้ม: ความสัมพันธ์เชิงบวก (sectors เคลื่อนไหวในทิศทางเดียวกัน)
- ดำ: ไม่มีความสัมพันธ์
- น้ำเงิน: ความสัมพันธ์เชิงลบ (sectors เคลื่อนไหวสวนทางกัน)

**ตารางตีความ:**

| ลักษณะที่สังเกตเห็น | นัยสำคัญ |
|--------------------|---------|
| XLK–XLF มีสีแดงเข้ม | Technology และ Financials เคลื่อนไหวร่วมกัน — มักเกิดในช่วง credit-driven rally หรือ broad risk-off |
| XLE–XLU มีสีน้ำเงิน | Energy และ Utilities เคลื่อนไหวสวนทาง — สะท้อน yield-sensitive vs. commodity dynamic |
| แถว XLE ส่วนใหญ่มีค่าต่ำหรือเป็นลบ | Energy ถูกขับเคลื่อนโดย oil price dynamics ที่แยกออกจาก equity market |
| Matrix ทั้งหมดมีสีแดงเข้ม | Systematic co-movement — หลักฐานของ panic หรือ forced deleveraging |

### 2.2 CORR Score และ Regime Label

CORR score คือค่าเฉลี่ยของ $|\rho_{ij}|$ ทุกคู่ (ดูนิยามทางคณิตศาสตร์ในหัวข้อ 4.1) threshold ที่ใช้จำแนก label ได้รับการปรับ calibrate ด้วย 4-state Gaussian HMM:

```
score < τ₁              →  DIVERGENT  — sectors เป็นอิสระต่อกัน
τ₁ ≤ score < τ₂         →  TRENDING   — มี trend ร่วม แต่ sector rotation ยังเกิดขึ้น
τ₂ ≤ score < τ₃         →  RISK-OFF   — นักลงทุนลด exposure หลายประเภทพร้อมกัน
score ≥ τ₃              →  CRISIS     — panic หรือ systematic deleveraging
```

โดย (τ₁, τ₂, τ₃) = (0.40, 0.55, 0.70) เป็นค่าประมาณเริ่มต้น ค่าจริงที่ใช้ขึ้นอยู่กับสถานะของ MRS model (ดูหัวข้อ 7.1)

---

## 3. GEOM Mode

### 3.1 การอ่าน Wedge Matrix (MTX)

Matrix ในมุมมอง GEOM แสดงค่า $|\sin\theta_{ij}| = \sqrt{1 - \rho_{ij}^2}$ ระหว่าง sector pair ซึ่งแตกต่างจาก CORR matrix ในทิศทางตรงกันข้าม:

**รหัสสี:**
- เขียวสว่าง (ค่าใกล้ 1.0): sectors เคลื่อนไหวอย่างอิสระต่อกัน (orthogonal vectors)
- ดำ (ค่าใกล้ 0.0): sectors เคลื่อนไหวร่วมกัน (parallel vectors)
- Diagonal: ดำเสมอ (sector กับตัวเองมี wedge = 0 โดยนิยาม)

**ข้อสังเกตสำคัญ:** GEOM cell สูง (สีเขียว) มีความหมายตรงข้ามกับ CORR cell สูง (สีแดง) การที่ XLE มีแถวสีเขียวทั้งหมดบ่งชี้ว่า Energy sector เคลื่อนไหวอย่างเป็นอิสระจาก sectors อื่น ซึ่งเป็นลักษณะปกติเนื่องจาก oil price dynamics

### 3.2 GEOM Score และ Regime Label

GEOM score คือ geometric mean ของ eigenvalues ของ correlation matrix $[\det(\mathbf{C})]^{1/N}$ (ดูนิยามทางคณิตศาสตร์ในหัวข้อ 4.2) threshold ที่ใช้ปัจจุบันยังอยู่ในระดับ heuristic:

```
score < 0.25             →  CORRELATED — vectors เกือบ parallel; factor เดียวครอบงำ
score ∈ [0.25, 0.45)     →  TRENDING   — market beta dominant แต่ยังมี secondary factors
score ∈ [0.45, 0.65)     →  MIXED      — transitional; beta และ alpha factor แข่งขันกัน
score ≥ 0.65             →  DIVERGENT  — sectors กระจาย; โอกาส alpha สูง
```

### 3.3 Wedge Space Projection (SPC View)

Wedge Space แสดง direction ของ return vector แต่ละ sector ใน principal component 2D space:

| ลักษณะที่สังเกตเห็น | นัยสำคัญ |
|--------------------|---------|
| Arrows รวมกลุ่มกัน | Sectors เคลื่อนไหวในทิศเดียว — CORRELATED regime |
| Arrows กระจายรอบ origin | Sectors เคลื่อนไหวอย่างอิสระ — DIVERGENT regime |
| Arrows ชี้ตรงข้ามกัน | Sectors มี inverse relationship — rotation ที่ชัดเจน |
| Defensive cluster (UTIL, CONS, REIT) แยกจาก growth | Late-cycle rotation |
| XLE arrow แยกออกจากกลุ่ม | Commodity-driven factor ที่เป็นอิสระ |

**ความน่าเชื่อถือของการแสดงผล 2D** ขึ้นอยู่กับ PC1+PC2 variance explained:

| PC1+PC2 % | ระดับความน่าเชื่อถือ |
|-----------|-------------------|
| > 70% | สูง — การตีความจาก 2D projection เชื่อถือได้ |
| 50–70% | ปานกลาง — ตีความประกอบกับ score หลัก |
| < 50% | ต่ำ — dimensionality reduction สูญเสียข้อมูลสำคัญ |

---

## 4. ทฤษฎีเชิงคณิตศาสตร์

### 4.1 CORR Score: avg|ρ|

**นิยาม:**

$$\text{score}_{\text{CORR}} = \frac{2}{N(N-1)} \sum_{i < j} |\rho_{ij}|$$

สำหรับ $N = 11$ sectors (SPDR ETFs): คำนวณจาก $\binom{11}{2} = 55$ คู่

$\rho_{ij}$ คือ Pearson correlation coefficient ของผลตอบแทนรายวันระหว่าง sector $i$ และ $j$ ในช่วง lookback window ที่เลือก

**สิ่งที่วัดได้จริง:**

Score วัด **ความรุนแรงเฉลี่ยของการเคลื่อนไหวร่วมกัน** โดยไม่คำนึงถึงทิศทาง (absolute value) ความหมายของ $|\rho_{ij}|$ มีดังนี้:

| $|\rho_{ij}|$ | ความหมาย |
|--------------|---------|
| 1.0 | Sector pair เคลื่อนไหวสอดคล้องกันอย่างสมบูรณ์ |
| 0.0 | Sector pair เคลื่อนไหวเป็นอิสระต่อกันอย่างสมบูรณ์ |
| ค่า intermediate | ระดับ co-movement ที่สัมพันธ์กัน โดยไม่แยกแยะทิศทาง + หรือ − |

**ข้อจำกัดเชิงโครงสร้าง:**

CORR score ไม่สามารถแยกแยะโครงสร้างตลาดที่แตกต่างกันสามประเภทต่อไปนี้ได้:

```
กรณี A (Uniform crash):    XLK −5%, XLF −5%, XLE −5%, XLU −5%  → avg|ρ| ≈ 0.95
กรณี B (Uniform rally):   XLK +3%, XLF +3%, XLE +3%, XLU +3%  → avg|ρ| ≈ 0.95
กรณี C (Structured rotation):
  XLK +3%, XLC +3%, XLF +2% (growth ขึ้น)
  XLU −3%, XLRE −2%          (defensive ลง)
  ρ(XLK,XLU) ≈ −0.85  →  avg|ρ| ≈ 0.87  → CORR score ≈ 0.87
```

กรณี C คือ structured rotation ซึ่งมีนัยสำคัญต่อการลงทุนที่แตกต่างจากกรณี A อย่างมาก แต่ CORR score ให้ค่าเดียวกัน ข้อจำกัดนี้ได้รับการแก้ไขบางส่วนโดย GEOM mode (ดูหัวข้อ 5.3)

### 4.2 GEOM Score: det(C)^(1/N)

**นิยาม:**

$$\text{score}_{\text{GEOM}} = \left[\det(\mathbf{C})\right]^{1/N}$$

โดย $\mathbf{C}$ คือ $N \times N$ correlation matrix และ:

$$\det(\mathbf{C}) = \prod_{k=1}^{N} \lambda_k$$

ซึ่ง $\lambda_1 \geq \lambda_2 \geq \cdots \geq \lambda_N \geq 0$ คือ eigenvalues ของ $\mathbf{C}$ ดังนั้น $\text{score}_{\text{GEOM}}$ จึงเท่ากับ **geometric mean ของ eigenvalues ทั้งหมด**

**Properties ทางคณิตศาสตร์:**

**Trace constraint:**
$$\sum_{k=1}^{N} \lambda_k = \operatorname{trace}(\mathbf{C}) = N$$
เนื่องจาก diagonal ของ correlation matrix มีค่าเท่ากับ 1 เสมอ ส่งผลให้ arithmetic mean ของ eigenvalues เท่ากับ 1 เสมอ

**AM-GM inequality:**
$$\underbrace{\frac{1}{N}\sum_{k} \lambda_k}_{= 1 \text{ เสมอ}} \;\geq\; \underbrace{\left(\prod_{k} \lambda_k\right)^{1/N}}_{\text{GEOM score}} \;\geq\; 0$$

- score $= 1$ เมื่อ $\lambda_k = 1$ ทุก $k$ → $\mathbf{C} = \mathbf{I}$ (sectors ออร์โธโกนัลสมบูรณ์)
- score $= 0$ เมื่อ $\lambda_k = 0$ สำหรับบาง $k$ → $\mathbf{C}$ singular (volume collapse)

**ความหมายเชิงเรขาคณิต:**

$\det(\mathbf{C})$ วัด **volume ของ N-dimensional parallelepiped** ที่ครอบคลุมโดย return vectors ของทุก sector:

```
ตัวอย่าง (N = 3 sectors):

det ≈ 0 :   vectors อยู่ใน hyperplane เดียว → 1 factor ครอบงำทั้งระบบ
det = max:  vectors ตั้งฉากกันทุกคู่ → N independent factors
det = กลาง: vectors กระจายบ้าง แต่ยังมี dominant direction
```

**โครงสร้าง eigenvalue และนัยสำคัญ:**

| โครงสร้าง eigenvalue | det | Regime |
|---------------------|-----|--------|
| $\lambda_1 \approx N,\; \lambda_{2,...,N} \approx 0$ | $\approx 0$ | 1 factor ครอบงำ (market beta) |
| $\lambda_1 \approx \lambda_2 \approx N/2,\; \text{rest} \approx 0$ | $> 0$ | 2 independent factors |
| $\lambda_k \approx 1 \;\forall k$ | $\approx 1$ | N independent factors |

### 4.3 ความสัมพันธ์ระหว่าง CORR และ GEOM

**กรณีที่ทั้งสองตรงกัน:**

```
โครงสร้าง A (Crash): ทุก sector ลงพร้อมกัน
  CORR: avg|ρ| สูง → CRISIS
  GEOM: det ≈ 0 (vectors parallel) → CORRELATED
  ✓ ทั้งคู่ยืนยัน: 1 factor ครอบงำระบบ

โครงสร้าง D (Idiosyncratic): ทุก sector เป็นอิสระ
  CORR: avg|ρ| ต่ำ → DIVERGENT
  GEOM: det สูง (vectors spread) → DIVERGENT
  ✓ ทั้งคู่ยืนยัน: multiple independent factors
```

**กรณีที่ทั้งสองขัดแย้ง — นัยสำคัญสูง:**

```
โครงสร้าง C (Structured rotation):
  XLK, XLC, XLY ขึ้น: ρ ≈ +0.85
  XLU, XLRE, XLP ลง: ρ ≈ +0.80
  Cross-group: ρ ≈ −0.75

  CORR: avg|ρ| ≈ 0.80 → RISK-OFF หรือ CRISIS
  GEOM: C มี 2 eigenvalues ขนาดใหญ่ (growth cluster + defensive cluster)
        det ≠ 0 เพราะทั้งสองกลุ่มออร์โธโกนัลกัน → TRENDING หรือ MIXED

  CORR: ตีความว่า "correlations สูง = ความเสี่ยงสูง"
  GEOM: ตีความว่า "มีสอง independent directions = rotation ยังดำเนินอยู่"
  ตัวอย่างจริง: ตลาดในปี 2022 ช่วง Fed rate hike — GEOM ให้ภาพที่ถูกต้องกว่า
```

**ตารางสรุปกรณีขัดแย้ง:**

| CORR Label | GEOM Label | ความหมายที่น่าจะเป็น | การตีความที่เหมาะสม |
|-----------|-----------|-------------------|------------------|
| CRISIS | TRENDING | Structured rotation สองกลุ่มสวนทาง | พิจารณา GEOM เป็นหลัก — sector opportunity อาจมีอยู่ |
| RISK-OFF | MIXED | Factor rotation ร่วมกับ moderate beta | ระมัดระวัง แต่ sector selection ยังมีนัยสำคัญ |
| DIVERGENT | MIXED | Hidden soft factor ที่ CORR ไม่ตรวจพบ | ตรวจสอบ PC1% — หาก > 40% ควรระมัดระวัง |
| TRENDING | DIVERGENT | Average correlation ต่ำแต่มีโครงสร้างสองกลุ่ม | ระบุกลุ่มที่เป็น long/short candidates |

**หลักการทั่วไป:** เมื่อ CORR และ GEOM ให้ผลตรงกัน signal มีความน่าเชื่อถือสูง เมื่อขัดแย้งกัน ให้ตรวจสอบ Wedge Space และ PC1% เพื่อประกอบการตัดสิน โดยทั่วไป CORR สูงแต่ GEOM ปานกลางมักบ่งชี้ถึง structured rotation ไม่ใช่ systematic crash

---

## 5. การจำแนก Regime และ Label

### 5.1 Regime สี่ระดับ (CORR Mode)

| Label | CORR Score | ลักษณะตลาด | นัยสำคัญต่อ Portfolio |
|-------|-----------|-----------|---------------------|
| DIVERGENT | < τ₁ | Sectors เคลื่อนไหวเป็นอิสระ; idiosyncratic factors ครอบงำ | Active sector selection ให้ alpha ได้ |
| TRENDING | τ₁–τ₂ | Trend ร่วมมีอยู่แต่ sector rotation ยังเกิดขึ้น | Sector selection ยังมีความหมาย |
| RISK-OFF | τ₂–τ₃ | Investors ลด exposure หลายประเภทพร้อมกัน | Defensive rotation เหมาะสม |
| CRISIS | ≥ τ₃ | Panic หรือ systematic deleveraging | Diversification ใน equity ล้มเหลว |

### 5.2 Regime ห้าระดับ (GEOM Mode)

| Label | GEOM Score | ความหมายเชิง eigenvalue |
|-------|-----------|----------------------|
| CORRELATED | < 0.25 | λ₁ ≫ λ₂,...,ₙ: 1 factor ครอบงำ |
| TRENDING | 0.25–0.45 | λ₁ dominant แต่ secondary factors มีอยู่ |
| MIXED | 0.45–0.65 | 2–4 factors แข่งขันกัน — transitional zone |
| DIVERGENT | > 0.65 | Eigenvalues กระจาย; multiple factors |

### 5.3 DIVERGENT และ MIXED: ความแตกต่างที่สำคัญ

**CORR DIVERGENT** (avg|ρ| < τ₁) บ่งชี้ว่า sector pairs ส่วนใหญ่มี correlation ต่ำ — ตลาดขับเคลื่อนด้วย idiosyncratic catalysts โดยไม่มี macro shock ที่ลาก sectors ขึ้นลงพร้อมกัน

**GEOM DIVERGENT** (det^(1/N) > 0.65) บ่งชี้ว่า eigenvalues กระจายตัวใกล้เคียงกับ 1 ทุกตัว — return vectors span พื้นที่ใน N-dimensional space อย่างกว้างขวาง แสดงให้เห็น N independent factors

**ความแตกต่างเชิงโครงสร้าง:** CORR วัด "bilateral independence" (รายคู่) ในขณะที่ GEOM วัด "collective dimensionality" (ทั้งระบบ) สามารถเกิดสถานการณ์ที่ CORR = DIVERGENT แต่ GEOM = MIXED ได้ หาก sectors มี correlation ต่ำแต่ eigenvalue structure ยังไม่สมมาตรสมบูรณ์ (มี soft dominant factor)

**MIXED** (GEOM เท่านั้น) เกิดขึ้นเมื่อ eigenvalue structure อยู่กึ่งกลาง:

```
ตัวอย่าง eigenvalue profiles (N = 11):

CORRELATED:  λ = {9.5, 0.5, 0.3, ...}  → score ≈ 0.10
TRENDING:    λ = {5.0, 2.0, 1.5, ...}  → score ≈ 0.35
MIXED:       λ = {3.0, 2.0, 1.5, 1.2, ...}  → score ≈ 0.55
DIVERGENT:   λ = {1.3, 1.2, 1.1, 1.0, ...}  → score ≈ 0.75
```

MIXED บ่งชี้ว่าตลาดมี 2–4 independent factors ที่แข่งขันกัน ซึ่งหมายความว่า ETF index และ active selection อาจให้ผลตอบแทนใกล้เคียงกัน ตัวอย่างเช่น ตลาดในปี 2024 ซึ่งมี Factor 1: AI/tech momentum (PC1 ≈ 40%), Factor 2: Rate sensitivity (PC2 ≈ 20%), Factor 3: Energy/commodity (PC3 ≈ 10%)

---

## 6. Trend Strip: การวิเคราะห์ Regime Momentum

### 6.1 โครงสร้าง Trend Strip

Trend Strip แสดง score ของทั้ง 4 period พร้อมกัน พร้อมคำนวณทิศทางการเปลี่ยนแปลง regime โดยอัตโนมัติ:

```
1M    3M    6M    1Y
████  ███   ██    █
0.52  0.44  0.41  0.35
TRD   TRD   TRD   DIV
→ CONTRACTING  Δ+0.167 (1M vs 1Y)
```

### 6.2 Risk Delta (Δ)

**นิยาม:**

$$\Delta = \text{risk}_{1M} - \text{risk}_{1Y}$$

โดย "risk" นิยามต่างกันตาม mode:

- **CORR mode:** $\text{risk} = \text{score}$ (score สูงหมายถึง correlation สูง = ความเสี่ยงสูง)
- **GEOM mode:** $\text{risk} = 1 - \text{score}$ (score ต่ำหมายถึง volume collapse = ความเสี่ยงสูง)

**การแปล Δ เป็น trend label:**

| Δ | Label | ความหมาย |
|---|-------|---------|
| > +0.05 | CONTRACTING | สภาพ 1M มีความเสี่ยงสูงกว่า 1Y — sectors กำลัง converge |
| < −0.05 | EXPANDING | สภาพ 1M มีความเสี่ยงต่ำกว่า 1Y — sectors กำลัง diverge |
| ±0.05 | STABLE | ไม่มีทิศทางที่ชัดเจน — regime ค่อนข้างคงที่ |

**ระดับนัยสำคัญของ |Δ|:**

| |Δ| | นัยสำคัญ | แนวทางการดำเนินการ |
|------|---------|-----------------|
| < 0.05 | ไม่มีนัยสำคัญ (noise) | ไม่จำเป็นต้องปรับ portfolio |
| 0.05–0.15 | Moderate shift — สัญญาณเริ่มปรากฏ | ติดตามสถานการณ์ |
| 0.15–0.30 | Significant shift — regime กำลังเปลี่ยน | เตรียม rotate positioning |
| > 0.30 | Strong shift — high conviction signal | ปรับ positioning ได้ |

### 6.3 การตีความ CONTRACTING และ EXPANDING

**ตัวอย่างที่ 1: CONTRACTING Δ+0.167**

```
สภาพที่สังเกตเห็น:
  1M score: 0.52  →  RISK-OFF     (สภาพปัจจุบัน)
  1Y score: 0.35  →  DIVERGENT    (structural baseline)
  Δ = 0.52 − 0.35 = +0.167  →  CONTRACTING
```

Δ วัด**ระยะห่างระหว่างสภาพปัจจุบันและ structural baseline** ไม่ใช่แค่ระดับ absolute ของ correlation ปัจจุบัน Δ+0.167 บ่งชี้ว่าในช่วง 1 เดือนที่ผ่านมา sectors เคลื่อนไหวร่วมกันมากกว่า baseline 16.7 percentage points ซึ่งเป็นหลักฐานที่ชัดเจนว่า regime กำลังอยู่ในช่วง transition ไม่ใช่เพียง noise ชั่วคราว

**ตัวอย่างที่ 2: EXPANDING Δ−0.140**

```
สภาพที่สังเกตเห็น:
  1M score: 0.38  →  DIVERGENT    (สภาพปัจจุบัน)
  1Y score: 0.52  →  RISK-OFF     (structural baseline)
  Δ = 0.38 − 0.52 = −0.140  →  EXPANDING
```

Sectors กำลัง decouple — macro factor เริ่มสูญเสียอิทธิพล ซึ่งบ่งชี้ถึงโอกาสที่ sector selection จะสร้าง alpha ได้มากขึ้น

### 6.4 การตีความเมื่อ CORR และ GEOM Trend ขัดแย้ง

| CORR Trend | GEOM Trend | ความหมาย |
|-----------|-----------|---------|
| CONTRACTING | CONTRACTING | Double confirmation — ความเสี่ยง systemic กำลังเพิ่มขึ้น |
| EXPANDING | EXPANDING | Double confirmation — regime กำลังผ่อนคลาย |
| CONTRACTING | EXPANDING | Structured rotation: average correlation สูงขึ้นแต่ volume ยังคงมีอยู่ — 2 กลุ่มเคลื่อนสวนทาง |
| EXPANDING | CONTRACTING | Rare: average correlation ลดลงแต่ factor structure collapse — ระวัง hidden single factor |

### 6.5 ข้อควรระวัง: STABLE ≠ ปลอดภัย

$\Delta \approx 0$ บ่งชี้เพียงว่า regime ไม่กำลังเปลี่ยนแปลง ไม่ใช่ว่า regime ปัจจุบันมีความเสี่ยงต่ำ ดังนั้นจึงต้องพิจารณา label ปัจจุบันร่วมกับ trend เสมอ:

```
DIVERGENT + STABLE     = Idiosyncratic market ต่อเนื่อง — เอื้อต่อ active management
TRENDING + CONTRACTING = Trend กำลังเสื่อมถอย — ลด active bet
RISK-OFF + CONTRACTING = ความเสี่ยงสูง — เพิ่ม defensive positioning
CRISIS + STABLE        = Crisis ยืดเยื้อ — คงถือ cash/safe haven assets
CRISIS + EXPANDING     = Crisis กำลังผ่อนคลาย — เริ่ม re-enter ได้อย่างระมัดระวัง
RISK-OFF + EXPANDING   = Regime กำลังผ่อนคลาย — rotate back สู่ risk assets ได้
```

---

## 7. การ Calibrate Threshold

### 7.1 CORR Thresholds: Markov Regime Switching Calibration

**ระดับการ calibrate:** สูง — ใช้ข้อมูลเชิงประจักษ์ (badge = `[MRS]`)

CORR thresholds ได้รับการปรับ calibrate ด้วย 4-state Gaussian Hidden Markov Model ตามกรอบของ Hamilton (1989) และ Ang & Bekaert (2002) โดยมีรายละเอียดดังนี้:

**กระบวนการ:**
1. ดาวน์โหลดข้อมูล daily return ของ SPDR sector ETFs ย้อนหลัง (2018–ปัจจุบัน)
2. คำนวณ rolling 63-day CORR score series
3. Train GaussianHMM 4 states ด้วย EM algorithm (Baum-Welch, 500 iterations)
4. จัดเรียง states ตาม mean จากน้อยไปมาก (state 0 = DIVERGENT, state 3 = CRISIS)
5. คำนวณ threshold เป็น midpoint ระหว่าง adjacent state means: $\tau_k = (\mu_k + \mu_{k+1})/2$

**State means จากการ train ล่าสุด:** $[\mu_0, \mu_1, \mu_2, \mu_3] \approx [0.36, 0.45, 0.52, 0.70]$

**Threshold ที่ได้:** $\tau_1 \approx 0.40,\; \tau_2 \approx 0.48,\; \tau_3 \approx 0.61$

**การ retrain อัตโนมัติ:** ระบบ retrain model ใหม่บน startup หาก model อายุเกิน 30 วัน สอดคล้องกับ best practice ใน Nystrup et al. (2017) ที่ระบุว่า MRS parameters มีความเสถียรเพียงพอสำหรับ monthly retraining cycle

สถานะ model สามารถตรวจสอบได้ที่ endpoint:
```
GET /api/regime/model-status
```

- `mrs_ready: true` → กำลังใช้ MRS-calibrated thresholds
- `mrs_ready: false` → กำลัง fallback เป็น heuristic (0.40, 0.55, 0.70) ขณะ model กำลัง train

**ผลการ Walk-forward Validation (8 folds, ข้อมูล 2000–ปัจจุบัน):**

| Threshold | Mean | Std | ระดับความเสถียร |
|-----------|------|-----|----------------|
| divergent/trending (τ₁) | 0.478 | 0.035 | WARN (moderate drift) |
| trending/riskoff (τ₂) | 0.616 | 0.037 | WARN (moderate drift) |
| riskoff/crisis (τ₃) | 0.722 | 0.035 | WARN (moderate drift) |

Threshold std ≈ 0.035 สะท้อน structural drift ที่คาดได้ระหว่าง market regimes ต่างยุค (pre-2010 vs. post-2018) ไม่ใช่ความไม่เสถียรของ model

**Spot-check validation (กรณีที่ label กำหนดก่อนรัน validation):**

| ช่วงเวลา | Expected | Actual | avg|ρ| | ผล |
|---------|---------|--------|--------|-----|
| COVID crash (Feb–Apr 2020) | CRISIS | CRISIS | 0.845 | ✓ |
| Fed hike peak (Jun–Nov 2022) | CRISIS | CRISIS | 0.677 | ✓ |
| AI bull H1 2024 | TRENDING | TRENDING | 0.465 | ✓ |
| Low-vol 2017 | DIVERGENT | DIVERGENT | 0.359 | ✓ |

Hit rate: 4/4 = 100% (กรณีที่ label กำหนดอย่างอิสระก่อนรัน)

### 7.2 GEOM Thresholds: Heuristic with RMT Supplementary Analysis

**ระดับการ calibrate:** ต่ำ — ยังเป็น heuristic judgment (badge = `[RMT]`)

Thresholds ปัจจุบัน (0.25, 0.45, 0.65) ได้รับการกำหนดจาก informed judgment โดยอ้างอิง eigenvalue profile ที่ทราบค่า ยังไม่ได้ผ่านกระบวนการ data-driven calibration เทียบเท่า MRS

**แนวทางการตีความที่เหมาะสมสำหรับ GEOM:** การวิเคราะห์ที่น่าเชื่อถือกว่าการดู absolute label คือการดู relative change ของ score ข้ามช่วงเวลา:

```
score ลดลงต่อเนื่อง → volume collapse → ความเสี่ยง systemic กำลังเพิ่ม
score เพิ่งกระโดดสูง (CORR) → macro shock ใหม่กำลังเกิดขึ้น
1M label = CRISIS แต่ 1Y label = TRENDING → spike ชั่วคราว ไม่ใช่ structural change
```

อย่างไรก็ตาม ระบบมีการเสริมการวิเคราะห์ GEOM ด้วย Random Matrix Theory (ดูหัวข้อ 9) ซึ่งช่วยแยกแยะโครงสร้าง eigenvalue ที่แตกต่างกันภายใน label เดียวกันได้

---

## 8. การรวม Δ กับ MRS Transition Probabilities

### 8.1 สองมิติที่เสริมกัน

Δ และ MRS transition probabilities ให้ข้อมูลที่แตกต่างและเสริมกัน:

| มิติ | วัดอะไร | กรอบเวลา |
|------|--------|---------|
| **Δ (trend strip)** | ระยะที่ score ปัจจุบันเบี่ยงจาก baseline | Realized (เกิดขึ้นแล้ว) |
| **MRS transition_20d** | ความน่าจะเป็นที่ regime จะเปลี่ยน (หรือคงที่) ใน 20 วัน | Forward-looking |

กล่าวโดยสรุป: **Δ บอกว่าเกิดอะไรขึ้นแล้ว** ในขณะที่ **MRS transition probabilities บอกว่าน่าจะเกิดอะไรต่อ**

### 8.2 การวิเคราะห์ CONTRACTING Δ+0.169

**ตัวอย่างสถานการณ์:**

```
1M CORR score: 0.52  →  RISK-OFF     (สภาพปัจจุบัน)
1Y CORR score: 0.35  →  DIVERGENT    (structural baseline)
Δ = 0.52 − 0.35 = +0.169  →  CONTRACTING
```

Δ+0.169 บ่งชี้ว่าสภาพล่าสุดเบี่ยงจาก structural norm +16.9 percentage points ซึ่งจัดอยู่ในระดับ "significant" (ดูหัวข้อ 6.2) เทียบเท่ากับ Q4 2018 correction ในเชิง magnitude แต่ยังต่ำกว่า COVID panic (Δ ≈ +0.30–0.50)

### 8.3 สี่ scenarios ของการรวม Δ กับ MRS

**Scenario 1: CONTRACTING + P(escalation) สูง — High Conviction**

```
Δ = +0.169  (CONTRACTING, significant)
MRS: current state = TRENDING
P(TRENDING → RISK-OFF ใน 20 วัน) = 0.48

การตีความ:
  - Δ ยืนยันว่า sectors กำลัง converge (realized)
  - MRS ยืนยันว่า transition probability สูง (forward-looking)
  - ทั้งสองมิติสอดคล้องกัน → high conviction signal

แนวทาง: ลด exposure ใน high-beta sectors (XLK, XLC, XLY)
          เพิ่ม defensive sectors (XLP, XLU, XLV) หรือ cash
```

**Scenario 2: CONTRACTING + P(escalation) ต่ำ — Likely Transient**

```
Δ = +0.169  (CONTRACTING, significant)
MRS: current state = RISK-OFF
P(RISK-OFF → CRISIS ใน 20 วัน) = 0.12

การตีความ:
  - Δ สูงขึ้น (realized)
  - แต่ MRS transition matrix บ่งชี้ว่า RISK-OFF เสถียร (P ต่ำ)
  - spike อาจเป็นชั่วคราว — mean-reversion น่าจะเกิดขึ้น

แนวทาง: ติดตามสถานการณ์โดยไม่ปรับ positioning อย่างรุนแรง
```

**Scenario 3: STABLE + P(escalation) สูง — Early Warning**

```
Δ ≈ +0.02  (STABLE)
MRS: current state = TRENDING
P(TRENDING → RISK-OFF ใน 20 วัน) = 0.52

การตีความ:
  - Score ปัจจุบันยังไม่เปลี่ยนแปลง (Δ ยังไม่ confirm)
  - แต่ MRS anticipate regime transition จาก historical pattern
  - Early warning จาก HMM — Δ จะตามมา

แนวทาง: เตรียม defensive positioning ล่วงหน้า รอ Δ เป็น confirmation signal
```

**Scenario 4: EXPANDING + MRS ยืนยัน — Risk Reduction**

```
Δ = −0.140  (EXPANDING, significant)
MRS: current state = RISK-OFF
P(RISK-OFF → TRENDING ใน 20 วัน) = 0.38

การตีความ:
  - Sectors กำลัง decouple (realized)
  - MRS บ่งชี้ว่ามีโอกาส 38% ที่ regime จะผ่อนคลายลงใน 3 สัปดาห์
  - Risk environment กำลังปรับตัวในทิศทางที่ดีขึ้น

แนวทาง: เริ่มพิจารณา re-entry ใน risk assets อย่างค่อยเป็นค่อยไป
```

### 8.4 บริบทเชิงประวัติศาสตร์ของ Δ

| ช่วงเวลา | สภาพตลาด | Δ โดยประมาณ |
|---------|---------|------------|
| 2017 (Low-vol) | DIVERGENT เสถียร | ±0.02–0.04 |
| 2019 (Mid-cycle) | TRENDING เสถียร | ±0.05–0.08 |
| Q4 2018 (Correction) | TRENDING → RISK-OFF | +0.12–0.18 |
| 2022 (Fed hike) | TRENDING → CRISIS (gradual) | +0.15–0.25 |
| Mar 2020 (COVID) | RISK-OFF → CRISIS | +0.30–0.50 |

### 8.5 กระบวนการตัดสิน: วิธีอ่าน CONTRACTING Δ

```
ขั้นที่ 1: ประเมิน magnitude ของ Δ
  |Δ| < 0.05  → noise; ไม่มีนัยสำคัญ
  |Δ| 0.05–0.15 → moderate; ติดตาม
  |Δ| 0.15–0.30 → significant; เตรียม rotate
  |Δ| > 0.30  → strong; ปรับ positioning

ขั้นที่ 2: พิจารณา label ปัจจุบัน
  TRENDING + CONTRACTING  → อาจเลื่อนสู่ RISK-OFF
  RISK-OFF + CONTRACTING  → อาจเลื่อนสู่ CRISIS

ขั้นที่ 3: ตรวจสอบ MRS transition_20d (modal ใน CORR mode)
  P(→ higher regime) > 0.40 → high conviction; ปรับ positioning
  P(→ higher regime) < 0.20 → spike ชั่วคราว; รอสัญญาณยืนยัน

ขั้นที่ 4: ตรวจสอบ GEOM Δ เพื่อ confirmation
  GEOM ก็ CONTRACTING  → double confirmation; signal แข็งแกร่ง
  GEOM STABLE/EXPANDING → CORR spike อาจเป็น structured rotation
```

---

## 9. RMT Supplementary Analysis: k_signal และ factor_regime

### 9.1 พื้นฐาน: Marchenko-Pastur Distribution

Random Matrix Theory กำหนด **upper bound ของ eigenvalue** ที่เกิดจาก noise ใน random matrix ตาม Marchenko-Pastur distribution (Laloux et al., 1999; Plerou et al., 2002):

$$\lambda_{\max}^{MP} = \left(1 + \sqrt{N/T}\right)^2$$

โดย $N$ คือจำนวน sectors และ $T$ คือจำนวน observations ใน lookback window

สำหรับ $N = 11$ sectors และ $T = 63$ วัน: $\lambda_{\max}^{MP} \approx (1 + \sqrt{11/63})^2 \approx 1.84$

### 9.2 k_signal: จำนวน Genuine Market Factors

```
k_signal = #{λ_k : λ_k > λ_max^MP}
```

**ความหมาย:** k_signal คือจำนวน eigenvalues ที่เกิน Marchenko-Pastur upper bound ซึ่งตีความว่าเป็น genuine market factors ที่ไม่ใช่ noise

| k_signal | การตีความ |
|----------|---------|
| 0 | Correlation matrix ไม่แตกต่างจาก random noise — ไม่มี factor structure |
| 1 | 1 genuine factor (มักคือ market beta) ครอบงำทั้งระบบ |
| 2–3 | 2–3 independent factors (เช่น market beta + sector rotation) |
| ≥ 4 | Multiple independent factors — idiosyncratic market structure |

**ข้อจำกัดของ k_signal:** k_signal ไม่สามารถแยกแยะ regime ที่มีความเสี่ยงต่างกันได้ เนื่องจากสำหรับ equicorrelation matrix ที่มี off-diagonal $\rho$:

$$\lambda_1 = 1 + (N-1)\rho, \quad \lambda_2 = \cdots = \lambda_N = 1 - \rho$$

ส่งผลให้ $k = 1$ สำหรับ $\rho \geq (\lambda_{\max}^{MP} - 1)/(N-1) \approx 0.08$ นั่นคือทั้ง $\rho = 0.20$ (DIVERGENT) และ $\rho = 0.85$ (CRISIS) ให้ $k = 1$ เท่ากัน ด้วยเหตุนี้ label หลักจึงใช้ score (det^(1/N)) ไม่ใช่ k_signal

### 9.3 factor_regime: การรวม k กับ λ₁/N

`factor_regime` รวมข้อมูล k_signal กับ $\lambda_1/N$ (market dominance ratio) เพื่อให้การตีความละเอียดขึ้น:

| k_signal | $\lambda_1/N$ | factor_regime | ความหมาย |
|----------|--------------|--------------|---------|
| 0 | — | NOISE | ไม่มี factor structure; ใกล้เคียง identity matrix |
| 1 | > 0.75 | SINGLE-FACTOR-DOMINANT | 1 factor กินทั้งระบบ — crisis-like |
| 1 | 0.45–0.75 | SINGLE-FACTOR-MODERATE | beta ครอบงำแต่ไม่สมบูรณ์ — trending-like |
| 1 | ≤ 0.45 | SINGLE-FACTOR-WEAK | weak beta — near-divergent |
| 2–3 | — | MULTI-FACTOR | rotation structure มี 2–3 pillars |
| ≥ 4 | — | MANY-FACTORS | idiosyncratic — stock-picker's market |

### 9.4 การตีความร่วมระหว่าง GEOM label และ factor_regime

| GEOM label | factor_regime ที่สอดคล้อง | นัยสำคัญ |
|-----------|--------------------------|---------|
| CORRELATED | SINGLE-FACTOR-DOMINANT | Classic panic — 1 factor (fear) ครอบงำ |
| TRENDING | SINGLE-FACTOR-MODERATE | Market beta dominant แต่ secondary factors ยังมีอยู่ |
| MIXED | MULTI-FACTOR | 2–3 factors แข่งขัน — sector selection เริ่มมีความหมาย |
| DIVERGENT | MANY-FACTORS | True idiosyncratic market |

**กรณีที่ขัดแย้งและนัยสำคัญ:**

*CORRELATED + MULTI-FACTOR:* score ต่ำ (volume collapse) แต่ k=2–3 บ่งชี้ว่าเป็น structured rotation สองกลุ่มสวนทางกัน ไม่ใช่ systematic panic ควรให้น้ำหนักกับ factor_regime มากกว่า GEOM label

*DIVERGENT + SINGLE-FACTOR-MODERATE:* score สูงแต่ k=1 ด้วย $\lambda_1/N$ ปานกลาง บ่งชี้ว่า hidden market beta ยังคงมีอยู่ แม้ average correlation จะต่ำ ควรยืนยันด้วย PC1% < 40% ก่อนสรุปว่าเป็น DIVERGENT อย่างแท้จริง

---

## 10. กรณีศึกษาเชิงประวัติศาสตร์

### 10.1 COVID Crash มีนาคม 2020

```
ประเภท: Forced systematic deleveraging
เหตุการณ์: Global margin call — ทุก asset class ถูกขายพร้อมกัน

Eigenvalue: λ₁ ≈ 9.8, λ₂ ≈ 0.5, λ₃ ≈ 0.3, ...
CORR score: ~0.85  →  CRISIS
GEOM score: ~0.05  →  CORRELATED
PC1: >90% variance

ทั้งสอง mode สอดคล้องกัน: 1 factor (pandemic fear) ครอบงำทั้งระบบ
factor_regime: SINGLE-FACTOR-DOMINANT (λ₁/N > 0.89)
```

**นัยสำคัญต่อ portfolio:** Equity diversification ไม่มีประสิทธิภาพในช่วงนี้ เนื่องจาก cross-sector correlation สูงมาก กลยุทธ์ที่เหมาะสมจำกัดอยู่ที่ cash, gold, และ long-duration bonds

### 10.2 Fed Rate Hike ปี 2022

```
ประเภท: Factor rotation — rate-sensitive vs. real assets
เหตุการณ์: Fed ขึ้นดอกเบี้ยจาก 0% → 4.5% ภายใน 1 ปี

Performance:
  XLK −40%, XLC −40% (high PE, rate-sensitive)
  XLE +65%            (Russia-Ukraine oil shock)
  XLU −5%, XLP ±0%   (defensive, partly rate-sensitive)

Correlation structure:
  ρ(XLK, XLC) ≈ +0.90  (growth cluster)
  ρ(XLE, XLK) ≈ −0.70  (energy สวนทาง growth)

CORR score: avg|ρ| ≈ 0.60  →  RISK-OFF
GEOM score: score ≈ 0.38   →  TRENDING
factor_regime: MULTI-FACTOR (k = 2)
```

**กรณีขัดแย้ง:** CORR บ่งชี้ RISK-OFF เนื่องจาก absolute correlation สูง แต่ GEOM บ่งชี้ TRENDING เนื่องจาก growth vector และ energy vector ออร์โธโกนัลกัน GEOM ให้ภาพที่ถูกต้องกว่า: นี่คือ factor rotation ไม่ใช่ systematic crash

**นัยสำคัญต่อ portfolio:** Sector selection ยังมีความหมาย (long XLE, short XLK) — ไม่ควร liquidate equity portfolio ทั้งหมดอย่างที่ CORR label แนะนำ

### 10.3 AI Bull Market H1 2024

```
ประเภท: Thematic momentum + rate normalization
เหตุการณ์: AI spending surge, Fed pause, soft landing narrative

CORR score: avg|ρ| ≈ 0.45  →  TRENDING
GEOM score: score ≈ 0.50   →  MIXED
PC1 ≈ 50%, PC2 ≈ 20%, PC3 ≈ 10%
factor_regime: MULTI-FACTOR (k = 3)
```

**ทั้งสอง mode สอดคล้องกันโดยประมาณ:** ตลาดมีทั้ง market beta (broad-based rally) และ sector-specific factors (AI concentration) สถานะ MIXED บ่งชี้ว่า ETF index และ active selection ให้ผลตอบแทนใกล้เคียงกัน

### 10.4 Low-Volatility Market ปี 2017

```
ประเภท: Earnings-driven, macro-quiet
เหตุการณ์: VIX < 12 นานหลายเดือน, EPS growth แตกต่างรายกลุ่ม

CORR score: avg|ρ| ≈ 0.28  →  DIVERGENT
GEOM score: score ≈ 0.70   →  DIVERGENT
factor_regime: MANY-FACTORS (k ≥ 4)
```

**ทั้งสอง mode สอดคล้องกัน:** N independent factors ครอบงำ — ตลาดขับเคลื่อนด้วย sector/stock-specific catalysts ช่วงนี้เอื้อต่อ active management และ pairs trading อย่างมาก

---

## 11. ข้อจำกัดของระบบ

### 11.1 CORR Score ไม่สนใจทิศทาง

avg|ρ| ทิ้ง sign information ทั้งหมด ส่งผลให้ตลาดที่ทุก sector ขึ้นพร้อมกัน (risk-on rally) และตลาดที่ทุก sector ลงพร้อมกัน (crash) ได้ score เดียวกัน การแยกแยะสองกรณีนี้จำเป็นต้องพิจารณาข้อมูลเชิง directional เพิ่มเติม

### 11.2 GEOM Score ไวต่อ Near-Zero Eigenvalues อย่างมาก

เนื่องจาก $\text{score} = (\prod_k \lambda_k)^{1/N}$ หาก $\lambda_k \approx 0$ เพียงหนึ่งตัว จะส่งผลให้ score ≈ 0 แม้ sectors อื่นจะมี distribution ที่ดี กรณีนี้มักเกิดขึ้นเมื่อ sector หนึ่งเป็น near-linear combination ของ sectors อื่น (multicollinearity)

### 11.3 GEOM Threshold ยังเป็น Heuristic

Threshold (0.25, 0.45, 0.65) ได้รับการกำหนดจาก judgment โดยอิงจาก eigenvalue profiles ที่ทราบค่า ยังไม่ผ่านกระบวนการ data-driven calibration เทียบเท่า MRS การตีความ GEOM label ควรให้น้ำหนักกับ relative change ข้ามช่วงเวลามากกว่าค่า absolute

### 11.4 Energy (XLE) เป็น Structural Outlier

XLE มักมี correlation ต่ำหรือเป็นลบกับ sectors อื่น เนื่องจากถูกขับเคลื่อนด้วย oil price dynamics ซึ่งมีกลไกที่แตกต่างออกไปจาก equity market factors การที่ XLE แยกออกใน Wedge Space เป็นลักษณะปกติ ไม่ควรตีความว่าเป็นสัญญาณผิดปกติ

### 11.5 ข้อจำกัดของ Walk-Forward Validation

Spot-check validation ใช้ข้อมูลชุดเดียวกับที่ train model ในบางส่วน สำหรับ pre-2015 periods การ validation ใช้ SECTORS_CORE (9 sectors, ไม่รวม XLRE) ซึ่งมี score distribution ต่างจาก production model (11 sectors) การ validate ด้วย external classification เช่น NBER recession dates หรือ Chicago Fed ANFCI จะให้ independence ที่แท้จริงกว่า

---

## 12. สรุปแนวทางการตัดสินใจ

### 12.1 ตาราง Quick Reference ตาม Label และ Trend

| Label ปัจจุบัน | Trend | สรุปสถานการณ์ | แนวทางหลัก |
|--------------|-------|-------------|-----------|
| DIVERGENT | STABLE | Idiosyncratic market ต่อเนื่อง | Active sector selection / pairs trade |
| DIVERGENT | CONTRACTING | Regime กำลังเสื่อมถอย | ลด active bet ลดหลั่น |
| TRENDING | STABLE | Mid-cycle ปกติ | Maintain positioning |
| TRENDING | CONTRACTING | Risk กำลังเพิ่มขึ้น | เตรียม defensive rotation |
| RISK-OFF | CONTRACTING | สัญญาณอันตราย | เพิ่ม defensive อย่างมีนัยสำคัญ |
| RISK-OFF | EXPANDING | Regime กำลังผ่อนคลาย | เริ่ม rotate back ได้ |
| CRISIS | STABLE | Crisis ยืดเยื้อ | คงถือ cash/safe haven assets |
| CRISIS | EXPANDING | Crisis กำลังสิ้นสุด | เริ่ม re-entry อย่างระมัดระวัง |

### 12.2 ลำดับการวิเคราะห์ที่แนะนำ

1. **ดู Trend Strip ก่อน** — CONTRACTING/EXPANDING/STABLE ให้ directional bias ทันที
2. **ดู label ปัจจุบัน** — ระบุ regime ปัจจุบัน
3. **ดู |Δ|** — ประเมิน magnitude ของการเปลี่ยนแปลง
4. **ดู MRS transition_20d** (ถ้า `mrs_ready: true`) — ประเมิน duration/persistence
5. **ดู GEOM ควบคู่** — ยืนยันหรือ flag กรณีขัดแย้ง
6. **ดู factor_regime** — แยกแยะ panic จาก structured rotation ใน GEOM

### 12.3 เงื่อนไข Double Confirmation

Signal มีความน่าเชื่อถือสูงสุดเมื่อ:
- CORR และ GEOM ให้ label ตรงกัน
- Δ และ MRS transition probability สอดคล้องกัน (ทั้งบ่งชี้ทิศทางเดียวกัน)
- PC1+PC2 > 70% (Wedge Space interpretation เชื่อถือได้)

---

## 13. บรรณานุกรม

Ang, A., & Bekaert, G. (2002). International asset allocation with regime shifts. *Review of Financial Studies*, 15(4), 1137–1187.

Guidolin, M., & Timmermann, A. (2007). Asset allocation under multivariate regime switching. *Journal of Economic Dynamics and Control*, 31(12), 3982–4013.

Hamilton, J. D. (1989). A new approach to the economic analysis of nonstationary time series and the business cycle. *Econometrica*, 57(2), 357–384.

Laloux, L., Cizeau, P., Bouchaud, J.-P., & Potters, M. (1999). Noise dressing of financial correlation matrices. *Physical Review Letters*, 83(7), 1467–1470.

Nystrup, P., Hansen, B. W., Madsen, H., & Lindström, E. (2015). Regime-based versus static asset allocation: Improving risk-adjusted returns. *Journal of Risk*, 17(4), 1–30.

Nystrup, P., Madsen, H., & Lindström, E. (2017). Dynamic portfolio optimization across hidden market regimes. *Quantitative Finance*, 17(10), 1545–1558.

Plerou, V., Gopikrishnan, P., Rosenow, B., Amaral, L. A. N., Guhr, T., & Stanley, H. E. (2002). Random matrix approach to cross correlations in financial data. *Physical Review E*, 65(6), 066126.
