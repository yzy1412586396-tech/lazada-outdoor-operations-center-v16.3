param(
  [string]$Destination = (Join-Path (Get-Location) 'recovered-v16.3')
)

$ErrorActionPreference = 'Stop'
$repo = 'yzy1412586396-tech/lazada-outdoor-operations-center-v16.3'
$tag = 'v16.3.0'
if (-not (Get-Command gh -ErrorAction SilentlyContinue)) {
  throw '需要先安装 GitHub CLI (gh) 并运行 gh auth login，才能下载私人仓库附件。'
}
New-Item -ItemType Directory -Force -Path $Destination | Out-Null
& gh release download $tag --repo $repo --dir $Destination --pattern '*.part*' --pattern 'manifest.json' --clobber
if ($LASTEXITCODE -ne 0) { throw '下载 Release 附件失败。' }

$manifestPath = Join-Path $Destination 'manifest.json'
$manifest = Get-Content -LiteralPath $manifestPath -Raw | ConvertFrom-Json
foreach ($entry in $manifest.files) {
  $outputPath = Join-Path $Destination $entry.output
  $outputStream = [IO.File]::Create($outputPath)
  try {
    for ($index = 1; $index -le [int]$entry.parts; $index++) {
      $partName = '{0}.part{1:D3}' -f $entry.prefix, $index
      $partPath = Join-Path $Destination $partName
      if (-not (Test-Path -LiteralPath $partPath)) { throw "缺少分片：$partName" }
      $inputStream = [IO.File]::OpenRead($partPath)
      try { $inputStream.CopyTo($outputStream) } finally { $inputStream.Dispose() }
    }
  } finally { $outputStream.Dispose() }
  $actualBytes = (Get-Item -LiteralPath $outputPath).Length
  $actualHash = (Get-FileHash -Algorithm SHA256 -LiteralPath $outputPath).Hash
  if ($actualBytes -ne [long]$entry.bytes -or $actualHash -ne $entry.sha256) {
    throw "校验失败：$($entry.output)。请删除下载目录并重新下载。"
  }
  Write-Output "已还原并校验：$outputPath"
}
