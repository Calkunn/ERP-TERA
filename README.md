# TERA ERP Local

Aplikasi ERP lokal untuk brand TERA dengan login Owner/Admin, dashboard penjualan, input pendapatan bulanan, dan dua inventory pool.

## Menjalankan aplikasi

```powershell
node server.mjs
```

Buka:

```text
http://localhost:3000
```

Database SQLite otomatis dibuat di:

```text
data/erp.sqlite
```

## Modul awal

- Login Owner/Admin
- Dashboard dengan diagram penjualan, distribusi stock, dan sisa stock artikel
- Tema monochrome; light mode tombol hitam, dark mode abu gelap dengan tombol abu muda
- Dark mode dengan tombol bulan/matahari
- Input pendapatan online dan offline per bulan, termasuk artikel terjual dan qty online/offline
- Edit atau hapus riwayat pendapatan bulanan
- Input pengeluaran bulanan dan profit kumulatif untuk melihat balik modal
- Artikel dan varian SKU
- Edit detail artikel termasuk HPP ketika harga bahan baku atau jasa berubah
- Hilangkan artikel dari daftar aktif
- Online Inventory dan Offline Inventory
- Tambah artikel baru beserta stock awal online/offline
- Terima stok dan transfer stok antar inventory
- Riwayat pergerakan stok dengan filter bulan
- Laporan revenue, COGS, gross profit, dan margin per SKU

## Login awal

```text
Owner: owner@tera.local / teraowner
Admin: admin@tera.local / teraadmin
```

Kamu juga bisa membuat akun Owner/Admin sendiri dari layar login.
