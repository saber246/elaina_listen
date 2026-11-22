const databaseName = "elaina-mobile-library";
let connection;

function openDatabase() {
  if (!connection) {
    connection = new Promise((resolve, reject) => {
      const request = indexedDB.open(databaseName, 1);
      request.onupgradeneeded = () => {
        const database = request.result;
        database.createObjectStore("entries", { keyPath: "id" });
        database.createObjectStore("content");
      };
      request.onsuccess = () => {
        const database = request.result;
        database.onversionchange = () => {
          database.close();
          connection = undefined;
        };
        resolve(database);
      };
      request.onerror = () => reject(request.error);
    }).catch((error) => {
      connection = undefined;
      throw error;
    });
  }
  return connection;
}

async function transact(stores, mode, run) {
  const database = await openDatabase();
  return new Promise((resolve, reject) => {
    const transaction = database.transaction(stores, mode);
    let result;
    transaction.oncomplete = () => resolve(result);
    transaction.onabort = () => reject(transaction.error ?? new Error("本地写入中断"));
    run(transaction, (value) => { result = value; });
  });
}

export function listEntries() {
  return transact("entries", "readonly", (transaction, done) => {
    const request = transaction.objectStore("entries").getAll();
    request.onsuccess = () => done(request.result.sort((a, b) => b.updatedAt - a.updatedAt));
  });
}

export function readEntry(id) {
  return transact(["entries", "content"], "readonly", (transaction, done) => {
    const entry = transaction.objectStore("entries").get(id);
    const content = transaction.objectStore("content").get(id);
    content.onsuccess = () => done(entry.result ? { entry: entry.result, content: content.result } : null);
  });
}

export function addEntry(kind, title, content) {
  const entry = { id: crypto.randomUUID(), kind, title, favorite: false, updatedAt: Date.now(), progress: {} };
  return transact(["entries", "content"], "readwrite", (transaction, done) => {
    transaction.objectStore("entries").add(entry);
    transaction.objectStore("content").add(content, entry.id);
    done(entry);
  });
}

export function updateEntry(id, changes) {
  return transact("entries", "readwrite", (transaction, done) => {
    const entries = transaction.objectStore("entries");
    const request = entries.get(id);
    request.onsuccess = () => {
      if (request.result) {
        const entry = { ...request.result, ...changes, updatedAt: Date.now() };
        entries.put(entry);
        done(entry);
      }
    };
  });
}

export function removeEntry(id) {
  return transact(["entries", "content"], "readwrite", (transaction) => {
    transaction.objectStore("entries").delete(id);
    transaction.objectStore("content").delete(id);
  });
}