'use strict';
/* Utilidades globais. Dinheiro trafega em centavos (inteiro); quantidades em decimal. */

const $ = (s, r = document) => r.querySelector(s);
const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const brl = c => (c / 100).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
const num = n => Number(n).toLocaleString('pt-BR', { maximumFractionDigits: 3 });
const r3 = n => Math.round((n + Number.EPSILON) * 1000) / 1000;
const norm = s => String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
const centsIn = c => (c / 100).toFixed(2).replace('.', ',');
const decIn = n => String(n).replace('.', ',');
const pct = f => (f * 100).toFixed(1).replace('.', ',') + '%';
const PAY = { dinheiro: 'Dinheiro', pix: 'Pix', debito: 'Débito', credito: 'Crédito' };
const MOVE = { inicial: 'Cadastro', entrada: 'Entrada', ajuste: 'Ajuste', venda: 'Venda', cancelamento: 'Cancelamento' };

// "1.234,56" / "12,5" / "12.50" -> centavos; NaN se inválido
function parseMoney(s) {
  s = String(s == null ? '' : s).replace(/[^\d,.-]/g, '');
  if (!s) return NaN;
  if (s.includes(',')) s = s.replace(/\./g, '').replace(',', '.');
  else if (/^\d{1,3}(\.\d{3})+$/.test(s)) s = s.replace(/\./g, '');
  const v = parseFloat(s);
  return Number.isNaN(v) ? NaN : Math.round(v * 100);
}
function parseNum(s) {
  s = String(s == null ? '' : s).trim().replace(',', '.');
  if (s === '') return NaN;
  const v = Number(s);
  return Number.isFinite(v) ? v : NaN;
}

const curMonth = d => {
  d = d || new Date();
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0');
};
const monthLabel = m => {
  const [y, mo] = m.split('-').map(Number);
  return new Date(y, mo - 1, 1).toLocaleDateString('pt-BR', { month: 'long', year: 'numeric' });
};
const shiftMonth = (m, d) => {
  const [y, mo] = m.split('-').map(Number);
  return curMonth(new Date(y, mo - 1 + d, 1));
};
const fmtDT = ts => new Date(ts).toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
const uuid = () => (typeof crypto !== 'undefined' && crypto.randomUUID
  ? crypto.randomUUID()
  : 'r' + Date.now().toString(36) + Math.random().toString(36).slice(2, 12));
