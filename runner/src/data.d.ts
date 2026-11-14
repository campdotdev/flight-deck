// Shipped scripts under `data/` that `src` imports as text with `with { type: "text" }`, so `bun build --compile`
// embeds them. TypeScript 7.0 doesn't read the import attribute, so each one is declared here.
declare module "*/data/retry-reset.cjs" {
  const text: string;
  export default text;
}
