# Mercado Aliança — Estoque e Vendas

Front-end em HTML/CSS/JS puro (pasta `public/`) e backend em Node.js + Express (pasta `server/`), com banco **PostgreSQL no Supabase**.

## Tecnologias

- Node.js 22.13 ou mais novo, Express 5
- PostgreSQL (Supabase), driver `pg` (node-postgres)
- Autenticação própria: senha com scrypt, sessão em cookie httpOnly (o banco guarda só o hash do token)
- Testes: `node:test` + PGlite (PostgreSQL embutido) ou um Postgres real

## Como funciona a ligação com o Supabase

O navegador **nunca** fala com o Supabase. Só o servidor Node acessa o banco, pela connection string do Postgres (que fica em variável de ambiente, nunca no frontend). As regras de dono/caixa são aplicadas no servidor.

No banco, todas as tabelas têm **RLS ligado e nenhuma policy**, e as roles públicas do Supabase (`anon`, `authenticated`) não têm permissão nenhuma. Ou seja: mesmo que alguém pegue a URL/anon key do projeto, a API pública do Supabase não lê nem grava nada. **Não use a chave `service_role` neste sistema** — ela não é necessária.

## Estrutura do banco

| Tabela | Para quê |
|---|---|
| `users` | Donos e caixas (hash scrypt da senha, perfil, ativo) |
| `sessions` | Sessões abertas (hash SHA-256 do token, validade) |
| `categories` | Categorias de produto (nome único, sem diferenciar maiúsculas) |
| `products` | Produtos: preço de venda, custo (último preço de compra), estoque, estoque mínimo, `active` (exclusão lógica) |
| `sales` | Vendas: totais, desconto, pagamento, troco, `request_id` (anti-duplicidade), cancelamento (quem, quando, motivo) |
| `sale_items` | Itens com nome, categoria, preço e custo **da época** da venda |
| `stock_movements` | Histórico de estoque: inicial, entrada, ajuste, venda, cancelamento |

Dinheiro em **centavos inteiros**; quantidades em **milésimos** (1 un = 1000; 0,5 kg = 500). Datas em `timestamptz` (UTC no banco; relatórios fecham dia/mês pelo `TZ_OFFSET_MINUTES`).

O banco também barra dados inconsistentes por conta própria: estoque negativo, total ≠ subtotal − desconto, troco em venda que não é dinheiro, venda cancelada sem quem/quando, código de barras repetido entre produtos ativos, apagar venda ou item. O SQL completo está em [`supabase/schema.sql`](supabase/schema.sql).

## 1. Criar o banco no Supabase

1. Crie uma conta em https://supabase.com e um **New project**. Região recomendada: **South America (São Paulo)**. Anote a **Database Password** que você definir (dá para trocar depois em *Project Settings → Database → Reset database password*).
2. No projeto: **SQL Editor → New query**, cole o conteúdo de `supabase/schema.sql` e clique **Run**. Deve aparecer "Success. No rows returned".
3. **Só se for uma instalação nova (sem migrar dados):** rode também `supabase/seed.sql` (cria as categorias padrão). **Se for migrar do SQLite, não rode o seed.**

## 2. Pegar as credenciais e configurar o `.env`

1. No Supabase, clique no botão **Connect** (topo da página do projeto).
2. Escolha **Session pooler** e copie a **URI**. Ela tem este formato:
   `postgresql://postgres.SEU_PROJECT_REF:[YOUR-PASSWORD]@aws-0-sa-east-1.pooler.supabase.com:5432/postgres`
3. Troque `[YOUR-PASSWORD]` pela senha do banco. Se a senha tiver caracteres especiais (`@ : / ? #`), use uma senha só com letras e números, ou codifique (ex.: `@` vira `%40`).
4. Copie `.env.example` para `.env` e preencha `DATABASE_URL`.
5. **Recomendado:** em *Project Settings → Database → SSL Configuration*, clique **Download certificate** e informe o caminho do arquivo em `DATABASE_CA_CERT` (ou cole o conteúdo). Assim o servidor verifica que está falando com o Supabase de verdade. Sem ele a conexão continua criptografada, mas sem verificação do certificado.

> Por que o *Session pooler* e não a *Direct connection*? A conexão direta do Supabase só funciona por IPv6, que muitas hospedagens (incluindo o Railway) não usam para sair para a internet. O Session pooler funciona por IPv4 e mantém todos os recursos usados aqui (transações, travas).

| Variável | Padrão | Para quê |
|---|---|---|
| `DATABASE_URL` | — (obrigatória) | Connection string do Supabase (Session pooler) |
| `DATABASE_SSL` | `require` | `require`, `verify` (exige certificado) ou `disable` (só Postgres local) |
| `DATABASE_CA_CERT` | — | Certificado do Supabase (caminho ou conteúdo PEM) |
| `PG_POOL_MAX` | `10` | Máximo de conexões deste servidor |
| `PORT` | `3000` | Porta do servidor |
| `ADMIN_USER` | `dono` | Usuário criado no primeiro start (se o banco não tiver usuários) |
| `ADMIN_PASSWORD` | aleatória (aparece no log) | Senha do primeiro dono (mínimo 8 caracteres) |
| `TZ_OFFSET_MINUTES` | `-180` | Fuso usado para fechar o dia e o mês (Brasília/Fortaleza) |
| `TRUST_PROXY` | automático no Railway | `1` quando estiver atrás de proxy HTTPS |

## 3. Rodar no computador

```bash
npm install
node --env-file=.env server/index.js
```

Abra http://localhost:3000. Se o banco estiver vazio (sem migração), o sistema cria o usuário **dono**; sem `ADMIN_PASSWORD`, a senha aparece no terminal — anote e troque em **Senha**.

Se aparecer "Tabelas ausentes no banco", o `schema.sql` ainda não foi executado no Supabase.

## 4. Migrar os dados do SQLite antigo

1. **Baixe o banco atual:** no sistema antigo (ainda no ar), entre como dono → **Lucro do mês → Baixar backup do banco**. Você recebe `alianca-backup-AAAA-MM-DD.db`. Guarde uma cópia em lugar seguro.
2. Crie o projeto Supabase e rode **só** o `schema.sql` (sem o seed).
3. **Simule** (confere tudo e não grava nada):
   ```bash
   node --env-file=.env scripts/migrate-sqlite.js caminho/alianca-backup-AAAA-MM-DD.db --dry-run
   ```
4. Se a simulação terminar sem erro, **grave**:
   ```bash
   node --env-file=.env scripts/migrate-sqlite.js caminho/alianca-backup-AAAA-MM-DD.db
   ```

O que o script faz:
- Copia o arquivo `.db` para `backups/` antes de tudo e abre o original **somente leitura** (nunca altera nem apaga).
- Recusa gravar se o banco de destino já tiver dados.
- Copia usuários (com os mesmos hashes de senha — todos entram com a senha de sempre), categorias, produtos, vendas, itens e movimentações, **preservando os IDs** e números das vendas.
- Tudo numa transação: confere **cada linha e cada coluna** contra a origem, quantidades de registros, totais financeiros e estoque. Se algo não bater, nada é gravado.
- Mostra avisos se os dados antigos já tinham inconsistências (ex.: estoque diferente da soma do histórico) — esses dados são copiados como estão.
- Sessões não são migradas: cada pessoa entra de novo uma vez.

**Faça a migração com o sistema antigo parado** (ou sem vendas acontecendo), para não ficar venda de fora.

**Plano de reversão:** o SQLite original e o Volume do Railway não são tocados. Para voltar, publique de novo a versão anterior (commit "Estado original (SQLite)") com o Volume montado.

## 5. Testes

```bash
npm test
```

Por padrão os testes usam o **PGlite** (PostgreSQL embutido, não precisa de internet nem de Supabase). Cada teste cria um banco novo com o `schema.sql`.

Para rodar contra um **Postgres real** (prova de verdade os testes de vendas simultâneas, que no PGlite rodam em fila):

```bash
TEST_DATABASE_URL='postgresql://...' npm test        # Linux / Mac
$env:TEST_DATABASE_URL='postgresql://...'; npm test  # Windows PowerShell
```

Use um banco **só de teste** (um Postgres local ou um segundo projeto Supabase). Cada teste cria um schema `test_xxx` próprio e o apaga no fim. **Nunca aponte para o banco de produção.**

Cobrem: login/logout, sessão, troca de senha, bloqueio por tentativas, permissões de dono e caixa, produtos, entrada e ajuste de estoque, histórico, venda, desconto rateado, estoque insuficiente, vendas simultâneas de vários caixas, reenvio da mesma venda (inclusive simultâneo), cancelamento e cancelamento duplicado/simultâneo, relatórios, preço histórico, virada de mês no fuso, CSV, backup/restauração e migração do SQLite.

## 6. Publicar no Railway

1. No serviço do Railway, em **Variables**, defina `DATABASE_URL` (a do Session pooler), `ADMIN_PASSWORD` e, de preferência, `DATABASE_CA_CERT` (cole o conteúdo do certificado).
2. Remova a variável `DATA_DIR` (não é mais usada). O **Volume** deixa de ser necessário — mantenha-o até ter certeza de que a migração deu certo, porque ele guarda o banco antigo.
3. Faça o deploy (`npm start` roda sozinho).

Com o banco no Supabase, o serviço pode ter mais de uma instância. Observação: o bloqueio após 5 senhas erradas é contado por instância.

## Perfis

- **Dono:** tudo. Cadastra e edita produtos, vê preço de compra, lucro e relatórios, cancela vendas, gerencia usuários, baixa backup.
- **Caixa:** só vende e consulta as próprias vendas do dia. Não vê preço de compra nem lucro (o servidor nem envia esses dados).

## Regras do sistema

- Preço e custo da venda vêm sempre do banco, nunca do navegador.
- A venda grava o preço e o custo da época. Mudar o preço depois não altera vendas antigas nem o lucro do passado.
- Venda e baixa de estoque acontecem na mesma transação, com as linhas dos produtos travadas. Vários caixas vendendo o último item ao mesmo tempo: só um consegue.
- Número de venda sequencial, sem buracos nem repetição, mesmo com vários caixas.
- Reenviar a mesma venda (queda de internet no meio) não duplica: cada venda tem um identificador de requisição.
- Cancelar venda devolve o estoque e tira o valor do lucro. Fica registrado quem cancelou, quando e o motivo. Cancelar duas vezes não devolve o estoque duas vezes.
- Todo movimento de estoque (cadastro, entrada, ajuste, venda, cancelamento) fica no histórico do produto.
- Excluir produto é lógico: ele some das telas, mas as vendas antigas continuam no histórico.
- O custo do produto passa a ser o último preço de compra informado na entrada (não há custo médio ponderado).
- Dinheiro em centavos inteiros; quantidades em milésimos. Sem erro de arredondamento de ponto flutuante.

## Backup e restauração

- **Lucro do mês → Baixar backup do banco** gera um arquivo `alianca-backup-AAAA-MM-DD.json` com todos os dados (consistente: lido numa única transação). Contém os hashes de senha — guarde em local seguro.
- Pelo terminal: `node --env-file=.env scripts/backup.js` (salva em `backups/`).
- **Restaurar** (num projeto Supabase novo, com só o `schema.sql` executado):
  ```bash
  node --env-file=.env scripts/restore.js alianca-backup-AAAA-MM-DD.json --dry-run   # confere
  node --env-file=.env scripts/restore.js alianca-backup-AAAA-MM-DD.json             # grava
  ```
  A restauração nunca sobrescreve: se o banco já tiver dados, ela recusa.
- O Supabase também faz backups próprios: no plano **Pro**, backups diários (*Database → Backups*), com opção de *Point in Time Recovery*. **No plano gratuito não há backup que você possa restaurar** — baixe o backup JSON com frequência e guarde fora do servidor.
- **Exportar vendas do mês (CSV)** abre direto no Excel (separador `;`).

## Limites desta versão

- Precisa de internet (ou da rede local) para vender. Não há modo offline.
- Não emite nota fiscal (NFC-e/SAT) nem integra com maquininha.
- Sem controle de lote/validade, fornecedor, contas a pagar ou fiado.
- Um único mercado por instalação.

## Estrutura

```
server/    index.js (start) · app.js (rotas e regras) · db.js (conexão Postgres) · auth.js (senhas e sessão) · dataset.js (backup/carga)
supabase/  schema.sql (estrutura do banco) · seed.sql (categorias padrão, só instalação nova)
scripts/   migrate-sqlite.js · backup.js · restore.js
public/    index.html · css/style.css · js/ (uma tela por arquivo)
test/      api.test.js · migration.test.js · support/ · fixtures/
```
