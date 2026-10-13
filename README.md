
<div align="center">

# 🛒 MERCADO ALIANÇA

### Sistema de Gestão Comercial, Estoque e Vendas

**Uma solução completa para organizar operações comerciais, controlar o estoque e acompanhar resultados com segurança.**

![Node.js](https://img.shields.io/badge/Node.js-22+-339933?style=for-the-badge&logo=nodedotjs&logoColor=white)
![Express](https://img.shields.io/badge/Express.js-5-000000?style=for-the-badge&logo=express&logoColor=white)
![PostgreSQL](https://img.shields.io/badge/PostgreSQL-4169E1?style=for-the-badge&logo=postgresql&logoColor=white)
![Supabase](https://img.shields.io/badge/Supabase-3FCF8E?style=for-the-badge&logo=supabase&logoColor=white)
![JavaScript](https://img.shields.io/badge/JavaScript-F7DF1E?style=for-the-badge&logo=javascript&logoColor=black)

**Gestão inteligente • Controle de estoque • Segurança • Escalabilidade**

</div>

---

## 📖 Sobre o projeto

O **Mercado Aliança** é um sistema de gestão comercial desenvolvido para facilitar o gerenciamento das atividades diárias de estabelecimentos varejistas.

A aplicação reúne funcionalidades de controle de produtos, estoque, vendas, usuários e relatórios financeiros em uma plataforma simples e organizada.

O projeto utiliza uma arquitetura cliente-servidor, com backend em Node.js e Express e banco de dados PostgreSQL hospedado no Supabase.

O sistema foi desenvolvido com foco em três pilares:

- **Confiabilidade:** operações comerciais consistentes e proteção contra duplicidade de vendas.
- **Segurança:** autenticação, controle de permissões e proteção das informações financeiras.
- **Organização:** centralização das informações de produtos, estoque, movimentações e vendas.

---

## ✨ Funcionalidades

### 📦 Gestão de produtos

- Cadastro, edição e consulta de produtos.
- Organização por categorias.
- Controle de preços de compra e venda.
- Acompanhamento das quantidades disponíveis.
- Desativação de produtos sem perda do histórico.

### 📊 Controle de estoque

- Registro de entradas e ajustes.
- Histórico de movimentações.
- Atualização automática após vendas.
- Devolução de mercadorias ao cancelar vendas.
- Proteção contra estoque negativo.
- Consistência em operações simultâneas.

### 🛒 Gestão de vendas

- Registro de vendas com múltiplos produtos.
- Aplicação de descontos.
- Cálculo automático dos valores.
- Registro histórico de preços e custos.
- Proteção contra vendas duplicadas.
- Cancelamento controlado com reposição de estoque.
- Processamento transacional das operações.

### 👥 Usuários e permissões

O sistema possui dois perfis principais:

| Recurso | Dono | Caixa |
|---|:---:|:---:|
| Realizar vendas | ✅ | ✅ |
| Consultar produtos | ✅ | ✅ |
| Gerenciar produtos | ✅ | Restrito |
| Controlar estoque | ✅ | Restrito |
| Visualizar custos | ✅ | ❌ |
| Visualizar lucro | ✅ | ❌ |
| Relatórios administrativos | ✅ | ❌ |
| Cancelar vendas | ✅ | ❌ |
| Gerenciar usuários | ✅ | ❌ |

As permissões são verificadas diretamente no backend.

### 📈 Relatórios gerenciais

- Acompanhamento das vendas.
- Indicadores de faturamento.
- Análise de custos e lucro.
- Histórico de operações.
- Informações para apoiar decisões comerciais.

### 🔐 Segurança

- Autenticação com senhas protegidas por hash `scrypt`.
- Sessões persistidas no PostgreSQL.
- Controle de acesso por perfil.
- Cookies de sessão.
- Consultas parametrizadas.
- Transações atômicas.
- Comunicação criptografada com o banco.
- Row Level Security (RLS) habilitado no Supabase.

---

## 🖥️ Demonstração

Adicione aqui imagens reais do sistema para apresentar sua interface.

| Dashboard | Controle de produtos |
|---|---|
| `docs/images/dashboard.png` | `docs/images/produtos.png` |

| Vendas | Relatórios |
|---|---|
| `docs/images/vendas.png` | `docs/images/relatorios.png` |

> As imagens acima são caminhos sugeridos. Substitua esta seção por capturas reais da aplicação.

---

## 🛠️ Tecnologias utilizadas

| Camada | Tecnologia |
|---|---|
| Frontend | HTML5, CSS3 e JavaScript |
| Backend | Node.js e Express |
| Banco de dados | PostgreSQL |
| Infraestrutura do banco | Supabase |
| Driver PostgreSQL | `pg` |
| Autenticação | Sessões e hash `scrypt` |
| Testes | Node.js Test Runner e PGlite |
| Versionamento | Git e GitHub |
| Hospedagem planejada | Railway |

---

## 🏗️ Arquitetura do sistema

```text
┌──────────────────────────┐
│         FRONTEND         │
│    HTML + CSS + JS       │
└────────────┬─────────────┘
             │ HTTP / API
             ▼
┌──────────────────────────┐
│          BACKEND         │
│    Node.js + Express     │
│                          │
│  • Autenticação          │
│  • Permissões            │
│  • Regras de negócio     │
│  • Vendas e estoque      │
│  • Relatórios            │
└────────────┬─────────────┘
             │ PostgreSQL
             ▼
┌──────────────────────────┐
│         SUPABASE         │
│                          │
│  • PostgreSQL            │
│  • Transações            │
│  • Integridade dos dados │
│  • RLS                   │
└──────────────────────────┘
```

O frontend se comunica com o backend por meio de uma API. O backend é responsável pela validação das operações, autenticação, autorização e acesso ao banco.

As credenciais de acesso ao PostgreSQL permanecem exclusivamente no servidor.

---

## 🗄️ Estrutura do banco de dados

O PostgreSQL possui as seguintes tabelas principais:

| Tabela | Responsabilidade |
|---|---|
| `users` | Usuários e perfis de acesso |
| `sessions` | Sessões autenticadas |
| `categories` | Categorias dos produtos |
| `products` | Produtos, preços e estoque |
| `sales` | Registro das vendas |
| `sale_items` | Produtos vinculados às vendas |
| `stock_movements` | Histórico de movimentações do estoque |

Os valores monetários são armazenados em centavos inteiros, e as quantidades utilizam milésimos para preservar a precisão dos cálculos.

### Integridade das vendas

O registro de uma venda é realizado dentro de uma transação PostgreSQL.

Isso permite que a venda e a atualização do estoque sejam confirmadas juntas ou revertidas em caso de falha.

Também são utilizados mecanismos de controle de concorrência e idempotência para reduzir riscos de inconsistências em operações simultâneas.

---

## 🚀 Instalação e execução

### Pré-requisitos

Antes de iniciar, tenha instalado:

- Node.js 22 ou superior.
- Git.
- Uma instância PostgreSQL no Supabase.
- Um editor de código, como VS Code.

### 1. Clone o repositório

```bash
git clone https://github.com/SEU-USUARIO/mercado-alianca.git
cd mercado-alianca
```

### 2. Instale as dependências

```bash
npm install
```

### 3. Configure as variáveis de ambiente

Crie um arquivo `.env` na raiz do projeto, utilizando o `.env.example` como referência.

```env
DATABASE_URL=postgresql://USUARIO:SENHA@HOST:5432/postgres
DATABASE_SSL=require
PG_POOL_MAX=10

PORT=3000
ADMIN_USER=dono
ADMIN_PASSWORD=DEFINA_UMA_SENHA_FORTE
TZ_OFFSET_MINUTES=-180
```

A URI deve ser obtida diretamente no painel do Supabase, preferencialmente pela opção **Session Pooler**, conforme a compatibilidade do ambiente.

**Nunca publique o arquivo `.env` ou credenciais reais no GitHub.**

### 4. Prepare o banco

No painel do Supabase, acesse:

**SQL Editor → New Query**

Execute os arquivos SQL do projeto, nesta ordem:

```text
supabase/schema.sql
supabase/seed.sql
```

O primeiro cria a estrutura do banco e o segundo adiciona os dados iniciais necessários.

Execute os scripts apenas em um banco apropriado, verificando previamente se já existem tabelas e dados.

### 5. Inicie a aplicação

```bash
node --env-file=.env server/index.js
```

Acesse:

**http://localhost:3000**

---

## 🧪 Testes automatizados

O projeto possui testes para validar o funcionamento da aplicação e a integridade das operações comerciais.

Execute:

```bash
npm test
```

A suíte de testes cobre funcionalidades como:

- Autenticação e permissões.
- Cadastro e gerenciamento de produtos.
- Movimentações de estoque.
- Registro e cancelamento de vendas.
- Vendas simultâneas.
- Proteção contra duplicidade.
- Relatórios.
- Migração, backup e restauração.

Na validação da migração para PostgreSQL, **21 testes automatizados foram executados com sucesso**, incluindo testes com PostgreSQL real e PGlite.

---

## 💾 Backup e recuperação

O sistema disponibiliza mecanismos para exportação e recuperação de dados.

Arquivos relacionados:

```text
scripts/backup.js
scripts/restore.js
scripts/migrate-sqlite.js
```

O sistema também disponibiliza exportação de backup em JSON.

A restauração de dados deve ser realizada com cuidado, preferencialmente após validação em ambiente de teste.

---

## ☁️ Implantação

A arquitetura permite executar o backend em uma plataforma de hospedagem Node.js, como o Railway, mantendo o PostgreSQL no Supabase.

Para implantação, é necessário configurar as variáveis de ambiente no serviço de hospedagem.

Variáveis principais:

```text
DATABASE_URL
DATABASE_SSL
PG_POOL_MAX
PORT
ADMIN_USER
ADMIN_PASSWORD
TZ_OFFSET_MINUTES
```

A publicação em produção deve ser validada com testes de conexão, autenticação, vendas e integridade do estoque.

---

## 📁 Organização do projeto

```text
mercado-alianca/
│
├── public/
│   └── Interface web
│
├── server/
│   ├── app.js
│   ├── auth.js
│   ├── db.js
│   ├── dataset.js
│   └── index.js
│
├── supabase/
│   ├── schema.sql
│   └── seed.sql
│
├── scripts/
│   ├── backup.js
│   ├── restore.js
│   ├── migrate-sqlite.js
│   └── lib/
│       └── transfer.js
│
├── test/
│   ├── api.test.js
│   ├── migration.test.js
│   └── support/
│
├── .env.example
├── .gitignore
├── package.json
└── README.md
```

---

## 🔄 Evolução do projeto

O Mercado Aliança passou por uma evolução de infraestrutura, migrando do banco de dados local SQLite para PostgreSQL hospedado no Supabase.

A migração teve como objetivos:

- Centralizar os dados em um banco online.
- Melhorar o suporte a acessos simultâneos.
- Preservar a integridade das operações.
- Preparar a aplicação para hospedagem.
- Manter a compatibilidade com a interface existente.

A migração foi validada com testes automatizados e verificações manuais das principais funcionalidades.

---

## 📌 Status do projeto

| Componente | Situação |
|---|---|
| Interface web | Implementada |
| Backend Node.js | Implementado |
| PostgreSQL / Supabase | Integrado |
| Autenticação | Implementada |
| Controle de estoque | Implementado |
| Gestão de vendas | Implementada |
| Relatórios | Implementados |
| Testes automatizados | 21 testes aprovados na migração |
| Publicação Railway | Pendente |

---



### 🛒 Mercado Aliança

**Tecnologia aplicada à gestão comercial.**

Desenvolvido com Node.js, Express, PostgreSQL e Supabase.

</div>
