// Generated from libs/v3sharedtypes/src/customApiBooking.ts. Run npm run generate; do not edit.
import { z } from 'zod/v4'

export const CUSTOM_API_CONTRACT_REVISION = '1.0' as const

const opaqueId = z.string().min(1).max(200)
const timestamp = z.string().datetime({ offset: true })
export const CustomApiTimezoneSchema = z
  .string()
  .min(1)
  .max(100)
  .refine((timezone) => {
    if (timezone.startsWith('+') || timezone.startsWith('-')) return false
    try {
      new Intl.DateTimeFormat('en', { timeZone: timezone })
      return true
    } catch {
      return false
    }
  }, 'Expected an IANA timezone')

export const CustomApiAddressSchema = z
  .object({
    line1: z.string().trim().min(1).max(300),
    line2: z.string().trim().max(300).optional(),
    city: z.string().trim().min(1).max(100),
    region: z.string().trim().min(1).max(100),
    postalCode: z.string().trim().min(1).max(30),
    country: z.enum(['US', 'CA']),
  })
  .strict()

const fieldBase = {
  key: z.string().regex(/^[a-zA-Z][a-zA-Z0-9_]{0,63}$/),
  label: z.string().trim().min(1).max(200),
  requiredAt: z.enum(['availability', 'booking', 'optional']),
  affectsScheduling: z.boolean(),
}
export const CustomApiIntakeFieldSchema = z.discriminatedUnion('type', [
  z
    .object({
      ...fieldBase,
      type: z.literal('string'),
      maxLength: z.number().int().min(1).max(2000),
    })
    .strict(),
  z
    .object({
      ...fieldBase,
      type: z.literal('number'),
      minimum: z.number().finite(),
      maximum: z.number().finite(),
    })
    .strict(),
  z.object({ ...fieldBase, type: z.literal('boolean') }).strict(),
  z
    .object({
      ...fieldBase,
      type: z.literal('choice'),
      choices: z
        .array(
          z
            .object({
              id: opaqueId,
              label: z.string().trim().min(1).max(200),
            })
            .strict(),
        )
        .min(1)
        .max(100),
    })
    .strict(),
])

export const CustomApiServiceSchema = z
  .object({
    id: opaqueId,
    name: z.string().trim().min(1).max(200),
    description: z.string().max(2000).optional(),
    fields: z.array(CustomApiIntakeFieldSchema).max(50),
  })
  .strict()
  .superRefine((service, ctx) => {
    if (
      new Set(service.fields.map((field) => field.key)).size !==
      service.fields.length
    ) {
      ctx.addIssue({
        code: 'custom',
        message: 'Intake field keys must be unique',
      })
    }
    for (const field of service.fields) {
      if (field.type === 'number' && field.minimum > field.maximum) {
        ctx.addIssue({
          code: 'custom',
          message: 'Invalid intake number bounds',
        })
      }
      if (
        field.type === 'choice' &&
        new Set(field.choices.map((choice) => choice.id)).size !==
          field.choices.length
      ) {
        ctx.addIssue({ code: 'custom', message: 'Choice IDs must be unique' })
      }
    }
  })

export const CustomApiDescribeResponseSchema = z
  .object({
    contractRevision: z.literal(CUSTOM_API_CONTRACT_REVISION),
    accountId: opaqueId,
    businessName: z.string().trim().min(1).max(200),
    timezone: CustomApiTimezoneSchema,
    // Change whenever services, questions, or scheduling semantics change.
    definitionRevision: opaqueId,
    services: z.array(CustomApiServiceSchema).min(1).max(100),
    notificationOwnership: z
      .object({
        customerConfirmation: z.enum([
          'customer_system',
          'leadtruffle',
          'none',
        ]),
        teamNotification: z.enum(['customer_system', 'leadtruffle', 'none']),
      })
      .strict(),
  })
  .strict()
  .refine(
    (value) =>
      new Set(value.services.map((service) => service.id)).size ===
      value.services.length,
    'Service IDs must be unique',
  )

export const CustomApiIntakeAnswersSchema = z
  .record(
    z.string().regex(/^[a-zA-Z][a-zA-Z0-9_]{0,63}$/),
    z.union([z.string().max(2000), z.number().finite(), z.boolean()]),
  )
  .refine(
    (answers) => Object.keys(answers).length <= 50,
    'Too many intake answers',
  )

export const validateCustomApiIntakeAnswers = (params: {
  service: z.infer<typeof CustomApiServiceSchema>
  answers: unknown
  stage: 'availability' | 'booking'
}) => {
  const fields = Object.fromEntries(
    params.service.fields.map((field) => {
      let schema: z.ZodType<unknown>
      switch (field.type) {
        case 'string':
          schema = z.string().trim().min(1).max(field.maxLength)
          break
        case 'number':
          schema = z.number().finite().min(field.minimum).max(field.maximum)
          break
        case 'boolean':
          schema = z.boolean()
          break
        case 'choice':
          schema = z
            .string()
            .refine(
              (value) => field.choices.some((choice) => choice.id === value),
              'Unknown choice ID',
            )
          break
      }
      const required =
        field.requiredAt === 'availability' ||
        (field.requiredAt === 'booking' && params.stage === 'booking')
      return [field.key, required ? schema : schema.optional()]
    }),
  )
  return z.object(fields).strict().safeParse(params.answers)
}

export const CustomApiArrivalWindowSchema = z
  .object({
    arrivalWindowStart: timestamp,
    arrivalWindowEnd: timestamp,
    timezone: CustomApiTimezoneSchema,
  })
  .strict()
  .refine(
    (value) =>
      Date.parse(value.arrivalWindowStart) < Date.parse(value.arrivalWindowEnd),
    'Arrival window must end after it starts',
  )

export const CustomApiSlotSchema = z
  .object({
    slotReference: opaqueId,
    arrivalWindow: CustomApiArrivalWindowSchema,
    expiresAt: timestamp,
  })
  .strict()

export const CustomApiServiceabilityRequestSchema = z
  .object({
    serviceId: opaqueId,
    address: CustomApiAddressSchema,
    answers: CustomApiIntakeAnswersSchema,
  })
  .strict()
export const CustomApiServiceabilityResponseSchema = z.discriminatedUnion(
  'covered',
  [
    z
      .object({
        covered: z.literal(true),
        normalizedAddress: CustomApiAddressSchema,
        routingReference: opaqueId.optional(),
      })
      .strict(),
    z
      .object({ covered: z.literal(false), reason: z.string().max(500) })
      .strict(),
  ],
)
export const CustomApiAvailabilityRequestSchema =
  CustomApiServiceabilityRequestSchema.extend({
    routingReference: opaqueId.optional(),
    dateRange: z
      .object({ from: timestamp, to: timestamp })
      .strict()
      .refine((value) => {
        const duration = Date.parse(value.to) - Date.parse(value.from)
        return duration > 0 && duration <= 31 * 24 * 60 * 60 * 1000
      }, 'Availability range must be positive and at most 31 days'),
  })
export const CustomApiAvailabilityResponseSchema = z
  .object({
    slots: z.array(CustomApiSlotSchema).max(100),
  })
  .strict()
  .refine(
    (value) =>
      new Set(value.slots.map((slot) => slot.slotReference)).size ===
      value.slots.length,
    'Slot references must be unique',
  )

export const CustomApiBookingRequestSchema =
  CustomApiServiceabilityRequestSchema.extend({
    contractRevision: z.literal(CUSTOM_API_CONTRACT_REVISION),
    idempotencyKey: z.string().min(1).max(200),
    routingReference: opaqueId.optional(),
    slot: CustomApiSlotSchema,
    selectionRevision: z.number().int().nonnegative(),
    contact: z
      .object({
        name: z.string().trim().min(1).max(200),
        email: z.string().email().max(254).optional(),
        phone: z
          .string()
          .regex(/^\+[1-9]\d{6,14}$/)
          .optional(),
      })
      .strict()
      .refine(
        (value) => Boolean(value.email || value.phone),
        'Provide an email or phone number',
      ),
  })
export const CustomApiBookingStatusRequestSchema = z.union([
  z.object({ idempotencyKey: z.string().min(1).max(200) }).strict(),
  z.object({ bookingId: opaqueId }).strict(),
])
export const CustomApiBookingResultSchema = z.discriminatedUnion('status', [
  z
    .object({
      status: z.literal('confirmed'),
      bookingId: opaqueId,
      serviceId: opaqueId,
      arrivalWindow: CustomApiArrivalWindowSchema,
    })
    .strict(),
  z
    .object({
      status: z.literal('pending'),
      operationReference: opaqueId.optional(),
    })
    .strict(),
  z
    .object({
      status: z.literal('rejected'),
      code: opaqueId,
      message: z.string().min(1).max(500),
    })
    .strict(),
  // Only an authoritative, durable no-write result may use this state.
  z
    .object({ status: z.literal('not_created'), definitive: z.literal(true) })
    .strict(),
])
export const CustomApiErrorSchema = z
  .object({
    code: opaqueId,
    message: z.string().min(1).max(500),
  })
  .strict()

export const CustomApiBaseUrlSchema = z
  .string()
  .url()
  .max(2000)
  .refine((value) => {
    try {
      const url = new URL(value)
      return (
        url.protocol === 'https:' &&
        !url.username &&
        !url.password &&
        !url.search &&
        !url.hash
      )
    } catch {
      return false
    }
  }, 'Use an HTTPS base URL without credentials, query, or fragment')

export type CustomApiBookingRequest = z.infer<
  typeof CustomApiBookingRequestSchema
>
export type CustomApiBookingResult = z.infer<
  typeof CustomApiBookingResultSchema
>

export const CUSTOM_API_ROUTES = {
  describe: {
    method: 'GET',
    path: '/v1/describe',
    response: CustomApiDescribeResponseSchema,
  },
  serviceability: {
    method: 'POST',
    path: '/v1/serviceability',
    request: CustomApiServiceabilityRequestSchema,
    response: CustomApiServiceabilityResponseSchema,
  },
  availability: {
    method: 'POST',
    path: '/v1/availability',
    request: CustomApiAvailabilityRequestSchema,
    response: CustomApiAvailabilityResponseSchema,
  },
  bookings: {
    method: 'POST',
    path: '/v1/bookings',
    request: CustomApiBookingRequestSchema,
    response: CustomApiBookingResultSchema,
  },
  bookingStatus: {
    method: 'POST',
    path: '/v1/booking-status',
    request: CustomApiBookingStatusRequestSchema,
    response: CustomApiBookingResultSchema,
  },
} as const
