'use strict';
/* Inicialização, login, navegação por abas e roteamento de eventos. */

const VIEWS = { venda: viewVenda, estoque: viewEstoque, vendas: viewVendas, relatorio: viewRelatorio, usuarios: viewUsuarios };

function tabsFor(u) {
  const t = [['venda', 'Vender']];
  if (u.role === 'dono') t.push(['estoque', 'Estoque'], ['vendas', 'Vendas'], ['relatorio', 'Lucro do mês'], ['usuarios', 'Usuários']);
  else t.push(['vendas', 'Minhas vendas']);
  return t;
}

function renderTabs() {
  const el = $('#tabs');
  if (!el || !App.user) return;
  const low = isOwner() ? lowCount() : 0;
  el.innerHTML = tabsFor(App.user).map(([k, l]) =>
    `<button class="tab${App.tab === k ? ' on' : ''}" data-act="tab" data-tab="${k}">${l}${k === 'estoque' && low ? `<i class="dot">${low}</i>` : ''}</button>`).join('');
  // No celular as abas rolam de lado: mantém a aba atual à vista.
  const on = el.querySelector('.tab.on');
  if (on && el.scrollWidth > el.clientWidth) el.scrollLeft = on.offsetLeft - (el.clientWidth - on.offsetWidth) / 2;
}

function showLogin(msg) {
  App.user = null;
  closeDialog();
  $('#root').innerHTML = `<div class="login-wrap"><form class="login" id="login-form" autocomplete="on">
    <h1>🛒 Mercado Aliança</h1><p>Entre para continuar.</p>
    <label>Usuário<input id="l-user" name="username" autocomplete="username" autocapitalize="none" autofocus></label>
    <label>Senha<input id="l-pass" name="password" type="password" autocomplete="current-password"></label>
    <div class="err" id="l-err">${esc(msg || '')}</div>
    <button class="btn primary lg" style="width:100%" type="submit" id="l-btn">Entrar</button></form></div>`;
}

function showShell() {
  $('#root').innerHTML = `<header class="top"><div class="brand">🛒 Mercado Aliança</div><nav id="tabs"></nav>
    <div class="who"><span>${esc(App.user.name)}<small>${ROLE[App.user.role]}</small></span>
    <button class="btn sm" data-act="pw">Senha</button><button class="btn sm" data-act="logout">Sair</button></div></header>
    <main id="app"></main>`;
}

async function render() {
  if (!App.user) return;
  renderTabs();
  const my = ++App.seq;
  const live = () => my === App.seq;
  const app = $('#app');
  if (!app.innerHTML.trim()) app.innerHTML = '<p class="empty">Carregando…</p>';
  try {
    await VIEWS[App.tab](live);
    renderTabs();
  } catch (e) {
    if (live() && App.user) {
      app.innerHTML = `<div class="card"><p class="empty neg">${esc(e.message)}</p><div class="actions"><button class="btn primary" data-act="reload">Tentar de novo</button></div></div>`;
    }
  }
}

async function enterApp(user) {
  App.user = user;
  if (!tabsFor(user).some(([k]) => k === App.tab)) App.tab = 'venda';
  showShell();
  await render();
}

App.onSessionExpired = () => {
  if (App.user) showLogin('Sua sessão expirou. Entre novamente.');
};

Object.assign(H, {
  tab(t) { App.tab = t.dataset.tab; $('#app').innerHTML = ''; render(); window.scrollTo(0, 0); },
  reload() { render(); },
  async logout() {
    try { await api('POST', '/api/logout'); } catch (e) { /* sai mesmo assim */ }
    App.cart = []; App.discount = ''; App.received = ''; App.reqId = null; App.cartError = '';
    App.tab = 'venda';
    showLogin();
  },
});

// No celular as tabelas ".tbl.mob" viram cartões: cada célula ganha o nome da coluna.
function labelTables(root) {
  root.querySelectorAll('.tbl.mob').forEach(t => {
    const heads = [...t.querySelectorAll('thead th')].map(th => th.textContent.trim());
    t.querySelectorAll('tbody tr').forEach(tr => {
      [...tr.children].forEach((td, i) => { if (heads[i] && !td.dataset.label) td.dataset.label = heads[i]; });
    });
  });
}
new MutationObserver(() => labelTables(document)).observe(document.body, { childList: true, subtree: true });

document.addEventListener('click', e => {
  const t = e.target.closest('[data-act]');
  if (!t || t.disabled) return;
  const f = H[t.dataset.act];
  if (f) f(t, e);
});
document.addEventListener('input', e => { for (const f of INPUTS) if (f(e)) return; });
document.addEventListener('change', e => { for (const f of CHANGES) if (f(e)) return; });
document.addEventListener('keydown', e => {
  for (const f of KEYDOWNS) if (f(e)) return;
  if (e.key === 'Enter' && dlg.open && e.target.tagName === 'INPUT') {
    const b = dlg.querySelector('[data-primary]');
    if (b) { e.preventDefault(); b.click(); }
  }
});
document.addEventListener('submit', async e => {
  if (e.target.id !== 'login-form') return;
  e.preventDefault();
  const err = $('#l-err');
  const btn = $('#l-btn');
  err.textContent = '';
  btn.disabled = true;
  try {
    const { user } = await api('POST', '/api/login', { username: $('#l-user').value, password: $('#l-pass').value });
    await enterApp(user);
  } catch (ex) {
    err.textContent = ex.message;
    btn.disabled = false;
  }
});

(async function boot() {
  try {
    const { user } = await api('GET', '/api/me');
    await enterApp(user);
  } catch (e) {
    showLogin(e.status === 0 ? e.message : '');
  }
}());
