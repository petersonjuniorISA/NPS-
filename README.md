# NPS dos ISAs

Painel semanal do NPS dos ISAs, feito para substituir o preenchimento manual do
Notion. Site estático, publicado no GitHub Pages.

## Como funciona

O painel tem duas fontes de dados, com dois níveis de automação diferentes:

1. **NPS (Databricks) — 100% automático.** Toda segunda-feira, um workflow do
   GitHub Actions (`.github/workflows/update-nps-data.yml`) roda o script
   `scripts/fetch_databricks.py`, que consulta a tabela de respostas do NPS no
   Databricks, calcula os indicadores (NPS geral, distribuição, nota por
   pergunta, NPS por especialidade, satisfação por especialidade, histórico) e
   sobrescreve `data/nps.json`. O site lê esse arquivo direto — ninguém precisa
   preencher nada.

2. **Zendesk + narrativa semanal — preenchido à mão numa planilha.** Esses
   números hoje não vêm do Databricks, então continuam sendo preenchidos por
   alguém, só que agora numa planilha do Google Sheets em vez do Notion. O
   site busca essa planilha (publicada como CSV) toda vez que a página é
   aberta, então basta editar a planilha — o site reflete na hora, sem
   precisar mexer em código.

Enquanto a planilha não estiver configurada, o site usa
`data/zendesk_semanal_template.csv` como exemplo (já com os dados de
maio–agosto que estavam no Notion).

## Configuração — passo a passo

### 1. Publicar o site (GitHub Pages)

1. Suba este projeto para `https://github.com/petersonjuniorISA/NPS-`.
2. No repositório, vá em **Settings > Pages**.
3. Em "Build and deployment", escolha **Deploy from a branch**, branch
   `main`, pasta `/ (root)`. Salve.
4. Em alguns minutos o site fica disponível em
   `https://petersonjuniorisa.github.io/NPS-/`.

Como o repositório e o GitHub Pages são públicos por padrão, veja a seção
**Privacidade** mais abaixo antes de divulgar o link.

### 2. Conectar no Databricks

Você vai precisar de um **Personal Access Token** e do **endereço do SQL
Warehouse**. Quem tem acesso de dados/BI no Databricks consegue gerar isso em
2 minutos:

1. No Databricks, ícone do usuário (canto superior direito) > **User
   Settings > Developer > Access tokens > Generate new token**. Copie o
   token (ele só aparece uma vez).
2. Em **SQL Warehouses**, abra o warehouse usado pelo dashboard "NPS ISAs" >
   aba **Connection details**. Copie o **Server hostname** e o **HTTP path**.
3. Descubra o nome completo (`catalog.schema.tabela`) da tabela que alimenta o
   dashboard — pergunte ao time de dados, ou procure em **Catalog** pelas
   tabelas dentro de `isa_experience_dev` (foi o catálogo com esse nome que
   apareceu disponível durante a configuração inicial deste projeto).
4. No GitHub, vá em **Settings > Secrets and variables > Actions > New
   repository secret** e crie 4 secrets:
   - `DATABRICKS_HOST` → o server hostname (ex: `dbc-xxxxxxxx-xxxx.cloud.databricks.com`)
   - `DATABRICKS_HTTP_PATH` → o HTTP path (ex: `/sql/1.0/warehouses/xxxxxxxxxxxxxxxx`)
   - `DATABRICKS_TOKEN` → o token gerado no passo 1
   - `DATABRICKS_TABLE` → o nome completo da tabela (ex: `isa_experience_dev.nps.respostas`)
5. Rode o workflow manualmente uma vez para testar: aba **Actions** >
   "Atualiza dados do NPS" > **Run workflow**. Se der certo, `data/nps.json`
   é atualizado automaticamente com os dados reais.

Sem esses secrets, o site continua funcionando normalmente com os dados de
exemplo (agosto/2026) que já estão em `data/nps.json`.

### 3. Criar a planilha do Zendesk + narrativa semanal

1. Crie uma planilha nova no Google Sheets (dentro da conta/domínio da ISA).
2. Importe o arquivo `data/zendesk_semanal_template.csv` deste projeto
   (**Arquivo > Importar > Fazer upload**, opção "Substituir planilha") —
   ele já vem com as colunas certas e os dados de maio a agosto preenchidos.
3. Toda semana, adicione uma linha nova com `semana` de 1 a 4 e preencha as
   colunas de Zendesk e a narrativa. No fim do mês, adicione também uma linha
   com `semana = 0` (o resumo mensal, que entra no gráfico de histórico).
4. Publique a planilha como CSV: **Arquivo > Compartilhar > Publicar na
   Web** > selecione a aba correta > formato **Valores separados por
   vírgula (.csv)** > **Publicar**. Copie o link gerado.
5. Cole esse link em `js/config.js`, no campo `ZENDESK_CSV_URL`, e suba a
   alteração para o GitHub.

Colunas esperadas no CSV (a primeira linha do template já traz isso):

| coluna | exemplo | observação |
|---|---|---|
| `mes` | `2026-08` | ano-mês |
| `mes_label` | `Agosto` | nome do mês |
| `semana` | `0`, `1`, `2`, `3` ou `4` | `0` = resumo do mês inteiro |
| `periodo` | `3 a 9 de agosto` | só para linhas semanais |
| `csat_ia` | `3.4` | nota 0–5 |
| `csat_humano` | `4.05` | nota 0–5 |
| `tma_primeira_resposta` | `10h` | texto livre (não precisa ser número) |
| `tmr` | `12h48` | texto livre |
| `fcr_pct` | `73.3` | número, sem o `%` |
| `resolucao_ia_pct` | `40` | número, sem o `%` |
| `narrativa` | texto livre | as "alavancas da semana" |

### 4. Espelhar no Google Sites (acesso restrito ao domínio ISA)

Depois que o site estiver publicado e testado, para deixar o acesso restrito
a quem tem e-mail `@isasaude.com`:

1. Crie (ou abra) o site no Google Sites, dentro do domínio da ISA.
2. Adicione um bloco **Inserir > Incorporar** e cole a URL do GitHub Pages
   (`https://petersonjuniorisa.github.io/NPS-/`).
3. Em **Compartilhar**, restrinja o acesso ao domínio `isasaude.com` (ou aos
   grupos/pessoas específicas que devem ver o painel).

**Importante sobre privacidade:** os dados incluem nome do profissional,
cidade e comentários individuais. Restringir o acesso pelo Google Sites
controla quem *encontra* o painel através dele, mas a URL do GitHub Pages em
si continua tecnicamente acessível para quem tiver o link direto (GitHub
Pages não tem controle de acesso no plano gratuito). Se isso for um
problema, as opções são: manter o link do GitHub Pages só circulando dentro
do Google Sites (nunca divulgado à parte), ou migrar a hospedagem para um
serviço com senha/autenticação (ex.: Vercel/Netlify com proteção por senha,
que são planos pagos).

## Rodar localmente

Não precisa de build — é HTML/CSS/JS puro. Basta servir a pasta com
qualquer servidor estático, por exemplo:

```bash
python -m http.server 8000
```

E abrir `http://localhost:8000`.

## Estrutura

```
index.html                      Página do painel
css/styles.css                  Estilos (Design System ISA)
js/app.js                       Lógica de carregamento e renderização
js/config.js                    URL da planilha do Zendesk (preencher)
data/nps.json                   Dados de NPS (gerado automaticamente)
data/zendesk_semanal_template.csv  Modelo/fallback dos dados do Zendesk
scripts/fetch_databricks.py     Script que busca e processa os dados do Databricks
.github/workflows/update-nps-data.yml  Roda o script acima toda semana
```
