# Генерирует тестовую русскую речь голосом Microsoft Irina → test/audio/*.wav (16 kHz mono PCM16)
# Между фразами — тишина, чтобы проверить VAD-нарезку.
Add-Type -AssemblyName System.Speech
$out = Join-Path $PSScriptRoot 'audio'
New-Item -ItemType Directory -Force $out | Out-Null

$phrases = @(
  'Смотрите, пилот на две недели стоит сто двадцать тысяч рублей.',
  'А кто у вас принимает решение по таким вопросам?',
  'У одного клиента мы вернули один и девять миллиона рублей за два месяца.'
)

$synth = New-Object System.Speech.Synthesis.SpeechSynthesizer
$synth.SelectVoice('Microsoft Irina Desktop')
$synth.Rate = 0
$fmt = New-Object System.Speech.AudioFormat.SpeechAudioFormatInfo(16000, [System.Speech.AudioFormat.AudioBitsPerSample]::Sixteen, [System.Speech.AudioFormat.AudioChannel]::Mono)

$i = 0
foreach ($p in $phrases) {
  $i++
  $file = Join-Path $out ("phrase$i.wav")
  $synth.SetOutputToWaveFile($file, $fmt)
  $synth.Speak($p)
  $synth.SetOutputToNull()
  Write-Output "wrote $file"
}

# Сшитый диалог с паузами 1.2 с — как «моя» дорожка в звонке
$file = Join-Path $out 'dialog.wav'
$synth.SetOutputToWaveFile($file, $fmt)
$pb = New-Object System.Speech.Synthesis.PromptBuilder
foreach ($p in $phrases) {
  $pb.AppendText($p)
  $pb.AppendBreak([TimeSpan]::FromMilliseconds(1200))
}
$synth.Speak($pb)
$synth.SetOutputToNull()
Write-Output "wrote $file"
