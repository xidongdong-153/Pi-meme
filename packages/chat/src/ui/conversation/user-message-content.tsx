import { Box } from 'lucide-react'
import { skillMessageParts } from '@pi-meme/contracts/skills'

export function UserMessageContent({ text }: { text: string }) {
  return (
    <div className="pi-content">
      {skillMessageParts(text).map((part, index) =>
        part.type === 'text' ? (
          part.text
        ) : (
          <span key={index} title={part.path} className="inline text-blue-400" aria-label={`技能：${part.name}`}>
            <Box aria-hidden="true" className="inline-block size-4 align-[-0.125em] mr-1" />${part.name}
          </span>
        ),
      )}
    </div>
  )
}
