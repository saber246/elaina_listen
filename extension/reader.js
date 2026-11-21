import { INDEX_KEY, THEME_KEY } from "./library.js";
import { ParagraphSpeech } from "./speech.js";

const element = (id) => document.getElementById(id);
const notice = element("notice");
const reading = element("reading");
const library = element("library");
const libraryButton = element("library-button");
const libraryList = element("library-list");
const themeButton = element("theme");
const favorite = element("favorite");
const player = element("player");
const toggle = element("toggle");
const progress = element("progress");
const position = element("position");
const storageStatus = element("storage-status");
const libraryStatus = element("library-status");
const route = new URLSearchParams(location.search);
const startsInLibrary = route.get("view") === "library";
const systemTheme = matchMedia("(prefers-color-scheme: dark)");
const dateFormat = new Intl.DateTimeFormat("zh-CN", { dateStyle: "medium", timeStyle: "short" });

let snapshot;
let activeEntry;
let allEntries = [];
let showFavorites = false;
let themePreference;
let highlightedIndex = -1;
let highlightedSentence;
const paragraphNodes = [];

async function callLibrary(command, data = {}) {
  const response = await chrome.runtime.sendMessage({ type: "library:" + command, ...data });
  if (!response?.ok) {
    throw new Error(response?.message ?? "无法读取阅读库，请稍后重试。");
  }
  return response.data;
}

function applyTheme() {
  const dark = themePreference === "dark" || (!themePreference && systemTheme.matches);
  document.documentElement.dataset.theme = dark ? "dark" : "light";
  themeButton.setAttribute("aria-pressed", String(dark));
}

themeButton.addEventListener("click", async () => {
  themePreference = document.documentElement.dataset.theme === "dark" ? "light" : "dark";
  applyTheme();
  try {
    await chrome.storage.local.set({ [THEME_KEY]: themePreference });
  } catch (error) {
    console.warn("无法保存主题设置", error);
  }
});
systemTheme.addEventListener("change", applyTheme);
applyTheme();

function updateFavorite(entry) {
  activeEntry = entry?.version === snapshot?.version ? entry : null;
  favorite.hidden = !activeEntry;
  favorite.setAttribute("aria-pressed", String(activeEntry?.favorite ?? false));
  favorite.textContent = activeEntry?.favorite ? "取消收藏" : "加入收藏";
}

favorite.addEventListener("click", async () => {
  if (!activeEntry) {
    return;
  }

  favorite.disabled = true;
  try {
    const entry = await callLibrary("favorite", {
      id: snapshot.id, version: snapshot.version, favorite: !activeEntry.favorite,
    });
    updateFavorite(entry);
    storageStatus.textContent = entry?.favorite ? "已加入收藏" : entry ? "已取消收藏" : "此文章已从阅读库移除。";
  } catch (error) {
    storageStatus.textContent = error.message;
  } finally {
    favorite.disabled = false;
  }
});

function renderLibrary() {
  const focusedId = libraryList.contains(document.activeElement) ? document.activeElement.id : "";
  const entries = showFavorites ? allEntries.filter((entry) => entry.favorite) : allEntries;
  const rows = document.createDocumentFragment();

  for (const entry of entries) {
    const row = document.createElement("li");
    const info = document.createElement("div");
    const link = document.createElement("a");
    link.id = "open-" + entry.id;
    link.href = "reader.html?article=" + encodeURIComponent(entry.id);
    link.textContent = entry.title;
    const detail = document.createElement("p");
    const progressText = entry.completed ? "已读完" : "第 " + (entry.index + 1) + " / " + entry.count + " 段";
    detail.textContent = [entry.source, progressText, dateFormat.format(entry.openedAt)].filter(Boolean).join(" · ");
    info.append(link, detail);

    const remove = document.createElement("button");
    remove.id = "remove-" + entry.id;
    remove.type = "button";
    remove.className = "quiet";
    remove.textContent = "移除记录";
    remove.setAttribute("aria-label", "从阅读库移除《" + entry.title + "》");
    remove.addEventListener("click", async () => {
      remove.disabled = true;
      try {
        await callLibrary("remove", { id: entry.id });
        if (!library.hidden) {
          element("library-title").focus({ preventScroll: true });
        }
      } catch (error) {
        libraryStatus.textContent = error.message;
        remove.disabled = false;
      }
    });

    row.append(info, remove);
    rows.append(row);
  }

  libraryList.replaceChildren(rows);
  libraryStatus.textContent = entries.length ? "" : showFavorites
    ? "收藏的文章会显示在这里。"
    : "用听阅打开的文章会显示在这里。";
  if (focusedId) {
    element(focusedId)?.focus({ preventScroll: true });
  }
}

function filterLibrary(favorites) {
  showFavorites = favorites;
  element("show-history").setAttribute("aria-pressed", String(!favorites));
  element("show-favorites").setAttribute("aria-pressed", String(favorites));
  renderLibrary();
}

element("show-history").addEventListener("click", () => filterLibrary(false));
element("show-favorites").addEventListener("click", () => filterLibrary(true));
element("return-to-article").addEventListener("click", () => setLibraryVisible(false));
libraryButton.addEventListener("click", () => setLibraryVisible(library.hidden));

async function setLibraryVisible(visible) {
  library.hidden = !visible;
  reading.hidden = visible || !snapshot;
  notice.hidden = visible || !notice.textContent;
  libraryButton.setAttribute("aria-expanded", String(visible));
  element("return-to-article").hidden = !snapshot;
  if (!visible) {
    libraryButton.focus();
    if (highlightedIndex > 0) {
      paragraphNodes[highlightedIndex].scrollIntoView({ block: "nearest" });
    }
    return;
  }

  element("library-title").focus();
  libraryStatus.textContent = "正在读取本地阅读库…";
  try {
    allEntries = await callLibrary("list");
    renderLibrary();
  } catch (error) {
    libraryStatus.textContent = error.message;
  }
}

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== "local") {
    return;
  }
  if (changes[THEME_KEY]) {
    themePreference = changes[THEME_KEY].newValue;
    applyTheme();
  }
  if (changes[INDEX_KEY]) {
    allEntries = changes[INDEX_KEY].newValue ?? [];
    if (snapshot?.id) {
      updateFavorite(allEntries.find((entry) => entry.id === snapshot.id));
    }
    if (!library.hidden) {
      renderLibrary();
    }
  }
});

function renderHighlight(index, sentence) {
  if (index === highlightedIndex && sentence === highlightedSentence) {
    return;
  }

  const old = paragraphNodes[highlightedIndex];
  if (old) {
    old.classList.remove("is-current");
    if (highlightedSentence) {
      old.textContent = snapshot.paragraphs[highlightedIndex];
    }
  }

  const paragraph = paragraphNodes[index];
  if (paragraph) {
    paragraph.classList.add("is-current");
    if (sentence) {
      const text = snapshot.paragraphs[index];
      const mark = document.createElement("mark");
      mark.textContent = text.slice(sentence.start, sentence.end);
      paragraph.replaceChildren(text.slice(0, sentence.start), mark, text.slice(sentence.end));
    }
    if (index !== highlightedIndex && !reading.hidden) {
      paragraph.scrollIntoView({ block: "nearest" });
    }
  }

  highlightedIndex = index;
  highlightedSentence = sentence;
}

function updateControls({ state, index, sentence, completed, message, progressChanged }) {
  toggle.textContent = { idle: completed ? "重播" : "播放", playing: "暂停", paused: "继续" }[state];
  element("stop").disabled = state === "idle" && index === 0 && !completed;
  element("previous").disabled = index === 0;
  element("next").disabled = index === paragraphNodes.length - 1;
  progress.value = completed ? paragraphNodes.length : index;
  position.textContent = completed ? "已读完" : "第 " + (index + 1) + " / " + paragraphNodes.length + " 段";
  element("player-status").textContent = message;
  const showPosition = state !== "idle" || (index > 0 && !completed);
  renderHighlight(showPosition ? index : -1, showPosition ? sentence : null);

  if (progressChanged && activeEntry) {
    callLibrary("progress", { id: snapshot.id, version: snapshot.version, index, completed }).catch((error) => {
      storageStatus.textContent = error.message;
    });
  }
}

function renderArticle(article, entry) {
  snapshot = article;
  document.title = snapshot.title + " · 听阅";
  element("title").textContent = snapshot.title;
  element("source").textContent = snapshot.source;
  element("source").hidden = !snapshot.source;
  storageStatus.textContent = snapshot.libraryError ?? "";
  updateFavorite(entry);

  const content = element("paragraphs");
  if (snapshot.language) {
    content.lang = snapshot.language;
  }
  const paragraphs = document.createDocumentFragment();
  for (const text of snapshot.paragraphs) {
    const paragraph = document.createElement("p");
    paragraph.textContent = text;
    paragraphNodes.push(paragraph);
    paragraphs.append(paragraph);
  }
  content.append(paragraphs);

  notice.textContent = "";
  notice.hidden = true;
  reading.hidden = !library.hidden;

  if (!("speechSynthesis" in window) || !("SpeechSynthesisUtterance" in window)) {
    storageStatus.textContent = "当前浏览器环境不支持系统语音朗读。";
    return;
  }
  player.hidden = false;
  progress.max = paragraphNodes.length;
  const speech = new ParagraphSpeech(snapshot.paragraphs, snapshot.language, updateControls, activeEntry ?? {});
  toggle.addEventListener("click", () => speech.toggle());
  element("stop").addEventListener("click", () => speech.stop());
  element("previous").addEventListener("click", () => speech.move(-1));
  element("next").addEventListener("click", () => speech.move(1));

  const rate = element("rate");
  rate.addEventListener("input", () => {
    element("rate-value").value = rate.valueAsNumber.toFixed(1) + "×";
    speech.setRate(rate.valueAsNumber);
  });
  window.addEventListener("pagehide", () => speech.dispose());
}

async function loadArticle() {
  if (startsInLibrary) {
    notice.textContent = "从阅读库选择一篇文章，或在网页上点击听阅图标。";
    await setLibraryVisible(true);
    return;
  }

  if (location.hash === "#storage-error") {
    notice.textContent = "无法暂存正文。请关闭其他听阅阅读页后再试。";
    return;
  }

  const articleId = route.get("article");
  if (articleId) {
    const saved = await callLibrary("open", { id: articleId });
    if (!saved) {
      notice.textContent = "这篇文章已从阅读库移除。";
      return;
    }
    renderArticle(saved.snapshot, saved.entry);
    return;
  }

  const tab = await chrome.tabs.getCurrent();
  const key = "reader:" + tab?.id;
  const article = (await chrome.storage.session.get(key))[key];
  if (!article || article.error) {
    notice.textContent = article?.error ?? "阅读内容已失效。请返回原网页，再点击听阅图标。";
    return;
  }

  let entry = null;
  if (article.id) {
    try {
      entry = await callLibrary("entry", { id: article.id });
    } catch (error) {
      article.libraryError = error.message;
    }
  }
  renderArticle(article, entry);
}

chrome.storage.local.get(THEME_KEY).then((settings) => {
  themePreference = settings[THEME_KEY];
  applyTheme();
}).catch((error) => console.warn("无法读取主题设置", error));

loadArticle().catch((error) => {
  console.error("无法载入阅读页", error);
  notice.textContent = "无法加载阅读内容。请返回原网页后重试。";
  notice.hidden = !library.hidden;
});