'use strict';
const crypto = require('crypto');
const path = require('path');
const { createPool, fromPool, checkSchema } = require('./db');
const { createApp } = require('./app');
const { hashPassword } = require('./auth');

const PORT = Number(process.env.PORT) || 3000;
const HOST = process.env.HOST || '0.0.0.0';
const behindProxy = process.env.TRUST_PROXY === '1' || !!process.env.RAILWAY_ENVIRONMENT || !!process.env.RENDER;

async function main() {
  const pool = createPool(process.env);
  const db = fromPool(pool);
  await checkSchema(db);

  // Primeiro start sem nenhum usuário: cria o dono.
  const [{ n }] = await db.query('SELECT COUNT(*) AS n FROM users');
  if (n === 0) {
    const username = (process.env.ADMIN_USER || 'dono').toLowerCase();
    let password = process.env.ADMIN_PASSWORD;
    let generated = false;
    if (!password || password.length < 8) {
      if (password) console.warn('ADMIN_PASSWORD tem menos de 8 caracteres e foi ignorada.');
      password = crypto.randomBytes(9).toString('base64url');
      generated = true;
    }
    // ON CONFLICT: se duas instâncias subirem juntas, só uma cria o dono.
    const created = await db.query(`INSERT INTO users(name, username, pass_hash, role) VALUES ($1,$2,$3,'dono')
      ON CONFLICT (username) DO NOTHING RETURNING id`, ['Dono', username, hashPassword(password)]);
    if (created.length) {
      console.log('==============================================');
      console.log(' Usuário dono criado');
      console.log(`   usuário: ${username}`);
      if (generated) console.log(`   senha:   ${password}   (anote e troque depois do primeiro acesso)`);
      else console.log('   senha:   a definida em ADMIN_PASSWORD');
      console.log('==============================================');
    }
  }

  const app = createApp({
    db,
    trustProxy: behindProxy,
    tzOffsetMin: process.env.TZ_OFFSET_MINUTES ? Number(process.env.TZ_OFFSET_MINUTES) : -180,
    publicDir: path.join(__dirname, '..', 'public'),
  });

  const server = app.listen(PORT, HOST, () => {
    console.log(`Mercado Aliança rodando em http://localhost:${PORT}`);
    console.log(`Banco de dados: PostgreSQL em ${new URL(process.env.DATABASE_URL).hostname}`);
  });

  // Keep-alive: o Supabase (plano grátis) pausa o projeto após ~7 dias sem atividade.
  // Uma consulta leve a cada KEEPALIVE_HOURS (padrão 12h) mantém o banco ativo. 0 desliga.
  const keepaliveHours = process.env.KEEPALIVE_HOURS !== undefined ? Number(process.env.KEEPALIVE_HOURS) : 12;
  let keepalive = null;
  if (keepaliveHours > 0) {
    keepalive = setInterval(() => {
      db.query('SELECT COUNT(*) AS n FROM users')
        .then(() => console.log(`Keep-alive Supabase ok (${new Date().toISOString()})`))
        .catch(e => console.warn(`Keep-alive Supabase falhou: ${e.message}`));
    }, keepaliveHours * 3600 * 1000);
    keepalive.unref();
  }

  function shutdown() {
    if (keepalive) clearInterval(keepalive);
    server.close(() => { db.close().finally(() => process.exit(0)); });
    setTimeout(() => process.exit(1), 5000).unref();
  }
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}

main().catch(err => {
  // Mensagem curta, sem despejar a connection string (que contém a senha).
  console.error(`Falha ao iniciar: ${err.message}`);
  process.exit(1);
});
