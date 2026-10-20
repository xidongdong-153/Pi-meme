import type {
  MessageRef,
  UiMessage,
  UiMessageBody,
  UiMessageMetadata,
  UiMessagePage,
  UiMessagePageInput,
  UiReactiveMetadata,
  UiReactiveState,
} from '@pi-meme/contracts/plugin-ui-data'
import type { SessionRef } from '@pi-meme/contracts/app-host'
import type { Disposer } from './scope'

export type UiExternalStore<T> = { getSnapshot: () => T; subscribe: (listener: () => void) => Disposer }
export type UiReactiveApi = UiExternalStore<UiReactiveState> & {
  metadata: UiExternalStore<UiReactiveMetadata>
  select: <T>(selector: (state: UiReactiveState) => T, equal?: (left: T, right: T) => boolean) => UiExternalStore<T>
  message: (id: string) => UiExternalStore<UiMessageMetadata | undefined>
  body: (id: string) => UiExternalStore<UiMessageBody | undefined>
}
export type UiMessagesApi = {
  page: (session: SessionRef, input?: UiMessagePageInput) => Promise<UiMessagePage>
  getMessage: (ref: MessageRef) => Promise<UiMessage>
  body: (ref: MessageRef) => UiExternalStore<UiMessageBody | undefined>
}
export type UiDataSource = { reactive: UiReactiveApi; messages: UiMessagesApi }
