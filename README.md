# Custom Booking System adapter kit

Revision 1.0 developer kit for a customer-owned booking system. Implement five
fixed routes below one HTTPS base URL and protect all five with a Bearer API key.
Your system owns service areas, technician routing, capacity and appointment
creation. LeadTruffle's production connector, webchat flow and connection UI are
not enabled by this kit.

## Get started

Requires Node.js v24.22.1 or a newer Node.js 24 release, and npm. Clone this
repository and install its own dependencies:

```sh
git clone https://github.com/LeadTruffle/custom-booking-api-integration-examples.git
cd custom-booking-api-integration-examples
nvm use
npm ci --ignore-scripts
npm run check
npm run validate
npm run fixture
```

If you downloaded the kit ZIP, extract it, open that folder and start with
`nvm use` and `npm ci --ignore-scripts`. No LeadTruffle application checkout,
account credentials or database access is needed to run these examples.

| File | Start here for |
| --- | --- |
| [src/adapter.ts](src/adapter.ts) | Typed Express starter and the five methods to connect to your scheduler |
| [CONTRACT.md](CONTRACT.md) | Routes, intake, arrival windows, idempotency and recovery rules |
| [openapi.json](openapi.json) | Machine-readable request and response definitions |
| [examples.json](examples.json) | Synthetic payloads for every route |
| [IMPLEMENTATION_PROMPT.md](IMPLEMENTATION_PROMPT.md) | Instructions for a coding agent working in your own booking repository |
| [src/fixture.ts](src/fixture.ts) | Runnable SQLite example with durable operation/capacity handling |
| [src/scenarios.ts](src/scenarios.ts) | Executable synthetic contract scenarios |

## Run the synthetic fixture

`validate` runs eight HTTP scenarios against fresh fixtures on ephemeral loopback
ports: happy path, validation/authentication, duplicate keys, last-slot contention,
lost responses, pending status, actual create timeout, and normal no-inventory /
out-of-area outcomes. It cannot target an external system or create real visits.
The Vitest suite additionally closes/reopens the fixture database to exercise
restart recovery, stale selections, expired replays and malformed responses.

`fixture` listens only on `127.0.0.1:8788`, with base path
`/sandbox/leadtruffle`. The default public synthetic key is
`synthetic-fixture-only-key`. You can override it using
`CUSTOM_BOOKING_FIXTURE_API_KEY`; the server does not print the configured key.
`CUSTOM_BOOKING_FIXTURE_PORT` changes the local port. No production environment or
LeadTruffle database connection is loaded.

The fixture uses Node's built-in SQLite in a fresh temporary directory. Its
single synthetic arrival window is tomorrow in UTC, with a two-hour arrival
window and capacity **one**. Offers expire after one hour. It sends no messages,
charges no payments and has no CRM side effects. Postal code `00000` represents
an out-of-area address. The `inspection` service requires `propertyType` before
availability and `accessNotes` before booking.

To preserve fixture data across manual server restarts:

```sh
npm run fixture -- --database /tmp/my-synthetic-booking.sqlite
```

Use a fresh path to reset capacity. Reopening an existing fixture preserves
bookings, capacity, slot expiry and idempotency. Existing files without the
fixture marker are rejected. Keep this database local and synthetic. The default
temporary database is retained when the manual server exits so it can be reopened;
automated scenarios clean up only their own newly created temporary directories.

## Implement your adapter

Start with `src/adapter.ts`, which exports `createCustomerBookingAdapter` and the
typed `CustomerBookingSystem` interface. Supply implementations that call your
existing booking system's business logic. For example, inside your own server:

```ts
import { createCustomerBookingAdapter } from './src/adapter'
import { customerBookingSystem } from './your-existing-system'

export const bookingAdapter = createCustomerBookingAdapter({
  apiKey: process.env.LEADTRUFFLE_BOOKING_API_KEY ?? '',
  system: customerBookingSystem,
  basePath: '/leadtruffle',
})
```

Mount this Express application behind your existing HTTPS server/reverse proxy.
For that example, the base URL supplied to LeadTruffle is
`https://booking.example.com/leadtruffle`. Do not expose the synthetic fixture as
a production scheduler. The fixture's tables and single-capacity rule are test
data; reuse your actual scheduling transactions and tenant authorization.

The starter validates request and response shapes, bounds request JSON to
128 KiB and responses to 1 MiB, and returns public errors without raw exceptions.
It does **not** implement your business transaction, customer notification policy,
production rate limiting, TLS, API-key storage/rotation or deployment. Configure
those in your existing server. Use `CONTRACT.md`, `openapi.json`, `examples.json`
and `IMPLEMENTATION_PROMPT.md` when implementing the interface.

`src/contract.generated.ts` contains the public wire contract only. It imports no
LeadTruffle backend, database or environment. `npm run generate` regenerates
OpenAPI and examples from this included schema; `npm run check:generated` and
CI reject stale artifacts. Commit the contract and generated outputs together.
Example dates are fixed documentation examples, not currently bookable offers.

## Read-only inspection of your adapter

Set `CUSTOM_BOOKING_API_KEY` securely in your shell environment, then run:

```sh
npm run validate -- --read-only-url https://booking.example.com/leadtruffle
```

This external mode calls **only describe** and validates its schema. It has no
write mode. Passing this check does not validate bookings, capacity, idempotency,
delivery or sandbox behavior. Run those checks in your own isolated sandbox with
synthetic contacts and delivery disabled before asking to enable real booking.
No external adapter was contacted as part of this kit's implementation.

The example HTTP client supports the loopback fixture. Customer adapters must
be served over public HTTPS. LeadTruffle connects through its own guarded client;
connection and sandbox checks do not themselves prove your real booking
transaction. Complete the isolated tests before enabling real webchat booking.

## License

[MIT](LICENSE). This repository contains examples for building your own adapter;
it does not grant access to LeadTruffle's application or customer data.
