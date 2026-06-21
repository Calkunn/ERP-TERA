const rupiah = new Intl.NumberFormat("id-ID", { style: "currency", currency: "IDR", maximumFractionDigits: 0 });
const number = new Intl.NumberFormat("id-ID");

const titles = {
  dashboard: ["Dashboard", "Track penjualan, distribusi stock, dan sisa stock artikel TERA."],
  products: ["Artikel & Stock", "Tambah artikel, cek sisa stock, terima stock, dan transfer antar inventory."],
  inventori: ["Inventori", "Kelola transfer stock dan lihat riwayat pergerakan inventory."],
  pembelian: ["Pembelian & PO", "Kelola purchase order dan database supplier."],
  produksi: ["Produksi", "Kelola batch produksi (cutting, sewing, finishing)."],
  penjualan: ["Penjualan", "Input pendapatan online/offline bulanan dan detail artikel terjual."],
  keuangan: ["Keuangan", "Buku kas ledger keuangan, cashflow 12 bulan, dan laba rugi bulanan."],
  laporan: ["Laporan", "Ringkasan revenue, COGS, gross profit, dan margin SKU."],
  pengaturan: ["Pengaturan", "Informasi sistem dan konfigurasi server ERP."]
};

let authToken = localStorage.getItem("tera_token") || "";
let currentUser = JSON.parse(localStorage.getItem("tera_user") || "null");
let productRows = [];
let monthlyRevenueRows = [];

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
          ${isOngoing ? `<button class="mini edit-progress-btn" data-id="${b.id}" data-no="${b.batch_no}" data-cutting="${b.cutting_progress}" data-sewing="${b.sewing_progress}" data-finishing="${b.finishing_progress}" type="button">Update Progress</button>` : ''}
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

  // Filter out completed and canceled POs (only show ongoing POs)
  const activePos = pos.filter(r => r.status !== 'Selesai' && r.status !== 'Dibatalkan');
  const shippedPos = activePos.filter(r => r.status === 'Dikirim');
  const totalExpenses = activePos.reduce((sum, r) => sum + Number(r.total_amount || 0), 0);

  document.querySelector("#totalActivePos").textContent = activePos.length;
  document.querySelector("#totalShippedPos").textContent = shippedPos.length;
  document.querySelector("#totalPoExpenses").textContent = rupiah.format(totalExpenses);

  const purchaseOrderList = document.querySelector("#purchaseOrderList");
  if (!activePos.length) {
    purchaseOrderList.innerHTML = `<div class="panel" style="padding:24px; grid-column:1/-1; text-align:center; color:var(--muted); font-weight:700;">Belum ada purchase order aktif.</div>`;
  } else {
    purchaseOrderList.innerHTML = activePos.map(r => {
      const itemsHtml = r.items.map(it => {
        const spec = [it.sku, it.size && it.color ? `${it.size}/${it.color}` : ""].filter(Boolean).join(" - ");
        const specText = spec ? ` (${spec})` : "";
        return `
          <div class="po-card-item">
            <span class="po-card-item-name">${it.product_name}${specText}</span>
            <span>x${it.qty}</span>
          </div>
        `;
      }).join("");

      let badgeClass = 'warn';
      if (r.status === 'Dikirim') badgeClass = 'marketplace';
      if (r.status === 'Diterima Sebagian') badgeClass = 'offline';

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
          <div class="po-card-footer">
            <div class="po-card-total">
              <span>Total Pengeluaran</span>
              <strong>${rupiah.format(r.total_amount)}</strong>
            </div>
            <button class="po-card-btn mark-po-complete-btn" data-id="${r.id}" data-no="${r.po_no}" type="button">
              ✓ Selesai
            </button>
          </div>
        </article>
      `;
    }).join("");
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
  
  const variantOptions = data.variants.map((v) => `<option value="${v.variant_id}">${v.sku} - ${v.name} (${v.size}/${v.color})</option>`).join("");
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
      select.innerHTML = data.variants.map((v) => `<option value="${v.variant_id}">${v.sku} - ${v.name}</option>`).join("");
      if (currentVal && data.variants.some(v => String(v.variant_id) === String(currentVal))) {
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
    loadKeuangan()
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
      else if (viewId === "keuangan") loadKeuangan().catch(e => console.error(e));
      else if (viewId === "laporan") loadReports().catch(e => console.error(e));
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

// Listen products table click to open Detail Drawer
document.querySelector("#productsTable").addEventListener("click", (event) => {
  const button = event.target.closest(".open-product");
  if (!button) return;
  const row = productRows.find((item) => String(item.variant_id) === button.dataset.id);
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
});

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
    <div style="display:flex; flex-direction:column; gap:4px;">
      <label style="font-size:11px; font-weight:700; color:var(--muted);">Bahan Baku / Aksesoris (BOM)</label>
      <input name="materialName" list="materialOptions" placeholder="Ketik nama bahan/aksesoris..." required autocomplete="off">
    </div>
    <div style="display:flex; flex-direction:column; gap:4px;">
      <label style="font-size:11px; font-weight:700; color:var(--muted);">Qty</label>
      <input name="qty" type="number" min="1" value="1" placeholder="Qty" required>
    </div>
    <div style="display:flex; flex-direction:column; gap:4px;">
      <label style="font-size:11px; font-weight:700; color:var(--muted);">Harga Satuan (Rp)</label>
      <input name="costPrice" type="number" min="0" value="0" placeholder="Harga Satuan" required>
    </div>
    <div style="display:flex; flex-direction:column; gap:4px;">
      <label style="font-size:11px; font-weight:700; color:var(--muted);">Harga Total (Rp)</label>
      <input name="totalPrice" type="number" min="0" value="0" placeholder="Harga Total" required>
    </div>
    <button class="mini danger remove-po-row" type="button" title="Hapus baris" style="margin-top:20px;">×</button>
  `;

  const qtyInput = row.querySelector('[name="qty"]');
  const unitPriceInput = row.querySelector('[name="costPrice"]');
  const totalPriceInput = row.querySelector('[name="totalPrice"]');
  
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
  
  document.querySelector("#poDialog").showModal();
});

// Save PO
document.querySelector("#newPoForm").addEventListener("submit", async (event) => {
  event.preventDefault();
  const data = formData(event.target);
  
  const items = [...document.querySelectorAll("#poItemRows .item-row")].map(row => ({
    materialName: row.querySelector('[name="materialName"]').value,
    qty: Number(row.querySelector('[name="qty"]').value),
    costPrice: Number(row.querySelector('[name="costPrice"]').value)
  }));
  
  try {
    await api("/api/purchase-orders", {
      method: "POST",
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
    toast("Purchase Order berhasil disimpan.");
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

// Mark PO Complete/Cancel/Delete Event Listener
document.querySelector("#purchaseOrderList").addEventListener("click", async (event) => {
  const completeBtn = event.target.closest(".mark-po-complete-btn");
  const cancelBtn = event.target.closest(".cancel-po-btn");
  const deleteBtn = event.target.closest(".delete-po-btn");
  
  if (completeBtn) {
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
});



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
  const data = await api("/api/options");
  const uniqueProducts = [];
  const seenIds = new Set();
  data.variants.forEach(row => {
    const isMaterial = row.category === "Bahan Baku" || row.category === "Aksesoris";
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
    const isMaterial = row.category === "Bahan Baku" || row.category === "Aksesoris";
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
    await api("/api/production/batches", {
      method: "POST",
      body: JSON.stringify({
        batchNo: data.batchNo,
        batchType: data.batchType,
        dueDate: data.dueDate,
        items
      })
    });
    document.querySelector("#batchDialog").close();
    event.target.reset();
    toast("Batch produksi berhasil dibuat.");
    await refreshAll();
  } catch (err) {
    toast("Gagal membuat batch: " + err.message);
  }
});

// Listen batch list clicks for updating progress, cancelling, and deleting
const handleBatchClick = async (event) => {
  const editBtn = event.target.closest(".edit-progress-btn");
  const cancelBtn = event.target.closest(".cancel-batch-btn");
  const deleteBtn = event.target.closest(".delete-batch-btn");
  
  if (editBtn) {
    const form = document.querySelector("#updateProgressForm");
    form.batchId.value = editBtn.dataset.id;
    document.querySelector("#progressBatchTitle").textContent = `Batch: ${editBtn.dataset.no}`;
    form.cuttingProgress.value = editBtn.dataset.cutting;
    form.sewingProgress.value = editBtn.dataset.sewing;
    form.finishingProgress.value = editBtn.dataset.finishing;
    
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
  const variants = productRows.length ? productRows : [];
  const row = document.createElement("div");
  row.className = "item-row";
  row.innerHTML = `
    <select name="variantId" required>
      ${variants.map((v) => `<option value="${v.variant_id}" ${String(item.variant_id || item.variantId || "") === String(v.variant_id) ? "selected" : ""}>${v.sku} - ${v.name}</option>`).join("")}
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

// Add variant
document.querySelector("#productForm").addEventListener("submit", async (event) => {
  event.preventDefault();
  try {
    await api("/api/products", { method: "POST", body: JSON.stringify(formData(event.target)) });
    event.target.reset();
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

  const szPart = size.trim().toUpperCase().replace(/\s+/g, "");

  return ["TERA", namePart, catPart, colPart, szPart].filter(Boolean).join("-");
}

document.querySelector("#productForm").addEventListener("input", (event) => {
  const form = event.currentTarget;

  // Auto-generate SKU
  const name = form.name.value;
  const category = form.category.value;
  const size = form.size.value;
  const color = form.color.value;
  if (form.sku && ["name", "category", "size", "color"].includes(event.target.name)) {
    form.sku.value = generateSku(name, category, size, color);
  }
});

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
    form.offlineRevenue.value = row.offline_revenue;
    form.onlineNotes.value = row.online_notes || "";
    form.offlineNotes.value = row.offline_notes || "";
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
