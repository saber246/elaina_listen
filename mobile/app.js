import { addEntry, listEntries, readEntry, removeEntry, updateEntry } from "./library.js";
import { createTimeline } from "../extension/timeline.js";

const byId = (id) => document.getElementById(id);
const library = byId("library");
const reader = byId("reader");
const notice = byId("notice");
const paragraphsBox = byId("paragraphs");
const speechPanel = byId("speech-player");
const audioPanel = byId("audio-player");
const audio = byId("audio");
const favorite = byId("favorite");
const seek = byId("seek");
const rate = byId("rate");

let filter = "all";
let active;
let view = 0;
let installPrompt;

function showNotice(message = "") {
  notice.textContent = message;
  notice.hidden = !message;
}

function formatTime(seconds) {
  const time = Math.max(0, Math.floor(seconds));
  return Math.floor(time / 60) + ":" + String(time % 60).padStart(2, "0");
}

function description(entry) {
  const type = entry.kind === "text" ? "文章" : "音频";
  if (entry.progress.completed) return type + " · 已听完";
  const { index, offset, time } = entry.progress;
  if (entry.kind === "text" && (index > 0 || offset > 0)) return type + " · 第 " + (index + 1) + " 段";
  if (entry.kind === "audio" && time > 0) return type + " · 已听 " + formatTime(time);
  return type;
}

async function renderLibrary() {
  const entries = await listEntries();
  if (library.hidden) return;
  const shown = entries.filter((entry) => filter === "all"
    || (filter === "favorite" ? entry.favorite : filter === entry.kind));
  const rows = shown.map((entry) => {
    const row = document.createElement("li");
    const link = document.createElement("a");
    link.href = "#read/" + entry.id;
    const icon = document.createElement("span");
    icon.className = "kind";
    icon.setAttribute("aria-hidden", "true");
    icon.textContent = entry.kind === "text" ? "文" : "音";
    const detail = document.createElement("span");
    detail.className = "entry-detail";
    const title = document.createElement("strong");
    title.textContent = entry.title;
    const info = document.createElement("small");
    info.textContent = description(entry);
    detail.append(title, info);
    link.append(icon, detail);
    if (entry.favorite) {
      const saved = document.createElement("span");
      saved.className = "saved";
      saved.textContent = "已收藏";
      link.append(saved);
    }
    row.append(link);
    return row;
  });
  byId("entries").replaceChildren(...rows);
  byId("empty").hidden = shown.length > 0;
  byId("empty").textContent = filter === "all" ? "添加第一篇文章或音频，开始阅读。" : "这个分类还没有内容。";
}

function storeProgress(session, progress) {
  if (session.savedProgress === JSON.stringify(progress)) return;
  session.savedProgress = JSON.stringify(progress);
  updateEntry(session.entry.id, { progress }).catch(() => {
    session.savedProgress = undefined;
    if (active === session) showNotice("阅读位置保存失败，请检查浏览器的本地存储。");
  });
}

function closeReader() {
  if (!active) return;
  const session = active;
  active = undefined;
  session.save?.();
  session.dispose?.();
}

function updateFavorite(value) {
  favorite.setAttribute("aria-pressed", String(value));
  favorite.textContent = value ? "已收藏" : "收藏";
}

async function route() {
  closeReader();
  showNotice();
  reader.hidden = true;
  speechPanel.hidden = true;
  audioPanel.hidden = true;
  paragraphsBox.hidden = true;
  paragraphsBox.replaceChildren();
  const version = ++view;
  const id = /^#read\/([a-f0-9-]+)$/i.exec(location.hash)?.[1];
  if (!id) {
    library.hidden = false;
    window.scrollTo(0, 0);
    await renderLibrary();
    return;
  }
  library.hidden = true;
  const item = await readEntry(id);
  if (version !== view) return;
  if (!item) {
    history.replaceState(null, "", location.pathname + location.search);
    library.hidden = false;
    await renderLibrary();
    showNotice("这条内容已从阅读库移除。");
    return;
  }
  const session = { entry: item.entry, savedProgress: JSON.stringify(item.entry.progress) };
  active = session;
  byId("reader-title").textContent = item.entry.title;
  updateFavorite(item.entry.favorite);
  reader.hidden = false;
  window.scrollTo(0, 0);
  byId("reader-title").focus({ preventScroll: true });
  if (item.entry.kind === "text") {
    await openArticle(session, item.content);
  } else {
    openAudio(session, item.content);
  }
}

function languageFor(text) {
  const sample = text.slice(0, 2000);
  if (/[\p{Script=Hiragana}\p{Script=Katakana}]/u.test(sample)) return "ja";
  if (/\p{Script=Hangul}/u.test(sample)) return "ko";
  if (/\p{Script=Han}/u.test(sample)) return "zh-CN";
  return "";
}

async function openArticle(session, text) {
  const paragraphs = text.split(/\n+/).map((line) => line.trim()).filter(Boolean);
  const content = document.createDocumentFragment();
  const nodes = paragraphs.map((body) => {
    const node = document.createElement("p");
    node.textContent = body;
    content.append(node);
    return node;
  });
  paragraphsBox.append(content);
  paragraphsBox.hidden = false;

  if (!window.speechSynthesis || !window.SpeechSynthesisUtterance || !Intl.Segmenter) {
    showNotice("当前浏览器无法使用文字朗读，文章和本地音频仍可打开。");
    return;
  }
  const { ParagraphSpeech } = await import("../extension/speech.js");
  if (active !== session) return;

  const timeline = createTimeline(paragraphs);
  let selectedRate = Number(rate.value);
  let controller;
  let lastState;
  let timer;
  let previewing = false;
  let activeIndex = -1;
  let activeSentence;

  function renderHighlight(index, sentence, state) {
    const nextIndex = state === "idle" ? -1 : index;
    if (nextIndex === activeIndex && sentence === activeSentence) return;
    const previous = nodes[activeIndex];
    if (previous) {
      previous.classList.remove("current");
      if (activeSentence) previous.textContent = paragraphs[activeIndex];
    }
    const current = nodes[nextIndex];
    if (current) {
      current.classList.add("current");
      if (sentence) {
        const text = paragraphs[nextIndex];
        const mark = document.createElement("mark");
        mark.textContent = text.slice(sentence.start, sentence.end);
        current.replaceChildren(text.slice(0, sentence.start), mark, text.slice(sentence.end));
      }
      if (nextIndex !== activeIndex) current.scrollIntoView({ block: "nearest" });
    }
    activeIndex = nextIndex;
    activeSentence = sentence;
  }

  function refresh() {
    const current = controller ?? lastState;
    if (!current || previewing) return;
    const seconds = timeline.timeAt(current.index, current.offset);
    const remaining = current.completed ? 0 : Math.max(1, Math.ceil((timeline.duration - seconds) / selectedRate));
    seek.max = Math.max(1, Math.ceil(timeline.duration / selectedRate));
    seek.value = current.completed ? seek.max : Math.min(Number(seek.max) - 1, Math.round(seconds / selectedRate));
    seek.setAttribute("aria-valuetext", "第 " + (current.index + 1) + " 段，约剩 " + formatTime(remaining));
    byId("position").textContent = "第 " + (current.index + 1) + " / " + paragraphs.length + " 段";
    byId("remaining").textContent = current.completed ? "已听完" : "约剩 " + formatTime(remaining);
  }

  function draw(state) {
    lastState = state;
    byId("toggle").textContent = state.state === "playing" ? "暂停"
      : state.state === "paused" ? "继续" : state.completed ? "重播" : "播放";
    byId("previous").disabled = state.index === 0;
    byId("next").disabled = state.index === paragraphs.length - 1;
    byId("speech-status").textContent = state.message;
    renderHighlight(state.index, state.sentence, state.state);
    if (state.state === "playing") {
      timer ??= setInterval(refresh, 350);
    } else {
      clearInterval(timer);
      timer = undefined;
    }
    refresh();
    if (state.progressChanged) session.save?.();
  }

  controller = new ParagraphSpeech(paragraphs, languageFor(text), draw, session.entry.progress);
  controller.setRate(selectedRate);
  speechPanel.hidden = false;
  if (controller.index > 0 && !controller.completed) nodes[controller.index].scrollIntoView({ block: "start" });

  byId("toggle").onclick = () => controller.toggle();
  byId("previous").onclick = () => controller.move(-1);
  byId("next").onclick = () => controller.move(1);
  rate.onchange = () => {
    selectedRate = Number(rate.value);
    controller.setRate(selectedRate);
  };
  seek.oninput = () => {
    previewing = true;
    byId("remaining").textContent = "定位到 " + formatTime(Number(seek.value));
    seek.setAttribute("aria-valuetext", "定位到 " + formatTime(Number(seek.value)));
  };
  seek.onchange = () => {
    previewing = false;
    const time = Number(seek.value) === Number(seek.max) ? timeline.duration : Number(seek.value) * selectedRate;
    const target = timeline.positionAt(time);
    controller.seek(target.index, target.offset, target.completed);
  };
  seek.onpointercancel = () => {
    previewing = false;
    refresh();
  };

  session.save = () => storeProgress(session, {
    index: controller.index,
    offset: Math.floor(controller.offset),
    completed: controller.completed,
  });
  session.dispose = () => {
    clearInterval(timer);
    controller.dispose();
  };
}

function openAudio(session, blob) {
  audioPanel.hidden = false;
  if (!(blob instanceof Blob)) {
    byId("audio-status").textContent = "找不到这段本地音频，请重新导入。";
    return;
  }
  const source = URL.createObjectURL(blob);
  const saved = session.entry.progress;
  let restored = false;
  let interacted = false;
  let lastSaved = saved.time ?? 0;
  byId("audio-status").textContent = "音频已保存在本机，可离线播放。";

  audio.onloadedmetadata = () => {
    if (!saved.completed && saved.time > 0 && Number.isFinite(audio.duration)) {
      audio.currentTime = Math.min(saved.time, Math.max(0, audio.duration - 0.1));
    }
    restored = true;
  };
  session.save = () => {
    if (!restored || (saved.completed && !interacted)) return;
    lastSaved = Math.floor(audio.currentTime);
    storeProgress(session, { time: lastSaved, completed: audio.ended });
  };
  audio.ontimeupdate = () => {
    if (Math.abs(audio.currentTime - lastSaved) >= 5) session.save();
  };
  audio.onplay = () => { interacted = true; };
  audio.onpause = session.save;
  audio.onseeked = () => {
    interacted = true;
    session.save();
  };
  audio.onended = session.save;
  audio.onerror = () => { byId("audio-status").textContent = "当前浏览器无法播放这个音频格式。"; };
  audio.src = source;
  session.dispose = () => {
    audio.onloadedmetadata = audio.ontimeupdate = audio.onpause = null;
    audio.onplay = audio.onseeked = audio.onended = audio.onerror = null;
    audio.pause();
    audio.removeAttribute("src");
    audio.load();
    URL.revokeObjectURL(source);
  };
}

async function importText(title, text) {
  const body = text.replace(/\r\n?/g, "\n").trim();
  if (!body) throw new Error("请输入文章正文。");
  const label = title.trim() || body.split("\n")[0].slice(0, 60);
  const entry = await addEntry("text", label, body);
  location.hash = "read/" + entry.id;
}

async function decodeText(file) {
  const bytes = new Uint8Array(await file.arrayBuffer());
  if (bytes[0] === 0xff && bytes[1] === 0xfe) return new TextDecoder("utf-16le").decode(bytes);
  if (bytes[0] === 0xfe && bytes[1] === 0xff) return new TextDecoder("utf-16be").decode(bytes);
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return new TextDecoder("gb18030").decode(bytes);
  }
}

const audioTypes = { mp3: "audio/mpeg", m4a: "audio/mp4", aac: "audio/aac",
  wav: "audio/wav", ogg: "audio/ogg", opus: "audio/ogg", flac: "audio/flac" };

byId("pick-file").onclick = () => byId("file").click();
byId("file").onchange = async (event) => {
  const file = event.target.files[0];
  event.target.value = "";
  if (!file) return;
  try {
    const extension = file.name.split(".").pop().toLowerCase();
    const title = file.name.replace(/\.[^.]+$/, "") || file.name;
    if (extension === "txt") {
      await importText(title, await decodeText(file));
    } else if (file.type.startsWith("audio/") || Object.hasOwn(audioTypes, extension)) {
      if (file.size === 0) throw new Error("音频文件为空。");
      const mime = file.type.startsWith("audio/") ? file.type : audioTypes[extension];
      const entry = await addEntry("audio", title, file.slice(0, file.size, mime));
      location.hash = "read/" + entry.id;
    } else {
      showNotice("请选择 TXT 或音频文件。");
    }
  } catch (error) {
    showNotice(error.name === "QuotaExceededError" ? "本地空间不足，无法导入文件。" : error.message);
  }
};

const pasteDialog = byId("paste-dialog");
const pasteError = byId("paste-error");
byId("paste").onclick = () => {
  pasteError.hidden = true;
  pasteDialog.showModal();
};
byId("paste-form").onsubmit = async (event) => {
  event.preventDefault();
  const save = byId("save-article");
  save.disabled = true;
  try {
    await importText(byId("article-title").value, byId("article-text").value);
    event.target.reset();
    pasteDialog.close();
  } catch (error) {
    pasteError.textContent = error.message;
    pasteError.hidden = false;
  } finally {
    save.disabled = false;
  }
};

byId("filters").onclick = (event) => {
  const filterButton = event.target.closest("[data-filter]");
  if (!filterButton) return;
  filter = filterButton.dataset.filter;
  for (const button of byId("filters").querySelectorAll("button")) {
    button.setAttribute("aria-pressed", String(button === filterButton));
  }
  renderLibrary().catch(renderError);
};

favorite.onclick = async () => {
  const session = active;
  if (!session) return;
  favorite.disabled = true;
  try {
    const updated = await updateEntry(session.entry.id, { favorite: !session.entry.favorite });
    if (active === session && updated) {
      session.entry = updated;
      updateFavorite(updated.favorite);
    }
  } catch (error) {
    renderError(error);
  } finally {
    favorite.disabled = false;
  }
};

byId("remove").onclick = () => byId("remove-dialog").showModal();
byId("confirm-remove").onclick = async (event) => {
  const session = active;
  if (!session) return;
  const button = event.currentTarget;
  button.disabled = true;
  try {
    await removeEntry(session.entry.id);
    byId("remove-dialog").close();
    if (active === session) location.hash = "";
  } catch (error) {
    byId("remove-dialog").close();
    renderError(error);
  } finally {
    button.disabled = false;
  }
};

for (const button of document.querySelectorAll("[data-close]")) {
  button.onclick = () => byId(button.dataset.close).close();
}

const systemDark = matchMedia("(prefers-color-scheme: dark)");
const themeButton = byId("theme");
let chosenTheme;
try { chosenTheme = localStorage.getItem("elaina-mobile-theme"); } catch {}

function renderTheme() {
  const dark = (chosenTheme ?? (systemDark.matches ? "dark" : "light")) === "dark";
  document.documentElement.dataset.theme = dark ? "dark" : "light";
  themeButton.textContent = dark ? "浅色" : "深色";
  document.querySelector('meta[name="theme-color"]').content = dark ? "#181622" : "#f6f4fb";
}
themeButton.onclick = () => {
  chosenTheme = document.documentElement.dataset.theme === "dark" ? "light" : "dark";
  try { localStorage.setItem("elaina-mobile-theme", chosenTheme); } catch {}
  renderTheme();
};
systemDark.addEventListener("change", renderTheme);
renderTheme();

const standalone = matchMedia("(display-mode: standalone)");
const install = byId("install");
function updateInstall() {
  install.hidden = standalone.matches || navigator.standalone === true;
}
updateInstall();
standalone.addEventListener("change", updateInstall);
window.addEventListener("beforeinstallprompt", (event) => {
  event.preventDefault();
  installPrompt = event;
});
window.addEventListener("appinstalled", () => { install.hidden = true; installPrompt = undefined; });
install.onclick = async () => {
  if (!installPrompt) {
    byId("install-dialog").showModal();
    return;
  }
  const prompt = installPrompt;
  installPrompt = undefined;
  try {
    await prompt.prompt();
  } catch {
    byId("install-dialog").showModal();
  }
};

const offline = byId("offline-status");
if ("serviceWorker" in navigator) {
  offline.textContent = "正在准备离线资源…";
  navigator.serviceWorker.register("./sw.js").then((registration) => {
    registration.installing?.addEventListener("statechange", (event) => {
      if (event.target.state === "redundant" && !registration.active) {
        offline.textContent = "离线资源准备失败，请联网刷新。";
      }
    });
    return navigator.serviceWorker.ready;
  }).then(() => {
    offline.textContent = "离线资源已就绪";
  }).catch(() => {
    offline.textContent = "离线资源准备失败，请联网刷新。";
  });
} else {
  offline.textContent = "使用 HTTPS 打开可安装并离线使用。";
}

function renderError(error) {
  console.error(error);
  showNotice("暂时无法访问本地阅读库，请刷新后重试。");
}

window.addEventListener("hashchange", () => route().catch(renderError));
window.addEventListener("pagehide", closeReader);
window.addEventListener("pageshow", (event) => {
  if (event.persisted) route().catch(renderError);
});
document.addEventListener("visibilitychange", () => {
  if (document.hidden) active?.save?.();
});

route().catch(renderError);