/** Desktop 运行时的加密凭据存储接口。 */
export interface SecureCredentialStorage {
  get: (key: string) => string | undefined
  set: (key: string, value: string) => void
  delete: (key: string) => boolean
  entries: (prefix?: string) => Array<[string, string]>
}
