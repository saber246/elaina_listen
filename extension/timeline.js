const EAST_ASIAN_CHARACTERS = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/gu;
const WORD = /[\p{L}\p{N}]+(?:['’-][\p{L}\p{N}]+)*/gu;
const PAUSE = /[，。！？；：、,.!?;:…]/gu;

// Approximate 270 East Asian characters or 155 other words per minute at 1×.
export function estimateSpeechSeconds(text) {
  const characters = (text.match(EAST_ASIAN_CHARACTERS) ?? []).length;
  const words = (text.replace(EAST_ASIAN_CHARACTERS, " ").match(WORD) ?? []).length;
  const pauses = (text.match(PAUSE) ?? []).length;
  return Math.max(0.3, characters / 4.5 + words / 2.6 + pauses * 0.14);
}

export function createTimeline(paragraphs) {
  let duration = 0;
  const ranges = paragraphs.map((text) => {
    const start = duration;
    const seconds = estimateSpeechSeconds(text);
    duration += seconds;
    return { start, end: duration, seconds, length: text.length };
  });

  return {
    duration,
    timeAt(index, offset) {
      const range = ranges[index];
      return range.start + range.seconds * Math.min(1, Math.max(0, offset / range.length));
    },
    positionAt(seconds) {
      const time = Math.max(0, Math.min(duration, seconds));
      if (time === duration) {
        const index = ranges.length - 1;
        return { index, offset: ranges[index].length, completed: true };
      }

      let low = 0;
      let high = ranges.length - 1;
      while (low < high) {
        const middle = Math.floor((low + high) / 2);
        if (time < ranges[middle].end) {
          high = middle;
        } else {
          low = middle + 1;
        }
      }

      const range = ranges[low];
      const offset = Math.round((time - range.start) / range.seconds * range.length);
      return { index: low, offset: Math.min(offset, range.length - 1), completed: false };
    },
  };
}