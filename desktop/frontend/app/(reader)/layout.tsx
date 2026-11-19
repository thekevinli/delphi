import { Workspace } from "../components/Workspace";

/**
 * The reader's frame, and the reason it is a layout rather than a page.
 *
 * A layout instance is reused across a change to the segments *below* it, so
 * moving between documents — or between projects — updates this component rather
 * than replacing it. That is what keeps the library rail, the chat panel, the
 * panel widths, the per-document zoom, the citation trail and the warmed pdf.js
 * engine alive across a navigation. Rendering the workspace from a `page.tsx`
 * instead would tear all of it down and rebuild it on every click.
 *
 * The pages beneath are deliberately inert. `Workspace` reads the address itself
 * through `usePathname`/`useSearchParams`, which report the whole current URL
 * rather than only this segment's slice — so there is exactly one place that
 * turns a URL into ids, instead of three pages pushing params upward.
 *
 * The route group keeps the reading workspace separate from the Dashboard
 * and Memory surfaces.
 */
export default function ReaderLayout() {
  return <Workspace />;
}
