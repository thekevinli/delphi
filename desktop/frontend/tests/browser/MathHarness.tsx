import { useState } from 'react';
import katex from 'katex';
import { MemoAssistantMessage } from '../../app/components/markdown';
import { MemoizedMemoryBody } from '../../app/components/MemoryMarkdown';
import ResearchDigestView from '../../app/components/ResearchDigestView';
import TitleText from '../../app/components/TitleText';
import { fraction, mathDocument, assignments, notation, digestList, legacyList, malformed, proseFences } from '../math-fixture';
import 'katex/dist/katex.min.css';

const pages = new Map();
const noop = () => {};
export default function MathHarness() {
  const params = new URLSearchParams(location.search), surface = params.get('surface');
  const [source, setSource] = useState(params.has('audit')
    ? [...assignments, ...notation, surface === 'digest' ? digestList : surface === 'memory' ? legacyList : 'Tail.'].join('\n\n')
    : params.has('malformed') ? malformed : params.has('fences') ? proseFences : params.get('source') ?? mathDocument);
  return <main style={{ padding: 20 }}>
    <button onClick={() => setSource(source + ' More text.')}>Stream token</button>
    <div data-testid="math-body" style={{ maxWidth: 640 }}>
      {surface === 'digest' ? <ResearchDigestView digest={{ contentMarkdown: source, citations: [1, 2].map(id => ({ id, claimType: "author-claim", page: id, section: null })), assets: [] }}
        projectId="project" paperId="paper" documentHref="/fixture" onNavigate={noop} />
      : <div className="message assistant"><div className="kb-chat-turn"><div className="message-markdown prose-reading">
        {surface === 'memory' ? <MemoizedMemoryBody body={source} figures={[]} pages={pages} onOpen={noop} /> : <MemoAssistantMessage content={source} />}
      </div></div></div>}
    </div>
    <div data-testid="title"><TitleText title={String.raw`Ratio $\frac{x^2}{y^3}$`} /></div>
    <div data-testid="reference" dangerouslySetInnerHTML={{ __html: katex.renderToString(fraction, { displayMode: true }) }} />
  </main>;
}
