'use strict';
const Database = require('better-sqlite3');
const fs = require('fs');
const path = require('path');

const DEFAULT_CATEGORIES = ['Mercearia', 'Bebidas', 'Limpeza', 'Higiene', 'Hortifruti', 'Padaria', 'Outros'];

// Dinheiro sempre em centavos (inteiro). Quantidades em milésimos (inteiro):
// 1 un = 1000, 0,5 kg = 500. Evita erro de ponto flutuante em estoque e caixa.
const SCHEMA_V1 = `
CREATE TABLE users (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  username TEXT NOT NULL UNIQUE COLLATE NOCASE,
  pass_hash TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('dono','caixa')),
  active INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL
);

CREATE TABLE sessions (
  token_hash TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at INTEGER NOT NULL,
  touched_at INTEGER NOT NULL
);

CREATE TABLE categories (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL UNIQUE COLLATE NOCASE
);

CREATE TABLE products (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  category_id INTEGER NOT NULL REFERENCES categories(id),
  code TEXT,
  unit TEXT NOT NULL CHECK (unit IN ('un','kg')),
  cost_cents INTEGER NOT NULL CHECK (cost_cents >= 0),
  price_cents INTEGER NOT NULL CHECK (price_cents > 0),
  stock_milli INTEGER NOT NULL CHECK (stock_milli >= 0),
  min_milli INTEGER NOT NULL DEFAULT 0 CHECK (min_milli >= 0),
  active INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL
);
CREATE UNIQUE INDEX ux_products_code ON products(code) WHERE code IS NOT NULL AND active = 1;

CREATE TABLE sales (
  id INTEGER PRIMARY KEY,
  number INTEGER NOT NULL UNIQUE,
  request_id TEXT UNIQUE,
  user_id INTEGER NOT NULL REFERENCES users(id),
  created_at INTEGER NOT NULL,
  subtotal_cents INTEGER NOT NULL,
  discount_cents INTEGER NOT NULL DEFAULT 0,
  total_cents INTEGER NOT NULL,
  cost_cents INTEGER NOT NULL,
  payment TEXT NOT NULL CHECK (payment IN ('dinheiro','pix','debito','credito')),
  received_cents INTEGER,
  status TEXT NOT NULL DEFAULT 'ok' CHECK (status IN ('ok','cancelada')),
  cancelled_at INTEGER,
  cancelled_by INTEGER REFERENCES users(id),
  cancel_reason TEXT
);
CREATE INDEX ix_sales_created ON sales(created_at);

CREATE TABLE sale_items (
  id INTEGER PRIMARY KEY,
  sale_id INTEGER NOT NULL REFERENCES sales(id) ON DELETE CASCADE,
  product_id INTEGER NOT NULL REFERENCES products(id),
  name TEXT NOT NULL,
  category TEXT NOT NULL,
  unit TEXT NOT NULL,
  qty_milli INTEGER NOT NULL CHECK (qty_milli > 0),
  price_cents INTEGER NOT NULL,
  cost_cents INTEGER NOT NULL,
  total_cents INTEGER NOT NULL,
  discount_cents INTEGER NOT NULL DEFAULT 0,
  cost_total_cents INTEGER NOT NULL
);
CREATE INDEX ix_items_sale ON sale_items(sale_id);

CREATE TABLE stock_movements (
  id INTEGER PRIMARY KEY,
  product_id INTEGER NOT NULL REFERENCES products(id),
  type TEXT NOT NULL CHECK (type IN ('inicial','entrada','ajuste','venda','cancelamento')),
  qty_milli INTEGER NOT NULL,
  note TEXT,
  user_id INTEGER REFERENCES users(id),
  sale_id INTEGER REFERENCES sales(id),
  created_at INTEGER NOT NULL
);
CREATE INDEX ix_mov_product ON stock_movements(product_id, created_at);
`;

function openDb(file) {
  if (file !== ':memory:') fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new Database(file);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.pragma('busy_timeout = 5000');
  const version = db.pragma('user_version', { simple: true });
  if (version < 1) {
    db.transaction(() => {
      db.exec(SCHEMA_V1);
      const ins = db.prepare('INSERT INTO categories(name) VALUES (?)');
      DEFAULT_CATEGORIES.forEach(c => ins.run(c));
      db.pragma('user_version = 1');
    })();
  }
  return db;
}

module.exports = { openDb };
