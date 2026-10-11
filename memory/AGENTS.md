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
| **Completed Plan** | `plans/completed/` | แผนที่ทำเสร็จและมี `## ✅ Completion Evidence` (ดู 6b) | Agent ผู้ปิดงาน |
| **Risk Report** | `reports/` | จุดเสี่ยง bug ที่พบแต่อยู่นอก scope — ไฟล์, บรรทัด, วิธี reproduce (ดู 6b) | Agent ผู้พบ |
| **Core summary** | `project_summary.md` | ภาพรวมเดียวของทั้งระบบ: run, tests, stack, env vars, routers, DB schema, views, agent access, known issues, plan list | ทุก Agent (ดู 6c) |
| **Reference** | `reference/` | ข้อมูลสถาปัตยกรรมที่เสถียร — stack, key files, data flow, endpoints, shapes, gotchas, spec ที่ MCP เสิร์ฟ | Agent หรือมนุษย์ |
| **Index** | `INDEX.md` (root) | Navigation map + feature status — ห้ามใส่ content จริง | ทุก Agent (update เมื่อจำเป็น) |
| **Session Index** | `sessions/INDEX.md` | Audit trail — ตารางรายการ session + ไฟล์ที่เปลี่ยน | ทุก Agent (update ทุก session) |

### อะไรอยู่ใน git อะไรอยู่เฉพาะเครื่อง

| อยู่ใน git — ทุกเครื่องและทุก agent เห็นเหมือนกัน | เฉพาะเครื่อง (`.gitignore`) |
|---|---|
| `INDEX.md` · `AGENTS.md` · `project_summary.md` · `reference/*` · `../CLAUDE.md` · `../docs/*` | `plans/` (รวม `completed/`) · `sessions/` · `reports/` |

- ข้อเท็จจริงที่ agent ตัวอื่นต้องใช้ **ต้องอยู่ฝั่งซ้าย** — session report อย่างเดียวไม่พอ เพราะอีกเครื่องไม่มีไฟล์นั้น
- ลิงก์ใน `INDEX.md` ที่ชี้ไป `plans/` · `sessions/` · `reports/` อาจไม่มีไฟล์บนเครื่องนี้ = ไฟล์อยู่อีกเครื่อง ไม่ใช่ถูกลบ ห้ามลบลิงก์เพราะเหตุนี้

---

## 2. Naming Convention

```
sessions/YYYY-MM-DD-<task-slug>.md        เช่น 2026-05-19-pipeline-refactor.md
sessions/reports/<topic>-report.md        เช่น api-test-report.md
plans/<task-name>.md                      เช่น gmov-enhancement.md
plans/completed/<task-name>.md            ชื่อเดิม ย้ายเมื่อผ่านเงื่อนไขใน 6b
reports/<topic>-risk-report.md            เช่น db-latency-risk-report.md
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
**สถานะ Backend:** <ทำงาน / หยุด> (localhost:9317)

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

---

## ✅ Completion Evidence

> **บังคับกรอกก่อน OP-4 จะย้ายไป `plans/completed/`** — ถ้าไม่มี section นี้ plan จะไม่ถูก move แม้ checkbox ครบ

**วันที่เสร็จ:** YYYY-MM-DD
**ยืนยันโดย:** <ชื่อ agent หรือมนุษย์>
**หลักฐาน:** <เลือกอย่างน้อย 1>
- Git commit: `<hash>` / PR #N
- Test output: pass (N/N)
- Manual verify: <สิ่งที่ตรวจ + ผลที่เห็น>
**หมายเหตุ:** <optional — edge case, known limitation>
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
1. อ่าน `memory/project_summary.md` — ภาพรวมเดียวของระบบ (ลำดับเดียวกับ `CLAUDE.md` บรรทัดแรก)
2. อ่าน `memory/INDEX.md` — ดู feature status + rules สำคัญ + "ต้องการรู้เรื่องอะไร → อ่านที่ไหน"
3. อ่าน `memory/sessions/INDEX.md` — ดู session ล่าสุดบนเครื่องนี้ (ไฟล์เฉพาะเครื่อง — ไม่มีก็ข้าม); อะไรเข้า `main` บ้างดูจาก git: `git log --merges --first-parent --date=short --format="%ad %s"`
4. หากงานที่รับมีแผนใน `memory/plans/` → อ่านแผนนั้นก่อนลงมือ
5. ตามชนิดงาน: จะแก้ bug → `reference/gotchas.md` ก่อน · จะหาข้อมูล → `reference/data-sources.md` ก่อนค้นเว็บ · ข้อมูลหาย/ช้า → `logs/upstream.jsonl` ก่อน (`CLAUDE.md`)
6. จะเรียก backend ในฐานะ agent → `project_summary.md` → "Agent access" (MCP · ASK · REST) และ `docs/mcp-server.md`

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
5. **อัปเดตไฟล์ที่อยู่ใน git ตาม 6c** — ถ้าเพิ่ม/ลบ router, endpoint, view, ตาราง, env var, MCP tool หรือ ASK tool แล้วไม่แก้ `project_summary.md` + `reference/` ใน commit เดียวกับ code, agent ตัวถัดไปจะเห็นระบบคนละภาพ

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

> ⚠️ **ต้องผ่าน 2 เงื่อนไข** ก่อน move — ถ้าขาดข้อใดข้อหนึ่ง ห้าม move:
> 1. checkbox ครบทุกอัน (ไม่มี `- [ ]` เหลือ)
> 2. มี `## ✅ Completion Evidence` section พร้อม **วันที่เสร็จ + หลักฐานอย่างน้อย 1 ชิ้น**
>
> ถ้าเงื่อนไขไม่ครบ → เขียน **"BLOCKED: missing evidence"** ใน report แล้วหยุด รอมนุษย์ยืนยัน

1. กรอก `## ✅ Completion Evidence` ในไฟล์ plan (format ดู Section 4c)
2. ย้ายไฟล์: `memory/plans/<task>.md` → `memory/plans/completed/<task>.md`
3. อัปเดต `memory/project_summary.md`:
   - เปลี่ยน `- [ ]` เป็น `- [x]` พร้อมวันที่: `- [x] **<Feature>** — done YYYY-MM-DD`
4. อัปเดต `memory/INDEX.md` → เปลี่ยน path ใน plans section ให้ชี้ไป `plans/completed/`
5. สร้าง session report ตาม format 4a

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

---

## 6c. ภาพรวมเดียวกันทุก Agent — ตัวเลขนับจาก repo ไม่ใช่จำ

`project_summary.md` คือภาพรวมที่ agent ทุกตัวอ่าน ตัวเลขในนั้นซ้ำอยู่ในไฟล์อื่นด้วย — แก้ที่หนึ่งต้องแก้ให้ครบ
ตารางว่า "เปลี่ยนอะไร → แก้ไฟล์ไหน" อยู่ที่ `CLAUDE.md` → "Memory Maintenance"; ตารางนี้บอกว่า **นับจากไหน** และ **เลขเดียวกันอยู่ที่ไหนบ้าง**

| สิ่งที่นับ | นับจาก (รันจาก repo root) | เลขนี้ปรากฏที่ |
|-----------|---------------------------|----------------|
| Routers | `grep -c "include_router" backend/main.py` | `project_summary.md` (Stack + Backend Architecture) · `INDEX.md` · `reference/architecture.md` · `CLAUDE.md` (Memory files) · `README.md` |
| Views | union ของ `currentViewAtom` ใน `components/bloomberg/atoms/index.ts` (ลบ `stock` = ไม่มีปุ่ม nav) | `project_summary.md` · `INDEX.md` · `reference/architecture.md` · `reference/frontend-structure.md` · `CLAUDE.md` (Views) · `README.md` |
| MCP tools | `grep -c "@mcp.tool" backend/mcp_server.py` | `project_summary.md` → "Agent access" · `INDEX.md` · `docs/mcp-server.md` · `CLAUDE.md` |
| ASK tools | `grep -cE '^\s*"name": "' backend/routers/news_ai.py` | `project_summary.md` (router `news_ai.py` + "Agent access") |
| DB tables | `SELECT type, COUNT(*) FROM sqlite_master GROUP BY type` บน `backend/portfolio.db` (เปิดแบบ read-only) | `project_summary.md` → "SQLite Database Schema" · `INDEX.md` |
| Next.js proxies | `find app/api -name route.ts \| wc -l` | `project_summary.md` → "Agent access" |
| Test counts | รัน `npm run test:*` / `pytest --collect-only -q` จริง | `project_summary.md` → "Tests" |

กฎ:
- **ห้ามเขียนตัวเลขจากความจำหรือจากไฟล์ memory อีกไฟล์** — นับใหม่ แล้วใส่วันที่นับ (`counted YYYY-MM-DD`)
- Router ทุกตัวที่ mount ใน `main.py` ต้องมีแถวใน `project_summary.md` และมี route อยู่ใน `reference/api-endpoints.md` — รวมตัวที่ไม่มี UI (เขียนว่า "no UI")
- ตารางใหม่ทุกตารางต้องมีชื่ออยู่ใน `project_summary.md` พร้อมบอกว่า sync หรือเฉพาะเครื่อง
- MCP tool ใหม่ → เพิ่มในกลุ่มของมันทั้งใน `project_summary.md` → "Agent access" และ `docs/mcp-server.md` → Tools พร้อมบอกว่าเขียนข้อมูลได้หรืออ่านอย่างเดียว
- ตรวจทั้งชุดอีกครั้ง: สั่ง "audit memory" (skill `update-memory`) — ครั้งล่าสุด 2026-10-09

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
