/** Cost cap: spoken characters per reply. After this the rest of the reply stays silent. */
export const READ_ALOUD_MAX_REPLY_CHARS = 3_000;
/** The longest piece sent for synthesis at once; a longer sentence is split between words. */
const READ_ALOUD_MAX_CHUNK_CHARS = 500;

const TERMINATORS = ".!?…。！？";
const FULL_WIDTH_TERMINATORS = "。！？";
const CLOSERS = "\"'”’»)]*_~";
// How far an unclosed "[" holds back a sentence while the reply is still being written.
const OPEN_BRACKET_HOLD_CHARS = 300;
const ABBREVIATIONS = new Set(
  "e.g i.e etc vs cf mr mrs ms dr prof sr jr st fig approx incl".split(" "),
);

const QUOTE_PREFIX = /^(?: {0,3}>[ \t]?)+/;
const HEADING_PREFIX = /^ {0,3}#{1,6}(?:[ \t]+|$)/;
const LIST_PREFIX = /^[ \t]*(?:[-*+]|\d{1,9}[.)])[ \t]+/;
const TASK_PREFIX = /^\[[ xX]\][ \t]+/;
// A backtick fence's info string cannot contain a backtick, so "```x``` runs" is inline code.
const FENCE_OPEN = /^[ \t]*(`{3,}(?![^`]*`)|~{3,})/;
const TABLE_DIVIDER = /^\|?[ \t]*:?-+:?[ \t]*(?:\|[ \t]*(?::?-+:?)?[ \t]*)+$/;
const RULE_LINE = /^(?:(?:\*[ \t]*){3,}|(?:_[ \t]*){3,}|(?:-[ \t]*){3,}|-+|=+)$/;
const REFERENCE_DEFINITION = /^\[[^\]]+\]:(?:[ \t]|$)/;
// A bold line standing as a section title.
const BOLD_TITLE = /^(\*\*|__)(?:(?!\1).)+\1:?$/;
// A line that so far could still turn out to be a marker, fence, table, heading or comment.
const UNDECIDED_LINE = /^(?:`{1,2}$|```|~|\$$|\$\$|\||#|<!|\[[^\]]*\]:|[-*+_=:.)\d \t]*$)/;
const INDENTED = /^(?: {4}|\t)/;

const HAS_WORDS = /[\p{L}\p{N}]/u;

const HTML_ENTITIES: Record<string, string> = {
  "&amp;": "&",
  "&lt;": "<",
  "&gt;": ">",
  "&quot;": '"',
  "&#39;": "'",
  "&apos;": "'",
  "&nbsp;": " ",
};

/** Removes Markdown and addresses from one piece of prose, leaving what should be said. */
function cleanProse(raw: string): string {
  return (
    raw
      .replace(/<!--[\s\S]*?-->/g, " ")
      // Inline code stays silent.
      .replace(/(?<![\\`])(`+)(?!`)[\s\S]*?(?<!`)\1(?!`)/g, " ")
      .replace(/!\[[^\]]*\]\((?:[^()]|\([^()]*\))*\)/g, " ")
      .replace(/\[((?:[^[\]]|\[[^[\]]*\])*)\]\((?:[^()]|\([^()]*\))*\)/g, "$1")
      .replace(/\[\^[^\]]*\]/g, "")
      .replace(/\[([^[\]]+)\]\[[^[\]]*\]/g, "$1")
      .replace(/\[![A-Za-z]+\]/g, " ")
      .replace(/<(?:[a-z][a-z\d+.-]*:[^\s<>]*|[^\s<>@]+@[^\s<>]+)>/gi, " ")
      .replace(/<\/?[A-Za-z][\w:-]*(?:\s[^<>]*)?\/?>/g, " ")
      // The punctuation after an address belongs to the sentence, so it stays.
      .replace(/(?:\b(?:https?|ftp|file):\/\/|\bwww\.)[^\s<>]*[^\s<>.,;:!?'"”’)\]*_~]/gi, " ")
      .replace(/&(?:amp|lt|gt|quot|apos|nbsp|#39);/g, (entity) => HTML_ENTITIES[entity] ?? " ")
      .replace(/\\([\\`*_{}[\]()#+\-.!|>~<])/g, "$1")
      .replace(/(?<=\d)\*(?=\d)/g, " times ")
      .replace(/`+|~~|\*+/g, "")
      .replace(/(?<=[\p{L}\p{N}])_+(?=[\p{L}\p{N}])/gu, " ")
      .replace(/_+/g, "")
      .replace(/\|/g, ",")
      .replace(/(?<=^|\s)#+(?=\s|$)/g, "")
      .replace(/\(\s*[,;]?\s*\)|\[\s*\]/g, " ")
      .replace(/\s+/g, " ")
      .replace(/ (?=[,.;:!?)](?:\s|$))/g, "")
      .replace(/[,;:]+(?=[,.;:!?])/g, "")
      .replace(/^[\s,.;:)\]]+(?=\s|[\p{L}\p{N}])/u, "")
      .trim()
  );
}

function splitLong(sentence: string): string[] {
  const pieces: string[] = [];
  let rest = sentence;
  while (rest.length > READ_ALOUD_MAX_CHUNK_CHARS) {
    const space = rest.lastIndexOf(" ", READ_ALOUD_MAX_CHUNK_CHARS);
    const cut = space > 0 ? space : READ_ALOUD_MAX_CHUNK_CHARS;
    pieces.push(rest.slice(0, cut));
    rest = rest.slice(cut).trimStart();
  }
  if (rest.length > 0) pieces.push(rest);
  return pieces;
}

function isRealPeriod(raw: string, sentenceStart: number, at: number): boolean {
  const before = raw.slice(Math.max(sentenceStart, at - 12), at);
  const word = /[A-Za-z][A-Za-z.]*$/.exec(before)?.[0];
  if (word !== undefined) {
    // Initials ("J. Doe") and common abbreviations do not end a sentence.
    if (/^[A-Z]$/.test(word) || ABBREVIATIONS.has(word.toLowerCase())) return false;
  }
  // "1. Plan" is a number in front of a title.
  return !(at - sentenceStart < 12 && /^\s*\d+$/.test(raw.slice(sentenceStart, at)));
}

/** The index after the bracket that closes the one at `open`, or -1. */
function closingIndex(raw: string, open: number, opener: string, closer: string): number {
  let depth = 0;
  for (let index = open; index < raw.length; index++) {
    const char = raw[index];
    if (char === "\\") index++;
    else if (char === opener) depth++;
    else if (char === closer && --depth === 0) return index + 1;
  }
  return -1;
}

/**
 * Where each finished sentence of `raw` ends. Punctuation inside inline code, links and addresses
 * does not count. Unless `complete`, `raw` may still grow, so its last character proves nothing.
 */
function sentenceEnds(raw: string, complete: boolean): number[] {
  const ends: number[] = [];
  let start = 0;
  let index = 0;
  while (index < raw.length) {
    const char = raw[index]!;
    if (char === "\\") {
      index += 2;
      continue;
    }
    if (char === "`") {
      let run = 1;
      while (raw[index + run] === "`") run++;
      const fence = new RegExp(`(?<!\`)\`{${run}}(?!\`)`, "g");
      fence.lastIndex = index + run;
      const close = fence.exec(raw);
      if (close) {
        index = close.index + run;
        continue;
      }
      if (!complete) break;
      index += run;
      continue;
    }
    if (char === "<" && raw.startsWith("<!--", index)) {
      const close = raw.indexOf("-->", index + 4);
      if (close === -1 && !complete) break;
      index = close === -1 ? index + 4 : close + 3;
      continue;
    }
    if (char === "[") {
      const label = closingIndex(raw, index, "[", "]");
      if (label === -1) {
        if (!complete && raw.length - index < OPEN_BRACKET_HOLD_CHARS) break;
        index++;
        continue;
      }
      if (raw[label] !== "(") {
        index = label;
        continue;
      }
      const target = closingIndex(raw, label, "(", ")");
      if (target === -1) {
        if (!complete) break;
        index = label;
        continue;
      }
      index = target;
      continue;
    }
    if (!TERMINATORS.includes(char)) {
      index++;
      continue;
    }
    let end = index + 1;
    while (end < raw.length) {
      const next = raw[end]!;
      if (TERMINATORS.includes(next) || CLOSERS.includes(next)) {
        end++;
        continue;
      }
      const footnote = next === "[" && raw[end + 1] === "^" ? raw.indexOf("]", end) : -1;
      if (footnote === -1) break;
      end = footnote + 1;
    }
    const followed = end < raw.length ? /\s/.test(raw[end]!) : complete;
    if (
      (followed || FULL_WIDTH_TERMINATORS.includes(char)) &&
      (char !== "." || end !== index + 1 || isRealPeriod(raw, start, index))
    ) {
      ends.push(end);
      start = end;
    }
    index = end;
  }
  return ends;
}

export interface SpeechTextStream {
  /** Takes the reply's whole text so far and returns the sentences that became complete. */
  readonly push: (text: string) => string[];
  /** The reply ended: returns every sentence still waiting. Later calls return nothing. */
  readonly finish: (text: string) => string[];
}

/**
 * Turns one Markdown reply into speakable sentences while it streams. It reads each line once;
 * only the unfinished sentence at the end is looked at again.
 */
export function createSpeechTextStream(): SpeechTextStream {
  let lineStart = 0;
  let searchFrom = 0;
  /** Characters of the unfinished line already turned into sentences. */
  let lineConsumed = 0;
  /** Prose from earlier lines whose sentence has not ended. */
  let carry = "";
  let fence: { readonly marker: string; readonly quoted: boolean } | null = null;
  let inMath = false;
  let inComment = false;
  let inList = false;
  let inTable = false;
  let quoted = false;
  let afterBlank = true;
  let finished = false;
  let out: string[] = [];

  const say = (raw: string) => {
    const spoken = cleanProse(raw);
    if (HAS_WORDS.test(spoken)) out.push(...splitLong(spoken));
  };
  const flush = () => {
    if (carry !== "") say(carry);
    carry = "";
  };

  /** Says the finished sentences of `carry` plus `rest`; returns how much of `rest` they used. */
  const feed = (rest: string, lineComplete: boolean): number => {
    const joined = carry === "" ? rest : `${carry} ${rest}`;
    const offset = joined.length - rest.length;
    let used = 0;
    for (const end of sentenceEnds(joined, lineComplete)) {
      say(joined.slice(used, end));
      used = end;
    }
    if (lineComplete) {
      carry = joined.slice(used).trim();
      return rest.length;
    }
    if (used === 0) return 0;
    carry = used < offset ? joined.slice(used, offset).trim() : "";
    return Math.max(0, used - offset);
  };

  const standalone = (raw: string) => {
    flush();
    feed(raw, true);
    flush();
  };

  const tableRow = (row: string) => {
    const cells = row
      .replace(/(`+)(?!`)[\s\S]*?(?<!`)\1(?!`)/g, " ")
      .split(/(?<!\\)\|/)
      .map(cleanProse)
      .filter((cell) => HAS_WORDS.test(cell));
    flush();
    if (cells.length > 0) out.push(...splitLong(cells.join(", ")));
  };

  /** Strips a line's quote, list and task markers, ending the sentence before a new block. */
  const enterBlock = (line: string) => {
    const quote = QUOTE_PREFIX.exec(line)?.[0] ?? "";
    let body = line.slice(quote.length);
    const isQuote = quote !== "";
    if (isQuote !== quoted) flush();
    quoted = isQuote;
    const list = RULE_LINE.test(body.trim()) ? null : LIST_PREFIX.exec(body);
    if (list) {
      body = body.slice(list[0].length);
      body = body.slice(TASK_PREFIX.exec(body)?.[0].length ?? 0);
      flush();
      inList = true;
    }
    return { body, isList: list !== null };
  };

  const readLine = (line: string) => {
    if (fence !== null) {
      const body = (fence.quoted ? line.replace(QUOTE_PREFIX, "") : line).trim();
      const run = fence.marker.length;
      if (
        body.startsWith(fence.marker) &&
        body.slice(run) === fence.marker[0]!.repeat(body.length - run)
      ) {
        fence = null;
      }
      return;
    }
    if (inMath) {
      if (line.trim().endsWith("$$")) inMath = false;
      return;
    }
    if (inComment) {
      const close = line.indexOf("-->");
      if (close === -1) return;
      inComment = false;
      line = line.slice(close + 3);
    }
    const blank = line.replace(QUOTE_PREFIX, "").trim() === "";
    const wasAfterBlank = afterBlank;
    if (blank) {
      flush();
      afterBlank = true;
      inTable = false;
      return;
    }
    if (INDENTED.test(line) && wasAfterBlank && !inList) {
      flush();
      return;
    }
    afterBlank = false;
    const { body, isList } = enterBlock(line);
    const trimmed = body.trim();
    if (!isList && wasAfterBlank && !/^[ \t]/.test(body)) inList = false;

    const opening = FENCE_OPEN.exec(body);
    if (opening) {
      flush();
      fence = { marker: opening[1]!, quoted };
      return;
    }
    if (trimmed.startsWith("$$")) {
      flush();
      inMath = !(trimmed.length > 3 && trimmed.endsWith("$$"));
      return;
    }
    const comment = trimmed.lastIndexOf("<!--");
    if (comment !== -1 && !trimmed.includes("-->", comment)) {
      standalone(trimmed.slice(0, comment));
      inComment = true;
      return;
    }
    if (TABLE_DIVIDER.test(trimmed) && trimmed.includes("|")) {
      flush();
      inTable = true;
      return;
    }
    if (RULE_LINE.test(trimmed) || REFERENCE_DEFINITION.test(trimmed)) {
      flush();
      return;
    }
    if (trimmed.startsWith("|") || (inTable && trimmed.includes("|"))) {
      tableRow(trimmed);
      return;
    }
    inTable = false;
    const heading = HEADING_PREFIX.exec(body);
    if (heading) {
      standalone(body.slice(heading[0].length).replace(/[ \t]+#+[ \t]*$/, ""));
      return;
    }
    if (BOLD_TITLE.test(trimmed)) {
      standalone(trimmed);
      return;
    }
    feed(trimmed, true);
  };

  /** Releases sentences from the line still being written, once it is surely prose. */
  const readPartialLine = (line: string) => {
    if (fence !== null || inMath || inComment) return;
    if (lineConsumed > 0) {
      lineConsumed += feed(line.slice(lineConsumed), false);
      return;
    }
    const unquoted = line.replace(QUOTE_PREFIX, "");
    if (/^[ \t]*$/.test(unquoted) || (INDENTED.test(line) && afterBlank && !inList)) return;
    if (/^[ \t]*[-*+_=.)\d]*[ \t]*$/.test(unquoted) || /^ {0,3}>?$/.test(line)) return;
    const { body } = enterBlock(line);
    const content = body.trimStart();
    if (HEADING_PREFIX.test(content) || content.startsWith("|") || FENCE_OPEN.test(content)) {
      flush();
      return;
    }
    if (UNDECIDED_LINE.test(content) || inTable) return;
    const prefix = line.length - content.length;
    const used = feed(content, false);
    if (used > 0) lineConsumed = prefix + used;
  };

  const advance = (text: string) => {
    for (;;) {
      const newline = text.indexOf("\n", Math.max(searchFrom, lineStart));
      if (newline === -1) break;
      const line = text.slice(lineStart, newline).replace(/\r$/, "");
      if (lineConsumed > 0) feed(line.slice(lineConsumed).trim(), true);
      else readLine(line);
      lineStart = newline + 1;
      lineConsumed = 0;
    }
    searchFrom = text.length;
  };

  const take = () => {
    const sentences = out;
    out = [];
    return sentences;
  };

  return {
    push: (text) => {
      if (finished) return [];
      advance(text);
      if (lineStart < text.length) readPartialLine(text.slice(lineStart));
      return take();
    },
    finish: (text) => {
      if (finished) return [];
      finished = true;
      advance(text);
      if (lineStart < text.length) {
        const line = text.slice(lineStart);
        if (lineConsumed > 0) feed(line.slice(lineConsumed).trim(), true);
        else readLine(line);
      }
      flush();
      return take();
    },
  };
}

/** One reply's share of the cost cap, shared by all the messages of that reply. */
export function createSpeechBudget(limit: number = READ_ALOUD_MAX_REPLY_CHARS) {
  let used = 0;
  let spent = false;
  return {
    /** The leading sentences that still fit. The first one that does not ends the reply. */
    take: (sentences: ReadonlyArray<string>): string[] => {
      const allowed: string[] = [];
      for (const sentence of sentences) {
        spent ||= used + sentence.length > limit;
        if (spent) break;
        used += sentence.length;
        allowed.push(sentence);
      }
      return allowed;
    },
  };
}
