# Guarda a credencial de API do Zendesk cifrada para o seu usuario do Windows.
#
# Rode uma vez so:
#     powershell -File scripts\salvar_chave_zendesk.ps1
#
# Ou passando tudo direto:
#     powershell -File scripts\salvar_chave_zendesk.ps1 -Subdominio isasaude -Email voce@isasaude.com -Token "abc..."
#
# Duas formas de provar quem voce e. O script aceita as duas:
#
#   TOKEN DE API  -  o caminho recomendado, mas gera-lo exige papel de admin:
#                    Zendesk > Admin Center > Apps e integracoes > APIs >
#                    Zendesk API > aba "Tokens de API" > Adicionar token.
#                    O token aparece UMA vez so; se perder, gere outro.
#
#   SENHA         -  a senha da sua propria conta do Zendesk. Serve para
#                    qualquer agente, sem depender de admin. So falha se o
#                    admin tiver desligado "Password access" na mesma tela da
#                    API - que vem ligado por padrao.
#
# Se voce nao tem admin, use a senha:
#     powershell -File scripts\salvar_chave_zendesk.ps1 -UsarSenha
#
# O subdominio e o que vem antes de .zendesk.com. Em isasaude.zendesk.com,
# o subdominio e "isasaude".
#
# Sao guardados os tres juntos, num JSON cifrado com DPAPI: o arquivo fica
# amarrado a esta conta do Windows e a esta maquina. Nunca vai para o Git.

param(
    [string]$Subdominio,
    [string]$Email,
    [string]$Token,
    # pede a senha da conta em vez do token de API
    [switch]$UsarSenha
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
$Senha = $null
if (-not $Token) {
    Write-Host ""
    if ($UsarSenha) {
        Write-Host "Senha da sua conta do Zendesk" -ForegroundColor Cyan
    } else {
        Write-Host "Token de API" -ForegroundColor Cyan
        Write-Host "Se voce nao consegue gerar um token, saia daqui (Ctrl+C) e rode de novo" -ForegroundColor DarkGray
        Write-Host "com -UsarSenha, para usar a senha da sua propria conta." -ForegroundColor DarkGray
    }
    Write-Host "A tela NAO mostra o que voce digita - isso e proposital. Digite e de Enter." -ForegroundColor DarkGray
    $segura = Read-Host -AsSecureString
    $claro = [Runtime.InteropServices.Marshal]::PtrToStringAuto(
        [Runtime.InteropServices.Marshal]::SecureStringToBSTR($segura))
    if ($UsarSenha) { $Senha = $claro } else { $Token = $claro }
}

$Subdominio = $Subdominio.Trim()
$Email = $Email.Trim()
if ($Token) { $Token = $Token.Trim() }
if ($Senha) { $Senha = $Senha.Trim() }

if (-not $Subdominio -or -not $Email -or (-not $Token -and -not $Senha)) {
    Write-Host "Faltou o subdominio, o e-mail ou o segredo. Nenhum arquivo criado." -ForegroundColor Yellow
    exit 1
}
# engano comum: colar a URL inteira no lugar do subdominio
if ($Subdominio -match "zendesk\.com|https?://") {
    $Subdominio = ($Subdominio -replace "https?://", "") -replace "\.zendesk\.com.*", ""
    Write-Host "Usando subdominio: $Subdominio" -ForegroundColor DarkGray
}

$cofre = @{ subdominio = $Subdominio; email = $Email }
if ($Token) { $cofre.token = $Token } else { $cofre.senha = $Senha }
$json = $cofre | ConvertTo-Json -Compress

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
