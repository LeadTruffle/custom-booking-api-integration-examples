import {
  CUSTOM_API_CONTRACT_REVISION,
  CUSTOM_API_ROUTES,
  CustomApiServiceSchema,
} from './contract.generated'

export const fixtureService = CustomApiServiceSchema.parse({
  id: 'inspection',
  name: 'Home inspection',
  fields: [
    {
      key: 'propertyType',
      label: 'Property type',
      type: 'choice',
      choices: [
        { id: 'house', label: 'House' },
        { id: 'condo', label: 'Condo' },
      ],
      requiredAt: 'availability',
      affectsScheduling: true,
    },
    {
      key: 'accessNotes',
      label: 'Access instructions',
      type: 'string',
      maxLength: 200,
      requiredAt: 'booking',
      affectsScheduling: false,
    },
  ],
})
export const fixtureAddress = {
  line1: '100 Example Street',
  city: 'Example City',
  region: 'NY',
  postalCode: '10001',
  country: 'US' as const,
}
export const fixtureContext = {
  serviceId: fixtureService.id,
  address: fixtureAddress,
  answers: { propertyType: 'house' },
}

export const makeContractExamples = () => {
  const describe = CUSTOM_API_ROUTES.describe.response.parse({
    contractRevision: CUSTOM_API_CONTRACT_REVISION,
    accountId: 'synthetic-fixture',
    businessName: 'Synthetic booking fixture',
    timezone: 'America/New_York',
    definitionRevision: 'fixture-1',
    services: [fixtureService],
    notificationOwnership: {
      customerConfirmation: 'none',
      teamNotification: 'none',
    },
  })
  const slot = {
    slotReference: 'opaque-fixture-slot',
    expiresAt: '2026-10-31T20:00:00Z',
    arrivalWindow: {
      arrivalWindowStart: '2026-11-01T01:30:00-04:00',
      arrivalWindowEnd: '2026-11-01T01:30:00-05:00',
      timezone: describe.timezone,
    },
  }
  return {
    describe: { response: describe },
    serviceability: {
      request: CUSTOM_API_ROUTES.serviceability.request.parse(fixtureContext),
      response: CUSTOM_API_ROUTES.serviceability.response.parse({
        covered: true,
        normalizedAddress: fixtureAddress,
        routingReference: 'opaque-fixture-route',
      }),
    },
    availability: {
      request: CUSTOM_API_ROUTES.availability.request.parse({
        ...fixtureContext,
        routingReference: 'opaque-fixture-route',
        dateRange: {
          from: '2026-11-01T00:00:00-04:00',
          to: '2026-11-03T00:00:00-05:00',
        },
      }),
      response: CUSTOM_API_ROUTES.availability.response.parse({
        slots: [slot],
      }),
    },
    bookings: {
      request: CUSTOM_API_ROUTES.bookings.request.parse({
        ...fixtureContext,
        contractRevision: CUSTOM_API_CONTRACT_REVISION,
        idempotencyKey: 'synthetic-operation-1',
        routingReference: 'opaque-fixture-route',
        answers: {
          ...fixtureContext.answers,
          accessNotes: 'Use the front door.',
        },
        slot,
        selectionRevision: 1,
        contact: { name: 'Fixture Customer', email: 'fixture@example.com' },
      }),
      response: CUSTOM_API_ROUTES.bookings.response.parse({
        status: 'confirmed',
        bookingId: 'synthetic-booking-1',
        serviceId: fixtureService.id,
        arrivalWindow: slot.arrivalWindow,
      }),
    },
    bookingStatus: {
      request: CUSTOM_API_ROUTES.bookingStatus.request.parse({
        idempotencyKey: 'synthetic-operation-1',
      }),
      response: CUSTOM_API_ROUTES.bookingStatus.response.parse({
        status: 'pending',
        operationReference: 'synthetic-operation-1',
      }),
    },
  }
}
