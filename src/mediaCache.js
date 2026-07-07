function createMediaCache(fetcher, ttlSeconds) {
  const ttlMs = Math.max(Number(ttlSeconds) || 300, 1) * 1000;
  const cache = new Map();

  async function get(limit, options = {}) {
    const safeLimit = Math.min(Math.max(Number(limit) || 25, 1), 100);
    const key = String(safeLimit);
    const now = Date.now();
    const cached = cache.get(key);

    if (!options.force && cached && cached.expiresAt > now) {
      return {
        data: cached.data,
        cache: { hit: true, ttlSeconds: Math.ceil((cached.expiresAt - now) / 1000) }
      };
    }

    const data = await fetcher(safeLimit);
    cache.set(key, {
      data,
      expiresAt: now + ttlMs
    });

    return {
      data,
      cache: { hit: false, ttlSeconds: Math.ceil(ttlMs / 1000) }
    };
  }

  function clear() {
    cache.clear();
  }

  return { get, clear };
}

module.exports = {
  createMediaCache
};
