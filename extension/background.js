import {
  getEntry, listArticles, openSavedArticle, rememberArticle, removeArticle, saveFavorite, saveProgress,
} from "./library.js";

const READER_URL = chrome.runtime.getURL("reader.html");
const SELECTION_COMMAND = "tingyue-read-selection";
const LIBRARY_COMMAND = "tingyue-open-library";
const ALLOWED_PAGES = ["http://*/*", "https://*/*"];

let pendingStorage = Promise.resolve();

function useLibrary(operation) {
  const request = pendingStorage.then(operation);
  pendingStorage = request.catch(() => {});
  return request;
}

function logError(error) {
  console.error("elaina 操作未完成", error);
}

chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.removeAll(() => {
    chrome.contextMenus.create({
      id: SELECTION_COMMAND,
      title: "用 elaina 朗读选中文字",
      contexts: ["selection"],
      documentUrlPatterns: ALLOWED_PAGES,
    });
    chrome.contextMenus.create({
      id: LIBRARY_COMMAND,
      title: "打开 elaina 阅读库",
      contexts: ["action"],
    });
  });
});

chrome.action.onClicked.addListener((tab) => {
  openArticle(tab).catch(logError);
});

chrome.contextMenus.onClicked.addListener((info, tab) => {
  if (info.menuItemId === LIBRARY_COMMAND) {
    chrome.tabs.create({ url: READER_URL + "?view=library" }).catch(logError);
  } else if (info.menuItemId === SELECTION_COMMAND && tab) {
    openSelection(info, tab).catch(logError);
  }
});

chrome.tabs.onRemoved.addListener((tabId) => {
  chrome.storage.session.remove("reader:" + tabId).catch(logError);
});

const libraryCommands = {
  "library:list": () => listArticles(),
  "library:open": ({ id }) => openSavedArticle(id),
  "library:entry": ({ id }) => getEntry(id),
  "library:favorite": ({ id, version, favorite }) => saveFavorite(id, version, favorite),
  "library:progress": ({ id, version, index, offset, completed }) => saveProgress(id, version, index, completed, offset),
  "library:remove": ({ id }) => removeArticle(id),
};

chrome.runtime.onMessage.addListener((message, sender, respond) => {
  const senderPage = sender.url?.split(/[?#]/, 1)[0];
  if (sender.id !== chrome.runtime.id || senderPage !== READER_URL
      || typeof message?.type !== "string" || !Object.hasOwn(libraryCommands, message.type)) {
    return;
  }

  useLibrary(() => libraryCommands[message.type](message)).then(
    (data) => respond({ ok: true, data }),
    (error) => {
      logError(error);
      respond({ ok: false, message: "无法更新阅读库，请稍后重试。" });
    },
  );
  return true;
});

async function openArticle(tab) {
  const snapshot = await captureArticle(tab);

  await openReader(tab, snapshot);
}

async function openSelection(info, tab) {
  const text = (info.selectionText ?? "").trim();
  const url = info.frameUrl || info.pageUrl || tab.url;
  if (!text || !/^https?:\/\//i.test(url ?? "")) {
    return;
  }

  let language = "";
  try {
    const [injection] = await chrome.scripting.executeScript({
      target: { tabId: tab.id, frameIds: [info.frameId ?? 0] },
      func: () => {
        const anchor = getSelection()?.anchorNode;
        const element = anchor instanceof Element ? anchor : anchor?.parentElement;
        return element?.closest("[lang]")?.lang || document.documentElement.lang;
      },
    });
    language = injection?.result ?? "";
  } catch {
    // Selection text is already supplied by Edge even if the frame is inaccessible.
  }

  await openReader(tab, {
    kind: "selection",
    title: "选中文字",
    source: new URL(url).hostname,
    language,
    paragraphs: text.split(/\r?\n/).map((paragraph) => paragraph.replace(/\s+/g, " ").trim()).filter(Boolean),
  });
}

async function openReader(sourceTab, snapshot) {
  const readerTab = await chrome.tabs.create({
    windowId: sourceTab.windowId,
    index: sourceTab.index + 1,
    url: "about:blank",
    active: false,
  });
  const key = "reader:" + readerTab.id;
  try {
    if (snapshot.id) {
      let libraryError = "";
      try {
        await useLibrary(() => rememberArticle(snapshot));
      } catch (error) {
        logError(error);
        libraryError = "这篇文章未存入阅读库。若空间不足，可移除旧条目后重新打开。";
      }
      await chrome.storage.session.set({ [key]: { ...snapshot, libraryError } });
    } else {
      await chrome.storage.session.set({ [key]: snapshot });
    }
  } catch (error) {
    logError(error);
    await chrome.tabs.update(readerTab.id, { url: READER_URL + "#storage-error", active: true });
    return;
  }

  await chrome.tabs.update(readerTab.id, { url: READER_URL, active: true });
}

async function captureArticle(tab) {
  if (!Number.isInteger(tab.id) || !/^https?:\/\//i.test(tab.url ?? "")) {
    return { error: "当前页面无法提取。请打开普通的网页文章后再试。" };
  }

  try {
    const [injection] = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      files: ["vendor/Readability.js", "extract.js"],
    });
    const snapshot = injection?.result;
    if (!snapshot || snapshot.error) {
      return snapshot ?? { error: "没有收到正文。请刷新原网页后重试。" };
    }

    const url = new URL(snapshot.url || tab.url);
    url.username = "";
    url.password = "";
    const id = await digest(url.href);
    const version = await digest(JSON.stringify([snapshot.title, snapshot.language, snapshot.paragraphs]));
    return {
      id, version, title: snapshot.title, source: snapshot.source,
      language: snapshot.language, paragraphs: snapshot.paragraphs,
    };
  } catch (error) {
    console.warn("无法读取当前网页", error);
    return { error: "无法读取当前网页。请刷新后重试，或换一篇普通的网页文章。" };
  }
}

async function digest(value) {
  const hash = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Array.from(new Uint8Array(hash), (byte) => byte.toString(16).padStart(2, "0")).join("");
}