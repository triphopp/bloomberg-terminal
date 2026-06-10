// Redis removed — replaced by in-memory cache in API routes
export const redis = {
  get: async () => null,
  set: async () => null,
  ping: async () => { throw new Error("Redis not configured"); },
};
