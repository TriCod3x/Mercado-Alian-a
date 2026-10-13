'use strict';
// Carrega um conjunto de dados (backup JSON ou SQLite convertido) num banco
// vazio, numa transação só, e confere tudo antes de confirmar (COMMIT).
// Se qualquer conferência falhar, nada é gravado.
const { loadDataset, compareWithSource, summary, warnings } = require('../../server/dataset');

class DryRun extends Error {}

async function transfer(db, data, { dryRun = false, log = console.log } = {}) {
  let report;
  try {
    await db.tx(async c => {
      await loadDataset(c, data);
      const problems = await compareWithSource(c, data);
      if (problems.length) {
        const shown = problems.slice(0, 20).join('\n  ');
        throw new Error(`Conferência falhou (${problems.length} divergência(s)); nada foi gravado:\n  ${shown}`);
      }
      report = { summary: await summary(c), warnings: await warnings(c) };
      if (dryRun) throw new DryRun();
    });
  } catch (e) {
    if (!(e instanceof DryRun)) throw e;
  }
  log(dryRun ? '\nSIMULAÇÃO concluída: tudo conferido, nada foi gravado (ROLLBACK).' : '\nDados gravados e conferidos (COMMIT).');
  log('Registros:', JSON.stringify(report.summary.counts));
  log('Vendas:', JSON.stringify(report.summary.sales));
  log('Itens:', JSON.stringify(report.summary.items));
  log('Estoque:', JSON.stringify(report.summary.stock), 'Movimentações:', JSON.stringify(report.summary.movements));
  if (report.warnings.length) {
    log(`\nAvisos (${report.warnings.length}) — inconsistências que JÁ existiam na origem, copiadas sem alteração:`);
    report.warnings.slice(0, 50).forEach(w => log('  -', w));
  }
  return report;
}

module.exports = { transfer };
