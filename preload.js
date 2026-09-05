// Ponte de licença: injeta window.PRISMA_LIC no PRISMA (renderer).
const { ipcRenderer } = require('electron');
const cfg = ipcRenderer.sendSync('lic-config');   // {api, machineId, machineName, chave}
window.PRISMA_LIC = Object.assign({}, cfg, {
  saveToken: (chave, token) => { try { ipcRenderer.send('lic-save', chave, token); } catch (e) {} },
  // Chamadas ao servidor pelo processo principal (Node) — não sofrem bloqueio de CORS.
  trialStart: (dados) => ipcRenderer.invoke('trial-start', dados),
  activate:   (chave) => ipcRenderer.invoke('lic-activate', { chave }),
  validate:   (chave) => ipcRenderer.invoke('lic-validate', { chave })
});

// Ponte de ARQUIVOS: salvar/abrir o culto com a janela nativa do Windows.
// (o Electron nao suporta window.prompt(), por isso o Salvar antigo nao fazia nada)
window.PRISMA_FILE = {
  save: (nomeSugerido, texto) => ipcRenderer.invoke('file-save', nomeSugerido, texto),
  open: () => ipcRenderer.invoke('file-open')
};

// Voz-guia: gera a fala (WAV) a partir do texto, offline pela voz do Windows.
window.PRISMA_TTS = {
  say: (text, voice) => ipcRenderer.invoke('tts-say', { text, voice })
};

// Motor de separação (local): garante que está instalado+ligado; avisa o progresso do download.
window.PRISMA_SEP = {
  ensure: () => ipcRenderer.invoke('sep-ensure'),
  onProgress: (cb) => ipcRenderer.on('sep-progress', (e, d) => cb(d))
};

// Culto (plano B): grava o áudio das músicas separadas numa pasta fixa
// para o "Abrir culto" recarregar tudo sem depender do motor estar ligado.
window.PRISMA_CULTO = {
  writeSong: (key, faixas) => ipcRenderer.invoke('culto-write-song', { key, faixas })
};
