import test from "node:test";
import assert from "node:assert/strict";
import { computeRiskAssessment } from "./risk-engine.mjs";
import { mergeExtraction } from "./extraction.mjs";

test("Risk Engine: Scenario PRD §2.2 (Reported ETA > Deadline + Blocker -> HIGH)", () => {
  const result = computeRiskAssessment({
    dueDate: "2026-10-24",
    batchStatus: "Sedang Diproses",
    stages: { cutting: 60, sewing: 0, finishing: 0 },
    latestReport: {
      reported_progress_percent: 60,
      reported_eta: "2026-10-27",
      blockers: ["Keterlambatan pasokan kain"],
      verification_status: "PENDING"
    },
    now: new Date("2026-10-21T09:00:00Z")
  });

  assert.equal(result.risk_level, "HIGH");
  assert.ok(result.risk_score >= 50, `Expected score >= 50, got ${result.risk_score}`);

  const reasons = JSON.parse(result.risk_reasons);
  assert.ok(reasons.some(r => r.includes("melewati agreed deadline")));
  assert.ok(reasons.some(r => r.includes("Keterlambatan pasokan kain")));
});

test("Risk Engine: On-track batch with no blockers -> LOW", () => {
  const result = computeRiskAssessment({
    dueDate: "2026-10-30",
    batchStatus: "Sedang Diproses",
    stages: { cutting: 80, sewing: 70, finishing: 60 },
    latestReport: {
      reported_progress_percent: 70,
      reported_eta: "2026-10-29",
      blockers: [],
      verification_status: "VERIFIED"
    },
    now: new Date("2026-10-21T09:00:00Z")
  });

  assert.equal(result.risk_level, "LOW");
  assert.ok(result.risk_score < 25);
});

test("Risk Engine: Unresponsive supplier after H-3 inquiry -> HIGH", () => {
  const result = computeRiskAssessment({
    dueDate: "2026-10-24",
    batchStatus: "Sedang Diproses",
    stages: { cutting: 20, sewing: 0, finishing: 0 },
    latestReport: null,
    inquirySentAt: "2026-10-21T00:00:00Z",
    now: new Date("2026-10-23T00:00:00Z") // 48 hours later
  });

  assert.equal(result.risk_level, "HIGH");
  assert.ok(result.risk_score >= 50);
});

test("Risk Engine: Completed batch -> LOW risk 0 score", () => {
  const result = computeRiskAssessment({
    dueDate: "2026-10-15",
    batchStatus: "Selesai"
  });

  assert.equal(result.risk_score, 0);
  assert.equal(result.risk_level, "LOW");
});
