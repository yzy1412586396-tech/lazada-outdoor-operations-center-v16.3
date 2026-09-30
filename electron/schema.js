'use strict';

const LATEST_SCHEMA_VERSION = 5;

const migrations = [
  {
    version: 1,
    name: 'legacy-desktop-storage',
    sql: `
      CREATE TABLE IF NOT EXISTS app_meta (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS browser_storage (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS uploaded_files (
        slot TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        mime_type TEXT NOT NULL DEFAULT '',
        last_modified INTEGER NOT NULL DEFAULT 0,
        content BLOB NOT NULL,
        size INTEGER NOT NULL,
        updated_at TEXT NOT NULL
      );
    `,
  },
  {
    version: 2,
    name: 'business-ai-history-and-backups',
    sql: `
      CREATE TABLE IF NOT EXISTS schema_migrations (
        version INTEGER PRIMARY KEY,
        name TEXT NOT NULL,
        applied_at TEXT NOT NULL,
        success INTEGER NOT NULL DEFAULT 1,
        error_message TEXT NOT NULL DEFAULT ''
      );
      CREATE TABLE IF NOT EXISTS app_settings (
        key TEXT PRIMARY KEY,
        value_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS countries (
        id TEXT PRIMARY KEY,
        code TEXT NOT NULL UNIQUE,
        name TEXT NOT NULL,
        active INTEGER NOT NULL DEFAULT 1,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS stores (
        id TEXT PRIMARY KEY,
        country_id TEXT NOT NULL REFERENCES countries(id),
        external_id TEXT NOT NULL,
        name TEXT NOT NULL,
        active INTEGER NOT NULL DEFAULT 1,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE(country_id, external_id)
      );
      CREATE TABLE IF NOT EXISTS business_databases (
        id TEXT PRIMARY KEY,
        country_id TEXT REFERENCES countries(id),
        external_id TEXT NOT NULL,
        name TEXT NOT NULL,
        active INTEGER NOT NULL DEFAULT 1,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE(country_id, external_id)
      );
      CREATE TABLE IF NOT EXISTS source_file_metadata (
        id TEXT PRIMARY KEY,
        original_name TEXT NOT NULL,
        file_hash TEXT NOT NULL,
        file_size INTEGER NOT NULL DEFAULT 0,
        mime_type TEXT NOT NULL DEFAULT '',
        source_type TEXT NOT NULL DEFAULT '',
        archive_path TEXT NOT NULL DEFAULT '',
        imported_at TEXT NOT NULL,
        created_at TEXT NOT NULL,
        UNIQUE(file_hash, source_type)
      );
      CREATE TABLE IF NOT EXISTS import_batches (
        id TEXT PRIMARY KEY,
        module TEXT NOT NULL,
        country_code TEXT NOT NULL DEFAULT '',
        store_id TEXT REFERENCES stores(id),
        business_database_id TEXT REFERENCES business_databases(id),
        source_file_id TEXT REFERENCES source_file_metadata(id),
        file_hash TEXT NOT NULL DEFAULT '',
        row_count INTEGER NOT NULL DEFAULT 0,
        status TEXT NOT NULL,
        dedupe_hash TEXT NOT NULL UNIQUE,
        started_at TEXT NOT NULL,
        completed_at TEXT NOT NULL DEFAULT '',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_import_batches_scope ON import_batches(module, country_code, store_id, completed_at);

      CREATE TABLE IF NOT EXISTS daily_report_history (
        id TEXT PRIMARY KEY, batch_id TEXT REFERENCES import_batches(id), country_code TEXT NOT NULL DEFAULT '',
        store_id TEXT REFERENCES stores(id), business_database_id TEXT REFERENCES business_databases(id),
        business_date TEXT NOT NULL DEFAULT '', module TEXT NOT NULL DEFAULT 'daily_report', version_no INTEGER NOT NULL DEFAULT 1,
        payload_json TEXT NOT NULL, source_hash TEXT NOT NULL DEFAULT '', dedupe_hash TEXT NOT NULL UNIQUE,
        created_at TEXT NOT NULL, updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS inventory_history (
        id TEXT PRIMARY KEY, batch_id TEXT REFERENCES import_batches(id), country_code TEXT NOT NULL DEFAULT '',
        store_id TEXT REFERENCES stores(id), business_database_id TEXT REFERENCES business_databases(id),
        business_date TEXT NOT NULL DEFAULT '', module TEXT NOT NULL DEFAULT 'inventory', version_no INTEGER NOT NULL DEFAULT 1,
        payload_json TEXT NOT NULL, source_hash TEXT NOT NULL DEFAULT '', dedupe_hash TEXT NOT NULL UNIQUE,
        created_at TEXT NOT NULL, updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS activity_price_history (
        id TEXT PRIMARY KEY, batch_id TEXT REFERENCES import_batches(id), country_code TEXT NOT NULL DEFAULT '',
        store_id TEXT REFERENCES stores(id), business_database_id TEXT REFERENCES business_databases(id),
        business_date TEXT NOT NULL DEFAULT '', module TEXT NOT NULL DEFAULT 'activity_price', version_no INTEGER NOT NULL DEFAULT 1,
        payload_json TEXT NOT NULL, source_hash TEXT NOT NULL DEFAULT '', dedupe_hash TEXT NOT NULL UNIQUE,
        created_at TEXT NOT NULL, updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS repricing_history (
        id TEXT PRIMARY KEY, batch_id TEXT REFERENCES import_batches(id), country_code TEXT NOT NULL DEFAULT '',
        store_id TEXT REFERENCES stores(id), business_database_id TEXT REFERENCES business_databases(id),
        business_date TEXT NOT NULL DEFAULT '', module TEXT NOT NULL DEFAULT 'repricing', version_no INTEGER NOT NULL DEFAULT 1,
        payload_json TEXT NOT NULL, source_hash TEXT NOT NULL DEFAULT '', dedupe_hash TEXT NOT NULL UNIQUE,
        created_at TEXT NOT NULL, updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS expense_history (
        id TEXT PRIMARY KEY, batch_id TEXT REFERENCES import_batches(id), country_code TEXT NOT NULL DEFAULT '',
        store_id TEXT REFERENCES stores(id), business_database_id TEXT REFERENCES business_databases(id),
        business_date TEXT NOT NULL DEFAULT '', module TEXT NOT NULL DEFAULT 'expense', version_no INTEGER NOT NULL DEFAULT 1,
        payload_json TEXT NOT NULL, source_hash TEXT NOT NULL DEFAULT '', dedupe_hash TEXT NOT NULL UNIQUE,
        created_at TEXT NOT NULL, updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS sku_history (
        id TEXT PRIMARY KEY, batch_id TEXT REFERENCES import_batches(id), country_code TEXT NOT NULL DEFAULT '',
        store_id TEXT REFERENCES stores(id), business_database_id TEXT REFERENCES business_databases(id), sku TEXT NOT NULL,
        business_date TEXT NOT NULL DEFAULT '', module TEXT NOT NULL DEFAULT 'sku', version_no INTEGER NOT NULL DEFAULT 1,
        payload_json TEXT NOT NULL, source_hash TEXT NOT NULL DEFAULT '', dedupe_hash TEXT NOT NULL UNIQUE,
        created_at TEXT NOT NULL, updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS anomaly_history (
        id TEXT PRIMARY KEY, batch_id TEXT REFERENCES import_batches(id), country_code TEXT NOT NULL DEFAULT '',
        store_id TEXT REFERENCES stores(id), business_database_id TEXT REFERENCES business_databases(id),
        business_date TEXT NOT NULL DEFAULT '', module TEXT NOT NULL, anomaly_type TEXT NOT NULL, severity TEXT NOT NULL DEFAULT 'info',
        payload_json TEXT NOT NULL, source_hash TEXT NOT NULL DEFAULT '', dedupe_hash TEXT NOT NULL UNIQUE,
        created_at TEXT NOT NULL, updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS rule_versions (
        id TEXT PRIMARY KEY, country_code TEXT NOT NULL DEFAULT '', store_id TEXT REFERENCES stores(id),
        business_database_id TEXT REFERENCES business_databases(id), module TEXT NOT NULL, version_no INTEGER NOT NULL DEFAULT 1,
        title TEXT NOT NULL, rules_json TEXT NOT NULL, source TEXT NOT NULL DEFAULT '', dedupe_hash TEXT NOT NULL UNIQUE,
        created_at TEXT NOT NULL, updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS operation_logs (
        id TEXT PRIMARY KEY, country_code TEXT NOT NULL DEFAULT '', store_id TEXT REFERENCES stores(id),
        business_database_id TEXT REFERENCES business_databases(id), module TEXT NOT NULL, action TEXT NOT NULL,
        status TEXT NOT NULL, summary TEXT NOT NULL DEFAULT '', payload_json TEXT NOT NULL DEFAULT '{}',
        dedupe_hash TEXT NOT NULL UNIQUE, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_daily_report_scope ON daily_report_history(country_code, store_id, business_date, created_at);
      CREATE INDEX IF NOT EXISTS idx_inventory_scope ON inventory_history(country_code, store_id, business_date, created_at);
      CREATE INDEX IF NOT EXISTS idx_activity_scope ON activity_price_history(country_code, store_id, business_date, created_at);
      CREATE INDEX IF NOT EXISTS idx_repricing_scope ON repricing_history(country_code, store_id, business_date, created_at);
      CREATE INDEX IF NOT EXISTS idx_expense_scope ON expense_history(country_code, store_id, business_date, created_at);
      CREATE INDEX IF NOT EXISTS idx_sku_scope ON sku_history(country_code, store_id, sku, business_date);
      CREATE INDEX IF NOT EXISTS idx_anomaly_scope ON anomaly_history(module, country_code, store_id, business_date, severity);
      CREATE INDEX IF NOT EXISTS idx_operation_scope ON operation_logs(module, country_code, store_id, created_at);

      CREATE TABLE IF NOT EXISTS ai_provider_configs (
        provider_id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        base_url TEXT NOT NULL,
        model_name TEXT NOT NULL,
        max_input_tokens INTEGER NOT NULL DEFAULT 16000,
        max_output_tokens INTEGER NOT NULL DEFAULT 1200,
        timeout_ms INTEGER NOT NULL DEFAULT 60000,
        stream_enabled INTEGER NOT NULL DEFAULT 1,
        enabled INTEGER NOT NULL DEFAULT 0,
        input_cost_per_million REAL NOT NULL DEFAULT 0,
        output_cost_per_million REAL NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS ai_chat_sessions (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        provider_id TEXT NOT NULL,
        model_name TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS ai_chat_messages (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL REFERENCES ai_chat_sessions(id) ON DELETE CASCADE,
        role TEXT NOT NULL CHECK(role IN ('user','assistant','system')),
        content TEXT NOT NULL,
        request_status TEXT NOT NULL DEFAULT 'complete',
        error_type TEXT NOT NULL DEFAULT '',
        input_tokens INTEGER NOT NULL DEFAULT 0,
        output_tokens INTEGER NOT NULL DEFAULT 0,
        estimated_cost REAL NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_ai_messages_session ON ai_chat_messages(session_id, created_at);
      CREATE TABLE IF NOT EXISTS ai_analysis_runs (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL REFERENCES ai_chat_sessions(id) ON DELETE CASCADE,
        user_message_id TEXT REFERENCES ai_chat_messages(id) ON DELETE SET NULL,
        assistant_message_id TEXT REFERENCES ai_chat_messages(id) ON DELETE SET NULL,
        provider_id TEXT NOT NULL,
        model_name TEXT NOT NULL,
        request_status TEXT NOT NULL,
        error_type TEXT NOT NULL DEFAULT '',
        context_scope_json TEXT NOT NULL DEFAULT '{}',
        payload_hash TEXT NOT NULL DEFAULT '',
        input_tokens INTEGER NOT NULL DEFAULT 0,
        output_tokens INTEGER NOT NULL DEFAULT 0,
        estimated_cost REAL NOT NULL DEFAULT 0,
        snapshot_created_at TEXT NOT NULL DEFAULT '',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_ai_runs_session ON ai_analysis_runs(session_id, created_at);
      CREATE TABLE IF NOT EXISTS ai_context_sources (
        id TEXT PRIMARY KEY,
        analysis_run_id TEXT NOT NULL REFERENCES ai_analysis_runs(id) ON DELETE CASCADE,
        source_type TEXT NOT NULL,
        source_table TEXT NOT NULL DEFAULT '',
        source_record_id TEXT NOT NULL DEFAULT '',
        module TEXT NOT NULL DEFAULT '',
        country_code TEXT NOT NULL DEFAULT '',
        store_id TEXT NOT NULL DEFAULT '',
        date_start TEXT NOT NULL DEFAULT '',
        date_end TEXT NOT NULL DEFAULT '',
        record_count INTEGER NOT NULL DEFAULT 0,
        snapshot_at TEXT NOT NULL,
        summary_json TEXT NOT NULL DEFAULT '{}',
        created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_ai_context_run ON ai_context_sources(analysis_run_id, source_type);
      CREATE TABLE IF NOT EXISTS ai_usage_records (
        id TEXT PRIMARY KEY,
        analysis_run_id TEXT REFERENCES ai_analysis_runs(id) ON DELETE SET NULL,
        provider_id TEXT NOT NULL,
        model_name TEXT NOT NULL,
        input_tokens INTEGER NOT NULL DEFAULT 0,
        output_tokens INTEGER NOT NULL DEFAULT 0,
        estimated_cost REAL NOT NULL DEFAULT 0,
        request_status TEXT NOT NULL,
        error_type TEXT NOT NULL DEFAULT '',
        usage_date TEXT NOT NULL,
        usage_month TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_ai_usage_day ON ai_usage_records(usage_date, provider_id);
      CREATE INDEX IF NOT EXISTS idx_ai_usage_month ON ai_usage_records(usage_month, provider_id);
      CREATE TABLE IF NOT EXISTS ai_memory_items (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        content TEXT NOT NULL,
        memory_type TEXT NOT NULL,
        country_code TEXT NOT NULL DEFAULT '',
        store_id TEXT NOT NULL DEFAULT '',
        business_module TEXT NOT NULL DEFAULT '',
        source TEXT NOT NULL DEFAULT 'user',
        ai_suggested INTEGER NOT NULL DEFAULT 0,
        user_confirmed INTEGER NOT NULL DEFAULT 1,
        enabled INTEGER NOT NULL DEFAULT 1,
        confirmed_at TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_ai_memory_scope ON ai_memory_items(enabled, country_code, store_id, business_module, updated_at);
      CREATE TABLE IF NOT EXISTS ai_conversation_summaries (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL REFERENCES ai_chat_sessions(id) ON DELETE CASCADE,
        content TEXT NOT NULL,
        through_message_id TEXT NOT NULL DEFAULT '',
        message_count INTEGER NOT NULL DEFAULT 0,
        is_ai_generated INTEGER NOT NULL DEFAULT 1,
        provider_id TEXT NOT NULL DEFAULT '',
        model_name TEXT NOT NULL DEFAULT '',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_ai_summaries_session ON ai_conversation_summaries(session_id, created_at);

      CREATE TABLE IF NOT EXISTS backup_catalog (
        id TEXT PRIMARY KEY,
        file_name TEXT NOT NULL UNIQUE,
        reason TEXT NOT NULL,
        size INTEGER NOT NULL DEFAULT 0,
        integrity_status TEXT NOT NULL DEFAULT 'unknown',
        created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS legacy_migration_records (
        id TEXT PRIMARY KEY,
        source_key TEXT NOT NULL,
        source_hash TEXT NOT NULL,
        target_table TEXT NOT NULL,
        target_id TEXT NOT NULL,
        created_at TEXT NOT NULL,
        UNIQUE(source_key, source_hash, target_table, target_id)
      );
      CREATE TABLE IF NOT EXISTS migration_reports (
        id TEXT PRIMARY KEY,
        migration_type TEXT NOT NULL,
        status TEXT NOT NULL,
        report_json TEXT NOT NULL,
        backup_id TEXT NOT NULL DEFAULT '',
        created_at TEXT NOT NULL
      );
    `,
  },
  {
    version: 3,
    name: 'local-full-text-search',
    sql: `
      CREATE VIRTUAL TABLE IF NOT EXISTS ai_memory_fts USING fts5(
        title, content, memory_type, country_code, store_id, business_module,
        content='ai_memory_items', content_rowid='rowid', tokenize='unicode61'
      );
      CREATE TRIGGER IF NOT EXISTS ai_memory_insert AFTER INSERT ON ai_memory_items BEGIN
        INSERT INTO ai_memory_fts(rowid,title,content,memory_type,country_code,store_id,business_module)
        VALUES(new.rowid,new.title,new.content,new.memory_type,new.country_code,new.store_id,new.business_module);
      END;
      CREATE TRIGGER IF NOT EXISTS ai_memory_delete AFTER DELETE ON ai_memory_items BEGIN
        INSERT INTO ai_memory_fts(ai_memory_fts,rowid,title,content,memory_type,country_code,store_id,business_module)
        VALUES('delete',old.rowid,old.title,old.content,old.memory_type,old.country_code,old.store_id,old.business_module);
      END;
      CREATE TRIGGER IF NOT EXISTS ai_memory_update AFTER UPDATE ON ai_memory_items BEGIN
        INSERT INTO ai_memory_fts(ai_memory_fts,rowid,title,content,memory_type,country_code,store_id,business_module)
        VALUES('delete',old.rowid,old.title,old.content,old.memory_type,old.country_code,old.store_id,old.business_module);
        INSERT INTO ai_memory_fts(rowid,title,content,memory_type,country_code,store_id,business_module)
        VALUES(new.rowid,new.title,new.content,new.memory_type,new.country_code,new.store_id,new.business_module);
      END;
      INSERT INTO ai_memory_fts(ai_memory_fts) VALUES('rebuild');

      CREATE VIRTUAL TABLE IF NOT EXISTS ai_chat_fts USING fts5(
        content, role, session_id,
        content='ai_chat_messages', content_rowid='rowid', tokenize='unicode61'
      );
      CREATE TRIGGER IF NOT EXISTS ai_chat_insert AFTER INSERT ON ai_chat_messages BEGIN
        INSERT INTO ai_chat_fts(rowid,content,role,session_id) VALUES(new.rowid,new.content,new.role,new.session_id);
      END;
      CREATE TRIGGER IF NOT EXISTS ai_chat_delete AFTER DELETE ON ai_chat_messages BEGIN
        INSERT INTO ai_chat_fts(ai_chat_fts,rowid,content,role,session_id)
        VALUES('delete',old.rowid,old.content,old.role,old.session_id);
      END;
      CREATE TRIGGER IF NOT EXISTS ai_chat_update AFTER UPDATE ON ai_chat_messages BEGIN
        INSERT INTO ai_chat_fts(ai_chat_fts,rowid,content,role,session_id)
        VALUES('delete',old.rowid,old.content,old.role,old.session_id);
        INSERT INTO ai_chat_fts(rowid,content,role,session_id) VALUES(new.rowid,new.content,new.role,new.session_id);
      END;
      INSERT INTO ai_chat_fts(ai_chat_fts) VALUES('rebuild');
    `,
  },
  {
    version: 4,
    name: 'provider-and-safety-defaults',
    sql: `
      INSERT OR IGNORE INTO app_settings(key,value_json,created_at,updated_at)
      VALUES
        ('ai_enabled','false',datetime('now'),datetime('now')),
        ('ai_limits','{"maxInputTokens":12000,"maxOutputTokens":1200,"dailyCalls":20,"dailyCost":10,"monthlyCost":100,"costEstimation":true}',datetime('now'),datetime('now')),
        ('backup_retention','30',datetime('now'),datetime('now')),
        ('context_limits','{"defaultDetailRows":100,"maxDetailRows":500,"recentMessages":12,"maxInputCharacters":24000}',datetime('now'),datetime('now'));
      INSERT OR IGNORE INTO ai_provider_configs(
        provider_id,name,base_url,model_name,max_input_tokens,max_output_tokens,timeout_ms,
        stream_enabled,enabled,input_cost_per_million,output_cost_per_million,created_at,updated_at
      ) VALUES
        ('deepseek','DeepSeek','https://api.deepseek.com','deepseek-v4-flash',64000,1200,60000,1,0,0,0,datetime('now'),datetime('now')),
        ('custom-openai','自定义 OpenAI 兼容接口','https://example.invalid/v1','custom-model',16000,1200,60000,1,0,0,0,datetime('now'),datetime('now'));
    `,
  },
  {
    version: 5,
    name: 'control-price-context-index',
    sql: `
      CREATE INDEX IF NOT EXISTS idx_rule_scope
      ON rule_versions(module,country_code,store_id,business_database_id,created_at);
    `,
  },
];

module.exports = { LATEST_SCHEMA_VERSION, migrations };
