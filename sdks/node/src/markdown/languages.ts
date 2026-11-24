/**
 * Code block languages. Notion stores the display name (`properties.language`), Markdown fences
 * use a lower-case tag. Verified against official output: "Plain Text" → `txt`,
 * "JavaScript" → `javascript` (same-page comparison with the official output). Every other
 * name maps to its lower-case form, which is unverified.
 */
const NOTION_LANGUAGES = [
  "ABAP", "Agda", "Arduino", "ASCII Art", "Assembly", "Bash", "BASIC", "BNF", "C", "C#", "C++", "Clojure",
  "CoffeeScript", "Coq", "CSS", "Dart", "Dhall", "Diff", "Docker", "EBNF", "Elixir", "Elm", "Erlang", "F#",
  "Flow", "Fortran", "Gherkin", "GLSL", "Go", "GraphQL", "Groovy", "Haskell", "HCL", "HTML", "Idris", "Java",
  "JavaScript", "JSON", "Julia", "Kotlin", "LaTeX", "Less", "Lisp", "LiveScript", "LLVM IR", "Lua", "Makefile",
  "Markdown", "Markup", "MATLAB", "Mathematica", "Mermaid", "Nix", "Notion Formula", "Objective-C", "OCaml",
  "Pascal", "Perl", "PHP", "Plain Text", "PowerShell", "Prolog", "Protobuf", "PureScript", "Python", "R",
  "Racket", "Reason", "Ruby", "Rust", "Sass", "Scala", "Scheme", "SCSS", "Shell", "Smalltalk", "Solidity",
  "SQL", "Swift", "TOML", "TypeScript", "VB.Net", "Verilog", "VHDL", "Visual Basic", "WebAssembly", "XML", "YAML",
] as const;

const SPECIAL_TAGS: Record<string, string> = { "Plain Text": "txt" };

export function languageTag(notionName: string | undefined): string {
  if (!notionName) return "txt";
  return SPECIAL_TAGS[notionName] ?? notionName.toLowerCase();
}

const BY_TAG = new Map<string, string>();
for (const name of NOTION_LANGUAGES) BY_TAG.set((SPECIAL_TAGS[name] ?? name.toLowerCase()), name);
const ALIASES: Record<string, string> = {
  "": "Plain Text", text: "Plain Text", plaintext: "Plain Text", "plain text": "Plain Text",
  js: "JavaScript", ts: "TypeScript", py: "Python", sh: "Shell", zsh: "Shell", yml: "YAML", md: "Markdown",
  "c++": "C++", cpp: "C++", "c#": "C#", csharp: "C#", golang: "Go", rb: "Ruby", rs: "Rust", kt: "Kotlin",
};

/** Notion display name for a fence tag; unknown tags fall back to "Plain Text". */
export function languageName(tag: string | undefined): string {
  const t = (tag ?? "").trim().toLowerCase();
  return BY_TAG.get(t) ?? ALIASES[t] ?? "Plain Text";
}
