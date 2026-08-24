const g = require("./glossary");
console.log("exports:", Object.keys(g).join(", "));
const sample = "```json\n[{\"term\":\"如月雨露\",\"type\":\"character\",\"query\":\"如月雨露\"},{\"term\":\"例の町\",\"type\":\"place\"}]\n```";
console.log("parseTerms fenced:", JSON.stringify(g.parseTerms(sample)));
console.log("parseTerms plain:", JSON.stringify(g.parseTerms("[{\"term\":\"A\"}]")));
console.log("parseTerms empty:", JSON.stringify(g.parseTerms("[]")));
console.log("parseTerms prose:", JSON.stringify(g.parseTerms("Here are the terms:\n[{\"term\":\"B\",\"type\":\"item\",\"query\":\"B\"}]\nDone.")));
