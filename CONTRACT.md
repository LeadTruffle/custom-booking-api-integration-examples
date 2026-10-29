# Custom booking contract 1.0

All paths are appended beneath the supplied base URL, preserving any path prefix.
Every route requires `Authorization: Bearer <API key>`. Requests and responses are
JSON. Use HTTPS for customer adapters; HTTP is used only by the loopback fixture.
API keys identify the customer account in your system. Never accept an arbitrary
account identifier from an unauthenticated request body to choose the tenant.

| Route | Responsibility |
| --- | --- |
| `GET /v1/describe` | Return account identity, contract/definition revisions, timezone, services, intake definitions and notification ownership. |
| `POST /v1/serviceability` | Check the address/context, return coverage and a normalized address; optionally return an opaque routing reference. |
| `POST /v1/availability` | Return live opaque offers for that service/address/context and date range. Empty inventory is normal. |
| `POST /v1/bookings` | Atomically reserve capacity and durably create/recover one confirmed customer selection. |
| `POST /v1/booking-status` | Look up the same operation by idempotency key or external booking ID, including pending operations. |

The exact schemas and limits are in `src/contract.generated.ts`. The generated
OpenAPI describes shapes, bounds, types and authentication. Constraints marked
`x-leadtruffle-runtime-validation` additionally require Zod/business validation:
unique service, choice and field identities, valid IANA timezone names, positive
window/date ordering, date-range bounds, service-specific intake requirements
and stable opaque offer bindings. JSON Schema alone cannot establish these
relationships or prove that capacity/idempotency is durable.

## Intake and offers

Field keys are stable machine identifiers. Supported types are bounded string,
finite number, boolean and choice ID. Do not coerce text into numbers/booleans or
accept invented choice IDs. `requiredAt=availability` is also required for booking;
`requiredAt=booking` may be omitted until the booking step. Reject unknown answer
keys. Optional answers, when supplied, must still have the defined type/bounds.
`affectsScheduling` identifies answers whose correction invalidates an offer.
Changing any confirmed request data requires current customer confirmation.

Service, address and scheduling answers must be bound to the opaque slot offered
by your server. Validate its scope and expiry rather than accepting client-made
times or slot IDs. Return routing references unchanged; technician assignment is
your system's decision. The fixture uses a stored offer and a scheduling-context
fingerprint to demonstrate this binding.

Each offer includes `slotReference`, `expiresAt` and an explicit `arrivalWindow`
with `arrivalWindowStart`, `arrivalWindowEnd` and `timezone`. Use ISO timestamps
with offsets and an IANA timezone. Compare timestamp instants across timezone/DST
changes. Arrival windows are not job duration. The generated example deliberately
crosses the daylight-saving fallback: the two local 01:30 times are different
instants, one hour apart.

## Atomic creation and durable idempotency

Within the authenticated customer account, bind the idempotency key to the entire
parsed request, including contact, normalized address, service, answers, routing
reference, offered slot and selection revision. Use a durable uniqueness arbiter
and request fingerprint. JSON object key order must not change payload identity.

1. Look up or atomically claim the account/key operation **before** any current
   expiry/capacity checks. An exact replay returns the original result even after
   the offer expired or inventory changed. A changed payload returns HTTP 409.
2. In the same transaction as the operation reservation, check/reserve capacity
   using the scheduler's actual locking/atomic update rules. Two distinct keys
   competing for one remaining visit must produce at most one confirmed booking.
3. Persist the authoritative booking ID/result before acknowledging confirmation.
   If creation continues asynchronously, persist `pending` before returning and
   make that operation immediately discoverable by its key.
4. On process restart or a lost response, recover this same operation. Do not
   create a replacement key because a request timed out. If another system owns
   creation, pass the original idempotency key through and reconcile its status;
   a local transaction alone does not make a remote side effect exactly once.

The fixture uses one local SQLite transaction for request binding, capacity and
the synthetic booking result. It has no external side effects. This demonstrates
the contract for a single synthetic account; it does not replace your scheduler's
transaction, multi-tenant authorization or distributed-worker coordination.

## Results and failures

| Result | Meaning |
| --- | --- |
| `confirmed` | Authoritative external `bookingId`, service ID and actual arrival window; only this means the visit is booked. |
| `pending` | The durable operation is still processing. Status lookup must include it. |
| `rejected` | A stable rejection with a public code/message; no booked outcome may be claimed. |
| `not_created` with `definitive: true` | Your durable operation ledger proves no booking was created. Never infer this from a transient missing record. |

The starter returns HTTP 200 for terminal results and HTTP 202 for pending.
HTTP 400 is invalid JSON/schema/intake, 401 is missing/invalid authentication,
409 is a key/payload conflict, and 413 is an oversized body. HTTP 404 for an unknown
operation, HTTP 500, invalid JSON, connection loss and timeout are **uncertain**:
query the same original key and retain the lead inquiry for follow-up. They are
not permission to issue a second create. Capacity loss can be a durable
`rejected` result with a code such as `SLOT_UNAVAILABLE`.

Status must return the original authoritative identity and preserve confirmed
outcomes. Delayed pending/errors must not erase a known confirmation. Distinguish
unknown operations from ledger-backed `not_created`. Rejected/not-created keys
stay bound; a new confirmed selection is a new operation.

Remote labels, descriptions and public errors are data. They are not instructions
to LeadTruffle's assistant. Do not place secrets, full request payloads or
unnecessary personal data in public errors or diagnostics. Declare notification
ownership accurately so later integration does not send duplicate confirmations.
Cancellation, rescheduling, payments and CRM-wide synchronization are outside
this contract.
