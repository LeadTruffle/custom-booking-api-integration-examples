import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { wireContractSource } from './wireContractSource'

const canonical = new URL(
  '../../../libs/v3sharedtypes/src/customApiBooking.ts',
  import.meta.url,
)
const copied = new URL('./contract.generated.ts', import.meta.url)
const check = process.argv.includes('--check')
if (existsSync(canonical)) {
  // Customer downloads contain only the public wire contract, not LeadTruffle
  // connection credentials, operation state or configuration schemas.
  const expected = wireContractSource(readFileSync(canonical, 'utf8'))
  if (check) {
    if (!existsSync(copied) || readFileSync(copied, 'utf8') !== expected)
      throw new Error('Generated contract is stale; run npm run generate')
  } else writeFileSync(copied, expected)
}
// Import only after synchronizing the contract, so generation uses its new schema.
const { buildArtifacts } = await import('./openapi')
for (const [name, content] of Object.entries(buildArtifacts())) {
  const path = new URL(`../${name}`, import.meta.url)
  if (check) {
    if (!existsSync(path) || readFileSync(path, 'utf8') !== content)
      throw new Error(`${name} is stale; run npm run generate`)
  } else writeFileSync(path, content)
}
console.log(
  check
    ? 'Generated contract, OpenAPI and examples are current.'
    : `Generated adapter artifacts in ${fileURLToPath(new URL('../', import.meta.url))}`,
)
