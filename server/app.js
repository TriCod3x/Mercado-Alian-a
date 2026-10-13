'use strict';
const express = require('express');
const {
  hashPassword, verifyPassword, DUMMY_HASH, newToken, hashToken, parseCookies,
} = require('./auth');
const { dumpDataset } = require('./dataset');

const SESSION_MS = 12 * 60 * 60 * 1000;
const TOUCH_MS = 5 * 60 * 1000;
const PAYMENTS = ['dinheiro', 'pix', 'debito', 'credito'];
const MAX_FAILS = 5;
const LOCK_MS = 5 * 60 * 1000;
// Trava (advisory lock) que enfileira vendas e cancelamentos: garante número de
// venda sequencial sem buracos e request_id sem corrida, como o BEGIN IMMEDIATE do SQLite.
const SALES_LOCK = 7428001;

class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}
const bad = m => new HttpError(400, m);
const isCents = v => Number.isSafeInteger(v) && v >= 0;
const str = (v, max) => String(v == null ? '' : v).trim().slice(0, max);
// ID de rota inválido vira 0 (não existe) em vez de erro de tipo no Postgres.
const idOf = v => { const n = Number(v); return Number.isSafeInteger(n) && n > 0 ? n : 0; };
const ms = d => (d == null ? null : d.getTime());

// Violações de UNIQUE que podem acontecer por corrida entre duas requisições.
const UNIQUE_MESSAGES = {
  ux_products_code: 'Já existe outro produto com esse código de barras.',
  ux_categories_name: 'Essa categoria já existe.',
  ux_users_username: 'Esse usuário já existe.',
};
const DB_DOWN = new Set(['ECONNREFUSED', 'ECONNRESET', 'ENOTFOUND', 'ETIMEDOUT', 'EAI_AGAIN', '57P01', '57P03', '53300', '57014', '55P03']);

// Converte quantidade decimal da API em milésimos inteiros, validando a unidade.
function toMilli(v, unit, label) {
  if (typeof v !== 'number' || !Number.isFinite(v)) throw bad(`${label} inválida.`);
  const m = Math.round(v * 1000);
  if (Math.abs(m / 1000 - v) > 1e-9) throw bad(`${label}: use no máximo 3 casas decimais.`);
  if (m < 0) throw bad(`${label} não pode ser negativa.`);
  if (unit === 'un' && m % 1000 !== 0) throw bad(`${label}: produto por unidade exige número inteiro.`);
  return m;
}

// Divide o desconto da venda entre os itens, proporcional ao valor, sem perder centavo.
function allocateDiscount(totals, discount, subtotal) {
  if (!discount) return totals.map(() => 0);
  const parts = totals.map(t => Math.floor((t * discount) / subtotal));
  let rest = discount - parts.reduce((a, b) => a + b, 0);
  const order = totals.map((_, i) => i).sort((a, b) => totals[b] - totals[a]);
  for (let k = 0; rest > 0; k = (k + 1) % order.length) { parts[order[k]]++; rest--; }
  return parts;
}

function createApp({ db, tzOffsetMin = -180, now = () => Date.now(), trustProxy = false, publicDir } = {}) {
  const app = express();
  app.disable('x-powered-by');
  if (trustProxy) app.set('trust proxy', 1);

  /* ---------- datas (fuso fixo, Brasil não tem horário de verão) ---------- */
  const localDate = ts => new Date(ts + tzOffsetMin * 60000);
  function monthRange(s) {
    if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(String(s || ''))) throw bad('Mês inválido (use AAAA-MM).');
    const [y, m] = s.split('-').map(Number);
    return {
      start: new Date(Date.UTC(y, m - 1, 1) - tzOffsetMin * 60000),
      end: new Date(Date.UTC(y, m, 1) - tzOffsetMin * 60000),
      days: new Date(Date.UTC(y, m, 0)).getUTCDate(),
    };
  }
  function todayRange() {
    const d = localDate(now());
    const start = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()) - tzOffsetMin * 60000;
    return { start: new Date(start), end: new Date(start + 86400000) };
  }

  /* ---------- acesso ao banco ---------- */
  const q = (sql, params) => db.query(sql, params);
  const one = async (sql, params) => (await db.query(sql, params))[0];

  /* ---------- middlewares gerais ---------- */
  app.use((req, res, next) => {
    res.set({
      'X-Content-Type-Options': 'nosniff',
      'X-Frame-Options': 'DENY',
      'Referrer-Policy': 'no-referrer',
      'Content-Security-Policy':
        "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
    });
    next();
  });
  app.use((req, res, next) => {
    if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return next();
    const origin = req.headers.origin;
    if (origin) {
      let ok = false;
      try { ok = new URL(origin).host === req.headers.host; } catch { /* inválido */ }
      if (!ok) return res.status(403).json({ error: 'Origem não permitida.' });
    }
    next();
  });
  app.use(express.json({ limit: '100kb' }));

  const wrap = fn => (req, res, next) => {
    try {
      const r = fn(req, res, next);
      if (r && typeof r.then === 'function') r.catch(next);
    } catch (e) { next(e); }
  };

  /* ---------- sessão ---------- */
  async function currentUser(req) {
    const sid = parseCookies(req.headers.cookie).sid;
    if (!sid) return null;
    const th = hashToken(sid);
    const row = await one(`SELECT s.expires_at, s.touched_at, u.id, u.name, u.username, u.role, u.active
      FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token_hash = $1`, [th]);
    if (!row) return null;
    const t = now();
    if (ms(row.expires_at) <= t || !row.active) {
      await q('DELETE FROM sessions WHERE token_hash = $1', [th]);
      return null;
    }
    if (t - ms(row.touched_at) > TOUCH_MS) {
      await q('UPDATE sessions SET touched_at = $1, expires_at = $2 WHERE token_hash = $3', [new Date(t), new Date(t + SESSION_MS), th]);
    }
    return { id: row.id, name: row.name, username: row.username, role: row.role, tokenHash: th };
  }
  const auth = wrap(async (req, res, next) => {
    const u = await currentUser(req);
    if (!u) return res.status(401).json({ error: 'Sessão expirada. Entre novamente.' });
    req.user = u;
    next();
  });
  const owner = (req, res, next) => (req.user.role === 'dono'
    ? next()
    : res.status(403).json({ error: 'Apenas o dono pode fazer isso.' }));
  const publicUser = u => ({ id: u.id, name: u.name, username: u.username, role: u.role });
  const body = req => (req.body && typeof req.body === 'object' && !Array.isArray(req.body) ? req.body : {});

  /* ---------- login ---------- */
  const fails = new Map();
  function lockInfo(key) {
    const f = fails.get(key);
    if (!f) return 0;
    if (f.until && f.until > now()) return f.until - now();
    if (f.until) fails.delete(key);
    return 0;
  }

  app.post('/api/login', wrap(async (req, res) => {
    const b = body(req);
    const username = str(b.username, 64).toLowerCase();
    const password = typeof b.password === 'string' ? b.password : '';
    if (!username || !password) throw bad('Informe usuário e senha.');
    const key = `${req.ip}|${username}`;
    const wait = lockInfo(key);
    if (wait) throw new HttpError(429, `Muitas tentativas. Tente de novo em ${Math.ceil(wait / 60000)} min.`);
    const u = await one('SELECT * FROM users WHERE username = $1', [username]);
    const ok = verifyPassword(password, u ? u.pass_hash : DUMMY_HASH) && u && u.active;
    if (!ok) {
      const f = fails.get(key) || { n: 0 };
      f.n++;
      if (f.n >= MAX_FAILS) { f.until = now() + LOCK_MS; f.n = 0; }
      fails.set(key, f);
      if (fails.size > 2000) fails.clear();
      throw new HttpError(401, 'Usuário ou senha incorretos.');
    }
    fails.delete(key);
    const token = newToken();
    const t = now();
    await q('INSERT INTO sessions(token_hash, user_id, expires_at, touched_at) VALUES ($1,$2,$3,$4)',
      [hashToken(token), u.id, new Date(t + SESSION_MS), new Date(t)]);
    await q('DELETE FROM sessions WHERE expires_at <= $1', [new Date(t)]);
    res.cookie('sid', token, { httpOnly: true, sameSite: 'lax', secure: req.secure, maxAge: SESSION_MS, path: '/' });
    res.json({ user: publicUser(u) });
  }));

  app.post('/api/logout', wrap(async (req, res) => {
    const sid = parseCookies(req.headers.cookie).sid;
    if (sid) await q('DELETE FROM sessions WHERE token_hash = $1', [hashToken(sid)]);
    res.clearCookie('sid', { path: '/' });
    res.json({ ok: true });
  }));

  app.get('/api/me', auth, (req, res) => res.json({ user: publicUser(req.user) }));

  app.post('/api/me/password', auth, wrap(async (req, res) => {
    const b = body(req);
    const u = await one('SELECT * FROM users WHERE id = $1', [req.user.id]);
    if (typeof b.current !== 'string' || !verifyPassword(b.current, u.pass_hash)) throw bad('Senha atual incorreta.');
    if (typeof b.next !== 'string' || b.next.length < 8 || b.next.length > 200) throw bad('A nova senha precisa ter pelo menos 8 caracteres.');
    const hash = hashPassword(b.next);
    await db.tx(async c => {
      await c.query('UPDATE users SET pass_hash = $1 WHERE id = $2', [hash, u.id]);
      await c.query('DELETE FROM sessions WHERE user_id = $1 AND token_hash <> $2', [u.id, req.user.tokenHash]);
    });
    res.json({ ok: true });
  }));

  /* ---------- categorias ---------- */
  const categoryJson = c => ({ id: c.id, name: c.name, products: c.products });
  const listCategories = async () => (await q(`SELECT c.id, c.name,
      (SELECT COUNT(*) FROM products p WHERE p.category_id = c.id AND p.active) AS products
    FROM categories c ORDER BY lower(c.name), c.id`)).map(categoryJson);

  app.get('/api/categories', auth, wrap(async (req, res) => res.json(await listCategories())));

  app.post('/api/categories', auth, owner, wrap(async (req, res) => {
    const name = str(body(req).name, 60);
    if (!name) throw bad('Digite o nome da categoria.');
    if (await one('SELECT 1 FROM categories WHERE lower(name) = lower($1)', [name])) throw new HttpError(409, 'Essa categoria já existe.');
    await q('INSERT INTO categories(name) VALUES ($1)', [name]);
    res.status(201).json(await listCategories());
  }));

  app.put('/api/categories/:id', auth, owner, wrap(async (req, res) => {
    const id = idOf(req.params.id);
    const name = str(body(req).name, 60);
    if (!name) throw bad('O nome não pode ficar vazio.');
    if (!await one('SELECT 1 FROM categories WHERE id = $1', [id])) throw new HttpError(404, 'Categoria não encontrada.');
    if (await one('SELECT 1 FROM categories WHERE lower(name) = lower($1) AND id <> $2', [name, id])) throw new HttpError(409, 'Já existe uma categoria com esse nome.');
    await q('UPDATE categories SET name = $1 WHERE id = $2', [name, id]);
    res.json(await listCategories());
  }));

  app.delete('/api/categories/:id', auth, owner, wrap(async (req, res) => {
    const id = idOf(req.params.id);
    if (!await one('SELECT 1 FROM categories WHERE id = $1', [id])) throw new HttpError(404, 'Categoria não encontrada.');
    if (await one('SELECT 1 FROM products WHERE category_id = $1 LIMIT 1', [id])) {
      throw new HttpError(409, 'Mova ou exclua os produtos dessa categoria antes de excluí-la.');
    }
    // Se um produto entrar na categoria entre a checagem e o DELETE, a FK barra.
    await q('DELETE FROM categories WHERE id = $1', [id]);
    res.json(await listCategories());
  }));

  /* ---------- produtos ---------- */
  const SELECT_PRODUCT = 'SELECT p.*, c.name AS category FROM products p JOIN categories c ON c.id = p.category_id';
  const productJson = (p, withCost) => {
    const o = {
      id: p.id, name: p.name, category: p.category, code: p.code || '', unit: p.unit,
      price: p.price_cents, stock: p.stock_milli / 1000, min: p.min_milli / 1000,
      low: p.stock_milli <= p.min_milli,
    };
    if (withCost) o.cost = p.cost_cents;
    return o;
  };
  const getProduct = id => one(`${SELECT_PRODUCT} WHERE p.id = $1 AND p.active`, [id]);
  const mustProduct = async id => {
    const p = await getProduct(id);
    if (!p) throw new HttpError(404, 'Produto não encontrado.');
    return p;
  };
  const logMove = (c, productId, type, qtyMilli, userId, note, saleId, t) =>
    c.query('INSERT INTO stock_movements(product_id, type, qty_milli, note, user_id, sale_id, created_at) VALUES ($1,$2,$3,$4,$5,$6,$7)',
      [productId, type, qtyMilli, note || null, userId, saleId || null, new Date(t)]);

  async function categoryId(c, name) {
    await c.query('INSERT INTO categories(name) VALUES ($1) ON CONFLICT ((lower(name))) DO NOTHING', [name]);
    return (await c.query('SELECT id FROM categories WHERE lower(name) = lower($1)', [name]))[0].id;
  }

  function parseProduct(b) {
    const name = str(b.name, 120);
    if (!name) throw bad('Informe o nome do produto.');
    const category = str(b.category, 60) || 'Outros';
    const code = str(b.code, 64) || null;
    if (b.unit !== 'un' && b.unit !== 'kg') throw bad('Unidade inválida.');
    if (!isCents(b.cost)) throw bad('Preço de compra inválido.');
    if (!Number.isSafeInteger(b.price) || b.price <= 0) throw bad('Preço de venda inválido.');
    return {
      name, category, code, unit: b.unit, cost: b.cost, price: b.price,
      stock: toMilli(b.stock, b.unit, 'Estoque'),
      min: toMilli(b.min == null ? 0 : b.min, b.unit, 'Estoque mínimo'),
    };
  }
  const codeTaken = async (code, exceptId) => code
    && !!await one('SELECT 1 FROM products WHERE code = $1 AND active AND id <> $2', [code, exceptId || 0]);

  app.get('/api/products', auth, wrap(async (req, res) => {
    const withCost = req.user.role === 'dono';
    res.json((await q(`${SELECT_PRODUCT} WHERE p.active ORDER BY lower(p.name), p.id`))
      .map(p => productJson(p, withCost)));
  }));

  app.post('/api/products', auth, owner, wrap(async (req, res) => {
    const p = parseProduct(body(req));
    if (await codeTaken(p.code)) throw new HttpError(409, 'Já existe outro produto com esse código de barras.');
    const t = now();
    const id = await db.tx(async c => {
      const [r] = await c.query(`INSERT INTO products(name, category_id, code, unit, cost_cents, price_cents, stock_milli, min_milli, created_at)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id`,
      [p.name, await categoryId(c, p.category), p.code, p.unit, p.cost, p.price, p.stock, p.min, new Date(t)]);
      if (p.stock > 0) await logMove(c, r.id, 'inicial', p.stock, req.user.id, 'Cadastro do produto', null, t);
      return r.id;
    });
    res.status(201).json(productJson(await getProduct(id), true));
  }));

  app.put('/api/products/:id', auth, owner, wrap(async (req, res) => {
    const old = await mustProduct(idOf(req.params.id));
    const p = parseProduct(body(req));
    if (await codeTaken(p.code, old.id)) throw new HttpError(409, 'Já existe outro produto com esse código de barras.');
    const t = now();
    await db.tx(async c => {
      // Relê o estoque com a linha travada: uma venda simultânea não some do ajuste.
      const [cur] = await c.query('SELECT stock_milli FROM products WHERE id = $1 AND active FOR UPDATE', [old.id]);
      if (!cur) throw new HttpError(404, 'Produto não encontrado.');
      await c.query(`UPDATE products SET name=$1, category_id=$2, code=$3, unit=$4, cost_cents=$5, price_cents=$6, stock_milli=$7, min_milli=$8 WHERE id=$9`,
        [p.name, await categoryId(c, p.category), p.code, p.unit, p.cost, p.price, p.stock, p.min, old.id]);
      if (p.stock !== cur.stock_milli) await logMove(c, old.id, 'ajuste', p.stock - cur.stock_milli, req.user.id, 'Ajuste manual no cadastro', null, t);
    });
    res.json(productJson(await getProduct(old.id), true));
  }));

  app.delete('/api/products/:id', auth, owner, wrap(async (req, res) => {
    const p = await mustProduct(idOf(req.params.id));
    // Exclusão lógica: vendas antigas continuam apontando para o produto.
    await q('UPDATE products SET active = false WHERE id = $1', [p.id]);
    res.json({ ok: true });
  }));

  app.post('/api/products/:id/restock', auth, owner, wrap(async (req, res) => {
    const p = await mustProduct(idOf(req.params.id));
    const b = body(req);
    const qty = toMilli(b.qty, p.unit, 'Quantidade');
    if (qty <= 0) throw bad('Informe a quantidade que chegou.');
    const cost = b.cost == null ? p.cost_cents : b.cost;
    if (!isCents(cost)) throw bad('Preço de compra inválido.');
    await db.tx(async c => {
      const r = await c.query('UPDATE products SET stock_milli = stock_milli + $1, cost_cents = $2 WHERE id = $3 AND active RETURNING id', [qty, cost, p.id]);
      if (!r.length) throw new HttpError(404, 'Produto não encontrado.');
      await logMove(c, p.id, 'entrada', qty, req.user.id, 'Entrada de mercadoria', null, now());
    });
    res.json(productJson(await getProduct(p.id), true));
  }));

  app.get('/api/products/:id/movements', auth, owner, wrap(async (req, res) => {
    const id = idOf(req.params.id);
    const p = await one('SELECT id, name, unit FROM products WHERE id = $1', [id]);
    if (!p) throw new HttpError(404, 'Produto não encontrado.');
    const rows = await q(`SELECT m.type, m.qty_milli, m.note, m.created_at, m.sale_id, u.name AS user_name, s.number AS sale_number
      FROM stock_movements m LEFT JOIN users u ON u.id = m.user_id LEFT JOIN sales s ON s.id = m.sale_id
      WHERE m.product_id = $1 ORDER BY m.created_at DESC, m.id DESC LIMIT 100`, [id]);
    res.json({
      product: { id: p.id, name: p.name, unit: p.unit },
      movements: rows.map(m => ({
        type: m.type, qty: m.qty_milli / 1000, note: m.note, at: ms(m.created_at),
        user: m.user_name, sale: m.sale_number,
      })),
    });
  }));

  /* ---------- vendas ---------- */
  const itemJson = (i, withCost) => {
    const o = {
      product_id: i.product_id, name: i.name, category: i.category, unit: i.unit,
      qty: i.qty_milli / 1000, price: i.price_cents, total: i.total_cents, discount: i.discount_cents,
    };
    if (withCost) { o.cost = i.cost_cents; o.cost_total = i.cost_total_cents; }
    return o;
  };
  const saleJson = (s, items, withCost) => {
    const o = {
      id: s.id, number: s.number, at: ms(s.created_at), user: s.user_name,
      subtotal: s.subtotal_cents, discount: s.discount_cents, total: s.total_cents,
      payment: s.payment, received: s.received_cents,
      change: s.received_cents == null ? null : s.received_cents - s.total_cents,
      status: s.status, cancel_reason: s.cancel_reason || null,
      items: items.map(i => itemJson(i, withCost)),
    };
    if (withCost) { o.cost = s.cost_cents; o.profit = s.total_cents - s.cost_cents; }
    return o;
  };
  const SELECT_SALE = 'SELECT s.*, u.name AS user_name FROM sales s JOIN users u ON u.id = s.user_id';
  const loadSale = async (id, withCost) => {
    const s = await one(`${SELECT_SALE} WHERE s.id = $1`, [id]);
    if (!s) return null;
    return saleJson(s, await q('SELECT * FROM sale_items WHERE sale_id = $1 ORDER BY id', [id]), withCost);
  };

  // Tudo numa transação só: valida, grava a venda, os itens, baixa o estoque
  // (condicional, nunca negativo) e registra o histórico. Qualquer erro desfaz tudo.
  const createSale = (user, b) => db.tx(async c => {
    await c.query('SELECT pg_advisory_xact_lock($1)', [SALES_LOCK]);
    const requestId = b.request_id == null ? null : str(b.request_id, 80);
    if (requestId) {
      const [dup] = await c.query('SELECT id FROM sales WHERE request_id = $1', [requestId]);
      if (dup) return { id: dup.id, duplicate: true };
    }
    if (!Array.isArray(b.items) || !b.items.length || b.items.length > 200) throw bad('A venda precisa ter pelo menos um item.');

    // Preço e custo vêm SEMPRE do banco; o cliente só diz produto e quantidade.
    // As linhas dos produtos ficam travadas (em ordem de id, sem deadlock) até o fim.
    const ids = [...new Set(b.items.filter(it => it && Number.isSafeInteger(it.product_id) && it.product_id > 0).map(it => it.product_id))];
    const found = new Map((await c.query(`${SELECT_PRODUCT} WHERE p.id = ANY($1::bigint[]) AND p.active ORDER BY p.id FOR UPDATE OF p`, [ids]))
      .map(p => [p.id, p]));
    const lines = new Map();
    for (const it of b.items) {
      if (!it || !Number.isSafeInteger(it.product_id)) throw bad('Item inválido.');
      const p = found.get(it.product_id);
      if (!p) throw new HttpError(409, 'Um dos produtos não existe mais. Atualize a tela e refaça a venda.');
      const milli = toMilli(it.qty, p.unit, `Quantidade de "${p.name}"`);
      if (milli <= 0) throw bad(`Quantidade de "${p.name}" deve ser maior que zero.`);
      const cur = lines.get(p.id);
      if (cur) cur.milli += milli; else lines.set(p.id, { p, milli });
    }
    const list = [...lines.values()];
    for (const { p, milli } of list) {
      if (milli > p.stock_milli) {
        throw new HttpError(409, `Estoque insuficiente de "${p.name}" (disponível: ${p.stock_milli / 1000} ${p.unit}).`);
      }
    }
    const totals = list.map(({ p, milli }) => Math.round((p.price_cents * milli) / 1000));
    const costs = list.map(({ p, milli }) => Math.round((p.cost_cents * milli) / 1000));
    const subtotal = totals.reduce((a, x) => a + x, 0);
    if (subtotal > 1e9) throw bad('Valor da venda acima do limite.');
    const discount = b.discount == null ? 0 : b.discount;
    if (!isCents(discount) || discount > subtotal) throw bad('Desconto inválido (não pode passar do subtotal).');
    const total = subtotal - discount;
    if (total <= 0) throw bad('O total da venda precisa ser maior que zero.');
    if (!PAYMENTS.includes(b.payment)) throw bad('Forma de pagamento inválida.');
    let received = null;
    if (b.payment === 'dinheiro' && b.received != null) {
      if (!isCents(b.received) || b.received < total) throw bad('Valor recebido menor que o total.');
      received = b.received;
    }
    const discounts = allocateDiscount(totals, discount, subtotal);
    const t = new Date(now());
    const [{ n: number }] = await c.query('SELECT COALESCE(MAX(number), 0) + 1 AS n FROM sales');
    const [sale] = await c.query(`INSERT INTO sales(number, request_id, user_id, created_at, subtotal_cents, discount_cents, total_cents, cost_cents, payment, received_cents)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING id`,
    [number, requestId, user.id, t, subtotal, discount, total, costs.reduce((a, x) => a + x, 0), b.payment, received]);
    const col = f => list.map(f);
    await c.query(`INSERT INTO sale_items(sale_id, product_id, name, category, unit, qty_milli, price_cents, cost_cents, total_cents, discount_cents, cost_total_cents)
      SELECT $1, product_id, name, category, unit, qty, price, cost, total, discount, cost_total
      FROM unnest($2::bigint[], $3::text[], $4::text[], $5::text[], $6::bigint[], $7::bigint[], $8::bigint[], $9::bigint[], $10::bigint[], $11::bigint[])
      WITH ORDINALITY AS x(product_id, name, category, unit, qty, price, cost, total, discount, cost_total, ord) ORDER BY ord`,
    [sale.id, col(l => l.p.id), col(l => l.p.name), col(l => l.p.category), col(l => l.p.unit), col(l => l.milli),
      col(l => l.p.price_cents), col(l => l.p.cost_cents), totals, discounts, costs]);
    const updated = await c.query(`UPDATE products p SET stock_milli = p.stock_milli - x.qty
      FROM unnest($1::bigint[], $2::bigint[]) AS x(id, qty)
      WHERE p.id = x.id AND p.stock_milli >= x.qty RETURNING p.id`, [col(l => l.p.id), col(l => l.milli)]);
    if (updated.length !== list.length) {
      const miss = list.find(l => !updated.some(u => u.id === l.p.id));
      throw new HttpError(409, `Estoque insuficiente de "${miss.p.name}".`);
    }
    await c.query(`INSERT INTO stock_movements(product_id, type, qty_milli, user_id, sale_id, created_at)
      SELECT x.id, 'venda', -x.qty, $3, $4, $5 FROM unnest($1::bigint[], $2::bigint[]) WITH ORDINALITY AS x(id, qty, ord) ORDER BY ord`,
    [col(l => l.p.id), col(l => l.milli), user.id, sale.id, t]);
    return { id: sale.id, duplicate: false };
  });

  app.post('/api/sales', auth, wrap(async (req, res) => {
    const r = await createSale(req.user, body(req));
    res.status(r.duplicate ? 200 : 201).json({ sale: await loadSale(r.id, req.user.role === 'dono'), duplicate: r.duplicate });
  }));

  app.get('/api/sales', auth, wrap(async (req, res) => {
    const isOwner = req.user.role === 'dono';
    const range = isOwner ? monthRange(req.query.month) : todayRange();
    const filter = isOwner ? '' : ' AND s.user_id = $3';
    const params = isOwner ? [range.start, range.end] : [range.start, range.end, req.user.id];
    const sales = await q(`${SELECT_SALE} WHERE s.created_at >= $1 AND s.created_at < $2${filter} ORDER BY s.created_at DESC, s.id DESC`, params);
    const items = await q(`SELECT si.* FROM sale_items si JOIN sales s ON s.id = si.sale_id
      WHERE s.created_at >= $1 AND s.created_at < $2${filter} ORDER BY si.id`, params);
    const bySale = new Map();
    items.forEach(i => { if (!bySale.has(i.sale_id)) bySale.set(i.sale_id, []); bySale.get(i.sale_id).push(i); });
    res.json(sales.map(s => saleJson(s, bySale.get(s.id) || [], isOwner)));
  }));

  const cancelSale = (user, id, reason) => db.tx(async c => {
    await c.query('SELECT pg_advisory_xact_lock($1)', [SALES_LOCK]);
    const [s] = await c.query('SELECT * FROM sales WHERE id = $1 FOR UPDATE', [id]);
    if (!s) throw new HttpError(404, 'Venda não encontrada.');
    if (s.status === 'cancelada') throw new HttpError(409, 'Essa venda já foi cancelada.');
    const t = new Date(now());
    await c.query(`UPDATE sales SET status = 'cancelada', cancelled_at = $1, cancelled_by = $2, cancel_reason = $3 WHERE id = $4 AND status = 'ok'`,
      [t, user.id, reason || null, id]);
    const items = await c.query('SELECT product_id, SUM(qty_milli) AS qty FROM sale_items WHERE sale_id = $1 GROUP BY product_id ORDER BY product_id', [id]);
    const pids = items.map(i => i.product_id);
    const qtys = items.map(i => i.qty);
    await c.query('SELECT id FROM products WHERE id = ANY($1::bigint[]) ORDER BY id FOR UPDATE', [pids]);
    await c.query(`UPDATE products p SET stock_milli = p.stock_milli + x.qty
      FROM unnest($1::bigint[], $2::bigint[]) AS x(id, qty) WHERE p.id = x.id`, [pids, qtys]);
    await c.query(`INSERT INTO stock_movements(product_id, type, qty_milli, note, user_id, sale_id, created_at)
      SELECT x.id, 'cancelamento', x.qty, $3, $4, $5, $6 FROM unnest($1::bigint[], $2::bigint[]) WITH ORDINALITY AS x(id, qty, ord) ORDER BY ord`,
    [pids, qtys, `Cancelamento da venda #${s.number}`, user.id, id, t]);
  });

  app.post('/api/sales/:id/cancel', auth, owner, wrap(async (req, res) => {
    const id = idOf(req.params.id);
    await cancelSale(req.user, id, str(body(req).reason, 200));
    res.json(await loadSale(id, true));
  }));

  /* ---------- relatório do mês ---------- */
  app.get('/api/reports/month', auth, owner, wrap(async (req, res) => {
    const r = monthRange(req.query.month);
    const params = [r.start, r.end];
    const sales = await q(`SELECT total_cents, cost_cents, payment, created_at FROM sales
      WHERE status = 'ok' AND created_at >= $1 AND created_at < $2`, params);
    let revenue = 0; let cost = 0;
    const days = Array.from({ length: r.days }, () => ({ revenue: 0, profit: 0 }));
    const byPay = {};
    for (const s of sales) {
      revenue += s.total_cents; cost += s.cost_cents;
      const d = days[localDate(ms(s.created_at)).getUTCDate() - 1];
      d.revenue += s.total_cents; d.profit += s.total_cents - s.cost_cents;
      const bp = byPay[s.payment] || (byPay[s.payment] = { payment: s.payment, count: 0, revenue: 0 });
      bp.count++; bp.revenue += s.total_cents;
    }
    const grouped = col => q(`SELECT ${col} AS k, MAX(si.name) AS name, MAX(si.unit) AS unit, SUM(si.qty_milli) AS qty_milli,
        SUM(si.total_cents - si.discount_cents) AS revenue, SUM(si.cost_total_cents) AS cost
      FROM sale_items si JOIN sales s ON s.id = si.sale_id
      WHERE s.status = 'ok' AND s.created_at >= $1 AND s.created_at < $2
      GROUP BY ${col}
      ORDER BY (SUM(si.total_cents - si.discount_cents) - SUM(si.cost_total_cents)) DESC, ${col}`, params);
    const top = (await grouped('si.product_id')).slice(0, 10).map(x => ({
      name: x.name, unit: x.unit, qty: x.qty_milli / 1000, revenue: x.revenue, profit: x.revenue - x.cost,
    }));
    const categories = (await grouped('si.category')).map(x => ({ name: x.k, revenue: x.revenue, profit: x.revenue - x.cost }));
    const low = (await q(`${SELECT_PRODUCT} WHERE p.active AND p.stock_milli <= p.min_milli ORDER BY p.stock_milli, lower(p.name), p.id`))
      .map(p => productJson(p, true));
    const profit = revenue - cost;
    res.json({
      month: req.query.month,
      kpis: {
        profit, revenue, cost, count: sales.length,
        margin: revenue > 0 ? profit / revenue : 0,
        ticket: sales.length ? Math.round(revenue / sales.length) : 0,
      },
      days,
      top,
      categories,
      payments: Object.values(byPay).sort((a, b) => b.revenue - a.revenue),
      low,
    });
  }));

  /* ---------- usuários ---------- */
  const userRow = u => ({ id: u.id, name: u.name, username: u.username, role: u.role, active: !!u.active });
  const listUsers = async () => (await q('SELECT id, name, username, role, active FROM users ORDER BY active DESC, lower(name), id')).map(userRow);
  const checkPassword = p => {
    if (typeof p !== 'string' || p.length < 8 || p.length > 200) throw bad('A senha precisa ter pelo menos 8 caracteres.');
  };

  app.get('/api/users', auth, owner, wrap(async (req, res) => res.json(await listUsers())));

  app.post('/api/users', auth, owner, wrap(async (req, res) => {
    const b = body(req);
    const name = str(b.name, 80);
    const username = str(b.username, 32).toLowerCase();
    if (!name) throw bad('Informe o nome.');
    if (!/^[a-z0-9._-]{3,32}$/.test(username)) throw bad('Usuário: 3 a 32 caracteres (letras, números, ponto, hífen ou sublinhado).');
    if (b.role !== 'dono' && b.role !== 'caixa') throw bad('Perfil inválido.');
    checkPassword(b.password);
    if (await one('SELECT 1 FROM users WHERE username = $1', [username])) throw new HttpError(409, 'Esse usuário já existe.');
    await q('INSERT INTO users(name, username, pass_hash, role, created_at) VALUES ($1,$2,$3,$4,$5)',
      [name, username, hashPassword(b.password), b.role, new Date(now())]);
    res.status(201).json(await listUsers());
  }));

  app.put('/api/users/:id', auth, owner, wrap(async (req, res) => {
    const id = idOf(req.params.id);
    const b = body(req);
    const u = await one('SELECT * FROM users WHERE id = $1', [id]);
    if (!u) throw new HttpError(404, 'Usuário não encontrado.');
    const name = b.name === undefined ? u.name : str(b.name, 80);
    const role = b.role === undefined ? u.role : b.role;
    const active = b.active === undefined ? u.active : !!b.active;
    if (!name) throw bad('Informe o nome.');
    if (role !== 'dono' && role !== 'caixa') throw bad('Perfil inválido.');
    if (id === req.user.id && (role !== 'dono' || !active)) throw bad('Você não pode rebaixar ou desativar a própria conta.');
    if (b.password !== undefined) checkPassword(b.password);
    const hash = b.password !== undefined ? hashPassword(b.password) : null;
    await db.tx(async c => {
      await c.query('UPDATE users SET name = $1, role = $2, active = $3 WHERE id = $4', [name, role, active, id]);
      if (hash) await c.query('UPDATE users SET pass_hash = $1 WHERE id = $2', [hash, id]);
      if (hash || !active || role !== u.role) await c.query('DELETE FROM sessions WHERE user_id = $1', [id]);
    });
    res.json(await listUsers());
  }));

  /* ---------- backup e exportação ---------- */
  // Cópia completa e consistente (uma única transação de leitura) em JSON.
  // Restaurar: scripts/restore.js (veja o README).
  app.get('/api/backup', auth, owner, wrap(async (req, res) => {
    const data = await db.tx(c => dumpDataset(c));
    const d = localDate(now()).toISOString().slice(0, 10);
    res.set({
      'Content-Type': 'application/json; charset=utf-8',
      'Content-Disposition': `attachment; filename="alianca-backup-${d}.json"`,
      'Cache-Control': 'no-store',
    });
    res.send(JSON.stringify(data));
  }));

  const csvCell = v => {
    const s = String(v == null ? '' : v);
    return /[;"\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const dec = c => (c / 100).toFixed(2).replace('.', ',');

  app.get('/api/export/sales.csv', auth, owner, wrap(async (req, res) => {
    const r = monthRange(req.query.month);
    const rows = await q(`SELECT s.number, s.created_at, s.status, s.payment, s.discount_cents, s.total_cents, u.name AS operator,
        si.name, si.category, si.qty_milli, si.price_cents, si.cost_cents
      FROM sales s JOIN users u ON u.id = s.user_id JOIN sale_items si ON si.sale_id = s.id
      WHERE s.created_at >= $1 AND s.created_at < $2 ORDER BY s.created_at, s.id, si.id`, [r.start, r.end]);
    const out = [['Venda', 'Data', 'Hora', 'Status', 'Operador', 'Produto', 'Categoria', 'Qtd', 'Preço unit.', 'Custo unit.', 'Pagamento', 'Desconto da venda', 'Total da venda']];
    for (const x of rows) {
      const d = localDate(ms(x.created_at)).toISOString();
      out.push([
        x.number, d.slice(0, 10).split('-').reverse().join('/'), d.slice(11, 16),
        x.status === 'ok' ? 'Concluída' : 'Cancelada', x.operator, x.name, x.category,
        String(x.qty_milli / 1000).replace('.', ','), dec(x.price_cents), dec(x.cost_cents),
        x.payment, dec(x.discount_cents), dec(x.total_cents),
      ]);
    }
    res.set({
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': `attachment; filename="alianca-vendas-${req.query.month}.csv"`,
    });
    res.send('﻿' + out.map(l => l.map(csvCell).join(';')).join('\r\n'));
  }));

  /* ---------- estáticos, 404 e erros ---------- */
  app.get('/healthz', (req, res) => res.json({ ok: true }));
  app.use('/api', (req, res) => res.status(404).json({ error: 'Rota não encontrada.' }));
  if (publicDir) {
    app.use(express.static(publicDir, { setHeaders: res => res.set('Cache-Control', 'no-cache') }));
  }
  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    if (err instanceof HttpError) return res.status(err.status).json({ error: err.message });
    if (err && (err.type === 'entity.parse.failed' || err.status === 400)) return res.status(400).json({ error: 'Requisição inválida.' });
    if (err && err.status === 413) return res.status(413).json({ error: 'Requisição grande demais.' });
    if (err && err.code === '23505') {
      return res.status(409).json({ error: UNIQUE_MESSAGES[err.constraint] || 'Registro duplicado. Atualize a tela e tente de novo.' });
    }
    console.error(err);
    if (err && (DB_DOWN.has(err.code) || /Connection terminated|timeout exceeded when trying to connect/i.test(err.message || ''))) {
      return res.status(503).json({ error: 'Banco de dados indisponível no momento. Tente de novo em instantes.' });
    }
    res.status(500).json({ error: 'Erro interno do servidor.' });
  });

  return app;
}

module.exports = { createApp };
