// Supplier Intelligence Migrations
// SQLite-compatible: per-statement, no IF NOT EXISTS on ALTER, handle errors per-column
export async function runMigrations(db) {
  // 1. suppliers: phone_number
  try {
    await db.exec("ALTER TABLE suppliers ADD COLUMN phone_number VARCHAR(20)");
  } catch (e) {
    if (!e.message.includes("duplicate column name") && !e.message.includes("already exists")) throw e;
  }

  // 2. suppliers: whatsapp_status
  try {
    await db.exec("ALTER TABLE suppliers ADD COLUMN whatsapp_status TEXT DEFAULT 'unverified'");
  } catch (e) {
    if (!e.message.includes("duplicate column name") && !e.message.includes("already exists")) throw e;
  }

  // 3. suppliers: contact_person
  try {
    await db.exec("ALTER TABLE suppliers ADD COLUMN contact_person VARCHAR(255)");
  } catch (e) {
    if (!e.message.includes("duplicate column name") && !e.message.includes("already exists")) throw e;
  }

  // 4. production_batches: supplier_id FK
  try {
    await db.exec("ALTER TABLE production_batches ADD COLUMN supplier_id INTEGER REFERENCES suppliers(id) ON DELETE SET NULL");
  } catch (e) {
    if (!e.message.includes("duplicate column name") && !e.message.includes("already exists")) throw e;
  }

  // 5. communication_logs table
  try {
    await db.exec(`
      CREATE TABLE IF NOT EXISTS communication_logs (
        id TEXT PRIMARY KEY,
        batch_id INTEGER NOT NULL REFERENCES production_batches(id) ON DELETE CASCADE,
        supplier_id INTEGER NOT NULL REFERENCES suppliers(id) ON DELETE CASCADE,
        direction TEXT NOT NULL CHECK(direction IN ('OUTBOUND', 'INBOUND')),
        raw_content TEXT NOT NULL,
        provider_message_id VARCHAR(255),
        created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
      )
    `);
    await db.exec("CREATE INDEX IF NOT EXISTS idx_comm_batch ON communication_logs(batch_id)");
    await db.exec("CREATE INDEX IF NOT EXISTS idx_comm_supplier ON communication_logs(supplier_id)");
  } catch (e) {
    if (!e.message.includes("table already exists") && !e.message.includes("duplicate table")) throw e;
  }

  // 6. progress_reports table
  try {
    await db.exec(`
      CREATE TABLE IF NOT EXISTS progress_reports (
        id TEXT PRIMARY KEY,
        batch_id INTEGER NOT NULL REFERENCES production_batches(id) ON DELETE CASCADE,
        supplier_id INTEGER NOT NULL REFERENCES suppliers(id) ON DELETE CASCADE,
        reported_progress_percent INTEGER,
        reported_eta TEXT,
        blockers TEXT,
        confidence_score FLOAT,
        verification_status TEXT DEFAULT 'PENDING' CHECK(verification_status IN ('PENDING', 'VERIFIED', 'REJECTED')),
        created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
      )
    `);
    await db.exec("CREATE INDEX IF NOT EXISTS idx_progress_batch ON progress_reports(batch_id)");
    await db.exec("CREATE INDEX IF NOT EXISTS idx_progress_supplier ON progress_reports(supplier_id)");
  } catch (e) {
    if (!e.message.includes("table already exists") && !e.message.includes("duplicate table")) throw e;
  }

  // 7. risk_assessments table
  try {
    await db.exec(`
      CREATE TABLE IF NOT EXISTS risk_assessments (
        id TEXT PRIMARY KEY,
        batch_id INTEGER NOT NULL REFERENCES production_batches(id) ON DELETE CASCADE,
        supplier_id INTEGER NOT NULL REFERENCES suppliers(id) ON DELETE CASCADE,
        risk_score INTEGER CHECK(risk_score >= 0 AND risk_score <= 100),
        risk_level TEXT CHECK(risk_level IN ('LOW', 'MEDIUM', 'HIGH')),
        risk_reasons TEXT,
        ai_analysis_summary TEXT,
        created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
      )
    `);
    await db.exec("CREATE INDEX IF NOT EXISTS idx_risk_batch ON risk_assessments(batch_id)");
    await db.exec("CREATE INDEX IF NOT EXISTS idx_risk_supplier ON risk_assessments(supplier_id)");
  } catch (e) {
    if (!e.message.includes("table already exists") && !e.message.includes("duplicate table")) throw e;
  }

  // 8. Add extraction cache and immutable analysis history fields
  for (const [table, column, type] of [
    ["communication_logs", "extraction_json", "TEXT"],
    ["risk_assessments", "source_message_id", "TEXT"],
    ["risk_assessments", "chat_summary", "TEXT"],
    ["progress_reports", "reported_stage", "TEXT"],
    ["progress_reports", "deadline_confirmation", "INTEGER"],
    ["progress_reports", "needs_human_review", "INTEGER"]
  ]) {
    try {
      await db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}`);
    } catch (e) {
      if (!e.message.includes("duplicate column name") && !e.message.includes("already exists")) throw e;
    }
  }

  try {
    await db.exec("CREATE INDEX IF NOT EXISTS idx_risk_source_message ON risk_assessments(source_message_id)");
  } catch (e) {
    if (!e.message.includes("already exists")) throw e;
  }
}