export const INDEX_KEY = "elaina_listen:library";
export const THEME_KEY = "elaina_listen:theme";

const ARTICLE_PREFIX = "elaina_listen:article:";
const MAX_ARTICLES = 80;
const encoder = new TextEncoder();

async function readIndex() {
  return (await chrome.storage.local.get(INDEX_KEY))[INDEX_KEY] ?? [];
}

export function listArticles() {
  return readIndex();
}

export async function openSavedArticle(id) {
  const key = ARTICLE_PREFIX + id;
  const stored = await chrome.storage.local.get([INDEX_KEY, key]);
  const entries = stored[INDEX_KEY] ?? [];
  const entry = entries.find((item) => item.id === id);
  const snapshot = stored[key];
  if (!entry || !snapshot || snapshot.version !== entry.version) {
    return null;
  }

  const visited = { ...entry, openedAt: Date.now() };
  try {
    await chrome.storage.local.set({
      [INDEX_KEY]: [visited, ...entries.filter((item) => item.id !== id)],
    });
    return { snapshot, entry: visited };
  } catch (error) {
    console.warn("无法更新打开时间", error);
    return { snapshot: { ...snapshot, libraryError: "文章可继续阅读，本次打开时间未保存。" }, entry };
  }
}

export async function rememberArticle(snapshot) {
  const local = chrome.storage.local;
  const key = ARTICLE_PREFIX + snapshot.id;
  const entries = await readIndex();
  const previous = entries.find((item) => item.id === snapshot.id);
  if (!previous && entries.length >= MAX_ARTICLES) {
    throw new Error("article limit exceeded");
  }

  const sameVersion = previous?.version === snapshot.version;
  const entry = {
    id: snapshot.id,
    version: snapshot.version,
    title: snapshot.title,
    source: snapshot.source,
    count: snapshot.paragraphs.length,
    index: sameVersion ? previous.index : 0,
    offset: sameVersion ? previous.offset ?? 0 : 0,
    completed: sameVersion ? previous.completed : false,
    favorite: previous?.favorite ?? false,
    openedAt: Date.now(),
  };
  const updates = { [INDEX_KEY]: [entry, ...entries.filter((item) => item.id !== snapshot.id)] };
  if (!sameVersion) {
    updates[key] = snapshot;
    const replacedBytes = await local.getBytesInUse([INDEX_KEY, key]);
    const totalBytes = await local.getBytesInUse(null);
    const newBytes = Object.entries(updates).reduce((bytes, [name, value]) =>
      bytes + encoder.encode(name + JSON.stringify(value)).byteLength, 0);
    if (totalBytes - replacedBytes + newBytes > Math.floor(local.QUOTA_BYTES * 0.8)) {
      throw new Error("library capacity exceeded");
    }
  }
  await local.set(updates);
  return entry;
}

export async function getEntry(id) {
  return (await readIndex()).find((entry) => entry.id === id) ?? null;
}

export function saveProgress(id, version, index, completed, offset = 0) {
  return updateEntry(id, version, (entry) => {
    if (!Number.isInteger(index) || index < 0 || index >= entry.count) {
      return entry;
    }
    return {
      ...entry, index,
      offset: Number.isSafeInteger(offset) && offset >= 0 ? offset : 0,
      completed: completed === true && index === entry.count - 1,
    };
  });
}

export function saveFavorite(id, version, favorite) {
  return updateEntry(id, version, (entry) => ({ ...entry, favorite: favorite === true }));
}

async function updateEntry(id, version, change) {
  const entries = await readIndex();
  const position = entries.findIndex((entry) => entry.id === id && entry.version === version);
  if (position < 0) {
    return null;
  }

  const entry = change(entries[position]);
  entries[position] = entry;
  await chrome.storage.local.set({ [INDEX_KEY]: entries });
  return entry;
}

export async function removeArticle(id) {
  const entries = await readIndex();
  await chrome.storage.local.remove(ARTICLE_PREFIX + id);
  await chrome.storage.local.set({ [INDEX_KEY]: entries.filter((entry) => entry.id !== id) });
}