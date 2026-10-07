/**
 * The line itself, and the annotation that puts it on every tool answer. At the soft level it tells the agent to offload BEFORE its next read; at the hard level the harness offloads by itself.
 *
 * Part of the context.js layer (split out of the original single file).
 */

/**
 * The line the agent sees in every tool result — the mechanism ACM's case study
 * shows actually produces context-management behaviour.
 *
 * Without it the two tools sit unused, which is what the paper measured on
 * frontier models. It is deliberately a plain number with a plain instruction.
 *
 * @param {{tokens: number, window: number, fraction: number, level: string}} pressure
 * @returns {string} e.g. `| working window: 231,000 / 262,144 tokens (88%) — offload with manage_context(...) before your next read`
 */
function pressureLine(pressure) {
  if (!pressure || !pressure.window) return "";
  const pct = Math.round(pressure.fraction * 100);
  const head = `| working window: ${pressure.tokens.toLocaleString("en-US")} / ${pressure.window.toLocaleString("en-US")} tokens (${pct}%)`;
  if (pressure.level === "hard") {
    return `${head} — FULL. Offload with manage_context(...) now; further reads will be trimmed automatically.`;
  }
  if (pressure.level === "soft") {
    return `${head} — getting full. Offload what you no longer need with manage_context(...) BEFORE your next read.`;
  }
  return head;
}


/**
 * Attach the pressure line to a tool result, so the agent sees its own pressure
 * at the moment it is deciding what to look at next.
 *
 * Handles the shapes the fs tools actually return (an object with a `status`
 * line, or a plain string) and leaves anything else alone rather than corrupting
 * it.
 *
 * @param {*} result - The tool's return value.
 * @param {Object} pressure - From windowPressure.
 * @returns {*} The same result, annotated.
 */
function annotateToolResult(result, pressure) {
  const line = pressureLine(pressure);
  if (!line) return result;
  if (typeof result === "string") return `${result}\n${line}`;
  if (result && typeof result === "object" && !Array.isArray(result)) {
    const out = { ...result };
    out.status = [out.status, line].filter(Boolean).join(" ");
    return out;
  }
  return result;
}

// ─── What may never be offloaded (design R3/R4/R5/R6) ───────────────────────


module.exports = {
  pressureLine,
  annotateToolResult,
};
