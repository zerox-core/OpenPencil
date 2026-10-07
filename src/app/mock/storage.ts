import { StorageSerializers, useLocalStorage } from '@vueuse/core'

const MOCK_PAGES_KEY = 'open-pencil:mock-pages:v2'

const mockPages = useLocalStorage<unknown>(MOCK_PAGES_KEY, null, {
  serializer: StorageSerializers.object,
  writeDefaults: false
})

export function readMockPagesStorage(): unknown {
  return mockPages.value
}

export function writeMockPagesStorage(value: unknown): void {
  mockPages.value = value
}
