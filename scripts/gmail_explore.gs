/**
 * Pega o anexo do Zendesk Explore no Gmail e comita no repositorio.
 *
 * Por que do lado do Google
 * -------------------------
 * A maquina que roda a atualizacao semanal nao tem cliente de e-mail nem Drive
 * sincronizado, entao nao alcanca o anexo. O Apps Script alcanca: ele roda com
 * a sua conta, enxerga a sua caixa, e o painel ja vive nele.
 *
 * O que ele NAO faz de proposito
 * ------------------------------
 * Nao calcula nada. Ele so tira o CSV de dentro do .zip e o deixa em
 * data/explore/ do repositorio. Quem junta com o historico e quem converte hora
 * decimal em "12h30" e o scripts/importar_explore.py, que ja esta escrito e
 * testado — duplicar essa logica aqui em JavaScript seria manter duas versoes
 * da mesma conta.
 *
 * Instalacao (uma vez)
 * --------------------
 * 1. script.google.com > Novo projeto > nome "Explore para o painel de NPS"
 * 2. Cole este arquivo inteiro.
 * 3. Um token do GitHub com permissao de escrever neste repositorio:
 *    github.com/settings/personal-access-tokens > Generate new token
 *      Repository access: apenas petersonjuniorISA/NPS-
 *      Permissions > Repository permissions > Contents: Read and write
 * 4. No projeto: engrenagem (Configuracoes do projeto) > Propriedades do script
 *    > Adicionar propriedade
 *      nome:  GITHUB_TOKEN
 *      valor: o token
 *    Guardado ali ele nao aparece no codigo e nao vai para o Git.
 * 5. Rode `testar()` uma vez. O Google vai pedir autorizacao para ler o Gmail —
 *    aceite. A saida diz o que ele achou, sem comitar nada.
 * 6. Rode `instalarGatilho()` uma vez. Ele passa a rodar toda segunda de manha.
 *
 * Do lado do Zendesk
 * ------------------
 * Explore > o dashboard > menu (...) > Agendar entrega
 *   periodicidade: semanal, segunda de manha
 *   formato: CSV (ou Excel; o .zip vem igual)
 *   para: voce mesmo
 */

// ---------------------------------------------------------------- ajustes ---
var REPO = 'petersonjuniorISA/NPS-';
var RAMO = 'main';
var DESTINO = 'data/explore/tma-tmr-fcr-semana.csv';

/* A busca do Gmail. `newer_than` evita reprocessar um e-mail antigo quando uma
   semana falha; o resto e frouxo de proposito, porque o assunto do agendamento
   e escrito por quem agenda e muda. */
var BUSCA = 'has:attachment filename:zip newer_than:14d ' +
            '(from:zendesk.com OR subject:Explore OR subject:"Efici")';

/* Dentro do .zip vem uma planilha por aba do dashboard. Esta e a que interessa. */
var PLANILHA = 'TMA';


// ------------------------------------------------------------------ Gmail ---
/** O anexo .zip mais recente que a busca encontrar, ou null. */
function anexoMaisRecente_() {
  var linhas = GmailApp.search(BUSCA, 0, 20);
  var melhor = null;
  linhas.forEach(function (linha) {
    linha.getMessages().forEach(function (msg) {
      msg.getAttachments().forEach(function (anexo) {
        if (!/\.zip$/i.test(anexo.getName())) return;
        if (!melhor || msg.getDate() > melhor.quando) {
          melhor = { blob: anexo, quando: msg.getDate(), assunto: msg.getSubject() };
        }
      });
    });
  });
  return melhor;
}

/** Tira do .zip a planilha que interessa. */
function csvDoZip_(blob) {
  // o Utilities.unzip so aceita o blob marcado como zip; o Gmail as vezes
  // entrega como application/octet-stream
  var arquivos = Utilities.unzip(blob.setContentType('application/zip'));
  for (var i = 0; i < arquivos.length; i++) {
    if (arquivos[i].getName().toUpperCase().indexOf(PLANILHA) !== -1) return arquivos[i];
  }
  var nomes = arquivos.map(function (f) { return f.getName(); }).join(', ');
  throw new Error('o .zip nao tem planilha com "' + PLANILHA + '" no nome. Tem: ' + nomes);
}


// ----------------------------------------------------------------- GitHub ---
function token_() {
  var t = PropertiesService.getScriptProperties().getProperty('GITHUB_TOKEN');
  if (!t) throw new Error('falta a propriedade GITHUB_TOKEN nas Configuracoes do projeto.');
  return t;
}

function chamarGitHub_(metodo, caminho, corpo) {
  var r = UrlFetchApp.fetch('https://api.github.com/repos/' + REPO + '/' + caminho, {
    method: metodo,
    contentType: 'application/json',
    headers: { Authorization: 'Bearer ' + token_(), Accept: 'application/vnd.github+json' },
    payload: corpo ? JSON.stringify(corpo) : null,
    muteHttpExceptions: true
  });
  var codigo = r.getResponseCode();
  if (codigo === 404) return null;           // arquivo ainda nao existe
  if (codigo >= 300) throw new Error('GitHub respondeu ' + codigo + ': ' + r.getContentText().slice(0, 300));
  return JSON.parse(r.getContentText());
}

/* O GitHub exige o sha do arquivo atual para substituir — sem ele a chamada e
   recusada. E a trava dele contra sobrescrever a cegas. */
function comitar_(texto, quando) {
  var atual = chamarGitHub_('GET', 'contents/' + DESTINO + '?ref=' + RAMO);
  var mesmo = atual && Utilities.newBlob(Utilities.base64Decode(atual.content))
                                .getDataAsString('UTF-8') === texto;
  if (mesmo) return { mudou: false };

  var corpo = {
    message: 'chore: exportacao do Zendesk Explore de ' +
             Utilities.formatDate(quando, 'America/Sao_Paulo', 'dd/MM/yyyy') + ' (automatico)',
    content: Utilities.base64Encode(texto, Utilities.Charset.UTF_8),
    branch: RAMO
  };
  if (atual) corpo.sha = atual.sha;
  chamarGitHub_('PUT', 'contents/' + DESTINO, corpo);
  return { mudou: true };
}


// ------------------------------------------------------------------ rodar ---
function importarExplore() {
  var achado = anexoMaisRecente_();
  if (!achado) {
    Logger.log('Nenhum e-mail com anexo .zip nos ultimos 14 dias. Nada a fazer.');
    return;
  }
  var csv = csvDoZip_(achado.blob);
  var texto = csv.getDataAsString('UTF-8').replace(/^﻿/, '');
  var r = comitar_(texto, achado.quando);
  Logger.log(r.mudou
    ? 'Comitado ' + DESTINO + ' (de "' + achado.assunto + '", ' + achado.quando + ').'
    : 'A exportacao e igual a que ja esta no repositorio. Nada comitado.');
}

/** Roda uma vez, sem comitar, so para ver se a busca e o .zip estao certos. */
function testar() {
  var achado = anexoMaisRecente_();
  if (!achado) {
    Logger.log('Nao achei e-mail. Ajuste a BUSCA no topo do arquivo.');
    return;
  }
  Logger.log('E-mail: "' + achado.assunto + '" de ' + achado.quando);
  Logger.log('Anexo: ' + achado.blob.getName());
  var csv = csvDoZip_(achado.blob);
  var texto = csv.getDataAsString('UTF-8').replace(/^﻿/, '');
  Logger.log('Planilha: ' + csv.getName());
  Logger.log('Primeiras linhas:\n' + texto.split('\n').slice(0, 5).join('\n'));
}

/** Instala o gatilho semanal. Rode uma vez; rodar de novo nao duplica. */
function instalarGatilho() {
  ScriptApp.getProjectTriggers().forEach(function (g) {
    if (g.getHandlerFunction() === 'importarExplore') ScriptApp.deleteTrigger(g);
  });
  ScriptApp.newTrigger('importarExplore')
    .timeBased().onWeekDay(ScriptApp.WeekDay.MONDAY).atHour(8).create();
  Logger.log('Gatilho instalado: toda segunda, por volta das 8h.');
}
