/**
 * style-guide.js — the "how do I write it" policy layer.
 *
 * The glossary says what to call things, character-voice says how characters sound, the
 * wiki says what is happening; the style guide says how source-language constructs are
 * rendered in the target language (honorifics, pronouns, sentence-ending particles,
 * internal-monologue markers, onomatopoeia, interjections, POV and scene markers, tense,
 * punctuation, wordplay, translator notes). It is written in the TARGET language, quoting
 * source-language patterns inline, and it is cumulative.
 *
 * Rules must be ACTIONABLE — a concrete rendering decision (keep / drop / translate /
 * adapt) with context and exceptions; vague guidance is a validation finding. Undecidable
 * constructs go to an "Open Questions" section with their context rather than being guessed.
 *
 * This file is the public face of the layer: apart from the declarations noted
 * below it holds no logic, only re-exports. The implementation lives in
 * ./style-guide/ — open the module that owns the behaviour you are changing
 * instead of reading all of them.
 */

// .env, then the one setting that has a default — both before any task module is
// required, because several of them read these values at require time (gotcha 79).
require("./configs/env-defaults").bootstrapEnv();
require("./types");
const { emittedToolCallAsText } = require("./utils/agents");

const __config = require("./style-guide/config");
const __carry_forward = require("./style-guide/carry-forward");
const __reference_index = require("./style-guide/reference-index");
const __prompts = require("./style-guide/prompts");
const __amend = require("./style-guide/amend");
const __stages = require("./style-guide/stages");
const __qa = require("./style-guide/qa");
const __chunked = require("./style-guide/chunked");
const __task = require("./style-guide/task");

module.exports = {
  ...__config,
  ...__carry_forward,
  ...__reference_index,
  ...__prompts,
  ...__amend,
  ...__stages,
  ...__qa,
  ...__chunked,
  ...__task,
  emittedToolCallAsText,
};
