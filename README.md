# Mercado Aliança — Estoque e Vendas

Front-end em HTML/CSS/JS puro (pasta `public/`) e backend em Node.js + Express com banco SQLite (pasta `server/`).

## Rodar no computador

Requisitos: Node.js 22 ou mais novo (https://nodejs.org).

```bash
npm install
npm start
```

Abra http://localhost:3000.

No primeiro start o sistema cria o usuário **dono**. Se você não definir `ADMIN_PASSWORD`, uma senha aleatória aparece no terminal. Anote e troque em **Senha** (canto superior direito).

Para definir a senha logo de início:

```bash
ADMIN_PASSWORD='uma-senha-forte' npm start      # Linux / Mac
$env:ADMIN_PASSWORD='uma-senha-forte'; npm start  # Windows PowerShell
```

O banco fica em `data/mercado.db`.

## Variáveis de ambiente

| Variável | Padrão | Para quê |
|---|---|---|
| `PORT` | `3000` | Porta do servidor |
| `DATA_DIR` | `./data` | Pasta do banco SQLite |
| `ADMIN_USER` | `dono` | Usuário criado no primeiro start |
| `ADMIN_PASSWORD` | aleatória (aparece no log) | Senha do primeiro dono (mínimo 8 caracteres) |
| `TZ_OFFSET_MINUTES` | `-180` | Fuso usado para fechar o dia e o mês (Brasília/Fortaleza) |
| `TRUST_PROXY` | automático no Railway | `1` quando estiver atrás de proxy HTTPS |

## Deploy no Railway

1. Suba esta pasta para um repositório e crie o serviço no Railway a partir dele (o `npm start` roda sozinho).
2. **Crie um Volume** e monte em `/data`.
3. Defina `DATA_DIR=/data` e `ADMIN_PASSWORD=...`.

Sem o volume, o banco fica dentro do container e **é apagado a cada novo deploy**. Isso não é opcional.

Use sempre **uma única instância** do serviço (SQLite não é para várias instâncias gravando ao mesmo tempo).

## Perfis

- **Dono:** tudo. Cadastra e edita produtos, vê preço de compra, lucro e relatórios, cancela vendas, gerencia usuários, baixa backup.
- **Caixa:** só vende e consulta as próprias vendas do dia. Não vê preço de compra nem lucro (o servidor nem envia esses dados).

## Regras do sistema

- Preço e custo da venda vêm sempre do banco, nunca do navegador.
- A venda grava o preço e o custo da época. Mudar o preço depois não altera vendas antigas nem o lucro do passado.
- Venda e baixa de estoque acontecem na mesma transação. Duas vendas ao mesmo tempo do último item: só uma passa.
- Reenviar a mesma venda (queda de internet no meio) não duplica: cada venda tem um identificador de requisição.
- Cancelar venda devolve o estoque e tira o valor do lucro. Fica registrado quem cancelou e o motivo.
- Todo movimento de estoque (cadastro, entrada, ajuste, venda, cancelamento) fica no histórico do produto.
- Excluir produto é lógico: ele some das telas, mas as vendas antigas continuam no histórico.
- O custo do produto passa a ser o último preço de compra informado na entrada (não há custo médio ponderado).
- Dinheiro em centavos inteiros; quantidades em milésimos. Sem erro de arredondamento de ponto flutuante.

## Backup e restauração

- **Lucro do mês → Baixar backup do banco** gera uma cópia consistente do `mercado.db`.
- Restaurar: pare o servidor, substitua `mercado.db` pelo arquivo do backup (apague `mercado.db-wal` e `mercado.db-shm` se existirem) e inicie de novo.
- **Exportar vendas do mês (CSV)** abre direto no Excel (separador `;`).

## Limites desta versão

- Precisa de internet (ou da rede local) para vender. Não há modo offline.
- Não emite nota fiscal (NFC-e/SAT) nem integra com maquininha.
- Sem controle de lote/validade, fornecedor, contas a pagar ou fiado.
- Um único mercado por instalação.

## Testes

```bash
npm test
```

Cobrem venda, baixa de estoque, desconto, cancelamento, permissões, login, virada de mês e concorrência.

## Estrutura

```
server/   index.js (start) · app.js (rotas e regras) · db.js (schema) · auth.js (senhas e sessão)
public/   index.html · css/style.css · js/ (uma tela por arquivo)
test/     api.test.js
```
