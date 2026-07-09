'use strict';
// Resolves which GOWA engine (process) serves a given device or group. A device
// belongs to a country group (default `ua`); each group runs its own engine in
// the pool. Returns the base URL + basic-auth header for that engine, or null
// when the engine isn't up yet.
const store = require('./accountStore');
const gowa = require('./gowaManager');

function toEngine(e) {
  if (!e) return null;
  return {
    baseUrl: `http://127.0.0.1:${e.port}`,
    auth: 'Basic ' + Buffer.from(`${e.user}:${e.pass}`).toString('base64'),
  };
}

function forGroup(groupId) {
  return toEngine(gowa.engine(groupId));
}

function forDevice(deviceId) {
  const a = store.get(deviceId);
  return forGroup((a && a.groupId) || 'ua');
}

module.exports = { forGroup, forDevice };
