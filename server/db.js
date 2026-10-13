'use strict';
const fs = require('fs');
const pg = require('pg');

// Dinheiro sempre em centavos (inteiro). Quantidades em milésimos (inteiro):
// 1 un = 1000, 0,5 kg = 500. Evita erro de ponto flutuante em estoque e caixa.
// O Postgres devolve bigint/numeric como texto; aqui viram Number, com checagem.
function toNumber(v) {
  if (v == null) return v;
  const n = Number(v);
  if (!Number.isFinite(n) || (Number.isInteger(n) && !Number.isSafeInteger(n))) {
    throw new Error(`Valor numérico fora da faixa segura: ${v}`);
  }
  return n;
}
const NUMBER_OIDS = new Set([20, 1700]); // int8, numeric

// Erros em que vale repetir a transação inteira.
const RETRY_CODES = new Set(['40001', '40P01']); // serialization_failure, deadlock_detected
const MAX_TRIES = 3;

// Interface única usada pelo app: query() devolve as linhas; tx() roda tudo
// numa transação (BEGIN/COMMIT, ROLLBACK em erro) num único cliente.
function fromPool(pool) {
  const wrapClient = c => ({ query: async (text, params) => (await c.query(text, params)).rows });
  return {
    query: async (text, params) => (await pool.query(text, params)).rows,
    exec: async text => { await pool.query(text); },
    async tx(fn) {
      for (let attempt = 1; ; attempt++) {
        const client = await pool.connect();
        let broken;
        try {
          await client.query('BEGIN');
          const result = await fn(wrapClient(client));
          await client.query('COMMIT');
          return result;
        } catch (e) {
          try { await client.query('ROLLBACK'); } catch (rb) { broken = rb; }
          if (RETRY_CODES.has(e.code) && attempt < MAX_TRIES) continue;
          throw e;
        } finally {
          client.release(broken);
        }
      }
    },
    close: () => pool.end(),
  };
}

// SSL: "require" criptografa; com DATABASE_CA_CERT o certificado do Supabase
// também é verificado (recomendado). "disable" só para Postgres local.
function sslConfig(env, host) {
  const mode = (env.DATABASE_SSL || (/^(localhost|127\.0\.0\.1|::1)$/.test(host) ? 'disable' : 'require')).toLowerCase();
  if (mode === 'disable') return false;
  const ca = env.DATABASE_CA_CERT;
  if (ca) return { ca: ca.includes('BEGIN CERTIFICATE') ? ca : fs.readFileSync(ca, 'utf8'), rejectUnauthorized: true };
  if (mode === 'verify') throw new Error('DATABASE_SSL=verify exige DATABASE_CA_CERT.');
  return { rejectUnauthorized: false };
}

function createPool(env = process.env, overrides = {}) {
  const raw = env.DATABASE_URL;
  if (!raw) throw new Error('Defina DATABASE_URL (connection string do Supabase). Veja o README.');
  const url = new URL(raw);
  // O SSL é configurado abaixo; parâmetros ssl* na URL brigariam com ele.
  ['sslmode', 'sslcert', 'sslkey', 'sslrootcert'].forEach(k => url.searchParams.delete(k));
  const pool = new pg.Pool({
    connectionString: url.toString(),
    ssl: sslConfig(env, url.hostname),
    max: Number(env.PG_POOL_MAX) || 10,
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: 10000,
    statement_timeout: 15000,
    idle_in_transaction_session_timeout: 30000,
    application_name: 'mercado-alianca',
    types: { getTypeParser: (oid, format) => (NUMBER_OIDS.has(oid) ? toNumber : pg.types.getTypeParser(oid, format)) },
    ...overrides,
  });
  // Conexão ociosa derrubada pelo servidor não pode derrubar o processo.
  pool.on('error', err => console.error('Conexão com o banco perdida:', err.message));
  return pool;
}

const TABLES = ['users', 'sessions', 'categories', 'products', 'sales', 'sale_items', 'stock_movements'];

// Confere se o schema.sql já foi executado no banco.
async function checkSchema(db) {
  const rows = await db.query('SELECT t, to_regclass(t) IS NOT NULL AS ok FROM unnest($1::text[]) AS t', [TABLES]);
  const missing = rows.filter(r => !r.ok).map(r => r.t);
  if (missing.length) {
    throw new Error(`Tabelas ausentes no banco: ${missing.join(', ')}. Rode supabase/schema.sql no SQL Editor do Supabase.`);
  }
}

module.exports = { createPool, fromPool, checkSchema, toNumber, NUMBER_OIDS };
