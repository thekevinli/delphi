import { spawn } from 'node:child_process';

export interface ReferenceImage { sourceId: string; page: number; data: string; }
// Isolate native PDF parsing in a child of the real bundled interpreter. Render
// actual source pages, never model-drawn reconstructions or guessed figure crops.
const script = `import sys,json,base64,io
import pypdfium2 as pdfium
pages=json.loads(sys.argv[1])
doc=pdfium.PdfDocument(sys.stdin.buffer.read())
out=[]
for number in pages:
 if number < 1 or number > len(doc): raise ValueError('Reference page is outside the document')
 page=doc[number-1]
 scale=min(1.6,1600/max(page.get_size()))
 image=page.render(scale=scale).to_pil()
 buf=io.BytesIO();image.save(buf,format='PNG')
 out.append({'page':number,'data':base64.b64encode(buf.getvalue()).decode('ascii')})
print(json.dumps(out))`;
export function renderReferencePages(python: string, pdf: Buffer, pages: number[], signal?: AbortSignal): Promise<{ page: number; data: string }[]> {
  if (signal?.aborted) return Promise.reject(new Error('Source capture timed out'));
  if (pdf.length > 20 * 1024 * 1024 || pages.length > 3 || pages.some(p => !Number.isInteger(p) || p < 1 || p > 2000)) return Promise.reject(new Error('Reference capture exceeds limits'));
  return new Promise((resolve, reject) => {
    const child = spawn(python, ['-c', script, JSON.stringify(pages)], { stdio: ['pipe', 'pipe', 'pipe'] });
    let output = '', error = ''; let stopped = false;
    const fail = (message: string) => { stopped = true; child.kill('SIGKILL'); reject(new Error(message)); };
    const abort = () => fail('Source capture timed out');
    signal?.addEventListener('abort', abort, {once:true});
    const timer = setTimeout(() => fail('Source page rendering timed out'), 30000);
    child.stdout.on('data', b => { output += b; if (output.length > 12 * 1024 * 1024) fail('Source images exceed limits'); });
    child.stderr.on('data', b => { error = (error + b).slice(-2000); });
    child.stdin.on('error', () => {});
    child.once('error', e => { signal?.removeEventListener('abort', abort); clearTimeout(timer); reject(e); });
    child.once('close', code => { signal?.removeEventListener('abort', abort); clearTimeout(timer); if (stopped) return; if (code !== 0) return reject(new Error('Cannot render source PDF: ' + error)); try { resolve(JSON.parse(output)); } catch { reject(new Error('Invalid source render result')); } });
    child.stdin.end(pdf);
  });
}
