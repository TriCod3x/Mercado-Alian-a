'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createTestDb } = require('./support/testdb');
const { createApp } = require('../server/app');
const { hashPassword } = require('../server/auth');

const BRT = '-03:00';
let clock = Date.parse(`2026-10-10T12:00:00${BRT}`);

async function boot(t) {
  const db = await createTestDb();
  await db.query('INSERT INTO users(name, username, pass_hash, role, created_at) VALUES ($1,$2,$3,$4,$5)',
    ['Dono', 'dono', hashPassword('senha-do-dono'), 'dono', new Date(0)]);
  const app = createApp({ db, now: () => clock });
  const server = await new Promise(r => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
  const base = `http://127.0.0.1:${server.address().port}`;
  // Fecha o servidor HTTP antes do banco.
  if (t) t.after(async () => { await new Promise(r => server.close(r)); await db.close(); });
  return { db, server, base };
}

function client(base) {
  let sid = '';
  const call = async (method, path, body) => {
    const res = await fetch(base + path, {
      method,
      headers: { 'Content-Type': 'application/json', ...(sid ? { Cookie: `sid=${sid}` } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    for (const c of res.headers.getSetCookie()) {
      const m = /^sid=([^;]*)/.exec(c);
      if (m) sid = m[1];
    }
    const type = res.headers.get('content-type') || '';
    const data = type.includes('json') ? await res.json() : await res.text();
    return { status: res.status, data, res };
  };
  call.login = async (u, p) => call('POST', '/api/login', { username: u, password: p });
  call.sid = () => sid;
  return call;
}

const product = (over = {}) => ({
  name: 'Café 500g', category: 'Mercearia', code: '', unit: 'un', cost: 1250, price: 1890, stock: 10, min: 2, ...over,
});

test('fluxo completo: venda, baixa, lucro, cancelamento', async t => {
  const { base } = await boot(t);
  const dono = client(base);
  assert.equal((await dono('GET', '/api/me')).status, 401);
  assert.equal((await dono.login('dono', 'errada')).status, 401);
  assert.equal((await dono.login('dono', 'senha-do-dono')).status, 200);

  const created = await dono('POST', '/api/products', product());
  assert.equal(created.status, 201);
  const cafe = created.data;
  assert.equal(cafe.stock, 10);
  assert.equal(cafe.cost, 1250);

  // preço vindo do cliente é ignorado; total sai do banco
  const sale = await dono('POST', '/api/sales', {
    items: [{ product_id: cafe.id, qty: 2, price: 1 }], discount: 100, payment: 'dinheiro', received: 5000,
  });
  assert.equal(sale.status, 201);
  assert.equal(sale.data.sale.subtotal, 3780);
  assert.equal(sale.data.sale.total, 3680);
  assert.equal(sale.data.sale.change, 1320);
  assert.equal(sale.data.sale.profit, 3680 - 2500);

  let prods = (await dono('GET', '/api/products')).data;
  assert.equal(prods.find(p => p.id === cafe.id).stock, 8);

  const rep = (await dono('GET', '/api/reports/month?month=2026-10')).data;
  assert.equal(rep.kpis.profit, 1180);
  assert.equal(rep.kpis.revenue, 3680);
  assert.equal(rep.kpis.count, 1);
  assert.equal(rep.top[0].profit, 1180);
  assert.equal(rep.days[9].revenue, 3680); // dia 10

  const cancel = await dono('POST', `/api/sales/${sale.data.sale.id}/cancel`, { reason: 'erro do caixa' });
  assert.equal(cancel.status, 200);
  assert.equal(cancel.data.status, 'cancelada');
  assert.equal((await dono('POST', `/api/sales/${sale.data.sale.id}/cancel`, {})).status, 409);
  prods = (await dono('GET', '/api/products')).data;
  assert.equal(prods.find(p => p.id === cafe.id).stock, 10);
  const rep2 = (await dono('GET', '/api/reports/month?month=2026-10')).data;
  assert.equal(rep2.kpis.profit, 0);
  assert.equal(rep2.kpis.count, 0);

  const mov = (await dono('GET', `/api/products/${cafe.id}/movements`)).data.movements.map(m => m.type);
  assert.deepEqual(mov, ['cancelamento', 'venda', 'inicial']);
});

test('regras de quantidade, estoque e desconto', async t => {
  const { base } = await boot(t);
  const c = client(base);
  await c.login('dono', 'senha-do-dono');
  const un = (await c('POST', '/api/products', product({ name: 'Arroz', stock: 3 }))).data;
  const kg = (await c('POST', '/api/products', product({ name: 'Banana', unit: 'kg', cost: 350, price: 599, stock: 12.5 }))).data;

  const sell = items => c('POST', '/api/sales', { items, payment: 'pix' });
  assert.equal((await sell([{ product_id: un.id, qty: 1.5 }])).status, 400);
  assert.equal((await sell([{ product_id: un.id, qty: 0 }])).status, 400);
  assert.equal((await sell([{ product_id: un.id, qty: -1 }])).status, 400);
  assert.equal((await sell([{ product_id: un.id, qty: 4 }])).status, 409);
  assert.equal((await sell([{ product_id: kg.id, qty: 1.2345 }])).status, 400);
  assert.equal((await sell([])).status, 400);
  assert.equal((await sell([{ product_id: 9999, qty: 1 }])).status, 409);
  // mesmo produto em duas linhas é somado antes de checar estoque
  assert.equal((await sell([{ product_id: un.id, qty: 2 }, { product_id: un.id, qty: 2 }])).status, 409);

  const ok = await sell([{ product_id: kg.id, qty: 1.25 }]);
  assert.equal(ok.status, 201);
  assert.equal(ok.data.sale.total, Math.round(599 * 1.25));
  const after = (await c('GET', '/api/products')).data.find(p => p.id === kg.id);
  assert.equal(after.stock, 11.25);

  assert.equal((await c('POST', '/api/sales', { items: [{ product_id: un.id, qty: 1 }], payment: 'pix', discount: 99999 })).status, 400);
  assert.equal((await c('POST', '/api/sales', { items: [{ product_id: un.id, qty: 1 }], payment: 'cheque' })).status, 400);
  assert.equal((await c('POST', '/api/sales', { items: [{ product_id: un.id, qty: 1 }], payment: 'dinheiro', received: 100 })).status, 400);
  assert.equal((await c('POST', '/api/sales', { items: [{ product_id: un.id, qty: 1 }], payment: 'pix', discount: 1890 })).status, 400); // total zero
  // nada disso mexeu no estoque
  assert.equal((await c('GET', '/api/products')).data.find(p => p.id === un.id).stock, 3);
});

test('desconto é rateado sem perder centavo', async t => {
  const { base } = await boot(t);
  const c = client(base);
  await c.login('dono', 'senha-do-dono');
  const a = (await c('POST', '/api/products', product({ name: 'A', price: 333, cost: 100 }))).data;
  const b = (await c('POST', '/api/products', product({ name: 'B', price: 777, cost: 200 }))).data;
  const d = (await c('POST', '/api/products', product({ name: 'C', price: 1001, cost: 300 }))).data;
  const r = await c('POST', '/api/sales', {
    items: [{ product_id: a.id, qty: 1 }, { product_id: b.id, qty: 1 }, { product_id: d.id, qty: 1 }], discount: 101, payment: 'pix',
  });
  assert.equal(r.status, 201);
  const items = r.data.sale.items;
  assert.equal(items.reduce((s, i) => s + i.discount, 0), 101);
  assert.equal(items.reduce((s, i) => s + i.total - i.discount, 0), r.data.sale.total);
  items.forEach(i => assert.ok(i.discount >= 0 && i.discount <= i.total));
  const rep = (await c('GET', '/api/reports/month?month=2026-10')).data;
  assert.equal(rep.kpis.profit, r.data.sale.profit);
  assert.equal(rep.top.reduce((s, x) => s + x.profit, 0), r.data.sale.profit);
});

test('request_id evita venda duplicada em reenvio', async t => {
  const { base } = await boot(t);
  const c = client(base);
  await c.login('dono', 'senha-do-dono');
  const p = (await c('POST', '/api/products', product({ stock: 5 }))).data;
  const body = { items: [{ product_id: p.id, qty: 2 }], payment: 'pix', request_id: 'abc-123' };
  const r1 = await c('POST', '/api/sales', body);
  const r2 = await c('POST', '/api/sales', body);
  assert.equal(r1.status, 201);
  assert.equal(r2.status, 200);
  assert.equal(r2.data.duplicate, true);
  assert.equal(r1.data.sale.id, r2.data.sale.id);
  assert.equal((await c('GET', '/api/products')).data[0].stock, 3);
});

test('duas vendas simultâneas da última unidade: só uma passa', async t => {
  const { base } = await boot(t);
  const c = client(base);
  await c.login('dono', 'senha-do-dono');
  const p = (await c('POST', '/api/products', product({ stock: 1 }))).data;
  const go = () => c('POST', '/api/sales', { items: [{ product_id: p.id, qty: 1 }], payment: 'pix' });
  const res = await Promise.all([go(), go(), go()]);
  assert.deepEqual(res.map(r => r.status).sort(), [201, 409, 409]);
  assert.equal((await c('GET', '/api/products')).data[0].stock, 0);
});

test('virada de mês respeita o fuso de Fortaleza', async t => {
  const { base } = await boot(t);
  const c = client(base);
  await c.login('dono', 'senha-do-dono');
  const p = (await c('POST', '/api/products', product({ stock: 10 }))).data;
  const sell = () => c('POST', '/api/sales', { items: [{ product_id: p.id, qty: 1 }], payment: 'pix' });
  clock = Date.parse(`2026-09-30T23:30:00${BRT}`); // já é 01/10 em UTC
  await sell();
  clock = Date.parse(`2026-10-01T00:30:00${BRT}`);
  await sell();
  assert.equal((await c('GET', '/api/reports/month?month=2026-09')).data.kpis.count, 1);
  assert.equal((await c('GET', '/api/reports/month?month=2026-10')).data.kpis.count, 1);
  assert.equal((await c('GET', '/api/reports/month?month=2026-09')).data.days[29].revenue, 1890);
  assert.equal((await c('GET', '/api/sales?month=2026-09')).data.length, 1);
  clock = Date.parse(`2026-10-10T12:00:00${BRT}`);
});

test('caixa: permissões e dados sensíveis', async t => {
  const { base } = await boot(t);
  const dono = client(base);
  await dono.login('dono', 'senha-do-dono');
  const p = (await dono('POST', '/api/products', product())).data;
  assert.equal((await dono('POST', '/api/users', { name: 'Maria', username: 'maria', password: 'curta', role: 'caixa' })).status, 400);
  assert.equal((await dono('POST', '/api/users', { name: 'Maria', username: 'maria', password: 'senha-da-maria', role: 'caixa' })).status, 201);
  assert.equal((await dono('POST', '/api/users', { name: 'Outra', username: 'MARIA', password: 'senha-da-maria', role: 'caixa' })).status, 409);

  const cx = client(base);
  assert.equal((await cx.login('maria', 'senha-da-maria')).status, 200);
  const list = (await cx('GET', '/api/products')).data;
  assert.equal(list.length, 1);
  assert.ok(!('cost' in list[0]), 'caixa não pode ver custo');

  assert.equal((await cx('POST', '/api/products', product())).status, 403);
  assert.equal((await cx('PUT', `/api/products/${p.id}`, product())).status, 403);
  assert.equal((await cx('DELETE', `/api/products/${p.id}`)).status, 403);
  assert.equal((await cx('POST', `/api/products/${p.id}/restock`, { qty: 5 })).status, 403);
  assert.equal((await cx('GET', '/api/reports/month?month=2026-10')).status, 403);
  assert.equal((await cx('GET', '/api/users')).status, 403);
  assert.equal((await cx('GET', '/api/backup')).status, 403);
  assert.equal((await cx('GET', '/api/export/sales.csv?month=2026-10')).status, 403);

  const s = await cx('POST', '/api/sales', { items: [{ product_id: p.id, qty: 1 }], payment: 'pix' });
  assert.equal(s.status, 201);
  assert.ok(!('profit' in s.data.sale) && !('cost' in s.data.sale), 'caixa não vê lucro');
  assert.ok(!('cost' in s.data.sale.items[0]));
  assert.equal((await cx('POST', `/api/sales/${s.data.sale.id}/cancel`, {})).status, 403);

  const mine = (await cx('GET', '/api/sales')).data;
  assert.equal(mine.length, 1);
  assert.ok(!('profit' in mine[0]));

  // desativar derruba a sessão do caixa
  const users = (await dono('GET', '/api/users')).data;
  const maria = users.find(u => u.username === 'maria');
  assert.equal((await dono('PUT', `/api/users/${maria.id}`, { active: false })).status, 200);
  assert.equal((await cx('GET', '/api/me')).status, 401);
  assert.equal((await client(base).login('maria', 'senha-da-maria')).status, 401);

  const self = users.find(u => u.username === 'dono');
  assert.equal((await dono('PUT', `/api/users/${self.id}`, { active: false })).status, 400);
  assert.equal((await dono('PUT', `/api/users/${self.id}`, { role: 'caixa' })).status, 400);
});

test('bloqueio após tentativas de login erradas', async t => {
  const { base } = await boot(t);
  const c = client(base);
  for (let i = 0; i < 5; i++) assert.equal((await c.login('dono', 'x' + i)).status, 401);
  assert.equal((await c.login('dono', 'senha-do-dono')).status, 429);
  clock += 6 * 60 * 1000;
  assert.equal((await c.login('dono', 'senha-do-dono')).status, 200);
});

test('sessão expira e troca de senha', async t => {
  const { base } = await boot(t);
  const c = client(base);
  await c.login('dono', 'senha-do-dono');
  assert.equal((await c('POST', '/api/me/password', { current: 'errada', next: 'nova-senha-123' })).status, 400);
  assert.equal((await c('POST', '/api/me/password', { current: 'senha-do-dono', next: 'curta' })).status, 400);
  assert.equal((await c('POST', '/api/me/password', { current: 'senha-do-dono', next: 'nova-senha-123' })).status, 200);
  assert.equal((await c('GET', '/api/me')).status, 200); // a sessão atual continua
  assert.equal((await client(base).login('dono', 'senha-do-dono')).status, 401);
  assert.equal((await client(base).login('dono', 'nova-senha-123')).status, 200);
  clock += 13 * 3600 * 1000;
  assert.equal((await c('GET', '/api/me')).status, 401);
  clock -= 13 * 3600 * 1000;
});

test('produtos: edição, entrada, código único, exclusão e categorias', async t => {
  const { base } = await boot(t);
  const c = client(base);
  await c.login('dono', 'senha-do-dono');
  const a = (await c('POST', '/api/products', product({ code: '789' }))).data;
  assert.equal((await c('POST', '/api/products', product({ name: 'Outro', code: '789' }))).status, 409);
  assert.equal((await c('POST', '/api/products', product({ price: 0 }))).status, 400);
  assert.equal((await c('POST', '/api/products', product({ cost: -1 }))).status, 400);
  assert.equal((await c('POST', '/api/products', product({ name: '  ' }))).status, 400);

  const up = await c('PUT', `/api/products/${a.id}`, product({ code: '789', price: 2000, stock: 7 }));
  assert.equal(up.data.price, 2000);
  assert.equal(up.data.stock, 7);
  const re = await c('POST', `/api/products/${a.id}/restock`, { qty: 5, cost: 1300 });
  assert.equal(re.data.stock, 12);
  assert.equal(re.data.cost, 1300);
  assert.equal((await c('POST', `/api/products/${a.id}/restock`, { qty: 0 })).status, 400);

  // venda antiga guarda preço e custo da época
  const s = (await c('POST', '/api/sales', { items: [{ product_id: a.id, qty: 1 }], payment: 'pix' })).data.sale;
  await c('PUT', `/api/products/${a.id}`, product({ code: '789', price: 5000, cost: 4000, stock: 11 }));
  const old = (await c('GET', '/api/sales?month=2026-10')).data.find(x => x.id === s.id);
  assert.equal(old.items[0].price, 2000);
  assert.equal(old.profit, 2000 - 1300);

  const cats = (await c('GET', '/api/categories')).data;
  const merc = cats.find(x => x.name === 'Mercearia');
  assert.equal((await c('DELETE', `/api/categories/${merc.id}`)).status, 409);
  assert.equal((await c('POST', '/api/categories', { name: 'mercearia' })).status, 409);
  assert.equal((await c('POST', '/api/categories', { name: 'Pet' })).status, 201);

  assert.equal((await c('DELETE', `/api/products/${a.id}`)).status, 200);
  assert.equal((await c('GET', '/api/products')).data.length, 0);
  assert.equal((await c('POST', '/api/products', product({ code: '789' }))).status, 201); // código liberado
  assert.equal((await c('GET', '/api/sales?month=2026-10')).data.length, 1); // histórico preservado
});

test('backup, CSV e validações de entrada', async t => {
  const { base } = await boot(t);
  const c = client(base);
  await c.login('dono', 'senha-do-dono');
  const p = (await c('POST', '/api/products', product({ name: 'Item; "aspas"' }))).data;
  await c('POST', '/api/sales', { items: [{ product_id: p.id, qty: 1 }], payment: 'pix' });

  const csv = await fetch(`${base}/api/export/sales.csv?month=2026-10`, { headers: { Cookie: `sid=${''}` } });
  assert.equal(csv.status, 401); // sem cookie
  const authed = await c('GET', '/api/export/sales.csv?month=2026-10');
  assert.equal(authed.status, 200);
  assert.ok(authed.data.startsWith('Venda;Data;Hora'));
  const raw = new Uint8Array(await (await fetch(`${base}/api/export/sales.csv?month=2026-10`, { headers: { Cookie: `sid=${c.sid()}` } })).arrayBuffer());
  assert.deepEqual([...raw.slice(0, 3)], [0xef, 0xbb, 0xbf], 'CSV precisa de BOM para o Excel abrir acentos');
  assert.ok(authed.data.includes('"Item; ""aspas"""'));

  const bk = await c('GET', '/api/backup');
  assert.equal(bk.status, 200);
  assert.ok(String(bk.data).length > 0);

  assert.equal((await c('GET', '/api/reports/month?month=2026-13')).status, 400);
  assert.equal((await c('GET', '/api/reports/month')).status, 400);
  assert.equal((await c('GET', '/api/nao-existe')).status, 404);
  const bad = await fetch(`${base}/api/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{quebrado' });
  assert.equal(bad.status, 400);
  const evil = await fetch(`${base}/api/login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Origin: 'https://evil.example' },
    body: JSON.stringify({ username: 'dono', password: 'senha-do-dono' }),
  });
  assert.equal(evil.status, 403);
});

test('logout encerra a sessão no servidor', async t => {
  const { base } = await boot(t);
  const c = client(base);
  await c.login('dono', 'senha-do-dono');
  const sid = c.sid();
  assert.equal((await c('POST', '/api/logout')).status, 200);
  const reused = await fetch(`${base}/api/me`, { headers: { Cookie: `sid=${sid}` } });
  assert.equal(reused.status, 401, 'token antigo não vale mais');
});

test('estoque: ajuste na edição e entrada ficam no histórico; custo = último preço de compra', async t => {
  const { base } = await boot(t);
  const c = client(base);
  await c.login('dono', 'senha-do-dono');
  const p = (await c('POST', '/api/products', product({ stock: 10 }))).data;
  await c('PUT', `/api/products/${p.id}`, product({ stock: 7 }));
  const re = await c('POST', `/api/products/${p.id}/restock`, { qty: 5 }); // sem custo: mantém o atual
  assert.equal(re.data.cost, 1250);
  const re2 = await c('POST', `/api/products/${p.id}/restock`, { qty: 1, cost: 1400 });
  assert.equal(re2.data.cost, 1400);
  assert.equal(re2.data.stock, 13);
  const mov = (await c('GET', `/api/products/${p.id}/movements`)).data.movements;
  assert.deepEqual(mov.map(m => [m.type, m.qty]), [['entrada', 1], ['entrada', 5], ['ajuste', -3], ['inicial', 10]]);
  assert.ok(mov.every(m => typeof m.at === 'number' && m.user === 'Dono'));
  // soma do histórico = estoque atual
  assert.equal(mov.reduce((s, m) => s + m.qty, 0), 13);
  assert.equal((await c('POST', `/api/products/${p.id}/restock`, { qty: 1, cost: -5 })).status, 400);
  assert.equal((await c('GET', '/api/products/abc/movements')).status, 404);
  assert.equal((await c('POST', '/api/sales/abc/cancel', {})).status, 404);
});

test('caixa só vê as próprias vendas do dia', async t => {
  const { base } = await boot(t);
  const dono = client(base);
  await dono.login('dono', 'senha-do-dono');
  const p = (await dono('POST', '/api/products', product({ stock: 10 }))).data;
  await dono('POST', '/api/users', { name: 'Ana', username: 'ana', password: 'senha-da-ana', role: 'caixa' });
  const ana = client(base);
  await ana.login('ana', 'senha-da-ana');
  const sell = c => c('POST', '/api/sales', { items: [{ product_id: p.id, qty: 1 }], payment: 'pix' });
  clock = Date.parse(`2026-10-09T12:00:00${BRT}`);
  await sell(ana); // ontem
  clock = Date.parse(`2026-10-10T12:00:00${BRT}`);
  await sell(ana);
  await sell(dono);
  const mine = (await ana('GET', '/api/sales?month=2026-09')).data; // mês é ignorado para o caixa
  assert.equal(mine.length, 1);
  assert.equal(mine[0].user, 'Ana');
  assert.equal((await dono('GET', '/api/sales?month=2026-10')).data.length, 3);
});

test('mesma venda reenviada ao mesmo tempo: grava uma só vez', async t => {
  const { base } = await boot(t);
  const c = client(base);
  await c.login('dono', 'senha-do-dono');
  const p = (await c('POST', '/api/products', product({ stock: 5 }))).data;
  const body = { items: [{ product_id: p.id, qty: 1 }], payment: 'pix', request_id: 'mesma-venda' };
  const res = await Promise.all([1, 2, 3, 4].map(() => c('POST', '/api/sales', body)));
  assert.deepEqual(res.map(r => r.status).sort(), [200, 200, 200, 201]);
  assert.equal(new Set(res.map(r => r.data.sale.id)).size, 1);
  assert.equal((await c('GET', '/api/products')).data[0].stock, 4);
});

test('vários caixas ao mesmo tempo: estoque e numeração consistentes', async t => {
  const { base } = await boot(t);
  const dono = client(base);
  await dono.login('dono', 'senha-do-dono');
  const a = (await dono('POST', '/api/products', product({ name: 'A', stock: 6 }))).data;
  const b = (await dono('POST', '/api/products', product({ name: 'B', stock: 6 }))).data;
  const caixas = [];
  for (const u of ['cx1', 'cx2', 'cx3']) {
    await dono('POST', '/api/users', { name: u, username: u, password: 'senha-forte-1', role: 'caixa' });
    const c = client(base);
    await c.login(u, 'senha-forte-1');
    caixas.push(c);
  }
  // ordens invertidas de itens para provocar deadlock se as travas não forem ordenadas
  const jobs = [];
  for (let i = 0; i < 12; i++) {
    const items = i % 2 ? [{ product_id: a.id, qty: 1 }, { product_id: b.id, qty: 1 }] : [{ product_id: b.id, qty: 1 }, { product_id: a.id, qty: 1 }];
    jobs.push(caixas[i % 3]('POST', '/api/sales', { items, payment: 'pix' }));
  }
  jobs.push(dono('POST', `/api/products/${a.id}/restock`, { qty: 0 + 2 }));
  const res = await Promise.all(jobs);
  const sales = res.slice(0, 12);
  const ok = sales.filter(r => r.status === 201);
  assert.ok(sales.every(r => r.status === 201 || r.status === 409), sales.map(r => r.status).join());
  assert.equal(ok.length, 6, 'B só tem 6: exatamente 6 vendas passam');
  assert.deepEqual(ok.map(r => r.data.sale.number).sort((x, y) => x - y), [1, 2, 3, 4, 5, 6], 'numeração sem buracos nem repetição');
  const prods = (await dono('GET', '/api/products')).data;
  assert.equal(prods.find(p => p.id === a.id).stock, 2);
  assert.equal(prods.find(p => p.id === b.id).stock, 0);
  for (const p of [a, b]) {
    const mov = (await dono('GET', `/api/products/${p.id}/movements`)).data.movements;
    assert.equal(mov.reduce((s, m) => s + m.qty, 0), prods.find(x => x.id === p.id).stock, 'histórico bate com o estoque');
  }
});

test('cancelamento simultâneo da mesma venda devolve o estoque uma vez só', async t => {
  const { base } = await boot(t);
  const c = client(base);
  await c.login('dono', 'senha-do-dono');
  const p = (await c('POST', '/api/products', product({ stock: 5 }))).data;
  const s = (await c('POST', '/api/sales', { items: [{ product_id: p.id, qty: 3 }], discount: 500, payment: 'pix' })).data.sale;
  const res = await Promise.all([1, 2, 3].map(() => c('POST', `/api/sales/${s.id}/cancel`, { reason: 'cliente desistiu' })));
  assert.deepEqual(res.map(r => r.status).sort(), [200, 409, 409]);
  const done = res.find(r => r.status === 200).data;
  assert.equal(done.status, 'cancelada');
  assert.equal(done.cancel_reason, 'cliente desistiu');
  assert.equal((await c('GET', '/api/products')).data[0].stock, 5);
  const rep = (await c('GET', '/api/reports/month?month=2026-10')).data;
  assert.equal(rep.kpis.revenue, 0);
  assert.equal(rep.kpis.count, 0);
});

test('categoria criada duas vezes ao mesmo tempo: uma passa, outra 409', async t => {
  const { base } = await boot(t);
  const c = client(base);
  await c.login('dono', 'senha-do-dono');
  const res = await Promise.all([c('POST', '/api/categories', { name: 'Pet' }), c('POST', '/api/categories', { name: 'PET' })]);
  assert.deepEqual(res.map(r => r.status).sort(), [201, 409]);
});
