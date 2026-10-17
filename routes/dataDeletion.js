import { DATA_DELETION_HTML } from '../views/dataDeletionPage.js'

const HEADERS = {
  'content-type': 'text/html; charset=utf-8',
  'cache-control': 'public, max-age=3600',
  'x-content-type-options': 'nosniff',
  'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; frame-ancestors 'none'"
}

// Public page linked from the Play Console data safety form.
export async function dataDeletionRoutes(app) {
  app.get('/delete-data', { logLevel: 'warn' }, async (request, reply) => {
    return reply.headers(HEADERS).send(DATA_DELETION_HTML)
  })
}
