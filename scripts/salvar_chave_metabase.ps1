# Guarda a chave de API do Metabase cifrada para o seu usuario do Windows.
#
# Rode uma vez so:
#     powershell -File scripts\salvar_chave_metabase.ps1
#
# A chave se cria em Metabase > Configuracoes > Autenticacao > Chaves de API.
# O arquivo gerado usa DPAPI: e amarrado a esta conta do Windows e a esta
# maquina, entao nao adianta copiar para outro lugar. Nunca vai para o Git.

$ErrorActionPreference = "Stop"

$pasta = Join-Path $env:USERPROFILE ".nps-isas"
$arquivo = Join-Path $pasta "metabase.key"

if (-not (Test-Path $pasta)) { New-Item -ItemType Directory -Path $pasta | Out-Null }

Write-Host ""
Write-Host "Chave de API do Metabase (report.isalab.com.br)" -ForegroundColor Cyan
Write-Host "Cole a chave e tecle Enter. Ela nao aparece na tela." -ForegroundColor DarkGray
$chave = Read-Host -AsSecureString

if (-not $chave -or $chave.Length -eq 0) {
    Write-Host "Nada foi digitado. Nenhum arquivo criado." -ForegroundColor Yellow
    exit 1
}

$chave | ConvertFrom-SecureString | Set-Content -Path $arquivo -Encoding ascii

# So o dono le o arquivo
$acl = Get-Acl $arquivo
$acl.SetAccessRuleProtection($true, $false)
$regra = New-Object System.Security.AccessControl.FileSystemAccessRule(
    "$env:USERDOMAIN\$env:USERNAME", "FullControl", "Allow")
$acl.SetAccessRule($regra)
Set-Acl -Path $arquivo -AclObject $acl

Write-Host ""
Write-Host "OK: chave guardada em $arquivo" -ForegroundColor Green
Write-Host "Testando o acesso ao Metabase..." -ForegroundColor DarkGray
Write-Host ""

python scripts\fetch_metabase.py
