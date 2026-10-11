const acronyms = new Set(['ui', 'api', 'mcp', 'sdk', 'css', 'html', 'sql', 'ai'])

export function formatAgentName(name: string) {
  const words = name.trim().replace(/[_-]+/g, ' ').split(/\s+/)
  return words
    .map((word, index) =>
      acronyms.has(word.toLowerCase())
        ? word.toUpperCase()
        : index === 0
          ? word.charAt(0).toUpperCase() + word.slice(1)
          : word,
    )
    .join(' ')
}
