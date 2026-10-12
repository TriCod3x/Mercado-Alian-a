'use strict';
const crypto = require('crypto');
const path = require('path');
const { openDb } = require('./db');
const { createApp } = require('./app');
const { hashPassword } = require('./auth');

const PORT = Number(process.env.PORT) || 3000;
const HOST = process.env.HOST || '0.0.0.0';
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
const behindProxy = process.env.TRUST_PROXY === '1' || !!process.env.RAILWAY_ENVIRONMENT;

const db = openDb(path.join(DATA_DIR, 'mercado.db'));

// Primeiro start sem nenhum usuário: cria o dono.
if (db.prepare('SELECT COUNT(*) AS n FROM users').get().n === 0) {
  const username = (process.env.ADMIN_USER || 'dono').toLowerCase();
  let password = process.env.ADMIN_PASSWORD;
  let generated = false;
  if (!password || password.length < 8) {
    if (password) console.warn('ADMIN_PASSWORD tem menos de 8 caracteres e foi ignorada.');
    password = crypto.randomBytes(9).toString('base64url');
    generated = true;
  }
  db.prepare('INSERT INTO users(name, username, pass_hash, role, created_at) VALUES (?,?,?,?,?)')
    .run('Dono', username, hashPassword(password), 'dono', Date.now());
  console.log('==============================================');
  console.log(' Usuário dono criado');
  console.log(`   usuário: ${username}`);
  if (generated) console.log(`   senha:   ${password}   (anote e troque depois do primeiro acesso)`);
  else console.log('   senha:   a definida em ADMIN_PASSWORD');
  console.log('==============================================');
}

const app = createApp({
  db,
  trustProxy: behindProxy,
  tzOffsetMin: process.env.TZ_OFFSET_MINUTES ? Number(process.env.TZ_OFFSET_MINUTES) : -180,
  publicDir: path.join(__dirname, '..', 'public'),
});

const server = app.listen(PORT, HOST, () => {
  console.log(`Mercado Aliança rodando em http://localhost:${PORT}`);
  console.log(`Banco de dados: ${path.join(DATA_DIR, 'mercado.db')}`);
});

function shutdown() {
  server.close(() => { db.close(); process.exit(0); });
  setTimeout(() => process.exit(1), 5000).unref();
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
