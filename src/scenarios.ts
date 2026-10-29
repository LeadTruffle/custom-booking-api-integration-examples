import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import axios from 'axios'
import { createAdapterClient } from './client'
import { FIXTURE_API_KEY, startFixtureServer } from './fixture'
import { fixtureContext, makeContractExamples } from './examples'
import type { CustomApiBookingRequest } from './contract.generated'

export const makeSyntheticBooking = async (
  client: ReturnType<typeof createAdapterClient>,
  now: Date,
): Promise<CustomApiBookingRequest> => {
  const coverage = await client.serviceability(fixtureContext)
  assert.equal(coverage.covered, true)
  if (!coverage.covered)
    throw new Error('Fixture must cover its synthetic address')
  const availability = await client.availability({
    ...fixtureContext,
    routingReference: coverage.routingReference,
    dateRange: {
      from: now.toISOString(),
      to: new Date(now.getTime() + 3 * 86_400_000).toISOString(),
    },
  })
  assert.equal(availability.slots.length, 1)
  return {
    ...makeContractExamples().bookings.request,
    routingReference: coverage.routingReference,
    slot: availability.slots[0],
  }
}

// Full write scenarios have no external target option. They can create only
// synthetic records in a newly created local fixture database.
export const runFixtureContractValidation = async () => {
  const reports: string[] = []
  const directory = await mkdtemp(join(tmpdir(), 'lt-booking-contract-'))
  let number = 0
  const scenario = async (
    name: string,
    run: (
      fixture: Awaited<ReturnType<typeof startFixtureServer>>,
      client: ReturnType<typeof createAdapterClient>,
      now: Date,
    ) => Promise<void>,
    pending = false,
  ) => {
    const now = new Date('2026-10-29T12:00:00Z')
    const fixture = await startFixtureServer({
      databasePath: join(directory, `${number++}.sqlite`),
      now: () => now,
      pending,
    })
    try {
      await run(
        fixture,
        createAdapterClient({
          baseUrl: fixture.baseUrl,
          apiKey: FIXTURE_API_KEY,
        }),
        now,
      )
      reports.push(name)
    } finally {
      await fixture.close()
    }
  }
  try {
    await scenario(
      'happy path, arrival window and status lookup',
      async (_fixture, client, now) => {
        const description = await client.describe()
        assert.equal(description.accountId, 'synthetic-fixture')
        const request = await makeSyntheticBooking(client, now)
        const result = await client.book(request)
        assert.equal(result.status, 'confirmed')
        if (result.status !== 'confirmed')
          throw new Error('Expected a confirmed synthetic booking')
        assert.deepEqual(result.arrivalWindow, request.slot.arrivalWindow)
        assert.deepEqual(
          await client.status({ bookingId: result.bookingId }),
          result,
        )
      },
    )
    await scenario(
      'request validation and authentication',
      async (fixture, _client, now) => {
        const invalid = await axios.post(
          `${fixture.baseUrl}/v1/bookings`,
          {},
          {
            headers: { Authorization: `Bearer ${FIXTURE_API_KEY}` },
            proxy: false,
            validateStatus: () => true,
          },
        )
        assert.equal(invalid.status, 400)
        const unauthorized = createAdapterClient({
          baseUrl: fixture.baseUrl,
          apiKey: 'wrong',
        })
        await assert.rejects(unauthorized.describe(), /HTTP 401/)
        assert.equal(fixture.system.operationCount(), 0)
        const client = createAdapterClient({
          baseUrl: fixture.baseUrl,
          apiKey: FIXTURE_API_KEY,
        })
        const request = await makeSyntheticBooking(client, now)
        await assert.rejects(
          client.book({ ...request, answers: { propertyType: 'house' } }),
          /INVALID_INTAKE/,
        )
      },
    )
    await scenario(
      'concurrent duplicate key and changed-payload conflict',
      async (fixture, client, now) => {
        const request = await makeSyntheticBooking(client, now)
        const results = await Promise.all([
          client.book(request),
          client.book(request),
          client.book({
            ...request,
            answers: {
              accessNotes: 'Use the front door.',
              propertyType: 'house',
            },
          }),
        ])
        assert.deepEqual(results[0], results[1])
        assert.deepEqual(results[0], results[2])
        await assert.rejects(
          client.book({
            ...request,
            contact: { ...request.contact, name: 'Changed' },
          }),
          /HTTP 409: IDEMPOTENCY_CONFLICT/,
        )
        assert.equal(fixture.system.operationCount(), 1)
      },
    )
    await scenario(
      'atomic last-slot capacity across distinct keys',
      async (_fixture, client, now) => {
        const request = await makeSyntheticBooking(client, now)
        const results = await Promise.all([
          client.book(request),
          client.book({
            ...request,
            idempotencyKey: 'second-synthetic-operation',
          }),
        ])
        assert.equal(
          results.filter((result) => result.status === 'confirmed').length,
          1,
        )
        assert.equal(
          results.filter(
            (result) =>
              result.status === 'rejected' &&
              result.code === 'SLOT_UNAVAILABLE',
          ).length,
          1,
        )
        const availability = await client.availability({
          ...fixtureContext,
          dateRange: {
            from: now.toISOString(),
            to: new Date(now.getTime() + 3 * 86_400_000).toISOString(),
          },
        })
        assert.deepEqual(availability.slots, [])
      },
    )
    await scenario(
      'lost create response recovers the same booking',
      async (fixture, client, now) => {
        const request = await makeSyntheticBooking(client, now)
        fixture.dropNextCreateResponse()
        await assert.rejects(client.book(request))
        const recovered = await client.status({
          idempotencyKey: request.idempotencyKey,
        })
        assert.equal(recovered.status, 'confirmed')
        assert.deepEqual(await client.book(request), recovered)
        assert.equal(fixture.system.operationCount(), 1)
      },
    )
    await scenario(
      'pending operations are visible before completion',
      async (fixture, client, now) => {
        const request = await makeSyntheticBooking(client, now)
        assert.equal((await client.book(request)).status, 'pending')
        assert.equal(
          (await client.status({ idempotencyKey: request.idempotencyKey }))
            .status,
          'pending',
        )
        fixture.system.completePending(request.idempotencyKey)
        assert.equal(
          (await client.status({ idempotencyKey: request.idempotencyKey }))
            .status,
          'confirmed',
        )
      },
      true,
    )
    await scenario(
      'create timeout reconciles the original key',
      async (fixture, client, now) => {
        const request = await makeSyntheticBooking(client, now)
        fixture.delayNextCreateResponse(1000)
        const impatient = createAdapterClient({
          baseUrl: fixture.baseUrl,
          apiKey: FIXTURE_API_KEY,
          timeoutMs: 25,
        })
        await assert.rejects(
          impatient.book(request),
          /Adapter transport failed/,
        )
        const recovered = await client.status({
          idempotencyKey: request.idempotencyKey,
        })
        assert.equal(recovered.status, 'confirmed')
        assert.deepEqual(await client.book(request), recovered)
        assert.equal(fixture.system.operationCount(), 1)
      },
    )
    await scenario(
      'missing status is uncertain; out-of-area and no inventory are normal',
      async (_fixture, client, now) => {
        await assert.rejects(
          client.status({ idempotencyKey: 'not-yet-visible' }),
          /HTTP 404: OPERATION_NOT_FOUND/,
        )
        assert.equal(
          (
            await client.serviceability({
              ...fixtureContext,
              address: { ...fixtureContext.address, postalCode: '00000' },
            })
          ).covered,
          false,
        )
        assert.deepEqual(
          (
            await client.availability({
              ...fixtureContext,
              dateRange: {
                from: new Date(now.getTime() + 10 * 86_400_000).toISOString(),
                to: new Date(now.getTime() + 11 * 86_400_000).toISOString(),
              },
            })
          ).slots,
          [],
        )
      },
    )
    return reports
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
}
