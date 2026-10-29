import { timingSafeEqual } from 'node:crypto'
import express, { type ErrorRequestHandler, type RequestHandler } from 'express'
import { z } from 'zod/v4'
import { CUSTOM_API_ROUTES } from './contract.generated'

type Routes = typeof CUSTOM_API_ROUTES
type Output<K extends keyof Routes> = z.output<Routes[K]['response']>
type Input<K extends Exclude<keyof Routes, 'describe'>> = z.output<
  Routes[K]['request']
>

// Implement these methods against the customer's own business logic. Creation
// must own the atomic capacity check and durable account-scoped idempotency.
export interface CustomerBookingSystem {
  describe(): Promise<Output<'describe'>>
  serviceability(
    request: Input<'serviceability'>,
  ): Promise<Output<'serviceability'>>
  availability(request: Input<'availability'>): Promise<Output<'availability'>>
  createBookingAtomically(
    request: Input<'bookings'>,
  ): Promise<Output<'bookings'>>
  bookingStatus(
    request: Input<'bookingStatus'>,
  ): Promise<Output<'bookingStatus'>>
}

export class AdapterHttpError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
  ) {
    super(message)
  }
}

export const MAX_ADAPTER_BODY_BYTES = 128 * 1024
const MAX_ADAPTER_RESPONSE_BYTES = 1024 * 1024

export const createCustomerBookingAdapter = (params: {
  apiKey: string
  system: CustomerBookingSystem
  basePath?: string
}) => {
  if (!params.apiKey || Buffer.byteLength(params.apiKey) > 4096)
    throw new Error('Configure a nonempty API key of at most 4096 bytes')
  const basePath = params.basePath ?? ''
  if (basePath && !/^\/(?:[a-zA-Z0-9_-]+\/?)+$/.test(basePath))
    throw new Error('Use a plain absolute base path')
  const app = express()
  app.disable('x-powered-by')
  const router = express.Router()
  const expected = new TextEncoder().encode(params.apiKey)
  router.use((req, res, next) => {
    const header = req.headers.authorization ?? ''
    const actual = new TextEncoder().encode(
      header.slice(0, 7).toLowerCase() === 'bearer ' ? header.slice(7) : '',
    )
    if (
      actual.length !== expected.length ||
      !timingSafeEqual(actual, expected)
    ) {
      res.status(401).json({
        code: 'UNAUTHORIZED',
        message: 'Valid Bearer authentication is required.',
      })
      return
    }
    next()
  })
  router.use(express.json({ limit: MAX_ADAPTER_BODY_BYTES, strict: true }))

  const register = <I, O>(route: {
    method: 'GET' | 'POST'
    path: string
    request: z.ZodType<I>
    response: z.ZodType<O>
    handle: (input: I) => Promise<O>
  }) => {
    const handle: RequestHandler = (req, res, next) => {
      void (async () => {
        const parsed = route.request.safeParse(
          route.method === 'GET' ? undefined : req.body,
        )
        if (!parsed.success)
          throw new AdapterHttpError(
            400,
            'INVALID_REQUEST',
            'Request does not match the booking contract.',
          )
        const result = route.response.parse(await route.handle(parsed.data))
        const body = JSON.stringify(result)
        if (Buffer.byteLength(body) > MAX_ADAPTER_RESPONSE_BYTES)
          throw new Error('Adapter response exceeds the size limit')
        const pending =
          typeof result === 'object' &&
          result !== null &&
          'status' in result &&
          result.status === 'pending'
        res
          .status(pending ? 202 : 200)
          .type('json')
          .send(body)
      })().catch(next)
    }
    if (route.method === 'GET') router.get(route.path, handle)
    else router.post(route.path, handle)
  }
  register({
    ...CUSTOM_API_ROUTES.describe,
    request: z.undefined(),
    handle: () => params.system.describe(),
  })
  register({
    ...CUSTOM_API_ROUTES.serviceability,
    handle: (input) => params.system.serviceability(input),
  })
  register({
    ...CUSTOM_API_ROUTES.availability,
    handle: (input) => params.system.availability(input),
  })
  register({
    ...CUSTOM_API_ROUTES.bookings,
    handle: (input) => params.system.createBookingAtomically(input),
  })
  register({
    ...CUSTOM_API_ROUTES.bookingStatus,
    handle: (input) => params.system.bookingStatus(input),
  })
  app.use(basePath || '/', router)
  app.use((_req, res) => {
    res.status(404).json({ code: 'NOT_FOUND', message: 'Route was not found.' })
  })
  const onError: ErrorRequestHandler = (error: unknown, _req, res, _next) => {
    if (res.headersSent) return
    if (error instanceof AdapterHttpError) {
      res
        .status(error.status)
        .json({ code: error.code, message: error.message })
    } else if (
      typeof error === 'object' &&
      error !== null &&
      'type' in error &&
      error.type === 'entity.too.large'
    ) {
      res
        .status(413)
        .json({ code: 'BODY_TOO_LARGE', message: 'Request body is too large.' })
    } else if (error instanceof SyntaxError) {
      res.status(400).json({
        code: 'INVALID_JSON',
        message: 'Request body must be valid JSON.',
      })
    } else {
      // Never echo raw provider errors, payloads, tokens or exception stacks.
      res.status(500).json({
        code: 'ADAPTER_ERROR',
        message:
          'The operation could not be completed. Query booking status before retrying a create.',
      })
    }
  }
  app.use(onError)
  return app
}
