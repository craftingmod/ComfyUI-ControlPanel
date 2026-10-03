declare module "@tbela99/css-parser" {
  type CssNode = { sel?: string }

  export function parse(css: string): Promise<{ ast: unknown }>
  export function walk(ast: unknown): Iterable<{ node: CssNode }>
}
