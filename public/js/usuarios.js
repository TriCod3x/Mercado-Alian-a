'use strict';
/* Usuários e senha (dono gerencia; qualquer um troca a própria senha). */

const ROLE = { dono: 'Dono', caixa: 'Caixa' };

async function viewUsuarios(live) {
  const users = await api('GET', '/api/users');
  if (!live()) return;
  App.users = users;
  $('#app').innerHTML = `<div class="toolbar"><h2 style="margin:0;flex:1">Usuários</h2><button class="btn primary" data-act="u-new">+ Novo usuário</button></div>
  <section class="card tblw"><table class="tbl mob"><thead><tr><th>Nome</th><th>Usuário</th><th>Perfil</th><th>Situação</th><th></th></tr></thead><tbody>
  ${users.map(u => `<tr class="${u.active ? '' : 'canc'}"><td class="nm">${esc(u.name)}</td><td>${esc(u.username)}</td><td>${ROLE[u.role]}</td>
    <td>${u.active ? 'Ativo' : 'Desativado'}</td><td class="act"><button class="btn sm" data-act="u-edit" data-id="${u.id}">Editar</button></td></tr>`).join('')}
  </tbody></table></section>
  <p class="hint"><b>Dono</b> vê custos, lucro e gerencia tudo. <b>Caixa</b> só vende e consulta as próprias vendas do dia, sem ver preço de compra nem lucro.</p>`;
}

function userDialog(id) {
  const u = id ? App.users.find(x => x.id === id) : null;
  const self = u && App.user && u.id === App.user.id;
  openDialog(`<div class="dbody"><h3>${u ? 'Editar usuário' : 'Novo usuário'}</h3>
    <label>Nome<input id="u-name" value="${esc(u ? u.name : '')}" autocomplete="off"></label>
    <label>Usuário (para entrar)<input id="u-user" value="${esc(u ? u.username : '')}" ${u ? 'disabled' : ''} autocomplete="off" autocapitalize="none"></label>
    <label>Perfil<select id="u-role" ${self ? 'disabled' : ''}><option value="caixa"${u && u.role === 'caixa' ? ' selected' : ''}>Caixa</option><option value="dono"${u && u.role === 'dono' ? ' selected' : ''}>Dono</option></select></label>
    <label>${u ? 'Nova senha (deixe em branco para manter)' : 'Senha (mínimo 8 caracteres)'}<input id="u-pass" type="password" autocomplete="new-password"></label>
    ${u && !self ? `<label class="chk"><input type="checkbox" id="u-active"${u.active ? ' checked' : ''}> Usuário ativo</label>` : ''}
    <div class="err" id="u-err"></div></div>
    <div class="dfoot"><button class="btn" data-act="dlg-no">Cancelar</button><button class="btn primary" data-act="u-save" data-id="${u ? u.id : ''}" data-primary>Salvar</button></div>`);
}

function passwordDialog() {
  openDialog(`<div class="dbody"><h3>Trocar minha senha</h3>
    <label>Senha atual<input id="pw-cur" type="password" autocomplete="current-password"></label>
    <label>Nova senha (mínimo 8 caracteres)<input id="pw-new" type="password" autocomplete="new-password"></label>
    <label>Repita a nova senha<input id="pw-new2" type="password" autocomplete="new-password"></label>
    <div class="err" id="pw-err"></div></div>
    <div class="dfoot"><button class="btn" data-act="dlg-no">Cancelar</button><button class="btn primary" data-act="pw-save" data-primary>Trocar senha</button></div>`);
}

Object.assign(H, {
  'u-new'() { userDialog(null); },
  'u-edit'(t) { userDialog(Number(t.dataset.id)); },
  'u-save'(t) {
    const id = t.dataset.id ? Number(t.dataset.id) : null;
    const err = m => { const e = $('#u-err'); if (e) e.textContent = m; };
    err('');
    const pass = $('#u-pass').value;
    guarded(async () => {
      if (id) {
        const body = { name: $('#u-name').value };
        if (!$('#u-role').disabled) body.role = $('#u-role').value;
        const act = $('#u-active');
        if (act) body.active = act.checked;
        if (pass) body.password = pass;
        await api('PUT', `/api/users/${id}`, body);
      } else {
        await api('POST', '/api/users', {
          name: $('#u-name').value, username: $('#u-user').value, role: $('#u-role').value, password: pass,
        });
      }
      closeDialog();
      await render();
      toast('Usuário salvo');
    }, err);
  },
  pw() { passwordDialog(); },
  'pw-save'() {
    const err = m => { const e = $('#pw-err'); if (e) e.textContent = m; };
    err('');
    const next = $('#pw-new').value;
    if (next !== $('#pw-new2').value) return err('As senhas novas não são iguais.');
    return guarded(async () => {
      await api('POST', '/api/me/password', { current: $('#pw-cur').value, next });
      closeDialog();
      toast('Senha alterada');
    }, err);
  },
});
