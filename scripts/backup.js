'use strict';
// Gera um backup completo do banco em JSON (o mesmo do botão "Baixar backup").
//   node --env-file=.env scripts/backup.js [pasta]       (padrão: ./backups)
const fs = require('fs');
const path = require('path');
const { createPool, fromPool, checkSchema } = require('../server/db');
const { dumpDataset } = require('../server/dataset');

async function main() {
  const dir = process.argv[2] || path.join(__dirname, '..', 'backups');
  const db = fromPool(createPool(process.env));
  try {
    await checkSchema(db);
    const data = await db.tx(c => dumpDataset(c));
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, `alianca-backup-${data.created_at.replace(/[:.]/g, '-')}.json`);
    fs.writeFileSync(file, JSON.stringify(data), { flag: 'wx' });
    console.log(`Backup salvo em ${file}`);
    console.log(Object.entries(data.tables).map(([t, r]) => `${t}=${r.length}`).join(' '));
  } finally {
    await db.close();
  }
}

main().catch(e => { console.error(`Backup falhou: ${e.message}`); process.exit(1); });
