import postgres from "postgres";
const sql = postgres(process.env.PAPERCLIP_DB_URL, { ssl: 'require' });
const journal = await sql`SELECT table_schema, table_name FROM information_schema.tables WHERE table_name = '__drizzle_migrations' ORDER BY table_schema`;
const rows = await sql`SELECT table_name FROM information_schema.tables WHERE table_schema='public' AND table_name IN ('agent_runtime_state','agent_wakeup_requests','heartbeat_run_events') ORDER BY table_name`;
const hist = await sql.unsafe(`SELECT * FROM drizzle.__drizzle_migrations ORDER BY id LIMIT 10`);
console.log(JSON.stringify({ journal, rows, histCount: hist.length, hist }, null, 2));
await sql.end();
