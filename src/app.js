const rupiah = new Intl.NumberFormat("id-ID", { style: "currency", currency: "IDR", maximumFractionDigits: 0 });
const number = new Intl.NumberFormat("id-ID");

const titles = {
  dashboard: ["Dashboard", "Track penjualan, distribusi stock, dan sisa stock artikel TERA."],
  products: ["Artikel & Stock", "Tambah artikel, cek sisa stock, terima stock, dan transfer antar inventory."],
  inventori: ["Inventori", "Kelola transfer stock dan lihat riwayat pergerakan inventory."],
  pembelian: ["Pembelian & PO", "Kelola purchase order dan database supplier."],
  produksi: ["Produksi", "Kelola batch produksi (cutting, sewing, finishing)."],
  penjualan: ["Penjualan", "Input pendapatan online/offline bulanan dan detail artikel terjual."],
  pengeluaran: ["Pengeluaran", "Kelola biaya operasional, gaji, jahit, sablon, dan lainnya."],
  keuangan: ["Keuangan", "Buku kas, grafik arus kas bulanan, dan ringkasan keuangan TERA."],
  laporan: ["Laporan", "Income Statement, Cash Budget, dan Ringkasan Laba Rugi SKU/Channel model TERA."],
  "ai-consultant": ["Konsultan AI", "Virtual COO terintegrasi untuk pendampingan operasional, keuangan, & branding TERA."],
  pengaturan: ["Pengaturan", "Informasi sistem dan konfigurasi server ERP."]
};

let authToken = localStorage.getItem("tera_token") || "";
let currentUser = JSON.parse(localStorage.getItem("tera_user") || "null");
let productRows = [];
let monthlyRevenueRows = [];
let currentProductionBatches = [];
let currentPurchaseOrders = [];

// Base URL backend untuk Vercel. Menggunakan environment variable VITE_API_URL jika ada (misal di Vercel), default kosong (menggunakan proxy lokal).
const API_BASE = import.meta.env.VITE_API_URL || '';

async function api(path, options = {}) {
  const url = path.startsWith('http') ? path : `${API_BASE}${path}`;
  const res = await fetch(url, {
    headers: {
      "Content-Type": "application/json",
      ...(authToken ? { Authorization: `Bearer ${authToken}` } : {})
    },
    ...options
  });
  
  let data;
  try {
    data = await res.json();
  } catch (parseError) {
    console.error(`Failed to parse JSON from ${path}:`, parseError);
    if (!res.ok) {
      throw new Error(`Server error: ${res.status} ${res.statusText}`);
    }
    throw new Error("Response server tidak valid");
  }
  
  if (!res.ok) throw new Error(data.error || `Request gagal: ${res.status}`);
  return data;
}

function toast(message) {
  const el = document.querySelector("#toast");
  if (el) {
    el.textContent = message;
    el.style.display = "block";
    setTimeout(() => (el.style.display = "none"), 2800);
  }
}

function formData(form) {
  return Object.fromEntries(new FormData(form).entries());
}

function badge(value) {
  const cls = value?.includes("Offline") || value === "Store" || value === "Event" || value === "Offline" ? "offline" : "marketplace";
  return `<span class="badge ${cls}">${value}</span>`;
}

function table(selector, columns, rows, empty = "Belum ada data") {
  const el = document.querySelector(selector);
  if (!el) return;
  const thead = `<thead><tr>${columns.map((c) => `<th>${c.label}</th>`).join("")}</tr></thead>`;
  const tbody = rows.length
    ? `<tbody>${rows.map((row) => `<tr>${columns.map((c) => `<td>${c.render ? c.render(row) : row[c.key] ?? ""}</td>`).join("")}</tr>`).join("")}</tbody>`
    : `<tbody><tr><td colspan="${columns.length}">${empty}</td></tr></tbody>`;
  el.innerHTML = thead + tbody;
}

function monthName(month) {
  if (!month || month === "-") return "-";
  const parts = String(month).split("-");
  if (parts.length < 2) return month;
  const year = Number(parts[0]);
  const value = Number(parts[1]);
  if (isNaN(year) || isNaN(value)) return month;
  return new Date(year, value - 1).toLocaleDateString("id-ID", { month: "short", year: "2-digit" });
}

function chartColors() {
  const dark = document.body.classList.contains("dark");
  return {
    text: dark ? "#f4f4f5" : "#09090b",
    muted: dark ? "#71717a" : "#71717a",
    line: dark ? "#1f1f23" : "#e4e4e7",
    online: dark ? "#f4f4f5" : "#09090b", // Monochrome main
    offline: dark ? "#71717a" : "#71717a", // Monochrome secondary
    amber: dark ? "#f59e0b" : "#d97706", // Accent amber
    panel: dark ? "#111113" : "#ffffff"
  };
}

function clearCanvas(canvas) {
  const ctx = canvas.getContext("2d");
  const dpr = window.devicePixelRatio || 1;
  const rect = canvas.getBoundingClientRect();
  const cssWidth = Math.max(280, rect.width || canvas.parentElement?.clientWidth || 420);
  
  // Scale down chart heights on mobile to keep them compact and prevent long scrolls
  let cssHeight = Number(canvas.getAttribute("height")) || 260;
  if (window.innerWidth <= 820) {
    cssHeight = Math.min(cssHeight, 180);
  }

  canvas.style.height = `${cssHeight}px`;
  canvas.width = Math.max(1, Math.floor(cssWidth * dpr));
  canvas.height = Math.max(1, Math.floor(cssHeight * dpr));
  ctx.scale(dpr, dpr);
  ctx.clearRect(0, 0, cssWidth, cssHeight);
  return { ctx, width: cssWidth, height: cssHeight };
}

function rupiahCompact(val) {
  if (val >= 1000000) return `${(val / 1000000).toFixed(1)}jt`;
  if (val >= 1000) return `${(val / 1000).toFixed(0)}rb`;
  return val;
}

function drawLineChart(canvasId, rows, config) {
  const canvas = document.querySelector(`#${canvasId}`);
  if (!canvas) return;
  const { ctx, width, height } = clearCanvas(canvas);
  const colors = chartColors();
  const pad = width > 400 ? 42 : 32;
  if (!rows.length) {
    ctx.fillStyle = colors.muted;
    ctx.font = width > 400 ? "13px 'Plus Jakarta Sans', system-ui" : "11px 'Plus Jakarta Sans', system-ui";
    ctx.fillText("Belum ada data", pad, height / 2);
    return;
  }

  const max = Math.max(1, ...rows.flatMap((row) => config.series.map((s) => Math.abs(Number(row[s.key] || 0)))));
  const groupWidth = (width - pad * 2) / Math.max(1, rows.length);

  // Draw Horizontal Dashed Gridlines
  ctx.strokeStyle = colors.line;
  ctx.lineWidth = 0.8;
  ctx.setLineDash([4, 4]);
  ctx.fillStyle = colors.muted;
  ctx.font = width > 400 ? "10px 'Plus Jakarta Sans', system-ui" : "9px 'Plus Jakarta Sans', system-ui";
  for (let i = 0; i <= 4; i++) {
    const y = pad + ((height - pad * 2) / 4) * i;
    ctx.beginPath();
    ctx.moveTo(pad, y);
    ctx.lineTo(width - pad, y);
    ctx.stroke();

    const val = max - (max / 4) * i;
    ctx.textAlign = "right";
    ctx.fillText(rupiahCompact(val), pad - 8, y + 3);
  }
  ctx.setLineDash([]); // Reset line dash

  // Draw Data Series
  config.series.forEach((series) => {
    const points = rows.map((row, index) => {
      const x = pad + index * groupWidth + groupWidth / 2;
      const value = Number(row[series.key] || 0);
      const y = height - pad - (value / max) * (height - pad * 2);
      return { x, y };
    });

    if (points.length === 0) return;

    // Draw Filled Area Gradient first
    ctx.beginPath();
    ctx.moveTo(points[0].x, points[0].y);
    for (let i = 1; i < points.length; i++) {
      ctx.lineTo(points[i].x, points[i].y);
    }
    const bottomY = height - pad;
    ctx.lineTo(points[points.length - 1].x, bottomY);
    ctx.lineTo(points[0].x, bottomY);
    ctx.closePath();

    const grad = ctx.createLinearGradient(0, pad, 0, bottomY);
    let rgbaStart = "rgba(245, 158, 11, 0.15)";
    let rgbaEnd = "rgba(245, 158, 11, 0)";
    if (series.color === colors.online) {
      const isDark = document.body.classList.contains("dark");
      rgbaStart = isDark ? "rgba(244, 244, 245, 0.12)" : "rgba(9, 9, 11, 0.06)";
      rgbaEnd = isDark ? "rgba(244, 244, 245, 0)" : "rgba(9, 9, 11, 0)";
    } else if (series.color === colors.offline) {
      rgbaStart = "rgba(113, 113, 122, 0.08)";
      rgbaEnd = "rgba(113, 113, 122, 0)";
    }

    grad.addColorStop(0, rgbaStart);
    grad.addColorStop(1, rgbaEnd);
    ctx.fillStyle = grad;
    ctx.fill();

    // Draw Line Stroke
    ctx.strokeStyle = series.color;
    ctx.lineWidth = 2.5;
    ctx.beginPath();
    ctx.moveTo(points[0].x, points[0].y);
    for (let i = 1; i < points.length; i++) {
      ctx.lineTo(points[i].x, points[i].y);
    }
    ctx.stroke();

    // Draw Point Circles
    ctx.fillStyle = series.color;
    points.forEach((pt) => {
      ctx.beginPath();
      ctx.arc(pt.x, pt.y, 4, 0, Math.PI * 2);
      ctx.fill();
      ctx.strokeStyle = colors.panel;
      ctx.lineWidth = 1.5;
      ctx.stroke();
    });
  });

  // Draw X Axis Labels
  rows.forEach((row, index) => {
    const x = pad + index * groupWidth + groupWidth / 2;
    ctx.fillStyle = colors.muted;
    ctx.textAlign = "center";
    ctx.font = width > 400 ? "10px 'Plus Jakarta Sans', system-ui" : "9px 'Plus Jakarta Sans', system-ui";
    ctx.fillText(config.label(row), x, height - 11);
  });

  // Draw Legend Elements
  config.series.forEach((series, index) => {
    const spacing = width > 400 ? 110 : (width - pad * 2) / Math.max(1, config.series.length);
    const lx = pad + index * spacing;
    const ly = width > 400 ? 18 : 12;

    ctx.fillStyle = series.color;
    ctx.beginPath();
    ctx.arc(lx + 5, ly, 4.5, 0, Math.PI * 2);
    ctx.fill();

    ctx.fillStyle = colors.text;
    ctx.font = width > 400 ? "11px 'Plus Jakarta Sans', system-ui" : "9px 'Plus Jakarta Sans', system-ui";
    ctx.textAlign = "left";
    ctx.fillText(series.label, lx + 14, ly + 3);
  });
}

function drawPieChart(canvasId, rows) {
  const canvas = document.querySelector(`#${canvasId}`);
  if (!canvas) return;
  const { ctx, width, height } = clearCanvas(canvas);
  const colors = chartColors();
  const total = rows.reduce((sum, row) => sum + Number(row.qty || 0), 0) || 1;
  let angle = -Math.PI / 2;
  const cx = width / 2;
  const cy = height / 2 - 25;
  const radius = Math.min(width, height) * 0.22;

  // Modern soft palette colors
  const isDark = document.body.classList.contains("dark");
  const sliceColors = isDark 
    ? ["#38bdf8", "#34d399", "#fbbf24", "#c084fc", "#f43f5e", "#22d3ee"]
    : ["#09090b", "#4b5563", "#71717a", "#a1a1aa", "#d4d4d8"];

  rows.forEach((row, index) => {
    const slice = (Number(row.qty || 0) / total) * Math.PI * 2;
    ctx.beginPath();
    ctx.moveTo(cx, cy);
    ctx.arc(cx, cy, radius, angle, angle + slice);
    ctx.closePath();
    ctx.fillStyle = sliceColors[index % sliceColors.length];
    ctx.fill();
    angle += slice;
  });

  // Cut center to make a Donut Chart
  ctx.beginPath();
  ctx.arc(cx, cy, radius * 0.6, 0, Math.PI * 2);
  ctx.closePath();
  ctx.fillStyle = colors.panel;
  ctx.fill();

  // Draw Center Text
  ctx.fillStyle = colors.text;
  ctx.font = "bold 13px 'Plus Jakarta Sans', system-ui";
  ctx.textAlign = "center";
  ctx.fillText(rupiahCompact(total), cx, cy - 2);
  ctx.fillStyle = colors.muted;
  ctx.font = "9px 'Plus Jakarta Sans', system-ui";
  ctx.fillText("Total Stok", cx, cy + 9);

  // Draw Legend Lists
  rows.forEach((row, index) => {
    let x = 32;
    let y = height - 42 + index * 18;
    if (width <= 400) {
      const spacing = (width - 64) / Math.max(1, rows.length);
      x = 32 + index * spacing;
      y = height - 16;
    }
    
    ctx.fillStyle = sliceColors[index % sliceColors.length];
    ctx.beginPath();
    ctx.arc(x, y - 4, 4.5, 0, Math.PI * 2);
    ctx.fill();

    ctx.fillStyle = colors.text;
    ctx.font = width > 400 ? "11px 'Plus Jakarta Sans', system-ui" : "9px 'Plus Jakarta Sans', system-ui";
    ctx.textAlign = "left";
    ctx.fillText(`${row.pool}: ${number.format(row.qty || 0)} pcs`, x + 12, y);
  });
}

// Draw "Sisa Stock per Artikel" as a Line Chart instead of a Bar Chart
function drawArticleStockLineChart(canvasId, rows) {
  const chartRows = rows.slice(0, 8); // Top 8 articles
  drawLineChart(canvasId, chartRows, {
    label: (row) => row.name.length > 15 ? `${row.name.slice(0, 12)}...` : row.name,
    series: [
      { key: "total_qty", label: "Stok Total", color: chartColors().online }
    ]
  });
}

function showApp() {
  document.querySelector("#loginScreen").classList.add("hidden");
  document.querySelector("#appShell").classList.remove("hidden");
  
  // Update name, role, avatar
  document.querySelector("#currentUser").textContent = currentUser.name;
  const roleEl = document.querySelector("#currentUserRole");
  if (roleEl) roleEl.textContent = String(currentUser.role).toUpperCase();
  
  const avatarEl = document.querySelector("#userAvatar");
  if (avatarEl) {
    const initials = currentUser.name.split(" ").map(n => n[0]).join("").slice(0, 2).toUpperCase();
    avatarEl.textContent = initials;
  }
}

function showLogin() {
  document.querySelector("#loginScreen").classList.remove("hidden");
  document.querySelector("#appShell").classList.add("hidden");
}

async function loadDashboard() {
  const [data, profits] = await Promise.all([
    api("/api/dashboard"),
    api("/api/profit-summary")
  ]);
  const totalMonthlyRevenue = data.monthlyRevenue.at(-1)?.total || 0;
  const latestProfit = profits[0]?.profit || 0;
  const stockQty = data.inventory.reduce((sum, row) => sum + Number(row.qty || 0), 0);
  const stockValue = data.inventory.reduce((sum, row) => sum + Number(row.value || 0), 0);

  document.querySelector("#metrics").innerHTML = [
    ["Revenue Bulan Ini", rupiah.format(totalMonthlyRevenue)],
    ["Laba Bersih", rupiah.format(latestProfit)],
    ["Total Stock", `${number.format(stockQty)} pcs`],
    ["Nilai Inventory", rupiah.format(stockValue)]
  ].map(([label, value]) => `<article class="metric"><span>${label}</span><strong>${value}</strong></article>`).join("");

  drawLineChart("salesChart", data.monthlyRevenue.slice(-6), {
    label: (row) => monthName(row.month),
    series: [
      { key: "online_revenue", label: "Online", color: chartColors().online },
      { key: "offline_revenue", label: "Offline", color: chartColors().offline }
    ]
  });
  
  drawPieChart("stockPieChart", data.inventory);
  
  // Draw stock as a line chart now
  drawArticleStockLineChart("articleStockChart", data.stockByArticle);

  table("#lowStockTable", [
    { label: "SKU", key: "sku" },
    { label: "Artikel", key: "name" },
    { label: "Pool", key: "pool" },
    { label: "Sisa", render: (r) => `<span class="badge warn">${r.qty}</span>` },
    { label: "Min", key: "low_stock" }
  ], data.lowStock);
}

async function loadProducts() {
  const rows = await api("/api/products");
  productRows = rows;
  table("#productsTable", [
    { label: "", render: (r) => `<button class="mini open-product" data-id="${r.variant_id}" type="button" title="Buka artikel">✎ Detail</button>` },
    { label: "SKU", key: "sku" },
    { label: "Artikel", key: "name" },
    { label: "Kategori", key: "category" },
    { label: "Size", key: "size" },
    { label: "Warna", key: "color" },
    { label: "HPP", render: (r) => rupiah.format(r.cost_price) },
    { label: "Harga Jual", render: (r) => rupiah.format(r.sell_price) },
    { label: "Online", render: (r) => number.format(r.online_qty) },
    { label: "Offline", render: (r) => number.format(r.offline_qty) },
    { label: "Total", render: (r) => `<strong>${number.format(r.total_qty)}</strong>` }
  ], rows);
}

async function loadMovements() {
  const month = document.querySelector("#movementMonth")?.value || "";
  const rows = await api(`/api/movements${month ? `?month=${encodeURIComponent(month)}` : ""}`);
  table("#movementsTable", [
    { label: "", render: (r) => `<button class="mini danger delete-movement" data-id="${r.id}" title="Hapus riwayat">🗑</button>` },
    { label: "Waktu", render: (r) => new Date(r.created_at).toLocaleString("id-ID") },
    { label: "Tipe", key: "type" },
    { label: "SKU", key: "sku" },
    { label: "Artikel", key: "name" },
    { label: "Pool", key: "pool" },
    { label: "Qty", render: (r) => number.format(r.qty) },
    { label: "Catatan", key: "note" }
  ], rows);
  
  await loadCategoryStocks().catch(e => console.error(e));
}

async function loadMonthlyRevenue() {
  const rows = await api("/api/monthly-revenues");
  monthlyRevenueRows = rows;
  const chartRows = [...rows].reverse().slice(-8);
  drawLineChart("revenueCompareChart", chartRows, {
    label: (row) => monthName(row.month),
    series: [
      { key: "online_revenue", label: "Online", color: chartColors().online },
      { key: "offline_revenue", label: "Offline", color: chartColors().offline }
    ]
  });
  table("#monthlyRevenueTable", [
    { label: "", render: (r) => `<button class="mini edit-revenue" data-month="${r.month}" title="Edit pendapatan">✎</button> <button class="mini danger delete-revenue" data-month="${r.month}" title="Hapus pendapatan">🗑</button>` },
    { label: "Bulan", render: (r) => monthName(r.month) },
    { label: "Online", render: (r) => rupiah.format(r.online_revenue) },
    { label: "Offline", render: (r) => rupiah.format(r.offline_revenue) },
    { label: "Total", render: (r) => `<strong>${rupiah.format(r.total_revenue)}</strong>` },
    { label: "Lebih Tinggi", render: (r) => badge(r.difference >= 0 ? "Online" : "Offline") },
    { label: "Artikel", render: (r) => number.format((r.items || []).reduce((sum, item) => sum + item.online_qty + item.offline_qty, 0)) }
  ], rows);
}

async function loadExpenses() {
  const [expenses, profits] = await Promise.all([
    api("/api/monthly-expenses"),
    api("/api/profit-summary")
  ]);

  const latest = profits[0] || { cumulative_profit: 0, revenue: 0, expense: 0, profit: 0, month: "-" };
  const positive = latest.cumulative_profit >= 0;
  const paybackBox = document.querySelector("#paybackBox");
  if (paybackBox) {
    paybackBox.innerHTML = `
      <span class="payback-label">${positive ? "Uang sudah kembali secara kumulatif" : "Belum balik modal"}</span>
      <strong>${rupiah.format(latest.cumulative_profit || 0)}</strong>
      <p>Bulan terakhir: ${monthName(latest.month)}. Revenue ${rupiah.format(latest.revenue || 0)}, pengeluaran ${rupiah.format(latest.expense || 0)}, profit bulan itu ${rupiah.format(latest.profit || 0)}.</p>
    `;
  }
}

async function loadReports() {
  const data = await api("/api/reports");
  table("#reportChannelTable", [
    { label: "Channel", render: (r) => badge(r.channel) },
    { label: "Stream", key: "revenue_stream" },
    { label: "Revenue", render: (r) => rupiah.format(r.revenue || 0) },
    { label: "COGS", render: (r) => rupiah.format(r.cogs || 0) },
    { label: "Profit", render: (r) => rupiah.format(r.gross_profit || 0) }
  ], data.channel);
  table("#reportSkuTable", [
    { label: "SKU", key: "sku" },
    { label: "Artikel", key: "name" },
    { label: "Terjual", key: "sold_qty" },
    { label: "Revenue", render: (r) => rupiah.format(r.revenue || 0) },
    { label: "Margin", render: (r) => rupiah.format(r.margin || 0) }
  ], data.sku);
}

async function loadProduksi() {
  const batches = await api("/api/production/batches");
  currentProductionBatches = batches;

  // Summary stats
  const activeBatches = batches.filter(b => b.status === "Sedang Diproses");
  const historyBatches = batches.filter(b => b.status === "Selesai" || b.status === "Dibatalkan");

  document.querySelector("#totalActiveBatches").textContent = activeBatches.length;
  document.querySelector("#totalInProcessBatches").textContent = activeBatches.length;
  const totalTarget = activeBatches.reduce((sum, b) => {
    const batchQty = b.items ? b.items.reduce((s, it) => s + it.qty, 0) : 0;
    return sum + batchQty;
  }, 0);
  document.querySelector("#totalTargetPcs").textContent = number.format(totalTarget);

  const renderCard = (b) => {
    const itemsHtml = b.items && b.items.length ? b.items.map(it => `
      <div style="display:flex; justify-content:space-between; font-size:11px; color:var(--ink); margin-bottom:4px; padding-bottom:2px; border-bottom:1px dashed var(--line);">
        <span>${it.product_name}</span>
        <span style="font-weight:700;">${it.qty} pcs - Biaya: Rp ${number.format(it.production_cost)}</span>
      </div>
    `).join("") : `<div style="font-size:11px; color:var(--muted);">Tidak ada produk.</div>`;

    const totalQty = b.items ? b.items.reduce((sum, it) => sum + it.qty, 0) : 0;
    const totalCost = b.items ? b.items.reduce((sum, it) => sum + it.production_cost, 0) : 0;
    const isOngoing = b.status === 'Sedang Diproses';

    return `
      <article class="panel production-card">
        <div class="production-card-header" style="display:flex; justify-content:space-between; align-items:flex-start;">
          <div>
            <strong>${b.batch_no}</strong>
            <div style="font-size:10px; font-weight:800; color:var(--muted); margin-top:2px; text-transform:uppercase; letter-spacing:0.5px; display:inline-flex; align-items:center; gap:6px;">
              <span class="badge ${b.batch_type === 'Sampling' ? 'warn' : 'marketplace'}" style="padding:1px 6px; font-size:9px; min-height:auto;">${b.batch_type}</span>
            </div>
          </div>
          <div style="display:flex; align-items:center; gap:8px;">
            <span class="badge ${b.status === 'Selesai' ? 'marketplace' : b.status === 'Dibatalkan' ? 'offline' : 'warn'}">${b.status}</span>
            ${isOngoing ? `<button class="mini danger cancel-batch-btn" data-id="${b.id}" data-no="${b.batch_no}" style="padding:4px 8px; font-size:10px; min-height:auto;" type="button" title="Batalkan batch">✕</button>` : ''}
            <button class="mini danger delete-batch-btn" data-id="${b.id}" data-no="${b.batch_no}" style="padding:4px 8px; font-size:10px; min-height:auto;" type="button" title="Hapus batch">🗑</button>
          </div>
        </div>
        
        <div class="po-card-items" style="margin: 4px 0 10px; background:var(--soft-primary); padding:10px; border-radius:8px;">
          ${itemsHtml}
          <div style="display:flex; justify-content:space-between; font-size:11px; font-weight:800; margin-top:6px; color:var(--ink);">
            <span>TOTAL TARGET</span>
            <span>${totalQty} pcs</span>
          </div>
          <div style="display:flex; justify-content:space-between; font-size:11px; font-weight:800; margin-top:2px; color:var(--accent);">
            <span>ESTIMASI BIAYA</span>
            <span>${rupiah.format(totalCost)}</span>
          </div>
        </div>

        <div class="production-progress-section" style="display:grid; gap:8px;">
          <div class="batch-progress-row">
            <span class="progress-label">Cutting</span>
            <div class="progress-bar-container">
              <div class="progress-bar-fill" style="width: ${b.cutting_progress}%;"></div>
            </div>
            <span class="progress-val">${b.cutting_progress}%</span>
          </div>
          <div class="batch-progress-row">
            <span class="progress-label">Sewing</span>
            <div class="progress-bar-container">
              <div class="progress-bar-fill" style="width: ${b.sewing_progress}%;"></div>
            </div>
            <span class="progress-val">${b.sewing_progress}%</span>
          </div>
          <div class="batch-progress-row">
            <span class="progress-label">Finishing</span>
            <div class="progress-bar-container">
              <div class="progress-bar-fill" style="width: ${b.finishing_progress}%;"></div>
            </div>
            <span class="progress-val">${b.finishing_progress}%</span>
          </div>
        </div>
        <div class="production-card-footer" style="display:flex; justify-content:space-between; align-items:center; margin-top:8px;">
          <span style="font-size:12px; color:var(--muted);">${b.status === 'Selesai' && b.completed_at ? `Selesai: ${new Date(b.completed_at.replace(" ", "T")).toLocaleDateString("id-ID", { day: "numeric", month: "short", year: "numeric" })}` : `Due: ${new Date(b.due_date).toLocaleDateString("id-ID", { day: "numeric", month: "short" })}`}</span>
          <div style="display:flex; gap:6px;">
            <button class="mini edit-batch-detail-btn" data-id="${b.id}" type="button">Edit Detail</button>
            ${isOngoing ? `<button class="mini edit-progress-btn" data-id="${b.id}" data-no="${b.batch_no}" data-cutting="${b.cutting_progress}" data-sewing="${b.sewing_progress}" data-finishing="${b.finishing_progress}" type="button">Update Progress</button>` : ''}
          </div>
        </div>
      </article>
    `;
  };

  const batchList = document.querySelector("#productionBatchList");
  if (!activeBatches.length) {
    batchList.innerHTML = `<div class="panel" style="padding:24px; grid-column:1/-1; text-align:center; color:var(--muted);">Belum ada batch produksi aktif.</div>`;
  } else {
    batchList.innerHTML = activeBatches.map(renderCard).join("");
  }

  const historyList = document.querySelector("#productionHistoryList");
  if (historyList) {
    if (!historyBatches.length) {
      historyList.innerHTML = `<div class="panel" style="padding:24px; grid-column:1/-1; text-align:center; color:var(--muted);">Belum ada riwayat produksi.</div>`;
    } else {
      historyList.innerHTML = historyBatches.map(renderCard).join("");
    }
  }
}
async function loadPembelian() {
  const [pos, suppliers] = await Promise.all([
    api("/api/purchase-orders"),
    api("/api/suppliers")
  ]);
  currentPurchaseOrders = pos;

  // Filter out completed and canceled POs (only show ongoing POs)
  const activePos = pos.filter(r => r.status !== 'Selesai' && r.status !== 'Dibatalkan');
  const historyPos = pos.filter(r => r.status === 'Selesai' || r.status === 'Dibatalkan');
  const shippedPos = activePos.filter(r => r.status === 'Dikirim');
  const totalExpenses = activePos.reduce((sum, r) => sum + Number(r.total_amount || 0), 0);

  document.querySelector("#totalActivePos").textContent = activePos.length;
  document.querySelector("#totalShippedPos").textContent = shippedPos.length;
  document.querySelector("#totalPoExpenses").textContent = rupiah.format(totalExpenses);

  const renderPoCard = (r, isHistory) => {
    const itemsHtml = r.items.map(it => {
      const spec = [it.sku, it.size && it.color ? `${it.size}/${it.color}` : ""].filter(Boolean).join(" - ");
      const specText = spec ? ` (${spec})` : "";
      return `
        <div class="po-card-item">
          <span class="po-card-item-name">${it.product_name || it.material_name}${specText}</span>
          <span>x${it.qty}</span>
        </div>
      `;
    }).join("");

    let badgeClass = 'warn';
    if (r.status === 'Dikirim') badgeClass = 'marketplace';
    if (r.status === 'Diterima Sebagian') badgeClass = 'offline';
    if (r.status === 'Selesai') badgeClass = 'marketplace';
    if (r.status === 'Dibatalkan') badgeClass = 'offline';

    return `
      <article class="po-card">
        <div class="po-card-header">
          <div>
            <h3>${r.po_no}</h3>
            <p>${new Date(r.created_at).toLocaleDateString("id-ID", { day: "numeric", month: "short", year: "numeric" })}</p>
          </div>
          <div style="display:flex; align-items:center; gap:8px;">
            <span class="badge ${badgeClass}">${r.status}</span>
            <button class="mini danger delete-po-btn" data-id="${r.id}" data-no="${r.po_no}" style="padding:4px 8px; font-size:10px; min-height:auto;" type="button">🗑</button>
          </div>
        </div>
        <div class="po-card-body">
          <div class="po-card-info-row">
            <span>Supplier:</span>
            <strong>${r.supplier_name}</strong>
          </div>
          <div class="po-card-info-row">
            <span>Tujuan:</span>
            <strong>${r.pool_name}</strong>
          </div>
          <div class="po-card-items">
            <div style="font-size:9px; text-transform:uppercase; color:var(--muted); font-weight:800; margin-bottom:6px; letter-spacing:0.5px;">Items PO (${r.items.length})</div>
            ${itemsHtml}
          </div>
        </div>
        <div class="po-card-footer" style="display:flex; justify-content:space-between; align-items:center; gap:8px;">
          <div class="po-card-total">
            <span>Total Pengeluaran</span>
            <strong>${rupiah.format(r.total_amount)}</strong>
          </div>
          <div style="display:flex; gap:6px;">
            <button class="mini edit-po-btn" data-id="${r.id}" type="button" style="padding:6px 12px; font-size:11px; min-height:auto;">Edit</button>
            ${!isHistory ? `
              <button class="po-card-btn mark-po-complete-btn" data-id="${r.id}" data-no="${r.po_no}" type="button" style="padding:6px 12px; font-size:11px; min-height:auto;">
                ✓ Selesai
              </button>
            ` : ''}
          </div>
        </div>
      </article>
    `;
  };

  const purchaseOrderList = document.querySelector("#purchaseOrderList");
  if (!activePos.length) {
    purchaseOrderList.innerHTML = `<div class="panel" style="padding:24px; grid-column:1/-1; text-align:center; color:var(--muted); font-weight:700;">Belum ada purchase order aktif.</div>`;
  } else {
    purchaseOrderList.innerHTML = activePos.map(r => renderPoCard(r, false)).join("");
  }

  const purchaseOrderHistoryList = document.querySelector("#purchaseOrderHistoryList");
  if (purchaseOrderHistoryList) {
    if (!historyPos.length) {
      purchaseOrderHistoryList.innerHTML = `<div class="panel" style="padding:24px; grid-column:1/-1; text-align:center; color:var(--muted); font-weight:700;">Belum ada riwayat purchase order.</div>`;
    } else {
      purchaseOrderHistoryList.innerHTML = historyPos.map(r => renderPoCard(r, true)).join("");
    }
  }

  table("#supplierTable", [
    { label: "", render: (r) => `<button class="mini danger delete-supplier-btn" data-id="${r.id}" data-name="${r.name}" title="Hapus Supplier" type="button">🗑</button>` },
    { label: "Nama Supplier", key: "name" },
    { label: "Kontak / Telepon", key: "contact" }
  ], suppliers);
}
async function loadKeuangan() {
  const [transactions, profits, expenses] = await Promise.all([
    api("/api/keuangan/transactions"),
    api("/api/profit-summary"),
    api("/api/monthly-expenses")
  ]);

  const totalIncome = profits.reduce((sum, r) => sum + Number(r.revenue || 0), 0);
  const totalExpense = profits.reduce((sum, r) => sum + Number(r.expense || 0), 0);
  const netProfit = totalIncome - totalExpense;

  document.querySelector("#financeTotalIncome").textContent = rupiah.format(totalIncome);
  document.querySelector("#financeTotalExpense").textContent = rupiah.format(totalExpense);
  document.querySelector("#financeNetProfit").textContent = rupiah.format(netProfit);
  
  const profitCard = document.querySelector("#financeNetProfitCard");
  if (profitCard) {
    profitCard.className = "metric-summary-card " + (netProfit >= 0 ? "green" : "red");
  }

  // Draw Cash Flow Chart
  const chartRows = [...profits].reverse().slice(-8);
  drawLineChart("profitChart", chartRows, {
    label: (row) => monthName(row.month),
    series: [
      { key: "revenue", label: "Pemasukan", color: chartColors().online },
      { key: "expense", label: "Pengeluaran", color: chartColors().offline },
      { key: "profit", label: "Profit", color: chartColors().amber }
    ]
  });

  // Recent Transactions
  table("#recentTransactionsTable", [
    { label: "Tanggal", render: (r) => new Date(r.tanggal).toLocaleDateString("id-ID") },
    { label: "Jenis", render: (r) => `<span class="badge ${r.jenis === 'Pemasukan' ? 'marketplace' : 'offline'}">${r.jenis}</span>` },
    { label: "Kategori", key: "kategori" },
    { label: "Deskripsi", key: "deskripsi" },
    { label: "Nominal", render: (r) => rupiah.format(r.jumlah) }
  ], transactions.slice(0, 10));

  // Monthly Laba Rugi Summary
  table("#profitTable", [
    { label: "Bulan", render: (r) => monthName(r.month) },
    { label: "Revenue", render: (r) => rupiah.format(r.revenue || 0) },
    { label: "Pengeluaran", render: (r) => rupiah.format(r.expense || 0) },
    { label: "Profit", render: (r) => rupiah.format(r.profit || 0) },
    { label: "Akumulasi", render: (r) => `<strong>${rupiah.format(r.cumulative_profit || 0)}</strong>` }
  ], profits);

  // Expenses Table
  table("#expenseTable", [
    { label: "", render: (r) => `<button class="mini danger delete-expense" data-id="${r.id}" title="Hapus pengeluaran">🗑</button>` },
    { label: "Bulan", render: (r) => monthName(r.month) },
    { label: "Kategori", key: "category" },
    { label: "Nominal", render: (r) => rupiah.format(r.amount || 0) },
    { label: "Catatan", key: "note" }
  ], expenses);
}


async function loadOptions() {
  const data = await api("/api/options");
  productRows = data.variants;
  
  const sellableVariants = data.variants.filter(v => v.category !== "Bahan Baku" && v.category !== "Packaging" && v.category !== "Hangtag");
  const variantOptions = sellableVariants.map((v) => `<option value="${v.variant_id}">${v.sku} - ${v.name} (${v.size}/${v.color})</option>`).join("");
  for (const id of ["receiveVariant", "transferVariant"]) {
    const el = document.querySelector(`#${id}`);
    if (el) el.innerHTML = variantOptions;
  }
  
  const poolOptions = data.pools.map((p) => `<option value="${p.id}">${p.name}</option>`).join("");
  for (const id of ["receivePool", "fromPool", "toPool"]) {
    const el = document.querySelector(`#${id}`);
    if (el) el.innerHTML = poolOptions;
  }
  
  const toPoolEl = document.querySelector("#toPool");
  if (toPoolEl) toPoolEl.selectedIndex = 1;
  
  const revItemsRowsEl = document.querySelector("#revenueItemRows");
  if (revItemsRowsEl) {
    const selects = revItemsRowsEl.querySelectorAll("select");
    selects.forEach(select => {
      const currentVal = select.value;
      select.innerHTML = sellableVariants.map((v) => `<option value="${v.variant_id}">${v.sku} - ${v.name}</option>`).join("");
      if (currentVal && sellableVariants.some(v => String(v.variant_id) === String(currentVal))) {
        select.value = currentVal;
      }
    });
    if (!revItemsRowsEl.children.length) {
      addRevenueItemRow();
    }
  }
}

async function refreshAll() {
  await Promise.all([
    loadDashboard(),
    loadProducts(),
    loadMovements(),
    loadMonthlyRevenue(),
    loadExpenses(),
    loadReports(),
    loadOptions(),
    loadProduksi(),
    loadPembelian(),
    loadKeuangan(),
    loadKeuanganReports()
  ]);
}

// Side Navigation Switching Handler
document.querySelectorAll(".nav").forEach((button) => {
  button.addEventListener("click", () => {
    // Hide mobile sidebar on navigation click
    document.querySelector(".sidebar")?.classList.remove("open");
    document.querySelector("#sidebarOverlay")?.classList.add("hidden");
    const toggleBtn = document.querySelector("#menuToggleBtn");
    if (toggleBtn) toggleBtn.textContent = "☰";

    document.querySelectorAll(".nav, .view").forEach((el) => el.classList.remove("active"));
    button.classList.add("active");
    
    const viewId = button.dataset.view;
    const viewEl = document.querySelector(`#${viewId}`);
    if (viewEl) viewEl.classList.add("active");
    
    // Update Header Text context and Title
    const config = titles[viewId] || [viewId.toUpperCase(), ""];
    document.querySelector("#pageTitle").textContent = config[0];
    document.querySelector("#pageSubtitle").textContent = config[1];
    
    const navGroup = button.closest(".nav-group");
    const groupTitle = navGroup ? navGroup.querySelector(".nav-group-title") : null;
    const contextEl = document.querySelector("#pageContext");
    if (contextEl && groupTitle) {
      contextEl.textContent = groupTitle.textContent;
    }

    // Delay chart drawing slightly to let layout stabilize and avoid canvas stretch
    setTimeout(() => {
      if (viewId === "dashboard") loadDashboard().catch(e => console.error(e));
      else if (viewId === "products") loadProducts().catch(e => console.error(e));
      else if (viewId === "inventori") {
        loadMovements().catch(e => console.error(e));
        loadOptions().catch(e => console.error(e));
      }
      else if (viewId === "pembelian") loadPembelian().catch(e => console.error(e));
      else if (viewId === "produksi") loadProduksi().catch(e => console.error(e));
      else if (viewId === "penjualan") {
        loadMonthlyRevenue().catch(e => console.error(e));
        loadOptions().catch(e => console.error(e));
      }
      else if (viewId === "pengeluaran") loadExpenses().catch(e => console.error(e));
      else if (viewId === "keuangan") {
        loadKeuangan().catch(e => console.error(e));
      }
      else if (viewId === "laporan") {
        loadReports().catch(e => console.error(e));
        loadKeuanganReports().catch(e => console.error(e));
      }
      else if (viewId === "ai-consultant") {
        loadAiConsultant().catch(e => console.error(e));
      }
    }, 100);
  });
});

// Theme Toggler with Debounced Layout Settlement to prevent chart stretching
document.querySelector("#themeToggle").addEventListener("click", () => {
  document.body.classList.toggle("dark");
  localStorage.setItem("tera_theme", document.body.classList.contains("dark") ? "dark" : "light");
  document.querySelector("#themeToggle").textContent = document.body.classList.contains("dark") ? "☀️" : "🌙";
  document.querySelector("#themeToggle").title = document.body.classList.contains("dark") ? "Light mode" : "Dark mode";
  
  // 100ms layout stabilization delay
  setTimeout(() => {
    refreshAll().catch((error) => toast(error.message));
  }, 100);
});

// Mobile Sidebar Menu Toggle Handler
document.querySelector("#menuToggleBtn")?.addEventListener("click", () => {
  const sidebar = document.querySelector(".sidebar");
  const overlay = document.querySelector("#sidebarOverlay");
  const toggleBtn = document.querySelector("#menuToggleBtn");
  if (sidebar) {
    if (sidebar.classList.contains("open")) {
      sidebar.classList.remove("open");
      overlay?.classList.add("hidden");
      if (toggleBtn) toggleBtn.textContent = "☰";
    } else {
      sidebar.classList.add("open");
      overlay?.classList.remove("hidden");
      if (toggleBtn) toggleBtn.textContent = "✕";
    }
  }
});

document.querySelector("#sidebarOverlay")?.addEventListener("click", () => {
  document.querySelector(".sidebar")?.classList.remove("open");
  document.querySelector("#sidebarOverlay")?.classList.add("hidden");
  const toggleBtn = document.querySelector("#menuToggleBtn");
  if (toggleBtn) toggleBtn.textContent = "☰";
});

// Generic tab switching (within Pembelian, Produksi)
document.querySelectorAll(".tab-btn").forEach((button) => {
  button.addEventListener("click", () => {
    const container = button.closest("section");
    if (!container) return;
    
    container.querySelectorAll(".tab-btn").forEach((btn) => btn.classList.remove("active"));
    container.querySelectorAll(".tab-content").forEach((content) => content.classList.remove("active"));
    
    button.classList.add("active");
    const targetTabId = button.dataset.tab;
    const targetTab = container.querySelector(`#${targetTabId}`);
    if (targetTab) {
      targetTab.classList.add("active");
    }
  });
});

// Sliding Product Detail Drawer handlers
function closeDrawer() {
  document.querySelector("#productDetailDrawer").classList.add("hidden");
  document.querySelector("#drawerOverlay").classList.add("hidden");
}

document.querySelector("#closeDrawerBtn").addEventListener("click", closeDrawer);
document.querySelector("#drawerOverlay").addEventListener("click", closeDrawer);

// Function to open sliding Product Detail Drawer
function openProductDetailDrawer(variantId) {
  const row = productRows.find((item) => String(item.variant_id) === String(variantId));
  if (!row) return;

  // Static Details
  document.querySelector("#drawerProductName").textContent = row.name;
  document.querySelector("#drawerProductSku").textContent = row.sku;
  document.querySelector("#drawerProductCategory").textContent = row.category;
  document.querySelector("#drawerCostPrice").textContent = rupiah.format(row.cost_price);
  document.querySelector("#drawerSellPrice").textContent = rupiah.format(row.sell_price);
  document.querySelector("#drawerBarcodeText").textContent = `${row.sku}-BC`;

  // Populate form
  const form = document.querySelector("#drawerEditProductForm");
  form.variantId.value = row.variant_id;
  form.name.value = row.name;
  form.sku.value = row.sku;
  form.category.value = row.category;
  form.size.value = row.size;
  form.color.value = row.color;
  form.costPrice.value = row.cost_price;
  form.sellPrice.value = row.sell_price;
  form.lowStock.value = row.low_stock;
  form.status.value = row.status;
  form.onlineQty.value = row.online_qty;
  form.offlineQty.value = row.offline_qty;

  // Build pivot matrix Size x Color
  const siblingVariants = productRows.filter((p) => p.product_id === row.product_id);
  const sizes = [...new Set(siblingVariants.map((v) => v.size))];
  const colors = [...new Set(siblingVariants.map((v) => v.color))];

  let matrixHtml = `<thead><tr><th>Warna \\ Ukuran</th>`;
  sizes.forEach((sz) => {
    matrixHtml += `<th>${sz}</th>`;
  });
  matrixHtml += `</tr></thead><tbody>`;

  colors.forEach((col) => {
    matrixHtml += `<tr><td><strong>${col}</strong></td>`;
    sizes.forEach((sz) => {
      const match = siblingVariants.find((v) => v.size === sz && v.color === col);
      if (match) {
        matrixHtml += `<td><strong>${match.total_qty}</strong> <small style="display:block; color:var(--muted); font-size:10px;">${match.online_qty} ON • ${match.offline_qty} OFF</small></td>`;
      } else {
        matrixHtml += `<td>-</td>`;
      }
    });
    matrixHtml += `</tr>`;
  });
  matrixHtml += `</tbody>`;
  document.querySelector("#drawerStockMatrix").innerHTML = matrixHtml;

  // Display sliding drawer
  document.querySelector("#productDetailDrawer").classList.remove("hidden");
  document.querySelector("#drawerOverlay").classList.remove("hidden");
}

// Listen products table click to open Detail Drawer
document.querySelector("#productsTable").addEventListener("click", (event) => {
  const button = event.target.closest(".open-product");
  if (!button) return;
  openProductDetailDrawer(button.dataset.id);
});

// Listen category stock table row click to open Detail Drawer
const categoryStockTableBody = document.querySelector("#categoryStockTableBody");
if (categoryStockTableBody) {
  categoryStockTableBody.addEventListener("click", (event) => {
    const rowEl = event.target.closest(".clickable-stock-row");
    if (!rowEl) return;
    openProductDetailDrawer(rowEl.dataset.id);
  });
}

// Drawer edit form submit
document.querySelector("#drawerEditProductForm").addEventListener("submit", async (event) => {
  event.preventDefault();
  const data = formData(event.target);
  try {
    await api(`/api/products/${data.variantId}`, { method: "PUT", body: JSON.stringify(data) });
    closeDrawer();
    toast("Detail artikel berhasil diperbarui.");
    await refreshAll();
  } catch (error) {
    toast(error.message);
  }
});

// Drawer delete variant
document.querySelector("#drawerDeleteProductBtn").addEventListener("click", async () => {
  const variantId = document.querySelector("#drawerEditProductForm").variantId.value;
  if (!confirm("Hapus artikel ini dari daftar aktif?")) return;
  try {
    await api(`/api/products/${variantId}`, { method: "DELETE" });
    closeDrawer();
    toast("Artikel berhasil dinonaktifkan.");
    await refreshAll();
  } catch (error) {
    toast(error.message);
  }
});

// Barcode Print Window
document.querySelector("#printBarcodeBtn").addEventListener("click", () => {
  const sku = document.querySelector("#drawerProductSku").textContent;
  const name = document.querySelector("#drawerProductName").textContent;
  
  const printWindow = window.open("", "_blank");
  printWindow.document.write(`
    <html>
      <head>
        <title>Print Barcode - ${sku}</title>
        <style>
          body {
            font-family: 'Courier New', Courier, monospace;
            display: flex;
            flex-direction: column;
            align-items: center;
            justify-content: center;
            height: 100vh;
            margin: 0;
            text-align: center;
          }
          .barcode {
            font-size: 44px;
            letter-spacing: 3px;
            margin-bottom: 8px;
            font-weight: bold;
          }
          .label {
            font-size: 16px;
            font-weight: bold;
          }
        </style>
      </head>
      <body>
        <div class="barcode">|||||||||||||||||||||||||</div>
        <div class="label">${sku}</div>
        <div style="font-size: 12px; margin-top: 4px;">${name}</div>
        <script>
          window.onload = function() {
            window.print();
            window.close();
          }
        </script>
      </body>
    </html>
  `);
  printWindow.document.close();
});

// Add PO item row creator
function addPoItemRow() {
  const row = document.createElement("div");
  row.className = "item-row";
  
  row.innerHTML = `
    <div style="display:flex; flex-direction:column; gap:4px; flex: 1.2;">
      <label style="font-size:11px; font-weight:700; color:var(--muted);">Kategori</label>
      <select name="poItemCategory" class="po-item-category-select">
        <option value="Bahan Baku">Bahan Baku</option>
        <option value="Packaging">Packaging</option>
        <option value="Hangtag">Hangtag</option>
      </select>
    </div>
    <div style="display:flex; flex-direction:column; gap:4px; flex: 2;" class="material-name-container">
      <label style="font-size:11px; font-weight:700; color:var(--muted);">Nama Item</label>
      <input name="materialName" list="materialOptions" placeholder="Ketik nama bahan/aksesoris..." required autocomplete="off" style="width: 100%;">
    </div>
    <div style="display:flex; flex-direction:column; gap:4px; flex: 0.8;">
      <label style="font-size:11px; font-weight:700; color:var(--muted);">Qty</label>
      <input name="qty" type="number" min="1" value="1" placeholder="Qty" required style="width: 100%;">
    </div>
    <div style="display:flex; flex-direction:column; gap:4px; flex: 1.2;">
      <label style="font-size:11px; font-weight:700; color:var(--muted);">Harga Satuan</label>
      <input name="costPrice" type="number" min="0" value="0" placeholder="Harga Satuan" required style="width: 100%;">
    </div>
    <div style="display:flex; flex-direction:column; gap:4px; flex: 1.2;">
      <label style="font-size:11px; font-weight:700; color:var(--muted);">Harga Total</label>
      <input name="totalPrice" type="number" min="0" value="0" placeholder="Harga Total" required style="width: 100%;">
    </div>
    <button class="mini danger remove-po-row" type="button" title="Hapus baris" style="margin-top:20px;">×</button>
  `;

  const qtyInput = row.querySelector('[name="qty"]');
  const unitPriceInput = row.querySelector('[name="costPrice"]');
  const totalPriceInput = row.querySelector('[name="totalPrice"]');
  const categorySelect = row.querySelector('.po-item-category-select');
  const nameContainer = row.querySelector('.material-name-container');

  categorySelect.addEventListener('change', () => {
    const cat = categorySelect.value;
    if (cat === 'Packaging') {
      nameContainer.innerHTML = `
        <label style="font-size:11px; font-weight:700; color:var(--muted);">Nama Item</label>
        <select name="materialName" required style="width: 100%;">
          <option value="Packaging Baju">Packaging Baju</option>
          <option value="Packaging Order">Packaging Order</option>
        </select>
      `;
    } else if (cat === 'Hangtag') {
      nameContainer.innerHTML = `
        <label style="font-size:11px; font-weight:700; color:var(--muted);">Nama Item</label>
        <input name="materialName" value="Hangtag" readonly style="background:var(--soft-primary); cursor:not-allowed; width: 100%;">
      `;
    } else {
      nameContainer.innerHTML = `
        <label style="font-size:11px; font-weight:700; color:var(--muted);">Nama Item</label>
        <input name="materialName" list="materialOptions" placeholder="Ketik nama bahan/aksesoris..." required autocomplete="off" style="width: 100%;">
      `;
    }
  });

  const updateFromUnit = () => {
    const qty = Number(qtyInput.value) || 1;
    const unitPrice = Number(unitPriceInput.value) || 0;
    totalPriceInput.value = qty * unitPrice;
  };
  
  const updateFromTotal = () => {
    const qty = Number(qtyInput.value) || 1;
    const totalPrice = Number(totalPriceInput.value) || 0;
    unitPriceInput.value = Math.round(totalPrice / qty);
  };
  
  qtyInput.addEventListener("input", updateFromUnit);
  unitPriceInput.addEventListener("input", updateFromUnit);
  totalPriceInput.addEventListener("input", updateFromTotal);

  document.querySelector("#poItemRows").append(row);
}

// Add PO dynamic buttons
document.querySelector("#addPoItemBtn").addEventListener("click", () => {
  addPoItemRow();
});

document.querySelector("#poItemRows").addEventListener("click", (event) => {
  if (!event.target.closest(".remove-po-row")) return;
  const rowsContainer = document.querySelector("#poItemRows");
  if (rowsContainer.children.length > 1) {
    event.target.closest(".item-row").remove();
  } else {
    toast("Purchase Order wajib memiliki minimal 1 item.");
  }
});

// Open PO dialog
document.querySelector("#newPoBtn").addEventListener("click", async () => {
  // Reset dialog title and hidden ID input
  document.querySelector('#poDialog h2').textContent = "Buat Purchase Order Baru";
  const idInput = document.querySelector('#newPoForm [name="poId"]');
  if (idInput) idInput.remove();

  const [data, pos] = await Promise.all([
    api("/api/options"),
    api("/api/purchase-orders")
  ]);
  
  document.querySelector("#poFormSupplier").innerHTML = data.suppliers.map(s => `<option value="${s.id}">${s.name}</option>`).join("");
  document.querySelector("#poFormPool").innerHTML = data.pools.map(p => `<option value="${p.id}">${p.name}</option>`).join("");
  
  // Set up datalist of materials for autocomplete
  let datalist = document.querySelector("#materialOptions");
  if (!datalist) {
    datalist = document.createElement("datalist");
    datalist.id = "materialOptions";
    document.body.appendChild(datalist);
  }
  datalist.innerHTML = data.bomMaterials.map(m => `<option value="${m.material_name}">${m.material_name} (${m.unit})</option>`).join("");
  
  document.querySelector("#poItemRows").innerHTML = "";
  addPoItemRow();

  // Auto-generate PO code: DDMMYYYY-N
  const now = new Date();
  const dd = String(now.getDate()).padStart(2, '0');
  const mm = String(now.getMonth() + 1).padStart(2, '0');
  const yyyy = now.getFullYear();
  const dateStr = `${dd}${mm}${yyyy}`;
  
  const countToday = pos.filter(p => p.po_no && p.po_no.startsWith(dateStr + "-")).length;
  const nextPoNo = `${dateStr}-${countToday + 1}`;
  
  const poNoInput = document.querySelector('#newPoForm [name="poNo"]');
  if (poNoInput) {
    poNoInput.value = nextPoNo;
    poNoInput.readOnly = true;
    poNoInput.style.background = "var(--soft-primary)";
    poNoInput.style.cursor = "not-allowed";
  }

  const statusSelect = document.querySelector('#newPoForm [name="status"]');
  if (statusSelect) {
    statusSelect.value = "Draft";
  }
  
  document.querySelector("#poDialog").showModal();
});

// Save PO
document.querySelector("#newPoForm").addEventListener("submit", async (event) => {
  event.preventDefault();
  const data = formData(event.target);
  
  const items = [...document.querySelectorAll("#poItemRows .item-row")].map(row => ({
    category: row.querySelector('.po-item-category-select')?.value || 'Bahan Baku',
    materialName: row.querySelector('[name="materialName"]').value,
    qty: Number(row.querySelector('[name="qty"]').value),
    costPrice: Number(row.querySelector('[name="costPrice"]').value)
  }));
  
  try {
    const isEdit = !!data.poId;
    const url = isEdit ? `/api/purchase-orders/${data.poId}/details` : "/api/purchase-orders";
    const method = isEdit ? "PUT" : "POST";

    await api(url, {
      method: method,
      body: JSON.stringify({
        poNo: data.poNo,
        supplierId: Number(data.supplierId),
        poolId: Number(data.poolId),
        status: data.status,
        items
      })
    });
    
    document.querySelector("#poDialog").close();
    event.target.reset();
    
    // Reset dialog header & ID
    document.querySelector('#poDialog h2').textContent = "Buat Purchase Order Baru";
    const idInput = document.querySelector('#newPoForm [name="poId"]');
    if (idInput) idInput.remove();

    toast(isEdit ? "Purchase Order berhasil diubah." : "Purchase Order berhasil disimpan.");
    await refreshAll();
  } catch (error) {
    toast(error.message);
  }
});

// Add Supplier
document.querySelector("#supplierForm").addEventListener("submit", async (event) => {
  event.preventDefault();
  try {
    await api("/api/suppliers", { method: "POST", body: JSON.stringify(formData(event.target)) });
    event.target.reset();
    toast("Supplier baru ditambahkan.");
    await refreshAll();
  } catch (error) {
    toast(error.message);
  }
});

// Mark PO Complete/Cancel/Delete/Edit Event Listener
const handlePoClick = async (event) => {
  const completeBtn = event.target.closest(".mark-po-complete-btn");
  const cancelBtn = event.target.closest(".cancel-po-btn");
  const deleteBtn = event.target.closest(".delete-po-btn");
  const editBtn = event.target.closest(".edit-po-btn");
  
  if (editBtn) {
    const id = Number(editBtn.dataset.id);
    const po = currentPurchaseOrders.find(p => p.id === id);
    if (po) {
      // 1. Set form header & hidden ID
      document.querySelector('#poDialog h2').textContent = "Edit Purchase Order";
      let idInput = document.querySelector('#newPoForm [name="poId"]');
      if (!idInput) {
        idInput = document.createElement("input");
        idInput.type = "hidden";
        idInput.name = "poId";
        document.querySelector('#newPoForm').appendChild(idInput);
      }
      idInput.value = po.id;

      // 2. Load suppliers and pools list first
      const data = await api("/api/options");
      document.querySelector("#poFormSupplier").innerHTML = data.suppliers.map(s => `<option value="${s.id}">${s.name}</option>`).join("");
      document.querySelector("#poFormPool").innerHTML = data.pools.map(p => `<option value="${p.id}">${p.name}</option>`).join("");
      
      let datalist = document.querySelector("#materialOptions");
      if (!datalist) {
        datalist = document.createElement("datalist");
        datalist.id = "materialOptions";
        document.body.appendChild(datalist);
      }
      datalist.innerHTML = data.bomMaterials.map(m => `<option value="${m.material_name}">${m.material_name} (${m.unit})</option>`).join("");

      // 3. Pre-fill PO fields
      document.querySelector('#newPoForm [name="poNo"]').value = po.po_no;
      document.querySelector('#newPoForm [name="supplierId"]').value = po.supplier_id;
      document.querySelector('#newPoForm [name="poolId"]').value = po.pool_id;
      document.querySelector('#newPoForm [name="status"]').value = po.status;

      const poNoInput = document.querySelector('#newPoForm [name="poNo"]');
      if (poNoInput) {
        poNoInput.readOnly = false;
        poNoInput.style.background = "";
        poNoInput.style.cursor = "";
      }

      // 4. Clear and populate items
      const container = document.querySelector("#poItemRows");
      container.innerHTML = "";
      
      po.items.forEach(item => {
        addPoItemRow();
        const lastRow = container.lastElementChild;
        
        const catSelect = lastRow.querySelector('.po-item-category-select');
        catSelect.value = item.category;
        catSelect.dispatchEvent(new Event('change'));
        
        const nameInput = lastRow.querySelector('[name="materialName"]');
        nameInput.value = item.material_name;
        
        lastRow.querySelector('[name="qty"]').value = item.qty;
        lastRow.querySelector('[name="costPrice"]').value = item.cost_price;
        lastRow.querySelector('[name="totalPrice"]').value = item.qty * item.cost_price;
      });

      document.querySelector("#poDialog").showModal();
    }
  } else if (completeBtn) {
    const id = completeBtn.dataset.id;
    const no = completeBtn.dataset.no;
    if (confirm(`Apakah Anda yakin ingin menyelesaikan Purchase Order ${no}?`)) {
      try {
        await api(`/api/purchase-orders/${id}`, {
          method: "PUT",
          body: JSON.stringify({ status: "Selesai" })
        });
        toast(`PO ${no} berhasil diselesaikan dan stok telah ditambahkan.`);
        await refreshAll();
      } catch (e) {
        console.error(e);
        toast(`Gagal menyelesaikan PO: ${e.message}`);
      }
    }
  } else if (cancelBtn) {
    const id = cancelBtn.dataset.id;
    const no = cancelBtn.dataset.no;
    if (confirm(`Apakah Anda yakin ingin membatalkan Purchase Order ${no}?`)) {
      try {
        await api(`/api/purchase-orders/${id}`, {
          method: "PUT",
          body: JSON.stringify({ status: "Dibatalkan" })
        });
        toast(`PO ${no} berhasil dibatalkan.`);
        await refreshAll();
      } catch (e) {
        console.error(e);
        toast(`Gagal membatalkan PO: ${e.message}`);
      }
    }
  } else if (deleteBtn) {
    const id = deleteBtn.dataset.id;
    const no = deleteBtn.dataset.no;
    if (confirm(`Apakah Anda yakin ingin menghapus Purchase Order ${no}? Tindakan ini permanen.`)) {
      try {
        await api(`/api/purchase-orders/${id}`, { method: "DELETE" });
        toast(`PO ${no} berhasil dihapus.`);
        await refreshAll();
      } catch (e) {
        console.error(e);
        toast(`Gagal menghapus PO: ${e.message}`);
      }
    }
  }
};

document.querySelector("#purchaseOrderList").addEventListener("click", handlePoClick);
const poHistoryListEl = document.querySelector("#purchaseOrderHistoryList");
if (poHistoryListEl) {
  poHistoryListEl.addEventListener("click", handlePoClick);
}



// Add Batch dynamic item row creator
function addBatchItemRow(products) {
  const row = document.createElement("div");
  row.className = "item-row";
  row.innerHTML = `
    <div style="display:flex; flex-direction:column; gap:4px;">
      <label style="font-size:11px; font-weight:700; color:var(--muted);">Artikel Produk</label>
      <select name="productId" required>
        ${products.map((p) => `<option value="${p.product_id}">${p.name} (${p.category})</option>`).join("")}
      </select>
    </div>
    <div style="display:flex; flex-direction:column; gap:4px;">
      <label style="font-size:11px; font-weight:700; color:var(--muted);">Qty</label>
      <input name="qty" type="number" min="1" value="1" placeholder="Qty" required>
    </div>
    <div style="display:flex; flex-direction:column; gap:4px;">
      <label style="font-size:11px; font-weight:700; color:var(--muted);">Biaya Produksi (Satuan)</label>
      <input name="productionCost" type="number" min="0" value="0" placeholder="Biaya jahit/potong per pcs" required>
    </div>
    <button class="mini danger remove-batch-row" type="button" title="Hapus baris" style="margin-top:20px;">×</button>
  `;
  document.querySelector("#batchItemRows").append(row);
}

// Open Production Batch Dialog
document.querySelector("#newBatchBtn").addEventListener("click", async () => {
  document.querySelector('#batchDialog h2').textContent = "Buat Batch Produksi Baru";
  const idInput = document.querySelector('#newBatchForm [name="batchId"]');
  if (idInput) idInput.remove();

  const data = await api("/api/options");
  const uniqueProducts = [];
  const seenIds = new Set();
  data.variants.forEach(row => {
    const isMaterial = row.category === "Bahan Baku" || (row.category === "Aksesoris" && row.sell_price === 0);
    if (!isMaterial && !seenIds.has(row.product_id)) {
      seenIds.add(row.product_id);
      uniqueProducts.push(row);
    }
  });

  document.querySelector("#batchItemRows").innerHTML = "";
  addBatchItemRow(uniqueProducts);

  // Auto-generate Batch Code: BCH-YYYYMMDD-N
  const now = new Date();
  const yyyy = now.getFullYear();
  const mm = String(now.getMonth() + 1).padStart(2, '0');
  const dd = String(now.getDate()).padStart(2, '0');
  const dateStr = `${yyyy}${mm}${dd}`;
  
  const batches = await api("/api/production/batches");
  const countToday = batches.filter(b => b.batch_no && b.batch_no.startsWith(`BCH-${dateStr}-`)).length;
  const nextBatchNo = `BCH-${dateStr}-${countToday + 1}`;
  
  const batchNoInput = document.querySelector('#newBatchForm [name="batchNo"]');
  if (batchNoInput) {
    batchNoInput.value = nextBatchNo;
    batchNoInput.readOnly = true;
    batchNoInput.style.background = "var(--soft-primary)";
    batchNoInput.style.cursor = "not-allowed";
  }

  document.querySelector("#batchDialog").showModal();
});

// Dynamic Add row button inside dialog
document.querySelector("#addBatchItemBtn").addEventListener("click", async () => {
  const data = await api("/api/options");
  const uniqueProducts = [];
  const seenIds = new Set();
  data.variants.forEach(row => {
    const isMaterial = row.category === "Bahan Baku" || (row.category === "Aksesoris" && row.sell_price === 0);
    if (!isMaterial && !seenIds.has(row.product_id)) {
      seenIds.add(row.product_id);
      uniqueProducts.push(row);
    }
  });
  addBatchItemRow(uniqueProducts);
});

// Remove item row button inside dialog
document.querySelector("#batchItemRows").addEventListener("click", (event) => {
  if (!event.target.closest(".remove-batch-row")) return;
  const rowsContainer = document.querySelector("#batchItemRows");
  if (rowsContainer.children.length > 1) {
    event.target.closest(".item-row").remove();
  } else {
    toast("Batch produksi wajib memiliki minimal 1 produk.");
  }
});

// Save Production Batch
document.querySelector("#newBatchForm").addEventListener("submit", async (event) => {
  event.preventDefault();
  const data = formData(event.target);
  
  const items = [...document.querySelectorAll("#batchItemRows .item-row")].map(row => ({
    productId: Number(row.querySelector('[name="productId"]').value),
    qty: Number(row.querySelector('[name="qty"]').value),
    productionCost: Number(row.querySelector('[name="productionCost"]').value)
  }));

  try {
    const isEdit = !!data.batchId;
    const url = isEdit ? `/api/production/batches/${data.batchId}/details` : "/api/production/batches";
    const method = isEdit ? "PUT" : "POST";

    await api(url, {
      method: method,
      body: JSON.stringify({
        batchNo: data.batchNo,
        batchType: data.batchType,
        dueDate: data.dueDate,
        items
      })
    });
    
    document.querySelector("#batchDialog").close();
    event.target.reset();
    
    document.querySelector('#batchDialog h2').textContent = "Buat Batch Produksi Baru";
    const idInput = document.querySelector('#newBatchForm [name="batchId"]');
    if (idInput) idInput.remove();

    toast(isEdit ? "Batch produksi berhasil diubah." : "Batch produksi berhasil dibuat.");
    await refreshAll();
  } catch (err) {
    toast("Gagal menyimpan batch: " + err.message);
  }
});

// Listen batch list clicks for updating progress, cancelling, and deleting
const handleBatchClick = async (event) => {
  const editBtn = event.target.closest(".edit-progress-btn");
  const editDetailBtn = event.target.closest(".edit-batch-detail-btn");
  const cancelBtn = event.target.closest(".cancel-batch-btn");
  const deleteBtn = event.target.closest(".delete-batch-btn");
  
  if (editDetailBtn) {
    const id = Number(editDetailBtn.dataset.id);
    const batch = currentProductionBatches.find(b => b.id === id);
    if (batch) {
      const data = await api("/api/options");
      const uniqueProducts = [];
      const seenIds = new Set();
      data.variants.forEach(row => {
        const isMaterial = row.category === "Bahan Baku" || (row.category === "Aksesoris" && row.sell_price === 0);
        if (!isMaterial && !seenIds.has(row.product_id)) {
          seenIds.add(row.product_id);
          uniqueProducts.push(row);
        }
      });

      // Pre-fill form fields
      document.querySelector('#newBatchForm [name="batchNo"]').value = batch.batch_no;
      document.querySelector('#newBatchForm [name="batchType"]').value = batch.batch_type;
      document.querySelector('#newBatchForm [name="dueDate"]').value = batch.due_date;

      // Set dialog title & ID
      document.querySelector('#batchDialog h2').textContent = "Edit Batch Produksi";
      let idInput = document.querySelector('#newBatchForm [name="batchId"]');
      if (!idInput) {
        idInput = document.createElement("input");
        idInput.type = "hidden";
        idInput.name = "batchId";
        document.querySelector('#newBatchForm').appendChild(idInput);
      }
      idInput.value = batch.id;

      const batchNoInput = document.querySelector('#newBatchForm [name="batchNo"]');
      if (batchNoInput) {
        batchNoInput.readOnly = false;
        batchNoInput.style.background = "";
        batchNoInput.style.cursor = "";
      }

      // Populate items
      const container = document.querySelector("#batchItemRows");
      container.innerHTML = "";
      if (batch.items && batch.items.length) {
        batch.items.forEach(item => {
          addBatchItemRow(uniqueProducts);
          const lastRow = container.lastElementChild;
          lastRow.querySelector('[name="productId"]').value = item.product_id;
          lastRow.querySelector('[name="qty"]').value = item.qty;
          lastRow.querySelector('[name="productionCost"]').value = Math.round(item.production_cost / item.qty);
        });
      } else {
        addBatchItemRow(uniqueProducts);
      }

      document.querySelector("#batchDialog").showModal();
    }
  } else if (editBtn) {
    const form = document.querySelector("#updateProgressForm");
    form.batchId.value = editBtn.dataset.id;
    document.querySelector("#progressBatchTitle").textContent = `Batch: ${editBtn.dataset.no}`;
    form.cuttingProgress.value = editBtn.dataset.cutting;
    form.sewingProgress.value = editBtn.dataset.sewing;
    form.finishingProgress.value = editBtn.dataset.finishing;
    
    // Set text display for sliders
    document.getElementById('cuttingVal').textContent = `${editBtn.dataset.cutting}%`;
    document.getElementById('sewingVal').textContent = `${editBtn.dataset.sewing}%`;
    document.getElementById('finishingVal').textContent = `${editBtn.dataset.finishing}%`;
    
    // Set completedAt to current local time in YYYY-MM-DDTHH:MM format
    const now = new Date();
    const localIso = new Date(now.getTime() - now.getTimezoneOffset() * 60000).toISOString().slice(0, 16);
    if (form.completedAt) form.completedAt.value = localIso;

    document.querySelector("#progressDialog").showModal();
  } else if (cancelBtn) {
    const id = cancelBtn.dataset.id;
    const no = cancelBtn.dataset.no;
    if (confirm(`Apakah Anda yakin ingin membatalkan Batch Produksi ${no}?`)) {
      try {
        await api(`/api/production/batches/${id}/cancel`, { method: "POST" });
        toast(`Batch ${no} berhasil dibatalkan.`);
        await refreshAll();
      } catch (e) {
        console.error(e);
        toast(`Gagal membatalkan batch: ${e.message}`);
      }
    }
  } else if (deleteBtn) {
    const id = deleteBtn.dataset.id;
    const no = deleteBtn.dataset.no;
    if (confirm(`Apakah Anda yakin ingin menghapus Batch Produksi ${no}? Tindakan ini permanen.`)) {
      try {
        await api(`/api/production/batches/${id}`, { method: "DELETE" });
        toast(`Batch ${no} berhasil dihapus.`);
        await refreshAll();
      } catch (e) {
        console.error(e);
        toast(`Gagal menghapus batch: ${e.message}`);
      }
    }
  }
};

document.querySelector("#productionBatchList").addEventListener("click", handleBatchClick);
const historyListEl = document.querySelector("#productionHistoryList");
if (historyListEl) {
  historyListEl.addEventListener("click", handleBatchClick);
}

// Save progress update
document.querySelector("#updateProgressForm").addEventListener("submit", async (event) => {
  event.preventDefault();
  const data = formData(event.target);
  try {
    await api(`/api/production/batches/${data.batchId}`, {
      method: "PUT",
      body: JSON.stringify({
        cuttingProgress: Number(data.cuttingProgress),
        sewingProgress: Number(data.sewingProgress),
        finishingProgress: Number(data.finishingProgress),
        completedAt: data.completedAt || ""
      })
    });
    document.querySelector("#progressDialog").close();
    toast("Progress batch produksi diperbarui.");
    await refreshAll();
  } catch (error) {
    toast(error.message);
  }
});

// Delete Supplier Event Listener
document.querySelector("#supplierTable").addEventListener("click", async (event) => {
  const btn = event.target.closest(".delete-supplier-btn");
  if (!btn) return;
  
  const id = btn.dataset.id;
  const name = btn.dataset.name;
  
  if (confirm(`Apakah Anda yakin ingin menghapus Supplier ${name}? Tindakan ini permanen.`)) {
    try {
      await api(`/api/suppliers/${id}`, { method: "DELETE" });
      toast(`Supplier ${name} berhasil dihapus.`);
      await refreshAll();
    } catch (e) {
      console.error(e);
      toast(`Gagal menghapus supplier: ${e.message}`);
    }
  }
});

// Revenue form item row creator
function addRevenueItemRow(item = {}) {
  const sellable = (productRows || []).filter(v => v.category !== "Bahan Baku" && v.category !== "Packaging" && v.category !== "Hangtag");
  const row = document.createElement("div");
  row.className = "item-row";
  row.innerHTML = `
    <select name="variantId" required>
      ${sellable.map((v) => `<option value="${v.variant_id}" ${String(item.variant_id || item.variantId || "") === String(v.variant_id) ? "selected" : ""}>${v.sku} - ${v.name}</option>`).join("")}
    </select>
    <input name="onlineQty" type="number" min="0" value="${item.online_qty || item.onlineQty || 0}" placeholder="Qty online">
    <input name="offlineQty" type="number" min="0" value="${item.offline_qty || item.offlineQty || 0}" placeholder="Qty offline">
    <button class="mini danger remove-row" type="button" title="Hapus baris">×</button>
  `;
  document.querySelector("#revenueItemRows").append(row);
}

function revenueItemsFromForm() {
  return [...document.querySelectorAll("#revenueItemRows .item-row")].map((row) => ({
    variantId: row.querySelector('[name="variantId"]').value,
    onlineQty: row.querySelector('[name="onlineQty"]').value,
    offlineQty: row.querySelector('[name="offlineQty"]').value
  })).filter((item) => Number(item.onlineQty) || Number(item.offlineQty));
}

function setRevenueItems(items = []) {
  document.querySelector("#revenueItemRows").innerHTML = "";
  if (!items.length) addRevenueItemRow();
  items.forEach((item) => addRevenueItemRow(item));
  recalculateRevenues();
}

function recalculateRevenues() {
  let onlineSum = 0;
  let offlineSum = 0;
  
  const rows = document.querySelectorAll("#revenueItemRows .item-row");
  rows.forEach(row => {
    const select = row.querySelector('select[name="variantId"]');
    const onlineInput = row.querySelector('input[name="onlineQty"]');
    const offlineInput = row.querySelector('input[name="offlineQty"]');
    
    if (select && onlineInput && offlineInput) {
      const variantId = select.value;
      const onlineQty = Number(onlineInput.value || 0);
      const offlineQty = Number(offlineInput.value || 0);
      
      const variant = productRows.find(v => String(v.variant_id) === String(variantId));
      if (variant) {
        onlineSum += onlineQty * (variant.sell_price || 0);
        offlineSum += offlineQty * (variant.sell_price || 0);
      }
    }
  });
  
  const form = document.querySelector("#monthlyRevenueForm");
  if (form) {
    form.querySelector('input[name="onlineRevenue"]').value = onlineSum || 0;
    form.querySelector('input[name="offlineRevenue"]').value = offlineSum || 0;
  }
}

document.querySelector("#addRevenueItem").addEventListener("click", () => {
  addRevenueItemRow();
  recalculateRevenues();
});

document.querySelector("#revenueItemRows").addEventListener("click", (event) => {
  if (!event.target.closest(".remove-row")) return;
  event.target.closest(".item-row").remove();
  if (!document.querySelector("#revenueItemRows").children.length) addRevenueItemRow();
  recalculateRevenues();
});

document.querySelector("#revenueItemRows").addEventListener("input", recalculateRevenues);
document.querySelector("#revenueItemRows").addEventListener("change", recalculateRevenues);

document.querySelector("#movementMonth").addEventListener("change", () => {
  loadMovements().catch((error) => toast(error.message));
});

// Auth handlers
document.querySelector("#loginForm").addEventListener("submit", async (event) => {
  event.preventDefault();
  try {
    const data = await api("/api/auth/login", { method: "POST", body: JSON.stringify(formData(event.target)) });
    authToken = data.token;
    currentUser = data.user;
    localStorage.setItem("tera_token", authToken);
    localStorage.setItem("tera_user", JSON.stringify(currentUser));
    showApp();
    
    // Give 150ms for transition animation and layout settlement before rendering charts
    setTimeout(() => {
      refreshAll().catch((error) => toast(error.message));
    }, 150);
  } catch (error) {
    toast(error.message);
  }
});



document.querySelector("#logoutBtn").addEventListener("click", () => {
  authToken = "";
  currentUser = null;
  localStorage.removeItem("tera_token");
  localStorage.removeItem("tera_user");
  showLogin();
});

let selectedSizes = ["M"];

function initSizeSelector() {
  const sizeSelectBtn = document.querySelector("#sizeSelectBtn");
  const sizeSelectPopover = document.querySelector("#sizeSelectPopover");
  const sizeHiddenInput = document.querySelector("#sizeHiddenInput");
  const sizeSelectLabel = document.querySelector("#sizeSelectLabel");
  const selectedCountInfo = document.querySelector("#selectedCountInfo");
  const sizeSelectDoneBtn = document.querySelector("#sizeSelectDoneBtn");

  if (!sizeSelectBtn) return;

  sizeSelectBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    sizeSelectPopover.classList.toggle("hidden");
  });

  sizeSelectDoneBtn.addEventListener("click", () => {
    sizeSelectPopover.classList.add("hidden");
  });

  document.addEventListener("click", (e) => {
    if (!sizeSelectPopover.classList.contains("hidden") && !sizeSelectPopover.contains(e.target) && e.target !== sizeSelectBtn) {
      sizeSelectPopover.classList.add("hidden");
    }
  });

  const tabs = document.querySelectorAll(".size-type-tab");
  tabs.forEach(tab => {
    tab.addEventListener("click", (e) => {
      e.stopPropagation();
      tabs.forEach(t => t.classList.remove("active"));
      tab.classList.add("active");

      const type = tab.dataset.type;
      document.querySelectorAll(".size-group-content").forEach(el => el.classList.add("hidden"));
      if (type === "alpha") {
        document.querySelector("#sizeGroupAlpha").classList.remove("hidden");
      } else if (type === "numeric") {
        document.querySelector("#sizeGroupNumeric").classList.remove("hidden");
      } else if (type === "custom") {
        document.querySelector("#sizeGroupCustom").classList.remove("hidden");
      }
    });
  });

  const alphaSizes = ["S", "M", "L", "XL", "XXL", "All Size"];
  const numericSizes = ["27", "28", "29", "30", "31", "32", "33", "34", "35", "36"];

  window.renderChips = function() {
    const alphaContainer = document.querySelector("#sizeGroupAlpha");
    if (alphaContainer) {
      alphaContainer.innerHTML = alphaSizes.map(sz => {
        const isSelected = selectedSizes.includes(sz);
        return `<span class="size-chip" data-size="${sz}" style="${getChipStyle(isSelected)}">${sz}</span>`;
      }).join("");
    }

    const numericContainer = document.querySelector("#sizeGroupNumeric");
    if (numericContainer) {
      numericContainer.innerHTML = numericSizes.map(sz => {
        const isSelected = selectedSizes.includes(sz);
        return `<span class="size-chip" data-size="${sz}" style="${getChipStyle(isSelected)}">${sz}</span>`;
      }).join("");
    }

    document.querySelectorAll(".size-chip").forEach(chip => {
      chip.addEventListener("click", (e) => {
        e.stopPropagation();
        const sz = chip.dataset.size;
        const index = selectedSizes.indexOf(sz);
        if (index > -1) {
          if (selectedSizes.length > 1) {
            selectedSizes.splice(index, 1);
          }
        } else {
          selectedSizes.push(sz);
        }
        updateSelectedUI();
        window.renderChips();
      });
    });
  };

  function getChipStyle(isSelected) {
    if (isSelected) {
      return "border: 1px solid var(--accent); background: var(--soft-primary); color: var(--accent); font-weight: 600; padding: 4px 8px; border-radius: 4px; cursor: pointer; font-size: 11px; display: inline-block; margin: 2px 0;";
    }
    return "border: 1px solid var(--line); background: white; color: var(--foreground); padding: 4px 8px; border-radius: 4px; cursor: pointer; font-size: 11px; display: inline-block; margin: 2px 0;";
  }

  window.updateSelectedUI = function() {
    if (sizeHiddenInput) {
      sizeHiddenInput.value = selectedSizes.join(",");
      sizeHiddenInput.dispatchEvent(new Event("input", { bubbles: true }));
    }
    if (sizeSelectLabel) {
      sizeSelectLabel.textContent = selectedSizes.join(", ");
    }
    if (selectedCountInfo) {
      selectedCountInfo.textContent = `${selectedSizes.length} terpilih`;
    }
    const form = document.querySelector("#productForm");
    if (form && form.sku) {
      form.sku.value = generateSku(form.name.value, form.category.value, selectedSizes.join(","), form.color.value);
    }
  };

  const btnCustomSizeAdd = document.querySelector("#btnCustomSizeAdd");
  const customSizeText = document.querySelector("#customSizeText");
  if (btnCustomSizeAdd && customSizeText) {
    btnCustomSizeAdd.addEventListener("click", (e) => {
      e.stopPropagation();
      const val = customSizeText.value.trim().toUpperCase();
      if (val && !selectedSizes.includes(val)) {
        selectedSizes.push(val);
        customSizeText.value = "";
        updateSelectedUI();
        window.renderChips();
      }
    });
  }

  updateSelectedUI();
  window.renderChips();
}

// Add variant
document.querySelector("#productForm").addEventListener("submit", async (event) => {
  event.preventDefault();
  try {
    await api("/api/products", { method: "POST", body: JSON.stringify(formData(event.target)) });
    event.target.reset();
    selectedSizes = ["M"];
    if (typeof window.updateSelectedUI === "function") {
      window.updateSelectedUI();
      window.renderChips();
    }
    const totalInput = event.target.querySelector("#productFormTotal");
    if (totalInput) totalInput.value = "";
    toast("Artikel baru TERA berhasil ditambahkan.");
    await refreshAll();
  } catch (error) {
    toast(error.message);
  }
});

function generateSku(name, category, size, color) {
  if (!name) return "";
  const namePart = name.trim().toUpperCase()
    .replace(/[^A-Z0-9\s-]/g, "")
    .replace(/\s+/g, "-");

  const cat = (category || "").trim().toUpperCase();
  let catPart = "";
  if (cat.includes("T-SHIRT")) catPart = "TS";
  else if (cat.includes("HOODIE")) catPart = "HD";
  else if (cat.includes("SHIRT")) catPart = "SH";
  else if (cat.includes("PANTS")) catPart = "PT";
  else if (cat.includes("JACKET")) catPart = "JK";
  else if (cat.includes("CAP")) catPart = "CP";
  else if (cat.includes("TOTE BAG")) catPart = "TB";
  else if (cat.includes("OUTERWEAR")) catPart = "OW";
  else if (cat.includes("AKSESORIS")) catPart = "AKS";
  else catPart = cat.slice(0, 3);

  const colPart = color.trim().toUpperCase()
    .replace(/[^A-Z0-9]/g, "")
    .slice(0, 3);

  if (size.includes(",")) {
    return ["TERA", namePart, catPart, colPart].filter(Boolean).join("-");
  }

  const szPart = size.trim().toUpperCase().replace(/\s+/g, "");
  return ["TERA", namePart, catPart, colPart, szPart].filter(Boolean).join("-");
}

document.querySelector("#productForm").addEventListener("input", (event) => {
  const form = event.currentTarget;

  const name = form.name.value;
  const category = form.category.value;
  const size = form.size ? form.size.value : selectedSizes.join(",");
  const color = form.color.value;
  if (form.sku && ["name", "category", "size", "color"].includes(event.target.name)) {
    form.sku.value = generateSku(name, category, size, color);
  }
});

setTimeout(initSizeSelector, 100);

document.querySelector("#monthlyRevenueForm").addEventListener("submit", async (event) => {
  event.preventDefault();
  try {
    await api("/api/monthly-revenues", {
      method: "POST",
      body: JSON.stringify({ ...formData(event.target), items: revenueItemsFromForm() })
    });
    toast("Pendapatan bulanan tersimpan.");
    await refreshAll();
  } catch (error) {
    toast(error.message);
  }
});

document.querySelector("#monthlyRevenueTable").addEventListener("click", async (event) => {
  const editButton = event.target.closest(".edit-revenue");
  const deleteButton = event.target.closest(".delete-revenue");
  if (editButton) {
    const row = monthlyRevenueRows.find((item) => item.month === editButton.dataset.month);
    if (!row) return;
    const form = document.querySelector("#monthlyRevenueForm");
    form.month.value = row.month;
    form.onlineRevenue.value = row.online_revenue;
    form.offlineRevenue.value = Math.round(row.offline_revenue / 0.64);
    form.onlineNotes.value = row.online_notes || "";
    form.offlineNotes.value = row.offline_notes || "";
    form.onlineOrderCount.value = row.online_order_count || 0;
    setRevenueItems(row.items || []);
    toast("Data pendapatan dimuat ke form untuk diedit.");
  }
  if (deleteButton) {
    if (!confirm("Hapus riwayat pendapatan bulan ini?")) return;
    try {
      await api(`/api/monthly-revenues/${encodeURIComponent(deleteButton.dataset.month)}`, { method: "DELETE" });
      toast("Pendapatan bulan itu dihapus.");
      await refreshAll();
    } catch (error) {
      toast(error.message);
    }
  }
});

document.querySelector("#expenseForm").addEventListener("submit", async (event) => {
  event.preventDefault();
  try {
    await api("/api/monthly-expenses", { method: "POST", body: JSON.stringify(formData(event.target)) });
    event.target.reset();
    toast("Pengeluaran bulanan berhasil disimpan.");
    await refreshAll();
  } catch (error) {
    toast(error.message);
  }
});

document.querySelector("#movementsTable").addEventListener("click", async (event) => {
  const deleteButton = event.target.closest(".delete-movement");
  if (!deleteButton) return;
  if (!confirm("Hapus riwayat pergerakan stok ini? Stok di pool akan disesuaikan kembali.")) return;
  try {
    await api(`/api/movements/${deleteButton.dataset.id}`, { method: "DELETE" });
    toast("Riwayat pergerakan stok berhasil dihapus.");
    await refreshAll();
  } catch (error) {
    toast(error.message);
  }
});

document.querySelector("#expenseTable").addEventListener("click", async (event) => {
  const deleteButton = event.target.closest(".delete-expense");
  if (!deleteButton) return;
  if (!confirm("Hapus pengeluaran ini?")) return;
  try {
    await api(`/api/monthly-expenses/${deleteButton.dataset.id}`, { method: "DELETE" });
    toast("Pengeluaran berhasil dihapus.");
    await refreshAll();
  } catch (error) {
    toast(error.message);
  }
});

document.querySelector("#receiveForm").addEventListener("submit", async (event) => {
  event.preventDefault();
  try {
    await api("/api/stock/receive", { method: "POST", body: JSON.stringify(formData(event.target)) });
    event.target.reset();
    toast("Stock berhasil ditambahkan.");
    await refreshAll();
  } catch (error) {
    toast(error.message);
  }
});

document.querySelector("#transferForm").addEventListener("submit", async (event) => {
  event.preventDefault();
  const data = formData(event.target);
  if (data.fromPoolId === data.toPoolId) return toast("Pool asal dan tujuan harus berbeda.");
  try {
    await api("/api/stock/transfer", { method: "POST", body: JSON.stringify(data) });
    event.target.reset();
    toast("Transfer stock selesai.");
    await refreshAll();
  } catch (error) {
    toast(error.message);
  }
});

// Debounced Window Resize handler to avoid chart stretch, ignoring height changes on mobile (e.g. URL bar show/hide)
let lastWidth = window.innerWidth;
window.addEventListener("resize", () => {
  if (authToken) {
    const currentWidth = window.innerWidth;
    if (currentWidth === lastWidth) return;
    lastWidth = currentWidth;

    if (window.resizeTimeout) clearTimeout(window.resizeTimeout);
    window.resizeTimeout = setTimeout(() => {
      refreshAll().catch((err) => console.warn("Error refreshing on resize:", err));
    }, 150);
  }
});

// Init theme
if (localStorage.getItem("tera_theme") === "dark") {
  document.body.classList.add("dark");
  document.querySelector("#themeToggle").textContent = "☀️";
  document.querySelector("#themeToggle").title = "Light mode";
}

// Auto Login or redirect
if (authToken && currentUser) {
  showApp();
  // Give 150ms for layout initialization before drawing charts
  setTimeout(() => {
    refreshAll().catch((err) => {
      console.error("Failed to refresh data - logging out:", err);
      localStorage.removeItem("tera_token");
      localStorage.removeItem("tera_user");
      showLogin();
    });
  }, 150);
} else {
  showLogin();
}

// System Reset Handler
const resetBtn = document.querySelector("#systemResetBtn");
if (resetBtn) {
  resetBtn.addEventListener("click", async () => {
    const confirm1 = confirm("Apakah Anda yakin ingin mereset seluruh database TERA ERP? Semua data produk, supplier, inventori, riwayat transaksi, PO, batch produksi, dan BOM akan terhapus selamanya.");
    if (!confirm1) return;
    
    const confirm2 = confirm("Peringatan Terakhir: Setelah berhasil direset, Anda akan otomatis logout dan harus masuk kembali menggunakan akun default TERA.");
    if (!confirm2) return;
    
    try {
      resetBtn.disabled = true;
      resetBtn.textContent = "Sedang mereset...";
      
      const data = await api("/api/system/reset", { method: "POST" });
      if (data.ok) {
        toast("Database berhasil direset ke kondisi awal.");
        
        // Clear auth sessions
        authToken = "";
        currentUser = null;
        localStorage.removeItem("tera_token");
        localStorage.removeItem("tera_user");
        
        // Wait 1.5s then redirect to login screen
        setTimeout(() => {
          showLogin();
          // Reset button state
          resetBtn.disabled = false;
          resetBtn.textContent = "Reset Database ke Awal";
        }, 1500);
      } else {
        throw new Error(data.error || "Gagal melakukan reset");
      }
    } catch (err) {
      toast("Error: " + err.message);
      resetBtn.disabled = false;
      resetBtn.textContent = "Reset Database ke Awal";
    }
  });
}

async function loadKeuanganReports() {
  try {
    const data = await api("/api/keuangan/reports");
    renderIncomeStatement(data);
    renderCashBudget(data);
  } catch (error) {
    console.error("Failed to load keuangan reports:", error);
  }
}

// Event delegation for deleting reports
document.querySelector("#laporan")?.addEventListener("click", async (event) => {
  if (event.target.classList.contains("delete-report-btn")) {
    const month = event.target.dataset.month;
    const confirmDelete = confirm(`Apakah Anda yakin ingin menghapus seluruh data laporan (penjualan dan pengeluaran) untuk bulan ${month}? Perubahan ini tidak dapat dibatalkan.`);
    if (!confirmDelete) return;

    try {
      const btn = event.target;
      btn.disabled = true;
      btn.textContent = "Menghapus...";
      const res = await api(`/api/keuangan/reports/${month}`, { method: "DELETE" });
      if (res.ok) {
        toast(`Laporan bulan ${month} berhasil dihapus.`);
        await loadKeuanganReports();
      } else {
        throw new Error(res.error || "Gagal menghapus laporan.");
      }
    } catch (err) {
      toast("Error: " + err.message);
      event.target.disabled = false;
      event.target.textContent = "Hapus";
    }
  }
});

function renderIncomeStatement(data) {
  const tableEl = document.querySelector("#incomeStatementSheet");
  if (!tableEl) return;
  
  if (!data || !data.length) {
    tableEl.innerHTML = `<tr><td style="text-align:center; padding:24px; color:var(--muted);">Belum ada data keuangan. Silakan input penjualan/pengeluaran terlebih dahulu.</td></tr>`;
    return;
  }
  
  let html = `
    <tr class="header-row">
      <td style="font-weight:800; min-width: 220px;">Tera</td>
      ${data.map(m => `<td style="font-weight:800; text-align:right; min-width: 180px;">Tera</td>`).join("")}
    </tr>
    <tr class="header-row">
      <td style="font-weight:700;">Income Statement</td>
      ${data.map(m => `<td style="font-weight:700; text-align:right;">Income Statement</td>`).join("")}
    </tr>
    <tr class="header-row">
      <td style="color:var(--muted); font-size:11px;">For the period ended</td>
      ${data.map(m => `
        <td style="text-align:right; font-size:11px;">
          For the period ended, ${monthName(m.month)}
          <div style="margin-top:4px;">
            <button class="delete-report-btn" data-month="${m.month}" style="background:#ef4444; color:white; border:none; padding:2px 6px; border-radius:4px; font-size:10px; cursor:pointer;">Hapus</button>
          </div>
        </td>
      `).join("")}
    </tr>
    
    <tr style="height: 10px;"><td colspan="${data.length + 1}"></td></tr>
    
    <tr style="font-weight:700; background:var(--soft-tertiary);"><td colspan="${data.length + 1}">Revenue</td></tr>
    <tr>
      <td>Sales <span class="formula-note">(Quantity × Sell Price)</span></td>
      ${data.map(m => `<td style="text-align:right;">${rupiah.format(m.grossSales)} <span class="formula-note" style="text-align:right;">(${m.qtySold} × ${rupiah.format(m.avgPrice)})</span></td>`).join("")}
    </tr>
    <tr>
      <td>Dikurang komisi <span class="formula-note">(36% Offline)</span></td>
      ${data.map(m => `<td style="text-align:right; color:#ef4444;">-${rupiah.format(m.komisi)} <span class="formula-note" style="text-align:right; color:#ef4444;">-36% Off</span></td>`).join("")}
    </tr>
    <tr class="total-row">
      <td>Total Revenue</td>
      ${data.map(m => `<td style="text-align:right;"><strong>${rupiah.format(m.totalRevenue)}</strong></td>`).join("")}
    </tr>
    
    <tr style="font-weight:700; background:var(--soft-tertiary);"><td colspan="${data.length + 1}">Cost</td></tr>
    <tr>
      <td>COGS <span class="formula-note">(HPP Artikel Terjual)</span></td>
      ${data.map(m => `<td style="text-align:right;">${rupiah.format(m.cogs)}</td>`).join("")}
    </tr>
    <tr class="total-row">
      <td>Operating Income</td>
      ${data.map(m => `<td style="text-align:right;"><strong>${rupiah.format(m.operatingIncome)}</strong></td>`).join("")}
    </tr>
    
    <tr style="font-weight:700; background:var(--soft-tertiary);"><td colspan="${data.length + 1}">Other cost</td></tr>
    <tr>
      <td>Other cost <span class="formula-note">(Operasional & Marketing)</span></td>
      ${data.map(m => `<td style="text-align:right;">${rupiah.format(m.otherCost)}</td>`).join("")}
    </tr>
    <tr>
      <td>Gaji Karyawan</td>
      ${data.map(m => `<td style="text-align:right;">${rupiah.format(m.bayarDavid)}</td>`).join("")}
    </tr>
    <tr class="total-row">
      <td>Net Income</td>
      ${data.map(m => `<td style="text-align:right;" class="cash-highlight">${rupiah.format(m.netIncome)}</td>`).join("")}
    </tr>
  `;
  
  tableEl.innerHTML = html;
}

function renderCashBudget(data) {
  const tableEl = document.querySelector("#cashBudgetSheet");
  if (!tableEl) return;
  
  if (!data || !data.length) {
    tableEl.innerHTML = `<tr><td style="text-align:center; padding:24px; color:var(--muted);">Belum ada data keuangan. Silakan input penjualan/pengeluaran terlebih dahulu.</td></tr>`;
    return;
  }
  
  let html = `
    <tr class="header-row">
      <td style="font-weight:800; min-width: 220px;">Tera</td>
      ${data.map(m => `<td style="font-weight:800; text-align:right; min-width: 180px;">Tera</td>`).join("")}
    </tr>
    <tr class="header-row">
      <td style="font-weight:700;">Cash Budget</td>
      ${data.map(m => `<td style="font-weight:700; text-align:right;">Cash Budget</td>`).join("")}
    </tr>
    <tr class="header-row">
      <td style="color:var(--muted); font-size:11px;">For the period ended</td>
      ${data.map(m => `
        <td style="text-align:right; font-size:11px;">
          For the period ended, ${monthName(m.month)}
          <div style="margin-top:4px;">
            <button class="delete-report-btn" data-month="${m.month}" style="background:#ef4444; color:white; border:none; padding:2px 6px; border-radius:4px; font-size:10px; cursor:pointer;">Hapus</button>
          </div>
        </td>
      `).join("")}
    </tr>
    
    <tr style="height: 10px;"><td colspan="${data.length + 1}"></td></tr>
    
    <tr>
      <td>Beginning cash</td>
      ${data.map(m => `<td style="text-align:right; font-weight:700;">${rupiah.format(m.beginningCash)}</td>`).join("")}
    </tr>
    
    <tr style="font-weight:700; background:var(--soft-tertiary);"><td colspan="${data.length + 1}">Cash Received</td></tr>
    <tr>
      <td>Sales / Operating income <span class="formula-note">(Sales jika ada Bahan Kain > 0, else Operating Income)</span></td>
      ${data.map(m => `<td style="text-align:right;">${rupiah.format(m.cashReceived)} <span class="formula-note" style="text-align:right; font-weight:600; color:var(--accent);">${m.cashReceivedLabel}</span></td>`).join("")}
    </tr>
    <tr class="total-row">
      <td>Total cash available</td>
      ${data.map(m => `<td style="text-align:right;"><strong>${rupiah.format(m.totalCashAvailable)}</strong></td>`).join("")}
    </tr>
    
    <tr style="font-weight:700; background:var(--soft-tertiary);"><td colspan="${data.length + 1}">Cash Disbursement (pengeluaran)</td></tr>
    <tr>
      <td>Bahan Kain <span class="formula-note">(PO / Bahan / Packaging / Hangtag)</span></td>
      ${data.map(m => `<td style="text-align:right; color:#ef4444;">-${rupiah.format(m.bahanKain)}</td>`).join("")}
    </tr>
    <tr>
      <td>Biaya gaji <span class="formula-note">(Gaji Karyawan)</span></td>
      ${data.map(m => `<td style="text-align:right; color:#ef4444;">-${rupiah.format(m.biayaGaji)}</td>`).join("")}
    </tr>
    <tr>
      <td>Biaya Operasional & Lainnya <span class="formula-note">(Marketing, Sewa, dll)</span></td>
      ${data.map(m => `<td style="text-align:right; color:#ef4444;">-${rupiah.format(m.otherExpenses)}</td>`).join("")}
    </tr>
    <tr class="total-row">
      <td>Total cash disbursement</td>
      ${data.map(m => `<td style="text-align:right;"><strong>-${rupiah.format(m.totalCashDisbursement)}</strong></td>`).join("")}
    </tr>
    <tr class="total-row">
      <td>Cash di rekening saat ini</td>
      ${data.map(m => `<td style="text-align:right;" class="cash-highlight">${rupiah.format(m.endingCash)}</td>`).join("")}
    </tr>
  `;
  
  tableEl.innerHTML = html;
}

async function loadCategoryStocks() {
  try {
    const data = await api("/api/inventory/categories");
    const tbody = document.querySelector("#categoryStockTableBody");
    if (!tbody) return;
    
    let html = "";
    data.clothing.forEach(row => {
      html += `
        <tr class="clickable-stock-row" data-id="${row.variant_id}" style="cursor: pointer;">
          <td><strong>${row.category} - ${row.product_name}</strong> <span style="font-size:10px; color:var(--muted); margin-left:8px; font-weight:normal;">(klik detail)</span></td>
          <td style="text-align:right;">${number.format(row.online_qty)} pcs</td>
          <td style="text-align:right;">${number.format(row.offline_qty)} pcs</td>
          <td style="text-align:right;"><strong>${number.format(row.total_qty)} pcs</strong></td>
        </tr>
      `;
    });
    
    let pkgBaju = 0;
    let pkgOrder = 0;
    let hangtag = 0;
    
    data.auxiliary.forEach(row => {
      if (row.name === "Packaging Baju") pkgBaju = row.qty;
      if (row.name === "Packaging Order") pkgOrder = row.qty;
      if (row.name === "Hangtag") hangtag = row.qty;
    });
    
    html += `
      <tr style="border-top: 2px solid var(--line); background: var(--soft-primary);">
        <td><strong>Packaging Baju</strong></td>
        <td style="text-align:right; color:var(--muted);">-</td>
        <td style="text-align:right; color:var(--muted);">-</td>
        <td style="text-align:right;"><strong>${number.format(pkgBaju)} pcs</strong></td>
      </tr>
      <tr style="background: var(--soft-primary);">
        <td><strong>Packaging Order</strong></td>
        <td style="text-align:right; color:var(--muted);">-</td>
        <td style="text-align:right; color:var(--muted);">-</td>
        <td style="text-align:right;"><strong>${number.format(pkgOrder)} pcs</strong></td>
      </tr>
      <tr style="background: var(--soft-primary);">
        <td><strong>Hangtag</strong></td>
        <td style="text-align:right; color:var(--muted);">-</td>
        <td style="text-align:right; color:var(--muted);">-</td>
        <td style="text-align:right;"><strong>${number.format(hangtag)} pcs</strong></td>
      </tr>
    `;
    tbody.innerHTML = html;
  } catch (error) {
    console.error("Failed to load category stocks:", error);
  }
}

let aiLoaded = false;
let activeSessionId = null;

async function populateAiMonthSelect() {
  try {
    const profits = await api("/api/profit-summary");
    const select = document.querySelector("#aiAnalysisMonthSelect");
    if (!select) return;
    
    const currentVal = select.value;
    select.innerHTML = `<option value="">Laporan Terkini (Semua Bulan)</option>`;
    
    const months = [...new Set(profits.map(p => p.month))].sort().reverse();
    months.forEach(m => {
      select.innerHTML += `<option value="${m}">${monthName(m)}</option>`;
    });
    
    select.value = currentVal;
  } catch (err) {
    console.error("Gagal memuat bulan analisis AI:", err);
  }
}

async function loadAiSessions() {
  try {
    const sessions = await api("/api/ai/sessions");
    const listEl = document.querySelector("#aiChatSessionsList");
    if (!listEl) return;
    
    if (!sessions.length) {
      listEl.innerHTML = `<div style="text-align: center; padding: 12px; color: var(--muted); font-size: 11px;">Belum ada riwayat.</div>`;
      return;
    }
    
    listEl.innerHTML = sessions.map(s => {
      const isActive = s.id === activeSessionId;
      const activeStyle = isActive ? "border-color: var(--accent); background: var(--soft-primary); font-weight: 700;" : "background: var(--bg); border-color: var(--line);";
      return `
        <div class="session-item" data-id="${s.id}" style="display: flex; justify-content: space-between; align-items: center; padding: 8px 12px; border-radius: 6px; cursor: pointer; border: 1px solid; font-size: 12px; transition: all 0.2s; ${activeStyle}">
          <span class="session-title" style="overflow: hidden; text-overflow: ellipsis; white-space: nowrap; flex-grow: 1; margin-right: 8px;">${escapeHtml(s.title)}</span>
          <button class="delete-session-btn" data-id="${s.id}" style="border: none; background: none; color: var(--muted); cursor: pointer; padding: 4px; font-size: 12px; line-height: 1;" type="button" title="Hapus sesi">🗑</button>
        </div>
      `;
    }).join("");
  } catch (err) {
    console.error(err);
  }
}

async function selectAiSession(id) {
  activeSessionId = id;
  await loadAiSessions();
  
  const chatMessagesEl = document.querySelector("#aiChatMessages");
  if (!chatMessagesEl) return;
  
  chatMessagesEl.innerHTML = `<div style="text-align:center; padding:24px; color:var(--muted);">Memuat pesan...</div>`;
  
  try {
    const messages = await api(`/api/ai/sessions/${id}/messages`);
    const title = document.querySelector(`.session-item[data-id="${id}"] .session-title`)?.textContent || "Chat Obrolan";
    document.querySelector("#activeChatTitle").textContent = title;
    
    chatMessagesEl.innerHTML = "";
    if (!messages.length) {
      chatMessagesEl.innerHTML = `
        <div class="ai-message" style="background: var(--soft-primary); padding: 10px 14px; border-radius: 8px 8px 8px 0; max-width: 85%; align-self: flex-start; border: 1px solid var(--soft-secondary);">
          Halo! Saya adalah Virtual COO dan Konsultan Bisnis Utama Anda untuk sesi ini. 
          Tanyakan apa saja tentang data stok, kemasan, atau laporan keuangan TERA.
        </div>
      `;
    } else {
      messages.forEach(m => {
        const isUser = m.role === "user";
        const msgHtml = isUser ? `
          <div class="user-message" style="background: var(--primary); color: var(--panel); padding: 10px 14px; border-radius: 8px 8px 0 8px; max-width: 85%; align-self: flex-end; font-size: 13px; line-height: 1.5;">
            ${escapeHtml(m.message)}
          </div>
        ` : `
          <div class="ai-message" style="background: var(--soft-primary); padding: 10px 14px; border-radius: 8px 8px 8px 0; max-width: 85%; align-self: flex-start; border: 1px solid var(--soft-secondary);">
            ${parseMarkdown(m.message)}
          </div>
        `;
        chatMessagesEl.insertAdjacentHTML("beforeend", msgHtml);
      });
    }
    chatMessagesEl.scrollTop = chatMessagesEl.scrollHeight;
  } catch (err) {
    chatMessagesEl.innerHTML = `<div style="color:var(--offline); text-align:center; padding:24px;">Gagal memuat pesan: ${err.message}</div>`;
  }
}

async function startNewAiChat() {
  try {
    const session = await api("/api/ai/sessions", {
      method: "POST",
      body: JSON.stringify({ title: "Obrolan Baru" })
    });
    activeSessionId = session.id;
    document.querySelector("#activeChatTitle").textContent = "Obrolan Baru";
    await loadAiSessions();
    await selectAiSession(session.id);
  } catch (err) {
    toast("Gagal membuat sesi baru: " + err.message);
  }
}

async function deleteAiSession(id) {
  if (!confirm("Apakah Anda yakin ingin menghapus sesi obrolan ini?")) return;
  try {
    await api(`/api/ai/sessions/${id}`, { method: "DELETE" });
    if (activeSessionId === id) {
      activeSessionId = null;
      const chatMessagesEl = document.querySelector("#aiChatMessages");
      if (chatMessagesEl) {
        chatMessagesEl.innerHTML = `
          <div class="ai-message" style="background: var(--soft-primary); padding: 10px 14px; border-radius: 8px 8px 8px 0; max-width: 85%; align-self: flex-start; border: 1px solid var(--soft-secondary);">
            Pilih obrolan dari riwayat di sebelah kiri atau buat obrolan baru untuk memulai.
          </div>
        `;
      }
      document.querySelector("#activeChatTitle").textContent = "Konsultan Bisnis AI (Virtual COO)";
    }
    await loadAiSessions();
  } catch (err) {
    toast("Gagal menghapus sesi: " + err.message);
  }
}

async function loadAiConsultant() {
  if (aiLoaded) return;

  await populateAiMonthSelect();
  await loadAiSessions();
  
  const chatMessagesEl = document.querySelector("#aiChatMessages");
  if (chatMessagesEl && !activeSessionId) {
    try {
      const sessions = await api("/api/ai/sessions");
      if (sessions && sessions.length > 0) {
        activeSessionId = sessions[0].id;
        await selectAiSession(activeSessionId);
      } else {
        chatMessagesEl.innerHTML = `
          <div class="ai-message" style="background: var(--soft-primary); padding: 10px 14px; border-radius: 8px 8px 8px 0; max-width: 85%; align-self: flex-start; border: 1px solid var(--soft-secondary);">
            Pilih obrolan dari riwayat di sebelah kiri atau klik "＋ Obrolan Baru" untuk memulai konsultasi bisnis AI dengan Virtual COO TERA.
          </div>
        `;
        document.querySelector("#activeChatTitle").textContent = "Konsultan Bisnis AI (Virtual COO)";
      }
    } catch (err) {
      console.error("Gagal memuat sesi chat awal:", err);
    }
  }
  
  await loadAiInsights();
  aiLoaded = true;
}

async function loadAiInsights() {
  const container = document.querySelector("#aiInsightsContainer");
  if (!container) return;

  container.innerHTML = `
    <div style="text-align: center; padding: 24px; color: var(--muted); font-size: 13px;">
      <span class="spinner" style="display: inline-block; width: 16px; height: 16px; border: 2px solid var(--muted); border-top-color: transparent; border-radius: 50%; animation: spin 0.8s linear infinite; margin-right: 8px; vertical-align: middle;"></span>
      Sedang menganalisis kondisi bisnis...
    </div>
  `;

  try {
    const monthVal = document.querySelector("#aiAnalysisMonthSelect")?.value || "";
    const data = await api(`/api/ai/insights?month=${encodeURIComponent(monthVal)}`);
    if (data.insights) {
      let html = "";
      const lines = data.insights.split("\n");
      lines.forEach(line => {
        const trimmed = line.trim();
        if (trimmed.startsWith("* ") || trimmed.startsWith("- ")) {
          let text = trimmed.substring(2);
          text = text.replace(/\*\*(.*?)\*\*/g, "<strong>$1</strong>");

          let borderLeftColor = "var(--primary)";
          let icon = "💡";
          if (text.includes("[Stok]")) {
            borderLeftColor = "#f59e0b";
            icon = "📦";
          } else if (text.includes("[Keuangan]")) {
            borderLeftColor = "#10b981";
            icon = "💰";
          } else if (text.includes("[Pemasaran & Branding]") || text.includes("[Pemasaran]") || text.includes("[Branding]")) {
            borderLeftColor = "#6366f1";
            icon = "📢";
          }

          html += `
            <div style="background: var(--bg); border-left: 4px solid ${borderLeftColor}; padding: 12px 16px; border-radius: 0 8px 8px 0; font-size: 13px; line-height: 1.5; box-shadow: 0 1px 3px rgba(0,0,0,0.05); border: 1px solid var(--line); border-left-width: 4px; display: flex; gap: 10px; align-items: flex-start;">
              <span style="font-size: 16px; margin-top: 1px;">${icon}</span>
              <div>${text}</div>
            </div>
          `;
        }
      });
      container.innerHTML = html || `<div style="text-align:center; padding:16px; color:var(--muted);">Tidak ada rekomendasi baru saat ini.</div>`;
    } else {
      throw new Error("Format wawasan tidak valid");
    }
  } catch (error) {
    if (error.message && error.message.includes("GEMINI_API_KEY_MISSING")) {
      container.innerHTML = `
        <div style="background: #fef2f2; border: 1px solid #fee2e2; padding: 16px; border-radius: 8px; color: #991b1b; font-size: 13px; line-height: 1.5;">
          <h4 style="margin: 0 0 6px 0; font-weight: 700;">API Key Belum Dipasang</h4>
          Fitur AI Consultant memerlukan API Key Gemini gratis dari Google AI Studio. 
          Silakan tambahkan variabel lingkungan <strong>GEMINI_API_KEY</strong> pada platform hosting Anda (Vercel).
          <br/><br/>
          <a href="https://aistudio.google.com/" target="_blank" style="color: #b91c1c; font-weight: 600; text-decoration: underline;">Dapatkan API Key Gratis Di Sini ↗</a>
        </div>
      `;
    } else {
      container.innerHTML = `
        <div style="text-align: center; padding: 16px; color: #ef4444; font-size: 13px;">
          ❌ Gagal memuat analisis: ${error.message}
        </div>
      `;
    }
  }
}

async function sendAiChatMessage() {
  const inputEl = document.querySelector("#aiChatInput");
  const chatMessagesEl = document.querySelector("#aiChatMessages");
  const sendBtn = document.querySelector("#sendAiChatBtn");

  if (!inputEl || !chatMessagesEl || !inputEl.value.trim()) return;

  const userText = inputEl.value.trim();
  inputEl.value = "";

  if (!activeSessionId) {
    try {
      const title = userText.substring(0, 30) + (userText.length > 30 ? "..." : "");
      const session = await api("/api/ai/sessions", {
        method: "POST",
        body: JSON.stringify({ title })
      });
      activeSessionId = session.id;
      document.querySelector("#activeChatTitle").textContent = title;
      chatMessagesEl.innerHTML = "";
      await loadAiSessions();
    } catch (err) {
      toast("Gagal membuat obrolan baru: " + err.message);
      return;
    }
  }

  const userMsgHtml = `
    <div class="user-message" style="background: var(--primary); color: var(--panel); padding: 10px 14px; border-radius: 8px 8px 0 8px; max-width: 85%; align-self: flex-end; font-size: 13px; line-height: 1.5;">
      ${escapeHtml(userText)}
    </div>
  `;
  chatMessagesEl.insertAdjacentHTML("beforeend", userMsgHtml);
  chatMessagesEl.scrollTop = chatMessagesEl.scrollHeight;

  inputEl.disabled = true;
  if (sendBtn) {
    sendBtn.disabled = true;
    sendBtn.textContent = "...";
  }

  const typingId = "typing-" + Date.now();
  const typingHtml = `
    <div id="${typingId}" class="ai-message" style="background: var(--soft-primary); padding: 10px 14px; border-radius: 8px 8px 8px 0; max-width: 85%; align-self: flex-start; border: 1px solid var(--soft-secondary); display: flex; align-items: center; gap: 4px;">
      <span class="dot" style="width:6px; height:6px; background:var(--muted); border-radius:50%; animation: pulse 1s infinite alternate;"></span>
      <span class="dot" style="width:6px; height:6px; background:var(--muted); border-radius:50%; animation: pulse 1s infinite alternate; animation-delay: 0.2s;"></span>
      <span class="dot" style="width:6px; height:6px; background:var(--muted); border-radius:50%; animation: pulse 1s infinite alternate; animation-delay: 0.4s;"></span>
    </div>
  `;
  chatMessagesEl.insertAdjacentHTML("beforeend", typingHtml);
  chatMessagesEl.scrollTop = chatMessagesEl.scrollHeight;

  try {
    const data = await api("/api/ai/chat", {
      method: "POST",
      body: JSON.stringify({
        message: userText,
        sessionId: activeSessionId
      })
    });

    const typingIndicator = document.getElementById(typingId);
    if (typingIndicator) typingIndicator.remove();

    if (data.response) {
      let parsedResponse = parseMarkdown(data.response);

      const aiMsgHtml = `
        <div class="ai-message" style="background: var(--soft-primary); padding: 10px 14px; border-radius: 8px 8px 8px 0; max-width: 85%; align-self: flex-start; border: 1px solid var(--soft-secondary);">
          ${parsedResponse}
        </div>
      `;
      chatMessagesEl.insertAdjacentHTML("beforeend", aiMsgHtml);
      chatMessagesEl.scrollTop = chatMessagesEl.scrollHeight;
    } else {
      throw new Error("Respons AI kosong");
    }
  } catch (error) {
    const typingIndicator = document.getElementById(typingId);
    if (typingIndicator) typingIndicator.remove();

    let errMsg = `Gagal mendapatkan respon AI: ${error.message}`;
    if (error.message && error.message.includes("GEMINI_API_KEY_MISSING")) {
      errMsg = `API Key Gemini belum terpasang di Vercel. Silakan pasang <strong>GEMINI_API_KEY</strong> agar AI bisa merespons.`;
    }

    const errorMsgHtml = `
      <div class="ai-message error" style="background: #fef2f2; border: 1px solid #fee2e2; color: #991b1b; padding: 10px 14px; border-radius: 8px 8px 8px 0; max-width: 85%; align-self: flex-start;">
        ${errMsg}
      </div>
    `;
    chatMessagesEl.insertAdjacentHTML("beforeend", errorMsgHtml);
    chatMessagesEl.scrollTop = chatMessagesEl.scrollHeight;
  } finally {
    inputEl.disabled = false;
    if (sendBtn) {
      sendBtn.disabled = false;
      sendBtn.textContent = "Kirim";
    }
    inputEl.focus();
  }
}

function parseMarkdown(text) {
  let html = escapeHtml(text);

  // Parse headers: ### header, ## header, # header
  html = html.replace(/^### (.*?)$/gm, '<h3 style="margin-top: 12px; margin-bottom: 6px; font-size: 14px; font-weight: 700; color: var(--ink);">$1</h3>');
  html = html.replace(/^## (.*?)$/gm, '<h2 style="margin-top: 16px; margin-bottom: 8px; font-size: 16px; font-weight: 700; color: var(--ink);">$1</h2>');
  html = html.replace(/^# (.*?)$/gm, '<h1 style="margin-top: 20px; margin-bottom: 10px; font-size: 18px; font-weight: 700; color: var(--ink);">$1</h1>');

  // Parse bold: **text**
  html = html.replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>');

  // Parse italic: *text* or _text_
  html = html.replace(/\*(.*?)\*/g, '<em>$1</em>');
  html = html.replace(/_(.*?)_/g, '<em>$1</em>');

  // Parse bullet list items: - item or * item
  html = html.replace(/^[-*] (.*?)$/gm, '<li style="margin-left: 16px; margin-bottom: 4px; list-style-type: disc; display: list-item;">$1</li>');

  // Parse numbered list items: 1. item or 2. item
  html = html.replace(/^(\d+)\. (.*?)$/gm, '<li style="margin-left: 16px; margin-bottom: 4px; list-style-type: decimal; display: list-item;">$2</li>');

  // Replace remaining newlines with <br/>
  html = html.replace(/\n/g, '<br/>');

  // Cleanup: do not put duplicate <br/> before/after block elements to prevent large empty spaces
  html = html.replace(/(<\/h\d>)<br\/>/g, '$1');
  html = html.replace(/(<\/li>)<br\/>/g, '$1');
  html = html.replace(/<br\/>(<li>)/g, '$1');
  html = html.replace(/<br\/>(<h\d>)/g, '$1');

  return html;
}

function escapeHtml(text) {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

// AI Consultant Event Listeners
document.querySelector("#refreshInsightsBtn")?.addEventListener("click", () => {
  loadAiInsights().catch(e => console.error(e));
});

document.querySelector("#sendAiChatBtn")?.addEventListener("click", () => {
  sendAiChatMessage().catch(e => console.error(e));
});

document.querySelector("#aiChatInput")?.addEventListener("keydown", (event) => {
  if (event.key === "Enter") {
    sendAiChatMessage().catch(e => console.error(e));
  }
});

document.querySelector("#newAiChatBtn")?.addEventListener("click", () => {
  startNewAiChat().catch(e => console.error(e));
});

document.querySelector("#aiAnalysisMonthSelect")?.addEventListener("change", () => {
  loadAiInsights().catch(e => console.error(e));
});

document.querySelector("#aiChatSessionsList")?.addEventListener("click", (e) => {
  const deleteBtn = e.target.closest(".delete-session-btn");
  const sessionItem = e.target.closest(".session-item");
  if (deleteBtn) {
    e.stopPropagation();
    const id = Number(deleteBtn.dataset.id);
    deleteAiSession(id).catch(e => console.error(e));
  } else if (sessionItem) {
    const id = Number(sessionItem.dataset.id);
    selectAiSession(id).catch(e => console.error(e));
  }
});
