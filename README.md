# NPS dos ISAs

Painel semanal do NPS dos ISAs, feito para substituir o preenchimento manual do
Notion.

**Onde o painel vive:** num Web App do Google Apps Script, publicado com acesso
restrito a `@isasaude.com`. Só quem tem conta do domínio abre — nem com o link.

O GitHub Pages foi desativado em 10/09/2026. Este repositório continua sendo a
origem do código e dos dados, mas não publica mais site nenhum.

## Como funciona

O painel tem quatro fontes de dados, com níveis de automação diferentes:

1. **NPS (Databricks) — 100% automático.** Toda sexta-feira às 18h, o
   Agendador de Tarefas do Windows roda `scripts/weekly_update.ps1` na
   máquina do Peterson, que chama `scripts/fetch_databricks.py` — esse
   script consulta a tabela de respostas do NPS no Databricks (usando login
   OAuth salvo localmente, sem token), calcula os indicadores (NPS geral,
   distribuição, nota por pergunta, NPS por especialidade, satisfação por
   especialidade, histórico), sobrescreve `data/nps.json` e sobe direto pro
   GitHub. O painel lê esse arquivo — ninguém precisa preencher nada.

   Essa tarefa só roda com a máquina ligada e o usuário logado (ver seção
   "Conectar no Databricks" abaixo pra saber por quê). Havia um workflow do
   GitHub Actions fazendo a mesma coisa na segunda-feira; ele foi removido
   porque disputava com a tarefa de sexta e sobrescrevia o arquivo com dados
   de outro momento.

2. **Zendesk + narrativa semanal — preenchido à mão num arquivo do
   próprio repositório.** Esses números hoje não vêm do Databricks, então
   continuam sendo preenchidos por alguém, só que agora em
   `data/zendesk_semanal.csv` (editado direto pelo site do GitHub, que tem
   um editor de tabela pra CSV) em vez do Notion ou de uma planilha externa
   — o Workspace da ISA bloqueia publicação externa do Google Sheets, então
   esse caminho evita esbarrar nisso. Depois de editar e comitar, rode `py scripts/build_appscript.py`
   e republique no Apps Script para o número novo aparecer.

3. **Metas SMART — preenchido à mão, raramente.** A liderança define as metas
   do semestre na planilha "Metas 2S - Isa Experience". Esses números não
   mudam toda semana, então ficam em `data/metas.json`, editado só quando a
   meta é revisada. O painel cruza meta × realizado sozinho e mostra o
   atingimento de cada objetivo (NPS, CSAT do SAC, Resolução com IA e FCR)
   na página **Metas SMART**, além da linha de meta no histórico do NPS.

4. **Ocorrências (Metabase) — automático assim que houver chave de API.**
   As ocorrências da Comunidade (sem Captação) vêm do Metabase, card 380
   "Ocorrências Finalizadas", sobre o MongoDB de tickets.
   `scripts/fetch_metabase.py` baixa o CSV pela API e
   `scripts/build_ocorrencias.py` calcula volume e SLA em
   `data/ocorrencias.json`. Falta só criar a chave de API e guardá-la — veja
   a seção "Ocorrências (Metabase)" abaixo. Sem a chave, o passo é pulado com
   um aviso e a atualização do NPS segue normalmente.

## Qual recorte o painel mostra

Não há seletor de mês nem de semana. O painel abre sempre no **mês mais
recente com dado** e é isso que ele mostra — tirar a escolha foi decisão de
produto: quem lê o painel quer o número de agora, não um arquivo navegável.

No lugar do seletor, o topo mostra **há quanto tempo o dado foi coletado**
("Atualizado há 4 dias"), que passa a laranja depois de oito dias — a coleta é
semanal, então acima disso alguma automação falhou.

O detalhe semanal não sumiu: ele aparece no **card flutuante**, ao clicar em
qualquer mês de qualquer gráfico mensal. É o mesmo dado, só que puxado quando
alguém quer olhar, em vez de virar um estado do painel inteiro.

O `data/nps.json` continua guardando todos os meses (campo `meses`) e a quebra
semanal de cada um (`semanas`) — nenhum mês perde detalhe quando um novo
entra. O que mudou é que o painel não pergunta mais qual deles você quer.

## Configuração — passo a passo

### 1. Publicar o painel (Apps Script)

O painel é empacotado num arquivo único por `scripts/build_appscript.py` e
colado num projeto do Apps Script. O passo a passo completo está em
`dist/appscript/LEIA-ME.md`.

Resumo: **script.google.com** > novo projeto > cole `Codigo.gs` e um arquivo
HTML chamado `painel` > **Implantar > App da Web** com **"Qualquer pessoa em
ISA Saúde"**.

A URL sai no formato `script.google.com/a/macros/isasaude.com/s/.../exec` — o
trecho `/a/macros/isasaude.com/` é o que confirma que a restrição pegou.

Para atualizar depois de uma mudança nos dados ou no código:

```powershell
py scripts\build_appscript.py
```

e cole o novo `dist/appscript/painel.html` no arquivo `painel`, seguido de
**Implantar > Gerenciar implantações > ✏️ > Nova versão**.

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
4. Registrar a tarefa agendada (Windows), toda sexta às 18h — fecha a
   semana e deixa o painel pronto para a segunda:

   ```powershell
   $scriptPath = "C:\Users\Peterson.Junior\Programação\NPS-\scripts\weekly_update.ps1"
   $action = New-ScheduledTaskAction -Execute "powershell.exe" -Argument "-ExecutionPolicy Bypass -NoProfile -File `"$scriptPath`""
   $trigger = New-ScheduledTaskTrigger -Weekly -DaysOfWeek Friday -At 6:00PM
   $settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -DontStopOnIdleEnd
   Register-ScheduledTask -TaskName "NPS-ISAs-AtualizacaoSemanal" -Action $action -Trigger $trigger -Settings $settings -Description "Atualiza o painel de NPS dos ISAs com dados do Databricks e publica no GitHub"
   ```

Isso já está feito nesta máquina. Pontos de atenção:

- **A automação só roda com o PC ligado e você logado** no horário
  agendado (sexta 18h). Se o PC estiver desligado, aquela semana não
  atualiza sozinha — `StartWhenAvailable` faz a tarefa rodar assim que o PC
  ligar de novo, mas não recupera retroativamente.
- **A CLI do Databricks precisa estar instalada.** É ela que guarda o token
  OAuth (no Gerenciador de Credenciais do Windows, por causa do
  `auth_storage = secure` no `~/.databrickscfg`) e o renova sozinha. O
  script procura a CLI no PATH e, se não achar, na pasta do winget. Sem a
  CLI, cada execução abre o navegador pedindo login — o que trava a tarefa
  agendada, porque não há ninguém pra clicar.
- **A sessão OAuth pode expirar** (troca de senha, política de segurança da
  empresa). Se a tarefa começar a falhar, rode `databricks auth login`
  de novo manualmente. Os logs de cada execução ficam em `logs/` (não
  versionados).
- **O warehouse dorme depois de 5 minutos parado.** A primeira consulta
  depois disso acorda ele e demora mais — é normal, não é erro.
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

> **Link direto para editar:**
> https://github.com/petersonjuniorISA/NPS-/edit/main/data/zendesk_semanal.csv

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
| `tickets_humano` | `266` | conversas que um atendente tocou |
| `tickets_ia` | `17` | conversas atendidas pela IA |
| `narrativa` | texto livre | as "alavancas da semana" |

As duas colunas de volume alimentam os cartões **Total humano**, **Total IA** e
**Total geral** no topo da aba Análise de tickets. O total é a soma das duas, e
a fatia da IA que aparece no cartão deve bater com `resolucao_ia_pct` — se não
bater, um dos dois números está errado. Enquanto estiverem vazias, os cartões
dizem que faltam dados em vez de mostrar zero.

### 4. Ocorrências (Metabase) — ligar a atualização automática

A aba **Ocorrências** mostra o volume e o SLA de encerramento das ocorrências
da Comunidade (Treinamento, Onboarding, SAC ISAs, Enfermagem, Equipe Multi),
**sem as de Captação**. A fonte é o Metabase — `report.isalab.com.br`, card 380
"Ocorrências Finalizadas", sobre o MongoDB de tickets.

Falta só a chave de API para isso rodar sozinho junto com o NPS:

1. No Metabase: **Configurações > Autenticação > Chaves de API > Criar chave**.
   Dê um nome tipo "Painel NPS ISAs" e escolha um grupo que enxergue a coleção
   SAC. Copie a chave — ela só aparece uma vez.
2. Na máquina que roda a tarefa agendada:

   ```powershell
   powershell -File scripts\salvar_chave_metabase.ps1
   ```

   O script pede a chave (não aparece na tela), guarda cifrada com DPAPI em
   `%USERPROFILE%\.nps-isas\metabase.key` e já testa a conexão. DPAPI amarra o
   segredo à sua conta do Windows: o arquivo é inútil em outra máquina, e não
   entra no Git.

Feito isso, `scripts/weekly_update.ps1` passa a atualizar `data/ocorrencias.json`
toda sexta junto com o NPS. Sem a chave, o script apenas avisa e segue — a
atualização do NPS nunca é derrubada por causa das ocorrências.

Para rodar à mão a partir de um CSV já exportado do Metabase:

```powershell
py scriptsuild_ocorrencias.py "C:\caminho\export.csv"
```

**Uma limitação que fica:** o card 380 devolve só ocorrências **já
finalizadas**. As que seguem abertas não entram, e nenhum card do Metabase as
expõe linha a linha. Por isso o painel fala em "finalizadas", não em "total".

### 5. Atualizar as metas SMART

As metas do semestre ficam em `data/metas.json` (espelho da planilha
"Metas 2S - Isa Experience"). Cada objetivo tem a meta de cada mês e sabe
de onde vem o realizado:

```json
{
  "id": "nps",
  "label": "NPS",
  "descricao": "Elevar o NPS da Isa para acima de 60 pontos até dezembro de 2026.",
  "unidade": "pts",
  "casas": 1,
  "baseline": 39,
  "alvo_final": 60,
  "fonte_realizado": "nps",
  "metas": { "2026-08": 46.5, "2026-09": 48.6, "2026-10": 54.3 }
}
```

- `fonte_realizado: "nps"` → o realizado vem do Databricks (`data/nps.json`).
- `fonte_realizado: "zendesk:csat_humano"` → vem da coluna `csat_humano` de
  `data/zendesk_semanal.csv`. Vale para qualquer coluna daquele arquivo.
- `alvo_final` é a meta de dezembro, usada no gráfico de trajetória e no
  bloco "Onde estamos".

Com isso, a página **Metas SMART** calcula sozinha o "Real vs. meta" de cada
objetivo — não precisa mexer em código quando a meta mudar, só neste arquivo.

### 6. Trocar o logo

Suba o logo da área como `assets/logo.png` (direto pelo GitHub:
**Add file → Upload files**). Ele aparece no topo da barra lateral. Enquanto
o arquivo não existir, o painel mostra um selo "ISA" em teal automaticamente.

### 7. Google Sites — desativado

O painel ficou espelhado em **https://sites.google.com/isasaude.com/nps-dos-isas**
até 10/09/2026, com um bloco de Incorporar apontando para o GitHub Pages.

Isso foi abandonado por dois motivos:

1. **A restrição do Sites era só de fachada.** Ela controlava quem encontrava o
   painel *através da página*, mas o iframe apontava para uma URL pública do
   GitHub — quem tivesse o link direto entrava sem passar pelo domínio. O Web
   App do Apps Script resolve isso de verdade: sem conta `@isasaude.com`, o
   Google nem serve a página.
2. **A largura.** A grade do tema do Sites limita o conteúdo a ~920px e não há
   ajuste para remover essa margem. Aberto direto pelo Apps Script, o painel usa
   a tela inteira.

> **Pendência:** a página do Sites ainda existe e ainda embute a URL do GitHub,
> que agora está fora do ar — então mostra um quadro quebrado. Precisa ser
> tratada: trocar o conteúdo por um link para o Apps Script, ou cancelar a
> publicação em ⋮ > Cancelar publicação.

### Privacidade — o que é publicado

Nenhum arquivo em `data/` carrega campo de identificação: não há nome, CPF,
e-mail nem id de profissional. O `build_ocorrencias.py` e o
`fetch_comentarios.py` descartam esses campos na origem — o primeiro guarda só
contagem e SLA; o segundo guarda mês, nota, tema e o texto.

**Uma ressalva sobre `data/comentarios.json`.** Ali há texto livre escrito pelos
próprios ISAs. Ninguém está identificado pela estrutura do arquivo, mas o autor
pode ter escrito um nome dentro do comentário ("a enfermeira Fulana me
atendeu") — isso não dá para higienizar sem mutilar a resposta. É mais um
motivo para o painel seguir restrito ao domínio `@isasaude.com`.

O resto é informação de negócio agregada — NPS, metas do semestre, SLA, volume
de ocorrências, funil de onboarding.

### 8. Comentários do NPS e Onboarding (Metabase)

As duas bases mais novas saem do mesmo Metabase das ocorrências, com a mesma
chave — não precisa configurar nada além do que o passo 4 já pede.

| Script | Sai em | De onde vem |
|---|---|---|
| `scripts/fetch_comentarios.py` | `data/comentarios.json` | banco **Survey**, coleção `distributions`, pesquisas `i-nps` e `inps-isas` |
| `scripts/fetch_onboarding.py` | `data/onboarding.json` | banco **Professional History** (eventos `professional.created` / `.activated`) + **Professional** (status de hoje) |

Os comentários não estão no Databricks: a tabela `fact_inps_response` guarda só
as notas. O texto vive na pesquisa, onde cada nota é seguida de um "Quer
comentar sobre essa resposta?". Por isso o botão **Exibir os comentários** que
aparece embaixo de cada gráfico do NPS lê o Metabase, não o Databricks.

O onboarding é todo semanal e segue a mesma conta do Farol:

> **Tempo médio de ativação** = data do evento `professional.activated` menos a
> data de cadastro, contando só quem já ativou, agrupado pela semana em que a
> pessoa **se cadastrou**. **% na meta** = quantos ativaram dentro do prazo.

O agrupamento é por semana de *cadastro*, não de ativação. Medir pela semana de
ativação responde outra pergunta — "quanto tempo tinha esperado quem ativou
agora" — e dá números várias vezes maiores (30 dias contra 0,7 na mesma
semana). As duas contas estão certas; a do Farol é a que a área usa.

Duas ressalvas que o painel mostra na tela:

1. A taxa de ativação das semanas mais recentes ainda vai subir — uma ativação
   leva ~30 dias. Elas aparecem **pontilhadas**: não caíram, só não fecharam.
   A janela é configurável em `ONBOARDING_JANELA`.
2. O gráfico de onboarding assistido é **aproximação**. Não há marcador de
   "assistido" no cadastro; o que dá para medir é quem está parado num status
   que só anda com alguém da operação. O número oficial depende da planilha do
   Gabi.

As metas do funil ficam em `data/metas.json`, no bloco `onboarding` — fora de
`objetivos`, porque são semanais e o farol do semestre é mensal:

```json
"onboarding": { "tempo_ativacao_dias": 2, "taxa_ativacao_pct": 40, "temporarios": 0 }
```

### 9. Comportamental × técnica nas ocorrências

O ticket **não** tem esse campo. O que ele tem é o motivo (`reason`),
preenchido nos departamentos de Treinamento, Onboarding e SAC ISAs a partir de
abril de 2026. A tradução motivo → classe vive em
`data/classificacao_ocorrencias.json` e em nenhum outro lugar:

```json
"comportamental": { "motivos": ["Conduta inadequada do profissional", "..."] }
```

Editar esse arquivo e rodar `py scripts/build_ocorrencias.py <csv>` refaz o
gráfico inteiro. O painel mostra a divisão aberta, em "Como cada ocorrência
entra numa classe", justamente para quem lê poder discordar dela.

> **Pendência:** essa classificação foi proposta a partir dos motivos
> existentes, não veio de uma definição da área. Vale uma revisão do ISA
> Experience antes de levar o gráfico ao board.

### 10. Focos do mês

O quadro "Focos do mês" na aba de NPS é texto, não indicador: é o que a área
escolheu atacar naquele mês. Ele sai de `data/focos.json`:

```json
"2026-08": {
  "subtitulo": "Escolhas de agosto, revisadas na reunião de área",
  "itens": [
    { "texto": "...", "dono": "Suporte", "estado": "fazendo" }
  ]
}
```

`estado` aceita `fazendo`, `feito`, `risco` ou vazio — muda só a cor do ponto.
Se o mês aberto no painel não tiver bloco próprio, o painel cai no mês em
`padrao`.

Esse quadro substituiu o de "Resolução com IA" que ficava aqui. Aquele era um
indicador solto no meio do resumo, e indicador já tem lugar no farol e na aba
de Suporte.

### 11. Onde fica a Análise de tickets

É uma aba própria, pendurada no Suporte dentro do menu: a seta ao lado de
"Suporte" abre o subitem. O grupo fica aberto enquanto qualquer uma das duas
abas estiver em cima.

**A aba escolhe a fonte sozinha.** Se `data/zendesk_tickets.json` existir e
tiver meses, ela lê o Zendesk. Se não, cai nos tickets da Comunidade
(`data/ocorrencias.json`), que já chegam pelo Metabase — assim a aba nunca
fica vazia esperando credencial.

| Com Zendesk | Sem Zendesk |
|---|---|
| Humano / IA contados por ticket | Preenchidos à mão no CSV |
| Assunto vem da tag do ticket | Assunto vem do tipo da ocorrência |
| Semanal mostra Humano × IA | Semanal mostra Comportamental × Técnica |

### Ligar o Zendesk

O Zendesk **não está no Metabase** (lá só existem os tickets da Comunidade,
que são de operação de cuidado). A única porta é a API REST:

```bash
powershell -File scripts\salvar_chave_zendesk.ps1
```

Pede subdomínio (já vem `isasaude`), e-mail e token. Fica cifrado com DPAPI em
`~/.nps-isas/zendesk.json`, o mesmo esquema da chave do Metabase, e nunca vai
para o Git.

**O token precisa de alguém com papel de admin no Zendesk.** Criar o token é
em *Admin Center > Apps e integrações > APIs > Zendesk API > Tokens de API* —
uma tela que conta de agente não enxerga. E o token sozinho não basta: ele é
usado com um e-mail, e as permissões são as daquele usuário.

O script lida com os dois cenários:

| Papel da conta | O que acontece |
|---|---|
| admin | Exportação incremental — puxa tudo de uma vez |
| agente | Cai na listagem comum, do mais novo para o mais antigo, parando na data de corte |
| sem acesso à API | Explica o que pedir ao administrador e sai com 1 |

Ele diz o papel logo na primeira linha (`Conectado como Fulano (admin)`), então
dá para saber por qual caminho está indo sem adivinhar.

Depois disso, `scripts/fetch_zendesk.py` roda junto da atualização de sexta e
grava `data/zendesk_tickets.json`. Sem credencial ele avisa e sai com 0 — não
derruba o resto.

> **Antes de confiar na divisão humano × IA, rode o diagnóstico:**
>
> ```bash
> py scripts/fetch_zendesk.py --diagnostico
> ```
>
> O ticket do Zendesk **não tem** um campo "foi a IA que atendeu". O que existe
> são tags e canal, e cada conta usa os seus. O diagnóstico lista os canais,
> status e tags que realmente aparecem, e diz que percentual a regra atual
> classifica como IA. Se não bater com o que a operação sabe, ajuste
> `data/classificacao_zendesk.json` — as tags padrão ali são os nomes comuns do
> Zendesk (`ai_agent_solved`, `answer_bot_solved`), não os confirmados da ISA.

Na barra lateral compacta (781–1140px, só ícones) a seta e o submenu somem —
ali não cabe subitem escrito.

### 12. O que abre ao clicar num mês

Todo gráfico mensal do painel é clicável. Clicar num mês abre um **card
flutuante** com a semana daquele mês, e os botões dos outros meses ficam no
topo do card. Vale para os seis cartões de Suporte, para CSAT e FCR, para os
gráficos de ocorrências e para a distribuição por assunto.

No card flutuante não aparece meta: a meta é mensal, e desenhá-la sobre uma
série semanal daria a impressão de que existe alvo por semana.

## Rodar localmente

Não precisa de build — é HTML/CSS/JS puro. Basta servir a pasta com
qualquer servidor estático, por exemplo:

```bash
python -m http.server 8000
```

E abrir `http://localhost:8000`.

## Estrutura

```
index.html                          Painel — 4 itens de menu, 5 abas
css/styles.css                      Estilos (Design System ISA)
js/app.js                           Carregamento e renderizacao
js/config.js                        URL externa do CSV de Zendesk (opcional)

data/nps.json                       NPS, dimensoes e especialidades      <- fetch_databricks
data/historico_nps.json             Mai/Jun/Jul de 2026, apurados no Notion (a mao)
data/zendesk_semanal.csv            FCR, CSAT, TMA, TMR e narrativa      (a mao)
data/metas.json                     Metas do semestre                    (a mao)
data/ocorrencias.json               Volume e SLA de tickets              <- fetch_metabase
data/classificacao_ocorrencias.json Motivo -> comportamental / tecnica   (a mao)
data/zendesk_tickets.json           Tickets de suporte                   <- fetch_zendesk
data/classificacao_zendesk.json     Tag/canal -> humano ou IA            (a mao)
data/comentarios.json               Texto livre do i-NPS                 <- fetch_comentarios
data/onboarding.json                Funil semanal de ativacao            <- fetch_onboarding
data/focos.json                     Focos do mes, texto livre            (a mao)

scripts/fetch_databricks.py         NPS oficial (Databricks SQL)
scripts/fetch_metabase.py           Baixa o CSV de tickets e chama o build
scripts/build_ocorrencias.py        CSV de tickets -> ocorrencias.json
scripts/fetch_comentarios.py        Comentarios do i-NPS (Metabase / Survey)
scripts/fetch_onboarding.py         Onboarding semanal (Metabase / Professional)
scripts/fetch_zendesk.py            Tickets de suporte (API do Zendesk)
scripts/salvar_chave_zendesk.ps1    Guarda a credencial do Zendesk com DPAPI
scripts/build_appscript.py          Embute tudo num HTML so -> dist/appscript/
scripts/bump_versao.py              Sobe o ?v= dos assets (evita cache velho)
scripts/weekly_update.ps1           Orquestra tudo — roda toda sexta, 18h
scripts/salvar_chave_metabase.ps1   Guarda a chave do Metabase com DPAPI

dist/appscript/painel.html          O que se cola no Apps Script
```

O menu tem quatro itens: **NPS** · **Suporte** · **Ocorrencias** ·
**Onboarding**. O Suporte tem uma seta que abre **Analise de tickets**, que e
uma aba separada — mesma base das Ocorrencias, lida como fila de atendimento.

Nao existem mais abas de Metas nem de Historico. A meta virou a linha
tracejada cinza dentro de cada grafico que tem meta definida, e o historico
virou o proprio formato: todo grafico do painel e de linha, mes a mes. O farol
das metas do semestre continua, agora dentro da aba de NPS.
