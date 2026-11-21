import { estimateSpeechSeconds } from "./timeline.js";

const MAX_CHUNK_LENGTH = 180;
const MISSING_VOICE_MESSAGE = "未找到匹配的本机语音。请检查系统语言设置中的语音包，再点击播放。";
const sentenceSegmenter = new Intl.Segmenter(undefined, { granularity: "sentence" });
const wordSegmenter = new Intl.Segmenter(undefined, { granularity: "word" });
const graphemeSegmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });

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
    this.setPosition(index, resume.offset);
    this.synthesis.getVoices();
    const resumed = index > 0 || this.offset > 0;
    this.publish(this.completed ? "上次已读完" : resumed ? "已找到上次的朗读位置" : "准备就绪");
  }

  toggle() {
    switch (this.state) {
      case "playing":
        this.offsetAtStart = this.offset;
        this.startedAt = null;
        this.state = "paused";
        this.synthesis.pause();
        this.publish("已暂停", true);
        break;
      case "paused":
        this.state = "playing";
        this.publish("正在朗读");
        if (this.active) {
          this.startedAt = this.hasStarted ? performance.now() : null;
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
      this.publish(MISSING_VOICE_MESSAGE);
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

  playFrom(index, offset) {
    const voice = findLocalVoice(this.synthesis, this.language);
    if (!voice) {
      if (this.state !== "idle") {
        this.cancelCurrent();
        this.state = "idle";
        this.sentence = null;
      }
      this.publish(MISSING_VOICE_MESSAGE);
      return;
    }

    this.cancelCurrent();
    this.voice = voice;
    this.completed = false;
    this.setPosition(index, offset);
    this.state = "playing";
    this.publish("正在朗读", true);
    this.speakCurrentChunk();
  }

  stop() {
    const resetProgress = this.index > 0 || this.offset > 0 || this.completed;
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

    this.seek(target, 0);
  }

  seek(index, offset, completed = false) {
    this.cancelCurrent();
    this.completed = completed;
    this.setPosition(index, offset);
    if (completed) {
      this.state = "idle";
      this.publish("已到末尾", true);
    } else if (this.state === "playing") {
      this.publish("正在朗读", true);
      this.speakCurrentChunk();
    } else {
      this.publish(this.state === "paused" ? "已暂停，继续后从新位置开始" : "已调整朗读位置", true);
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

  get offset() {
    if (this.completed) {
      return this.paragraphs[this.index].length;
    }
    if (this.startedAt === null) {
      return this.offsetAtStart;
    }

    const chunk = this.chunks[this.chunkIndex];
    const estimated = this.offsetAtStart + (performance.now() - this.startedAt) * this.charactersPerMillisecond;
    return Math.min(chunk.start + chunk.text.length, estimated);
  }

  setPosition(index, offset = 0) {
    this.index = index;
    const paragraph = this.paragraphs[index];
    this.sentences = sentenceRanges(paragraph);
    this.chunks = splitParagraph(paragraph, this.sentences);
    this.chunkIndex = 0;
    this.paragraphRate = this.rate;
    this.sentence = null;
    this.startedAt = null;

    if (Number.isInteger(offset) && offset > 0 && !this.completed) {
      const target = Math.min(offset, paragraph.length - 1);
      this.chunkIndex = this.chunks.findIndex((chunk) => chunk.start + chunk.text.length > target);
      const chunk = this.chunks[this.chunkIndex];
      const relative = Math.max(0, target - chunk.start);
      const word = wordSegmenter.segment(chunk.text).containing(relative);
      const grapheme = graphemeSegmenter.segment(chunk.text).containing(relative);
      const cut = word?.isWordLike && relative - word.index <= 4 ? word.index : grapheme.index;
      const suffix = chunk.text.slice(cut);
      this.chunks[this.chunkIndex] = {
        start: chunk.start + chunk.text.length - suffix.trimStart().length,
        text: suffix.trimStart(),
      };
    }

    this.offsetAtStart = this.chunks[this.chunkIndex].start;
  }

  cancelCurrent() {
    this.offsetAtStart = this.offset;
    this.startedAt = null;
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
    this.hasStarted = false;
    this.startedAt = null;
    this.offsetAtStart = chunk.start;
    this.charactersPerMillisecond = chunk.text.length * utterance.rate / (1000 * estimateSpeechSeconds(chunk.text));
    if (this.sentence) {
      this.sentence = null;
      this.publish();
    }

    utterance.onstart = () => {
      if (this.active === utterance) {
        this.hasStarted = true;
        if (this.state === "playing") {
          this.startedAt = performance.now();
        }
      }
    };

    utterance.onboundary = (event) => {
      if (this.active !== utterance || !Number.isInteger(event.charIndex)
          || event.charIndex < 0 || event.charIndex >= chunk.text.length
          || !(event.name === "sentence" || (event.name === "word" && event.charIndex > 0))) {
        return;
      }
      const offset = chunk.start + event.charIndex;
      if (this.state === "playing" && offset >= this.offsetAtStart) {
        this.hasStarted = true;
        this.offsetAtStart = offset;
        this.startedAt = performance.now();
      }
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
      this.startedAt = null;
      this.sentence = null;
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
      } else {
        this.offsetAtStart = this.chunks[this.chunkIndex].start;
      }
      this.publish(this.state === "playing" ? "正在朗读" : "已暂停", true);

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
      offset: Math.floor(this.offset),
      sentence: this.sentence,
      completed: this.completed,
      message,
      progressChanged,
    });
  }
}