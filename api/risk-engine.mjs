// Deterministic Risk Engine for TERA Supplier Intelligence
// Complies with FR-05: strictly deterministic, 0-100 score, AI cannot override.

export function computeRiskAssessment({
  dueDate,
  batchStatus = "Sedang Diproses",
  stages = { cutting: 0, sewing: 0, finishing: 0 },
  latestReport = null,
  inquirySentAt = null,
  now = new Date()
}) {
  const reasons = [];
  let score = 0;

  // 1. Finished batch: zero risk
  if (batchStatus === "Selesai") {
    return {
      risk_score: 0,
      risk_level: "LOW",
      risk_reasons: JSON.stringify(["Batch sudah selesai."])
    };
  }

  const nowDate = new Date(now);
  const deadlineDate = new Date(dueDate);
  const isPastDeadline = nowDate > deadlineDate;

  // 2. Verified progress (average of 3 stages)
  const cutting = Number(stages.cutting || 0);
  const sewing = Number(stages.sewing || 0);
  const finishing = Number(stages.finishing || 0);
  const verifiedProgress = Math.round((cutting + sewing + finishing) / 3);

  // 3. Evaluate latest report from supplier
  if (latestReport) {
    const reportedEta = latestReport.reported_eta ? new Date(latestReport.reported_eta) : null;

    // Reported ETA exceeds agreed deadline -> instant HIGH risk trigger (+50)
    if (reportedEta && reportedEta > deadlineDate) {
      score += 50;
      reasons.push(`Reported ETA (${latestReport.reported_eta}) melewati agreed deadline (${dueDate}).`);
    }

    // Blockers handling (+10 per blocker, max 30)
    let blockers = [];
    if (latestReport.blockers) {
      if (Array.isArray(latestReport.blockers)) {
        blockers = latestReport.blockers;
      } else if (typeof latestReport.blockers === "string") {
        try {
          const parsed = JSON.parse(latestReport.blockers);
          if (Array.isArray(parsed)) blockers = parsed;
        } catch (_) {
          if (latestReport.blockers.trim()) blockers = [latestReport.blockers.trim()];
        }
      }
    }

    if (blockers.length > 0) {
      const blockerScore = Math.min(blockers.length * 10, 30);
      score += blockerScore;
      reasons.push(`Terdapat ${blockers.length} kendala dilaporkan: ${blockers.join(", ")}.`);
    }

    // Progress comparison: reported vs verified
    if (latestReport.verification_status === "PENDING") {
      score += 5;
      reasons.push("Laporan progres terbaru masih berstatus PENDING verifikasi.");
    }
  } else if (inquirySentAt) {
    // Inquiry sent but no reply received
    const sentDate = new Date(inquirySentAt);
    const hoursSinceInquiry = (nowDate - sentDate) / (1000 * 60 * 60);

    if (hoursSinceInquiry >= 24) {
      score += 40;
      reasons.push(`Supplier belum merespons permintaan progres selama >${Math.floor(hoursSinceInquiry / 24)} hari.`);
    } else {
      score += 15;
      reasons.push("Menunggu respons dari supplier.");
    }
  }

  // 4. Progress gap check against deadline proximity
  const msRemaining = deadlineDate - nowDate;
  const daysRemaining = msRemaining / (1000 * 60 * 60 * 24);

  if (daysRemaining <= 0 && verifiedProgress < 100) {
    score += 40;
    reasons.push(`Melewati deadline dengan progres terverifikasi ${verifiedProgress}%.`);
  } else if (daysRemaining <= 3 && verifiedProgress < 70) {
    score += 25;
    reasons.push(`Kurang dari 3 hari sebelum deadline namun progres baru ${verifiedProgress}%.`);
  } else if (daysRemaining <= 7 && verifiedProgress < 40) {
    score += 15;
    reasons.push(`Sisa waktu ${Math.ceil(daysRemaining)} hari dengan progres ${verifiedProgress}%.`);
  }

  // Clamp 0 - 100
  const finalScore = Math.min(Math.max(score, 0), 100);

  // Band classification according to FR-05
  let level = "LOW";
  if (finalScore >= 50) {
    level = "HIGH";
  } else if (finalScore >= 25) {
    level = "MEDIUM";
  }

  if (reasons.length === 0) {
    reasons.push("Progres produksi sesuai target, tidak ditemukan kendala berisiko.");
  }

  return {
    risk_score: finalScore,
    risk_level: level,
    risk_reasons: JSON.stringify(reasons)
  };
}
