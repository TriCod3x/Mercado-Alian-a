'use strict';
// Exportação e carga do banco inteiro em JSON. Usado pelo backup (/api/backup e
// scripts/backup.js), pela restauração e pela migração do SQLite.
// Sessões ficam de fora: depois de restaurar, cada um entra de novo.

const FORMAT = 'mercado-alianca-backup';
const VERSION = 1;
// Ordem respeita as chaves estrangeiras.
const TABLES = ['users', 'categories', 'products', 'sales', 'sale_items', 'stock_movements'];
const CHUNK = 2000;

// Precisa rodar dentro de db.tx(): leitura consistente de todas as tabelas.
async function dumpDataset(c) {
  await c.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY');
  const tables = {};
  for (const t of TABLES) tables[t] = await c.query(`SELECT * FROM ${t} ORDER BY id`);
  return { format: FORMAT, version: VERSION, created_at: new Date().toISOString(), tables };
}

async function counts(c) {
  const out = {};
  for (const t of TABLES) out[t] = (await c.query(`SELECT COUNT(*) AS n FROM ${t}`))[0].n;
  return out;
}

// Recusa carregar por cima de dados existentes (nada é sobrescrito nem apagado).
async function assertEmpty(c) {
  const n = await counts(c);
  const busy = Object.entries(n).filter(([, v]) => v > 0);
  if (busy.length) {
    throw new Error(`O banco de destino já tem dados (${busy.map(([t, v]) => `${t}: ${v}`).join(', ')}). `
      + 'Carregue apenas num banco recém-criado com supabase/schema.sql (sem rodar o seed.sql).');
  }
}

// Insere preservando os IDs; colunas são casadas pelo nome via jsonb.
async function loadDataset(c, data) {
  if (!data || data.format !== FORMAT || data.version !== VERSION || !data.tables) {
    throw new Error('Arquivo de backup em formato desconhecido.');
  }
  await assertEmpty(c);
  for (const t of TABLES) {
    const rows = data.tables[t] || [];
    for (let i = 0; i < rows.length; i += CHUNK) {
      await c.query(`INSERT INTO ${t} SELECT * FROM jsonb_populate_recordset(NULL::${t}, $1::jsonb)`,
        [JSON.stringify(rows.slice(i, i + CHUNK))]);
    }
    // Próximo ID gerado continua depois do maior ID importado.
    await c.query(`SELECT setval(pg_get_serial_sequence('${t}', 'id'), COALESCE((SELECT MAX(id) FROM ${t}), 1), (SELECT MAX(id) FROM ${t}) IS NOT NULL)`);
  }
}

// Totais para conferir origem x destino depois de carregar.
async function summary(c) {
  const q = async sql => (await c.query(sql))[0];
  return {
    counts: await counts(c),
    sales: await q(`SELECT COUNT(*) FILTER (WHERE status = 'ok') AS ok, COUNT(*) FILTER (WHERE status = 'cancelada') AS cancelled,
      COALESCE(SUM(subtotal_cents), 0) AS subtotal, COALESCE(SUM(discount_cents), 0) AS discount,
      COALESCE(SUM(total_cents), 0) AS total, COALESCE(SUM(cost_cents), 0) AS cost, COALESCE(MAX(number), 0) AS last_number FROM sales`),
    items: await q(`SELECT COALESCE(SUM(qty_milli), 0) AS qty, COALESCE(SUM(total_cents), 0) AS total,
      COALESCE(SUM(discount_cents), 0) AS discount, COALESCE(SUM(cost_total_cents), 0) AS cost FROM sale_items`),
    stock: await q('SELECT COALESCE(SUM(stock_milli), 0) AS stock, COUNT(*) FILTER (WHERE active) AS active_products FROM products'),
    movements: await q('SELECT COALESCE(SUM(qty_milli), 0) AS qty FROM stock_movements'),
  };
}

// Inconsistências que já existiam nos dados (não impedem a carga; só avisam).
async function warnings(c) {
  const out = [];
  const stock = await c.query(`SELECT p.id, p.name, p.stock_milli, COALESCE(SUM(m.qty_milli), 0) AS moved
    FROM products p LEFT JOIN stock_movements m ON m.product_id = p.id
    GROUP BY p.id HAVING p.stock_milli <> COALESCE(SUM(m.qty_milli), 0) ORDER BY p.id`);
  stock.forEach(r => out.push(`Produto #${r.id} "${r.name}": estoque ${r.stock_milli / 1000} difere da soma do histórico ${r.moved / 1000}.`));
  const sales = await c.query(`SELECT s.number, s.total_cents, s.cost_cents,
      SUM(i.total_cents - i.discount_cents) AS items_total, SUM(i.cost_total_cents) AS items_cost
    FROM sales s LEFT JOIN sale_items i ON i.sale_id = s.id GROUP BY s.id
    HAVING s.total_cents IS DISTINCT FROM SUM(i.total_cents - i.discount_cents)
        OR s.cost_cents IS DISTINCT FROM SUM(i.cost_total_cents) ORDER BY s.number`);
  sales.forEach(r => out.push(`Venda #${r.number}: totais da venda não batem com a soma dos itens.`));
  return out;
}

// Confere, linha a linha e coluna a coluna, se o banco tem exatamente o que veio
// da origem. Datas são comparadas pelo instante (milissegundos).
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:?\d{2})$/;
const norm = v => (v instanceof Date ? v.getTime() : typeof v === 'string' && ISO.test(v) ? Date.parse(v) : v);

async function compareWithSource(c, data) {
  const problems = [];
  for (const t of TABLES) {
    const src = data.tables[t] || [];
    const dst = new Map((await c.query(`SELECT * FROM ${t}`)).map(r => [r.id, r]));
    if (dst.size !== src.length) problems.push(`${t}: origem ${src.length} linhas, destino ${dst.size}.`);
    for (const row of src) {
      const got = dst.get(row.id);
      if (!got) { problems.push(`${t} #${row.id}: não encontrado no destino.`); continue; }
      for (const [k, v] of Object.entries(row)) {
        if (norm(v ?? null) !== norm(got[k] ?? null)) problems.push(`${t} #${row.id}.${k}: origem ${JSON.stringify(v)}, destino ${JSON.stringify(got[k])}.`);
      }
    }
  }
  return problems;
}

module.exports = {
  FORMAT, VERSION, TABLES, dumpDataset, loadDataset, assertEmpty, summary, warnings, counts, compareWithSource,
};
