'use strict';
const express = require('express');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  hashPassword, verifyPassword, DUMMY_HASH, newToken, hashToken, parseCookies,
} = require('./auth');

const SESSION_MS = 12 * 60 * 60 * 1000;
const TOUCH_MS = 5 * 60 * 1000;
const PAYMENTS = ['dinheiro', 'pix', 'debito', 'credito'];
const MAX_FAILS = 5;
const LOCK_MS = 5 * 60 * 1000;

class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}
const bad = m => new HttpError(400, m);
const isCents = v => Number.isSafeInteger(v) && v >= 0;
const str = (v, max) => String(v == null ? '' : v).trim().slice(0, max);

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
      start: Date.UTC(y, m - 1, 1) - tzOffsetMin * 60000,
      end: Date.UTC(y, m, 1) - tzOffsetMin * 60000,
      days: new Date(Date.UTC(y, m, 0)).getUTCDate(),
    };
  }
  function todayRange() {
    const d = localDate(now());
    const start = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()) - tzOffsetMin * 60000;
    return { start, end: start + 86400000 };
  }

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
  const qSession = db.prepare(`SELECT s.expires_at, s.touched_at, u.id, u.name, u.username, u.role, u.active
    FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token_hash = ?`);

  function currentUser(req) {
    const sid = parseCookies(req.headers.cookie).sid;
    if (!sid) return null;
    const th = hashToken(sid);
    const row = qSession.get(th);
    if (!row) return null;
    const t = now();
    if (row.expires_at <= t || !row.active) {
      db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(th);
      return null;
    }
    if (t - row.touched_at > TOUCH_MS) {
      db.prepare('UPDATE sessions SET touched_at = ?, expires_at = ? WHERE token_hash = ?').run(t, t + SESSION_MS, th);
    }
    return { id: row.id, name: row.name, username: row.username, role: row.role, tokenHash: th };
  }
  const auth = (req, res, next) => {
    const u = currentUser(req);
    if (!u) return res.status(401).json({ error: 'Sessão expirada. Entre novamente.' });
    req.user = u;
    next();
  };
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

  app.post('/api/login', wrap((req, res) => {
    const b = body(req);
    const username = str(b.username, 64).toLowerCase();
    const password = typeof b.password === 'string' ? b.password : '';
    if (!username || !password) throw bad('Informe usuário e senha.');
    const key = `${req.ip}|${username}`;
    const wait = lockInfo(key);
    if (wait) throw new HttpError(429, `Muitas tentativas. Tente de novo em ${Math.ceil(wait / 60000)} min.`);
    const u = db.prepare('SELECT * FROM users WHERE username = ?').get(username);
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
    db.prepare('INSERT INTO sessions(token_hash, user_id, expires_at, touched_at) VALUES (?,?,?,?)')
      .run(hashToken(token), u.id, t + SESSION_MS, t);
    db.prepare('DELETE FROM sessions WHERE expires_at <= ?').run(t);
    res.cookie('sid', token, { httpOnly: true, sameSite: 'lax', secure: req.secure, maxAge: SESSION_MS, path: '/' });
    res.json({ user: publicUser(u) });
  }));

  app.post('/api/logout', wrap((req, res) => {
    const sid = parseCookies(req.headers.cookie).sid;
    if (sid) db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(hashToken(sid));
    res.clearCookie('sid', { path: '/' });
    res.json({ ok: true });
  }));

  app.get('/api/me', auth, (req, res) => res.json({ user: publicUser(req.user) }));

  app.post('/api/me/password', auth, wrap((req, res) => {
    const b = body(req);
    const u = db.prepare('SELECT * FROM users WHERE id = ?').get(req.user.id);
    if (typeof b.current !== 'string' || !verifyPassword(b.current, u.pass_hash)) throw bad('Senha atual incorreta.');
    if (typeof b.next !== 'string' || b.next.length < 8 || b.next.length > 200) throw bad('A nova senha precisa ter pelo menos 8 caracteres.');
    db.transaction(() => {
      db.prepare('UPDATE users SET pass_hash = ? WHERE id = ?').run(hashPassword(b.next), u.id);
      db.prepare('DELETE FROM sessions WHERE user_id = ? AND token_hash != ?').run(u.id, req.user.tokenHash);
    })();
    res.json({ ok: true });
  }));

  /* ---------- categorias ---------- */
  const categoryJson = c => ({ id: c.id, name: c.name, products: c.products });
  const listCategories = () => db.prepare(`SELECT c.id, c.name,
      (SELECT COUNT(*) FROM products p WHERE p.category_id = c.id AND p.active = 1) AS products
    FROM categories c ORDER BY c.name COLLATE NOCASE`).all().map(categoryJson);

  app.get('/api/categories', auth, (req, res) => res.json(listCategories()));

  app.post('/api/categories', auth, owner, wrap((req, res) => {
    const name = str(body(req).name, 60);
    if (!name) throw bad('Digite o nome da categoria.');
    if (db.prepare('SELECT 1 FROM categories WHERE name = ?').get(name)) throw new HttpError(409, 'Essa categoria já existe.');
    db.prepare('INSERT INTO categories(name) VALUES (?)').run(name);
    res.status(201).json(listCategories());
  }));

  app.put('/api/categories/:id', auth, owner, wrap((req, res) => {
    const id = Number(req.params.id);
    const name = str(body(req).name, 60);
    if (!name) throw bad('O nome não pode ficar vazio.');
    if (!db.prepare('SELECT 1 FROM categories WHERE id = ?').get(id)) throw new HttpError(404, 'Categoria não encontrada.');
    if (db.prepare('SELECT 1 FROM categories WHERE name = ? AND id != ?').get(name, id)) throw new HttpError(409, 'Já existe uma categoria com esse nome.');
    db.prepare('UPDATE categories SET name = ? WHERE id = ?').run(name, id);
    res.json(listCategories());
  }));

  app.delete('/api/categories/:id', auth, owner, wrap((req, res) => {
    const id = Number(req.params.id);
    if (!db.prepare('SELECT 1 FROM categories WHERE id = ?').get(id)) throw new HttpError(404, 'Categoria não encontrada.');
    if (db.prepare('SELECT 1 FROM products WHERE category_id = ?').get(id)) {
      throw new HttpError(409, 'Mova ou exclua os produtos dessa categoria antes de excluí-la.');
    }
    db.prepare('DELETE FROM categories WHERE id = ?').run(id);
    res.json(listCategories());
  }));

  /* ---------- produtos ---------- */
  const SELECT_PRODUCT = `SELECT p.*, c.name AS category FROM products p JOIN categories c ON c.id = p.category_id`;
  const productJson = (p, withCost) => {
    const o = {
      id: p.id, name: p.name, category: p.category, code: p.code || '', unit: p.unit,
      price: p.price_cents, stock: p.stock_milli / 1000, min: p.min_milli / 1000,
      low: p.stock_milli <= p.min_milli,
    };
    if (withCost) o.cost = p.cost_cents;
    return o;
  };
  const getProduct = id => db.prepare(`${SELECT_PRODUCT} WHERE p.id = ? AND p.active = 1`).get(id);
  const mustProduct = id => {
    const p = getProduct(id);
    if (!p) throw new HttpError(404, 'Produto não encontrado.');
    return p;
  };
  const logMove = (productId, type, qtyMilli, userId, note, saleId, t) =>
    db.prepare('INSERT INTO stock_movements(product_id, type, qty_milli, note, user_id, sale_id, created_at) VALUES (?,?,?,?,?,?,?)')
      .run(productId, type, qtyMilli, note || null, userId, saleId || null, t);

  function categoryId(name) {
    db.prepare('INSERT INTO categories(name) VALUES (?) ON CONFLICT(name) DO NOTHING').run(name);
    return db.prepare('SELECT id FROM categories WHERE name = ?').get(name).id;
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
  const codeTaken = (code, exceptId) => code
    && db.prepare('SELECT 1 FROM products WHERE code = ? AND active = 1 AND id != ?').get(code, exceptId || 0);

  app.get('/api/products', auth, (req, res) => {
    const withCost = req.user.role === 'dono';
    res.json(db.prepare(`${SELECT_PRODUCT} WHERE p.active = 1 ORDER BY p.name COLLATE NOCASE`).all()
      .map(p => productJson(p, withCost)));
  });

  app.post('/api/products', auth, owner, wrap((req, res) => {
    const p = parseProduct(body(req));
    if (codeTaken(p.code)) throw new HttpError(409, 'Já existe outro produto com esse código de barras.');
    const t = now();
    const id = db.transaction(() => {
      const r = db.prepare(`INSERT INTO products(name, category_id, code, unit, cost_cents, price_cents, stock_milli, min_milli, created_at)
        VALUES (?,?,?,?,?,?,?,?,?)`).run(p.name, categoryId(p.category), p.code, p.unit, p.cost, p.price, p.stock, p.min, t);
      if (p.stock > 0) logMove(r.lastInsertRowid, 'inicial', p.stock, req.user.id, 'Cadastro do produto', null, t);
      return r.lastInsertRowid;
    })();
    res.status(201).json(productJson(getProduct(id), true));
  }));

  app.put('/api/products/:id', auth, owner, wrap((req, res) => {
    const old = mustProduct(Number(req.params.id));
    const p = parseProduct(body(req));
    if (codeTaken(p.code, old.id)) throw new HttpError(409, 'Já existe outro produto com esse código de barras.');
    const t = now();
    db.transaction(() => {
      db.prepare(`UPDATE products SET name=?, category_id=?, code=?, unit=?, cost_cents=?, price_cents=?, stock_milli=?, min_milli=? WHERE id=?`)
        .run(p.name, categoryId(p.category), p.code, p.unit, p.cost, p.price, p.stock, p.min, old.id);
      if (p.stock !== old.stock_milli) logMove(old.id, 'ajuste', p.stock - old.stock_milli, req.user.id, 'Ajuste manual no cadastro', null, t);
    })();
    res.json(productJson(getProduct(old.id), true));
  }));

  app.delete('/api/products/:id', auth, owner, wrap((req, res) => {
    const p = mustProduct(Number(req.params.id));
    // Exclusão lógica: vendas antigas continuam apontando para o produto.
    db.prepare('UPDATE products SET active = 0 WHERE id = ?').run(p.id);
    res.json({ ok: true });
  }));

  app.post('/api/products/:id/restock', auth, owner, wrap((req, res) => {
    const p = mustProduct(Number(req.params.id));
    const b = body(req);
    const qty = toMilli(b.qty, p.unit, 'Quantidade');
    if (qty <= 0) throw bad('Informe a quantidade que chegou.');
    const cost = b.cost == null ? p.cost_cents : b.cost;
    if (!isCents(cost)) throw bad('Preço de compra inválido.');
    db.transaction(() => {
      db.prepare('UPDATE products SET stock_milli = stock_milli + ?, cost_cents = ? WHERE id = ?').run(qty, cost, p.id);
      logMove(p.id, 'entrada', qty, req.user.id, 'Entrada de mercadoria', null, now());
    })();
    res.json(productJson(getProduct(p.id), true));
  }));

  app.get('/api/products/:id/movements', auth, owner, wrap((req, res) => {
    const id = Number(req.params.id);
    const p = db.prepare('SELECT id, name, unit FROM products WHERE id = ?').get(id);
    if (!p) throw new HttpError(404, 'Produto não encontrado.');
    const rows = db.prepare(`SELECT m.type, m.qty_milli, m.note, m.created_at, m.sale_id, u.name AS user_name, s.number AS sale_number
      FROM stock_movements m LEFT JOIN users u ON u.id = m.user_id LEFT JOIN sales s ON s.id = m.sale_id
      WHERE m.product_id = ? ORDER BY m.created_at DESC, m.id DESC LIMIT 100`).all(id);
    res.json({
      product: { id: p.id, name: p.name, unit: p.unit },
      movements: rows.map(m => ({
        type: m.type, qty: m.qty_milli / 1000, note: m.note, at: m.created_at,
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
      id: s.id, number: s.number, at: s.created_at, user: s.user_name,
      subtotal: s.subtotal_cents, discount: s.discount_cents, total: s.total_cents,
      payment: s.payment, received: s.received_cents,
      change: s.received_cents == null ? null : s.received_cents - s.total_cents,
      status: s.status, cancel_reason: s.cancel_reason || null,
      items: items.map(i => itemJson(i, withCost)),
    };
    if (withCost) { o.cost = s.cost_cents; o.profit = s.total_cents - s.cost_cents; }
    return o;
  };
  const SELECT_SALE = `SELECT s.*, u.name AS user_name FROM sales s JOIN users u ON u.id = s.user_id`;
  const loadSale = (id, withCost) => {
    const s = db.prepare(`${SELECT_SALE} WHERE s.id = ?`).get(id);
    if (!s) return null;
    return saleJson(s, db.prepare('SELECT * FROM sale_items WHERE sale_id = ? ORDER BY id').all(id), withCost);
  };

  const createSale = db.transaction((user, b) => {
    const requestId = b.request_id == null ? null : str(b.request_id, 80);
    if (requestId) {
      const dup = db.prepare('SELECT id FROM sales WHERE request_id = ?').get(requestId);
      if (dup) return { id: dup.id, duplicate: true };
    }
    if (!Array.isArray(b.items) || !b.items.length || b.items.length > 200) throw bad('A venda precisa ter pelo menos um item.');

    // Preço e custo vêm SEMPRE do banco; o cliente só diz produto e quantidade.
    const lines = new Map();
    for (const it of b.items) {
      if (!it || !Number.isSafeInteger(it.product_id)) throw bad('Item inválido.');
      const p = getProduct(it.product_id);
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
    const subtotal = totals.reduce((a, c) => a + c, 0);
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
    const t = now();
    const number = db.prepare('SELECT COALESCE(MAX(number), 0) + 1 AS n FROM sales').get().n;
    const sale = db.prepare(`INSERT INTO sales(number, request_id, user_id, created_at, subtotal_cents, discount_cents, total_cents, cost_cents, payment, received_cents)
      VALUES (?,?,?,?,?,?,?,?,?,?)`)
      .run(number, requestId, user.id, t, subtotal, discount, total, costs.reduce((a, c) => a + c, 0), b.payment, received);
    const saleId = Number(sale.lastInsertRowid);
    const insItem = db.prepare(`INSERT INTO sale_items(sale_id, product_id, name, category, unit, qty_milli, price_cents, cost_cents, total_cents, discount_cents, cost_total_cents)
      VALUES (?,?,?,?,?,?,?,?,?,?,?)`);
    const dec = db.prepare('UPDATE products SET stock_milli = stock_milli - ? WHERE id = ? AND stock_milli >= ?');
    list.forEach(({ p, milli }, i) => {
      insItem.run(saleId, p.id, p.name, p.category, p.unit, milli, p.price_cents, p.cost_cents, totals[i], discounts[i], costs[i]);
      if (dec.run(milli, p.id, milli).changes !== 1) throw new HttpError(409, `Estoque insuficiente de "${p.name}".`);
      logMove(p.id, 'venda', -milli, user.id, null, saleId, t);
    });
    return { id: saleId, duplicate: false };
  });

  app.post('/api/sales', auth, wrap((req, res) => {
    const r = createSale.immediate(req.user, body(req));
    res.status(r.duplicate ? 200 : 201).json({ sale: loadSale(r.id, req.user.role === 'dono'), duplicate: r.duplicate });
  }));

  app.get('/api/sales', auth, wrap((req, res) => {
    const isOwner = req.user.role === 'dono';
    const range = isOwner ? monthRange(req.query.month) : todayRange();
    const filter = isOwner ? '' : ' AND s.user_id = @uid';
    const params = { start: range.start, end: range.end, uid: req.user.id };
    const sales = db.prepare(`${SELECT_SALE} WHERE s.created_at >= @start AND s.created_at < @end${filter} ORDER BY s.created_at DESC, s.id DESC`).all(params);
    const items = db.prepare(`SELECT si.* FROM sale_items si JOIN sales s ON s.id = si.sale_id
      WHERE s.created_at >= @start AND s.created_at < @end${filter} ORDER BY si.id`).all(params);
    const bySale = new Map();
    items.forEach(i => { if (!bySale.has(i.sale_id)) bySale.set(i.sale_id, []); bySale.get(i.sale_id).push(i); });
    res.json(sales.map(s => saleJson(s, bySale.get(s.id) || [], isOwner)));
  }));

  const cancelSale = db.transaction((user, id, reason) => {
    const s = db.prepare('SELECT * FROM sales WHERE id = ?').get(id);
    if (!s) throw new HttpError(404, 'Venda não encontrada.');
    if (s.status === 'cancelada') throw new HttpError(409, 'Essa venda já foi cancelada.');
    const t = now();
    db.prepare('UPDATE sales SET status = ?, cancelled_at = ?, cancelled_by = ?, cancel_reason = ? WHERE id = ?')
      .run('cancelada', t, user.id, reason || null, id);
    for (const i of db.prepare('SELECT product_id, qty_milli FROM sale_items WHERE sale_id = ?').all(id)) {
      db.prepare('UPDATE products SET stock_milli = stock_milli + ? WHERE id = ?').run(i.qty_milli, i.product_id);
      logMove(i.product_id, 'cancelamento', i.qty_milli, user.id, `Cancelamento da venda #${s.number}`, id, t);
    }
  });

  app.post('/api/sales/:id/cancel', auth, owner, wrap((req, res) => {
    const id = Number(req.params.id);
    cancelSale.immediate(req.user, id, str(body(req).reason, 200));
    res.json(loadSale(id, true));
  }));

  /* ---------- relatório do mês ---------- */
  app.get('/api/reports/month', auth, owner, wrap((req, res) => {
    const r = monthRange(req.query.month);
    const params = [r.start, r.end];
    const sales = db.prepare(`SELECT total_cents, cost_cents, payment, created_at FROM sales
      WHERE status = 'ok' AND created_at >= ? AND created_at < ?`).all(...params);
    let revenue = 0; let cost = 0;
    const days = Array.from({ length: r.days }, () => ({ revenue: 0, profit: 0 }));
    const byPay = {};
    for (const s of sales) {
      revenue += s.total_cents; cost += s.cost_cents;
      const d = days[localDate(s.created_at).getUTCDate() - 1];
      d.revenue += s.total_cents; d.profit += s.total_cents - s.cost_cents;
      const bp = byPay[s.payment] || (byPay[s.payment] = { payment: s.payment, count: 0, revenue: 0 });
      bp.count++; bp.revenue += s.total_cents;
    }
    const grouped = col => db.prepare(`SELECT ${col} AS k, MAX(si.name) AS name, MAX(si.unit) AS unit, SUM(si.qty_milli) AS qty_milli,
        SUM(si.total_cents - si.discount_cents) AS revenue, SUM(si.cost_total_cents) AS cost
      FROM sale_items si JOIN sales s ON s.id = si.sale_id
      WHERE s.status = 'ok' AND s.created_at >= ? AND s.created_at < ?
      GROUP BY ${col}
      ORDER BY (SUM(si.total_cents - si.discount_cents) - SUM(si.cost_total_cents)) DESC`).all(...params);
    const top = grouped('si.product_id').slice(0, 10).map(x => ({
      name: x.name, unit: x.unit, qty: x.qty_milli / 1000, revenue: x.revenue, profit: x.revenue - x.cost,
    }));
    const categories = grouped('si.category').map(x => ({ name: x.k, revenue: x.revenue, profit: x.revenue - x.cost }));
    const low = db.prepare(`${SELECT_PRODUCT} WHERE p.active = 1 AND p.stock_milli <= p.min_milli ORDER BY p.stock_milli, p.name COLLATE NOCASE`)
      .all().map(p => productJson(p, true));
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
  const listUsers = () => db.prepare('SELECT * FROM users ORDER BY active DESC, name COLLATE NOCASE').all().map(userRow);
  const checkPassword = p => {
    if (typeof p !== 'string' || p.length < 8 || p.length > 200) throw bad('A senha precisa ter pelo menos 8 caracteres.');
  };

  app.get('/api/users', auth, owner, (req, res) => res.json(listUsers()));

  app.post('/api/users', auth, owner, wrap((req, res) => {
    const b = body(req);
    const name = str(b.name, 80);
    const username = str(b.username, 32).toLowerCase();
    if (!name) throw bad('Informe o nome.');
    if (!/^[a-z0-9._-]{3,32}$/.test(username)) throw bad('Usuário: 3 a 32 caracteres (letras, números, ponto, hífen ou sublinhado).');
    if (b.role !== 'dono' && b.role !== 'caixa') throw bad('Perfil inválido.');
    checkPassword(b.password);
    if (db.prepare('SELECT 1 FROM users WHERE username = ?').get(username)) throw new HttpError(409, 'Esse usuário já existe.');
    db.prepare('INSERT INTO users(name, username, pass_hash, role, created_at) VALUES (?,?,?,?,?)')
      .run(name, username, hashPassword(b.password), b.role, now());
    res.status(201).json(listUsers());
  }));

  app.put('/api/users/:id', auth, owner, wrap((req, res) => {
    const id = Number(req.params.id);
    const b = body(req);
    const u = db.prepare('SELECT * FROM users WHERE id = ?').get(id);
    if (!u) throw new HttpError(404, 'Usuário não encontrado.');
    const name = b.name === undefined ? u.name : str(b.name, 80);
    const role = b.role === undefined ? u.role : b.role;
    const active = b.active === undefined ? u.active : (b.active ? 1 : 0);
    if (!name) throw bad('Informe o nome.');
    if (role !== 'dono' && role !== 'caixa') throw bad('Perfil inválido.');
    if (id === req.user.id && (role !== 'dono' || !active)) throw bad('Você não pode rebaixar ou desativar a própria conta.');
    if (b.password !== undefined) checkPassword(b.password);
    db.transaction(() => {
      db.prepare('UPDATE users SET name = ?, role = ?, active = ? WHERE id = ?').run(name, role, active, id);
      if (b.password !== undefined) db.prepare('UPDATE users SET pass_hash = ? WHERE id = ?').run(hashPassword(b.password), id);
      if (b.password !== undefined || !active || role !== u.role) db.prepare('DELETE FROM sessions WHERE user_id = ?').run(id);
    })();
    res.json(listUsers());
  }));

  /* ---------- backup e exportação ---------- */
  app.get('/api/backup', auth, owner, wrap(async (req, res) => {
    const tmp = path.join(os.tmpdir(), `alianca-backup-${process.pid}-${Date.now()}.db`);
    await db.backup(tmp);
    const d = localDate(now()).toISOString().slice(0, 10);
    res.download(tmp, `alianca-backup-${d}.db`, () => fs.unlink(tmp, () => {}));
  }));

  const csvCell = v => {
    const s = String(v == null ? '' : v);
    return /[;"\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const dec = c => (c / 100).toFixed(2).replace('.', ',');

  app.get('/api/export/sales.csv', auth, owner, wrap((req, res) => {
    const r = monthRange(req.query.month);
    const rows = db.prepare(`SELECT s.number, s.created_at, s.status, s.payment, s.discount_cents, s.total_cents, u.name AS operator,
        si.name, si.category, si.qty_milli, si.price_cents, si.cost_cents
      FROM sales s JOIN users u ON u.id = s.user_id JOIN sale_items si ON si.sale_id = s.id
      WHERE s.created_at >= ? AND s.created_at < ? ORDER BY s.created_at, s.id, si.id`).all(r.start, r.end);
    const out = [['Venda', 'Data', 'Hora', 'Status', 'Operador', 'Produto', 'Categoria', 'Qtd', 'Preço unit.', 'Custo unit.', 'Pagamento', 'Desconto da venda', 'Total da venda']];
    for (const x of rows) {
      const d = localDate(x.created_at).toISOString();
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
    console.error(err);
    res.status(500).json({ error: 'Erro interno do servidor.' });
  });

  return app;
}

module.exports = { createApp };
