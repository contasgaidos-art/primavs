// PRISMA - servidor de controle remoto embutido (Node, sem dependencias externas).
// Serve o app (PC) e a pagina do celular, e faz a ponte dos comandos.
const http = require('http');
const fs   = require('fs');
const path = require('path');
const os   = require('os');
let WebSocketServer = null, QRCode = null;
try { WebSocketServer = require('ws').WebSocketServer; } catch (e) {}
try { QRCode = require('qrcode'); } catch (e) {}

// Escolhe o MELHOR IP local para o celular.
// Prioridade: hotspot do Windows (192.168.137.x) > redes de casa (192.168.x) >
// 10.x > 172.16-31.x > qualquer privado > (por ultimo) publico.
// Assim o QR nunca cai num IP publico (ex.: 54.x) que o celular nao alcanca.
function ipScore(ip) {
  if (/^192\.168\.137\./.test(ip)) return 100;   // Hotspot movel do Windows
  if (/^192\.168\./.test(ip))      return 90;    // Wi-Fi/roteador de casa
  if (/^10\./.test(ip))            return 80;    // rede privada
  const m = ip.match(/^172\.(\d+)\./);
  if (m && +m[1] >= 16 && +m[1] <= 31) return 75; // rede privada
  if (/^169\.254\./.test(ip))      return 5;      // sem conexao (APIPA)
  if (/^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./.test(ip)) return 10; // CGNAT
  return 30;                                       // publico ou outro
}
function lanIP() {
  const ifs = os.networkInterfaces();
  let best = null, bestScore = -1;
  for (const name of Object.keys(ifs)) {
    for (const ni of ifs[name] || []) {
      if (ni.family !== 'IPv4' || ni.internal) continue;
      const sc = ipScore(ni.address);
      if (sc > bestScore) { bestScore = sc; best = ni.address; }
    }
  }
  return best || '127.0.0.1';
}

function createServer(opts = {}) {
  const WWW = opts.www || path.join(__dirname, 'www');
  const CULTO_DIR = opts.cultoAudioDir || '';   // Documentos\PRISMA Cultos\audio (áudio das músicas do culto)
  // Pastas onde procurar os PADS, em ordem. A externa (ex.: Documentos\PRISMA Pads)
  // vem primeiro: assim da para trocar os pads SEM gerar o instalador de novo.
  const PAD_DIRS = [];
  (opts.padsDirs || []).forEach(d => { if (d) PAD_DIRS.push(d); });
  PAD_DIRS.push(path.join(WWW, 'pads'));            // pads embutidos no app (reserva)

  // Acha o arquivo do pad aceitando nomes soltos: "A.mp3", "A Pad.mp3",
  // "a pad.mp3", "A.wav"... (so precisa comecar pela nota A..G).
  const AUDIO_EXT = ['.mp3', '.ogg', '.wav', '.m4a', '.flac'];
  function resolvePad(setName, note) {
    note = String(note).toUpperCase();
    for (const base of PAD_DIRS) {
      const dir = path.join(base, String(setName));
      let files;
      try { files = fs.readdirSync(dir); } catch (e) { continue; }
      // 1) nome exato tipo "A.mp3"
      for (const ext of AUDIO_EXT) {
        const exact = files.find(f => f.toLowerCase() === (note + ext).toLowerCase());
        if (exact) return path.join(dir, exact);
      }
      // 2) nome que COMECA pela nota e é audio: "A Pad.mp3", "A-pad.mp3", "A (dark).mp3"
      const near = files.find(f => {
        const ext = path.extname(f).toLowerCase();
        if (!AUDIO_EXT.includes(ext)) return false;
        const up = f.toUpperCase();
        // proxima letra depois da nota nao pode ser outra letra/numero (evita "AB.mp3")
        return up.startsWith(note) && !/[A-Z0-9#]/.test(up.charAt(note.length));
      });
      if (near) return path.join(dir, near);
    }
    return null;
  }

  // ---- VOZ-GUIA por clipes gravados (igual os pads) ----
  // Pastas: <externa>/Homem e <externa>/Mulher. Arquivo nomeado pelo que fala:
  // "1.mp3", "refrao.mp3", "comecar.mp3"... (acentos/maiusculas nao importam).
  const VOZ_DIRS = [];
  (opts.vozesDirs || []).forEach(d => { if (d) VOZ_DIRS.push(d); });
  function slugVoz(s) { return String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, ''); }
  function resolveVoz(genero, texto) {
    const alvo = slugVoz(texto); if (!alvo) return null;
    for (const base of VOZ_DIRS) {
      const dir = path.join(base, genero);
      let files; try { files = fs.readdirSync(dir); } catch (e) { continue; }
      const hit = files.find(f => { const ext = path.extname(f).toLowerCase(); if (!AUDIO_EXT.includes(ext)) return false; return slugVoz(path.basename(f, ext)) === alvo; });
      if (hit) return path.join(dir, hit);
    }
    return null;
  }

  // ---- BOTOES (cues de audio): cada botao e um arquivo pelo nome ----
  const BOT_DIRS = [];
  (opts.botoesDirs || []).forEach(d => { if (d) BOT_DIRS.push(d); });
  function resolveBotao(nome) {
    const alvo = slugVoz(nome); if (!alvo) return null;
    for (const base of BOT_DIRS) {
      let files; try { files = fs.readdirSync(base); } catch (e) { continue; }
      const hit = files.find(f => { const ext = path.extname(f).toLowerCase(); if (!AUDIO_EXT.includes(ext)) return false; return slugVoz(path.basename(f, ext)) === alvo; });
      if (hit) return path.join(base, hit);
    }
    return null;
  }
  function listarBotoes() {
    const vistos = {}; const lista = [];
    for (const base of BOT_DIRS) {
      let files; try { files = fs.readdirSync(base); } catch (e) { continue; }
      files.forEach(f => { const ext = path.extname(f).toLowerCase(); if (!AUDIO_EXT.includes(ext)) return;
        const nome = path.basename(f, ext); const sl = slugVoz(nome); if (!sl || vistos[sl]) return; vistos[sl] = 1; lista.push(nome); });
    }
    lista.sort((a, b) => a.localeCompare(b, 'pt'));
    return lista;
  }
  let state = { tracks: [], regions: [], master: 1, pad: { key: null, vol: 0.6, notes: [] }, playing: false };
  let cmds = [];
  let waiters = [];        // respostas /poll aguardando comandos (fallback HTTP)
  let curPort = 0;
  let lastState = null;    // ultimo estado enviado pelo host (para novos celulares)

  function sendJSON(res, code, body) {
    if (typeof body !== 'string') body = JSON.stringify(body);
    res.writeHead(code, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*', 'Cache-Control': 'no-store' });
    res.end(body);
  }
  function serveFile(res, file, ctype) {
    fs.readFile(path.join(WWW, file), (err, data) => {
      if (err) { res.writeHead(404); res.end('nao encontrado: ' + file); return; }
      res.writeHead(200, { 'Content-Type': ctype, 'Access-Control-Allow-Origin': '*' });
      res.end(data);
    });
  }
  function flushPoll() {
    if (cmds.length && waiters.length) {
      const out = JSON.stringify(cmds); cmds = [];
      const ws = waiters; waiters = [];
      ws.forEach(w => { clearTimeout(w.t); try { sendJSON(w.res, 200, out); } catch (e) {} });
    }
  }

  const server = http.createServer((req, res) => {
    const u = req.url.split('?')[0];
    if (req.method === 'OPTIONS') {
      res.writeHead(204, { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'GET,POST,OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type' });
      return res.end();
    }
    if (req.method === 'GET' || req.method === 'HEAD') {
      // CULTO: /cultoaudio/<musica>/<faixa>.wav  -> áudio salvo do culto (plano B)
      const cm = decodeURIComponent(u).match(/^\/cultoaudio\/([^\/]+)\/([^\/]+)$/);
      if (cm) {
        if (!CULTO_DIR) { res.writeHead(404); return res.end('sem pasta de culto'); }
        const safe = s => String(s || '').replace(/[\\/:*?"<>|]+/g, '-').replace(/\.\.+/g, '.').replace(/^\.+/, '');
        const fp = path.join(CULTO_DIR, safe(cm[1]), safe(cm[2]));
        if (fp.startsWith(CULTO_DIR) && fs.existsSync(fp) && fs.statSync(fp).isFile()) {
          const size = fs.statSync(fp).size;
          res.writeHead(200, { 'Content-Type': 'audio/wav', 'Access-Control-Allow-Origin': '*', 'Accept-Ranges': 'bytes', 'Content-Length': String(size) });
          if (req.method === 'HEAD') return res.end();
          return fs.createReadStream(fp).pipe(res);
        }
        res.writeHead(404); return res.end('audio do culto nao encontrado');
      }
      // PADS: /pads/<set>/<nota>.mp3  -> aceita nomes soltos e pasta externa
      const pm = decodeURIComponent(u).match(/^\/pads\/([^\/]+)\/([A-Ga-g])[^\/]*$/);
      if (pm) {
        const fp = resolvePad(pm[1], pm[2]);
        if (fp && fs.existsSync(fp)) {
          const ext = path.extname(fp).toLowerCase();
          const ct = { '.mp3': 'audio/mpeg', '.ogg': 'audio/ogg', '.wav': 'audio/wav', '.m4a': 'audio/mp4', '.flac': 'audio/flac' }[ext] || 'audio/mpeg';
          const size = fs.statSync(fp).size;
          res.writeHead(200, { 'Content-Type': ct, 'Access-Control-Allow-Origin': '*', 'Accept-Ranges': 'bytes', 'Content-Length': String(size) });
          if (req.method === 'HEAD') return res.end();
          return fs.createReadStream(fp).pipe(res);
        }
        res.writeHead(404); return res.end('pad nao encontrado');
      }
      // VOZES: /vozes/<Homem|Mulher>/<texto>  -> clipe gravado (voz real)
      const vm = decodeURIComponent(u).match(/^\/vozes\/([^\/]+)\/(.+)$/);
      if (vm) {
        const genero = /homem|masc|male/i.test(vm[1]) ? 'Homem' : 'Mulher';
        const texto = vm[2].replace(/\.[a-z0-9]+$/i, '');
        const fp = resolveVoz(genero, texto);
        if (fp && fs.existsSync(fp)) {
          const ext = path.extname(fp).toLowerCase();
          const ct = { '.mp3': 'audio/mpeg', '.ogg': 'audio/ogg', '.wav': 'audio/wav', '.m4a': 'audio/mp4', '.flac': 'audio/flac' }[ext] || 'audio/mpeg';
          const size = fs.statSync(fp).size;
          res.writeHead(200, { 'Content-Type': ct, 'Access-Control-Allow-Origin': '*', 'Accept-Ranges': 'bytes', 'Content-Length': String(size) });
          if (req.method === 'HEAD') return res.end();
          return fs.createReadStream(fp).pipe(res);
        }
        res.writeHead(404); return res.end('voz nao encontrada');
      }
      // BOTOES: lista dos botoes disponiveis (arquivos na pasta)
      if (u === '/botoes-lista') return sendJSON(res, 200, { botoes: listarBotoes() });
      // BOTOES: /botoes/<nome> -> toca o clipe daquele botao
      const bm = decodeURIComponent(u).match(/^\/botoes\/(.+)$/);
      if (bm) {
        const nome = bm[1].replace(/\.[a-z0-9]+$/i, '');
        const fp = resolveBotao(nome);
        if (fp && fs.existsSync(fp)) {
          const ext = path.extname(fp).toLowerCase();
          const ct = { '.mp3': 'audio/mpeg', '.ogg': 'audio/ogg', '.wav': 'audio/wav', '.m4a': 'audio/mp4', '.flac': 'audio/flac' }[ext] || 'audio/mpeg';
          const size = fs.statSync(fp).size;
          res.writeHead(200, { 'Content-Type': ct, 'Access-Control-Allow-Origin': '*', 'Accept-Ranges': 'bytes', 'Content-Length': String(size) });
          if (req.method === 'HEAD') return res.end();
          return fs.createReadStream(fp).pipe(res);
        }
        res.writeHead(404); return res.end('botao nao encontrado');
      }
      // arquivos estáticos (ex.: /icon.ico)
      if (u !== '/' && u !== '/index.html' && u !== '/remote' && u !== '/remote.html' &&
          u !== '/whoami' && u !== '/qr' && u !== '/state' && u !== '/poll') {
        const rel = decodeURIComponent(u).replace(/^\/+/, '');
        if (rel && !rel.includes('..')) {
          const fp = path.join(WWW, rel);
          if (fp.startsWith(WWW) && fs.existsSync(fp) && fs.statSync(fp).isFile()) {
            const ext = path.extname(fp).toLowerCase();
            const ct = { '.mp3': 'audio/mpeg', '.ogg': 'audio/ogg', '.wav': 'audio/wav', '.m4a': 'audio/mp4',
              '.png': 'image/png', '.ico': 'image/x-icon', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json' }[ext] || 'application/octet-stream';
            const size = fs.statSync(fp).size;
            res.writeHead(200, { 'Content-Type': ct, 'Access-Control-Allow-Origin': '*', 'Accept-Ranges': 'bytes', 'Content-Length': String(size) });
            if (req.method === 'HEAD') { return res.end(); }
            return fs.createReadStream(fp).pipe(res);
          }
        }
      }
      if (u === '/' || u === '/index.html') return serveFile(res, 'prismaeditor.html', 'text/html; charset=utf-8');
      if (u === '/remote' || u === '/remote.html') return serveFile(res, 'remote.html', 'text/html; charset=utf-8');
      if (u === '/whoami') return sendJSON(res, 200, { ip: lanIP(), port: curPort });
      if (u === '/qr') {
        if (!QRCode) { res.writeHead(404); return res.end('sem qr'); }
        const url = 'http://' + lanIP() + ':' + curPort + '/remote';
        QRCode.toBuffer(url, { type: 'png', margin: 1, width: 360, color: { dark: '#0b0e12ff', light: '#ffffffff' } }, (err, buf) => {
          if (err) { res.writeHead(500); return res.end('qr err'); }
          res.writeHead(200, { 'Content-Type': 'image/png', 'Access-Control-Allow-Origin': '*', 'Cache-Control': 'no-store' });
          res.end(buf);
        });
        return;
      }
      if (u === '/state') return sendJSON(res, 200, lastState || state);
      if (u === '/poll') {
        if (cmds.length) { const out = JSON.stringify(cmds); cmds = []; return sendJSON(res, 200, out); }
        const w = { res, t: null };
        w.t = setTimeout(() => { const i = waiters.indexOf(w); if (i >= 0) { waiters.splice(i, 1); sendJSON(res, 200, '[]'); } }, 25000);
        waiters.push(w);
        res.on('close', () => { clearTimeout(w.t); const i = waiters.indexOf(w); if (i >= 0) waiters.splice(i, 1); });
        return;
      }
      res.writeHead(404); return res.end('nf');
    }
    if (req.method === 'POST') {
      let body = '';
      req.on('data', c => { body += c; if (body.length > 2e6) req.destroy(); });
      req.on('end', () => {
        if (u === '/cmd') { try { cmds.push(JSON.parse(body)); } catch (e) {} flushPoll(); return sendJSON(res, 200, 'ok'); }
        if (u === '/state') { try { state = JSON.parse(body); lastState = state; } catch (e) {} return sendJSON(res, 200, 'ok'); }
        if (u === '/feedback') { try { fs.appendFileSync(path.join(__dirname, 'sugestoes.jsonl'), body.replace(/\n/g, ' ') + '\n'); } catch (e) {} return sendJSON(res, 200, 'ok'); }
        res.writeHead(404); res.end('nf');
      });
      return;
    }
    res.writeHead(404); res.end('nf');
  });

  // WebSocket (tempo real): celular <-> PC. Fallback HTTP continua funcionando.
  if (WebSocketServer) {
    const wss = new WebSocketServer({ server, path: '/ws' });
    const roleOf = req => {
      try { return new URL(req.url, 'http://x').searchParams.get('role') || 'remote'; }
      catch (e) { return 'remote'; }
    };
    const send = (c, data) => { if (c.readyState === 1) { try { c.send(data); } catch (e) {} } };
    wss.on('connection', (ws, req) => {
      ws._role = roleOf(req);
      if (ws._role === 'remote' && lastState) send(ws, JSON.stringify({ kind: 'state', state: lastState }));
      ws.on('message', (data) => {
        const s = data.toString();
        if (ws._role === 'host') {
          try { const m = JSON.parse(s); if (m.kind === 'state') { state = m.state; lastState = m.state; } } catch (e) {}
          wss.clients.forEach(c => { if (c._role === 'remote') send(c, s); });     // host -> celulares
        } else {
          wss.clients.forEach(c => { if (c._role === 'host') send(c, s); });       // celular -> PC
        }
      });
    });
  }

  return {
    server,
    lanIP,
    listen(port, cb) { curPort = port; server.listen(port, '0.0.0.0', cb); },
    get port() { return curPort; }
  };
}

module.exports = { createServer, lanIP };

// Execucao direta (teste): node server.js
if (require.main === module) {
  const PORT = parseInt(process.env.PRISMA_PORT || '8080', 10);
  const s = createServer();
  s.listen(PORT, () => console.log('PRISMA server em http://' + lanIP() + ':' + PORT + '/'));
}
