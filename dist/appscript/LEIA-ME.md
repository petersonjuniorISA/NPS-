# Publicar o painel no Apps Script + Google Sites

Os dois arquivos desta pasta são gerados por `py scripts\build_appscript.py`.
Não edite nada aqui à mão — a cada geração a pasta é refeita.

| Arquivo | O que é |
|---|---|
| `painel.html` | O painel inteiro: HTML, CSS, JavaScript e os dados, tudo embutido |
| `Codigo.gs` | O `doGet()` que serve a página |

Está tudo num arquivo só porque o Apps Script **não serve arquivos**: não
existe `data/nps.json` para o painel buscar lá dentro.

---

## 1. Criar o projeto (uma vez)

1. Abra **https://script.google.com** com a conta `@isasaude.com`
2. **Novo projeto** → renomeie para `Painel NPS dos ISAs`
3. No arquivo `Código.gs` que já vem aberto, apague tudo e cole o conteúdo de
   **`Codigo.gs`**
4. No `+` ao lado de "Arquivos", escolha **HTML**, nomeie **`painel`**
   (sem `.html` — o Apps Script acrescenta sozinho)
5. Apague o conteúdo padrão e cole o de **`painel.html`**
6. Salve (Ctrl+S)

> O arquivo tem ~271 KB. Colar pode demorar alguns segundos.

## 2. Publicar restrito ao domínio

**Implantar → Nova implantação → ⚙️ → App da Web**

| Campo | Valor |
|---|---|
| Descrição | `Painel NPS` |
| Executar como | **Eu** (`peterson.junior@isasaude.com`) |
| Quem tem acesso | **Qualquer pessoa em ISA Saúde** |

Clique em **Implantar**. Na primeira vez o Google pede autorização — aceite.

Copie a **URL do app da Web** (`.../macros/s/AKfy.../exec`). É essa que vai
para o Sites.

**"Qualquer pessoa em ISA Saúde" é o ponto de toda a migração:** quem não
tiver conta do domínio não abre a página, nem com o link.

## 3. Embutir no Google Sites

No seu site: **Inserir → Incorporar → Por URL** → cole a URL do app da Web.

Se o quadro aparecer em branco, confirme que o `Codigo.gs` tem a linha
`setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL)` — é ela que
autoriza o Sites a exibir a página.

Dê ao bloco a altura maior que o editor permitir; o painel rola por dentro.

## 4. Atualizar depois

A cada semana o `weekly_update.ps1` regenera os dados e roda o
`build_appscript.py`. Para levar isso ao ar você tem dois caminhos:

**À mão:** copie o novo `painel.html`, cole no arquivo `painel` do projeto e
faça **Implantar → Gerenciar implantações → ✏️ → Nova versão → Implantar**.

**Automático:** veja "Publicação automática" no `README.md` do projeto —
usa o `clasp`, a ferramenta oficial do Google para Apps Script.

---

## Se algo não funcionar

| Sintoma | Causa provável |
|---|---|
| Quadro em branco no Sites | Falta o `ALLOWALL` no `Codigo.gs` |
| "É necessário fazer login" | A implantação está como "Somente eu" |
| Gráficos não desenham | O Apps Script bloqueou o CDN do Chart.js — veja o console (F12) |
| Números velhos | A implantação não foi atualizada: precisa de **Nova versão** |

O painel continua funcionando em `index.html` (servidor comum) sem nenhuma
mudança — o mesmo código roda nos dois lugares.
