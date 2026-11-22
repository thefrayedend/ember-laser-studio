export interface TestRecord {
  id: string
  at: number
  name: string
  kind: 'engrave' | 'cut'
  title: string
  /** the chosen square in words, e.g. "3000 mm/min at 40%", or what the user wrote down */
  result?: string
  best?: { c: number; r: number }
  image: Blob
}

const DB = 'ember-tests'
const open = () =>
  new Promise<IDBDatabase>((res, rej) => {
    const q = indexedDB.open(DB, 1)
    q.onupgradeneeded = () => q.result.createObjectStore('tests', { keyPath: 'id' })
    q.onsuccess = () => res(q.result)
    q.onerror = () => rej(q.error)
  })
const run = async <T,>(mode: IDBTransactionMode, f: (s: IDBObjectStore) => IDBRequest<T>) => {
  const db = await open()
  return new Promise<T>((res, rej) => {
    const r = f(db.transaction('tests', mode).objectStore('tests'))
    r.onsuccess = () => res(r.result)
    r.onerror = () => rej(r.error)
  })
}
export const listTests = async () => ((await run('readonly', (s) => s.getAll())) as TestRecord[]).sort((a, b) => b.at - a.at)
export const saveTest = (t: TestRecord) => run('readwrite', (s) => s.put(t))
export const deleteTest = (id: string) => run('readwrite', (s) => s.delete(id))
