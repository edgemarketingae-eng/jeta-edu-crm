// Per-request context (who is acting) so the audit log can record every change automatically.
const { AsyncLocalStorage } = require('node:async_hooks');

const als = new AsyncLocalStorage();
const ctx = () => als.getStore() || {};
const run = (store, fn) => als.run({ ...ctx(), ...store }, fn);
module.exports = { als, ctx, run, userId: () => ctx().userId ?? null };
