# Guarda a credencial de API do Zendesk cifrada para o seu usuario do Windows.
#
# Rode uma vez so:
#     powershell -File scripts\salvar_chave_zendesk.ps1
#
# Ou passando tudo direto:
#     powershell -File scripts\salvar_chave_zendesk.ps1 -Subdominio isasaude -Email voce@isasaude.com -Token "abc..."
#
# Onde pegar o token:
#     Zendesk > Admin Center > Apps e integracoes > APIs > Zendesk API
#     Aba "Tokens de API" > Adicionar token de API
#     O token aparece UMA vez so; se perder, gere outro.
#
# O subdominio e o que vem antes de .zendesk.com. Em isasaude.zendesk.com,
# o subdominio e "isasaude".
#
# Sao guardados os tres juntos, num JSON cifrado com DPAPI: o arquivo fica
# amarrado a esta conta do Windows e a esta maquina. Nunca vai para o Git.

param(
    [string]$Subdominio,
    [string]$Email,
    [string]$Token
)

$ErrorActionPreference = "Stop"

$pasta = Join-Path $env:USERPROFILE ".nps-isas"
$arquivo = Join-Path $pasta "zendesk.json"
if (-not (Test-Path $pasta)) { New-Item -ItemType Directory -Path $pasta | Out-Null }

if (-not $Subdominio) {
    Write-Host ""
    Write-Host "Subdominio do Zendesk" -ForegroundColor Cyan
    Write-Host "So a parte antes de .zendesk.com. Enter aceita o padrao [isasaude]." -ForegroundColor DarkGray
    $Subdominio = Read-Host "Subdominio"
    if (-not $Subdominio) { $Subdominio = "isasaude" }
}
if (-not $Email) {
    Write-Host ""
    Write-Host "E-mail do usuario da API" -ForegroundColor Cyan
    Write-Host "Precisa ser um usuario com permissao de API no Zendesk." -ForegroundColor DarkGray
    $Email = Read-Host "E-mail"
}
if (-not $Token) {
    Write-Host ""
    Write-Host "Token de API" -ForegroundColor Cyan
    Write-Host "A tela NAO mostra o que voce cola - isso e proposital. Cole e de Enter." -ForegroundColor DarkGray
    $segura = Read-Host -AsSecureString
    $Token = [Runtime.InteropServices.Marshal]::PtrToStringAuto(
        [Runtime.InteropServices.Marshal]::SecureStringToBSTR($segura))
}

$Subdominio = $Subdominio.Trim()
$Email = $Email.Trim()
$Token = $Token.Trim()

if (-not $Subdominio -or -not $Email -or -not $Token) {
    Write-Host "Faltou preencher algum dos tres. Nenhum arquivo criado." -ForegroundColor Yellow
    exit 1
}
# engano comum: colar a URL inteira no lugar do subdominio
if ($Subdominio -match "zendesk\.com|https?://") {
    $Subdominio = ($Subdominio -replace "https?://", "") -replace "\.zendesk\.com.*", ""
    Write-Host "Usando subdominio: $Subdominio" -ForegroundColor DarkGray
}

$json = @{ subdominio = $Subdominio; email = $Email; token = $Token } | ConvertTo-Json -Compress

($json | ConvertTo-SecureString -AsPlainText -Force | ConvertFrom-SecureString) |
    Set-Content -Path $arquivo -Encoding ascii

# Restringe o arquivo ao dono. Em maquina fora do dominio isso pode falhar --
# nao e critico, porque o DPAPI ja amarra o segredo a conta do Windows.
try {
    $acl = Get-Acl $arquivo
    $acl.SetAccessRuleProtection($true, $false)
    $acl.SetAccessRule((New-Object System.Security.AccessControl.FileSystemAccessRule(
        [System.Security.Principal.WindowsIdentity]::GetCurrent().User, "FullControl", "Allow")))
    Set-Acl -Path $arquivo -AclObject $acl
} catch {
    Write-Host "Aviso: nao consegui restringir a ACL ($($_.Exception.Message))." -ForegroundColor DarkGray
    Write-Host "Sem problema: o DPAPI ja impede outra conta de decifrar." -ForegroundColor DarkGray
}

Write-Host ""
Write-Host "OK: credencial guardada em $arquivo" -ForegroundColor Green
Write-Host ""
Write-Host "Agora rode o diagnostico antes de confiar na divisao humano x IA:" -ForegroundColor Cyan
Write-Host "    py scripts\fetch_zendesk.py --diagnostico" -ForegroundColor White
Write-Host ""
Write-Host "Testando o acesso ao Zendesk..." -ForegroundColor DarkGray
Write-Host ""

python scripts\fetch_zendesk.py --diagnostico
