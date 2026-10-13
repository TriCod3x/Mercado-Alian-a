'use strict';
// Migra o banco SQLite antigo (mercado.db) para o Supabase/PostgreSQL.
//
//   node --env-file=.env scripts/migrate-sqlite.js caminho/mercado.db --dry-run   (simula)
//   node --env-file=.env scripts/migrate-sqlite.js caminho/mercado.db             (grava)
//
// Segurança:
//  * O arquivo SQLite é aberto SOMENTE LEITURA e copiado para backups/ antes de tudo.
//  * O destino precisa estar vazio (schema.sql rodado, seed.sql NÃO).
//  * Tudo numa transação: se qualquer conferência falhar, nada é gravado.
// Requer Node 22.13+ (usa o módulo node:sqlite embutido).
const fs = require('fs');
const path = require('path');
const { FORMAT, VERSION } = require('../server/dataset');
const { transfer } = require('./lib/transfer');

const iso = ms => (ms == null ? null : new Date(ms).toISOString());

// Lê o SQLite (schema v1 do sistema original) e converte para o formato do backup.
function readSqlite(file) {
  const { DatabaseSync } = require('node:sqlite');
  const src = new DatabaseSync(file, { readOnly: true });
  try {
    const version = src.prepare('PRAGMA user_version').get().user_version;
    if (version !== 1) throw new Error(`Versão do banco SQLite inesperada (user_version = ${version}; esperado 1).`);
    const all = sql => src.prepare(sql).all();
    const migratedAt = new Date().toISOString();
    return {
      format: FORMAT,
      version: VERSION,
      created_at: migratedAt,
      tables: {
        users: all('SELECT * FROM users ORDER BY id').map(u => ({
          id: u.id, name: u.name, username: u.username, pass_hash: u.pass_hash, role: u.role,
          active: !!u.active, created_at: iso(u.created_at), updated_at: iso(u.created_at),
        })),
        // O SQLite não guardava data nas categorias; recebem a data da migração.
        categories: all('SELECT * FROM categories ORDER BY id').map(c => ({
          id: c.id, name: c.name, created_at: migratedAt, updated_at: migratedAt,
        })),
        products: all('SELECT * FROM products ORDER BY id').map(p => ({
          id: p.id, name: p.name, category_id: p.category_id, code: p.code, unit: p.unit,
          cost_cents: p.cost_cents, price_cents: p.price_cents, stock_milli: p.stock_milli, min_milli: p.min_milli,
          active: !!p.active, created_at: iso(p.created_at), updated_at: iso(p.created_at),
        })),
        sales: all('SELECT * FROM sales ORDER BY id').map(s => ({
          ...s, created_at: iso(s.created_at), cancelled_at: iso(s.cancelled_at),
        })),
        sale_items: all('SELECT * FROM sale_items ORDER BY id'),
        stock_movements: all('SELECT * FROM stock_movements ORDER BY id').map(m => ({ ...m, created_at: iso(m.created_at) })),
      },
    };
  } finally {
    src.close();
  }
}

// Cópia do arquivo original (e do -wal/-shm, se existirem) antes de qualquer coisa.
function backupFile(file, dir) {
  fs.mkdirSync(dir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const copies = [];
  for (const suffix of ['', '-wal', '-shm']) {
    if (!fs.existsSync(file + suffix)) continue;
    const dest = path.join(dir, `sqlite-${stamp}-${path.basename(file)}${suffix}`);
    fs.copyFileSync(file + suffix, dest, fs.constants.COPYFILE_EXCL);
    copies.push(dest);
  }
  return copies;
}

async function main() {
  const args = process.argv.slice(2);
  const dryRun = args.includes('--dry-run');
  const file = args.find(a => !a.startsWith('--'));
  if (!file) throw new Error('Uso: node --env-file=.env scripts/migrate-sqlite.js caminho/mercado.db [--dry-run]');
  if (!fs.existsSync(file)) throw new Error(`Arquivo não encontrado: ${file}`);

  const copies = backupFile(file, path.join(__dirname, '..', 'backups'));
  console.log('Cópia de segurança do SQLite:', copies.join(', '));

  const data = readSqlite(file);
  console.log('Lido do SQLite:', Object.entries(data.tables).map(([t, r]) => `${t}=${r.length}`).join(' '));

  const { createPool, fromPool, checkSchema } = require('../server/db');
  const db = fromPool(createPool(process.env));
  try {
    await checkSchema(db);
    await transfer(db, data, { dryRun });
  } finally {
    await db.close();
  }
}

if (require.main === module) {
  main().catch(e => { console.error(`\nMIGRAÇÃO NÃO REALIZADA: ${e.message}`); process.exit(1); });
}

module.exports = { readSqlite };
