'use strict';
// Entrada para o Vercel (função serverless). Os arquivos de public/ são servidos
// direto pelo CDN do Vercel; esta função atende /api/* e /healthz.
const { createPool, fromPool } = require('../server/db');
const { createApp } = require('../server/app');

// Uma instância da função atende uma requisição por vez: poucas conexões bastam.
const db = fromPool(createPool(process.env, { max: Number(process.env.PG_POOL_MAX) || 2 }));

module.exports = createApp({
  db,
  trustProxy: true,
  tzOffsetMin: process.env.TZ_OFFSET_MINUTES ? Number(process.env.TZ_OFFSET_MINUTES) : -180,
});
