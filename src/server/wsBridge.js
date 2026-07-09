'use strict';

// WebSocket-мост: /ws — единственный канал доставки серверных событий в панель.
// Заменяет webContents.send(...) из ipc.js. Каждый подключённый клиент кладётся
// в набор; функция emit(channel, payload) широковещает всем живым сокетам JSON
// вида {channel, payload}. Каналы идентичны прежним ipc.js/boot.js:
//   log:line, accounts:updated, login:qr|code|success|timeout|cancel,
//   warming:tick|state, gowa:state, account:loggedOut, notify.
//
// Требует зарегистрированный @fastify/websocket. Роут /ws закрыт requireSession
// (та же подписанная кука, что и для REST).

const auth = require('./auth');

/**
 * Вешает /ws на приложение и возвращает { emit, clientCount }.
 * @param {import('fastify').FastifyInstance} app  Fastify с @fastify/websocket
 * @returns {{ emit: (channel: string, payload: any) => void, clientCount: () => number }}
 */
function attach(app) {
  const clients = new Set();

  app.get('/ws', { websocket: true, preHandler: auth.requireSession }, (socket /* WebSocket */) => {
    clients.add(socket);
    socket.on('close', () => clients.delete(socket));
    socket.on('error', () => clients.delete(socket));
  });

  function emit(channel, payload) {
    const msg = JSON.stringify({ channel, payload });
    for (const socket of clients) {
      // 1 === WebSocket.OPEN — шлём только живым сокетам
      if (socket.readyState === 1) {
        try { socket.send(msg); } catch { clients.delete(socket); }
      } else {
        clients.delete(socket);
      }
    }
  }

  return { emit, clientCount: () => clients.size };
}

module.exports = { attach };
