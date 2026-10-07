/**
 *
 *
 * This file is the public face of the layer: apart from the declarations noted
 * below it holds no logic, only re-exports. The implementation lives in
 * ./patches/ — open the module that owns the behaviour you are changing
 * instead of reading all of them.
 */

const __rules = require("./patches/rules");
const __path_rules = require("./patches/path-rules");
const __record = require("./patches/record");
const __proposal = require("./patches/proposal");
const __checks = require("./patches/checks");
const __decide = require("./patches/decide");
const __git = require("./patches/git");
const __render = require("./patches/render");

module.exports = {
  ...__rules,
  ...__path_rules,
  ...__record,
  ...__proposal,
  ...__checks,
  ...__decide,
  ...__git,
  ...__render,
  renderPatchesMarkdown: (patches) => __render.renderPatchesMarkdown(patches === undefined ? __record.readPatches().patches : patches),
};
