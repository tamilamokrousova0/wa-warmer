'use strict';
// Local HTTP server that receives GOWA webhook callbacks (real inbound events).
// Each logged-in device is pointed here via PATCH /devices/{id}/webhook, so we
// learn about genuinely delivered messages and can react / mark read.
const http = require('node:http');
const net = require('node:net');
const { EventEmitter } = require('node:events');
const log = require('./logbus');

const events = new EventEmitter();
events.setMaxListeners(50);
let server = null;
let url = null;

function freePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.on('error', reject);
    s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); });
  });
}

async function start() {
  if (url) return url;
  const port = await freePort();
  server = http.createServer((req, res) => {
    if (req.method !== 'POST') { res.writeHead(200); return res.end('ok'); }
    let body = '';
    req.on('data', (c) => { body += c; if (body.length > 1_000_000) req.destroy(); });
    req.on('end', () => {
      res.writeHead(200); res.end('ok');
      let data;
      try { data = JSON.parse(body); } catch { return; }
      try { events.emit('inbound', data); } catch (e) { log.warn('webhook', e.message); }
    });
  });
  await new Promise((resolve) => server.listen(port, '127.0.0.1', resolve));
  url = `http://127.0.0.1:${port}/webhook`;
  log.info('webhook', `слушаю входящие на ${url}`);
  return url;
}

function stop() {
  try { server && server.close(); } catch { /* ignore */ }
  server = null; url = null;
}

module.exports = { start, stop, events, getUrl: () => url };
