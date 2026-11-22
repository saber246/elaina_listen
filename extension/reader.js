import { INDEX_KEY, THEME_KEY } from "./library.js";
import { ParagraphSpeech } from "./speech.js";
import { createTimeline } from "./timeline.js";
import { bindVoicePacks } from "./voice-packs.js";

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
let timeline;
let speech;
let timelineRate = 1;
let timelineTimer;
let previewing = false;

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
  themeButton.textContent = dark ? "浅色" : "深色";
  themeButton.setAttribute("aria-label", dark ? "切换到浅色模式" : "切换到深色模式");
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
    : "用 elaina listen 打开的文章会显示在这里。";
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

function formatClock(seconds) {
  const minutes = Math.floor(seconds / 60);
  const remainder = String(seconds % 60).padStart(2, "0");
  return minutes + ":" + remainder;
}

function renderTimeline(time, completed, preview = false) {
  const total = Math.max(1, Math.ceil(timeline.duration / timelineRate));
  const elapsed = completed ? total : Math.min(total - 1, Math.floor(time / timelineRate));
  const left = completed ? 0 : Math.max(1, Math.ceil((timeline.duration - time) / timelineRate));
  if (!preview) {
    progress.max = total;
    const value = Math.round(time / timeline.duration * total);
    progress.value = completed ? total : Math.min(total - 1, value);
  }
  element("elapsed-time").textContent = (preview ? "跳到 " : "已听 ") + formatClock(elapsed);
  element("total-time").textContent = "预计总时长 " + formatClock(total) + "（" + total + " 秒）";
  element("remaining-time").textContent = "约剩 " + formatClock(left);
  progress.setAttribute("aria-valuetext", formatClock(elapsed) + "，预计总计 " + total + " 秒");
}

function refreshTimeline() {
  if (!previewing && speech) {
    renderTimeline(timeline.timeAt(speech.index, speech.offset), speech.completed);
  }
}

function stopTimelineTimer() {
  clearInterval(timelineTimer);
  timelineTimer = undefined;
}

function updateControls({ state, index, offset, sentence, completed, message, progressChanged }) {
  toggle.textContent = { idle: completed ? "重播" : "播放", playing: "暂停", paused: "继续" }[state];
  element("stop").disabled = state === "idle" && index === 0 && offset === 0 && !completed;
  element("previous").disabled = index === 0;
  element("next").disabled = index === paragraphNodes.length - 1;
  if (!previewing) {
    renderTimeline(timeline.timeAt(index, offset), completed);
  }
  if (state === "playing") {
    timelineTimer ??= setInterval(refreshTimeline, 250);
  } else {
    stopTimelineTimer();
  }
  position.textContent = completed ? "已读完" : "第 " + (index + 1) + " / " + paragraphNodes.length + " 段";
  element("player-status").textContent = message;
  const showPosition = state !== "idle" || (!completed && (index > 0 || offset > 0));
  renderHighlight(showPosition ? index : -1, showPosition ? sentence : null);

  if (progressChanged && activeEntry) {
    callLibrary("progress", { id: snapshot.id, version: snapshot.version, index, offset, completed }).catch((error) => {
      storageStatus.textContent = error.message;
    });
  }
}

function bindParagraphPlayback(content) {
  const holdDelay = 500;
  const movementLimit = 8;
  const hint = element("paragraph-hold-hint");
  let press;
  let releasedTouch;

  function hasSelection() {
    return window.getSelection()?.isCollapsed === false;
  }

  function withinLimit(event, held) {
    return Math.hypot(event.clientX - held.x, event.clientY - held.y) <= movementLimit;
  }

  function cancelIfSelected() {
    if (hasSelection()) {
      cancelPress();
    }
  }

  function cancelPress() {
    if (!press) {
      return;
    }
    clearTimeout(press.timer);
    press = undefined;
    hint.hidden = true;
    window.removeEventListener("scroll", cancelPress, true);
    window.removeEventListener("blur", cancelPress);
    document.removeEventListener("selectionchange", cancelIfSelected);
  }

  function cancelPointer(event) {
    if (event.pointerId === press?.pointerId) {
      cancelPress();
    }
  }

  content.addEventListener("pointerdown", (event) => {
    cancelPress();
    releasedTouch = undefined;
    if (!event.isPrimary || event.button !== 0 || hasSelection()) {
      return;
    }

    const paragraph = event.target.closest("#paragraphs p");
    const index = paragraphNodes.indexOf(paragraph);
    if (index < 0) {
      return;
    }

    const { clientX: x, clientY: y } = event;
    const caret = document.caretRangeFromPoint?.(x, y);
    if (!caret || !paragraph.contains(caret.startContainer)) {
      return;
    }
    const prefix = document.createRange();
    prefix.selectNodeContents(paragraph);
    prefix.setEnd(caret.startContainer, caret.startOffset);

    const shortcut = event.pointerType === "mouse" && event.altKey;
    const held = {
      paragraph, index, offset: prefix.toString().length, x, y, shortcut,
      pointerId: event.pointerId, pointerType: event.pointerType, armed: shortcut,
    };
    press = held;
    window.addEventListener("scroll", cancelPress, { capture: true, passive: true });
    window.addEventListener("blur", cancelPress);
    document.addEventListener("selectionchange", cancelIfSelected);

    if (!shortcut) {
      held.timer = setTimeout(() => {
        if (press !== held || hasSelection()) {
          cancelIfSelected();
          return;
        }
        held.armed = true;
        hint.hidden = false;
        const above = y - hint.offsetHeight - 12;
        const top = above >= 8 ? above : Math.min(y + 12, window.innerHeight - hint.offsetHeight - 8);
        const left = Math.min(x + 12, window.innerWidth - hint.offsetWidth - 8);
        hint.style.top = Math.max(8, top) + "px";
        hint.style.left = Math.max(8, left) + "px";
      }, holdDelay);
    }
  });

  content.addEventListener("pointermove", (event) => {
    if (event.pointerId === press?.pointerId && !withinLimit(event, press)) {
      cancelPress();
    }
  });

  content.addEventListener("pointerup", (event) => {
    const held = press;
    if (!held || event.pointerId !== held.pointerId) {
      return;
    }
    cancelPress();
    if (!held.armed || event.button !== 0 || !withinLimit(event, held)
        || hasSelection() || (held.shortcut && !event.altKey)) {
      return;
    }
    if (held.pointerType === "touch") {
      releasedTouch = { ...held, expiresAt: performance.now() + holdDelay };
    }
    speech.playFrom(held.index, held.offset);
  });

  content.addEventListener("pointerleave", cancelPointer);
  content.addEventListener("pointercancel", cancelPointer);

  content.addEventListener("contextmenu", (event) => {
    const touchMenu = event.pointerType === "touch" || event.sourceCapabilities?.firesTouchEvents;
    if (!touchMenu || hasSelection()) {
      return;
    }
    const held = press ?? releasedTouch;
    if (held?.pointerType === "touch"
        && (held === press || performance.now() <= held.expiresAt)
        && event.target.closest("#paragraphs p") === held.paragraph && withinLimit(event, held)) {
      event.preventDefault();
    }
  });
}

function renderArticle(article, entry) {
  snapshot = article;
  document.title = snapshot.title + " · elaina listen";
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
  timeline = createTimeline(snapshot.paragraphs);
  speech = new ParagraphSpeech(snapshot.paragraphs, snapshot.language, updateControls, activeEntry ?? {});
  bindParagraphPlayback(content);
  bindVoicePacks(speech, snapshot.language);
  toggle.addEventListener("click", () => speech.toggle());
  element("stop").addEventListener("click", () => speech.stop());
  element("previous").addEventListener("click", () => speech.move(-1));
  element("next").addEventListener("click", () => speech.move(1));

  function targetTime() {
    return timeline.duration * (progress.valueAsNumber / Number(progress.max));
  }

  progress.addEventListener("input", () => {
    previewing = true;
    const time = targetTime();
    renderTimeline(time, time === timeline.duration, true);
  });
  progress.addEventListener("change", () => {
    const target = timeline.positionAt(targetTime());
    previewing = false;
    speech.seek(target.index, target.offset, target.completed);
  });
  progress.addEventListener("pointercancel", () => {
    previewing = false;
    refreshTimeline();
  });

  const rate = element("rate");
  rate.addEventListener("input", () => {
    timelineRate = rate.valueAsNumber;
    element("rate-value").value = timelineRate.toFixed(1) + "×";
    speech.setRate(timelineRate);
  });
  window.addEventListener("pagehide", () => {
    stopTimelineTimer();
    speech.dispose();
  });
}

async function loadArticle() {
  if (startsInLibrary) {
    notice.textContent = "从阅读库选择一篇文章，或在网页上点击 elaina listen 图标。";
    await setLibraryVisible(true);
    return;
  }

  if (location.hash === "#storage-error") {
    notice.textContent = "无法暂存正文。请关闭其他 elaina listen 阅读页后再试。";
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
    notice.textContent = article?.error ?? "阅读内容已失效。请返回原网页，再点击 elaina listen 图标。";
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
