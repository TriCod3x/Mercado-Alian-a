'use strict';
/* Estoque: produtos, entradas, histórico e categorias (somente dono). */

async function viewEstoque(live) {
  await Promise.all([loadProducts(), loadCategories()]);
  if (!live()) return;
  $('#app').innerHTML = `<div class="toolbar">
    <input type="search" id="sq" placeholder="Buscar produto ou código…" value="${esc(App.sq)}" autocomplete="off">
    <select id="scat"><option value="">Todas as categorias</option>${App.categories.map(c => `<option${App.scat === c.name ? ' selected' : ''}>${esc(c.name)}</option>`).join('')}</select>
    <label class="chk"><input type="checkbox" id="slow"${App.slow ? ' checked' : ''}> Só estoque baixo</label>
    <button class="btn" data-act="cats">Categorias</button>
    <button class="btn primary" data-act="p-new">+ Novo produto</button>
  </div><div id="stock-out"></div>`;
  renderStockTable();
}

function renderStockTable() {
  const out = $('#stock-out');
  if (!out) return;
  if (!App.products.length) {
    out.innerHTML = `<div class="card"><p class="empty">Nenhum produto cadastrado ainda.</p>
      <div class="sec-actions" style="justify-content:center"><button class="btn primary" data-act="p-new">+ Cadastrar primeiro produto</button></div></div>`;
    return;
  }
  const q = norm(App.sq);
  const raw = App.sq.trim();
  const list = App.products
    .filter(p => (!q || norm(p.name).includes(q) || (p.code && p.code.includes(raw)))
      && (!App.scat || p.category === App.scat) && (!App.slow || p.low))
    .sort((a, b) => a.name.localeCompare(b.name, 'pt-BR'));
  const vCost = App.products.reduce((a, p) => a + Math.round(p.cost * p.stock), 0);
  const vSale = App.products.reduce((a, p) => a + Math.round(p.price * p.stock), 0);
  const low = lowCount();
  const kpis = `<div class="kpis">
    <div class="kpi"><span>Produtos</span><b>${App.products.length}</b></div>
    <div class="kpi"><span>Estoque a preço de custo</span><b>${brl(vCost)}</b></div>
    <div class="kpi"><span>Estoque a preço de venda</span><b>${brl(vSale)}</b></div>
    <div class="kpi"><span>Estoque baixo / zerado</span><b class="${low ? 'neg' : ''}">${low}</b></div></div>`;
  const rows = list.map(p => {
    const mg = p.price > 0 ? (p.price - p.cost) / p.price : 0;
    const badge = p.stock <= 0 ? '<span class="badge bad">zerado</span>' : p.low ? '<span class="badge warn">baixo</span>' : '';
    return `<tr><td class="nm">${esc(p.name)}${p.code ? `<small>${esc(p.code)}</small>` : ''}</td><td>${esc(p.category)}</td>
      <td class="r">${brl(p.cost)}</td><td class="r">${brl(p.price)}${p.unit === 'kg' ? '/kg' : ''}</td>
      <td class="r ${mg < 0 ? 'neg' : ''}">${pct(mg)}</td>
      <td class="r">${num(p.stock)} ${p.unit}${badge}</td><td class="r">${brl(Math.round(p.cost * p.stock))}</td>
      <td class="act"><button class="btn sm" data-act="p-restock" data-id="${p.id}">+ Entrada</button><button class="btn sm" data-act="p-hist" data-id="${p.id}">Histórico</button><button class="btn sm" data-act="p-edit" data-id="${p.id}">Editar</button><button class="btn sm danger" data-act="p-del" data-id="${p.id}">Excluir</button></td></tr>`;
  }).join('');
  out.innerHTML = kpis + `<div class="card tblw">${list.length
    ? `<table class="tbl mob"><thead><tr><th>Produto</th><th>Categoria</th><th class="r">Compra</th><th class="r">Venda</th><th class="r">Margem</th><th class="r">Estoque</th><th class="r">Valor (custo)</th><th></th></tr></thead><tbody>${rows}</tbody></table>`
    : '<p class="empty">Nenhum produto com esses filtros.</p>'}</div>`;
}

function productDialog(id) {
  const p = id ? prodById(id) : null;
  const v = p || { name: '', category: '', code: '', unit: 'un', cost: 0, price: 0, stock: 0, min: 0 };
  openDialog(`<div class="dbody"><h3>${p ? 'Editar produto' : 'Novo produto'}</h3>
    <label>Nome<input id="f-name" value="${esc(v.name)}" autocomplete="off"></label>
    <div class="row2"><label>Categoria<input id="f-cat" list="cat-list" value="${esc(v.category)}" placeholder="Escolha ou digite uma nova" autocomplete="off"><datalist id="cat-list">${App.categories.map(c => `<option value="${esc(c.name)}">`).join('')}</datalist></label>
    <label>Vendido por<select id="f-unit"><option value="un"${v.unit === 'un' ? ' selected' : ''}>Unidade</option><option value="kg"${v.unit === 'kg' ? ' selected' : ''}>Quilo (kg)</option></select></label></div>
    <label>Código de barras (opcional)<input id="f-code" value="${esc(v.code)}" inputmode="numeric" autocomplete="off"></label>
    <div class="row2"><label>Preço de compra (custo)<input id="f-cost" inputmode="decimal" value="${p ? centsIn(v.cost) : ''}" placeholder="0,00"></label>
    <label>Preço de venda<input id="f-price" inputmode="decimal" value="${p ? centsIn(v.price) : ''}" placeholder="0,00"></label></div>
    <div id="f-margin" class="hint"></div>
    <div class="row2"><label>Estoque atual<input id="f-stock" inputmode="decimal" value="${p ? decIn(v.stock) : ''}" placeholder="0"></label>
    <label>Estoque mínimo (alerta)<input id="f-min" inputmode="decimal" value="${p ? decIn(v.min) : ''}" placeholder="0"></label></div>
    ${p ? '<p class="hint">Mudar preços aqui não altera vendas já registradas: elas guardam o preço e o custo da época. Para somar mercadoria que chegou, use “+ Entrada”.</p>' : ''}
    <div class="err" id="f-err"></div></div>
    <div class="dfoot"><button class="btn" data-act="dlg-no">Cancelar</button><button class="btn primary" data-act="p-save" data-id="${p ? p.id : ''}" data-primary>Salvar</button></div>`);
  updMargin();
}

function updMargin() {
  const el = $('#f-margin');
  if (!el || !$('#f-cost')) return;
  const c = parseMoney($('#f-cost').value);
  const p = parseMoney($('#f-price').value);
  if (Number.isNaN(c) || Number.isNaN(p) || p <= 0) { el.textContent = ''; el.className = 'hint'; return; }
  const l = p - c;
  el.className = 'hint' + (l < 0 ? ' neg' : '');
  el.textContent = `${l < 0 ? '⚠ Preço de venda abaixo do custo. ' : ''}Lucro por unidade: ${brl(l)} · margem ${pct(l / p)}`;
}

async function saveProduct(id) {
  const err = m => { const e = $('#f-err'); if (e) e.textContent = m; };
  err('');
  const unit = $('#f-unit').value;
  const cost = parseMoney($('#f-cost').value);
  const price = parseMoney($('#f-price').value);
  const stock = parseNum($('#f-stock').value);
  const minTxt = $('#f-min').value.trim();
  const min = minTxt === '' ? 0 : parseNum(minTxt);
  if (!$('#f-name').value.trim()) return err('Informe o nome do produto.');
  if (Number.isNaN(cost) || cost < 0) return err('Preço de compra inválido.');
  if (Number.isNaN(price) || price <= 0) return err('Preço de venda inválido.');
  if (Number.isNaN(stock) || stock < 0) return err('Estoque inválido.');
  if (Number.isNaN(min) || min < 0) return err('Estoque mínimo inválido.');
  const body = {
    name: $('#f-name').value, category: $('#f-cat').value, code: $('#f-code').value, unit, cost, price, stock, min,
  };
  return guarded(async () => {
    await (id ? api('PUT', `/api/products/${id}`, body) : api('POST', '/api/products', body));
    closeDialog();
    await render();
    toast(id ? 'Produto atualizado' : 'Produto cadastrado');
  }, err);
}

function restockDialog(id) {
  const p = prodById(id);
  if (!p) return;
  openDialog(`<div class="dbody"><h3>Entrada de estoque</h3><p style="margin:0 0 10px"><b>${esc(p.name)}</b> — atual: ${num(p.stock)} ${p.unit}</p>
    <label>Quantidade que chegou (${p.unit})<input id="r-qty" inputmode="decimal" placeholder="0"></label>
    <label>Preço de compra atual (R$)<input id="r-cost" inputmode="decimal" value="${centsIn(p.cost)}"></label>
    <p class="hint">Se o custo mudou, ele vale daqui pra frente. Vendas já registradas mantêm o custo da época.</p>
    <div class="err" id="r-err"></div></div>
    <div class="dfoot"><button class="btn" data-act="dlg-no">Cancelar</button><button class="btn primary" data-act="r-save" data-id="${p.id}" data-primary>Registrar entrada</button></div>`);
}

async function saveRestock(id) {
  const err = m => { const e = $('#r-err'); if (e) e.textContent = m; };
  err('');
  const qty = parseNum($('#r-qty').value);
  const cost = parseMoney($('#r-cost').value);
  if (Number.isNaN(qty) || qty <= 0) return err('Informe a quantidade.');
  if (Number.isNaN(cost) || cost < 0) return err('Preço de compra inválido.');
  return guarded(async () => {
    await api('POST', `/api/products/${id}/restock`, { qty, cost });
    closeDialog();
    await render();
    toast(`Entrada registrada: +${num(qty)}`);
  }, err);
}

async function historyDialog(id) {
  try {
    const { product, movements } = await api('GET', `/api/products/${id}/movements`);
    openDialog(`<div class="dbody"><h3>Histórico: ${esc(product.name)}</h3>
      ${movements.length ? `<div class="tblw"><table class="tbl mob"><thead><tr><th>Quando</th><th>Tipo</th><th class="r">Qtd</th><th>Quem</th><th>Obs.</th></tr></thead><tbody>
      ${movements.map(m => `<tr><td>${fmtDT(m.at)}</td><td>${MOVE[m.type] || esc(m.type)}${m.sale ? ` #${m.sale}` : ''}</td>
        <td class="r ${m.qty < 0 ? 'neg' : 'pos'}">${m.qty > 0 ? '+' : ''}${num(m.qty)} ${product.unit}</td><td>${esc(m.user || '')}</td><td>${esc(m.note || '')}</td></tr>`).join('')}
      </tbody></table></div>` : '<p class="empty">Sem movimentações.</p>'}</div>
      <div class="dfoot"><button class="btn" data-act="dlg-no">Fechar</button></div>`);
  } catch (e) { toast(e.message, 5000); }
}

function catsDialog(msg) {
  openDialog(`<div class="dbody"><h3>Categorias</h3>
    ${App.categories.map(c => `<div class="crow"><input data-cat-input="${c.id}" value="${esc(c.name)}"><span class="hint">${c.products} prod.</span><button class="btn sm" data-act="cat-save" data-id="${c.id}">Renomear</button><button class="btn sm danger" data-act="cat-del" data-id="${c.id}">Excluir</button></div>`).join('')}
    <div class="crow" style="grid-template-columns:1fr auto"><input id="cat-new" placeholder="Nova categoria" autocomplete="off"><button class="btn sm primary" data-act="cat-add">Adicionar</button></div>
    <div class="err" id="c-err">${esc(msg || '')}</div></div>
    <div class="dfoot"><button class="btn" data-act="dlg-no">Fechar</button></div>`);
}

// chamada de categorias: atualiza a lista e reabre o diálogo (com o erro, se houver)
async function catCall(method, url, body) {
  await guarded(async () => {
    App.categories = await api(method, url, body);
    catsDialog();
    if ($('#stock-out')) await render();
  }, m => { const e = $('#c-err'); if (e) e.textContent = m; });
}

Object.assign(H, {
  'p-new'() { productDialog(null); },
  'p-edit'(t) { productDialog(Number(t.dataset.id)); },
  'p-save'(t) { saveProduct(t.dataset.id ? Number(t.dataset.id) : null); },
  'p-restock'(t) { restockDialog(Number(t.dataset.id)); },
  'r-save'(t) { saveRestock(Number(t.dataset.id)); },
  'p-hist'(t) { historyDialog(Number(t.dataset.id)); },
  async 'p-del'(t) {
    const p = prodById(Number(t.dataset.id));
    if (!p) return;
    if (!(await ask(`Excluir "${p.name}"? As vendas já feitas continuam no histórico.`, 'Excluir', true))) return;
    await guarded(async () => {
      await api('DELETE', `/api/products/${p.id}`);
      await render();
      toast('Produto excluído');
    });
  },
  cats() { catsDialog(); },
  'cat-add'() {
    const v = $('#cat-new').value.trim();
    if (!v) { $('#c-err').textContent = 'Digite o nome da categoria.'; return; }
    catCall('POST', '/api/categories', { name: v });
  },
  'cat-save'(t) {
    const id = t.dataset.id;
    catCall('PUT', `/api/categories/${id}`, { name: $(`[data-cat-input="${id}"]`).value });
  },
  'cat-del'(t) { catCall('DELETE', `/api/categories/${t.dataset.id}`); },
});

INPUTS.push(e => {
  const id = e.target.id;
  if (id === 'sq') { App.sq = e.target.value; renderStockTable(); return true; }
  if (id === 'f-cost' || id === 'f-price') { updMargin(); return true; }
  return false;
});
CHANGES.push(e => {
  const id = e.target.id;
  if (id === 'scat') { App.scat = e.target.value; renderStockTable(); return true; }
  if (id === 'slow') { App.slow = e.target.checked; renderStockTable(); return true; }
  return false;
});
