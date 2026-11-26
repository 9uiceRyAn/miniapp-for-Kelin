const defaultStorage = require('./storage');

const MAX_MEMORY_ENTRIES = 120;
const MAX_PERSISTED_KEYS = 30;
const DEFAULT_HARD_MAX_AGE = 24 * 60 * 60 * 1000;
const PERSIST_PREFIX = 'kl_cache:';
const INDEX_PREFIX = 'kl_cache_keys:';

function createCache(deps = {}) {
  const storage = deps.storage || defaultStorage;
  const wxApi = deps.wx || (typeof wx !== 'undefined' ? wx : null);
  const now = deps.now || (() => Date.now());
  const memory = new Map();

  function getUserId() {
    try {
      const user = storage.getUser && storage.getUser();
      return user && user.id != null ? String(user.id) : 'anon';
    } catch {
      return 'anon';
    }
  }

  function scopedKey(userId, key) {
    return userId + ':' + key;
  }

  function storageKey(userId, key) {
    return PERSIST_PREFIX + userId + ':' + key;
  }

  function indexKey(userId) {
    return INDEX_PREFIX + userId;
  }

  function readIndex(userId) {
    if (!wxApi || typeof wxApi.getStorageSync !== 'function') return [];
    try {
      const list = wxApi.getStorageSync(indexKey(userId));
      return Array.isArray(list) ? list : [];
    } catch {
      return [];
    }
  }

  function writeIndex(userId, list) {
    if (!wxApi || typeof wxApi.setStorageSync !== 'function') return;
    try {
      wxApi.setStorageSync(indexKey(userId), list);
    } catch {
      // Ignore storage quota or serialization errors.
    }
  }

  function removePersisted(userId, key) {
    if (!wxApi || typeof wxApi.removeStorageSync !== 'function') return;
    try {
      wxApi.removeStorageSync(storageKey(userId, key));
    } catch {
      // Ignore storage errors.
    }
  }

  function touchMemory(fullKey, entry) {
    if (memory.has(fullKey)) memory.delete(fullKey);
    memory.set(fullKey, entry);
    if (memory.size > MAX_MEMORY_ENTRIES) {
      const oldestKey = memory.keys().next().value;
      if (oldestKey !== undefined) memory.delete(oldestKey);
    }
  }

  function get(key, options = {}) {
    const { maxAge, hardMaxAge = DEFAULT_HARD_MAX_AGE } = options;
    const userId = getUserId();
    const fullKey = scopedKey(userId, key);
    const ts = now();

    let entry = memory.get(fullKey);
    if (entry) {
      if (hardMaxAge != null && ts - entry.updatedAt > hardMaxAge) {
        memory.delete(fullKey);
        removePersisted(userId, key);
        return null;
      }
      touchMemory(fullKey, entry);
    } else if (wxApi && typeof wxApi.getStorageSync === 'function') {
      try {
        const persisted = wxApi.getStorageSync(storageKey(userId, key));
        if (persisted && persisted.v === 1 && typeof persisted.updatedAt === 'number') {
          if (hardMaxAge != null && ts - persisted.updatedAt > hardMaxAge) {
            removePersisted(userId, key);
            return null;
          }
          entry = { value: persisted.value, updatedAt: persisted.updatedAt };
          touchMemory(fullKey, entry);
        }
      } catch {
        return null;
      }
    }

    if (!entry) return null;
    const fresh = maxAge == null ? true : ts - entry.updatedAt <= maxAge;
    return { value: entry.value, updatedAt: entry.updatedAt, fresh };
  }

  function set(key, value, options = {}) {
    const { persist = false } = options;
    const userId = getUserId();
    const fullKey = scopedKey(userId, key);
    const updatedAt = now();
    const entry = { value, updatedAt };
    touchMemory(fullKey, entry);

    if (persist && wxApi && typeof wxApi.setStorageSync === 'function') {
      try {
        wxApi.setStorageSync(storageKey(userId, key), {
          v: 1,
          updatedAt,
          value,
        });
        const list = readIndex(userId).filter((item) => item !== key);
        list.push(key);
        while (list.length > MAX_PERSISTED_KEYS) {
          const evicted = list.shift();
          if (evicted !== undefined) removePersisted(userId, evicted);
        }
        writeIndex(userId, list);
      } catch {
        // Ignore storage quota or serialization errors.
      }
    }
  }

  function invalidate(prefixOrKey) {
    if (!prefixOrKey) return;
    const userId = getUserId();
    const prefix = userId + ':';
    for (const fullKey of Array.from(memory.keys())) {
      if (!fullKey.startsWith(prefix)) continue;
      const entryKey = fullKey.slice(prefix.length);
      if (entryKey === prefixOrKey || entryKey.startsWith(prefixOrKey)) {
        memory.delete(fullKey);
      }
    }
    const list = readIndex(userId);
    if (list.length) {
      const kept = [];
      for (const entryKey of list) {
        if (entryKey === prefixOrKey || entryKey.startsWith(prefixOrKey)) {
          removePersisted(userId, entryKey);
        } else {
          kept.push(entryKey);
        }
      }
      if (kept.length !== list.length) writeIndex(userId, kept);
    }
  }

  function clear() {
    const userId = getUserId();
    const prefix = userId + ':';
    for (const fullKey of Array.from(memory.keys())) {
      if (fullKey.startsWith(prefix)) memory.delete(fullKey);
    }
    const list = readIndex(userId);
    for (const entryKey of list) {
      removePersisted(userId, entryKey);
    }
    if (wxApi && typeof wxApi.removeStorageSync === 'function') {
      try {
        wxApi.removeStorageSync(indexKey(userId));
      } catch {
        // Ignore storage errors.
      }
    }
  }

  return { get, set, invalidate, clear };
}

const defaultCache = createCache();

module.exports = {
  ...defaultCache,
  createCache,
};
