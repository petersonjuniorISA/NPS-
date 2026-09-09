/**
 * Painel de NPS dos ISAs — Web App.
 *
 * Publicar em: Implantar > Nova implantacao > Tipo: App da Web
 *   Executar como   : Eu
 *   Quem tem acesso : Qualquer pessoa em ISA Saude
 *
 * O XFrameOptionsMode.ALLOWALL e o que permite embutir esta pagina no
 * Google Sites. Sem ele o Sites mostra um quadro em branco.
 */
function doGet() {
  return HtmlService.createHtmlOutputFromFile('painel')
    .setTitle('NPS dos ISAs')
    .addMetaTag('viewport', 'width=device-width, initial-scale=1')
    .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL);
}
