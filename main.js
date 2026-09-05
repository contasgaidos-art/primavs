// PRISMA Virtual Sound - processo principal do Electron.
// Sobe o servidor embutido (remoto WiFi), cuida da LICENÇA/serial e do
// AUTO-UPDATE, e abre o PRISMA.
const { app, BrowserWindow, Menu, shell, ipcMain, dialog } = require('electron');
const path = require('path');
const os = require('os');
const fs = require('fs');
const crypto = require('crypto');
const { execFile } = require('child_process');
const { createServer, lanIP } = require('./server');

// ===== MOTOR DE SEPARAÇÃO (roda local; baixado no 1º uso) =====
const https = require('https');
const http = require('http');
const { spawn } = require('child_process');
const MOTOR_URL = 'https://prismavs.com.br/download/motor.zip';
const MOTOR_PORT = 5000;
let motorProc = null;
function motorDir() { return path.join(app.getPath('userData'), 'motor'); }
function motorExe() {
  const a = path.join(motorDir(), 'motor.exe');
  if (fs.existsSync(a)) return a;
  const b = path.join(motorDir(), 'motor', 'motor.exe'); // caso o zip tenha a pasta dentro
  return fs.existsSync(b) ? b : a;
}
function motorRunning() {
  return new Promise((res) => {
    const req = http.get({ host: '127.0.0.1', port: MOTOR_PORT, path: '/pcinfo', timeout: 1500 },
      (r) => { r.resume(); res(r.statusCode === 200); });
    req.on('error', () => res(false));
    req.on('timeout', () => { req.destroy(); res(false); });
  });
}
async function waitMotor(sec) { for (let i = 0; i < sec; i++) { if (await motorRunning()) return true; await new Promise(r => setTimeout(r, 1000)); } return false; }
function startMotor() {
  try {
    const exe = motorExe();
    if (!fs.existsSync(exe)) return;
    if (motorProc && !motorProc.killed) return;
    motorProc = spawn(exe, [], { cwd: path.dirname(exe), windowsHide: true });
    motorProc.on('exit', () => { motorProc = null; });
  } catch (e) {}
}
function baixarArquivo(url, dest, onProgress) {
  return new Promise((resolve, reject) => {
    const f = fs.createWriteStream(dest);
    const req = https.get(url, (r) => {
      if (r.statusCode >= 300 && r.statusCode < 400 && r.headers.location) {
        f.close(); try { fs.unlinkSync(dest); } catch (_) {}
        return baixarArquivo(r.headers.location, dest, onProgress).then(resolve, reject);
      }
      if (r.statusCode !== 200) { f.close(); return reject(new Error('HTTP ' + r.statusCode)); }
      const total = parseInt(r.headers['content-length'] || '0', 10); let got = 0, last = -1;
      r.on('data', (c) => { got += c.length; if (total && onProgress) { const p = Math.round(got * 100 / total); if (p !== last) { last = p; onProgress(p); } } });
      r.pipe(f);
      f.on('finish', () => f.close(() => resolve()));
    });
    req.on('error', (e) => { try { fs.unlinkSync(dest); } catch (_) {} reject(e); });
  });
}
function descompactar(zip, dest) {
  return new Promise((resolve, reject) => {
    execFile('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command',
      "Expand-Archive -LiteralPath '" + zip + "' -DestinationPath '" + dest + "' -Force"],
      { windowsHide: true, timeout: 600000 }, (err) => err ? reject(err) : resolve());
  });
}
ipcMain.handle('sep-ensure', async () => {
  try {
    if (await motorRunning()) return { ok: true };
    if (fs.existsSync(motorExe())) { startMotor(); const up = await waitMotor(30); return up ? { ok: true } : { ok: false, msg: 'O motor não respondeu.' }; }
    const r = await dialog.showMessageBox(win, {
      type: 'question', buttons: ['Baixar agora', 'Cancelar'], defaultId: 0, cancelId: 1,
      title: 'Separador de músicas',
      message: 'Para separar músicas, o PRISMA precisa baixar o motor de separação uma única vez (cerca de 2 GB). Deseja baixar agora?'
    });
    if (r.response !== 0) return { ok: false, msg: 'Você cancelou o download do motor.' };
    fs.mkdirSync(motorDir(), { recursive: true });
    const zip = path.join(app.getPath('userData'), 'motor.zip');
    if (win) win.webContents.send('sep-progress', { fase: 'baixando', pct: 0 });
    await baixarArquivo(MOTOR_URL, zip, (pct) => { if (win) win.webContents.send('sep-progress', { fase: 'baixando', pct }); });
    if (win) win.webContents.send('sep-progress', { fase: 'instalando', pct: 0 });
    await descompactar(zip, motorDir());
    try { fs.unlinkSync(zip); } catch (_) {}
    startMotor();
    const up = await waitMotor(45);
    if (win) win.webContents.send('sep-progress', { fase: 'pronto', pct: 100 });
    return up ? { ok: true } : { ok: false, msg: 'Baixou, mas o motor não iniciou. Feche e abra o PRISMA de novo.' };
  } catch (err) { return { ok: false, msg: 'Erro no motor: ' + (err && err.message || err) }; }
});

// ====== ÁUDIO DO CULTO (plano B) ======
// Guarda o áudio das músicas separadas em Documentos\PRISMA Cultos\audio\<musica>\<faixa>.wav
// para o "Abrir culto" recarregar tudo sem depender do motor estar ligado.
function cultoAudioDir() {
  let base = '';
  try { base = path.join(app.getPath('documents'), 'PRISMA Cultos'); }
  catch (e) { try { base = path.join(app.getPath('userData'), 'PRISMA Cultos'); } catch (e2) { return ''; } }
  const dir = path.join(base, 'audio');
  try { fs.mkdirSync(dir, { recursive: true }); } catch (e) {}
  return dir;
}
function nomeSeguro(s) {
  return String(s || '').replace(/[\\/:*?"<>|]+/g, '-').replace(/\.\.+/g, '.').replace(/^\.+/, '').trim() || 'x';
}
ipcMain.handle('culto-write-song', async (e, { key, faixas }) => {
  try {
    const base = cultoAudioDir();
    if (!base) return { ok: false, error: 'sem pasta' };
    const dir = path.join(base, nomeSeguro(key));
    fs.mkdirSync(dir, { recursive: true });
    (faixas || []).forEach((f) => {
      if (!f || !f.file) return;
      let buf;
      if (Buffer.isBuffer(f.bytes)) buf = f.bytes;
      else if (f.bytes instanceof ArrayBuffer) buf = Buffer.from(f.bytes);
      else if (f.bytes && f.bytes.buffer) buf = Buffer.from(f.bytes.buffer, f.bytes.byteOffset || 0, f.bytes.byteLength);
      else buf = Buffer.from(f.bytes || []);
      fs.writeFileSync(path.join(dir, nomeSeguro(f.file)), buf);
    });
    return { ok: true };
  } catch (err) { return { ok: false, error: (err && err.message) || String(err) }; }
});

// ====== SERVIDOR DE LICENÇA (Locaweb) ======
// Deixe VAZIO ('') para o app abrir SEM pedir serial (bom para testar/gerar agora).
// Quando o servidor estiver no ar, ponha:  'https://prismavs.com.br/api'
const LICENSE_API = process.env.PRISMA_LICENSE_API || 'https://prismavs.com.br/api';

let win = null;
let PORT = parseInt(process.env.PRISMA_PORT || '8080', 10);

// ---------- licença ----------
const licFile = path.join(app.getPath('userData'), 'licenca.json');
function readLic() { try { return JSON.parse(fs.readFileSync(licFile, 'utf8')); } catch (e) { return {}; } }
function machineId() {
  // impressão digital estável do computador (id do SO + hostname), com hash
  let base = os.hostname() + '|' + os.platform() + '|' + os.arch();
  try { base += '|' + require('node-machine-id').machineIdSync(); } catch (e) {}
  return crypto.createHash('sha256').update(base).digest('hex').slice(0, 32);
}
ipcMain.on('lic-config', (e) => {
  const l = readLic();
  e.returnValue = { api: LICENSE_API, machineId: machineId(), machineName: os.hostname(), chave: l.chave || null };
});
ipcMain.on('lic-save', (e, chave, token) => {
  try { fs.writeFileSync(licFile, JSON.stringify({ chave, token, quando: Date.now() })); } catch (err) {}
});

// POST JSON pelo processo principal (Node) — NÃO sofre bloqueio de CORS do navegador.
function postJson(url, obj) {
  return new Promise((resolve, reject) => {
    let data; try { data = JSON.stringify(obj || {}); } catch (e) { return reject(e); }
    let u; try { u = new URL(url); } catch (e) { return reject(e); }
    const lib = (u.protocol === 'http:') ? http : https;
    const req = lib.request({
      hostname: u.hostname, port: u.port || (u.protocol === 'http:' ? 80 : 443),
      path: u.pathname + (u.search || ''), method: 'POST', timeout: 20000,
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) }
    }, (r) => {
      let body = ''; r.on('data', c => body += c);
      r.on('end', () => { try { resolve(JSON.parse(body)); } catch (e) { resolve(null); } });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
    req.write(data); req.end();
  });
}
// Inicia o teste de 15 dias (cria a licença de teste e já ativa nesta máquina).
ipcMain.handle('trial-start', async (e, dados) => {
  try {
    if (!LICENSE_API) return { ok: false, erro: 'Servidor de licença não configurado.' };
    const mid = machineId(), mnome = os.hostname();
    const t = await postJson(LICENSE_API + '/trial.php', {
      nome: (dados && dados.nome) || '', email: (dados && dados.email) || '',
      whatsapp: (dados && dados.whatsapp) || '', maquina_id: mid, maquina_nome: mnome
    });
    if (!t || !t.ok || !t.chave) return { ok: false, erro: (t && t.erro) || 'Não foi possível iniciar o teste.' };
    // O teste já vem amarrado à máquina pelo servidor (não precisa passar pelo ativar.php).
    try { fs.writeFileSync(licFile, JSON.stringify({ chave: t.chave, token: 'trial', quando: Date.now() })); } catch (_) {}
    return { ok: true, chave: t.chave };
  } catch (err) { return { ok: false, erro: 'Sem conexão com o servidor.' }; }
});
// Ativa um serial (também pelo Node, à prova de CORS).
ipcMain.handle('lic-activate', async (e, dados) => {
  try {
    if (!LICENSE_API) return { ok: false, erro: 'Servidor de licença não configurado.' };
    const ch = ((dados && dados.chave) || '').trim().toUpperCase();
    if (!ch) return { ok: false, erro: 'Digite o serial.' };
    const a = await postJson(LICENSE_API + '/ativar.php', { chave: ch, maquina_id: machineId(), maquina_nome: os.hostname() });
    if (a && a.ok) {
      try { fs.writeFileSync(licFile, JSON.stringify({ chave: ch, token: a.token || '', quando: Date.now() })); } catch (_) {}
      return { ok: true, chave: ch };
    }
    return { ok: false, erro: (a && a.erro) || 'Não foi possível ativar.' };
  } catch (err) { return { ok: false, erro: 'Sem conexão com o servidor de ativação.' }; }
});
// Revalida a licença (Node, à prova de CORS).
ipcMain.handle('lic-validate', async (e, dados) => {
  try {
    if (!LICENSE_API) return { ok: true };
    const ch = ((dados && dados.chave) || '').trim().toUpperCase();
    if (!ch) return { ok: false, erro: 'sem_chave' };
    const v = await postJson(LICENSE_API + '/validar.php', { chave: ch, maquina_id: machineId() });
    return v || { ok: true };   // sem resposta = não bloqueia
  } catch (err) { return { ok: true }; }   // offline = não bloqueia
});

// ---------- salvar / abrir o CULTO (janela nativa do Windows) ----------
function cultosDir() {
  let dir = '';
  try { dir = path.join(app.getPath('documents'), 'PRISMA Cultos'); }
  catch (e) { try { dir = path.join(app.getPath('userData'), 'PRISMA Cultos'); } catch (e2) { return ''; } }
  try { fs.mkdirSync(dir, { recursive: true }); } catch (e) {}
  return dir;
}
ipcMain.handle('file-save', async (e, nomeSugerido, texto) => {
  try {
    const base = cultosDir();
    const nome = String(nomeSugerido || 'culto').replace(/[\\/:*?"<>|]+/g, '-');
    const r = await dialog.showSaveDialog(win, {
      title: 'Salvar o culto',
      defaultPath: base ? path.join(base, nome) : nome,
      filters: [{ name: 'Culto PRISMA', extensions: ['prisma.json', 'json'] }]
    });
    if (r.canceled || !r.filePath) return { ok: false, canceled: true };
    let fp = r.filePath; if (!/\.json$/i.test(fp)) fp += '.prisma.json';
    fs.writeFileSync(fp, texto, 'utf8');
    return { ok: true, path: fp };
  } catch (err) { return { ok: false, error: String(err && err.message || err) }; }
});
ipcMain.handle('file-open', async (e) => {
  try {
    const base = cultosDir();
    const r = await dialog.showOpenDialog(win, {
      title: 'Abrir um culto salvo',
      defaultPath: base || undefined,
      properties: ['openFile'],
      filters: [{ name: 'Culto PRISMA', extensions: ['json', 'prisma.json'] }]
    });
    if (r.canceled || !r.filePaths || !r.filePaths[0]) return { ok: false, canceled: true };
    const texto = fs.readFileSync(r.filePaths[0], 'utf8');
    return { ok: true, path: r.filePaths[0], texto };
  } catch (err) { return { ok: false, error: String(err && err.message || err) }; }
});

// ---------- VOZ-GUIA (TTS offline via voz do Windows) ----------
// Gera um WAV a partir do texto, com voz feminina ('f') ou masculina ('m'),
// e guarda em cache. O renderer toca esse WAV numa pista com volume e pan.
const TTS_PS1 = [
  "param([string]$TextFile,[string]$Gender,[string]$Out)",
  "try{",
  "Add-Type -AssemblyName System.Speech",
  "$text=[System.IO.File]::ReadAllText($TextFile,[System.Text.Encoding]::UTF8)",
  "$syn=New-Object System.Speech.Synthesis.SpeechSynthesizer",
  "$want= if($Gender -eq 'm'){'Male'}else{'Female'}",
  "$all=@($syn.GetInstalledVoices() | Where-Object {$_.Enabled} | ForEach-Object {$_.VoiceInfo})",
  "$pt=@($all | Where-Object {$_.Culture.Name -like 'pt*'})",
  "$sel=$null",
  "if($pt.Count -gt 0){ $sel=$pt | Where-Object {$_.Gender -eq $want} | Select-Object -First 1; if(-not $sel){$sel=$pt[0]} }",
  "if(-not $sel){ $sel=$all | Where-Object {$_.Gender -eq $want} | Select-Object -First 1 }",
  "if(-not $sel -and $all.Count -gt 0){ $sel=$all[0] }",
  "$used='F'",
  "if($sel){ $syn.SelectVoice($sel.Name); if($sel.Gender -eq 'Male'){$used='M'} }",
  "$syn.Rate=0",
  "$syn.Volume=100",
  "[Console]::Out.Write('USED='+$used)",
  "$fmt=New-Object System.Speech.AudioFormat.SpeechAudioFormatInfo(44100,[System.Speech.AudioFormat.AudioBitsPerSample]::Sixteen,[System.Speech.AudioFormat.AudioChannel]::Mono)",
  "$syn.SetOutputToWaveFile($Out,$fmt)",
  "$syn.Speak($text)",
  "$syn.Dispose()",
  "}catch{ exit 1 }"
].join("\r\n");

let ttsPs1Path = '';
function ensureTtsPs1() {
  if (ttsPs1Path) return ttsPs1Path;
  try { const dir = path.join(app.getPath('userData'), 'tts'); fs.mkdirSync(dir, { recursive: true });
    ttsPs1Path = path.join(dir, 'tts.ps1'); fs.writeFileSync(ttsPs1Path, TTS_PS1, 'utf8'); }
  catch (e) { ttsPs1Path = ''; }
  return ttsPs1Path;
}
ipcMain.handle('tts-say', async (e, { text, voice }) => {
  try {
    if (process.platform !== 'win32') return { ok: false, error: 'so-windows' };
    text = String(text || '').slice(0, 300).trim(); if (!text) return { ok: false, error: 'vazio' };
    const gender = (voice === 'm') ? 'm' : 'f';
    const dir = path.join(app.getPath('userData'), 'tts'); fs.mkdirSync(dir, { recursive: true });
    const hash = crypto.createHash('sha1').update(gender + '|' + text).digest('hex').slice(0, 20);
    const wav = path.join(dir, hash + '.wav');
    if (fs.existsSync(wav)) {
      let used = 'f'; try { used = (fs.readFileSync(wav + '.used', 'utf8').trim() === 'M') ? 'm' : 'f'; } catch (_) {}
      return { ok: true, wav: fs.readFileSync(wav).toString('base64'), used };
    }
    const ps1 = ensureTtsPs1(); if (!ps1) return { ok: false, error: 'sem-ps1' };
    const inTxt = path.join(dir, 'in_' + hash + '.txt'); fs.writeFileSync(inTxt, text, 'utf8');
    let out = '';
    await new Promise((res, rej) => {
      execFile('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', ps1, '-TextFile', inTxt, '-Gender', gender, '-Out', wav],
        { windowsHide: true, timeout: 15000 }, (err, stdout) => { out = String(stdout || ''); err ? rej(err) : res(); });
    });
    try { fs.unlinkSync(inTxt); } catch (_) {}
    const used = /USED=M/.test(out) ? 'm' : 'f';
    try { fs.writeFileSync(wav + '.used', used === 'm' ? 'M' : 'F'); } catch (_) {}
    if (fs.existsSync(wav)) return { ok: true, wav: fs.readFileSync(wav).toString('base64'), used };
    return { ok: false, error: 'sem-wav' };
  } catch (err) { return { ok: false, error: String(err && err.message || err) }; }
});

// ---------- auto-update ----------
function checkUpdates() {
  try {
    const { autoUpdater } = require('electron-updater');
    autoUpdater.autoDownload = true;
    autoUpdater.checkForUpdatesAndNotify();
  } catch (e) { /* sem updater em dev */ }
}

// Cria (1a vez) a pasta EXTERNA de pads em Documentos\PRISMA Pads\1 e \2.
// O usuario solta os pads ali e NAO precisa gerar o instalador de novo.
function ensurePadsDir() {
  let dir = '';
  try { dir = path.join(app.getPath('documents'), 'PRISMA Pads'); }
  catch (e) { try { dir = path.join(app.getPath('userData'), 'PRISMA Pads'); } catch (e2) { return ''; } }
  try {
    fs.mkdirSync(path.join(dir, '1'), { recursive: true });
    fs.mkdirSync(path.join(dir, '2'), { recursive: true });
    const leia = path.join(dir, 'LEIA-ME.txt');
    if (!fs.existsSync(leia)) {
      fs.writeFileSync(leia,
        'PADS DO PRISMA\r\n' +
        '===============\r\n\r\n' +
        'Coloque os arquivos de pad AQUI. Nao precisa gerar o instalador de novo:\r\n' +
        'e so fechar e abrir o PRISMA.\r\n\r\n' +
        'Pasta "1" = Som 1  |  Pasta "2" = Som 2\r\n\r\n' +
        'Precisa de 7 arquivos em cada pasta, um por nota (A ate G):\r\n' +
        '  A ...  B ...  C ...  D ...  E ...  F ...  G ...\r\n\r\n' +
        'O nome pode ser "A.mp3" OU "A Pad.mp3" (o programa aceita os dois).\r\n' +
        'Os sustenidos (A#, C#, ...) o programa cria sozinho a partir dessas 7 notas.\r\n', 'utf8');
    }
  } catch (e) {}
  return dir;
}

// Cria (1a vez) a pasta EXTERNA de VOZES em Documentos\PRISMA Vozes\Homem e \Mulher.
// O usuario grava os clipes (numeros e palavras) e o programa usa no lugar da voz do Windows.
function ensureVozesDir() {
  let dir = '';
  try { dir = path.join(app.getPath('documents'), 'PRISMA Vozes'); }
  catch (e) { try { dir = path.join(app.getPath('userData'), 'PRISMA Vozes'); } catch (e2) { return ''; } }
  try {
    fs.mkdirSync(path.join(dir, 'Homem'), { recursive: true });
    fs.mkdirSync(path.join(dir, 'Mulher'), { recursive: true });
    const leia = path.join(dir, 'LEIA-ME.txt');
    if (!fs.existsSync(leia)) {
      fs.writeFileSync(leia,
        'VOZ-GUIA DO PRISMA (voz real, igual os pads)\r\n' +
        '=============================================\r\n\r\n' +
        'Aqui voce coloca CLIPES DE AUDIO gravados para a Voz-guia falar com voz\r\n' +
        'de verdade (no lugar da voz do Windows). Nao precisa gerar o instalador\r\n' +
        'de novo: e so por os arquivos e reabrir o PRISMA.\r\n\r\n' +
        'Pasta "Mulher" = voz feminina  |  Pasta "Homem" = voz masculina.\r\n\r\n' +
        'O NOME DO ARQUIVO e o que a voz fala. Ex.:\r\n' +
        '   1.mp3   2.mp3   3.mp3   4.mp3\r\n' +
        '   refrao.mp3   solo.mp3   verso.mp3   ponte.mp3   comecar.mp3   final.mp3\r\n\r\n' +
        'Acentos e maiusculas nao importam ("refrao.mp3" serve para "Refrão").\r\n' +
        'Grave cada palavra/numero em um arquivo curto (mp3 ou wav).\r\n\r\n' +
        'Como a Voz-guia funciona:\r\n' +
        '  - Se existir o clipe para a palavra, ele toca (voz real). \r\n' +
        '  - Se NAO existir, o programa usa a voz do Windows como reserva.\r\n' +
        '  - Assim voce grava so o que quiser (ex.: 1,2,3,4 e "comecar") e o resto\r\n' +
        '    continua na voz do Windows.\r\n\r\n' +
        'DICA: da para gerar esses clipes com uma voz de IA online (bem natural),\r\n' +
        'baixar os mp3 e por aqui — depois funciona offline para sempre.\r\n', 'utf8');
    }
  } catch (e) {}
  return dir;
}

// Cria (1a vez) a pasta EXTERNA de BOTOES em Documentos\PRISMA Botoes.
// Cada botao (Intro, Refrao, Solo...) e um arquivo de audio com o nome do botao.
function ensureBotoesDir() {
  let dir = '';
  try { dir = path.join(app.getPath('documents'), 'PRISMA Botoes'); }
  catch (e) { try { dir = path.join(app.getPath('userData'), 'PRISMA Botoes'); } catch (e2) { return ''; } }
  try {
    fs.mkdirSync(dir, { recursive: true });
    const leia = path.join(dir, 'LEIA-ME.txt');
    if (!fs.existsSync(leia)) {
      fs.writeFileSync(leia,
        'BOTOES DO PRISMA (cues de audio na linha do tempo)\r\n' +
        '===================================================\r\n\r\n' +
        'Cada BOTAO e um arquivo de audio com o nome do botao. Ex.:\r\n' +
        '   Intro.mp3   Refrao.mp3   Solo.mp3   Ponte.mp3   Final.mp3   Contagem.mp3\r\n\r\n' +
        'Acentos e maiusculas nao importam ("refrao.mp3" serve para "Refrão").\r\n' +
        'Pode ser mp3 ou wav. Coloque os arquivos AQUI e reabra o PRISMA.\r\n\r\n' +
        'No programa: clique na regua onde quer o cue, escolha o botao na caixinha,\r\n' +
        'e quando o cursor passar ali o audio do botao toca (com volume e pan do\r\n' +
        'painel BOTOES, separado do volume geral).\r\n', 'utf8');
    }
  } catch (e) {}
  return dir;
}

function startServerThenWindow() {
  const dirs = [];
  const padsDir = ensurePadsDir();
  if (padsDir) dirs.push(padsDir);                               // Documentos\PRISMA Pads
  // pasta "pads" AO LADO do programa (versao sem instalar / portatil)
  try { dirs.push(path.join(path.dirname(app.getPath('exe')), 'pads')); } catch (e) {}
  const vdirs = [];
  const vozDir = ensureVozesDir();
  if (vozDir) vdirs.push(vozDir);                               // Documentos\PRISMA Vozes
  try { vdirs.push(path.join(path.dirname(app.getPath('exe')), 'vozes')); } catch (e) {}
  const bdirs = [];
  const botDir = ensureBotoesDir();
  if (botDir) bdirs.push(botDir);                              // Documentos\PRISMA Botoes
  try { bdirs.push(path.join(path.dirname(app.getPath('exe')), 'botoes')); } catch (e) {}
  const cultoDir = cultoAudioDir();                             // Documentos\PRISMA Cultos\audio
  const s = createServer({ padsDirs: dirs, vozesDirs: vdirs, botoesDirs: bdirs, cultoAudioDir: cultoDir });
  let attempts = 12;
  s.server.on('error', (e) => {
    if (e && e.code === 'EADDRINUSE' && attempts-- > 0) { PORT += 1; setTimeout(() => s.listen(PORT, onListening), 60); }
    else { console.error('Erro no servidor:', e); }
  });
  function onListening() {
    console.log('PRISMA no PC:      http://localhost:' + PORT + '/');
    console.log('PRISMA no celular: http://' + lanIP() + ':' + PORT + '/remote');
    createWindow();
  }
  s.listen(PORT, onListening);
}

function createWindow() {
  win = new BrowserWindow({
    width: 1360, height: 860, minWidth: 1080, minHeight: 680,
    backgroundColor: '#14171c', title: 'PRISMA Virtual Sound',
    icon: path.join(__dirname, 'www', 'icon.ico'),
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: false,
      backgroundThrottling: false
    }
  });
  Menu.setApplicationMenu(null);
  win.loadURL('http://127.0.0.1:' + PORT + '/');
  win.webContents.setWindowOpenHandler(({ url }) => { shell.openExternal(url); return { action: 'deny' }; });
  win.on('closed', () => { win = null; });
}

app.whenReady().then(() => {
  // Libera permissão de mídia (necessário pro "Detectar" listar as placas de áudio).
  try {
    const ses = require('electron').session.defaultSession;
    ses.setPermissionRequestHandler((wc, perm, cb) => cb(true));
    if (ses.setPermissionCheckHandler) ses.setPermissionCheckHandler(() => true);
  } catch (e) {}
  startServerThenWindow(); checkUpdates();
  try { if (fs.existsSync(motorExe())) startMotor(); } catch (e) {}
});
app.on('will-quit', () => { try { if (motorProc && !motorProc.killed) motorProc.kill(); } catch (e) {} });
app.on('activate', () => { if (win === null) createWindow(); });
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
