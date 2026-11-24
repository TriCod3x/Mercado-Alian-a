'use strict';
// Faz uma consulta no banco para o Supabase não pausar o projeto por inatividade.
//   node --env-file=.env scripts/keepalive.js     (ou: npm run keepalive)
const { createPool, fromPool } = require('../server/db');

async function main() {
  const db = fromPool(createPool(process.env));
  try {
    const [{ n }] = await db.query('SELECT COUNT(*) AS n FROM users');
    console.log(`Supabase ativo (${new Date().toISOString()}) — usuários: ${n}`);
  } finally {
    await db.close();
  }
}

main().catch(e => { console.error(`Keep-alive falhou: ${e.message}`); process.exit(1); });
