import { createServerFn } from '@tanstack/react-start'

export interface Item {
  key: string
  name: string
  path: string
}

let items: Item[] = []

export const getItems = createServerFn().handler(async (): Promise<Item[]> => {
  return items
})

export const addItem = createServerFn({ method: 'POST' })
  .inputValidator((item: Item) => item)
  .handler(async ({ data: item }): Promise<void> => {
    items.push(item)
  })

export const updateItem = createServerFn({ method: 'POST' })
  .inputValidator((item: Item) => item)
  .handler(async ({ data: item }): Promise<void> => {
    const index = items.findIndex((i) => i.key === item.key)
    if (index !== -1) {
      items[index] = item
    }
  })

export const deleteItem = createServerFn({ method: 'POST' })
  .inputValidator((item: Item) => item)
  .handler(async ({ data: item }): Promise<void> => {
    items = items.filter((i) => i.key !== item.key)
  })
