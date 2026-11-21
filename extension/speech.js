const MAX_CHUNK_LENGTH = 180;
const sentenceSegmenter = new Intl.Segmenter(undefined, { granularity: "sentence" });

function sentenceRanges(paragraph) {
  return Array.from(sentenceSegmenter.segment(paragraph), ({ index, segment }) => ({
    start: index + segment.length - segment.trimStart().length,
    end: index + segment.trimEnd().length,
  })).filter(({ start, end }) => end > start);
}

function splitParagraph(paragraph, sentences) {
  const chunks = [];
  let pending = null;

  function addChunk(start, end) {
    const text = paragraph.slice(start, end);
    if (text.trim()) {
      chunks.push({ start: start + text.length - text.trimStart().length, text: text.trim() });
    }
  }

  for (const { start, end } of sentences) {
    if (pending && end - pending.start <= MAX_CHUNK_LENGTH) {
      pending.end = end;
      continue;
    }
    if (pending) {
      addChunk(pending.start, pending.end);
      pending = null;
    }
    if (end - start <= MAX_CHUNK_LENGTH) {
      pending = { start, end };
      continue;
    }

    for (let cursor = start; cursor < end;) {
      let boundary = Math.min(cursor + MAX_CHUNK_LENGTH, end);
      if (boundary < end) {
        const wordBreak = paragraph.lastIndexOf(" ", boundary);
        if (wordBreak > cursor + MAX_CHUNK_LENGTH / 2) {
          boundary = wordBreak + 1;
        } else if (/[\uD800-\uDBFF]/.test(paragraph[boundary - 1])) {
          boundary -= 1;
        }
      }
      addChunk(cursor, boundary);
      cursor = boundary;
    }
  }

  if (pending) {
    addChunk(pending.start, pending.end);
  }
  return chunks;
}

function normalizeLanguage(language) {
  return language?.trim().toLowerCase().replaceAll("_", "-") || "";
}

function findLocalVoice(synthesis, language) {
  const voices = synthesis.getVoices().filter((voice) => voice.localService);
  const articleLanguage = normalizeLanguage(language);
  const hasArticleLanguage = Boolean(articleLanguage && articleLanguage !== "und");
  const preferred = hasArticleLanguage ? articleLanguage : normalizeLanguage(navigator.language);
  const primary = preferred.split("-")[0];

  const exactMatch = voices.find((voice) => normalizeLanguage(voice.lang) === preferred);
  const languageMatch = voices.find((voice) => normalizeLanguage(voice.lang).split("-")[0] === primary);
  const fallback = hasArticleLanguage ? null : voices.find((voice) => voice.default) ?? voices[0];
  return exactMatch ?? languageMatch ?? fallback;
}

export class ParagraphSpeech {
  constructor(paragraphs, language, onChange, resume = {}) {
    this.paragraphs = paragraphs;
    this.language = language;
    this.onChange = onChange;
    this.synthesis = window.speechSynthesis;
    this.state = "idle";
    this.rate = 1;
    this.active = null;
    this.voice = null;

    const index = Number.isInteger(resume.index)
      ? Math.max(0, Math.min(resume.index, paragraphs.length - 1))
      : 0;
    this.completed = resume.completed === true && index === paragraphs.length - 1;
    this.setPosition(index);
    this.synthesis.getVoices();
    this.publish(this.completed ? "上次已读完" : index > 0 ? "已找到上次的朗读位置" : "准备就绪");
  }

  toggle() {
    switch (this.state) {
      case "playing":
        this.state = "paused";
        this.synthesis.pause();
        this.publish("已暂停");
        break;
      case "paused":
        this.state = "playing";
        this.publish("正在朗读");
        if (this.active) {
          this.synthesis.resume();
        } else {
          this.speakCurrentChunk();
        }
        break;
      default:
        this.start();
    }
  }

  start() {
    this.voice = findLocalVoice(this.synthesis, this.language);
    if (!this.voice) {
      this.publish("未找到匹配的本机语音。请检查系统语言设置中的语音包，再点击播放。");
      return;
    }

    const replaying = this.completed;
    if (replaying) {
      this.completed = false;
      this.setPosition(0);
    }
    this.paragraphRate = this.rate;
    this.state = "playing";
    this.publish("正在朗读", replaying);
    this.speakCurrentChunk();
  }

  stop() {
    const resetProgress = this.index > 0 || this.completed;
    this.cancelCurrent();
    this.state = "idle";
    this.completed = false;
    this.setPosition(0);
    this.publish("已停止", resetProgress);
  }

  dispose() {
    this.cancelCurrent();
  }

  move(offset) {
    const target = this.index + offset;
    if (target < 0 || target >= this.paragraphs.length) {
      return;
    }

    this.cancelCurrent();
    this.completed = false;
    this.setPosition(target);

    if (this.state === "playing") {
      this.publish("正在朗读", true);
      this.speakCurrentChunk();
    } else if (this.state === "paused") {
      this.publish("已暂停，继续后从所选段落开始", true);
    } else {
      this.publish("已切换段落", true);
    }
  }

  setRate(rate) {
    this.rate = rate;
    if (this.state === "idle") {
      this.paragraphRate = rate;
      this.publish("播放时将使用新语速");
    } else {
      this.publish("新语速将在下一段生效");
    }
  }

  setPosition(index) {
    this.index = index;
    this.sentences = sentenceRanges(this.paragraphs[index]);
    this.chunks = splitParagraph(this.paragraphs[index], this.sentences);
    this.chunkIndex = 0;
    this.paragraphRate = this.rate;
    this.sentence = null;
  }

  cancelCurrent() {
    this.active = null;
    this.synthesis.cancel();
    if (this.synthesis.paused) {
      this.synthesis.resume();
    }
  }

  speakCurrentChunk() {
    const chunk = this.chunks[this.chunkIndex];
    const utterance = new SpeechSynthesisUtterance(chunk.text);
    utterance.voice = this.voice;
    utterance.lang = this.voice.lang;
    utterance.rate = this.paragraphRate;
    this.active = utterance;
    if (this.sentence) {
      this.sentence = null;
      this.publish();
    }

    utterance.onboundary = (event) => {
      if (this.active !== utterance || !Number.isInteger(event.charIndex)
          || event.charIndex < 0 || event.charIndex >= chunk.text.length
          || !(event.name === "sentence" || (event.name === "word" && event.charIndex > 0))) {
        return;
      }
      const offset = chunk.start + event.charIndex;
      const range = this.sentences.find(({ start, end }) => offset >= start && offset < end);
      if (range && range !== this.sentence) {
        this.sentence = range;
        this.publish();
      }
    };

    utterance.onend = () => {
      if (this.active !== utterance) {
        return;
      }

      this.active = null;
      this.chunkIndex += 1;
      if (this.chunkIndex === this.chunks.length) {
        if (this.index === this.paragraphs.length - 1) {
          this.state = "idle";
          this.completed = true;
          this.sentence = null;
          this.publish("朗读完成", true);
          return;
        }
        this.setPosition(this.index + 1);
        this.publish(this.state === "playing" ? "正在朗读" : "已暂停", true);
      }

      if (this.state === "playing") {
        this.speakCurrentChunk();
      }
    };

    utterance.onerror = (event) => {
      if (this.active !== utterance) {
        return;
      }

      this.cancelCurrent();
      this.state = "idle";
      this.sentence = null;
      console.warn("系统朗读中断", event.error);
      this.publish("系统朗读中断。请检查本机语音设置后重试。");
    };

    this.synthesis.speak(utterance);
  }

  publish(message = this.message, progressChanged = false) {
    this.message = message;
    this.onChange({
      state: this.state,
      index: this.index,
      sentence: this.sentence,
      completed: this.completed,
      message,
      progressChanged,
    });
  }
}