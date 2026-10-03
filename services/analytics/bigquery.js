import { existsSync, readFileSync } from 'fs'
import { GoogleAuth } from 'google-auth-library'
import { getEnv } from '../../config.js'

// Reads the GA4 BigQuery export row by row with tabledata.list. That needs
// only the BigQuery Data Viewer role, not permission to run query jobs.
const KEY_FILE = './ga_serviceaccount.json'
const COLUMNS = ['event_name', 'event_params', 'user_pseudo_id', 'geo', 'app_info']
const PAGE_SIZE = 5000
const RETRIES = 3

let clientPromise = null
let layoutPromise = null

export function bigQueryConfigured() {
  return existsSync(KEY_FILE) && Boolean(getEnv('GA_BQ_PROJECT') && getEnv('GA_BQ_DATASET'))
}

function tablesUrl(suffix = '') {
  return `https://bigquery.googleapis.com/bigquery/v2/projects/${getEnv('GA_BQ_PROJECT')}/datasets/${getEnv('GA_BQ_DATASET')}/tables${suffix}`
}

function getClient() {
  clientPromise ??= new GoogleAuth({
    credentials: JSON.parse(readFileSync(KEY_FILE, 'utf8')),
    scopes: ['https://www.googleapis.com/auth/bigquery.readonly']
  }).getClient()
  return clientPromise
}

const wait = ms => new Promise(resolve => setTimeout(resolve, ms))

async function request(url) {
  const client = await getClient()
  let lastError
  for (let attempt = 0; attempt < RETRIES; attempt++) {
    try {
      return (await client.request({ url, timeout: 60_000 })).data
    } catch (err) {
      lastError = err
      const status = err.response?.status
      if (status && status < 500 && status !== 429) break
      await wait(1000 * 2 ** attempt)
    }
  }
  const error = new Error(`bigquery_${lastError.response?.status ?? 'network'}`)
  error.status = lastError.response?.status
  throw error
}

// Dates ('YYYYMMDD') that have a finished events_ table, oldest first.
export async function listEventDays() {
  const days = []
  let pageToken = ''
  do {
    const data = await request(tablesUrl(`?maxResults=1000${pageToken ? `&pageToken=${pageToken}` : ''}`))
    for (const t of data.tables ?? []) {
      const match = /^events_(\d{8})$/.exec(t.tableReference.tableId)
      if (match) days.push(match[1])
    }
    pageToken = data.nextPageToken
  } while (pageToken)
  return days.sort()
}

// BigQuery returns selected columns in schema order, so the position of each
// column (and of the geo and app_info sub-fields) is read from the schema.
async function readLayout(day) {
  const schema = (await request(tablesUrl(`/events_${day}`))).schema.fields
  const sub = (column, field) => schema.find(f => f.name === column)?.fields?.findIndex(f => f.name === field) ?? -1
  return {
    names: schema.map(f => f.name),
    countryIdx: sub('geo', 'country'),
    versionIdx: sub('app_info', 'version')
  }
}

function layout(day) {
  layoutPromise ??= readLayout(day).catch(err => {
    layoutPromise = null
    throw err
  })
  return layoutPromise
}

// Event parameters arrive as a repeated record: [key, [string, int, float, double]].
export function parseParams(cell) {
  const params = {}
  for (const entry of cell ?? []) {
    const [key, value] = entry.v.f
    const [str, int, float, double] = value.v?.f ?? []
    params[key.v] = str?.v ?? int?.v ?? float?.v ?? double?.v ?? null
  }
  return params
}

export function toEvent(cells, { order, countryIdx, versionIdx }) {
  const byColumn = {}
  order.forEach((name, i) => { byColumn[name] = cells[i]?.v })
  const country = countryIdx >= 0 ? byColumn.geo?.f?.[countryIdx]?.v : null
  const version = versionIdx >= 0 ? byColumn.app_info?.f?.[versionIdx]?.v : null
  return {
    name: byColumn.event_name,
    uid: byColumn.user_pseudo_id,
    params: parseParams(byColumn.event_params),
    country: country || null,
    version: version || null
  }
}

export const AUDIENCE_COLUMNS = ['user_pseudo_id', 'geo']

// Yields parsed events for one day, one page at a time. A narrower `columns`
// list makes the read much lighter (event_params is the bulk of each row).
export async function* streamDay(day, { columns = COLUMNS } = {}) {
  const { names, countryIdx, versionIdx } = await layout(day)
  const cols = { order: names.filter(name => columns.includes(name)), countryIdx, versionIdx }
  let pageToken = ''
  do {
    const query = `maxResults=${PAGE_SIZE}&selectedFields=${columns.join(',')}${pageToken ? `&pageToken=${pageToken}` : ''}`
    const data = await request(tablesUrl(`/events_${day}/data?${query}`))
    for (const row of data.rows ?? []) yield toEvent(row.f, cols)
    pageToken = data.pageToken
  } while (pageToken)
}
