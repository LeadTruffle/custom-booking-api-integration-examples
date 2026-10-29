export const wireContractSource = (source: string) => {
  const wireEnd = source.indexOf('export const CustomApiConfirmationSchema')
  const routesStart = source.indexOf('export const CUSTOM_API_ROUTES')
  const baseUrlStart = source.indexOf('export const CustomApiBaseUrlSchema')
  const configStart = source.indexOf(
    'export const CustomApiIntegrationConfigSchema',
  )
  if (
    wireEnd < 0 ||
    routesStart < wireEnd ||
    baseUrlStart < wireEnd ||
    configStart < baseUrlStart
  )
    throw new Error('Wire contract extraction markers changed')
  const wire = source
    .slice(0, wireEnd)
    .replace("from 'zod'", "from 'zod/v4'")
    .replace(
      /export const CUSTOM_API_BOOKING_OPERATION_ACTION_TYPE =[\s\S]*? as const\n/,
      '',
    )
  return (
    '// Generated from libs/v3sharedtypes/src/customApiBooking.ts. Run npm run generate; do not edit.\n' +
    wire +
    source.slice(baseUrlStart, configStart) +
    'export type CustomApiBookingRequest = z.infer<\n  typeof CustomApiBookingRequestSchema\n>\nexport type CustomApiBookingResult = z.infer<\n  typeof CustomApiBookingResultSchema\n>\n\n' +
    source.slice(routesStart)
  )
}
