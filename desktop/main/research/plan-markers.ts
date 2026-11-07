// Only the server's delphi-artifact envelope is special here. Its source is
// already validated and must remain byte-for-byte intact; plan commands keep
// their existing meaning everywhere outside that envelope.
function artifactFence(line: string, current: number): number | undefined {
  const text = line.replace(/\r?\n$/, "");
  if (current) {
    const close = /^ {0,3}(`{3,})[\t ]*$/.exec(text);
    return close && close[1].length >= current ? 0 : undefined;
  }
  const open = /^ {0,3}(`{3,})delphi-artifact(?:[\t ][^`\r\n]*)?$/.exec(text);
  return open?.[1].length;
}

function possibleFence(line: string, current: number): boolean {
  const text = line.replace(/^ {0,3}/, "");
  if (!text) return true;
  const ticks = /^`+/.exec(text)?.[0];
  if (!ticks) return false;
  if (ticks.length === text.length) return true;
  if (ticks.length < 3) return false;
  const tail = text.slice(ticks.length);
  return current ? ticks.length >= current && /^[\t \r]*$/.test(tail)
    : "delphi-artifact".startsWith(tail) || /^delphi-artifact(?:[\t ][^`\r\n]*)?\r?$/.test(tail);
}

/** Incremental command detection holds only ambiguous fence/marker prefixes.
 * An artifact's HTML streams untouched even if a command marker occurs in it. */
export class PlanMarkerFilter {
  pending = "";
  hidden = false;
  private fence = 0;
  private lineStart = true;
  private marker: string;
  constructor(marker: string) { this.marker = marker; }

  push(text: string): string {
    this.pending += text;
    let output = "";
    const emit = (length: number) => {
      output += this.pending.slice(0, length);
      this.pending = this.pending.slice(length);
    };
    while (this.pending && !this.hidden) {
      const end = this.pending.indexOf("\n");
      const line = end < 0 ? this.pending : this.pending.slice(0, end + 1);
      if (this.lineStart && end >= 0) {
        const next = artifactFence(line, this.fence);
        if (next !== undefined) {
          this.fence = next;
          emit(line.length);
          continue;
        }
      }
      if (end < 0 && this.lineStart && possibleFence(line, this.fence)) break;
      if (this.fence) {
        emit(line.length);
        this.lineStart = end >= 0;
        continue;
      }
      const start = line.indexOf(this.marker);
      if (start >= 0) { emit(start); this.hidden = true; break; }
      const length = end >= 0 ? line.length : Math.max(0, line.length - this.marker.length);
      if (!length) break;
      emit(length);
      this.lineStart = end >= 0;
    }
    return output;
  }
}

/** History shields complete envelopes only. An unmatched example in the
 * original question must not hide its appended capability prompt receipt. */
export function planMarkerOutsideArtifacts(content: string): RegExpExecArray | null {
  const protectedRanges: Array<[number, number]> = [];
  let fence = 0, start = 0;
  for (const match of content.matchAll(/[^\n]*(?:\n|$)/g)) {
    if (!match[0]) continue;
    const next = artifactFence(match[0], fence);
    if (next === undefined) continue;
    if (!fence) start = match.index;
    else protectedRanges.push([start, match.index + match[0].length]);
    fence = next;
  }
  for (const match of content.matchAll(/```delphi-plan-([a-f0-9]+)(?:\n|$)/g)) {
    if (!protectedRanges.some(([start, end]) => match.index >= start && match.index < end)) return match;
  }
  return null;
}
