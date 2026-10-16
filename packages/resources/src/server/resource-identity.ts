import { createHash } from 'node:crypto'

export function resourceIdentity(value: string) {
  return createHash('sha256').update(value).digest('hex').slice(0, 24)
}
