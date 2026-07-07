function serializeMeta(meta) {
  if (!meta) return '';
  try {
    return JSON.stringify(redactSecrets(meta));
  } catch {
    return String(meta);
  }
}

function redactSecrets(value) {
  if (Array.isArray(value)) return value.map(redactSecrets);
  if (!value || typeof value !== 'object') return value;

  return Object.fromEntries(
    Object.entries(value).map(([key, item]) => {
      if (/token|secret|authorization|access_token/i.test(key)) return [key, '[REDACTED]'];
      return [key, redactSecrets(item)];
    })
  );
}

function log(level, message, meta) {
  const suffix = meta ? ` ${serializeMeta(meta)}` : '';
  console[level](`[${new Date().toISOString()}] ${message}${suffix}`);
}

module.exports = {
  info: (message, meta) => log('log', message, meta),
  warn: (message, meta) => log('warn', message, meta),
  error: (message, meta) => log('error', message, meta),
  redactSecrets
};
