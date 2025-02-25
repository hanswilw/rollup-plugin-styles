import path from "path";
import postcss from "postcss";
import valueParser from "postcss-value-parser";

import { normalizePath } from "../../../utils/path";

import resolveDefault, { ImportResolve } from "./resolve";

const name = "styles-import";
const extensionsDefault = [".css", ".pcss", ".postcss", ".sss"];

/** `@import` handler options */
export interface ImportOptions {
  /**
   * Provide custom resolver for imports
   * in place of the default one
   */
  resolve?: ImportResolve;
  /**
   * Aliases for import paths.
   * Overrides the global `alias` option.
   * - ex.: `{"foo":"bar"}`
   */
  alias?: Record<string, string>;
  /**
   * Import files ending with these extensions.
   * Overrides the global `extensions` option.
   * @default [".css", ".pcss", ".postcss", ".sss"]
   */
  extensions?: string[];
}

const plugin: postcss.Plugin<ImportOptions> = postcss.plugin(
  name,
  (options = {}) => async (css, res): Promise<void> => {
    if (!css.source?.input.file) return;

    const resolve = options.resolve ?? resolveDefault;
    const alias = options.alias ?? {};
    const extensions = options.extensions ?? extensionsDefault;

    const opts: postcss.ResultOptions = { ...res.opts };
    delete opts.map;

    const { file } = css.source.input;
    const importList: { importRule: postcss.AtRule; url: string }[] = [];
    const basedir = path.dirname(file);

    css.walkAtRules(/^import$/i, importRule => {
      // Top level only
      if (importRule.parent.type !== "root") {
        importRule.warn(res, "`@import` should be top level");
        return;
      }

      // Child nodes should not exist
      if (importRule.nodes) {
        importRule.warn(res, "`@import` was not terminated correctly");
        return;
      }

      const [urlNode] = valueParser(importRule.params).nodes;

      // No URL detected
      if (!urlNode || (urlNode.type !== "string" && urlNode.type !== "function")) {
        importRule.warn(res, `No URL in \`${importRule.toString()}\``);
        return;
      }

      let url = "";

      if (urlNode.type === "string") {
        url = urlNode.value;
      } else if (urlNode.type === "function") {
        // Invalid function
        if (!/^url$/i.test(urlNode.value)) {
          importRule.warn(res, `Invalid \`url\` function in \`${importRule.toString()}\``);
          return;
        }

        const isString = urlNode.nodes[0]?.type === "string";
        url = isString ? urlNode.nodes[0].value : valueParser.stringify(urlNode.nodes);
      }

      url = url.replace(/^\s+|\s+$/g, "");

      // Resolve aliases
      for (const [from, to] of Object.entries(alias)) {
        if (!url.startsWith(from)) continue;
        url = normalizePath(to) + url.slice(from.length);
      }

      // Empty url
      if (url.length === 0) {
        importRule.warn(res, `Empty URL in \`${importRule.toString()}\``);
        return;
      }

      importList.push({ importRule, url });
    });

    for await (const { importRule, url } of importList) {
      try {
        const { source, from } = await resolve(url, basedir, extensions);

        if (!(source instanceof Uint8Array) || typeof from !== "string") {
          importRule.warn(res, `Incorrectly resolved \`@import\` in \`${importRule.toString()}\``);
          continue;
        }

        if (normalizePath(from) === normalizePath(file)) {
          importRule.warn(res, `\`@import\` loop in \`${importRule.toString()}\``);
          continue;
        }

        const imported = await postcss(plugin(options)).process(source, { ...opts, from });
        res.messages.push(...imported.messages, { plugin: name, type: "dependency", file: from });

        if (!imported.root) importRule.remove();
        else importRule.replaceWith(imported.root);
      } catch {
        importRule.warn(res, `Unresolved \`@import\` in \`${importRule.toString()}\``);
      }
    }
  },
);

export default plugin;
