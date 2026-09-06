# Guarda a chave de API do Metabase cifrada para o seu usuario do Windows.
#
# Rode uma vez so:
#     powershell -File scripts\salvar_chave_metabase.ps1
#
# Ou, se preferir passar a chave direto (util quando o prompt mascarado
# atrapalha o colar):
#     powershell -File scripts\salvar_chave_metabase.ps1 -Chave "mb_..."
#
# A chave fica em Claude Desktop > Configuracoes > Extensoes > Metabase, ou se
# cria em Metabase > Configuracoes > Autenticacao > Chaves de API.
#
# O arquivo gerado usa DPAPI: e amarrado a esta conta do Windows e a esta
# maquina, entao nao adianta copiar para outro lugar. Nunca vai para o Git.

param([string]$Chave)

$ErrorActionPreference = "Stop"

$pasta = Join-Path $env:USERPROFILE ".nps-isas"
$arquivo = Join-Path $pasta "metabase.key"
if (-not (Test-Path $pasta)) { New-Item -ItemType Directory -Path $pasta | Out-Null }

if (-not $Chave) {
    Write-Host ""
    Write-Host "Chave de API do Metabase (report.isalab.com.br)" -ForegroundColor Cyan
    Write-Host "Cole a chave e tecle Enter." -ForegroundColor DarkGray
    Write-Host "A tela NAO mostra o que voce cola - isso e proposital. Cole e de Enter." -ForegroundColor DarkGray
    $segura = Read-Host -AsSecureString
    $Chave = [Runtime.InteropServices.Marshal]::PtrToStringAuto(
        [Runtime.InteropServices.Marshal]::SecureStringToBSTR($segura))
}

$Chave = $Chave.Trim()
if (-not $Chave) {
    Write-Host "Nada foi digitado. Nenhum arquivo criado." -ForegroundColor Yellow
    exit 1
}
if (-not $Chave.StartsWith("mb_")) {
    Write-Host "Aviso: chaves do Metabase costumam comecar com 'mb_'. Salvando mesmo assim." -ForegroundColor Yellow
}

($Chave | ConvertTo-SecureString -AsPlainText -Force | ConvertFrom-SecureString) |
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
Write-Host "OK: chave guardada em $arquivo" -ForegroundColor Green
Write-Host "Testando o acesso ao Metabase..." -ForegroundColor DarkGray
Write-Host ""

python scripts\fetch_metabase.py
