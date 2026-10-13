'use strict';
// Restaura um backup JSON num banco VAZIO (recém-criado com supabase/schema.sql).
//   node --env-file=.env scripts/restore.js alianca-backup-AAAA-MM-DD.json --dry-run   (simula)
//   node --env-file=.env scripts/restore.js alianca-backup-AAAA-MM-DD.json             (grava)
// Nunca apaga nem sobrescreve: se o banco já tiver dados, recusa.
const fs = require('fs');
const { createPool, fromPool, checkSchema } = require('../server/db');
const { transfer } = require('./lib/transfer');

async function main() {
  const args = process.argv.slice(2);
  const dryRun = args.includes('--dry-run');
  const file = args.find(a => !a.startsWith('--'));
  if (!file) throw new Error('Uso: node --env-file=.env scripts/restore.js arquivo.json [--dry-run]');
  const data = JSON.parse(fs.readFileSync(file, 'utf8'));
  const db = fromPool(createPool(process.env));
  try {
    await checkSchema(db);
    await transfer(db, data, { dryRun });
  } finally {
    await db.close();
  }
}

main().catch(e => { console.error(`\nRESTAURAÇÃO NÃO REALIZADA: ${e.message}`); process.exit(1); });
