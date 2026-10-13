'use strict';
// Banco de teste novo e vazio para cada teste, já com supabase/schema.sql aplicado.
//  * Padrão: PGlite (PostgreSQL real rodando dentro do Node, sem internet).
//  * Com TEST_DATABASE_URL: um Postgres de verdade (ex.: projeto Supabase de TESTE).
//    Cada teste cria um schema próprio (test_xxx) e apaga só esse schema no fim.
//    Nunca aponte TEST_DATABASE_URL para o banco de produção.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { createPool, fromPool, toNumber, NUMBER_OIDS } = require('../../server/db');

const ROOT = path.join(__dirname, '..', '..');
const SCHEMA = fs.readFileSync(path.join(ROOT, 'supabase', 'schema.sql'), 'utf8');
const SEED = fs.readFileSync(path.join(ROOT, 'supabase', 'seed.sql'), 'utf8');

async function pgliteDb() {
  const { PGlite } = await import('@electric-sql/pglite');
  const parsers = {};
  NUMBER_OIDS.forEach(oid => { parsers[oid] = toNumber; });
  const lite = new PGlite({ parsers });
  const run = async (exec, text, params) => (await exec.query(text, params)).rows;
  return {
    kind: 'pglite',
    query: (text, params) => run(lite, text, params),
    exec: text => lite.exec(text),
    // PGlite tem uma conexão só; transaction() segura a conexão até o fim.
    tx: fn => lite.transaction(t => fn({ query: (text, params) => run(t, text, params) })),
    close: () => lite.close(),
  };
}

async function realDb(url) {
  const schema = `test_${crypto.randomBytes(6).toString('hex')}`;
  // search_path definido na abertura de cada conexão (parâmetro de inicialização).
  const pool = createPool({ ...process.env, DATABASE_URL: url }, { max: 8, options: `-c search_path=${schema},public` });
  const db = fromPool(pool);
  await db.exec(`CREATE SCHEMA ${schema}`);
  const close = db.close;
  db.kind = 'postgres';
  db.close = async () => {
    try { await db.exec(`DROP SCHEMA ${schema} CASCADE`); } finally { await close(); }
  };
  return db;
}

async function createTestDb({ seed = true } = {}) {
  const db = process.env.TEST_DATABASE_URL ? await realDb(process.env.TEST_DATABASE_URL) : await pgliteDb();
  await db.exec(SCHEMA);
  if (seed) await db.exec(SEED);
  return db;
}

module.exports = { createTestDb };
