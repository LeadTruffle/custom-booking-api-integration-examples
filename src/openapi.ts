import { z } from 'zod/v4'
import {
  CUSTOM_API_CONTRACT_REVISION,
  CUSTOM_API_ROUTES,
  CustomApiErrorSchema,
} from './contract.generated'
import { makeContractExamples } from './examples'

// Zod's native exporter preserves the fixed contract's structural constraints.
// Cross-field refinements (coverage, stage requirements and temporal ordering)
// still require runtime validation, as documented in CONTRACT.md.
export const toJsonSchema = (
  schema: z.ZodType<unknown>,
): Record<string, unknown> => ({
  ...z.toJSONSchema(schema, { target: 'draft-7', io: 'input' }),
  'x-leadtruffle-runtime-validation': true,
})

export const buildArtifacts = () => {
  const examples = makeContractExamples()
  const paths = Object.fromEntries(
    Object.entries(CUSTOM_API_ROUTES).map(([name, route]) => {
      const sample = examples[name as keyof typeof examples]
      const success = {
        description:
          'Validated result; only status=confirmed is a booked appointment.',
        content: {
          'application/json': {
            schema: toJsonSchema(route.response),
            example: sample.response,
          },
        },
      }
      const error = (description: string) => ({
        description,
        content: {
          'application/json': { schema: toJsonSchema(CustomApiErrorSchema) },
        },
      })
      return [
        route.path,
        {
          [route.method.toLowerCase()]: {
            operationId: name,
            ...('request' in route && 'request' in sample
              ? {
                  requestBody: {
                    required: true,
                    content: {
                      'application/json': {
                        schema: toJsonSchema(route.request),
                        example: sample.request,
                      },
                    },
                  },
                }
              : {}),
            responses: {
              '200': success,
              ...(['bookings', 'bookingStatus'].includes(name)
                ? {
                    '202': {
                      ...success,
                      description:
                        'Pending operation; query the same idempotency key.',
                    },
                  }
                : {}),
              '400': error('Invalid request or JSON.'),
              '401': error('Missing or invalid Bearer authentication.'),
              '404': error(
                'Unknown route or operation. Missing operation is not proof that no booking was created.',
              ),
              ...(name === 'bookings'
                ? {
                    '409': error(
                      'Idempotency key reused with a different payload.',
                    ),
                  }
                : {}),
              '413': error('Request exceeds the body limit.'),
              '500': error(
                'Unknown outcome; reconcile booking status before further writes.',
              ),
            },
          },
        },
      ]
    }),
  )
  const openapi = {
    openapi: '3.1.0',
    info: {
      title: 'LeadTruffle Custom Booking Adapter',
      version: CUSTOM_API_CONTRACT_REVISION,
      description:
        'Customer-owned adapter contract. Paths are appended beneath your base URL. Custom semantic constraints marked x-leadtruffle-runtime-validation are enforced by the generated Zod contract and documented in CONTRACT.md.',
    },
    servers: [{ url: 'https://booking.example.com/leadtruffle' }],
    security: [{ bearerAuth: [] }],
    components: {
      securitySchemes: { bearerAuth: { type: 'http', scheme: 'bearer' } },
    },
    paths,
  }
  return {
    'openapi.json': `${JSON.stringify(openapi, null, 2)}\n`,
    'examples.json': `${JSON.stringify(examples, null, 2)}\n`,
  }
}
