import { defineConfig } from 'vite';
import { groqApiPlugin } from './server/groqApi.js';
import { dataApiPlugin } from './server/dataApiPlugin.mjs';

// The groqApiPlugin serves /api/* inside the dev/preview server process — that
// is where GROQ_API_KEY lives. Client code never references it (enforced by
// test/security.test.js), so Vite never inlines it into the bundle.
//
// dataApiPlugin serves the authenticated /api/data, /api/session,
// /api/consent, /api/migration, /api/retention, /api/audit, /api/admin
// routes from the SAME process — the SQLite database file and its
// connection never leave the server (see SERVER-DATA.md "Architecture").
export default defineConfig({
  plugins: [groqApiPlugin(), dataApiPlugin()],
});
