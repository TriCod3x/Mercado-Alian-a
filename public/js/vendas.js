'use strict';
/* Histórico de vendas. Dono: por mês, com lucro e cancelamento. Caixa: só as próprias, de hoje. */

function monthBar() {
  return `<div class="mbar"><button class="btn" data-act="m-prev" aria-label="Mês anterior">‹</button>
    <input type="month" id="month" value="${App.month}">
    <button class="btn" data-act="m-next" aria-label="Próximo mês">›</button>
    <span class="lbl">${esc(monthLabel(App.month))}</span></div>`;
}

async function viewVendas(live) {
  const owner = isOwner();
  const sales = await api('GET', owner ? `/api/sales?month=${App.month}` : '/api/sales');
  if (!live()) return;
  App.sales = sales;
  const rows = sales.map(s => `<tr class="${s.status === 'cancelada' ? 'canc' : ''}">
    <td>#${s.number}</td><td>${fmtDT(s.at)}</td>${owner ? `<td>${esc(s.user)}</td>` : ''}
    <td class="sum-cell">${esc(s.items.map(i => `${num(i.qty)}× ${i.name}`).join(', '))}</td>
    <td>${PAY[s.payment] || esc(s.payment)}</td><td class="r">${brl(s.total)}</td>
    ${owner ? `<td class="r">${brl(s.profit)}</td>` : ''}
    <td class="act"><button class="btn sm" data-act="sale-view" data-id="${s.id}">Ver</button></td></tr>`).join('');
  $('#app').innerHTML = (owner ? monthBar() : '') + `<section class="card tblw">
    <h2>${owner ? `Vendas de ${esc(monthLabel(App.month))}` : 'Minhas vendas de hoje'}</h2>
    ${sales.length
    ? `<table class="tbl"><thead><tr><th>Nº</th><th>Data</th>${owner ? '<th>Operador</th>' : ''}<th>Itens</th><th>Pgto</th><th class="r">Total</th>${owner ? '<th class="r">Lucro</th>' : ''}<th></th></tr></thead><tbody>${rows}</tbody></table>`
    : `<p class="empty">${owner ? 'Nenhuma venda neste mês.' : 'Você ainda não fez vendas hoje.'}</p>`}</section>`;
}

function saleDialog(id) {
  const s = App.sales.find(x => x.id === id);
  if (!s) return;
  const owner = isOwner();
  openDialog(`<div class="dbody"><h3>Venda #${s.number} ${s.status === 'cancelada' ? '<span class="badge bad">cancelada</span>' : ''}</h3>
    <p class="hint">${fmtDT(s.at)} · ${esc(s.user)} · ${PAY[s.payment] || esc(s.payment)}</p>
    <div class="tblw"><table class="tbl"><thead><tr><th>Produto</th><th class="r">Qtd</th><th class="r">Preço</th><th class="r">Subtotal</th></tr></thead><tbody>
    ${s.items.map(i => `<tr><td>${esc(i.name)}</td><td class="r">${num(i.qty)} ${i.unit}</td><td class="r">${brl(i.price)}</td><td class="r">${brl(i.total)}</td></tr>`).join('')}</tbody></table></div>
    <div style="margin-top:10px"><div class="srow"><span>Subtotal</span><b>${brl(s.subtotal)}</b></div>
    ${s.discount ? `<div class="srow"><span>Desconto</span><b>− ${brl(s.discount)}</b></div>` : ''}
    <div class="srow big"><span>Total</span><b>${brl(s.total)}</b></div>
    ${s.received != null ? `<div class="srow"><span>Recebido / troco</span><b>${brl(s.received)} / ${brl(s.change)}</b></div>` : ''}
    ${owner ? `<div class="srow"><span>Custo das mercadorias</span><b>${brl(s.cost)}</b></div>
    <div class="srow"><span>Lucro</span><b class="${s.profit < 0 ? 'neg' : ''}">${brl(s.profit)}</b></div>` : ''}
    ${s.cancel_reason ? `<p class="hint">Motivo do cancelamento: ${esc(s.cancel_reason)}</p>` : ''}</div></div>
    <div class="dfoot">${owner && s.status !== 'cancelada' ? `<button class="btn danger" data-act="sale-cancel" data-id="${s.id}">Cancelar venda</button>` : ''}<button class="btn" data-act="dlg-no">Fechar</button></div>`);
}

function cancelDialog(id) {
  const s = App.sales.find(x => x.id === id);
  if (!s) return;
  openDialog(`<div class="dbody"><h3>Cancelar venda #${s.number}?</h3>
    <p style="margin:0 0 10px">Os produtos voltam para o estoque e a venda deixa de contar no lucro. Isso não pode ser desfeito.</p>
    <label>Motivo (opcional)<input id="cancel-reason" maxlength="200" autocomplete="off"></label>
    <div class="err" id="cancel-err"></div></div>
    <div class="dfoot"><button class="btn" data-act="dlg-no">Voltar</button><button class="btn danger" data-act="sale-cancel-do" data-id="${s.id}" data-primary>Cancelar venda</button></div>`);
}

Object.assign(H, {
  'm-prev'() { App.month = shiftMonth(App.month, -1); render(); },
  'm-next'() { App.month = shiftMonth(App.month, 1); render(); },
  'sale-view'(t) { saleDialog(Number(t.dataset.id)); },
  'sale-cancel'(t) { cancelDialog(Number(t.dataset.id)); },
  'sale-cancel-do'(t) {
    const id = Number(t.dataset.id);
    guarded(async () => {
      const n = (App.sales.find(x => x.id === id) || {}).number;
      await api('POST', `/api/sales/${id}/cancel`, { reason: $('#cancel-reason').value });
      closeDialog();
      await render();
      toast(`Venda #${n} cancelada e estoque devolvido`);
    }, m => { const e = $('#cancel-err'); if (e) e.textContent = m; });
  },
});

CHANGES.push(e => {
  if (e.target.id !== 'month') return false;
  if (/^\d{4}-\d{2}$/.test(e.target.value)) { App.month = e.target.value; render(); }
  return true;
});
