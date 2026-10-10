/** Host 凭据存储接口；持久化完成后才确认凭据操作。 */
export interface SecureCredentialStorage {
  get: (key: string) => string | undefined
  set: (key: string, value: string) => void
  delete: (key: string) => boolean
  entries: (prefix?: string) => Array<[string, string]>
}
