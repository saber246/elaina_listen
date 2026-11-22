const SYNTHESIZE_URL = "http://127.0.0.1:43167/synthesize";
const CONNECTION_ERROR = "连接不到宵宫语音助手。请启动本机助手后重试，或切换回系统语音。";
const PLAYBACK_ERROR = "宵宫语音已合成，但音频播放失败。请重试或切换回系统语音。";

export class YoimiyaSpeech {
  maxChunkLength = 64;
  pendingMessage = "正在合成宵宫语音…";

  get paused() {
    return Boolean(this.current?.paused);
  }

  getVoices() {
    return [{ lang: "zh-CN", localService: true, default: true }];
  }

  createUtterance(text) {
    return { text };
  }

  speak(utterance) {
    const task = { utterance, controller: new AbortController(), paused: false };
    this.current = task;
    this.synthesize(task).catch(() => this.finish(task, CONNECTION_ERROR));
  }

  async synthesize(task) {
    const { utterance, controller } = task;
    const response = await fetch(SYNTHESIZE_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Elaina-Client": chrome.runtime.id },
      body: JSON.stringify({ text: utterance.text, rate: utterance.rate }),
      signal: AbortSignal.any([controller.signal, AbortSignal.timeout(30000)]),
      redirect: "error",
    });
    if (!response.ok) {
      const result = await response.json().catch(() => null);
      this.finish(task, result?.message || CONNECTION_ERROR);
      return;
    }
    if (!response.headers.get("Content-Type")?.startsWith("audio/wav")) {
      this.finish(task, PLAYBACK_ERROR);
      return;
    }
    const blob = await response.blob();
    if (this.current !== task) {
      return;
    }

    task.url = URL.createObjectURL(blob);
    const audio = task.audio = new Audio(task.url);
    audio.onplaying = () => {
      if (this.current === task && !task.started) {
        task.started = true;
        utterance.onstart?.({ duration: audio.duration });
      }
    };
    audio.onended = () => this.finish(task);
    audio.onerror = () => this.finish(task, PLAYBACK_ERROR);
    this.play(task);
  }

  play(task) {
    if (!task.audio || task.paused) {
      return;
    }

    const attempt = task.audio.play();
    task.playAttempt = attempt;
    attempt.catch(() => {
      if (task.playAttempt === attempt && !task.paused) {
        this.finish(task, PLAYBACK_ERROR);
      }
    });
  }

  pause() {
    if (this.current) {
      this.current.paused = true;
      this.current.audio?.pause();
    }
  }

  resume() {
    if (this.current) {
      this.current.paused = false;
      this.play(this.current);
    }
  }

  cancel() {
    const task = this.current;
    if (!task) {
      return;
    }

    this.current = null;
    task.controller.abort();
    if (task.audio) {
      task.audio.onplaying = null;
      task.audio.onended = null;
      task.audio.onerror = null;
      task.audio.pause();
      task.audio.removeAttribute("src");
    }
    if (task.url) {
      URL.revokeObjectURL(task.url);
    }
  }

  finish(task, message) {
    if (this.current !== task) {
      return;
    }

    this.cancel();
    if (message) {
      task.utterance.onerror?.({ error: "local-tts", message });
    } else {
      task.utterance.onend?.();
    }
  }
}
