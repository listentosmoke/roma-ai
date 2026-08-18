export const serverDataConfig = {
  healthEndpoint: '/api/data/health',
};

/** A stable object whose methods always delegate to `ref.current` at call time — lets useMemory/usePeople swap the underlying repository (server-backed <-> localStorage dev fallback <-> unavailable) without rebuilding the coordinator built on top of it. */
export function createDelegatingRepository(ref) {
  return new Proxy({}, {
    get(_target, prop) {
      return (...args) => ref.current[prop]?.(...args);
    },
  });
}
