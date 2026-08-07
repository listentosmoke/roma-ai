// Authenticated background-task API. Same boundary discipline as
// server/routes/dataApi.mjs: the principal comes from the auth layer and
// never from the request body, every query is workspace-scoped, responses are
// bounded, and errors are generic.

const MAX_BODY_BYTES = 256 * 1024;

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) { reject(new Error('Request body too large.')); req.destroy(); return; }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (!chunks.length) { resolve({}); return; }
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); } catch { reject(new Error('Request body was not valid JSON.')); }
    });
    req.on('error', reject);
  });
}
function sendJson(res, status, body) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json');
  res.end(JSON.stringify(body));
}
function parseUrl(req) {
  const url = new URL(req.url, 'http://internal');
  return { pathname: url.pathname, query: Object.fromEntries(url.searchParams.entries()) };
}
function matchPath(pattern, pathname) {
  const patternParts = pattern.split('/').filter(Boolean);
  const pathParts = pathname.split('/').filter(Boolean);
  if (patternParts.length !== pathParts.length) return null;
  const params = {};
  for (let i = 0; i < patternParts.length; i += 1) {
    if (patternParts[i].startsWith(':')) params[patternParts[i].slice(1)] = decodeURIComponent(pathParts[i]);
    else if (patternParts[i] !== pathParts[i]) return null;
  }
  return params;
}
function createRateLimiter({ windowMs = 10_000, max = 30 } = {}) {
  const hits = new Map();
  return function checkLimit(key) {
    const at = Date.now();
    const recent = (hits.get(key) ?? []).filter((t) => at - t < windowMs);
    recent.push(at);
    hits.set(key, recent);
    return recent.length <= max;
  };
}

export function createAgentTaskHandlers({ taskStore, engineeringMemory, dispatcher, auth }) {
  const limiter = createRateLimiter({ windowMs: 10_000, max: 60 });
  const dispatchLimiter = createRateLimiter({ windowMs: 60_000, max: 10 });

  async function withPrincipal(req, res) {
    const resolved = await auth.resolvePrincipal(req);
    if (!resolved.ok) { sendJson(res, resolved.status ?? 401, { error: 'Unauthorized.', code: resolved.reasonCode }); return null; }
    if (!limiter(resolved.principal.userId)) { sendJson(res, 429, { error: 'Rate limit exceeded.', code: 'rate_limited' }); return null; }
    return resolved.principal;
  }

  return {
    async health(req, res) {
      const principal = await withPrincipal(req, res); if (!principal) return;
      const tasks = taskStore.forWorkspace(principal.workspaceId, principal.userId);
      sendJson(res, 200, {
        ok: true,
        worker: dispatcher.describeWorker(),
        active: tasks.listActive().length,
        projects: engineeringMemory.forWorkspace(principal.workspaceId, principal.userId).listProjects().length,
      });
    },

    async createTask(req, res) {
      const principal = await withPrincipal(req, res); if (!principal) return;
      if (!dispatchLimiter(principal.userId)) { sendJson(res, 429, { error: 'Too many dispatches.', code: 'rate_limited' }); return; }
      const body = await readJsonBody(req);
      const tasks = taskStore.forWorkspace(principal.workspaceId, principal.userId);
      const memory = engineeringMemory.forWorkspace(principal.workspaceId, principal.userId);

      // A named project must already be registered — a task never invents a
      // filesystem location for a worker to operate in.
      let projectId = null;
      if (body.project) {
        const project = memory.findProjectByName(body.project) ?? memory.getProject(body.project);
        if (!project) { sendJson(res, 400, { error: `No registered project named "${body.project}".`, code: 'unknown_project' }); return; }
        projectId = project.projectId;
      }

      const created = tasks.create({ title: body.title, goal: body.goal, projectId, mode: body.mode === 'write' ? 'write' : 'readonly', operationId: body.operationId ?? null });
      if (!created.ok) { sendJson(res, 400, created); return; }
      const dispatched = dispatcher.dispatch(principal, { taskId: created.task.taskId });
      sendJson(res, 201, { ok: true, task: dispatched.task ?? created.task });
    },

    async listTasks(req, res) {
      const principal = await withPrincipal(req, res); if (!principal) return;
      const { query } = parseUrl(req);
      const tasks = taskStore.forWorkspace(principal.workspaceId, principal.userId);
      sendJson(res, 200, { tasks: query.active === 'true' ? tasks.listActive() : tasks.list({ status: query.status, limit: Number(query.limit) || 25 }) });
    },

    async getTask(req, res, params) {
      const principal = await withPrincipal(req, res); if (!principal) return;
      const task = taskStore.forWorkspace(principal.workspaceId, principal.userId).get(params.id);
      if (!task) { sendJson(res, 404, { error: 'Not found.', code: 'not_found' }); return; }
      sendJson(res, 200, { task });
    },

    async respondTask(req, res, params) {
      const principal = await withPrincipal(req, res); if (!principal) return;
      const body = await readJsonBody(req);
      const result = dispatcher.respond(principal, { taskId: params.id, response: body.response ?? null, approved: body.approved ?? null });
      sendJson(res, result.ok ? 200 : (result.reasonCode === 'not_found' ? 404 : 409), result);
    },

    async cancelTask(req, res, params) {
      const principal = await withPrincipal(req, res); if (!principal) return;
      const result = dispatcher.cancel(principal, { taskId: params.id });
      sendJson(res, result.ok ? 200 : (result.reasonCode === 'not_found' ? 404 : 409), result);
    },

    // ── projects + engineering memory (dev/admin surface) ─────────────────
    async createProject(req, res) {
      const principal = await withPrincipal(req, res); if (!principal) return;
      const body = await readJsonBody(req);
      const result = engineeringMemory.forWorkspace(principal.workspaceId, principal.userId)
        .createProject({ name: body.name, rootPath: body.rootPath, defaultTestCmd: body.defaultTestCmd ?? null });
      sendJson(res, result.ok ? 201 : 400, result);
    },

    async listProjects(req, res) {
      const principal = await withPrincipal(req, res); if (!principal) return;
      sendJson(res, 200, { projects: engineeringMemory.forWorkspace(principal.workspaceId, principal.userId).listProjects() });
    },

    async createEngMemory(req, res) {
      const principal = await withPrincipal(req, res); if (!principal) return;
      const body = await readJsonBody(req);
      const result = engineeringMemory.forWorkspace(principal.workspaceId, principal.userId)
        .remember({ projectId: body.projectId ?? null, kind: body.kind, title: body.title, body: body.body, tags: body.tags ?? [] });
      sendJson(res, result.ok ? 201 : 400, result);
    },

    async listEngMemory(req, res) {
      const principal = await withPrincipal(req, res); if (!principal) return;
      const { query } = parseUrl(req);
      const memory = engineeringMemory.forWorkspace(principal.workspaceId, principal.userId);
      sendJson(res, 200, { memories: memory.list({ projectId: query.projectId ?? null, kind: query.kind ?? null, limit: Number(query.limit) || 50 }), counts: memory.counts() });
    },
  };
}

const ROUTES = [
  ['GET', '/api/agent-tasks/health', 'health'],
  ['POST', '/api/agent-tasks', 'createTask'],
  ['GET', '/api/agent-tasks', 'listTasks'],
  ['GET', '/api/agent-tasks/:id', 'getTask'],
  ['POST', '/api/agent-tasks/:id/respond', 'respondTask'],
  ['DELETE', '/api/agent-tasks/:id', 'cancelTask'],
  ['POST', '/api/agent-projects', 'createProject'],
  ['GET', '/api/agent-projects', 'listProjects'],
  ['POST', '/api/agent-memory', 'createEngMemory'],
  ['GET', '/api/agent-memory', 'listEngMemory'],
];

export function attachAgentTaskApi(middlewares, handlers) {
  middlewares.use(async (req, res, next) => {
    if (!req.url.startsWith('/api/agent-tasks') && !req.url.startsWith('/api/agent-projects') && !req.url.startsWith('/api/agent-memory')) { next(); return; }
    const { pathname } = parseUrl(req);
    for (const [method, pattern, handlerName] of ROUTES) {
      if (req.method !== method) continue;
      const params = matchPath(pattern, pathname);
      if (!params) continue;
      try {
        await handlers[handlerName](req, res, params);
      } catch (error) {
        sendJson(res, 500, { error: error?.message ?? 'Internal error.', code: 'server_error' });
      }
      return;
    }
    sendJson(res, 404, { error: 'No such agent-task route.', code: 'not_found' });
  });
}
