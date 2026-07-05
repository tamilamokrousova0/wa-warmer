'use strict';
// Central log/event bus. Main modules push lines here; ipc.js forwards them to
// the renderer and keeps a bounded ring buffer for late subscribers.
const { EventEmitter } = require('node:events');

const MAX = 500;
const buffer = [];
const emitter = new EventEmitter();
emitter.setMaxListeners(50);

function push(tag, level, msg) {
  const line = { ts: Date.now(), tag, level, msg: String(msg) };
  buffer.push(line);
  if (buffer.length > MAX) buffer.shift();
  emitter.emit('line', line);
  return line;
}

const log = {
  info: (tag, msg) => push(tag, 'info', msg),
  warn: (tag, msg) => push(tag, 'warn', msg),
  error: (tag, msg) => push(tag, 'error', msg),
  gowa: (msg) => push('gowa', 'info', msg),
  warming: (msg) => push('warming', 'info', msg),
  history: () => buffer.slice(),
  on: (fn) => {
    emitter.on('line', fn);
    return () => emitter.off('line', fn);
  },
  emitter,
};

module.exports = log;
