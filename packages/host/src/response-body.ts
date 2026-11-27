export async function responseBody(response: Response, limit: number) {
  const chunks: Uint8Array[] = []
  let size = 0
  for await (const chunk of response.body ?? []) {
    size += chunk.byteLength
    if (size > limit) throw new Error('远程响应超过大小限制')
    chunks.push(chunk)
  }
  return Buffer.concat(chunks)
}
