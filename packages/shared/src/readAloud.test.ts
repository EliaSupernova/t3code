import { describe, expect, it } from "vite-plus/test";

import {
  createSpeechBudget,
  createSpeechTextStream,
  READ_ALOUD_MAX_REPLY_CHARS,
} from "./readAloud.ts";

// Every expected value below is written by hand. Never regenerate it from the code under test.

const speak = (markdown: string) => createSpeechTextStream().finish(markdown);

/** Feeds the reply as growing snapshots and records what each one released. */
function stream(chunks: ReadonlyArray<string>) {
  const speech = createSpeechTextStream();
  let text = "";
  const steps = chunks.map((chunk) => {
    text += chunk;
    return speech.push(text);
  });
  return { steps, end: speech.finish(text) };
}

describe("spoken text", () => {
  it("splits prose into sentences and keeps its punctuation", () => {
    expect(speak('It works! Does it, really? Yes: "mostly." Done')).toEqual([
      "It works!",
      "Does it, really?",
      'Yes: "mostly."',
      "Done",
    ]);
  });

  it("does not split at decimals, versions, abbreviations or initials", () => {
    expect(speak("Use v4.2, e.g. the 3.5 build, vs. J. Doe's copy. Next.")).toEqual([
      "Use v4.2, e.g. the 3.5 build, vs. J. Doe's copy.",
      "Next.",
    ]);
  });

  it("skips fenced code blocks", () => {
    const markdown = [
      "Here is the fix:",
      "",
      "```ts",
      "const secret = 1. Not spoken.",
      "```",
      "",
      "  ~~~~",
      "  ``` still code.",
      "  ~~~~",
      "Run it again.",
    ].join("\n");
    expect(speak(markdown)).toEqual(["Here is the fix:", "Run it again."]);
  });

  it("skips a fence inside a list or a quote, and one that never closes", () => {
    const markdown = [
      "1. Install it:",
      "   ```bash",
      "   npm i. Hidden.",
      "   ```",
      "> ```",
      "> quoted code. Hidden.",
      "> ```",
      "- ```",
      "  more. Hidden.",
      "  ```",
      "Then this.",
      "```",
      "dangling code. Hidden.",
    ].join("\n");
    expect(speak(markdown)).toEqual(["Install it:", "Then this."]);
  });

  it("treats triple backticks that close on the same line as inline code", () => {
    expect(speak("```npm test``` runs the suite.\nSecond line.")).toEqual([
      "runs the suite.",
      "Second line.",
    ]);
  });

  it("skips indented code blocks but not indented list text", () => {
    expect(speak("Before.\n\n    rm -rf build. Hidden.\n\nAfter.")).toEqual(["Before.", "After."]);
    expect(speak("- First item.\n\n    Still the first item.")).toEqual([
      "First item.",
      "Still the first item.",
    ]);
  });

  it("skips inline code and what it leaves behind", () => {
    expect(speak("Run `vp test` now. The helper (`a.b. c`) is gone, see `x`.")).toEqual([
      "Run now.",
      "The helper is gone, see.",
    ]);
    expect(speak("Use ``a ` tick`` here. Edit the .env file.")).toEqual([
      "Use here.",
      "Edit the .env file.",
    ]);
  });

  it("reads link text and drops every address", () => {
    expect(
      speak(
        'See [the docs](https://example.com/a_(b).html?x=1. "Title") today. ' +
          "Raw: https://example.com/path. Also www.example.org, and <https://x.dev/y>.",
      ),
    ).toEqual(["See the docs today.", "Raw.", "Also, and."]);
    expect(
      speak("Open [server.ts:42](/home/me/server.ts:42) or [ref link][1].\n\n[1]: http://x.y/z"),
    ).toEqual(["Open server.ts:42 or ref link."]);
    expect(speak("![diagram](http://x.y/d.png)\n[https://x.y](https://x.y)")).toEqual([]);
  });

  it("drops headings marks, list markers, task boxes, quotes, rules and emphasis", () => {
    const markdown = [
      "## 1. Plan ##",
      "",
      "- **Bold** step",
      "* _Second_ step with __strong__ text",
      "+ [x] Done ~~old~~ item.",
      "2) Last one",
      "",
      "> [!NOTE]",
      "> Quoted *advice* here.",
      "",
      "---",
      "Setext title",
      "===",
      "snake_case stays readable, issue #42 too.",
    ].join("\n");
    expect(speak(markdown)).toEqual([
      "1. Plan",
      "Bold step",
      "Second step with strong text",
      "Done old item.",
      "Last one",
      "Quoted advice here.",
      "Setext title",
      "snake case stays readable, issue #42 too.",
    ]);
  });

  it("reads table cells without pipes or divider rows", () => {
    const markdown = [
      "Results:",
      "",
      "| Name | Time |",
      "|:-----|-----:|",
      "| `build` | 3 s |",
      "| Tests \\| lint | 9 s |",
      "",
      "Metric | Value",
      "--- | ---",
      "Speed | fast",
      "",
      "End.",
    ].join("\n");
    expect(speak(markdown)).toEqual([
      "Results:",
      "Name, Time",
      "3 s",
      "Tests, lint, 9 s",
      "Metric, Value",
      "Speed, fast",
      "End.",
    ]);
  });

  it("drops HTML, comments, math blocks, footnotes and entities", () => {
    const markdown = [
      "<details><summary>More</summary>",
      "Fish &amp; chips<br/>today.[^1]",
      "</details>",
      "<!-- hidden. Note. -->",
      "<!--",
      "also hidden.",
      "-->",
      "$$",
      "x = 1. + 2",
      "$$",
      "[^1]: A footnote.",
      "It costs $5. A \\*literal\\* star.",
    ].join("\n");
    expect(speak(markdown)).toEqual([
      "More Fish & chips today.",
      "It costs $5.",
      "A literal star.",
    ]);
  });

  it("joins hard-wrapped lines into one sentence", () => {
    expect(speak("This sentence is\nwrapped over\nthree lines. Done.")).toEqual([
      "This sentence is wrapped over three lines.",
      "Done.",
    ]);
  });

  it("keeps a bold title apart from the line under it", () => {
    expect(speak("**Summary**\nAll good, 2*3 is six.")).toEqual([
      "Summary",
      "All good, 2 times 3 is six.",
    ]);
  });

  it("keeps speaking after a stray bracket or backtick", () => {
    expect(speak("An open [ bracket. Then more. And a stray ` tick. Final.")).toEqual([
      "An open [ bracket.",
      "Then more.",
      "And a stray tick.",
      "Final.",
    ]);
  });

  it("says nothing for symbols alone", () => {
    expect(speak("***\n\n> \n\n- \n\n`only code`\n\n...")).toEqual([]);
  });

  it("splits a run-on sentence into pieces of at most 500 characters", () => {
    const words = Array.from({ length: 150 }, () => "word").join(" "); // 749 characters
    const pieces = speak(words);
    expect(pieces).toEqual([
      Array.from({ length: 100 }, () => "word").join(" "),
      Array.from({ length: 50 }, () => "word").join(" "),
    ]);
  });
});

describe("streamed text", () => {
  it("releases each sentence as soon as the next character shows it ended", () => {
    const { steps, end } = stream([
      "The bui",
      "ld passed",
      ".",
      " All 12 te",
      "sts ran. Ship",
      " it",
    ]);
    expect(steps).toEqual([[], [], [], ["The build passed."], ["All 12 tests ran."], []]);
    expect(end).toEqual(["Ship it"]);
  });

  it("waits through a half-written decimal", () => {
    const { steps, end } = stream(["Pi is 3.", "14 today. "]);
    expect(steps).toEqual([[], ["Pi is 3.14 today."]]);
    expect(end).toEqual([]);
  });

  it("never releases text from inside a code fence that arrives in pieces", () => {
    const { steps, end } = stream([
      "Try this.\n",
      "`",
      "``py\nprint('a. b')",
      "\nx = 1. ",
      "\n``",
      "`\nWorked. ",
    ]);
    expect(steps).toEqual([["Try this."], [], [], [], [], ["Worked."]]);
    expect(end).toEqual([]);
  });

  it("holds a sentence while inline code or a link is still open", () => {
    const { steps, end } = stream([
      "Call `foo. ",
      "bar()` first. Read [the. ",
      "guide](https://a.b/c. ",
      ") now. ",
    ]);
    expect(steps).toEqual([[], ["Call first."], [], ["Read the. guide now."]]);
    expect(end).toEqual([]);
  });

  it("never releases half an address", () => {
    const { steps, end } = stream(["Go to https://exa", "mple.com/a.", "b today. "]);
    expect(steps).toEqual([[], [], ["Go to today."]]);
    expect(end).toEqual([]);
  });

  it("holds list markers, headings and table rows until they are readable", () => {
    const { steps, end } = stream([
      "Steps:\n",
      "1",
      ". ",
      "Build it. Then",
      " rest\n- Ship",
      " it\n## Ti",
      "tle\n| a",
      " | b |\n",
    ]);
    expect(steps).toEqual([
      [],
      [],
      [],
      ["Steps:", "Build it."],
      ["Then rest"],
      ["Ship it"],
      ["Title"],
      ["a, b"],
    ]);
    expect(end).toEqual([]);
  });

  it("joins a wrapped line with the streamed rest of its sentence", () => {
    const { steps, end } = stream(["A long\n", "wrapped line", " ends. Next"]);
    expect(steps).toEqual([[], [], ["A long wrapped line ends."]]);
    expect(end).toEqual(["Next"]);
  });

  it("speaks the same sentences however the reply is cut", () => {
    const markdown =
      "# Done\n\nI fixed `x`. See [log](http://a.b).\n\n```\nno. no.\n```\n- one\n- two\n\n| h |\n|---|\n| c |\nBye.";
    const expected = ["Done", "I fixed.", "See log.", "one", "two", "h", "c", "Bye."];
    expect(speak(markdown)).toEqual(expected);
    for (const size of [1, 2, 3, 7]) {
      const chunks = markdown.match(new RegExp(`[\\s\\S]{1,${size}}`, "g"))!;
      const { steps, end } = stream(chunks);
      expect([...steps.flat(), ...end]).toEqual(expected);
    }
  });

  it("returns nothing more after the end", () => {
    const speech = createSpeechTextStream();
    expect(speech.finish("One.")).toEqual(["One."]);
    expect(speech.finish("One.")).toEqual([]);
    expect(speech.push("One. Two. ")).toEqual([]);
  });
});

describe("reply cost cap", () => {
  it("is 3,000 characters", () => {
    expect(READ_ALOUD_MAX_REPLY_CHARS).toBe(3_000);
  });

  it("stops at the first sentence that would pass the cap and stays stopped", () => {
    const budget = createSpeechBudget(10);
    expect(budget.take(["abcd.", "efgh."])).toEqual(["abcd.", "efgh."]);
    expect(budget.take(["i."])).toEqual([]);

    const early = createSpeechBudget(10);
    expect(early.take(["abcd.", "too long.", "x."])).toEqual(["abcd."]);
    expect(early.take(["y."])).toEqual([]);
  });
});
