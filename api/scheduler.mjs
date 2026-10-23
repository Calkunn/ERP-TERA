// Scheduler for TERA Supplier Intelligence
// Complies with FR-02: scans batches due within 3 days, enforces idempotency

export async function runProgressInquiryScheduler(db, now = new Date()) {
  const targetDate = new Date(now);
  const nowIso = targetDate.toISOString().split("T")[0];

  // Target H-3: batch with due_date within next 3 days
  const hPlus3Date = new Date(targetDate);
  hPlus3Date.setDate(hPlus3Date.getDate() + 3);
  const hPlus3Iso = hPlus3Date.toISOString().split("T")[0];

  // Batches that are 'Sedang Diproses', have a supplier, and due_date <= H+3
  const dueBatches = await db.prepare(`
    SELECT pb.id, pb.batch_no, pb.due_date, pb.supplier_id, s.name as supplier_name, s.phone_number
    FROM production_batches pb
    JOIN suppliers s ON s.id = pb.supplier_id
    WHERE pb.status = 'Sedang Diproses'
      AND pb.due_date <= ?
      AND pb.due_date >= ?
  `).all(hPlus3Iso, nowIso);

  const results = [];

  for (const batch of dueBatches) {
    // Idempotency: check if outbound inquiry already sent today
    const existingLog = await db.prepare(`
      SELECT id FROM communication_logs
      WHERE batch_id = ?
        AND direction = 'OUTBOUND'
        AND created_at >= ?
      LIMIT 1
    `).get(batch.id, `${nowIso} 00:00:00`);

    if (existingLog) {
      results.push({ batchId: batch.id, batchNo: batch.batch_no, status: "SKIPPED_ALREADY_SENT" });
      continue;
    }

    // In MVP: Send simulated message (Phase 5 will call Meta WhatsApp API)
    const logId = "comm_" + Math.random().toString(36).substring(2, 10);
    const messageContent = `Halo ${batch.supplier_name}, ini pesan otomatis dari TERA. Mengingatkan bahwa Batch ${batch.batch_no} memiliki tenggat waktu ${batch.due_date}. Mohon berikan update progres pengerjaan dan apakah terdapat kendala produksi. Terima kasih!`;

    await db.prepare(`
      INSERT INTO communication_logs (id, batch_id, supplier_id, direction, raw_content, provider_message_id)
      VALUES (?, ?, ?, 'OUTBOUND', ?, ?)
    `).run(logId, batch.id, batch.supplier_id, messageContent, `simulated_${Date.now()}`);

    results.push({ batchId: batch.id, batchNo: batch.batch_no, status: "SENT_SIMULATED", logId });
  }

  return results;
}
