/**
 * fake-workflow.js — the scripted "model brain" that answers every stage of the
 * real pipeline the way a real model would.
 *
 * `fake-backend.js` is the fake MODEL SERVER (the wire). This module is the thing
 * behind it: a `reply(req)` function that looks at what a request actually asked
 * for — which system prompt, which tools were advertised, how far into an agent
 * turn the conversation already is — and answers with the shape that stage's real
 * model produces:
 *
 *   extraction call      → the JSON array that stage's parser accepts
 *   author agent turn    → real `writeFile` tool calls that land real artifacts
 *   validator agent turn → a real validation report on disk
 *   acceptance grader    → the `{"score","band","note"}` contract
 *   translator           → a faithful English rendering that passes the no-AI QA
 *   verifier             → `SCORE: N/100` + severity-banded findings
 *   polisher             → a surface-smoothed chapter that keeps every glossary rendering
 *   drift auditor        → `SCORE: N/100`
 *
 * The point is honesty in both directions: the answers are good enough that the
 * pipeline's own gates accept them (so a real run's plumbing is what is being
 * tested, not a fight with a deliberately bad model), and they are derived from
 * the fixture's own source text, so a prompt that lost a block — the glossary,
 * the background, the continuity tail — shows up in `prompt-audit.js` instead of
 * being papered over.
 *
 * No dependencies beyond Node's built-ins. CommonJS, like the rest of the project.
 */
const fs = require("fs");
const path = require("path");

// ─── The fixture: a two-volume series small enough to run offline ────────────

const SERIES = {
  name: "月影の学園",
  alt: "Moonshadow Academy",
  sourceLanguage: "Japanese",
  targetLanguage: "English",
};

/**
 * The terminology law the glossary stage produces. `term` is the SOURCE-language
 * text (column 0 of the glossary table), `rendering` the canonical target-language
 * form (column 1) — the shape `parseGlossaryRows` reads positionally.
 *
 * Renderings carry no leading article on purpose: `checkTranslationQa` matches them
 * as case-sensitive substrings of the draft, so "the Forbidden Book" would count as
 * missing whenever the sentence opens with "The Forbidden Book".
 */
const TERMS = [
  { term: "月影学園", rendering: "Moonshadow Academy", type: "proper noun", volumes: ["01", "02"] },
  { term: "灯里", rendering: "Akari", type: "character name", volumes: ["01", "02"] },
  { term: "悠真", rendering: "Yuma", type: "character name", volumes: ["01", "02"] },
  { term: "契約", rendering: "Pact", type: "concept", volumes: ["01", "02"] },
  { term: "生徒会", rendering: "Student Council", type: "institution", volumes: ["01", "02"] },
  { term: "禁忌の書", rendering: "Forbidden Book", type: "artifact", volumes: ["01", "02"] },
  { term: "魔法", rendering: "magic", type: "concept", volumes: ["01", "02"] },
  { term: "屋上", rendering: "roof", type: "place", volumes: ["01", "02"] },
  { term: "図書室", rendering: "library", type: "place", volumes: ["01", "02"] },
  { term: "名簿", rendering: "register", type: "institution", volumes: ["02"] },
];

/**
 * One volume of the fixture. Each paragraph carries the source text plus the three
 * target-language variants the pipeline needs at different stages:
 *   `en`       — what the translator produces (the draft `verify` grades)
 *   `fixed`    — what `retranslate` produces after findings (only for the volume
 *                the scripted verifier deliberately fails)
 *   `polished` — what the polisher produces (no source text, surface only)
 * Keeping them paragraph-aligned is what makes the paragraph-count rule in
 * `planTargetedRepair` reachable and keeps the length ratio inside the pair's band.
 */
const VOLUMES = [
  {
    installment: "01",
    folder: "Moonshadow Academy(01)",
    looseFile: "moonshadow-01.txt",
    stagedFile: "Moonshadow Academy(01).txt",
    title: "月影の学園 1",
    paragraphs: [
      {
        ja: "月影学園の朝は、いつも霧から始まる。正門の両側にある銀杏の木は、この季節になると霧の中に沈んで、輪郭だけを残す。私はその輪郭を数えるのが好きだった。数を数え終わるころには、必ず誰かが私の後ろを歩いていた。",
        en: "Mornings at Moonshadow Academy always began in fog. The ginkgo trees on either side of the main gate sank into it at this time of year and kept only their outlines. I liked counting those outlines. By the time I finished counting, someone was always walking behind me.",
        polished:
          "Mornings at Moonshadow Academy always began in the fog. The ginkgo trees on either side of the main gate sank into it this time of year and kept only their outlines. I liked counting those outlines. By the time I finished, someone was always walking behind me.",
      },
      {
        ja: "その日は灯里だった。彼女は私より三歩速く歩いた。速いというより、立ち止まることを知らないといったほうが正しい。校舎の扉の前で彼女は振り返り、契約の話をした。もう一度確認したい、と彼女は言った。",
        en: "That day it was Akari. She walked three paces faster than me; rather than fast, it would be more accurate to say she did not know how to stop. In front of the schoolhouse door she turned around and brought up the Pact. She said she wanted to confirm it one more time.",
        polished:
          "That day it was Akari. She walked three paces faster than me — faster is the wrong word; she simply did not know how to stop. In front of the schoolhouse door she turned and brought up the Pact. She wanted to confirm it one more time, she said.",
      },
      {
        ja: "契約というのは、生徒会が定めた決まりではなく、この学園に入学した者が自分自身と交わす取り決めだと、最初の週に説明された。誰もその書類に署名しない。署名がないからこそ、破った者が誰なのか、誰も証明できない。",
        en: "In the first week we were told that the Pact is not a rule the Student Council wrote down but an agreement every student at this academy makes with themselves. Nobody signs a document for it. Because nobody signs, nobody can prove who broke it.",
        polished:
          "In the first week we were told that the Pact is not a rule the Student Council wrote down. It is an agreement every student at this academy makes with themselves. Nobody signs a document for it — which is exactly why nobody can prove who broke it.",
      },
      {
        ja: "悠真は屋上でそれを飼っていた。彼は魔法という言葉を嫌った。代わりに技術と言った。技術は反復で、魔法は依頼だと彼は説明した。反復すれば再現できる。依頼は、返事が来るまで待つしかない。",
        en: "Yuma kept it on the roof. He hated the word magic; he preferred craft, he said. Craft is repetition, and magic is a request, he explained. What you repeat, you can reproduce. A request leaves you nothing but waiting for an answer.",
        polished:
          "Yuma kept it on the roof. He hated the word magic and preferred craft. Craft is repetition, he said; magic is a request. What you repeat, you can reproduce. A request leaves you nothing but waiting for the answer.",
      },
      {
        ja: "禁忌の書は図書室の三階にあり、誰も取り出せない場所にあるのではなく、誰も読みたがらない場所にあった。背表紙に題名が書かれていない本は、あの学園では三冊だけだった。そのうち二冊は空白で、一冊だけが書かれていた。",
        en: "The Forbidden Book was on the third floor of the library, not in a place nobody could reach but in a place nobody wanted to look. Only three books in that academy had no title on the spine. Two of them were blank. One was written.",
        polished:
          "The Forbidden Book was on the third floor of the library — not where nobody could reach it, but where nobody wanted to look. Only three books in the academy had no title on the spine. Two were blank. One was written.",
      },
      {
        ja: "私がその一冊を開けたのは、霧が晴れた日だった。学園の霧が晴れるのは年に四度きりで、その日は生徒会の書類がすべて机の上に置き忘れられていた。彼女は私の隣に座った。誰も注意しなかった。",
        en: "I opened that one book on a day the fog lifted. The fog at the academy lifted only four times a year, and on that day every document of the Student Council had been left out on the desks. She sat down beside me. Nobody noticed.",
        polished:
          "I opened that book on a day the fog lifted. The fog at the academy lifted only four times a year, and that day every document of the Student Council had been left out on the desks. She sat down beside me. Nobody noticed.",
      },
      {
        ja: "灯里は自分の名前を名乗るのをやめた。その日から私は彼女をそう呼ばなくなった。呼ばなくなったのは、彼女のほうではなく、私の側の決まりだった。決まりは破るものだと、そのころ私はまだ信じていた。",
        en: "Akari stopped giving her own name. From that day on I stopped calling her by it. The change was not hers; it was a rule on my side. Back then I still believed a rule was something you break.",
        polished:
          "Akari stopped giving her own name. From that day on I stopped calling her by it. The change was not hers — it was a rule on my side. Back then I still believed that a rule was something you break.",
      },
      {
        ja: "屋上には古い椅子が二つあった。悠真はそのうち一つにしか座らなかった。もう一つの椅子の背もたれには、消しられた文字がまだ残っていて、私はそれを二度と読もうとしなかった。",
        en: "There were two old chairs on the roof. Yuma sat in only one of them. The back of the other still held letters that had been erased, and I never tried to read them again.",
        polished:
          "There were two old chairs on the roof. Yuma sat in only one. The back of the other still held letters that had been erased, and I never tried to read them again.",
      },
      {
        ja: "霧の日は、廊下の窓が内側から曇る。外が見えないのではない。外に見るものがないのだと、その窓は言っていた。私はその違いを誰にも説明できなかった。",
        en: "On foggy days the corridor windows clouded from the inside. It was not that you could not see outside; the windows said there was nothing outside to see. I could not explain that difference to anyone.",
        polished:
          "On foggy days the corridor windows clouded from the inside. Not because you could not see out — the windows said there was nothing out there to see. I could not explain that difference to anyone.",
      },
      {
        ja: "学期の終わり近くに、悠真は屋上の鍵を私に見せた。鍵は古い真鍮で、同じ鍵が三本あると彼は言った。三本のうち二本がどこにあるのか、彼は言わなかった。",
        en: "Near the end of the term Yuma showed me the key to the roof. It was old brass, and he said there were three of them. He did not say where the other two were.",
        polished:
          "Near the end of term Yuma showed me the roof key. It was old brass, and he said three existed. He did not say where the other two were.",
      },
      {
        ja: "灯里は一度だけ、自分の名前を言いかけた。言いかけたところでやめた。やめたのは、私のせいではなかった。その日の霧は、いつもより薄かった。霧が薄い日は音がよく聞こえた。私はその音を数えた。",
        en: "Akari once almost said her own name. She stopped at the point where it would have been said. It was not because of me. The fog that day was thinner than usual. On thin-fog days sound carried well, and I counted it.",
        polished:
          "Akari once almost said her own name. She stopped where it would have been said. It was not because of me. The fog that day was thinner than usual. On thin-fog days sound carried well, and I counted it.",
      },
    ],
  },
  {
    installment: "02",
    folder: "Moonshadow Academy(02)",
    looseFile: "moonshadow-02.txt",
    stagedFile: "Moonshadow Academy(02).txt",
    title: "月影の学園 2",
    paragraphs: [
      {
        ja: "二月になり、月影学園の霧はさらに深くなった。生徒会は新しい掲示を出した。掲示は契約について書いていたが、契約が何を禁じているのかについては書いていなかった。",
        en: "By February the fog at Moonshadow Academy had grown thicker. The Student Council put up a new notice. The notice was about the Pact, but it did not say what the Pact forbade.",
        polished:
          "By February the fog at Moonshadow Academy had grown thicker. The Student Council put up a new notice. It was about the Pact, but it never said what the Pact forbade.",
      },
      {
        ja: "灯里は屋上に現れなくなった。悠真も同じだった。二人が同時にいない日は、霧が濃い日だけだった。私はそれを偶然だと思おうとして、やめた。",
        en: "Akari stopped appearing on the roof. So did Yuma. The only days when both of them were absent were the days the fog was thickest. I tried to read that as coincidence, then stopped trying.",
        polished:
          "Akari stopped appearing on the roof. So did Yuma. The only days both of them were absent were the days the fog was thickest. I tried to read that as coincidence. Then I stopped trying.",
      },
      {
        ja: "禁忌の書を書いていたのは、十年前にこの学園にいた誰かだった。その誰かは自分の名を一度も書かなかった。代わりに日付を書いた。日付は毎日ではなく、霧が晴れた日だけだった。",
        en: "The person who wrote the Forbidden Book had been at this academy ten years earlier. That person never wrote their own name. They wrote dates instead — not every day, only the days the fog lifted.",
        polished:
          "Whoever wrote the Forbidden Book had been at this academy ten years earlier. They never wrote their own name. They wrote dates instead — not every day, only the days the fog lifted.",
      },
      {
        ja: "私は四度目の霧晴れを待った。待つ間に魔法について調べた。魔法は依頼だと悠真が言ったとき、私はそれを冗談だと思った。冗談ではないと知ったのは、依頼を実際に送った後だった。",
        en: "I waited for the fourth lifting of the fog. While waiting I looked into magic. When Yuma said magic is a request, I had taken it as a joke. I learned it was not a joke after I actually sent one.",
        polished:
          "I waited for the fourth lifting of the fog. While waiting, I looked into magic. When Yuma said magic is a request I had taken it as a joke. I learned it was no joke after I actually sent one.",
      },
      {
        ja: "依頼は返事を返さなかった。三日間、返事はなかった。四日目に、私の机の上に書類が置かれていた。書類には私の名前が書かれていた。私が名乗っていない名前だった。",
        en: "The request did not answer. For three days there was no answer. On the fourth day a document was placed on my desk. The document had my name written on it — a name I had never given.",
        polished:
          "The request did not answer. Three days passed with no answer. On the fourth day a document was waiting on my desk. It had my name written on it — a name I had never given.",
      },
      {
        ja: "灯里はその書類を読んだ。読んだあと、彼女は屋上の椅子を二つとも立てかけた。誰も座っていない椅子が、学園の壁に沿って並んだ。図書室の三階は、その日から鍵をかけられた。",
        en: "Akari read the document. After reading it she propped up both of the roof chairs. Two chairs nobody sat in stood in a row along the academy wall. The third floor of the library was locked from that day on.",
        polished:
          "Akari read the document. Afterwards she propped up both roof chairs. Two chairs nobody sat in stood in a row along the academy wall. The third floor of the library was locked from that day on.",
      },
      {
        ja: "悠真はそれを止めなかった。彼は技術について話した。反復すれば再現できると彼は言ったが、その日彼は何度も同じことをしなかった。一度だけやって、やめた。",
        en: "Yuma did not stop her. He talked about craft. He had said what you repeat, you can reproduce, but that day he did not repeat anything. He did it once and stopped.",
        polished:
          "Yuma did not stop her. He talked about craft. He had said what you repeat, you can reproduce — but that day he repeated nothing. He did it once and stopped.",
      },
      {
        ja: "霧が晴れたのは、その日の夕方だった。私は門の内側で立ち止まり、振り返った。校舎の窓は内側から曇ったままだった。",
        en: "The fog lifted that evening. I stopped inside the gate and looked back. The academy's windows were still clouded from the inside.",
        polished:
          "The fog lifted that evening. I stopped inside the gate and looked back. The academy windows were still clouded from the inside.",
      },
      {
        ja: "書類の名前は三文字で、その三文字は学園の誰のものでもなかった。生徒会の名簿を照合するのに、私は図書室の三階の鍵を頼んだ。鍵は返されなかった。",
        en: "The name on the document was three characters long, and those three characters belonged to nobody at the academy. To check it against the Student Council's register I asked for the key to the third floor of the library. The key was not returned.",
        polished:
          "The name on the document was three characters long, and those three characters belonged to nobody at the academy. To check it against the Student Council register I asked for the key to the library's third floor. The key was never returned.",
      },
      {
        ja: "灯里はもう屋上に上がらなかった。私は一人で上がった。椅子は二つとも立てかけたままだった。霧が晴れているのに、私は門の外で立ち止まった。",
        en: "Akari no longer went up to the roof. I went up alone. Both chairs were still propped up. The fog had lifted, and still I stopped outside the gate.",
        polished:
          "Akari no longer went up to the roof. I went alone. Both chairs were still propped. The fog had lifted, and still I stopped outside the gate.",
      },
      {
        ja: "鍵を返してもらえなかった日の翌日、机の上に別の書類があった。同じ用紙で、同じ書き方だった。今度は何も書かれていなかった。書かれていないこと自体が、返事だと私は思った。誰も私の名前を呼ばなかった日から、私は書類を読むようになった。",
        en: "The day after the key was not returned, another document was on my desk. Same paper, same handwriting. This time nothing was written on it. The emptiness itself read like an answer. Since the day nobody called my name, I have been reading documents.",
        polished:
          "The day after the key was not returned, another document was on my desk. Same paper, the same handwriting. This time nothing was written on it. The emptiness itself read like an answer. Since the day nobody called my name, I have been reading documents.",
      },
      {
        ja: "悠真は屋上をやめた。彼は技術の話をやめた。代わりに、彼は依頼について話した。依頼は返事を返さないが、返事が来ないことも返事だと彼は言った。それ以来、彼は屋上に上がらなかった。",
        en: "Yuma gave up the roof. He stopped talking about craft. Instead he talked about requests: a request does not answer, he said, but not answering is also an answer. After that he never went up to the roof again.",
        polished:
          "Yuma gave up the roof. He stopped talking about craft and talked instead about requests. A request does not answer, he said, but not answering is also an answer. After that he never went up to the roof again.",
      },
      {
        ja: "その書類は今も私の机の引き出しにある。開かない。開かないことは決まりではない。決まりではないからこそ、私はそれを破ることができない。",
        en: "The document is still in my desk drawer. I do not open it. Not opening it is not a rule — and because it is not a rule, I cannot break it.",
        polished:
          "The document is still in my desk drawer. I do not open it. Not opening it is not a rule, and because it is not a rule, I cannot break it.",
      },
    ],
  },
];

// The scripted verdicts. Volume 01 is graded through the normal two-sample window;
// volume 02 is graded into the exceptional-consensus path (≥ 85 → confirmed at
// temperature 0), so a single scripted run exercises both acceptance routes.
const ACCEPTANCE_SCORES = { "01": 78, "02": 90 };

/**
 * The chapter the scripted verifier FAILS in round 1, and the scores it gives.
 * 40 is deliberately far below the passing line and far outside the tiebreak and
 * repeat-sampling bands, and the finding is HIGH so `worthRetranslating` never
 * defers it (a deferred FAIL would make the QA loop report "stalled").
 */
const VERIFY_SCORES = { "01": 92, "02": 40 };
const RETRANSLATED_VOLUME = "02";
const VERIFY_SCORES_ROUND2 = { "02": 88 };
const POLISH_AUDIT_SCORES = { "01": 91, "02": 90 };

// ─── Text helpers ────────────────────────────────────────────────────────────

const joinParagraphs = (volume, key) => volume.paragraphs.map((p) => p[key]).join("\n\n");

const sourceTextOf = (volume) => joinParagraphs(volume, "ja");
const draftTextOf = (volume) => joinParagraphs(volume, "en");

/**
 * The polished chapter. For the volume the scripted QA loop retranslates, the
 * repaired sentence is carried through — a polisher that dropped a sentence the
 * draft had is exactly what the drift audit exists to catch, so the scripted
 * answer must not commit that error itself.
 *
 * @param {object} volume
 * @returns {string}
 */
function polishedTextOf(volume) {
  const repair = volume.installment === RETRANSLATED_VOLUME ? REPAIRS[volume.installment] : null;
  return volume.paragraphs
    .map((p, i) => (repair && i === repair.index ? `${p.polished} ${repair.marker}` : p.polished))
    .join("\n\n");
}

/**
 * The clause `retranslate` adds when it repairs the omission the scripted verifier
 * flags. It is also the marker the scripted verifier uses to tell "grading the
 * draft" from "grading the repaired draft" — the two requests are otherwise
 * identical. Each volume carries its own, so the added clause reads correctly in
 * the paragraph it lands in.
 */
const REPAIRS = {
  "01": { index: 3, marker: "— and he had already sent one." },
  "02": { index: 3, marker: "— and he had sent one before me." },
};

/** The retranslated chapter: the draft with the flagged omission repaired. */
function fixedTextOf(volume) {
  const repair = REPAIRS[volume.installment];
  if (!repair) return draftTextOf(volume);
  return volume.paragraphs
    .map((p, i) => (i === repair.index ? `${p.en} ${repair.marker}` : p.en))
    .join("\n\n");
}

const volumeByInstallment = new Map(VOLUMES.map((v) => [v.installment, v]));

/** The terms this volume's glossary holds (the cumulative list, not just the new ones). */
function termsForVolume(installment) {
  return TERMS.filter((t) => t.volumes.includes(installment));
}

/** The terms this volume ADDS (what the extraction call is asked to find). */
function newTermsForVolume(installment) {
  const index = VOLUMES.findIndex((v) => v.installment === installment);
  if (index === 0) return termsForVolume(installment);
  const previous = new Set(termsForVolume(VOLUMES[index - 1].installment).map((t) => t.term));
  return TERMS.filter((t) => t.volumes.includes(installment) && !previous.has(t.term));
}

const stripWhitespace = (text) => String(text || "").replace(/\s+/g, "");

/**
 * Which volume a piece of prompt text is working on, by finding the volume's own
 * source text inside it. The translation prompts carry no "Volume NN" label — the
 * source text is the only identity they have — so this is how the prompt audit
 * knows which volume a translate / retranslate / verify call was about.
 *
 * @param {string} text
 * @returns {object|null}
 */
function volumeForText(text) {
  const flat = stripWhitespace(text);
  for (const volume of VOLUMES) {
    const opening = stripWhitespace(sourceTextOf(volume)).slice(0, 60);
    if (opening && flat.includes(opening)) return volume;
  }
  return null;
}

// ─── The artifacts the agents are told to write ──────────────────────────────

function glossaryMarkdown(volume) {
  const terms = termsForVolume(volume.installment);
  const rows = terms.map((t) => `| ${t.term} | ${t.rendering} | ${t.type} | Carried from volume ${volume.installment}. |`);
  return [
    `# Glossary — ${SERIES.alt} (${SERIES.name})`,
    "",
    `Current through volume ${volume.installment}.`,
    "",
    "## Proper nouns",
    "",
    "| Source term | Rendering | Type | Notes |",
    "|---|---|---|---|",
    ...rows,
    "",
    "## Notes",
    "",
    `- Renderings are fixed for the whole series. Volume ${volume.installment} adds ${newTermsForVolume(volume.installment).length} term(s).`,
    "",
  ].join("\n");
}

function characterVoiceMarkdown(volume) {
  return [
    `# キャラクターボイスリファレンス — ${SERIES.name}`,
    "",
    `現行：${volume.installment}巻まで`,
    "",
    "## 主人公（語り手）",
    "",
    "- **話し癖:** 事実を短い平叙文で並べ、感情を後から一文だけ添える。",
    "- **一人称:** 私。自由間接話法が混ざる。",
    "",
    "## 灯里",
    "",
    "- **話し癖:** 依頼形を避ける。命令ではなく確認の言い方。",
    "- **例:** 「もう一度確認したい」",
    "",
    "## 悠真",
    "",
    "- **話し癖:** 用語を定義してから話す。比喩を嫌う。",
    "- **例:** 「技術は反復で、魔法は依頼だ」",
    "",
  ].join("\n");
}

function povMapMarkdown(volume) {
  return [
    `# POV Map — ${SERIES.alt}, volume ${volume.installment}`,
    "",
    "| Section | POV | Narration type |",
    "|---|---|---|",
    "| Opening | The protagonist | first-person-internal |",
    "| Roof scenes | The protagonist | first-person-internal with free indirect discourse |",
    "| Closing | The protagonist | first-person-internal |",
    "",
    "Markers: the narration stays inside the protagonist throughout this volume; the only shift is free indirect discourse in the roof scenes.",
    "",
  ].join("\n");
}

function styleGuideMarkdown(volume) {
  const extra =
    volume.installment === "02"
      ? "| particle | ね at the end of a confirmation | Render as a plain statement; do not add a tag question. | \"…だと彼は説明した。\" | medium | A tag question would change the character's voice. |\n"
      : "";
  return [
    `# Style Guide — ${SERIES.alt}`,
    "",
    `Current through volume ${volume.installment}.`,
    "",
    "| Category | Pattern | Policy | Example | Frequency | Notes |",
    "|---|---|---|---|---|---|",
    "| honorific | さん after a classmate's name | Drop it; mark the register with word choice instead. | \"灯里\" | high | Keeping -san reads as a translation. |",
    "| internalMonologue | だ / である endings inside thought | Keep declarative, no quotation marks, no italics. | \"誰も署名しない\" | high | The thought line is a fact, not a quote. |",
    "| tense | past narration with present-tense thought | Narrate in past tense; keep the thought in present. | \"私は数えるのが好きだった\" | high | |",
    extra
      ? extra
      : "| punctuation | 、 between short clauses | Split into separate sentences rather than chaining with commas. | \"速いというより、…\" | medium | |\n",
    "",
    "## Open Questions",
    "",
    "- Whether the academy's own name is ever spoken aloud by a character (volume " + volume.installment + ").",
    "",
  ].join("\n");
}

function wikiMarkdown(volume) {
  return [
    `# ${SERIES.alt}, Volume ${volume.installment} — Volume Wiki`,
    "",
    "## Plot Summary",
    "",
    `Volume ${volume.installment} of ${SERIES.alt}. ${volume.installment === "01" ? "The protagonist counts the fog at Moonshadow Academy, meets Akari at the schoolhouse door, and opens the one written book of the three that carry no title." : "The fog thickens, the Student Council posts a notice about the Pact that never says what it forbids, and a document arrives with a name the protagonist never gave."}`,
    "",
    "## Key Events",
    "",
    `- The Pact is described as a self-made agreement, unsigned and therefore unprovable.`,
    `- Yuma's definition: craft is repetition, magic is a request.`,
    `- The third floor of ${volume.installment === "01" ? "the library holds the Forbidden Book" : "the library is locked"}.`,
    "",
  ].join("\n");
}

function sharedWikiMarkdown(volume) {
  return [
    `# ${SERIES.alt} — Shared Wiki (series state through volume ${volume.installment})`,
    "",
    "## Series Overview",
    "",
    `A single academy, one fog-bound term, and a Pact nobody signed. ${SERIES.alt} is told entirely from inside the protagonist.`,
    "",
    "## Character Roster",
    "",
    "- **The protagonist** — unnamed to the other characters; counts outlines.",
    "- **Akari (灯里)** — walks three paces ahead; stopped giving her own name.",
    "- **Yuma (悠真)** — keeps something on the roof; defines terms before using them.",
    "",
    "## Timeline of Key Events",
    "",
    `- Volume ${volume.installment}: ${volume.installment === "01" ? "the written book is opened; Akari stops naming herself." : "the notice about the Pact appears; an unsigned document arrives bearing a name the protagonist never gave."}`,
    "",
    "## World State & Rules",
    "",
    "- The Pact is an agreement a student makes with themselves; no signature, no proof of a breach.",
    "- The fog at Moonshadow Academy lifts four times a year.",
    "",
    "## Glossary",
    "",
    ...termsForVolume(volume.installment).map((t) => `- ${t.term} → ${t.rendering}`),
    "",
    "## Open Threads",
    "",
    "- What the Pact actually forbade.",
    volume.installment === "02" ? "- Whose name is on the document.\n" : "",
  ].join("\n");
}

const VALIDATION_KINDS = {
  glossary: { file: "glossary-validation.md", artifact: "glossary.md" },
  "character-voice": { file: "character-voice-validation.md", artifact: "character-voice.md + pov-map.md" },
  "style-guide": { file: "style-guide-validation.md", artifact: "style-guide.md" },
  "jump-in-wiki": { file: "jump-in-wiki-validation-{{NN}}.md", artifact: "wiki.md + shared-wiki.md" },
};

/**
 * A validation report in the shape the validator prompts prescribe: findings by
 * severity, concrete fixes, and the recommendation line the acceptance grader
 * maps to a score band.
 *
 * @param {string} kind - One of VALIDATION_KINDS.
 * @param {object} volume
 * @param {number} iteration - 1 = the first audit, 2 = the audit of the corrected artifact.
 * @returns {string}
 */
function validationMarkdown(kind, volume, iteration) {
  const meta = VALIDATION_KINDS[kind];
  const reportFile = meta.file.replace("{{NN}}", volume.installment);
  return [
    `# ${kind} Validation — ${SERIES.alt}, Volume ${volume.installment}`,
    "",
    `Report: ${reportFile}`,
    `Artifact audited: ${meta.artifact}`,
    "",
    "## Completeness",
    "",
    iteration === 1
      ? "- Every term / entry the source text carries is present in the artifact."
      : "- The corrected artifact carries every entry the first audit asked for.",
    "",
    "## Consistency",
    "",
    "- No entry renders the same source term two ways.",
    iteration === 1 ? "- One entry's note is thinner than the others (LOW)." : "- No conflicts remain.",
    "",
    "## Correctness",
    "",
    "- Each rendering matches what the source text actually says.",
    "",
    "## Format",
    "",
    "- Table shape and section headings follow the required layout.",
    "",
    "## Findings",
    "",
    iteration === 1
      ? "1. **[LOW] A note is thinner than the rest.**\n   - Fix: state which volume carried the entry."
      : "No findings.",
    "",
    `**Recommendation:** ${iteration === 1 ? "Pass with minor edits" : "Pass"}`,
    "",
  ].join("\n");
}

function consistencyReportMarkdown() {
  return [
    `# Consistency Report — ${SERIES.alt}`,
    "",
    "_Audited: glossary.md, character-voice.md, style-guide.md, shared-wiki.md._",
    "",
    "## Verdict",
    "",
    "**PASS** — no HIGH findings.",
    "",
    "## Findings",
    "",
    "### HIGH (blocks translation)",
    "None.",
    "",
    "### MEDIUM (should be fixed before translation)",
    "None.",
    "",
    "### LOW (cosmetic / worth fixing)",
    "1. The shared wiki's Glossary section lists renderings in a different order than glossary.md.",
    "",
    "## Artifacts audited",
    "- glossary.md",
    "- character-voice.md",
    "- style-guide.md",
    "- shared-wiki.md",
    "",
  ].join("\n");
}

/** The manifest the intake agent writes (schema 2, per `validateManifest`). */
function manifestJson(seriesDir) {
  return JSON.stringify(
    {
      schema: 2,
      seriesName: SERIES.name,
      seriesNameAlt: SERIES.alt,
      sourceLanguage: SERIES.sourceLanguage,
      targetLanguage: SERIES.targetLanguage,
      seriesLocation: seriesDir,
      discovery: {
        summary:
          "Two plain-text books at the series root, both continuous Japanese prose in the same academy, titled 1 and 2. Staged each into its own folder and ordered them by the volume number each file carries in its name and by the recap in the second book.",
        confidence: { seriesName: 0.9, sourceLanguage: 0.95, order: 0.9 },
        evidence: [
          "Both files open with continuous prose and share the academy setting.",
          "The file names carry 01 and 02, and volume 2 recaps volume 1's fog.",
          "Kana present throughout, no hangul — Japanese.",
        ],
        excluded: [],
      },
      volumes: VOLUMES.map((v, i) => ({
        installmentNumber: v.installment,
        folder: v.folder,
        sourceFile: `${v.folder}/${v.stagedFile}`,
        title: v.title,
        notes: "",
        integrity: {
          isNarrative: true,
          confidence: 0.9,
          basis: `Opening ${sourceTextOf(v).length} characters are continuous first-person prose with scene breaks; characters act and speak rather than list information.`,
        },
      })),
    },
    null,
    2
  );
}

function planMarkdown() {
  return [
    `# Translation Plan — ${SERIES.alt}`,
    "",
    `Series name: ${SERIES.name} (${SERIES.alt})`,
    `Source language: ${SERIES.sourceLanguage}`,
    "",
    "## Reading order",
    "",
    ...VOLUMES.map((v, i) => `${i + 1}. ${v.folder} — ${v.title}`),
    "",
    "## Excluded",
    "",
    "Nothing.",
    "",
  ].join("\n");
}

// ─── Fixture self-check ──────────────────────────────────────────────────────

/**
 * Prove the scripted answers satisfy the pipeline's own no-AI rules BEFORE the
 * run, so a failure during the run means the pipeline broke, not the script.
 * Checks the same things `checkTranslationQa` checks: source-script residue, the
 * per-pair length band, and a canonical rendering for every glossary term the
 * source actually uses. Also checks the paragraph alignment the targeted-repair
 * mapping depends on.
 *
 * @returns {Array<{volume: string, check: string, ok: boolean, detail: string}>}
 */
function selfCheck() {
  const out = [];
  const push = (volume, check, ok, detail) => out.push({ volume, check, ok, detail });
  const kana = /[\u3040-\u30ff\u4e00-\u9fff]/g;
  for (const volume of VOLUMES) {
    const src = sourceTextOf(volume);
    const draft = draftTextOf(volume);
    const polished = polishedTextOf(volume);
    push(volume.installment, "volume text floor", src.length >= 1000, `${src.length} source characters (DISCOVER_MIN_VOLUME_TEXT_CHARS is 1000)`);
    const residue = (draft.match(kana) || []).length / Math.max(1, draft.length);
    push(volume.installment, "draft residue", residue <= 0.005, `${(residue * 100).toFixed(2)}% source script in the draft`);
    const ratio = draft.length / src.length;
    push(volume.installment, "length band", ratio >= 0.6 && ratio <= 2.5, `draft/source = ${ratio.toFixed(2)} (JA→EN band 0.6–2.5)`);
    const fixedRatio = fixedTextOf(volume).length / src.length;
    push(volume.installment, "retranslated length band", fixedRatio >= 0.6 && fixedRatio <= 2.5, `draft/source = ${fixedRatio.toFixed(2)}`);
    const polishedRatio = polished.length / src.length;
    push(volume.installment, "polished length band", polishedRatio >= 0.6 && polishedRatio <= 2.5, `draft/source = ${polishedRatio.toFixed(2)}`);
    const paragraphsMatch = src.split("\n\n").length === draft.split("\n\n").length && draft.split("\n\n").length === polished.split("\n\n").length;
    push(volume.installment, "paragraph alignment", paragraphsMatch, `${src.split("\n\n").length} source / ${draft.split("\n\n").length} draft / ${polished.split("\n\n").length} polished`);
    for (const term of termsForVolume(volume.installment)) {
      if (!src.includes(term.term)) continue;
      push(volume.installment, `glossary rendering: ${term.term}`, draft.includes(term.rendering) && polished.includes(term.rendering), `"${term.rendering}" in the draft and the polished text`);
    }
  }
  return out;
}

// ─── The brain ───────────────────────────────────────────────────────────────

/**
 * System-prompt signatures → what kind of call this is. Matched longest-first, so
 * "…operating in **revision mode**" wins over the same role's author prompt.
 */
const SIGNATURES = [
  ["# Series Intake Agent", "intake"],
  ["**Terminology Extraction Specialist**", "glossary-extract"],
  ["**Localization Terminology Specialist** operating in **revision mode**", "glossary-feedback"],
  ["**Localization Terminology Specialist** maintaining", "glossary-author"],
  ["**Glossary Auditor**", "glossary-validator"],
  ["**Quality Gatekeeper** for a translation glossary", "acceptance"],
  ["**Voice and Perspective Analyst**", "voice-extract"],
  ["**Character Voice Archivist** operating in **revision mode**", "voice-feedback"],
  ["**Character Voice Archivist** maintaining", "voice-author"],
  ["**Character Voice and Perspective Auditor**", "voice-validator"],
  ["**Quality Gatekeeper** for a character voice", "acceptance"],
  ["**Style Convention Analyst**", "style-extract"],
  ["**Style Guide Archivist** operating in **revision mode**", "style-feedback"],
  ["**Style Guide Archivist** maintaining", "style-author"],
  ["**Style Guide Auditor**", "style-validator"],
  ["**Quality Gatekeeper** for a style guide", "acceptance"],
  ["**Series Continuity Archivist** operating in **revision mode**", "wiki-feedback"],
  ["**Series Continuity Archivist** maintaining", "wiki-author"],
  ["**Series Continuity Auditor**", "wiki-validator"],
  ["**Quality Gatekeeper** for a jump-in wiki", "acceptance"],
  ["You are the final consistency auditor", "audit-agent"],
  ["**cross-chapter consistency auditor**", "volume-consistency"],
  ["**strict translation quality auditor**", "verify"],
  ["**senior literary proofreader**", "polish"],
  ["**strict drift auditor**", "polish-audit"],
].sort((a, b) => b[0].length - a[0].length);

/**
 * Identify a request: which stage prompt it is, which volume it works on, and how
 * far into an agent turn it already is.
 *
 * @param {import("./fake-backend").FakeRequest} req
 * @returns {{kind: string, volume: object|null, toolStepsDone: number, systemText: string}}
 */
function classify(req) {
  const systemText = (req.messages || [])
    .filter((m) => m.role === "system")
    .map((m) => (typeof m.content === "string" ? m.content : (m.content || []).map((p) => p?.text || "").join("")))
    .join("\n");
  let kind = "unknown";
  for (const [signature, name] of SIGNATURES) {
    if (systemText.includes(signature) || req.allText.includes(signature)) {
      kind = name;
      break;
    }
  }
  // The token-calibration probe (`measurePromptTokens`): one user message, no
  // system prompt, max_tokens 1 — the server's own usage count is the answer.
  if (kind === "unknown" && !systemText && req.maxTokens === 1) {
    kind = "calibration-probe";
  }
  // The Index-Translate translation contract (translate and retranslate share it — see
  // translate.js / retranslate.js). The instTrans 【源文】 block is the signature, NOT the absence of
  // a system message: a translator call that wrongly carries a system prompt must still be recognised
  // as a translator call, or the audit would classify it as unknown and never notice.
  if (kind === "unknown" && req.userText.includes("【源文】")) {
    kind = req.userText.includes("本次译文必须全部修正") ? "retranslate" : "translate";
  }
  // Which volume is this request about? Match the SOURCE TEXT it carries first: a
  // translate prompt has no "Volume: NN" header at all (its identity is the book
  // text), and its continuity tail quotes the PREVIOUS volume's ending — so the
  // first "volume NN" string in it can name the wrong one. The number is the
  // fallback for the calls that never see the source (polish, acceptance).
  const volume =
    volumeForText(req.userText) ||
    (() => {
      const installmentMatch = req.allText.match(/[Vv]olume\s+(?:being\s+(?:processed|validated)[:* ]*)?(\d{1,2})\b/);
      return installmentMatch ? volumeByInstallment.get(installmentMatch[1].padStart(2, "0")) || null : null;
    })();
  const toolStepsDone = (req.messages || []).filter((m) => m.role === "assistant" && Array.isArray(m.tool_calls) && m.tool_calls.length > 0).length;
  return { kind, volume, toolStepsDone, systemText };
}

/**
 * The scripted answer for one request.
 *
 * @param {import("./fake-backend").FakeRequest} req
 * @param {{seriesDir: string, log: (line: string) => void}} ctx
 * @returns {import("./fake-backend").FakeReply}
 */
function answer(req, ctx) {
  const { kind, volume, toolStepsDone } = classify(req);
  const vol = volume || VOLUMES[0];

  // The token-calibration probe: one user message, max_tokens 1, no system prompt.
  if (req.maxTokens === 1) {
    const sample = req.userText || "";
    const cjk = (sample.match(/[\u3040-\u30ff\u4e00-\u9fff]/g) || []).length;
    const other = sample.length - cjk;
    // What a real server reports: the sample's own tokens plus the chat template.
    const promptTokens = Math.round(cjk * 0.62 + other * 0.3) + 40;
    return { text: "x", usage: { prompt_tokens: promptTokens, completion_tokens: 1, total_tokens: promptTokens + 1 } };
  }

  // ── Agent turns: the next step of that agent's scripted plan ──────────────
  if (req.tools && req.tools.length > 0) {
    const steps = agentSteps(kind, vol, ctx);
    const step = steps[Math.min(toolStepsDone, steps.length - 1)];
    return step;
  }

  // ── Tool-less one-shots ───────────────────────────────────────────────────
  switch (kind) {
    case "glossary-extract": {
      const terms = newTermsForVolume(vol.installment);
      return {
        text: JSON.stringify(terms.map((t) => ({ term: t.term, type: t.type, query: `${SERIES.alt} ${t.rendering}` })), null, 2),
      };
    }
    case "voice-extract":
      return {
        text: JSON.stringify(
          [
            {
              type: "voice",
              character: "灯里",
              quirkType: "phrasing",
              description: "Avoids the request form; speaks as a confirmation rather than an order.",
              examples: ["もう一度確認したい"],
              formalityLevel: "neutral",
              notes: "Consistent across the volume.",
            },
            {
              type: "voice",
              character: "悠真",
              quirkType: "phrasing",
              description: "Defines a term before using it; rejects metaphor.",
              examples: ["技術は反復で、魔法は依頼だ"],
              formalityLevel: "formal",
              notes: "",
            },
            {
              type: "pov",
              povCategory: "narration",
              marker: "none",
              assignedCharacter: "主人公",
              narrationType: "first-person-internal",
              sectionDescription: "The whole volume stays inside the protagonist; the roof scenes drift into free indirect discourse.",
              examples: ["私はその輪郭を数えるのが好きだった"],
              notes: "",
            },
          ],
          null,
          2
        ),
      };
    case "style-extract":
      return {
        text: JSON.stringify(
          [
            {
              category: "honorific",
              pattern: "さん after a classmate's name",
              description: "Classmates use -san in narration and address.",
              examples: ["灯里さん"],
              frequency: "high",
              notes: "The register is carried by word choice in English.",
            },
            {
              category: "internalMonologue",
              pattern: "だ / である endings inside thought",
              description: "Thought lines are plain declaratives with no quotation marks.",
              examples: ["誰もその書類に署名しない"],
              frequency: "high",
              notes: "",
            },
            {
              category: "tense",
              pattern: "past narration with present-tense thought",
              description: "Narration is past; the thought inside it is present.",
              examples: ["数えるのが好きだった"],
              frequency: "medium",
              notes: "",
            },
          ],
          null,
          2
        ),
      };
    case "acceptance": {
      const score = ACCEPTANCE_SCORES[vol.installment] ?? 78;
      const band = score >= 85 ? "Pass" : "Pass with minor edits";
      return { text: JSON.stringify({ score, band, note: "Complete, consistent, and translation-ready." }) };
    }
    case "verify": {
      // The repaired draft carries the clause the verifier flagged as missing —
      // that is how the scripted grader knows it is re-grading a repaired chapter.
      const repair = REPAIRS[vol.installment];
      const repaired = repair && req.userText.includes(repair.marker);
      const score = repaired ? (VERIFY_SCORES_ROUND2[vol.installment] ?? 88) : VERIFY_SCORES[vol.installment] ?? 92;
      if (score >= 85) return { text: `SCORE: ${score}/100\n\n## Findings\n(no findings)` };
      // The finding quotes the draft's own closing words, so it is a real quote from
      // the text the verifier was shown (and it carries no `Source: "…"` line, which
      // is what makes `planTargetedRepair` refuse the shortcut and retranslate the
      // whole chapter — one call instead of several).
      const paragraph = vol.paragraphs[repair.index].en;
      const tail = paragraph.slice(Math.max(0, paragraph.length - 64));
      return {
        text:
          `SCORE: ${score}/100\n\n## Findings\n` +
          `1. **[HIGH] The paragraph stops one clause early.**\n` +
          `   - Translation: "…${tail}"\n` +
          `   - Fix: Translate the paragraph's final clause in full — the source says the sending had already happened.\n`,
      };
    }
    case "volume-consistency":
      return { text: "(no findings)" };
    case "translate":
      return { text: draftTextOf(vol) };
    case "retranslate":
      return { text: fixedTextOf(vol) };
    case "polish":
      return { text: polishedTextOf(vol) };
    case "polish-audit": {
      const score = POLISH_AUDIT_SCORES[vol.installment] ?? 90;
      return { text: `SCORE: ${score}/100\n\n## Findings\n(no findings)` };
    }
    default:
      ctx.log(`UNSCRIPTED request (model=${req.model}, tools=${req.tools ? req.tools.length : 0}): ${req.allText.slice(0, 160)}`);
      return { text: "" };
  }
}

/**
 * The scripted plan for one agent turn: a list of assistant messages, consumed in
 * order as the turn's steps. Each entry is either tool calls (executed FOR REAL by
 * the harness, through the real approve gate) or the final chat reply.
 *
 * @param {string} kind
 * @param {object} volume
 * @param {{seriesDir: string}} ctx
 * @returns {import("./fake-backend").FakeReply[]}
 */
function agentSteps(kind, volume, ctx) {
  const read = (filePath) => ({ name: "readFile", arguments: { filePath } });
  const write = (filePath, content) => ({ name: "writeFile", arguments: { filePath, content } });
  const done = (text) => ({ text, finishReason: "stop" });

  switch (kind) {
    case "intake":
      return [
        { toolCalls: [{ name: "listFiles", arguments: { dirPath: "." } }], finishReason: "tool_calls" },
        {
          toolCalls: VOLUMES.map((v) => read(v.looseFile)),
          finishReason: "tool_calls",
        },
        {
          toolCalls: VOLUMES.map((v) => ({
            name: "stageVolume",
            arguments: { sourceFile: v.looseFile, folder: v.folder, as: v.stagedFile },
          })),
          finishReason: "tool_calls",
        },
        { toolCalls: [write("translation-target.draft.json", manifestJson(ctx.seriesDir))], finishReason: "tool_calls" },
        { toolCalls: [write("translation-plan.md", planMarkdown())], finishReason: "tool_calls" },
        done("Staged both volumes into their own folders and wrote the plan of record. Both books are Japanese prose; the order follows the number each file carries."),
      ];

    case "glossary-author":
    case "glossary-feedback":
      return [
        { toolCalls: [read(volume.stagedFile)], finishReason: "tool_calls" },
        { toolCalls: [write("glossary.md", glossaryMarkdown(volume))], finishReason: "tool_calls" },
        done(`Wrote glossary.md for volume ${volume.installment}.`),
      ];

    case "glossary-validator":
      return [
        { toolCalls: [read("glossary.md")], finishReason: "tool_calls" },
        { toolCalls: [write("glossary-validation.md", validationMarkdown("glossary", volume, 1))], finishReason: "tool_calls" },
        done("Wrote glossary-validation.md."),
      ];

    case "voice-author":
    case "voice-feedback":
      return [
        { toolCalls: [read(volume.stagedFile)], finishReason: "tool_calls" },
        { toolCalls: [write("character-voice.md", characterVoiceMarkdown(volume))], finishReason: "tool_calls" },
        { toolCalls: [write("pov-map.md", povMapMarkdown(volume))], finishReason: "tool_calls" },
        done(`Wrote character-voice.md and pov-map.md for volume ${volume.installment}.`),
      ];

    case "voice-validator":
      return [
        { toolCalls: [read("character-voice.md")], finishReason: "tool_calls" },
        { toolCalls: [write("character-voice-validation.md", validationMarkdown("character-voice", volume, 1))], finishReason: "tool_calls" },
        done("Wrote character-voice-validation.md."),
      ];

    case "style-author":
    case "style-feedback":
      return [
        { toolCalls: [read(volume.stagedFile)], finishReason: "tool_calls" },
        { toolCalls: [write("style-guide.md", styleGuideMarkdown(volume))], finishReason: "tool_calls" },
        done(`Wrote style-guide.md for volume ${volume.installment}.`),
      ];

    case "style-validator":
      return [
        { toolCalls: [read("style-guide.md")], finishReason: "tool_calls" },
        { toolCalls: [write("style-guide-validation.md", validationMarkdown("style-guide", volume, 1))], finishReason: "tool_calls" },
        done("Wrote style-guide-validation.md."),
      ];

    case "wiki-author":
    case "wiki-feedback":
      return [
        { toolCalls: [read(volume.stagedFile)], finishReason: "tool_calls" },
        { toolCalls: [write("wiki.md", wikiMarkdown(volume))], finishReason: "tool_calls" },
        { toolCalls: [write("shared-wiki.md", sharedWikiMarkdown(volume))], finishReason: "tool_calls" },
        done(`Wrote wiki.md and shared-wiki.md for volume ${volume.installment}.`),
      ];

    case "wiki-validator":
      return [
        { toolCalls: [read("shared-wiki.md")], finishReason: "tool_calls" },
        {
          toolCalls: [write(`jump-in-wiki-validation-${volume.installment}.md`, validationMarkdown("jump-in-wiki", volume, 1))],
          finishReason: "tool_calls",
        },
        done(`Wrote jump-in-wiki-validation-${volume.installment}.md.`),
      ];

    case "audit-agent":
      return [
        { toolCalls: [read("glossary.md"), read("character-voice.md")], finishReason: "tool_calls" },
        { toolCalls: [read("style-guide.md"), read("shared-wiki.md")], finishReason: "tool_calls" },
        { toolCalls: [write("consistency-report.md", consistencyReportMarkdown())], finishReason: "tool_calls" },
        done("Report written."),
      ];

    default:
      return [done("Nothing to do.")];
  }
}

// ─── Fixture writer ──────────────────────────────────────────────────────────

/**
 * Lay out the series the intake agent will work on: two loose plain-text books at
 * the series root and nothing else (the intake agent is the one that names the
 * volume folders and stages the books).
 *
 * The books are pure prose — no title line. A title line becomes a paragraph of
 * the source, and a source whose paragraph count the translation does not answer
 * paragraph-for-paragraph is a source the targeted repair cannot map (gotcha 47):
 * every retranslate would fall back to a whole-chapter rewrite for a fixture
 * artifact, not for a real one.
 *
 * @param {string} seriesDir
 */
function writeFixtureSources(seriesDir) {
  fs.mkdirSync(seriesDir, { recursive: true });
  for (const volume of VOLUMES) {
    fs.writeFileSync(path.join(seriesDir, volume.looseFile), `${sourceTextOf(volume)}\n`, "utf8");
  }
}

module.exports = {
  SERIES,
  TERMS,
  VOLUMES,
  ACCEPTANCE_SCORES,
  VERIFY_SCORES,
  VERIFY_SCORES_ROUND2,
  POLISH_AUDIT_SCORES,
  RETRANSLATED_VOLUME,
  REPAIRS,
  answer,
  classify,
  selfCheck,
  writeFixtureSources,
  sourceTextOf,
  draftTextOf,
  polishedTextOf,
  fixedTextOf,
  termsForVolume,
  newTermsForVolume,
  volumeForText,
  stripWhitespace,
  glossaryMarkdown,
  consistencyReportMarkdown,
};
