# PRODUCT REQUIREMENTS DOCUMENT (PRD)
## TERA Supplier Intelligence — Automated Production Monitoring, Supplier Communication & Risk Assessment
**Version:** 1.2  
**Status:** Approved — Discovery Completed  
**Parent Product:** TERA CRM/ERP  
**Primary Users:** TERA Owner, Production Manager, Admin  
**Language:** Bahasa Indonesia  

---

## 0. Project Context & Objectives

### 0.1 Project Background
TERA adalah *clothing brand* yang mengoperasikan produksi pakaian melalui supplier eksternal. Bisnis bergantung pada supplier untuk memproduksi barang sesuai dengan jadwal dan tenggat waktu yang disepakati.

Salah satu kendala operasional yang berulang adalah proses manual menghubungi supplier untuk menanyakan progres produksi, mengonfirmasi ketepatan deadline, mengidentifikasi kendala (*blockers*), dan menilai keandalan supplier. Proses manual ini memakan waktu, memerlukan follow-up berulang, dan menyulitkan evaluasi performa supplier secara obyektif across multiple batch.

TERA ingin menyelesaikan masalah ini dengan memperluas CRM/ERP yang sudah ada melalui fitur **TERA Supplier Intelligence**.

### 0.2 Ringkasan Hasil Discovery
Berdasarkan klarifikasi dan keputusan operasional TERA:
1. **Saluran Komunikasi:** Supplier saat ini menggunakan WhatsApp Personal. Untuk kebutuhan otomatisasi resmi, TERA akan mendaftarkan nomor baru untuk dikoneksikan ke **Meta WhatsApp Business Cloud API**.
2. **Identitas Kontak:** Nomor HP supplier belum tersimpan di database. Sistem akan menambahkan kolom `phone_number`, `whatsapp_status`, dan `contact_person` pada modul Supplier.
3. **Relasi Produksi:** Ditetapkan persis **1 Supplier untuk 1 Batch Produksi** (Mapping 1:1).
4. **Kebijakan Monitoring:** Permintaan progres (*progress inquiry*) otomatis dikirimkan pada **H-3 sebelum deadline batch**.
5. **Strategi MVP:** Implementasi awal difokuskan pada mesin risiko deterministik, *dashboard*, ekstraksi AI manual, dan **Simulated Messages** sebelum menghubungkan nomor ke API WhatsApp resmi.

---

## 1. Repository Strategy & Isolation

| Item | Detail Repositori | Kebijakan & Aturan Akses |
| :--- | :--- | :--- |
| **Source Repository** | `https://github.com/Calkunn/ERP-TERA` | **Read-Only**. Hanya untuk inspeksi codebase existing. Agent/Dev dilarang push/write ke repositori ini. |
| **Destination Repository** | `https://github.com/Calkunn/CRM-TERA` | **Development Output**. Seluruh komit dan push perubahan yang disetujui akan disampaikan ke repositori ini. |

---

## 2. Target Workflow & User Experience (UX)

### 2.1 Intended Workflow
1. Sistem membaca data batch produksi, penugasan supplier, progres terverifikasi, dan deadline dari database CRM.
2. Ketika batch memasuki jadwal pemantauan (**H-3 sebelum deadline**), scheduler server-side mendeteksi bahwa pembaharuan progres diperlukan.
3. Sistem mengirimkan *progress inquiry* ke supplier terkait melalui **Meta WhatsApp Business Cloud API** (dimulai dari *simulation* pada MVP).
4. Supplier membalas pesan berisi informasi progres saat ini, kendala produksi, dan estimasi tanggal selesai (*reported ETA*).
5. Sistem menerima dan menyimpan balasan asli (*raw message*).
6. LLM API menganalisis balasan, mengekstrak informasi terstruktur (JSON), serta memisahkan pernyataan pasti dari informasi yang ambigu.
7. Backend *risk engine* menghitung risiko keterlambatan batch secara deterministik menggunakan deadline, progres terverifikasi, kendala, dan riwayat historis.
8. Dashboard CRM menampilkan hasil penilaian risiko, riwayat percakapan, bukti pendukung, dan rekomendasi tindakan.
9. TERA Owner mengulas hasil untuk menentukan tindakan selanjutnya (konfirmasi ulang, permintaan tindakan korektif, atau evaluasi supplier alternatif).

### 2.2 Contoh Kasus Operasional
> **Skenario:** Batch **TERA-026** memiliki deadline penyelesaian **24 Oktober**.
> 
> 1. Pada **21 Oktober (H-3)**, sistem mengirimkan pesan otomatis ke WhatsApp supplier.
> 2. Supplier membalas: *"Progres produksi sekitar 60%. Kami sedang menunggu tambahan kain, jadi kemungkinan penyelesaian mundur ke 27 Oktober."*
> 3. **Sistem mengolah balasan:**
>    - Menyimpan pesan asli supplier.
>    - AI mengekstrak progres dilaporkan: **60%**.
>    - AI mencatat kendala: **"Keterlambatan pasokan kain"**.
>    - AI mencatat reported ETA: **27 Oktober** (terpisah dari agreed deadline 24 Oktober).
>    - Mesin deterministik backend menghitung skor risiko produksi (**High Risk** karena ETA > Deadline).
>    - Dashboard menampilkan status potensi keterlambatan dan merekomendasikan konfirmasi tanggal pasti pasokan kain.
>    - Insiden dicatat ke riwayat performa supplier setelah informasi diverifikasi.

---

## 3. Role of AI & Safety Boundaries

AI digunakan untuk memahami pesan supplier yang tidak terstruktur dan menyajikannya menjadi informasi terstruktur.

### Peran AI yang Diberikan:
- Mengekstrak persentase progres dan estimasi tanggal selesai (*reported ETA*).
- Mengidentifikasi dan mengkategorikan kendala produksi (*blockers*).
- Menjelaskan faktor risiko yang telah dihitung oleh backend.
- Merangkum riwayat percakapan.
- Merekomendasikan tindakan tindak lanjut yang rasional.

### Batasan Ketat AI (Safety Boundaries):
- **Bukan Source of Truth:** AI **dilarang keras** menjadi sumber kebenaran untuk status produksi resmi, figur keuangan, deadline, atau statistik performa supplier. Nilai-nilai tersebut harus berasal dari basis data dan logika aplikasi deterministik.
- **Untrusted Input:** Balasan supplier dianggap sebagai *untrusted input*. Perintah/instruksi yang terselip dalam pesan supplier tidak boleh mengubah kebijakan sistem atau mengeksekusi perintah CRM.
- **Tidak Merubah Data Otomatis:** AI tidak boleh secara diam-diam menimpa (*overwrite*) data produksi resmi atau mengganti supplier secara otomatis.
- **Deteksi Ambuitas:** Informasi ambigu atau berkonflik wajib ditandai untuk peninjauan manusia (*human review*).

---

## 4. Product Scope

### 4.1 MVP Scope (Fase Awal)
- Pemantauan deadline batch produksi (pemicu otomatis H-3).
- Manajemen kontak WhatsApp supplier pada modul Supplier.
- Pengiriman permintaan progres terjadwal (*Scheduled Progress Inquiry*).
- Penanganan pesan masuk (*Webhook Handler* & *Communication History*).
- Ekstraksi balasan berbasis LLM (*Structured JSON Output*).
- Verifikasi progres (memisahkan *reported progress* dan *verified progress*).
- Mesin penilaian risiko batch deterministik (*Backend Risk Engine*).
- Matriks evaluasi performa supplier berbasis histori terverifikasi.
- Rekomendasi risiko supplier untuk Owner TERA.
- Dashboard Supplier Intelligence terintegrasi di CRM-TERA.
- Eksekusi analisis AI manual via tombol *Analyze Risk*.

### 4.2 Out of Scope
- Training custom machine learning model.
- Penggantian supplier secara otomatis tanpa persetujuan Owner.
- Pengadaan barang/pembelian otomatis (*automatic purchasing/payments*).
- Computer-vision untuk inspeksi kualitas kain/pakaian.
- Rebuilding aplikasi CRM/ERP existing.

---

## 5. Functional Requirements (FR)

### FR-01 — Data Batch Produksi & Supplier
- Sistem menggunakan data dari DB existing: Batch ID, SKU, Supplier ID, Tahap Produksi, Tanggal Mulai, Agreed Deadline, Verified Progress, dan Status.
- Modul Supplier diperluas dengan bidang: `phone_number`, `whatsapp_status`, dan `contact_person`.
- Setiap batch diasosiasikan persis dengan 1 Supplier.

### FR-02 — Automated Scheduler
- Scheduler berjalan di server-side (cron job / scheduled task).
- **Kebijakan Default:** Progress request pertama dikirim otomatis pada **H-3 sebelum deadline batch**.
- Menerapkan kontrol idempotensi untuk mencegah pengiriman pesan ganda.

### FR-03 — Official WhatsApp Messaging Integration
- Channel resmi: **Meta WhatsApp Business Platform Cloud API**.
- Menerima balasan via Webhook aman (validasi signature).
- Pencocokan balasan masuk (*message correlation*) dengan Batch ID terkait.
- Merekam riwayat percakapan lengkap (*audit log*).

### FR-04 — AI Reply Extraction
- Memproses balasan supplier dan menghasilkan output terstruktur JSON:
  - `reported_progress_percent` (number)
  - `reported_stage` (string)
  - `reported_eta` (date)
  - `blockers` (array of strings)
  - `deadline_confirmation` (boolean)
  - `confidence_score` (number)
  - `needs_human_review` (boolean)
- Jika balasan ambigu, tandai `needs_human_review = true`.

### FR-05 — Deterministic Risk Engine
- Risiko keterlambatan dihitung secara deterministik di backend (skor 0 - 100):
  - **0–24 (Low Risk):** Progres sesuai target, tidak ada kendala.
  - **25–49 (Medium Risk):** Progres lambat atau terdapat kendala minor.
  - **50–100 (High Risk):** Reported ETA melampaui agreed deadline, kendala pasokan terkonfirmasi, atau supplier tidak merespons.
- AI dilarang keras mengubah atau mengambil alih kalkulasi skor deterministik ini.

### FR-06 — Supplier Performance & Analytics
- Menghitung performa dari data historis terverifikasi:
  - Total batch selesai.
  - Tingkat ketepatan waktu (*on-time completion rate*).
  - Rata-rata keterlambatan (hari).
  - Frekuensi perubahan ETA.
- Supplier dengan histori minim diberikan status **"Insufficient History"**.

### FR-07 — Recommendations & Owner Authorization
- Rekomendasi yang didukung: *Retain*, *Monitor*, *Evaluate Alternative*, atau *Insufficient Data*.
- Seluruh keputusan penting (seperti evaluasi/penggantian supplier) **wajib mendapatkan persetujuan manual dari TERA Owner**.

---

## 6. Database Schema Extension

Disesuaikan dengan konvensi database CRM/ERP existing:

### 1. `suppliers` (Table Update)
- `phone_number` (VARCHAR): Nomor WhatsApp supplier.
- `whatsapp_status` (ENUM): 'unverified', 'verified', 'opted_out'.
- `contact_person` (VARCHAR): Nama kontak penanggung jawab.

### 2. `communication_logs` (New Table)
- `id` (UUID / PK)
- `batch_id` (FK to Batches)
- `supplier_id` (FK to Suppliers)
- `direction` (ENUM: 'OUTBOUND', 'INBOUND')
- `raw_content` (TEXT): Pesan teks asli.
- `provider_message_id` (VARCHAR): ID dari Meta WhatsApp.
- `created_at` (TIMESTAMP)

### 3. `progress_reports` (New Table)
- `id` (UUID / PK)
- `batch_id` (FK to Batches)
- `supplier_id` (FK to Suppliers)
- `reported_progress_percent` (INT)
- `reported_eta` (DATE)
- `blockers` (JSONB / TEXT)
- `confidence_score` (FLOAT)
- `verification_status` (ENUM: 'PENDING', 'VERIFIED', 'REJECTED')
- `created_at` (TIMESTAMP)

### 4. `risk_assessments` (New Table)
- `id` (UUID / PK)
- `batch_id` (FK to Batches)
- `risk_score` (INT): 0 - 100.
- `risk_level` (ENUM: 'LOW', 'MEDIUM', 'HIGH')
- `risk_reasons` (JSONB / TEXT)
- `ai_analysis_summary` (TEXT)
- `created_at` (TIMESTAMP)

---

## 7. Implementation Roadmap

```
┌──────────────────────────────────────────────────────────┐
│ Phase 1: Discovery & Codebase Inspection                 │
│ - Audit struktur folder & skema DB CRM-TERA             │
└──────────────────────────┬───────────────────────────────┘
                           │
┌──────────────────────────▼───────────────────────────────┐
│ Phase 2: Core Risk Engine & Database Migration           │
│ - Tambah kolom WhatsApp & tabel pendukung                │
│ - Unit testing mesin kalkulasi risiko deterministik      │
└──────────────────────────┬───────────────────────────────┘
                           │
┌──────────────────────────▼───────────────────────────────┐
│ Phase 3: Dashboard UI & Manual AI Analysis               │
│ - Implementasi tabel risiko & tombol "Analyze Risk"      │
└──────────────────────────┬───────────────────────────────┘
                           │
┌──────────────────────────▼───────────────────────────────┐
│ Phase 4: Communication Simulator (Mock Testing)           │
│ - Testing alur pengiriman & parsing balasan tanpa WA     │
└──────────────────────────┬───────────────────────────────┘
                           │
┌──────────────────────────▼───────────────────────────────┐
│ Phase 5: Production WhatsApp Cloud API Integration       │
│ - Penyiapan Webhook, Template Pesan, & Idempotensi       │
└──────────────────────────┬───────────────────────────────┘
                           │
┌──────────────────────────▼───────────────────────────────┐
│ Phase 6: Supplier Analytics & Recommendations            │
│ - Perhitungan histori supplier & persetujuan Owner       │
└──────────────────────────────────────────────────────────┘
```

---

## 8. Definition of Done (DoD)

Fitur dinyatakan selesai (*done*) apabila:
1. Terintegrasi penuh ke dalam repositori `CRM-TERA` tanpa merusak fungsi existing.
2. Mesin risiko deterministik backend lulus unit testing.
3. Ekstraksi AI menghasilkan format JSON yang tervalidasi di server-side.
4. Dashboard hanya menjalankan panggilan LLM saat tombol *Analyze Risk* diklik atau pesan balasan baru masuk (tidak dipanggil otomatis pada *page load*).
5. Tidak ada API key, token, atau kredensial yang bocor ke dalam Git repository.
6. Rekomendasi penggantian supplier memerlukan konfirmasi persetujuan dari Owner TERA.
7. Seluruh perintah build, lint, dan test berhasil dieksekusi.