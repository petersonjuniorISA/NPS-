# NPS dos ISAs

Painel semanal do NPS dos ISAs, feito para substituir o preenchimento manual do
Notion. Site estático, publicado no GitHub Pages.

## Como funciona

O painel tem três fontes de dados, com níveis de automação diferentes:

1. **NPS (Databricks) — 100% automático.** Toda segunda-feira às 8h, o
   Agendador de Tarefas do Windows roda `scripts/weekly_update.ps1` na
   máquina do Peterson, que chama `scripts/fetch_databricks.py` — esse
   script consulta a tabela de respostas do NPS no Databricks (usando login
   OAuth salvo localmente, sem token), calcula os indicadores (NPS geral,
   distribuição, nota por pergunta, NPS por especialidade, satisfação por
   especialidade, histórico), sobrescreve `data/nps.json` e sobe direto pro
   GitHub. O site lê esse arquivo — ninguém precisa preencher nada.

   Essa tarefa só roda com a máquina ligada e o usuário logado (ver seção
   "Conectar no Databricks" abaixo pra saber por quê). Existe também um
   workflow do GitHub Actions (`.github/workflows/update-nps-data.yml`) já
   pronto, pra caso o time de dados libere um Personal Access Token no
   futuro — aí a automação passa a rodar na nuvem em vez de na máquina
   local.

2. **Zendesk + narrativa semanal — preenchido à mão num arquivo do
   próprio repositório.** Esses números hoje não vêm do Databricks, então
   continuam sendo preenchidos por alguém, só que agora em
   `data/zendesk_semanal.csv` (editado direto pelo site do GitHub, que tem
   um editor de tabela pra CSV) em vez do Notion ou de uma planilha externa
   — o Workspace da ISA bloqueia publicação externa do Google Sheets, então
   esse caminho evita esbarrar nisso. O site lê esse arquivo direto (mesma
   origem do GitHub Pages), então basta editar e comitar — a próxima
   visita à página já reflete a mudança.

3. **Metas do NPS — preenchido à mão, raramente.** A liderança define a meta
   de NPS por mês na planilha "Metas 2S - Isa Experience" (a mesma que já
   existe hoje, com as metas do semestre por KPI). Esses números não mudam
   toda semana, então ficam num arquivo simples, `data/metas.json`, editado
   só quando a meta do mês muda. O site usa isso para mostrar a linha de
   "meta" no gráfico de histórico do NPS e o "Real vs. Meta" no card
   principal — igual ao que já existia no Notion.

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

A conta do Peterson não tem permissão pra gerar Personal Access Token
("Tokens are disabled for your organization"). Por isso a automação usa
**login OAuth normal** (o mesmo processo de login do navegador), que já
confirmou ter acesso de leitura à tabela (grupo `isa_experience_readers`).

A limitação: esse login fica salvo de forma segura *na máquina onde foi
feito*, então a automação só roda **nessa máquina, com o usuário logado**
(por isso o Agendador de Tarefas do Windows, e não um workflow na nuvem).

**Configuração inicial (uma vez só, na máquina que vai rodar a tarefa):**

1. Instalar o CLI do Databricks: `winget install --id Databricks.DatabricksCLI -e`
2. Rodar `databricks auth login --host https://dbc-0fbb1123-410c.cloud.databricks.com`
   — abre o navegador, faz login normal com a conta `@isasaude.com`.
3. Testar: `python scripts/fetch_databricks.py` — se funcionar, escreve
   `data/nps.json` com dados reais.
4. Registrar a tarefa agendada (Windows), toda segunda às 8h:

   ```powershell
   $scriptPath = "C:\Users\Peterson.Junior\Programação\NPS-\scripts\weekly_update.ps1"
   $action = New-ScheduledTaskAction -Execute "powershell.exe" -Argument "-ExecutionPolicy Bypass -NoProfile -File `"$scriptPath`""
   $trigger = New-ScheduledTaskTrigger -Weekly -DaysOfWeek Monday -At 8:00AM
   $settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -DontStopOnIdleEnd
   Register-ScheduledTask -TaskName "NPS-ISAs-AtualizacaoSemanal" -Action $action -Trigger $trigger -Settings $settings -Description "Atualiza o painel de NPS dos ISAs com dados do Databricks e publica no GitHub"
   ```

Isso já está feito nesta máquina. Pontos de atenção:

- **A automação só roda com o PC ligado e você logado** no horário
  agendado (segunda 8h). Se o PC estiver desligado, aquela semana não
  atualiza sozinha — `StartWhenAvailable` faz a tarefa rodar assim que o PC
  ligar de novo, mas não recupera retroativamente.
- **A sessão OAuth pode expirar** (troca de senha, política de segurança da
  empresa). Se a tarefa começar a falhar, rode `databricks auth login`
  de novo manualmente. Os logs de cada execução ficam em `logs/` (não
  versionados).
- Se um dia o time de dados liberar um Personal Access Token, dá pra migrar
  pra automação na nuvem: basta cadastrar `DATABRICKS_TOKEN`,
  `DATABRICKS_HOST`, `DATABRICKS_HTTP_PATH` e `DATABRICKS_TABLE` como
  secrets em **Settings > Secrets and variables > Actions** do repositório
  — o workflow `.github/workflows/update-nps-data.yml` já está pronto e
  passa a ser usado automaticamente assim que o token existir (o script
  prioriza `DATABRICKS_TOKEN` quando ele está definido).

Sem nenhuma dessas duas automações configuradas, o site continua
funcionando com os últimos dados gravados em `data/nps.json`.

### 3. Atualizar os indicadores de Zendesk + narrativa semanal

Esses dados ficam em `data/zendesk_semanal.csv`, dentro do próprio
repositório — **não é uma planilha do Google**. A ideia inicial era usar
Google Sheets publicado como CSV, mas o Workspace da ISA bloqueia
publicação externa (a página fica pedindo login mesmo com o link
"publicado"), então esse arquivo no GitHub é o caminho mais simples que
não esbarra nessa restrição.

Toda semana, pra adicionar os números:

1. Abra [`data/zendesk_semanal.csv`](data/zendesk_semanal.csv) no GitHub.
2. Clique no ícone de lápis (editar) no canto superior direito do arquivo.
   O GitHub mostra a tabela num editor tipo planilha — não precisa mexer
   com vírgulas ou aspas manualmente, é só clicar na célula e digitar.
3. Adicione uma linha nova com `semana` de 1 a 4 e preencha as colunas de
   Zendesk e a narrativa daquela semana. No fim do mês, adicione também uma
   linha com `semana = 0` (o resumo mensal, que entra no gráfico de
   histórico).
4. Clique em **Commit changes** (direto na branch `main` é suficiente pra
   esse projeto).

O site lê esse arquivo direto (mesma origem do GitHub Pages, sem
CORS/login envolvido) e atualiza sozinho na próxima vez que alguém abrir a
página — não precisa rodar nada.

Colunas esperadas (a primeira linha do arquivo já traz isso):

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

### 4. Atualizar a meta do NPS

Sempre que a meta do mês mudar na planilha "Metas 2S - Isa Experience", edite
`data/metas.json` e suba a alteração. Formato:

```json
{
  "nps": {
    "baseline": 39,
    "2026-09": 48.6,
    "2026-10": 54.3
  }
}
```

Cada chave é um mês (`AAAA-MM`) e o valor é a meta de NPS daquele mês. O site
usa isso para desenhar a linha "NPS meta" no histórico e o "Real vs. Meta" no
card principal. Meses sem meta cadastrada simplesmente não mostram essa
comparação.

### 5. Espelhar no Google Sites (acesso restrito ao domínio ISA)

Já feito: **https://sites.google.com/isasaude.com/nps-dos-isas** — site
criado no Google Sites (Workspace ISA Saúde), com um bloco de **Incorporar**
apontando para a URL do GitHub Pages
(`https://petersonjuniorisa.github.io/NPS-/`), e visibilidade padrão
"Qualquer pessoa em ISA Saúde" (ou seja, restrito ao domínio
`isasaude.com` por padrão — não precisou configurar nada extra).

Para editar esse site depois (ex.: trocar o título, adicionar mais
páginas): abra o link acima, clique no ícone de lápis/editar no canto
inferior direito, e use **Publicar** quando terminar as alterações.

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
data/metas.json                 Metas de NPS por mês (editar à mão, raramente)
data/zendesk_semanal.csv        Dados de Zendesk + narrativa (editar direto no GitHub)
scripts/fetch_databricks.py     Script que busca e processa os dados do Databricks
.github/workflows/update-nps-data.yml  Roda o script acima toda semana
```
