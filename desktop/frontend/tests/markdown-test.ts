import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import ReactMarkdown from 'react-markdown';
import { unified, type PluggableList } from 'unified';
import remarkParse from 'remark-parse';
import type { Root } from 'mdast';
import { visit } from 'unist-util-visit';
import { REMARK_PLUGINS, REHYPE_PLUGINS } from '../app/lib/markdown-pipeline.ts';

export function parse(source: string, plugins: PluggableList = []) {
  const processor = unified().use(remarkParse).use(REMARK_PLUGINS).use(plugins);
  return processor.runSync(processor.parse(source), source) as Root;
}
export function formulas(source: string, plugins: PluggableList = []) {
  const result: string[] = [];
  visit(parse(source, plugins), node => {
    if (node.type === 'math' || node.type === 'inlineMath') result.push(node.value);
  });
  return result;
}
export function render(source: string, plugins: PluggableList = []) {
  return renderToStaticMarkup(createElement(ReactMarkdown, {
    remarkPlugins: [...REMARK_PLUGINS, ...plugins], rehypePlugins: REHYPE_PLUGINS,
  }, source));
}
