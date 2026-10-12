'use strict';

class ApiError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

// Chama a API. Em 401 (fora do login) avisa o app para voltar à tela de entrada.
async function api(method, url, body) {
  const opt = { method, headers: {}, credentials: 'same-origin' };
  if (body !== undefined) {
    opt.headers['Content-Type'] = 'application/json';
    opt.body = JSON.stringify(body);
  }
  let res;
  try {
    res = await fetch(url, opt);
  } catch (e) {
    throw new ApiError(0, 'Sem conexão com o servidor. Verifique a internet e tente de novo.');
  }
  let data = null;
  if ((res.headers.get('content-type') || '').includes('json')) {
    try { data = await res.json(); } catch (e) { data = null; }
  }
  if (!res.ok) {
    if (res.status === 401 && url !== '/api/login' && url !== '/api/me') App.onSessionExpired();
    throw new ApiError(res.status, (data && data.error) || `Erro inesperado (${res.status}).`);
  }
  return data;
}
