/**
 * An inert route marker.
 *
 * The stable workspace is mounted by the reader layout and resolves the full
 * `@username/project/paper` pathname itself. Keeping this page empty preserves
 * PDF, chat, panel and zoom state across document switches.
 */
export default function ReaderPage() {
  return null;
}
