import axios, { type AxiosResponse } from 'axios'
import { z } from 'zod/v4'
import { CUSTOM_API_ROUTES, CustomApiErrorSchema } from './contract.generated'

// Developer-kit transport only. This accepts explicit developer destinations,
// including the loopback fixture. Do not reuse it as LeadTruffle's production
// connector client; production requires DNS/IP policy and connection pinning.
export const createAdapterClient = (params: {
  baseUrl: string
  apiKey: string
  timeoutMs?: number
}) => {
  const http = axios.create({
    baseURL: params.baseUrl.replace(/\/+$/, ''),
    headers: { Authorization: `Bearer ${params.apiKey}` },
    timeout: params.timeoutMs ?? 3000,
    maxRedirects: 0,
    maxContentLength: 1024 * 1024,
    maxBodyLength: 128 * 1024,
    proxy: false,
    validateStatus: () => true,
  })
  const call = async <I, O>(
    route: { method: 'GET' | 'POST'; path: string; response: z.ZodType<O> },
    body?: I,
  ): Promise<O> => {
    let response: AxiosResponse<unknown>
    try {
      response = await http.request<unknown>({
        method: route.method,
        url: route.path,
        data: body,
      })
    } catch {
      // Axios errors contain request headers. Never propagate those to CLI output.
      throw new Error(
        'Adapter transport failed; reconcile the original booking key before further writes.',
      )
    }
    if (![200, 202].includes(response.status)) {
      const error = CustomApiErrorSchema.safeParse(response.data)
      throw new Error(
        `Adapter HTTP ${response.status}: ${error.success ? error.data.code : 'INVALID_ERROR_RESPONSE'}`,
      )
    }
    const parsed = route.response.safeParse(response.data)
    if (!parsed.success)
      throw new Error(
        'Adapter returned data that does not match the booking contract.',
      )
    return parsed.data
  }
  return {
    describe: () => call(CUSTOM_API_ROUTES.describe),
    serviceability: (
      request: z.output<typeof CUSTOM_API_ROUTES.serviceability.request>,
    ) =>
      call(
        CUSTOM_API_ROUTES.serviceability,
        CUSTOM_API_ROUTES.serviceability.request.parse(request),
      ),
    availability: (
      request: z.output<typeof CUSTOM_API_ROUTES.availability.request>,
    ) =>
      call(
        CUSTOM_API_ROUTES.availability,
        CUSTOM_API_ROUTES.availability.request.parse(request),
      ),
    book: (request: z.output<typeof CUSTOM_API_ROUTES.bookings.request>) =>
      call(
        CUSTOM_API_ROUTES.bookings,
        CUSTOM_API_ROUTES.bookings.request.parse(request),
      ),
    status: (
      request: z.output<typeof CUSTOM_API_ROUTES.bookingStatus.request>,
    ) =>
      call(
        CUSTOM_API_ROUTES.bookingStatus,
        CUSTOM_API_ROUTES.bookingStatus.request.parse(request),
      ),
  }
}
