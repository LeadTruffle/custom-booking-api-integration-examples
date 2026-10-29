import { readFileSync, existsSync, writeFileSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import Ajv from 'ajv'
import axios from 'axios'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { z } from 'zod/v4'
import { createCustomerBookingAdapter, MAX_ADAPTER_BODY_BYTES } from './adapter'
import { createAdapterClient } from './client'
import { CUSTOM_API_ROUTES } from './contract.generated'
import { fixtureContext, makeContractExamples } from './examples'
import {
  closeServer,
  FIXTURE_API_KEY,
  startFixtureServer,
  SyntheticBookingSystem,
} from './fixture'
import { buildArtifacts, toJsonSchema } from './openapi'
import { makeSyntheticBooking, runFixtureContractValidation } from './scenarios'
import { wireContractSource } from './wireContractSource'

const cleanups: Array<() => Promise<void>> = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})
const sandbox = async (pending = false) => {
  const directory = await mkdtemp(join(tmpdir(), 'lt-adapter-test-'))
  cleanups.push(() => rm(directory, { recursive: true, force: true }))
  const databasePath = join(directory, 'fixture.sqlite')
  const clock = { current: new Date('2026-10-29T12:00:00Z') }
  let fixture = await startFixtureServer({
    databasePath,
    now: () => clock.current,
    pending,
  })
  cleanups.push(() => fixture.close())
  return {
    get fixture() {
      return fixture
    },
    clock,
    directory,
    client: () =>
      createAdapterClient({
        baseUrl: fixture.baseUrl,
        apiKey: FIXTURE_API_KEY,
      }),
    restart: async () => {
      await fixture.close()
      fixture = await startFixtureServer({
        databasePath,
        now: () => clock.current,
        pending,
      })
    },
  }
}

describe('fixed booking contract developer kit', () => {
  it('rejects oversized collections before validating their elements', () => {
    const result = CUSTOM_API_ROUTES.availability.response.safeParse({
      slots: Array.from({ length: 10000 }, () => ({})),
    })
    expect(result.success).toBe(false)
    if (result.success) throw new Error('Oversized slots must be rejected')
    expect(result.error.issues).toHaveLength(1)
    expect(result.error.issues[0]).toMatchObject({
      code: 'too_big',
      path: ['slots'],
    })
  })

  it('preserves semantic wire constraints in the standalone parser', () => {
    const examples = makeContractExamples()
    const describe = examples.describe.response
    expect(
      CUSTOM_API_ROUTES.describe.response.safeParse({
        ...describe,
        services: [describe.services[0], describe.services[0]],
      }).success,
    ).toBe(false)
    expect(
      CUSTOM_API_ROUTES.describe.response.safeParse({
        ...describe,
        timezone: 'Not/A_Timezone',
      }).success,
    ).toBe(false)
    const slot = examples.bookings.request.slot
    expect(
      CUSTOM_API_ROUTES.availability.response.safeParse({ slots: [slot, slot] })
        .success,
    ).toBe(false)
    expect(
      CUSTOM_API_ROUTES.bookings.request.safeParse({
        ...examples.bookings.request,
        slot: {
          ...slot,
          arrivalWindow: {
            ...slot.arrivalWindow,
            arrivalWindowEnd: slot.arrivalWindow.arrivalWindowStart,
          },
        },
      }).success,
    ).toBe(false)
  })

  it('passes all eight actual HTTP contract scenarios against fresh local fixtures', async () => {
    expect(await runFixtureContractValidation()).toHaveLength(8)
  })

  it('recovers a lost create response after reopening the database, even after the offered slot expires', async () => {
    const box = await sandbox()
    const request = await makeSyntheticBooking(box.client(), box.clock.current)
    box.fixture.dropNextCreateResponse()
    await expect(box.client().book(request)).rejects.toThrow()
    await box.restart()
    box.clock.current = new Date(box.clock.current.getTime() + 2 * 86_400_000)
    const original = await box
      .client()
      .status({ idempotencyKey: request.idempotencyKey })
    expect(original.status).toBe('confirmed')
    expect(await box.client().book(request)).toEqual(original)
    expect(box.fixture.system.operationCount()).toBe(1)
  })

  it('retains pending operations through restart and makes completion visible on the original key', async () => {
    const box = await sandbox(true)
    const request = await makeSyntheticBooking(box.client(), box.clock.current)
    expect((await box.client().book(request)).status).toBe('pending')
    await box.restart()
    expect(
      (await box.client().status({ idempotencyKey: request.idempotencyKey }))
        .status,
    ).toBe('pending')
    expect((await box.client().book(request)).status).toBe('pending')
    box.fixture.system.completePending(request.idempotencyKey)
    const result = await box
      .client()
      .status({ idempotencyKey: request.idempotencyKey })
    expect(result.status).toBe('confirmed')
    expect(await box.client().book(request)).toEqual(result)
    expect(box.fixture.system.operationCount()).toBe(1)
  })

  it.each(['address', 'answers', 'window', 'reference'])(
    'rejects a stale offered %s without consuming capacity',
    async (field) => {
      const box = await sandbox()
      const request = await makeSyntheticBooking(
        box.client(),
        box.clock.current,
      )
      const changed = structuredClone(request)
      if (field === 'address') changed.address.line1 = '200 Example Street'
      if (field === 'answers') changed.answers.propertyType = 'condo'
      if (field === 'window')
        changed.slot.arrivalWindow.arrivalWindowEnd = new Date(
          Date.parse(changed.slot.arrivalWindow.arrivalWindowEnd) + 60_000,
        ).toISOString()
      if (field === 'reference')
        changed.slot.slotReference = 'invented-reference'
      expect(await box.client().book(changed)).toMatchObject({
        status: 'rejected',
        code: 'STALE_SLOT',
      })
      expect(
        (
          await box.client().book({
            ...request,
            idempotencyKey: 'corrected-synthetic-operation',
          })
        ).status,
      ).toBe('confirmed')
    },
  )

  it('stores a stable rejection for a newly expired slot', async () => {
    const box = await sandbox()
    const request = await makeSyntheticBooking(box.client(), box.clock.current)
    box.clock.current = new Date(box.clock.current.getTime() + 2 * 3_600_000)
    const rejection = await box.client().book(request)
    expect(rejection).toMatchObject({
      status: 'rejected',
      code: 'SLOT_EXPIRED',
    })
    expect(await box.client().book(request)).toEqual(rejection)
    expect(
      await box.client().status({ idempotencyKey: request.idempotencyKey }),
    ).toEqual(rejection)
  })

  it('requires authentication on all five routes and preserves a supplied base path', async () => {
    const box = await sandbox()
    for (const route of Object.values(CUSTOM_API_ROUTES)) {
      const result = await axios.request({
        url: `${box.fixture.baseUrl}${route.path}`,
        method: route.method,
        data: {},
        proxy: false,
        validateStatus: () => true,
      })
      expect(result.status).toBe(401)
      expect(JSON.stringify(result.data)).not.toContain(FIXTURE_API_KEY)
    }
    const wrongRoot = new URL(box.fixture.baseUrl).origin
    expect(
      (
        await axios.get(`${wrongRoot}/v1/describe`, {
          proxy: false,
          validateStatus: () => true,
        })
      ).status,
    ).toBe(404)
    expect((await box.client().describe()).accountId).toBe('synthetic-fixture')
    const lowercase = await axios.get(`${box.fixture.baseUrl}/v1/describe`, {
      headers: { Authorization: `bearer ${FIXTURE_API_KEY}` },
      proxy: false,
    })
    expect(lowercase.status).toBe(200)
  })

  it('returns bounded JSON errors for malformed and oversized bodies', async () => {
    const box = await sandbox()
    const options = {
      headers: {
        Authorization: `Bearer ${FIXTURE_API_KEY}`,
        'Content-Type': 'application/json',
      },
      proxy: false as const,
      validateStatus: () => true,
    }
    const invalid = await axios.post(
      `${box.fixture.baseUrl}/v1/bookings`,
      '{bad',
      options,
    )
    expect(invalid.status).toBe(400)
    expect(invalid.data).toEqual({
      code: 'INVALID_JSON',
      message: 'Request body must be valid JSON.',
    })
    const oversized = await axios.post(
      `${box.fixture.baseUrl}/v1/bookings`,
      JSON.stringify({ text: 'x'.repeat(MAX_ADAPTER_BODY_BYTES) }),
      options,
    )
    expect(oversized.status).toBe(413)
    expect(oversized.data.code).toBe('BODY_TOO_LARGE')
    expect(box.fixture.system.operationCount()).toBe(0)
  })

  it('does not expose malformed handler results or raw provider errors', async () => {
    const box = await sandbox()
    const system = box.fixture.system
    const app = createCustomerBookingAdapter({
      apiKey: FIXTURE_API_KEY,
      system,
    })
    const server = createServer(app)
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    cleanups.push(() => closeServer(server))
    const address = server.address()
    if (!address || typeof address === 'string')
      throw new Error('Expected TCP test server')
    const url = `http://127.0.0.1:${address.port}/v1/describe`
    const options = {
      headers: { Authorization: `Bearer ${FIXTURE_API_KEY}` },
      proxy: false as const,
      validateStatus: () => true,
    }
    const valid = await system.describe()
    const mock = vi.spyOn(system, 'describe')
    mock.mockResolvedValueOnce({
      ...valid,
      services: null as unknown as typeof valid.services,
    })
    const malformed = await axios.get(url, options)
    expect(malformed.status).toBe(500)
    mock.mockRejectedValueOnce(
      new Error(`raw-provider-secret:${FIXTURE_API_KEY}`),
    )
    const failed = await axios.get(url, options)
    expect(failed.status).toBe(500)
    expect(JSON.stringify(failed.data)).not.toContain(FIXTURE_API_KEY)
    mock.mockRestore()
  })

  it('validates routing references and stage-specific intake fields', async () => {
    const box = await sandbox()
    await expect(
      box.client().availability({
        ...fixtureContext,
        routingReference: 'stale',
        dateRange: {
          from: box.clock.current.toISOString(),
          to: '2026-10-31T12:00:00Z',
        },
      }),
    ).rejects.toThrow('INVALID_ROUTING_REFERENCE')
    await expect(
      box.client().serviceability({
        ...fixtureContext,
        answers: { propertyType: 'not-a-choice' },
      }),
    ).rejects.toThrow('INVALID_INTAKE')
    expect(box.fixture.system.operationCount()).toBe(0)
  })

  it('does not overwrite an unrelated existing file supplied as its database', async () => {
    const box = await sandbox()
    const path = join(box.directory, 'not-a-fixture.sqlite')
    writeFileSync(path, 'unrelated existing data')
    expect(() => new SyntheticBookingSystem({ databasePath: path })).toThrow()
    expect(readFileSync(path, 'utf8')).toBe('unrelated existing data')
    expect(box.fixture.system.operationCount()).toBe(0)
  })

  it('keeps generated artifacts current and validates every example against emitted JSON schemas', () => {
    const canonical = new URL(
      '../../../libs/v3sharedtypes/src/customApiBooking.ts',
      import.meta.url,
    )
    if (existsSync(canonical)) {
      expect(
        readFileSync(
          new URL('./contract.generated.ts', import.meta.url),
          'utf8',
        ),
      ).toBe(wireContractSource(readFileSync(canonical, 'utf8')))
    }
    const artifacts = buildArtifacts()
    for (const [name, expected] of Object.entries(artifacts))
      expect(readFileSync(new URL(`../${name}`, import.meta.url), 'utf8')).toBe(
        expected,
      )
    const examples = JSON.parse(artifacts['examples.json']) as Record<
      string,
      { request?: unknown; response: unknown }
    >
    const ajv = new Ajv({ allErrors: true, unknownFormats: 'ignore' })
    for (const [name, route] of Object.entries(CUSTOM_API_ROUTES)) {
      expect(
        ajv.validate(toJsonSchema(route.response), examples[name].response),
        JSON.stringify(ajv.errors),
      ).toBe(true)
      if ('request' in route)
        expect(
          ajv.validate(toJsonSchema(route.request), examples[name].request),
          JSON.stringify(ajv.errors),
        ).toBe(true)
    }
    expect(
      ajv.validate(toJsonSchema(CUSTOM_API_ROUTES.bookings.request), {
        ...(examples.bookings.request as object),
        extra: 'unknown',
      }),
    ).toBe(false)
    expect(
      ajv.validate(toJsonSchema(CUSTOM_API_ROUTES.bookingStatus.request), {}),
    ).toBe(false)
    expect(() => toJsonSchema(z.date())).toThrow()
    expect(
      ajv.validate(
        toJsonSchema(z.string().startsWith('prefix')),
        'prefix-value',
      ),
    ).toBe(true)
    expect(
      ajv.validate(
        toJsonSchema(z.string().startsWith('prefix')),
        'other-value',
      ),
    ).toBe(false)
  })
})
