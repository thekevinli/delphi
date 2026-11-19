import assert from 'node:assert/strict';
import test from 'node:test';
import { capturedQuote } from '../main/research/source-quotes.ts';
test('PDF typography matches while saving the actual captured passage', () => {
  const source = 'We synthesize a matrixP∈\nRD×d that is column-orthogonal. We studyx,ϵ, orv-\nprediction, all using thev-loss. Onlyx-predictioncan produce rea-\nsonable results. A ﬁxed model.';
  assert.equal(capturedQuote(source, '“We synthesize a matrix P ∈ R^{D×d} that is column-orthogonal.”'), source.slice(0, source.indexOf(' We study')));
  assert.equal(capturedQuote(source, '"We study x, ϵ, or v-prediction, all using the v-loss."'), 'We studyx,ϵ, orv-\nprediction, all using thev-loss.');
  assert.equal(capturedQuote(source, 'Only x-prediction can produce reasonable results.'), 'Onlyx-predictioncan produce rea-\nsonable results.');
  assert.equal(capturedQuote(source, 'A fixed model.'), 'A ﬁxed model.');
});
test('changed facts, missing negation, mathematical operators and paraphrases still fail', () => {
  const text = 'The 256-dim model does not succeed. x-y = 2. Training fails.';
  for (const quote of ['The 512-dim model does not succeed.', 'The 256-dim model does succeed.', 'xy = 2.', 'x+y = 2.', 'Training succeeds.', '']) assert.equal(capturedQuote(text, quote), undefined);
});

test('single-character exponent notation matches flattened PDF superscripts', () => {
  const source = 'The observed data\nisx=P ˆx∈R D, where the underlying data is ˆx∈R d.';
  assert.equal(capturedQuote(source, 'The observed data is x = Pˆx ∈ R^D, where the underlying data is ˆx ∈ R^d.'), source);
  assert.equal(capturedQuote(source, 'The observed data is x = Pˆx ∈ R^d, where the underlying data is ˆx ∈ R^D.'), undefined);
});
