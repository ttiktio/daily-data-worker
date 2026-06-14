# เป้าหมายโปรเจกต์: Public GitHub Actions + Private Access

## 1. เป้าหมายหลัก

ต้องการใช้ **GitHub Actions บน Public Repository** เพื่อรันงานอัตโนมัติ เช่น เช็กข้อมูล, scrape ข้อมูลแบบสุภาพ, อัปเดตผลลัพธ์ หรือส่งแจ้งเตือน  
แต่ต้องออกแบบให้ **คนอื่นเข้าไม่ถึงข้อมูลจริง** และ **มีแค่เจ้าของเท่านั้นที่เปิดหน้าเว็บ/ผลลัพธ์ได้**

แนวคิดหลักคือ:

> Public Repo เป็นแค่ “ตัวรันงาน”  
> ส่วนข้อมูลจริง รหัส เป้าหมาย และผลลัพธ์ ต้องอยู่หลังระบบป้องกัน เช่น GitHub Secrets + Cloudflare Worker / Cloudflare Access

---

## 2. เงื่อนไขของระบบ

### ต้องเป็นแบบนี้

- Repository ต้องเป็น **Public**
- ใช้ **GitHub Actions** ได้
- คนทั่วไปดู repo ได้ แต่ไม่ควรเห็นเป้าหมายจริง
- ข้อมูลลับต้องอยู่ใน **GitHub Secrets / Cloudflare Secrets**
- หน้าเว็บจริงต้องมีระบบป้องกันก่อนเปิดดู
- รหัสผ่านต้องเดายากมาก หรือใช้ระบบล็อกอินที่ปลอดภัยกว่า password ธรรมดา
- ผลลัพธ์จาก workflow ห้าม commit ลง repo public ถ้ามีข้อมูลสำคัญ

### ห้ามทำแบบนี้

- ห้ามใส่ token / cookie / API key ลงในโค้ด
- ห้ามใส่ URL เป้าหมายจริงใน repo
- ห้ามใส่รหัสผ่านไว้ใน JavaScript ฝั่งหน้าเว็บ
- ห้ามเก็บไฟล์ผลลัพธ์สำคัญไว้ใน repo public
- ห้ามใช้ GitHub Pages แบบ static ธรรมดาเพื่อซ่อนข้อมูลลับ เพราะซ่อนไม่จริง
- ห้าม print secret ลง log ของ GitHub Actions

---

## 3. โครงสร้างภาพรวม

```text
ผู้ใช้ / เจ้าของ
    │
    ▼
Cloudflare Access หรือ Cloudflare Worker Login
    │
    ▼
Cloudflare Worker API
    │
    ▼
Cloudflare KV / D1 / R2
    ▲
    │
GitHub Actions จาก Public Repo
    ▲
    │
GitHub Secrets
```

สรุปง่าย ๆ:

```text
Public GitHub Repo
= โค้ดกลาง ๆ + workflow

GitHub Secrets
= token, URL, config, API key, Cloudflare credentials

GitHub Actions
= ตัวรันงาน

Cloudflare KV / D1 / R2
= ที่เก็บผลลัพธ์จริง

Cloudflare Worker
= backend + login gate

Cloudflare Access
= ด่านล็อกอินที่ปลอดภัยสุด
```

---

## 4. โครงสร้าง Repository

ตัวอย่างโครงสร้าง repo public:

```text
project-name/
│
├── .github/
│   └── workflows/
│       └── run.yml
│
├── src/
│   ├── main.py
│   ├── worker.py
│   └── utils.py
│
├── README.md
├── requirements.txt
└── .gitignore
```

### แนวทางตั้งชื่อ

ควรใช้ชื่อกลาง ๆ เช่น:

```text
daily-data-worker
catalog-sync
scheduled-checker
data-monitor
utility-worker
```

หลีกเลี่ยงชื่อที่เปิดเผยเป้าหมาย เช่น:

```text
shopee-scraper
voucher-bot
flash-sale-checker
private-price-tracker
```

---

## 5. สิ่งที่อยู่ใน GitHub Secrets

เก็บค่าที่ไม่ต้องการให้คนเห็นไว้ใน **Repository Secrets** เช่น:

```text
TARGET_URL
TARGET_CONFIG
API_TOKEN
SESSION_COOKIE
TELEGRAM_BOT_TOKEN
TELEGRAM_CHAT_ID
CLOUDFLARE_API_TOKEN
CLOUDFLARE_ACCOUNT_ID
CLOUDFLARE_KV_NAMESPACE_ID
```

### ตัวอย่างการเรียกใช้ใน GitHub Actions

```yaml
env:
  TARGET_URL: ${{ secrets.TARGET_URL }}
  TARGET_CONFIG: ${{ secrets.TARGET_CONFIG }}
  TELEGRAM_BOT_TOKEN: ${{ secrets.TELEGRAM_BOT_TOKEN }}
  TELEGRAM_CHAT_ID: ${{ secrets.TELEGRAM_CHAT_ID }}
  CLOUDFLARE_API_TOKEN: ${{ secrets.CLOUDFLARE_API_TOKEN }}
```

### ตัวอย่างการเรียกใช้ใน Python

```python
import os

target_url = os.getenv("TARGET_URL")
target_config = os.getenv("TARGET_CONFIG")
telegram_token = os.getenv("TELEGRAM_BOT_TOKEN")
telegram_chat_id = os.getenv("TELEGRAM_CHAT_ID")
```

---

## 6. GitHub Actions Workflow

เป้าหมายของ workflow คือ:

1. รันแบบ manual หรือ schedule
2. โหลดค่าจาก GitHub Secrets
3. ประมวลผลข้อมูล
4. ส่งผลลัพธ์ไปเก็บใน Cloudflare KV / D1 / R2
5. ไม่ commit ข้อมูลลับลง repo

### ตัวอย่าง workflow แบบ manual

```yaml
name: Run Worker

on:
  workflow_dispatch:

jobs:
  run:
    runs-on: ubuntu-latest
    timeout-minutes: 330

    steps:
      - name: Checkout repository
        uses: actions/checkout@v4

      - name: Set up Python
        uses: actions/setup-python@v5
        with:
          python-version: "3.12"

      - name: Install dependencies
        run: pip install -r requirements.txt

      - name: Run job
        env:
          TARGET_URL: ${{ secrets.TARGET_URL }}
          TARGET_CONFIG: ${{ secrets.TARGET_CONFIG }}
          CLOUDFLARE_API_TOKEN: ${{ secrets.CLOUDFLARE_API_TOKEN }}
          CLOUDFLARE_ACCOUNT_ID: ${{ secrets.CLOUDFLARE_ACCOUNT_ID }}
        run: python src/main.py
```

### หมายเหตุเรื่อง 5 ชั่วโมง

ถ้าจะรันประมาณ 5 ชั่วโมง ให้ตั้ง timeout เผื่อไว้แต่ไม่ชน 6 ชั่วโมง เช่น:

```yaml
timeout-minutes: 330
```

และในโค้ดควรมี logic ให้จบเอง เช่น loop 5 ชั่วโมงแล้วหยุด ไม่ปล่อยให้ GitHub ตัดเอง

---

## 7. ที่เก็บผลลัพธ์จริง

ไม่ควรเก็บผลลัพธ์จริงใน repo public

ให้เลือกเก็บใน Cloudflare อย่างใดอย่างหนึ่ง:

### ตัวเลือกที่ 1: Cloudflare KV

เหมาะกับข้อมูลแบบ key-value เช่น:

```json
{
  "last_update": "2026-06-14T22:00:00+07:00",
  "items": []
}
```

เหมาะกับ:
- ข้อมูลล่าสุด
- config runtime
- cache
- status

### ตัวเลือกที่ 2: Cloudflare D1

เหมาะกับข้อมูลที่เป็นตาราง เช่น:
- ประวัติราคา
- log การเปลี่ยนแปลง
- records หลายรายการ

### ตัวเลือกที่ 3: Cloudflare R2

เหมาะกับไฟล์ใหญ่ เช่น:
- JSON ขนาดใหญ่
- รูปภาพ
- export file
- archive

---

## 8. ระบบเข้าเว็บ: ตัวเลือกที่แนะนำ

## ตัวเลือก A: Cloudflare Access — แนะนำที่สุด

ให้ Cloudflare เป็นด่านล็อกอินก่อนถึงเว็บจริง

แนวคิด:

```text
เข้าเว็บ
  ↓
Cloudflare Access ตรวจอีเมล
  ↓
ถ้าเป็นอีเมลเจ้าของเท่านั้นถึงผ่าน
  ↓
เปิด Cloudflare Worker / Dashboard
```

ข้อดี:
- ไม่ต้องเขียนระบบ password เอง
- ใช้อีเมล, Google, GitHub หรือ OTP ได้
- จำกัดเฉพาะอีเมลของเจ้าของได้
- ปลอดภัยกว่า password gate ธรรมดา
- repo public ก็ไม่กระทบ เพราะ auth อยู่ที่ Cloudflare

ตัวอย่าง policy:

```text
Allow only:
tiktokky1232321@gmail.com
```

---

## ตัวเลือก B: Password Gate ผ่าน Cloudflare Worker

ถ้าอยากใช้รหัสผ่านเอง ให้ทำแบบนี้:

```text
หน้า Login
  ↓
ผู้ใช้กรอกรหัส
  ↓
Cloudflare Worker ตรวจรหัส
  ↓
ถ้าถูก สร้าง session cookie
  ↓
เปิดหน้าเว็บจริง
```

### หลักการสำคัญ

- ไม่เก็บ password ตรง ๆ
- เก็บเฉพาะ password hash ใน Cloudflare Secret
- ใช้ password แบบสุ่มยาว 24–32 ตัวอักษรขึ้นไป
- ตั้ง cookie แบบปลอดภัย

ตัวอย่าง cookie ที่ควรใช้:

```text
HttpOnly
Secure
SameSite=Strict
Max-Age=86400
```

---

## 9. รูปแบบรหัสผ่านที่ควรใช้

ถ้าใช้ password gate เอง ควรใช้รหัสผ่านแบบสุ่ม เช่น:

```text
ความยาว: 24–32 ตัวอักษรขึ้นไป
มีตัวพิมพ์เล็ก
มีตัวพิมพ์ใหญ่
มีตัวเลข
มีสัญลักษณ์
ไม่ใช่คำศัพท์
ไม่เกี่ยวกับชื่อ วันเกิด เบอร์โทร หรือ username
```

ตัวอย่างรูปแบบ:

```text
vJ9!rQ2#Lx7@pM4%zT8&kN1$
```

ไม่จำเป็นต้องใช้ตัวอย่างนี้จริง ควรสร้างใหม่จาก password manager

---

## 10. ข้อมูลที่ไม่ควรเปิดเผยใน Public Repo

ห้ามมีสิ่งเหล่านี้ใน repo:

```text
URL เป้าหมายจริง
ชื่อเว็บเป้าหมายที่ชัดเจน
token
cookie
session
API key
chat id
webhook
config จริง
ไฟล์ผลลัพธ์จริง
ชื่อไฟล์ที่สื่อเป้าหมายมากเกินไป
README ที่บอกว่า repo ใช้ทำอะไรแบบชัดเกินไป
```

ควรใช้ชื่อกลาง ๆ เช่น:

```text
main.py
worker.py
sync.py
items.json
status.json
config.example.json
```

---

## 11. README ของ repo public

README ควรเขียนกลาง ๆ เช่น:

```md
# Scheduled Data Worker

Utility workflow for periodic data synchronization and status monitoring.

## Usage

This repository contains a GitHub Actions workflow that runs a scheduled or manual data processing task.

Configuration is provided through repository secrets.
```

หลีกเลี่ยงการเขียนรายละเอียดจริง เช่น:
- ชื่อเว็บที่ตรวจ
- คำค้น
- endpoint จริง
- token
- logic ที่อ่อนไหว
- output ตัวอย่างที่เปิดเผยเป้าหมาย

---

## 12. แนวทางเขียนโค้ดให้ปลอดภัย

### ควรทำ

- อ่านค่าจาก environment variables
- ทำ rate limit
- ทำ retry แบบสุภาพ
- cache ข้อมูล
- log เฉพาะสถานะทั่วไป
- ซ่อนค่าลับจาก log
- validate response ก่อนบันทึก
- ส่งผลลัพธ์ไป Cloudflare ไม่ commit ลง repo

### ไม่ควรทำ

- print environment variables
- print full response ถ้ามีข้อมูลลับ
- commit result กลับไปที่ repo
- hardcode URL หรือ token
- ใช้ชื่อ function ที่บอกเป้าหมายชัดเกินไป
- รับ pull request แล้วให้ workflow ใช้ secrets ทันที

---

## 13. ความเสี่ยงของ Public Repo

ถึงจะซ่อนข้อมูลด้วย Secrets ได้ แต่ public repo ยังมีความเสี่ยง:

```text
คนอ่านโค้ดได้
คนเดา purpose จากชื่อไฟล์ได้
คนดู workflow ได้
คนดู commit history ได้
คนส่ง PR แปลก ๆ ได้
คนดู log บางส่วนได้ ถ้าเรา log ไม่ดี
```

ดังนั้นต้องระวัง:

- ชื่อ repo
- ชื่อไฟล์
- README
- commit message
- workflow log
- output
- artifact
- cache
- branch / PR workflow

---

## 14. Pull Request Security

ถ้า repo public อย่าให้ PR จากคนอื่นเข้าถึง secrets

แนวทาง:

```text
ไม่ใช้ pull_request_target ถ้าไม่เข้าใจความเสี่ยง
ไม่รัน untrusted code พร้อม secrets
ไม่ auto-merge
ไม่ expose secrets ผ่าน log
```

สำหรับโปรเจกต์ส่วนตัว ควรปิดการรับ contribution หรือไม่ต้องสนับสนุน PR จากคนอื่น

---

## 15. Phase การทำงาน

## Phase 1: Public Repo พื้นฐาน

- สร้าง public repo
- ตั้งชื่อกลาง ๆ
- ใส่ workflow manual
- ใส่โค้ดกลาง ๆ
- ใช้ GitHub Secrets
- ทดสอบว่า workflow รันได้

ผลลัพธ์ที่ต้องได้:

```text
กด Run workflow แล้ว job ทำงานได้
ไม่มี secret โผล่ใน log
ไม่มี output สำคัญถูก commit
```

---

## Phase 2: Cloudflare Storage

- สร้าง Cloudflare KV หรือ D1
- สร้าง API token เฉพาะสิทธิ์ที่จำเป็น
- เก็บ token ใน GitHub Secrets
- ให้ GitHub Actions ส่งผลลัพธ์ไป KV/D1

ผลลัพธ์ที่ต้องได้:

```text
GitHub Actions รันแล้วอัปเดตข้อมูลใน Cloudflare ได้
repo public ไม่เห็นข้อมูลจริง
```

---

## Phase 3: Cloudflare Worker API

- สร้าง Worker
- Worker อ่านข้อมูลจาก KV/D1
- Worker แสดงผลเป็นหน้าเว็บหรือ JSON API

ผลลัพธ์ที่ต้องได้:

```text
Worker เปิดข้อมูลจาก KV/D1 ได้
ยังไม่มีใครเข้าถึงได้ถ้าไม่ผ่านระบบล็อกอิน
```

---

## Phase 4: Authentication

เลือกอย่างใดอย่างหนึ่ง:

### แบบแนะนำ

```text
Cloudflare Access
อนุญาตเฉพาะอีเมลเจ้าของ
```

### แบบ password เอง

```text
Worker Login
ตรวจ password hash
สร้าง signed session cookie
```

ผลลัพธ์ที่ต้องได้:

```text
คนอื่นเปิดเว็บไม่ได้
เจ้าของเปิดได้
ข้อมูลจริงไม่ถูกส่งออกก่อนผ่าน auth
```

---

## Phase 5: Hardening

- ตรวจ log
- ตรวจ commit history
- ลบ artifact ที่ไม่จำเป็น
- ตั้ง retention สั้น
- จำกัดสิทธิ์ API token
- ตั้ง rate limit ฝั่ง Worker
- ตั้ง session หมดอายุ
- ตรวจว่าไม่มี secret หลุดใน frontend

ผลลัพธ์ที่ต้องได้:

```text
ระบบพร้อมใช้งานจริงระดับโปรเจกต์ส่วนตัว
```

---

## 16. Success Criteria

ถือว่าแผนสำเร็จเมื่อ:

```text
1. Repo เป็น public
2. GitHub Actions รันได้
3. ไม่มีข้อมูลลับใน repo
4. ไม่มีข้อมูลลับใน log
5. ผลลัพธ์ถูกเก็บนอก repo
6. หน้าเว็บจริงถูกป้องกันด้วย Cloudflare Access หรือ Worker Login
7. เข้าได้เฉพาะเจ้าของ
8. คนที่เจอ repo ไม่สามารถรู้เป้าหมายจริงได้ง่าย
9. คนที่เปิดเว็บโดยไม่มีสิทธิ์จะไม่เห็นข้อมูลจริง
10. ระบบยัง maintain ง่าย ไม่ซับซ้อนเกินไป
```

---

## 17. สรุปสุดท้าย

แผนที่ดีที่สุดคือ:

```text
Public GitHub Repo
= ตัวรันงานแบบกลาง ๆ

GitHub Actions
= ทำงานตามรอบหรือกดรันเอง

GitHub Secrets
= เก็บ URL, token, config, credential

Cloudflare KV/D1/R2
= เก็บผลลัพธ์จริง

Cloudflare Worker
= backend/API สำหรับอ่านผลลัพธ์

Cloudflare Access
= ล็อกให้เข้าได้เฉพาะเจ้าของ
```

หลักคิดสำคัญ:

> อย่าพยายามซ่อนข้อมูลลับใน public repo  
> แต่ให้ public repo ไม่มีข้อมูลลับตั้งแต่แรก

ถ้าทำตามนี้ คนอื่นอาจเห็น repo ได้ แต่จะไม่เห็นข้อมูลสำคัญ ไม่เห็นเป้าหมายจริง และเปิดหน้าเว็บจริงไม่ได้
