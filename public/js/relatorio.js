'use strict';
/* Lucro do mês (somente dono). Todos os números vêm calculados do servidor. */

async function viewRelatorio(live) {
  const r = await api('GET', `/api/reports/month?month=${App.month}`);
  // "+ Entrada" na lista de reposição precisa dos produtos carregados
  if (r.low.length) await loadProducts();
  if (!live()) return;
  const k = r.kpis;
  const maxRev = Math.max(1, ...r.days.map(d => d.revenue));
  const h = v => (v === 0 ? 0 : Math.max(2, (Math.abs(v) / maxRev) * 100));
  const chart = r.days.map((d, i) => `<div class="col" title="Dia ${i + 1}: faturamento ${brl(d.revenue)} · lucro ${brl(d.profit)}"><div class="bars"><i class="b rev" style="height:${h(d.revenue)}%"></i><i class="b pr${d.profit < 0 ? ' neg' : ''}" style="height:${h(d.profit)}%"></i></div><span class="dl">${i + 1}</span></div>`).join('');
  const none = '<p class="empty">Sem vendas neste mês.</p>';
  $('#app').innerHTML = monthBar() + `
  <div class="kpis">
    <div class="kpi hl"><span>Lucro do mês</span><b class="${k.profit < 0 ? 'neg' : 'pos'}">${brl(k.profit)}</b></div>
    <div class="kpi"><span>Faturamento</span><b>${brl(k.revenue)}</b></div>
    <div class="kpi"><span>Custo das mercadorias vendidas</span><b>${brl(k.cost)}</b></div>
    <div class="kpi"><span>Margem</span><b>${pct(k.margin)}</b></div>
    <div class="kpi"><span>Vendas</span><b>${k.count}</b></div>
    <div class="kpi"><span>Ticket médio</span><b>${brl(k.ticket)}</b></div>
  </div>
  <section class="card"><h2>Dia a dia</h2><div class="chart">${chart}</div>
    <div class="legend"><span><i style="background:var(--rev)"></i>Faturamento</span><span><i style="background:var(--pri)"></i>Lucro</span></div></section>
  <div class="cols2">
    <section class="card tblw"><h2>Produtos que mais deram lucro</h2>${r.top.length
    ? `<table class="tbl"><thead><tr><th>Produto</th><th class="r">Qtd</th><th class="r">Receita</th><th class="r">Lucro</th></tr></thead><tbody>${r.top.map(t => `<tr><td>${esc(t.name)}</td><td class="r">${num(t.qty)} ${t.unit}</td><td class="r">${brl(t.revenue)}</td><td class="r ${t.profit < 0 ? 'neg' : ''}">${brl(t.profit)}</td></tr>`).join('')}</tbody></table>` : none}</section>
    <div>
      <section class="card tblw"><h2>Por categoria</h2>${r.categories.length
    ? `<table class="tbl"><thead><tr><th>Categoria</th><th class="r">Receita</th><th class="r">Lucro</th></tr></thead><tbody>${r.categories.map(c => `<tr><td>${esc(c.name)}</td><td class="r">${brl(c.revenue)}</td><td class="r">${brl(c.profit)}</td></tr>`).join('')}</tbody></table>` : none}</section>
      <section class="card tblw"><h2>Por forma de pagamento</h2>${r.payments.length
    ? `<table class="tbl"><thead><tr><th>Forma</th><th class="r">Vendas</th><th class="r">Total</th></tr></thead><tbody>${r.payments.map(p => `<tr><td>${PAY[p.payment] || esc(p.payment)}</td><td class="r">${p.count}</td><td class="r">${brl(p.revenue)}</td></tr>`).join('')}</tbody></table>` : none}</section>
    </div>
  </div>
  ${r.low.length ? `<section class="card"><h2>Repor estoque (${r.low.length})</h2><div class="tblw"><table class="tbl"><tbody>${r.low.map(p => `<tr><td class="nm">${esc(p.name)}</td><td class="r">${num(p.stock)} ${p.unit} <small style="display:inline">(mín. ${num(p.min)})</small></td><td class="act"><button class="btn sm" data-act="p-restock" data-id="${p.id}">+ Entrada</button></td></tr>`).join('')}</tbody></table></div></section>` : ''}
  <section class="card"><h2>Dados</h2>
    <p class="hint">O banco de dados fica no servidor. Mesmo assim, baixe um backup de vez em quando e guarde fora do servidor.</p>
    <div class="sec-actions"><a class="btn primary" href="/api/backup" download>Baixar backup do banco</a><a class="btn" href="/api/export/sales.csv?month=${App.month}" download>Exportar vendas do mês (CSV)</a></div>
  </section>`;
}
