# Regime Detection — วิธีคำนวณ

---

## ขั้นตอนที่ 1: เตรียมข้อมูล

```
รับ: prices ของ 11 sector ETFs (XLK, XLF, ..., XLC)
period lookback: 1m / 3m / 6m / 1y
interval: daily (1d)
```

### 1.1 คำนวณ Daily Returns

$$r_{i,t} = \frac{P_{i,t} - P_{i,t-1}}{P_{i,t-1}}$$

ได้ matrix returns $R$ ขนาด $T \times N$ (T วัน, N = 11 sectors)

### 1.2 Standardise (implied)

เมื่อคำนวณ Pearson correlation ตัว standardisation เกิดขึ้น implicit:

$$\hat{r}_{i,t} = \frac{r_{i,t} - \mu_i}{\sigma_i}$$

---

## CORR Mode

### 2.1 Pearson Correlation Matrix

$$C_{ij} = \rho_{ij} = \frac{\sum_t \hat{r}_{i,t} \cdot \hat{r}_{j,t}}{T - 1}$$

ได้ symmetric matrix ขนาด $11 \times 11$ โดย $C_{ii} = 1$ เสมอ

**แสดงใน heatmap:**
- $\rho = +1$ → สีแดง-ส้ม (co-move เต็มที่)
- $\rho = 0$ → สีดำ (ไม่สัมพันธ์)
- $\rho = -1$ → สีน้ำเงิน (inverse)

### 2.2 CORR Regime Score

$$\text{score}_\text{CORR} = \frac{1}{\binom{N}{2}} \sum_{i < j} |\rho_{ij}|$$

คือค่าเฉลี่ย absolute correlation ของทุก pair (55 pairs จาก 11 sectors)

**Range:** [0, 1]
- ใกล้ 0 = sectors เคลื่อนอิสระจากกัน
- ใกล้ 1 = sectors เคลื่อนพร้อมกันทั้งหมด

---

## GEOM Mode

### 3.1 Geometric Interpretation ของ Correlation Matrix

**Insight สำคัญ:** ถ้า $\hat{r}_i$ คือ unit-normalised return vector ของ sector $i$ ใน $\mathbb{R}^T$

$$C_{ij} = \langle \hat{r}_i, \hat{r}_j \rangle = \cos\theta_{ij}$$

ดังนั้น $C$ คือ **Gram matrix** ของ vector set $\{\hat{r}_1, \ldots, \hat{r}_N\}$ นั่นเอง

### 3.2 Wedge Product Magnitude

$$|sin\,\theta_{ij}| = \sqrt{1 - \rho_{ij}^2}$$

คือ magnitude ของ **2-blade** (wedge product) ระหว่าง $\hat{r}_i$ และ $\hat{r}_j$:

$$\hat{r}_i \wedge \hat{r}_j = |\hat{r}_i||\hat{r}_j|\sin\theta_{ij}$$

**ความหมาย:**
- $= 0$ → vectors parallel (sectors เคลื่อนในทิศเดียวกัน)
- $= 1$ → vectors orthogonal (sectors เคลื่อนอิสระจากกัน)

**แสดงใน heatmap (GEOM MTX):**
- $0$ → สีดำ (co-moving)
- $1$ → สีเขียวสว่าง (orthogonal/independent)

### 3.3 Gram Determinant

$$\det(C) = |\hat{r}_1 \wedge \hat{r}_2 \wedge \cdots \wedge \hat{r}_N|^2$$

คือ **squared volume** ของ N-dimensional parallelepiped ที่ถูก span โดย unit sector vectors

**คุณสมบัติ:**
- ถ้า sectors ทั้งหมด orthogonal กัน: $\det(C) = 1$ (maximum volume)
- ถ้า sectors ทั้งหมด parallel กัน: $\det(C) = 0$ (collapsed to line)
- ค่าจริง: $0 \leq \det(C) \leq 1$ เสมอ (เพราะ C เป็น PSD matrix)

### 3.4 GEOM Regime Score

$$\text{score}_\text{GEOM} = \det(C)^{1/N}$$

ใช้ N-th root เพื่อ normalise ตาม dimension (geometric mean ของ eigenvalues ที่ normalised)

**ทำไมต้อง N-th root:**
- $\det(C) = \prod_{k=1}^{N} \lambda_k$ (product ของ eigenvalues)
- $\det(C)^{1/N} = \left(\prod_{k=1}^{N} \lambda_k\right)^{1/N}$ = geometric mean ของ eigenvalues
- ทำให้ scale ไม่ขึ้นกับจำนวน sectors $N$

**Range:** [0, 1]

---

## Wedge Space PCA (SPC view)

### 4.1 จุดประสงค์

Project sector return vectors ลงใน 2D subspace ที่ optimal — เพื่อแสดงความสัมพันธ์เชิงมุมของ sectors

### 4.2 วิธีคำนวณ

**Eigendecomposition ของ Gram matrix C:**

$$C = V \Lambda V^\top$$

โดย $\lambda_1 \geq \lambda_2 \geq \cdots \geq \lambda_N \geq 0$ และ $V$ คือ eigenvectors

**Coordinates ของ sector $i$ ใน 2D:**

$$x_i = \sqrt{\lambda_1} \cdot v_{1,i}$$
$$y_i = \sqrt{\lambda_2} \cdot v_{2,i}$$

**Normalise** ให้ fit ใน $[-1, 1]$:
$$\hat{x}_i = \frac{x_i}{\max_k |x_k|}, \quad \hat{y}_i = \frac{y_i}{\max_k |y_k|}$$

### 4.3 ทำไม scale ด้วย $\sqrt{\lambda}$

เพราะ inner product ใน 2D projection จะ approximate correlation จริง:

$$\langle \hat{r}_i, \hat{r}_j \rangle \approx x_i x_j + y_i y_j = \sqrt{\lambda_1}\,v_{1,i}\,v_{1,j}\sqrt{\lambda_1} + \sqrt{\lambda_2}\,v_{2,i}\,v_{2,j}\sqrt{\lambda_2}$$

$$= \lambda_1 v_{1,i} v_{1,j} + \lambda_2 v_{2,i} v_{2,j} \approx \rho_{ij}$$

(approximate ได้ดีเมื่อ $\lambda_1 + \lambda_2$ explain variance สูง เช่น > 60%)

### 4.4 Variance Explained

$$\text{PC1+PC2 var} = \frac{\lambda_1 + \lambda_2}{\sum_{k=1}^{N} \lambda_k} = \frac{\lambda_1 + \lambda_2}{N}$$

แสดงใน UI เป็น % — ยิ่งสูง ยิ่ง reliable ที่จะตีความจาก 2D plot

### 4.5 Convex Hull Area

Hull area ของ arrow tips ≈ proxy สำหรับ "spread" ของ vectors ใน 2D

$$\text{hull area} = \frac{1}{2}\left|\sum_{i=1}^{H} (x_i y_{i+1} - x_{i+1} y_i)\right|$$

(shoelace formula, H = จำนวน vertices ของ convex hull)

แสดงเป็น ratio กับ circle area: $\frac{\text{hull area}}{\pi R^2}$
- สูง = sectors spread = DIVERGENT
- ต่ำ = sectors cluster = CORRELATED

---

## Implementation Notes

### Backend (Python)

```python
# regime.py key functions

_fetch_returns(period)        # yfinance download → pct_change()
_regime_gram(returns)         # det(C)^(1/N) → label
_regime_avg_corr(matrix, n)   # avg |ρ| → label
_pca_2d(corr_array)           # eigendecomposition → (x,y) coords
```

### Threshold Calibration

threshold ปัจจุบันตั้งแบบ heuristic — ควร calibrate กับ historical regimes:

| Period | Event | Expected Score (GEOM) |
|--------|-------|----------------------|
| Sep–Nov 2008 | Financial Crisis | < 0.15 |
| Mar 2020 | COVID crash | < 0.20 |
| 2021 H1 | Bull run / rotation | 0.45–0.65 |
| 2022–2023 | Rate hike cycle | 0.30–0.50 |
| Normal bull | — | 0.50–0.70 |
