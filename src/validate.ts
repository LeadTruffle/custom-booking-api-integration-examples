import { createAdapterClient } from './client'
import { CustomApiBaseUrlSchema } from './contract.generated'
import { runFixtureContractValidation } from './scenarios'

const args = process.argv.slice(2)
if (args.length === 0) {
  const reports = await runFixtureContractValidation()
  for (const name of reports) console.log(`PASS ${name}`)
  console.log(`${reports.length} local synthetic contract scenarios passed.`)
} else if (args.length === 2 && args[0] === '--read-only-url') {
  const baseUrl = CustomApiBaseUrlSchema.parse(args[1])
  const apiKey = process.env.CUSTOM_BOOKING_API_KEY
  if (!apiKey)
    throw new Error(
      'Set CUSTOM_BOOKING_API_KEY without putting it in command-line arguments',
    )
  // External mode has no booking calls or write-mode flag.
  const description = await createAdapterClient({ baseUrl, apiKey }).describe()
  console.log(
    `PASS describe: revision ${description.contractRevision}; ${description.services.length} services. Booking/capacity/idempotency behavior was not tested.`,
  )
} else {
  throw new Error(
    'Usage: npm run validate [-- --read-only-url https://your-adapter.example/base]',
  )
}
