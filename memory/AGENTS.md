# AGENTS.md — Inter-Agent Writing Contract

> **ทุก Agent ต้องอ่านไฟล์นี้ก่อนเขียนหรือแก้ไขไฟล์ใดๆ ใน `memory/`**
> กฎเหล่านี้มีไว้เพื่อให้มนุษย์และ agent ตัวอื่นสามารถอ่านย้อนหลัง ตรวจสอบ และสืบค้นได้อย่างมีประสิทธิภาพ

---

## 1. Document Types — ไฟล์แต่ละประเภทเก็บอะไร

| ประเภท | โฟลเดอร์ | วัตถุประสงค์ | ผู้สร้าง |
|--------|---------|--------------|---------|
| **Session Report** | `sessions/` | บันทึกสิ่งที่ทำในแต่ละ session — ไฟล์ไหนเปลี่ยน, ตรวจสอบอย่างไร, rollback ได้อย่างไร | Agent ผู้ดำเนินงาน |
| **Audit/Test Report** | `sessions/reports/` | ผลการทดสอบ, raw evidence, ข้อมูลจาก API จริง — ไม่ใช่แผน | Agent ผู้ทดสอบ |
| **Plan** | `plans/` | แผนการทำงานที่ยังไม่ได้ implement — ขั้นตอน, code sample, build order | Agent หรือมนุษย์ |
| **Reference** | `reference/` | ข้อมูลสถาปัตยกรรมที่เสถียร — stack, key files, data flow | Agent หรือมนุษย์ |
| **Index** | `INDEX.md` (root) | Navigation map + feature status — ห้ามใส่ content จริง | ทุก Agent (update เมื่อจำเป็น) |
| **Session Index** | `sessions/INDEX.md` | Audit trail — ตารางรายการ session + ไฟล์ที่เปลี่ยน | ทุก Agent (update ทุก session) |

---

## 2. Naming Convention

```
sessions/YYYY-MM-DD-<task-slug>.md        เช่น 2026-05-19-pipeline-refactor.md
sessions/reports/<topic>-report.md        เช่น api-test-report.md
plans/<task-name>.md                      เช่น gmov-enhancement.md
reference/<topic>.md                      เช่น architecture.md
```

**กฎการตั้งชื่อ:**
- ใช้ kebab-case เสมอ (lowercase, คั่นด้วย `-`)
- session slug = สรุปงานหลักที่ทำใน session นั้น
- ห้ามใช้ชื่อซ้ำกับไฟล์ที่มีอยู่แล้ว ให้ append วันที่หรือ suffix แทน

---

## 3. Required Frontmatter

**ทุกไฟล์ใน `sessions/` และ `sessions/reports/` ต้องมี YAML frontmatter:**

```yaml
---
name: <kebab-case-slug>            # ตรงกับชื่อไฟล์ ไม่มี .md
description: <one-line summary>    # ใช้ใน INDEX และ search — เขียนเป็นภาษาอังกฤษหรือไทยก็ได้
metadata:
  type: project                    # ใช้ "project" เสมอสำหรับ session reports
  date: YYYY-MM-DD                 # วันที่ session
  agent: <model-name>              # เช่น Claude Sonnet 4.6, DeepSeek V4 Pro
  status: complete | partial | wip # complete = งานเสร็จ, partial = บางส่วน, wip = กำลังทำ
---
```

**Plan และ Reference ไม่บังคับ frontmatter แต่ต้องมี header block (ดู Section 4)**

---

## 4. Required Sections — แต่ละประเภทต้องมีอะไร

### 4a. Session Report (`sessions/YYYY-MM-DD-*.md`)

```markdown
# <ชื่องาน> — <วันที่>

**วันที่:** YYYY-MM-DD
**Agent:** <model name>
**งานหลัก:** <1 ประโยคบรรยายงาน>
**สถานะ:** ✅ complete | ⚠️ partial | 🔄 wip

---

## สรุปการเปลี่ยนแปลง

| ไฟล์ | การเปลี่ยนแปลง | หมายเหตุ |
|------|----------------|----------|
| `path/to/file.py` | **ADDED** / **EDITED** / **CREATED** / **DELETED** | สิ่งที่เปลี่ยน |

---

## รายละเอียด (แต่ละ Task หรือ Feature)

### <ชื่อ Task 1>
...อธิบาย what + why + design decisions...

### <ชื่อ Task 2>
...

---

## Verification

```bash/powershell
# คำสั่งที่ใช้ verify ว่างานถูกต้อง
```

**ผล:** pass / fail / not tested (+ เหตุผล)

---

## Rollback Guide

| การเปลี่ยนแปลง | วิธี rollback |
|----------------|--------------|
| `file.py` lines X–Y | ลบบรรทัด X–Y, restore เป็นค่าเดิม |

---

## ไฟล์ที่ไม่ได้แตะ (สำหรับ debug)

| ไฟล์ | เหตุผล |
|------|--------|
| `safe-file.py` | ไม่เกี่ยวข้องกับ feature นี้ |

---

## Related

- [[plan-slug]] — แผนที่ใช้อ้างอิง
- [[project_summary]] — overview
```

---

### 4b. Audit/Test Report (`sessions/reports/<topic>-report.md`)

```markdown
# รายงาน<หัวข้อ>

**วันที่:** YYYY-MM-DD
**Agent:** <model name>
**วิธีทดสอบ:** <curl / unit test / manual / etc.>
**สถานะ Backend:** <ทำงาน / หยุด> (localhost:8000)

---

## สรุปผล

| หัวข้อ | ผล | หมายเหตุ |
|--------|-----|----------|
| <item> | ✅ pass / ❌ fail / ⚠️ partial | ... |

---

## หลักฐาน (ผลจริง)

### ✅ SUCCESS — <สิ่งที่ผ่าน>
```json / bash
<raw output>
```

### ❌ FAIL — <สิ่งที่ล้มเหลว>
```
<error output>
```
**Root cause:** ...
**Fix/Workaround:** ...

---

## สรุปข้อสังเกต

- bullet points สรุปสิ่งที่ค้นพบที่สำคัญ
```

---

### 4c. Plan (`plans/<task-name>.md`)

```markdown
# <ชื่อ Feature/Task> — Workflow

**View/Component:** `<component path>`
**สร้างเมื่อ:** YYYY-MM-DD
**สถานะ:** Planning — not yet implemented | In progress | Done

---

## Summary

| # | การเปลี่ยนแปลง | Scope | Complexity |
|---|----------------|-------|------------|
| 1 | ... | Frontend only / Backend + Frontend | Low / Medium / High |

---

## Step-by-step

### Step 1 — <ชื่อ>

**ไฟล์:** `path/to/file`
**บรรทัดที่แก้:** ~line X

```language
<code sample>
```

### Step 2 — ...

---

## Build Order

```
Step 1 (~Xm) — <ชื่อ>: <สิ่งที่ทำ>
  <verify command>

Step 2 (~Xm) — ...
```

---

## ข้อควรระวัง

- bullet points เรื่องที่ต้องระวัง
```

---

## 5. Style Guide

### ภาษา
- **Section headings:** ภาษาไทยหรืออังกฤษก็ได้ แต่ต้องสม่ำเสมอภายในไฟล์เดียวกัน
- **Keys / filenames / code / paths:** อังกฤษเสมอ
- **ชื่อ field ใน frontmatter:** อังกฤษเสมอ
- หากเขียน inline ระหว่างไทย-อังกฤษ: `backtick` ชื่อไฟล์/function เสมอ

### Tables
- ใช้ markdown table เสมอเมื่อมี 2+ item ที่มีโครงสร้างเดียวกัน
- Column แรกของ "สรุปการเปลี่ยนแปลง" ต้องเป็น path ที่ใช้งานได้จริง
- ห้ามใช้ nested table

### Code Blocks
- ระบุ language hint เสมอ: ` ```python `, ` ```tsx `, ` ```bash `, ` ```json `, ` ```sql `
- Code ที่ให้ run ใน PowerShell ใช้ ` ```powershell `
- ห้ามใส่ code ยาวกว่า 60 บรรทัดในส่วน session report — ถ้ายาวกว่านั้นให้ลิงก์ไปยังไฟล์จริง

### Status Icons
| Icon | ความหมาย |
|------|----------|
| ✅ | สำเร็จ / ใช้งานได้ / complete |
| ❌ | ล้มเหลว / ใช้งานไม่ได้ / not started |
| ⚠️ | มีปัญหา / partial / ต้องระวัง |
| 📋 | planned — ยังไม่ได้เริ่ม |
| 🔄 | กำลังดำเนินการ (wip) |

### File References
- ใช้ relative path จาก repo root เสมอ: `backend/routers/stock.py`
- ระบุบรรทัดเมื่อชี้ไปยัง code เฉพาะจุด: `stock.py:304`
- ใช้ link format ใน plan files: `[stock.py](../../backend/routers/stock.py)`

### การ Action ที่ต้องบันทึก
ใน "สรุปการเปลี่ยนแปลง" ใช้ keyword เหล่านี้ใน column "การเปลี่ยนแปลง":
- **CREATED** — สร้างไฟล์ใหม่
- **EDITED** — แก้ไขไฟล์ที่มีอยู่
- **ADDED** — เพิ่ม code ลงในไฟล์ที่มีอยู่ (ไม่ได้แก้ส่วนอื่น)
- **DELETED** — ลบไฟล์
- **RENAMED** — เปลี่ยนชื่อไฟล์

---

## 6. Agent Workflow — ต้องทำอะไรเมื่อไหร่

### ก่อนเริ่มทำงาน (START of session)
1. อ่าน `memory/INDEX.md` — ดู feature status + rules สำคัญ
2. อ่าน `memory/project_summary.md` — ดู full context
3. อ่าน `memory/sessions/INDEX.md` — ดู session ล่าสุดเพื่อรู้ว่ามีอะไรเปลี่ยนไปแล้ว
4. หากงานที่รับมีแผนใน `memory/plans/` → อ่านแผนนั้นก่อนลงมือ

### ระหว่างทำงาน
- หากพบ bug หรือข้อสังเกตที่ไม่เกี่ยวกับงานหลัก → บันทึกใน session report ส่วน "ข้อสังเกตอื่น" — ห้ามแก้ code นอก scope โดยไม่บอก
- หากต้องตัดสินใจ design ที่มีผลกระทบมาก → เขียน rationale ใน session report

### หลังเสร็จงาน (END of session)
1. **สร้างหรืออัปเดต session report** ใน `sessions/YYYY-MM-DD-slug.md`
2. **อัปเดต `sessions/INDEX.md`:**
   - เพิ่มแถวในตาราง Sessions
   - เพิ่มแถวในตาราง "Quick Lookup" สำหรับทุกไฟล์ที่เปลี่ยน
3. **อัปเดต `INDEX.md` (root)** — เปลี่ยน Feature Status ของสิ่งที่ทำเสร็จ (❌ → ✅)
4. หากแผนใน `plans/` ถูก implement เสร็จแล้ว → เปลี่ยน status ในไฟล์แผนนั้นเป็น `Done`

---

## 6b. Plan Lifecycle — บังคับทุก Agent

### เมื่อสร้าง Plan ใหม่
1. สร้างไฟล์ `memory/plans/<task-name>.md` ตาม format 4c
2. เพิ่ม entry ใน `memory/project_summary.md` → section "What Could Be Built Next":
   ```markdown
   - [ ] **<Feature Name>** — <1-line description> (`plans/<task-name>.md`)
   ```
3. เพิ่มใน `memory/INDEX.md` → plans section

### เมื่อ Plan เสร็จสมบูรณ์ (implement ครบ + verify แล้ว)
1. ย้ายไฟล์: `memory/plans/<task>.md` → `memory/plans/completed/<task>.md`
2. อัปเดต `memory/project_summary.md`:
   - เปลี่ยน `- [ ]` เป็น `- [x]` พร้อมวันที่: `- [x] **<Feature>** — done YYYY-MM-DD`
3. อัปเดต `memory/INDEX.md` → เปลี่ยน path ใน plans section ให้ชี้ไป `plans/completed/`
4. สร้าง session report ตาม format 4a

### เมื่อพบ Bug Risk ระหว่างแก้ไข
หาก agent พบจุดที่มีโอกาสเป็น bug (ไม่ว่าจะเกี่ยวกับงานหลักหรือไม่):
1. **อย่าแก้ถ้าไม่ใช่ scope ของงาน** — บันทึกไว้แทน
2. สร้างไฟล์ `memory/reports/<topic>-risk-report.md`:

```markdown
# Bug Risk Report — <หัวข้อ>

**วันที่:** YYYY-MM-DD
**พบระหว่าง:** แก้ไข <ไฟล์หลัก>
**ความเสี่ยง:** 🔴 สูง / 🟡 กลาง / 🟢 ต่ำ

## จุดที่น่ากังวล

**ไฟล์:** `path/to/file.py` บรรทัด ~X
**พฤติกรรม:** <อธิบายว่าทำอะไร>
**ความเสี่ยง:** <อธิบายว่าอาจพังอย่างไร ในเงื่อนไขไหน>

## วิธีตรวจสอบ

```bash
<คำสั่งที่ใช้ reproduce หรือ verify>
```

## แนวทางแก้ไข (ถ้ามี)

<แนะนำ fix ไว้ก่อน แต่ไม่บังคับทำตอนนี้>
```

3. เพิ่ม entry ใน `memory/reference/gotchas.md` → Error Dictionary section ถ้าเป็น pattern ที่อาจเกิดซ้ำ

### กฎห้าม
- ห้ามเขียน content จริงลงใน `INDEX.md` หรือ `sessions/INDEX.md` โดยตรง — มีไว้สำหรับ navigation เท่านั้น
- ห้ามลบหรือ overwrite session report เก่า — ให้สร้างไฟล์ใหม่
- ห้ามแก้ plan file ที่ status เป็น `Not yet implemented` โดยไม่ได้รับคำสั่ง — อ่านได้ แต่ห้ามเปลี่ยน
- ห้ามเขียนรายงาน "สำเร็จ" หากยังไม่ได้ verify จริง — ถ้า verify ไม่ได้ให้เขียน `not verified` พร้อมเหตุผล

---

## 7. ตัวอย่าง Session Report ที่ดี

ดู: [`sessions/2026-05-19-pipeline-refactor.md`](sessions/2026-05-19-pipeline-refactor.md)

สิ่งที่ทำได้ดี:
- มี frontmatter ครบ
- แยก Task อย่างชัดเจน
- มี "Pattern change" แสดง before/after code
- มี "สิ่งที่ไม่ได้ migrate" บอกชัดว่าอะไรที่ถูกต้องแล้ว ไม่จำเป็นต้องเปลี่ยน
- มี verification command จริง
- มี related memories ลิงก์ถึงกัน

ดู: [`sessions/2026-05-18-bot-statistics.md`](sessions/2026-05-18-bot-statistics.md)

สิ่งที่ทำได้ดี:
- มี raw API response จริง (เป็น evidence ถาวร)
- แยก FAILURES section ชัดเจน พร้อม root cause
- มี Bug Tracing Guide สำหรับ agent ตัวอื่น
- มี "Files NOT Touched" ป้องกัน false alarm เมื่อ debug

---

## 8. Index Update Template

เมื่อต้องอัปเดต `sessions/INDEX.md` ให้เพิ่มแถวในรูปแบบนี้:

```markdown
| 2026-MM-DD | [slug.md](slug.md) | <สรุป 1 ประโยค> |
```

และในตาราง Quick Lookup:
```markdown
| `backend/routers/new-file.py` _(ใหม่)_ | 2026-MM-DD | session-slug |
| `backend/routers/edited-file.py` | 2026-MM-DD | session-slug |
```
