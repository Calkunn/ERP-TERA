import test from "node:test";
import assert from "node:assert/strict";
import { extractReply, mergeExtraction } from "./extraction.mjs";

test("partial supplier update preserves prior ETA and progress", () => {
  const previous = extractReply("Progres 80%. Estimasi selesai 25 Oktober 2026. Tidak ada kendala.");
  const current = extractReply("untuk sekian progress sedang pemotongan kain");
  const merged = mergeExtraction(previous, current);

  assert.equal(merged.reported_progress_percent, 80);
  assert.equal(merged.reported_stage, "Cutting");
  assert.equal(merged.reported_eta, "2026-10-25");
  assert.equal(merged.deadline_confirmation, null);
  assert.deepEqual(merged.blockers, ["Keterlambatan pasokan kain"]);
});
