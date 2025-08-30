'use server';

export interface Item {
  key: string;
  name: string;
  path: string;
}

let items: Item[] = [];

export async function getItems(): Promise<Item[]> {
  return items;
}

export async function addItem(item: Item): Promise<void> {
  items.push(item);
}

export async function updateItem(item: Item): Promise<void> {
  const index = items.findIndex(i => i.key === item.key);
  if (index !== -1) {
    items[index] = item;
  }
}

export async function deleteItem(item: Item): Promise<void> {
  items = items.filter(i => i.key !== item.key);
}
