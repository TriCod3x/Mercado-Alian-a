'use strict';
// Migração SQLite → PostgreSQL e backup/restauração: dados idênticos, IDs,
// hashes de senha, histórico financeiro e sequências preservados.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');
const { createTestDb } = require('./support/testdb');
const { createApp } = require('../server/app');
const { hashPassword } = require('../server/auth');
const { readSqlite } = require('../scripts/migrate-sqlite');
const { transfer } = require('../scripts/lib/transfer');
const { counts } = require('../server/dataset');

const quiet = { log: () => {} };
const T = Date.parse('2026-09-15T10:00:00-03:00');

// Banco no formato EXATO do sistema antigo (schema v1), com casos reais:
// venda com desconto e troco, venda cancelada, produto excluído, produto em kg,
// usuário desativado, IDs com buracos.
function makeSqlite() {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'alianca-mig-')), 'mercado.db');
  const db = new DatabaseSync(file);
  db.exec(fs.readFileSync(path.join(__dirname, 'fixtures', 'sqlite-v1.sql'), 'utf8'));
  db.exec('PRAGMA user_version = 1');
  const run = (sql, ...p) => db.prepare(sql).run(...p);
  run('INSERT INTO users VALUES (1,?,?,?,?,1,?)', 'Dono', 'dono', hashPassword('senha-do-dono'), 'dono', T);
  run('INSERT INTO users VALUES (3,?,?,?,?,0,?)', 'Ex caixa', 'joao', hashPassword('senha-do-joao'), 'caixa', T);
  ['Mercearia', 'Bebidas', 'Outros'].forEach((c, i) => run('INSERT INTO categories VALUES (?,?)', i + 1, c));
  run("INSERT INTO products VALUES (1,'Café',1,'789',  'un',1250,1890, 8000,2000,1,?)", T);
  run("INSERT INTO products VALUES (2,'Banana',3,NULL, 'kg', 350, 599,11250,   0,1,?)", T);
  run("INSERT INTO products VALUES (5,'Antigo',2,'111', 'un', 100, 200,    0,   0,0,?)", T);
  // venda 1: 2 cafés + 1,25 kg banana, desconto 100, dinheiro 6000
  run("INSERT INTO sales VALUES (1,1,'req-1',1,?,4529,100,4429,2938,'dinheiro',6000,'ok',NULL,NULL,NULL)", T + 1000);
  run("INSERT INTO sale_items VALUES (1,1,1,'Café','Mercearia','un',2000,1890,1250,3780,84,2500)");
  run("INSERT INTO sale_items VALUES (2,1,2,'Banana','Outros','kg',1250,599,350,749,16,438)");
  // venda 2: cancelada (estoque já devolvido)
  run("INSERT INTO sales VALUES (2,2,NULL,3,?,200,0,200,100,'pix',NULL,'cancelada',?,1,'erro')", T + 2000, T + 3000);
  run("INSERT INTO sale_items VALUES (7,2,5,'Antigo','Bebidas','un',1000,200,100,200,0,100)");
  const mv = (id, p, type, q, sale, at) => run('INSERT INTO stock_movements VALUES (?,?,?,?,?,?,?,?)', id, p, type, q, null, 1, sale, at);
  mv(1, 1, 'inicial', 10000, null, T); mv(2, 2, 'inicial', 12500, null, T); mv(3, 5, 'inicial', 1000, null, T);
  mv(4, 1, 'venda', -2000, 1, T + 1000); mv(5, 2, 'venda', -1250, 1, T + 1000);
  mv(6, 5, 'venda', -1000, 2, T + 2000); mv(7, 5, 'cancelamento', 1000, 2, T + 3000);
  mv(8, 5, 'ajuste', -1000, null, T + 4000);
  db.close();
  return file;
}

async function serve(t, db) {
  const app = createApp({ db, now: () => Date.parse('2026-10-10T12:00:00-03:00') });
  const server = await new Promise(r => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
  t.after(() => new Promise(r => server.close(r)));
  const base = `http://127.0.0.1:${server.address().port}`;
  let sid = '';
  const call = async (method, url, body) => {
    const res = await fetch(base + url, {
      method, headers: { 'Content-Type': 'application/json', ...(sid ? { Cookie: `sid=${sid}` } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    for (const c of res.headers.getSetCookie()) { const m = /^sid=([^;]*)/.exec(c); if (m) sid = m[1]; }
    return { status: res.status, data: await res.json() };
  };
  return call;
}

test('migração do SQLite: dados idênticos, senhas, histórico e sequências', async t => {
  const file = makeSqlite();
  const before = fs.readFileSync(file);
  const data = readSqlite(file);
  assert.deepEqual(fs.readFileSync(file), before, 'o SQLite original não pode ser alterado');

  const db = await createTestDb({ seed: false });
  t.after(() => db.close());

  // simulação não grava nada
  await transfer(db, data, { dryRun: true, ...quiet });
  assert.equal((await counts(db)).users, 0);

  const report = await transfer(db, data, quiet);
  assert.deepEqual(report.summary.counts, { users: 2, categories: 3, products: 3, sales: 2, sale_items: 3, stock_movements: 8 });
  assert.equal(report.summary.sales.total, 4429 + 200);
  assert.equal(report.summary.sales.cancelled, 1);
  assert.equal(report.warnings.length, 0, report.warnings.join('\n'));

  // carregar de novo por cima é recusado (nada é sobrescrito)
  await assert.rejects(transfer(db, data, quiet), /já tem dados/);

  const api = await serve(t, db);
  assert.equal((await api('POST', '/api/login', { username: 'joao', password: 'senha-do-joao' })).status, 401, 'usuário desativado continua desativado');
  assert.equal((await api('POST', '/api/login', { username: 'dono', password: 'senha-do-dono' })).status, 200, 'hash scrypt migrado funciona');

  const sales = (await api('GET', '/api/sales?month=2026-09')).data;
  const s1 = sales.find(s => s.number === 1);
  assert.equal(s1.at, T + 1000, 'data/hora preservada ao milissegundo');
  assert.equal(s1.change, 6000 - 4429);
  assert.equal(s1.profit, 4429 - 2938);
  assert.deepEqual(s1.items.map(i => i.price), [1890, 599], 'preço histórico preservado');
  assert.equal(sales.find(s => s.number === 2).status, 'cancelada');
  const rep = (await api('GET', '/api/reports/month?month=2026-09')).data;
  assert.equal(rep.kpis.revenue, 4429);
  assert.equal(rep.kpis.profit, 4429 - 2938);

  const prods = (await api('GET', '/api/products')).data;
  assert.deepEqual(prods.map(p => [p.id, p.stock]), [[2, 11.25], [1, 8]]);

  // sequências continuam depois dos IDs migrados
  const novo = await api('POST', '/api/products', { name: 'Novo', category: 'Bebidas', unit: 'un', cost: 1, price: 2, stock: 3 });
  assert.equal(novo.data.id, 6);
  const venda = await api('POST', '/api/sales', { items: [{ product_id: 6, qty: 1 }], payment: 'pix' });
  assert.equal(venda.data.sale.number, 3);
  assert.equal(venda.data.sale.id, 3);
  const users = await api('POST', '/api/users', { name: 'Ana', username: 'ana', password: 'senha-da-ana', role: 'caixa' });
  assert.equal(users.data.find(u => u.username === 'ana').id, 4);
});

test('migração recusa SQLite com dados que violam as regras', async t => {
  const file = makeSqlite();
  const raw = new DatabaseSync(file);
  raw.exec("UPDATE sales SET total_cents = 1 WHERE id = 1"); // total ≠ subtotal − desconto
  raw.close();
  const db = await createTestDb({ seed: false });
  t.after(() => db.close());
  await assert.rejects(transfer(db, readSqlite(file), quiet), /check constraint/);
  assert.equal((await counts(db)).sales, 0, 'falha não deixa nada gravado');
});

test('backup JSON restaura idêntico num banco novo', async t => {
  const db = await createTestDb({ seed: false });
  t.after(() => db.close());
  await transfer(db, readSqlite(makeSqlite()), quiet);
  const api = await serve(t, db);
  await api('POST', '/api/login', { username: 'dono', password: 'senha-do-dono' });

  const res = await api('GET', '/api/backup');
  assert.equal(res.status, 200);
  const backup = res.data;
  assert.equal(backup.format, 'mercado-alianca-backup');
  assert.ok(!('sessions' in backup.tables), 'sessões não vão para o backup');

  const fresh = await createTestDb({ seed: false });
  t.after(() => fresh.close());
  const report = await transfer(fresh, JSON.parse(JSON.stringify(backup)), quiet);
  assert.deepEqual(report.summary.counts, await counts(db));
});
