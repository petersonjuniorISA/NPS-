// Configuração do painel NPS dos ISAs
//
// Os indicadores de Zendesk e a narrativa semanal são editados direto em
// data/zendesk_semanal.csv (pelo editor de tabela do próprio GitHub — veja
// o passo a passo no README.md). Não precisa configurar nada aqui pra isso
// funcionar.
//
// ZENDESK_CSV_URL é opcional: só use se um dia quiser trocar por uma
// planilha publicada externamente (o Workspace da ISA bloqueia isso hoje,
// por padrão fica em branco).
window.NPS_CONFIG = {
  ZENDESK_CSV_URL: ""
};
