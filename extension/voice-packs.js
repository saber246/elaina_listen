import { callVoiceAssistant, CONNECTION_ERROR, LocalSpeech } from "./yoimiya-speech.js";

const MIB = 1024 ** 2;

export function bindVoicePacks(speech, articleLanguage) {
  const select = document.getElementById("voice");
  const dialog = document.getElementById("voice-packs");
  const list = document.getElementById("voice-pack-list");
  const status = document.getElementById("voice-pack-status");
  const refresh = document.getElementById("refresh-voice-packs");
  let available = new Map();
  let pending = false;
  let timer;

  function selectVoice(id) {
    const pack = available.get(id);
    select.value = pack?.id ?? "system";
    speech.setEngine(pack ? new LocalSpeech(pack) : window.speechSynthesis,
      pack?.language ?? articleLanguage);
  }

  function renderPacks(packs) {
    available = new Map(packs.filter((pack) => pack.ready).map((pack) => [pack.id, pack]));
    const previous = select.value;
    select.replaceChildren(
      new Option("系统语音", "system"),
      ...Array.from(available.values(), (pack) => new Option(pack.name, pack.id)),
    );
    if (previous === "system" || available.has(previous)) {
      select.value = previous;
    } else {
      selectVoice("system");
    }

    const downloading = packs.some((pack) => pack.status === "downloading");
    const entries = packs.map((pack) => {
      const item = document.createElement("li");
      const text = document.createElement("div");
      const name = document.createElement("strong");
      const detail = document.createElement("div");
      const button = document.createElement("button");
      name.textContent = pack.name;
      detail.className = "status";
      detail.textContent = pack.message || (pack.ready ? "已就绪" : "仅本地使用");
      button.type = "button";
      button.className = "quiet";
      if (pack.ready) {
        button.textContent = "使用";
        button.addEventListener("click", () => {
          if (select.value !== pack.id) {
            selectVoice(pack.id);
          }
          dialog.close();
        });
      } else if (pack.status === "downloading") {
        const percent = Math.floor(pack.received * 100 / pack.size);
        detail.textContent = percent < 100 ? `正在下载 ${percent}%` : "正在安装…";
      } else if (pack.size) {
        if (!pack.message) {
          detail.textContent = `${Math.round(pack.size / MIB)} MiB`;
        }
        button.textContent = pack.status === "error" ? "重试" : "下载";
        button.disabled = downloading;
        button.addEventListener("click", () => update("/voices/install", { voice: pack.id }));
      }
      text.append(name, detail);
      item.append(text);
      if (button.textContent) {
        item.append(button);
      }
      return item;
    });
    list.replaceChildren(...entries);
    if (dialog.open && downloading) {
      timer = setTimeout(update, 1000);
    }
  }

  async function update(path = "/voices/list", data = {}) {
    if (pending) {
      return;
    }
    pending = true;
    clearTimeout(timer);
    refresh.disabled = true;
    try {
      const response = await callVoiceAssistant(path, data);
      const body = await response.json();
      if (!response.ok || !Array.isArray(body.packs)) {
        status.textContent = response.status === 409 ? body.message
          : "请使用 start-voice-packs.cmd 启动新版语音助手，再刷新。";
        if (response.status === 409 && dialog.open) {
          timer = setTimeout(update, 1000);
        }
        return;
      }
      status.textContent = "";
      renderPacks(body.packs);
    } catch {
      status.textContent = CONNECTION_ERROR + " 启动入口为 desktop/start-voice-packs.cmd。";
    } finally {
      refresh.disabled = false;
      pending = false;
    }
  }

  select.addEventListener("change", () => selectVoice(select.value));
  document.getElementById("show-voice-packs").addEventListener("click", () => {
    dialog.showModal();
    update();
  });
  refresh.addEventListener("click", () => update());
  dialog.addEventListener("close", () => clearTimeout(timer));
  update();
}
