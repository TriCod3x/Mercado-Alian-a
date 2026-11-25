'use strict';
/* Tela de venda (PDV): carrinho local, preço e estoque confirmados pelo servidor. */

// Qualquer mudança no carrinho invalida o request_id e o erro anterior.
function touchCart() { App.reqId = null; App.cartError = ''; }

const cartMilli = qty => Math.round(qty * 1000);

function cartCalc() {
  const lines = [];
  App.cart.forEach(l => {
    const p = prodById(l.pid);
    if (!p) return;
    const qty = parseNum(l.qty);
    const milli = cartMilli(qty);
    const ok = qty > 0 && qty <= p.stock + 1e-9 && Math.abs(milli - qty * 1000) < 1e-6
      && (p.unit === 'kg' || Number.isInteger(qty));
    lines.push({ l, p, qty, ok, sub: qty > 0 ? Math.round((p.price * milli) / 1000) : 0 });
  });
  const subtotal = lines.reduce((a, x) => a + x.sub, 0);
  const dTxt = App.discount.trim();
  let disc = 0;
  let discBad = false;
  if (dTxt !== '') {
    const v = parseMoney(dTxt);
    if (Number.isNaN(v) || v < 0 || v > subtotal) discBad = true; else disc = v;
  }
  const total = subtotal - disc;
  const recv = App.received.trim() === '' ? NaN : parseMoney(App.received);
  const cashShort = App.pay === 'dinheiro' && !Number.isNaN(recv) && recv < total;
  const canFinish = lines.length > 0 && lines.every(x => x.ok) && !discBad && total > 0 && !cashShort;
  return { lines, subtotal, disc, discBad, total, recv, cashShort, canFinish };
}

async function viewVenda(live) {
  await loadProducts();
  if (!live()) return;
  $('#app').innerHTML = `<div class="pdv">
    <section class="card"><h2>Produtos</h2>
      <input id="q" type="search" placeholder="Buscar por nome ou ler código de barras…" autocomplete="off" value="${esc(App.q)}">
      <div id="plist" class="plist"></div>
    </section>
    <section class="card cart" id="cart-sec"><h2>Venda atual</h2><div id="cart"></div></section>
    <div id="cartbar" class="cartbar"></div>
  </div>`;
  watchCartVisibility();
  renderPList();
  renderCart();
}

function filteredForSale() {
  const q = norm(App.q);
  const raw = App.q.trim();
  return App.products
    .filter(p => !q || norm(p.name).includes(q) || norm(p.category).includes(q) || (p.code && p.code.includes(raw)))
    .sort((a, b) => a.name.localeCompare(b.name, 'pt-BR'));
}

function renderPList() {
  const el = $('#plist');
  if (!el) return;
  if (!App.products.length) {
    el.innerHTML = `<p class="empty">Nenhum produto cadastrado.${isOwner() ? ' Vá em <b>Estoque</b> para cadastrar.' : ' Peça ao dono para cadastrar.'}</p>`;
    return;
  }
  const all = filteredForSale();
  const list = all.slice(0, 60);
  el.innerHTML = list.length
    ? list.map(p => `<button class="prow" data-act="add" data-id="${p.id}" ${p.stock <= 0 ? 'disabled' : ''}>
        <span class="pn">${esc(p.name)}<small>${esc(p.category)} · ${num(p.stock)} ${p.unit} em estoque</small></span>
        <span class="pp">${brl(p.price)}${p.unit === 'kg' ? '/kg' : ''}</span></button>`).join('')
      + (all.length > 60 ? `<p class="hint">Mostrando 60 de ${all.length}. Refine a busca.</p>` : '')
    : '<p class="empty">Nada encontrado.</p>';
}

function addToCart(id) {
  const p = prodById(id);
  if (!p) return;
  if (p.stock <= 0) { toast('Produto sem estoque'); return; }
  const step = p.unit === 'kg' ? 0.5 : 1;
  const ex = App.cart.find(l => l.pid === id);
  if (ex) {
    const n = r3((parseNum(ex.qty) || 0) + step);
    if (n > p.stock + 1e-9) { toast(`Estoque insuficiente (${num(p.stock)} ${p.unit})`); return; }
    ex.qty = decIn(n);
  } else {
    App.cart.push({ pid: id, qty: p.unit === 'kg' ? '0,5' : '1' });
  }
  touchCart();
  renderCart();
}

function renderCart() {
  const el = $('#cart');
  if (!el) return;
  App.cart = App.cart.filter(l => prodById(l.pid));
  if (!App.cart.length) {
    el.innerHTML = '<p class="empty">Carrinho vazio. Toque num produto (ou leia o código de barras) para adicionar.</p>';
    renderCartBar();
    return;
  }
  el.innerHTML = `<div class="lines">${App.cart.map(l => {
    const p = prodById(l.pid);
    return `<div class="line" data-id="${p.id}"><div class="ln-name">${esc(p.name)}<small>${brl(p.price)}${p.unit === 'kg' ? '/kg' : ' cada'}</small></div>
      <div class="qty"><button class="btn sm" data-act="dec" aria-label="Diminuir">−</button><input data-qty inputmode="decimal" value="${esc(l.qty)}" aria-label="Quantidade"><button class="btn sm" data-act="inc" aria-label="Aumentar">+</button></div>
      <div class="ln-sub" data-sub></div><button class="btn sm ghost" data-act="rm" aria-label="Remover">✕</button></div>`;
  }).join('')}</div>
  <div class="sum">
    <div class="srow"><span>Subtotal</span><b data-subtotal></b></div>
    <label class="srow">Desconto (R$)<input id="disc" inputmode="decimal" placeholder="0,00" value="${esc(App.discount)}"></label>
    <div class="srow big"><span>Total</span><b data-total></b></div>
    <label class="srow">Pagamento<select id="pay">${Object.entries(PAY).map(([k, v]) => `<option value="${k}"${App.pay === k ? ' selected' : ''}>${v}</option>`).join('')}</select></label>
    <div id="cash"><label class="srow">Valor recebido<input id="recv" inputmode="decimal" placeholder="0,00" value="${esc(App.received)}"></label><div class="srow"><span>Troco</span><b data-change>—</b></div></div>
    <div class="err" data-cerr></div>
    <div class="actions"><button class="btn" data-act="clear-cart">Limpar</button><button class="btn primary lg" data-act="finish" data-finish>Finalizar venda</button></div>
  </div>`;
  updateCartUI();
}

function updateCartUI() {
  renderCartBar();
  const root = $('#cart');
  if (!root || !App.cart.length) return;
  const c = cartCalc();
  let msg = '';
  c.lines.forEach(x => {
    const row = root.querySelector(`.line[data-id="${x.p.id}"]`);
    if (!row) return;
    row.classList.toggle('bad', !x.ok);
    row.querySelector('[data-sub]').textContent = brl(x.sub);
    if (!x.ok && !msg) msg = `${x.p.name}: quantidade inválida ou acima do estoque (${num(x.p.stock)} ${x.p.unit}).`;
  });
  root.querySelector('[data-subtotal]').textContent = brl(c.subtotal);
  root.querySelector('[data-total]').textContent = brl(c.total);
  $('#cash').hidden = App.pay !== 'dinheiro';
  root.querySelector('[data-change]').textContent = !Number.isNaN(c.recv) && c.recv >= c.total ? brl(c.recv - c.total) : '—';
  if (!msg && c.discBad) msg = 'Desconto inválido (não pode passar do subtotal).';
  if (!msg && c.cashShort) msg = 'Valor recebido menor que o total.';
  if (!msg && App.cartError) msg = App.cartError;
  root.querySelector('[data-cerr]').textContent = msg;
  root.querySelector('[data-finish]').disabled = App.busy || !c.canFinish;
}

async function finalizeSale() {
  const c = cartCalc();
  if (!c.canFinish || App.busy) return;
  const payload = {
    items: c.lines.map(x => ({ product_id: x.p.id, qty: r3(x.qty) })),
    discount: c.disc,
    payment: App.pay,
    request_id: App.reqId || (App.reqId = uuid()),
  };
  if (App.pay === 'dinheiro' && !Number.isNaN(c.recv) && c.recv >= c.total) payload.received = c.recv;
  await guarded(async () => {
    const btn = $('[data-finish]');
    if (btn) btn.disabled = true;
    try {
      const { sale } = await api('POST', '/api/sales', payload);
      App.cart = []; App.discount = ''; App.received = ''; App.reqId = null; App.cartError = '';
      await loadProducts().catch(() => {});
      renderCart(); renderPList(); renderTabs();
      const troco = sale.change != null && sale.change > 0 ? ` · troco ${brl(sale.change)}` : '';
      toast(`Venda #${sale.number} registrada: ${brl(sale.total)}${troco}`, troco ? 6000 : 3500);
      const q = $('#q');
      if (q) q.focus();
    } catch (e) {
      // 4xx: o servidor recusou (ex.: estoque mudou). Atualiza a tela com o estoque real.
      if (e.status >= 400 && e.status < 500) {
        App.reqId = null;
        App.cartError = e.message;
        await loadProducts().catch(() => {});
        renderPList();
      }
      // sem conexão: mantém o request_id, então tentar de novo não duplica a venda
      if (e.status === 0) App.cartError = e.message;
      renderCart();
      throw e;
    }
  }, msg => toast(msg, 6000));
  updateCartUI();
}

function stepQty(t, dir) {
  const row = t.closest('.line');
  const id = Number(row.dataset.id);
  const p = prodById(id);
  const inp = row.querySelector('[data-qty]');
  const l = App.cart.find(x => x.pid === id);
  const step = p.unit === 'kg' ? 0.5 : 1;
  let n = r3((parseNum(inp.value) || 0) + dir * step);
  if (n <= 0) { App.cart = App.cart.filter(x => x.pid !== id); touchCart(); renderCart(); return; }
  if (n > p.stock + 1e-9) { toast(`Estoque insuficiente (${num(p.stock)} ${p.unit})`); n = p.stock; }
  inp.value = l.qty = decIn(n);
  touchCart();
  updateCartUI();
}

Object.assign(H, {
  add(t) { addToCart(Number(t.dataset.id)); },
  inc(t) { stepQty(t, 1); },
  dec(t) { stepQty(t, -1); },
  rm(t) {
    const id = Number(t.closest('.line').dataset.id);
    App.cart = App.cart.filter(l => l.pid !== id);
    touchCart();
    renderCart();
  },
  'clear-cart'() { App.cart = []; App.discount = ''; App.received = ''; touchCart(); renderCart(); },
  finish() { finalizeSale(); },
});

INPUTS.push(e => {
  const t = e.target;
  if (t.id === 'q') { App.q = t.value; renderPList(); return true; }
  if (t.hasAttribute && t.hasAttribute('data-qty')) {
    const l = App.cart.find(x => x.pid === Number(t.closest('.line').dataset.id));
    if (l) { l.qty = t.value; touchCart(); updateCartUI(); }
    return true;
  }
  if (t.id === 'disc') { App.discount = t.value; touchCart(); updateCartUI(); return true; }
  if (t.id === 'recv') { App.received = t.value; touchCart(); updateCartUI(); return true; }
  return false;
});
CHANGES.push(e => {
  if (e.target.id !== 'pay') return false;
  App.pay = e.target.value;
  touchCart();
  updateCartUI();
  return true;
});
KEYDOWNS.push(e => {
  if (e.key !== 'Enter' || e.target.id !== 'q') return false;
  e.preventDefault();
  const raw = e.target.value.trim();
  if (!raw) return true;
  const byCode = App.products.find(p => p.code && p.code === raw);
  const list = filteredForSale();
  const pick = byCode || (list.length === 1 ? list[0] : null);
  if (pick) { addToCart(pick.id); App.q = ''; e.target.value = ''; renderPList(); }
  return true;
});

/* Barra fixa no rodapé (só aparece no celular, pelo CSS): total + atalho para a venda. */
let cartInView = false;
let cartObs = null;
function renderCartBar() {
  const bar = $('#cartbar');
  if (!bar) return;
  const n = App.cart.length;
  bar.closest('.pdv').classList.toggle('has-bar', n > 0);
  if (!n || cartInView) { bar.innerHTML = ''; return; }
  bar.innerHTML = `<div class="cb-info">${n} ${n === 1 ? 'item' : 'itens'}<b>${brl(cartCalc().total)}</b></div>
    <button class="btn primary lg" data-act="go-cart">Ver venda</button>`;
}
function watchCartVisibility() {
  if (cartObs) cartObs.disconnect();
  cartInView = false;
  const sec = $('#cart-sec');
  if (!sec || !('IntersectionObserver' in window)) return;
  cartObs = new IntersectionObserver(([e]) => { cartInView = e.isIntersecting; renderCartBar(); }, { threshold: 0.15 });
  cartObs.observe(sec);
}
H['go-cart'] = () => { const s = $('#cart-sec'); if (s) s.scrollIntoView({ behavior: 'smooth', block: 'start' }); };
