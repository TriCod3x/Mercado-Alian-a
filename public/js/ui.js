'use strict';

/* Estado global, registro de ações (data-act) e diálogos. */
const App = {
  user: null,
  tab: 'venda',
  seq: 0,
  busy: false,
  products: [],
  categories: [],
  month: curMonth(),
  sales: [],
  // carrinho do PDV
  cart: [], discount: '', pay: 'dinheiro', received: '', q: '', reqId: null, cartError: '',
  // filtros do estoque
  sq: '', scat: '', slow: false,
};
const H = {}; // ações disparadas por data-act="nome"
const INPUTS = [], CHANGES = [], KEYDOWNS = []; // cada tela registra seus tratadores; devolvem true se trataram
const isOwner = () => !!App.user && App.user.role === 'dono';

let toastT = null;
function toast(msg, ms) {
  const t = $('#toast');
  t.textContent = msg;
  t.classList.add('on');
  clearTimeout(toastT);
  toastT = setTimeout(() => t.classList.remove('on'), ms || 2800);
}

const dlg = $('#dlg');
let pending = null;
function settle(v) {
  const p = pending;
  pending = null;
  if (p) p(v);
}
function openDialog(html) {
  dlg.innerHTML = html;
  if (!dlg.open) dlg.showModal();
}
function closeDialog() {
  if (dlg.open) dlg.close();
}
dlg.addEventListener('close', () => settle(false));
dlg.addEventListener('click', e => { if (e.target === dlg) closeDialog(); });

function ask(msg, okLabel, danger) {
  return new Promise(res => {
    pending = res;
    openDialog(`<div class="dbody"><p style="margin:0 0 6px">${esc(msg)}</p></div>
      <div class="dfoot"><button class="btn" data-act="dlg-no">Cancelar</button>
      <button class="btn ${danger ? 'danger' : 'primary'}" data-act="dlg-yes" data-primary>${esc(okLabel || 'Confirmar')}</button></div>`);
  });
}

// Executa uma ação de gravação evitando clique duplo; mostra o erro onde o chamador indicar.
async function guarded(fn, onError) {
  if (App.busy) return;
  App.busy = true;
  try {
    await fn();
  } catch (e) {
    if (onError) onError(e.message); else toast(e.message, 5000);
  } finally {
    App.busy = false;
  }
}

Object.assign(H, {
  'dlg-yes'() { settle(true); closeDialog(); },
  'dlg-no'() { settle(false); closeDialog(); },
});

/* dados compartilhados pelas telas */
async function loadProducts() { App.products = await api('GET', '/api/products'); }
async function loadCategories() { App.categories = await api('GET', '/api/categories'); }
const lowCount = () => App.products.filter(p => p.low).length;
const prodById = id => App.products.find(p => p.id === id);
