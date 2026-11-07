/** Notion puts the product in the tab title. That is not the article's name. */
const NOTION_SUFFIX = /\s*[|–—]\s*Notion\s*$/i;

export function pageTitle(title: string): string {
  return title.replace(NOTION_SUFFIX, "").trim() || title;
}
