@echo off
cd /d "%~dp0"
echo Clothing ERP lokal berjalan di http://localhost:3000
echo Login awal Owner: owner@tera.local / teraowner
echo Login awal Admin: admin@tera.local / teraadmin
echo Tutup jendela ini kalau ingin mematikan server.
node server.mjs
