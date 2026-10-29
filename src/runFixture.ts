import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { startFixtureServer } from './fixture'

const args = process.argv.slice(2)
if (args.length !== 0 && !(args.length === 2 && args[0] === '--database'))
  throw new Error(
    'Usage: npm run fixture [-- --database /path/to/synthetic-fixture.sqlite]',
  )
const databasePath =
  args.length === 2
    ? resolve(args[1])
    : join(
        await mkdtemp(join(tmpdir(), 'lt-booking-fixture-')),
        'fixture.sqlite',
      )
const port = Number(process.env.CUSTOM_BOOKING_FIXTURE_PORT ?? 8788)
if (!Number.isInteger(port) || port < 1024 || port > 65535)
  throw new Error('Choose a fixture port between 1024 and 65535')
const fixture = await startFixtureServer({
  databasePath,
  port,
  apiKey: process.env.CUSTOM_BOOKING_FIXTURE_API_KEY,
})
console.log(
  `Synthetic fixture: ${fixture.baseUrl}\nLocal fixture database: ${databasePath}\nNo customer messages or real appointments are created.`,
)
let closing = false
const stop = () => {
  if (closing) return
  closing = true
  void fixture.close().catch(() => {
    process.exitCode = 1
  })
}
process.once('SIGINT', stop)
process.once('SIGTERM', stop)
