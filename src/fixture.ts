import { createHash, randomUUID } from 'node:crypto'
import { existsSync, statSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import { createRequire } from 'node:module'
import { z } from 'zod/v4'
import {
  AdapterHttpError,
  createCustomerBookingAdapter,
  type CustomerBookingSystem,
} from './adapter'
import {
  CUSTOM_API_ROUTES,
  CustomApiBookingRequestSchema,
  CustomApiBookingResultSchema,
  CustomApiSlotSchema,
  validateCustomApiIntakeAnswers,
  type CustomApiBookingRequest,
  type CustomApiBookingResult,
} from './contract.generated'
import { fixtureService, makeContractExamples } from './examples'

// Node 24's built-in SQLite is used only for synthetic fixture data. This narrow
// interface also supports repo installations whose Node type package predates it.
type SqlValue = string | number | null
interface FixtureDatabase {
  exec(sql: string): void
  prepare(sql: string): {
    get(...values: SqlValue[]): Record<string, unknown> | undefined
    all(...values: SqlValue[]): Record<string, unknown>[]
    run(...values: SqlValue[]): { changes: number }
  }
  close(): void
}
const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite') as {
  DatabaseSync: new (path: string) => FixtureDatabase
}
export const FIXTURE_API_KEY = 'synthetic-fixture-only-key'
export const FIXTURE_BASE_PATH = '/sandbox/leadtruffle'
const FIXTURE_FORMAT = 'leadtruffle-synthetic-booking-fixture-v1'

const canonical = (value: unknown): string => {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`
  if (value !== null && typeof value === 'object')
    return `{${Object.entries(value)
      .filter(([, item]) => item !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`)
      .join(',')}}`
  return JSON.stringify(value)
}
const fingerprint = (value: unknown) =>
  createHash('sha256').update(canonical(value)).digest('hex')
type Context = z.output<typeof CUSTOM_API_ROUTES.serviceability.request>
const schedulingFingerprint = (context: Context) =>
  fingerprint({
    serviceId: context.serviceId,
    address: context.address,
    answers: Object.fromEntries(
      fixtureService.fields
        .filter((field) => field.affectsScheduling)
        .map((field) => [field.key, context.answers[field.key]]),
    ),
  })
const routeReference = (context: Context) =>
  `route-${schedulingFingerprint(context)}`
const assertContext = (context: Context, stage: 'availability' | 'booking') => {
  if (
    context.serviceId !== fixtureService.id ||
    !validateCustomApiIntakeAnswers({
      service: fixtureService,
      answers: context.answers,
      stage,
    }).success
  ) {
    throw new AdapterHttpError(
      400,
      'INVALID_INTAKE',
      'Choose a known service and supply its required typed answers.',
    )
  }
}

export class SyntheticBookingSystem implements CustomerBookingSystem {
  private readonly db: FixtureDatabase
  private readonly now: () => Date
  constructor(params: {
    databasePath: string
    now?: () => Date
    pending?: boolean
  }) {
    const existing =
      existsSync(params.databasePath) && statSync(params.databasePath).size > 0
    this.db = new DatabaseSync(params.databasePath)
    this.now = params.now ?? (() => new Date())
    if (existing) {
      try {
        const marker = this.db
          .prepare(
            "SELECT name FROM sqlite_master WHERE type='table' AND name='fixture_metadata'",
          )
          .get()
        if (
          !marker ||
          this.db.prepare('SELECT format FROM fixture_metadata').get()
            ?.format !== FIXTURE_FORMAT
        )
          throw new Error('Not a synthetic booking fixture database')
      } catch (error) {
        this.db.close()
        throw error
      }
    }
    this.db.exec(`PRAGMA journal_mode=WAL;
      CREATE TABLE IF NOT EXISTS fixture_metadata (format TEXT PRIMARY KEY);
      CREATE TABLE IF NOT EXISTS fixture_capacity (id TEXT PRIMARY KEY, slot_json TEXT NOT NULL, remaining INTEGER NOT NULL CHECK (remaining >= 0));
      CREATE TABLE IF NOT EXISTS fixture_offer (reference TEXT PRIMARY KEY, context_fingerprint TEXT NOT NULL, slot_json TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS fixture_operation (operation_key TEXT PRIMARY KEY, fingerprint TEXT NOT NULL, request_json TEXT NOT NULL, result_json TEXT NOT NULL, booking_id TEXT UNIQUE);
    `)
    this.db
      .prepare('INSERT OR IGNORE INTO fixture_metadata VALUES (?)')
      .run(FIXTURE_FORMAT)
    const start = new Date(this.now().getTime() + 24 * 60 * 60 * 1000)
    const nativeSlot = {
      slotReference: 'native-fixture-slot',
      expiresAt: new Date(this.now().getTime() + 60 * 60 * 1000).toISOString(),
      arrivalWindow: {
        arrivalWindowStart: start.toISOString(),
        arrivalWindowEnd: new Date(
          start.getTime() + 2 * 60 * 60 * 1000,
        ).toISOString(),
        timezone: 'UTC',
      },
    }
    this.db
      .prepare('INSERT OR IGNORE INTO fixture_capacity VALUES (?, ?, 1)')
      .run('only-slot', JSON.stringify(nativeSlot))
    this.pending = params.pending ?? false
  }
  private readonly pending: boolean
  close() {
    this.db.close()
  }
  operationCount() {
    return Number(
      this.db.prepare('SELECT count(*) AS count FROM fixture_operation').get()
        ?.count,
    )
  }
  async describe() {
    return { ...makeContractExamples().describe.response, timezone: 'UTC' }
  }
  async serviceability(
    request: Context,
  ): ReturnType<CustomerBookingSystem['serviceability']> {
    assertContext(request, 'availability')
    if (request.address.postalCode === '00000')
      return { covered: false, reason: 'Synthetic out-of-area address.' }
    return {
      covered: true,
      normalizedAddress: request.address,
      routingReference: routeReference(request),
    }
  }
  async availability(
    request: z.output<typeof CUSTOM_API_ROUTES.availability.request>,
  ): ReturnType<CustomerBookingSystem['availability']> {
    assertContext(request, 'availability')
    if (
      request.routingReference &&
      request.routingReference !== routeReference(request)
    )
      throw new AdapterHttpError(
        400,
        'INVALID_ROUTING_REFERENCE',
        'Request serviceability again after changing the visit details.',
      )
    const row = this.db
      .prepare('SELECT slot_json, remaining FROM fixture_capacity WHERE id = ?')
      .get('only-slot')!
    const slot = CustomApiSlotSchema.parse(JSON.parse(String(row.slot_json)))
    if (
      request.address.postalCode === '00000' ||
      Number(row.remaining) === 0 ||
      Date.parse(slot.expiresAt) <= this.now().getTime() ||
      Date.parse(slot.arrivalWindow.arrivalWindowStart) <
        Date.parse(request.dateRange.from) ||
      Date.parse(slot.arrivalWindow.arrivalWindowEnd) >
        Date.parse(request.dateRange.to)
    )
      return { slots: [] }
    const contextFingerprint = schedulingFingerprint(request)
    const offered = {
      ...slot,
      slotReference: `offer-${fingerprint({ contextFingerprint, slot })}`,
    }
    this.db
      .prepare('INSERT OR IGNORE INTO fixture_offer VALUES (?, ?, ?)')
      .run(offered.slotReference, contextFingerprint, JSON.stringify(offered))
    return { slots: [offered] }
  }
  async createBookingAtomically(
    input: CustomApiBookingRequest,
  ): Promise<CustomApiBookingResult> {
    const request = CustomApiBookingRequestSchema.parse(input)
    const requestFingerprint = fingerprint(request)
    this.db.exec('BEGIN IMMEDIATE')
    try {
      // Idempotency lookup precedes every live business/expiry/capacity check.
      const existing = this.db
        .prepare(
          'SELECT fingerprint, result_json FROM fixture_operation WHERE operation_key = ?',
        )
        .get(request.idempotencyKey)
      if (existing) {
        if (existing.fingerprint !== requestFingerprint)
          throw new AdapterHttpError(
            409,
            'IDEMPOTENCY_CONFLICT',
            'This key is already bound to a different booking request.',
          )
        const result = CustomApiBookingResultSchema.parse(
          JSON.parse(String(existing.result_json)),
        )
        this.db.exec('COMMIT')
        return result
      }
      assertContext(request, 'booking')
      const offer = this.db
        .prepare(
          'SELECT context_fingerprint, slot_json FROM fixture_offer WHERE reference = ?',
        )
        .get(request.slot.slotReference)
      let rejection: string | null = null
      if (
        !offer ||
        offer.context_fingerprint !== schedulingFingerprint(request) ||
        canonical(JSON.parse(String(offer.slot_json))) !==
          canonical(request.slot)
      )
        rejection = 'STALE_SLOT'
      else if (
        request.routingReference &&
        request.routingReference !== routeReference(request)
      )
        rejection = 'STALE_ROUTING'
      else if (request.address.postalCode === '00000') rejection = 'OUT_OF_AREA'
      else if (Date.parse(request.slot.expiresAt) <= this.now().getTime())
        rejection = 'SLOT_EXPIRED'
      let bookingId: string | null = null
      if (!rejection) {
        const reserved = this.db
          .prepare(
            'UPDATE fixture_capacity SET remaining = remaining - 1 WHERE id = ? AND remaining > 0',
          )
          .run('only-slot')
        if (reserved.changes === 0) rejection = 'SLOT_UNAVAILABLE'
        else bookingId = `synthetic-${randomUUID()}`
      }
      const result: CustomApiBookingResult = rejection
        ? {
            status: 'rejected',
            code: rejection,
            message:
              'The synthetic visit could not be reserved. Request current availability.',
          }
        : this.pending
          ? { status: 'pending', operationReference: request.idempotencyKey }
          : {
              status: 'confirmed',
              bookingId: bookingId!,
              serviceId: request.serviceId,
              arrivalWindow: request.slot.arrivalWindow,
            }
      this.db
        .prepare('INSERT INTO fixture_operation VALUES (?, ?, ?, ?, ?)')
        .run(
          request.idempotencyKey,
          requestFingerprint,
          JSON.stringify(request),
          JSON.stringify(result),
          bookingId,
        )
      this.db.exec('COMMIT')
      return result
    } catch (error) {
      this.db.exec('ROLLBACK')
      throw error
    }
  }
  async bookingStatus(
    request: z.output<typeof CUSTOM_API_ROUTES.bookingStatus.request>,
  ): Promise<CustomApiBookingResult> {
    const row =
      'idempotencyKey' in request
        ? this.db
            .prepare(
              'SELECT result_json FROM fixture_operation WHERE operation_key = ?',
            )
            .get(request.idempotencyKey)
        : this.db
            .prepare(
              'SELECT result_json FROM fixture_operation WHERE booking_id = ?',
            )
            .get(request.bookingId)
    if (!row)
      throw new AdapterHttpError(
        404,
        'OPERATION_NOT_FOUND',
        'No authoritative result is visible. This does not prove that a booking was not created.',
      )
    return CustomApiBookingResultSchema.parse(
      JSON.parse(String(row.result_json)),
    )
  }
  completePending(idempotencyKey: string) {
    const row = this.db
      .prepare(
        'SELECT request_json, result_json, booking_id FROM fixture_operation WHERE operation_key = ?',
      )
      .get(idempotencyKey)
    if (!row) throw new Error('Synthetic operation was not found')
    const prior = CustomApiBookingResultSchema.parse(
      JSON.parse(String(row.result_json)),
    )
    if (prior.status !== 'pending') return
    const request = CustomApiBookingRequestSchema.parse(
      JSON.parse(String(row.request_json)),
    )
    const result: CustomApiBookingResult = {
      status: 'confirmed',
      bookingId: z.string().min(1).parse(row.booking_id),
      serviceId: request.serviceId,
      arrivalWindow: request.slot.arrivalWindow,
    }
    this.db
      .prepare(
        'UPDATE fixture_operation SET result_json = ? WHERE operation_key = ?',
      )
      .run(JSON.stringify(result), idempotencyKey)
  }
}

export const startFixtureServer = async (params: {
  databasePath: string
  now?: () => Date
  pending?: boolean
  port?: number
  apiKey?: string
}) => {
  const system = new SyntheticBookingSystem(params)
  const app = createCustomerBookingAdapter({
    apiKey: params.apiKey ?? FIXTURE_API_KEY,
    system,
    basePath: FIXTURE_BASE_PATH,
  })
  let dropNext = false
  let delayNext = 0
  const server = createServer((req, res) => {
    if (
      dropNext &&
      req.method === 'POST' &&
      req.url === `${FIXTURE_BASE_PATH}/v1/bookings`
    ) {
      dropNext = false
      // Destroy only after the handler commits and tries to send its response.
      res.end = () => {
        res.destroy()
        return res
      }
    } else if (
      delayNext > 0 &&
      req.method === 'POST' &&
      req.url === `${FIXTURE_BASE_PATH}/v1/bookings`
    ) {
      const delay = delayNext
      delayNext = 0
      const end = res.end.bind(res)
      res.end = ((...args: unknown[]) => {
        const timer = setTimeout(() => Reflect.apply(end, res, args), delay)
        res.once('close', () => clearTimeout(timer))
        return res
      }) as typeof res.end
    }
    app(req, res)
  })
  server.requestTimeout = 5000
  server.headersTimeout = 5000
  try {
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject)
      server.listen(params.port ?? 0, '127.0.0.1', resolve)
    })
  } catch (error) {
    system.close()
    throw error
  }
  const address = server.address()
  if (!address || typeof address === 'string')
    throw new Error('Synthetic server did not bind a TCP port')
  return {
    system,
    server,
    baseUrl: `http://127.0.0.1:${address.port}${FIXTURE_BASE_PATH}`,
    dropNextCreateResponse: () => {
      dropNext = true
    },
    delayNextCreateResponse: (milliseconds: number) => {
      delayNext = milliseconds
    },
    close: async () => {
      await closeServer(server)
      system.close()
    },
  }
}
export const closeServer = (server: Server) =>
  new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()))
    server.closeAllConnections()
  })
