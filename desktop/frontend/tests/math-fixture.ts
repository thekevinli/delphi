export const aligned = String.raw`\[
\begin{aligned}
y_1 &= Wx_1 + B_1 A_1 x_1 \\
y_2 &= Wx_2 + B_2 A_2 x_2
\end{aligned}
\]`;
export const shell = 'Run export PATH="$HOME/.local/bin:$PATH" and then use $x_i$.';
export const fraction = String.raw`\frac{\frac{x_i^2}{1+x_i}}{\sqrt{1+y_j^3}}`;
export const matrix = String.raw`$\begin{matrix}a\\beta\end{matrix}$`;
export const code = '~~~md\n`x²` and ![sample](asset:literal)\n\n[E1]\n~~~';
export const mathDocument = [
  '# Rendering specimen', '**Bold**, *italic*, and `literal_code`.', '---',
  aligned, shell, `Inline $${fraction}$ within prose.`, `$$\n${fraction}\n$$`,
  matrix, '> Quoted prose.\n>\n> Another paragraph.', '- First\n\n- Second',
  '| Name | Value |\n| --- | --- |\n| x | $x^2$ |', code, '$[E1]$',
  'Before $\\frac{x}{$ after.',
].join('\n\n');

export const assignments = [String.raw`d=$d_{model}$ dims`, String.raw`(n=$n_{\text{eff}}$)`,
  'Set x=$a+b$ here', 'Let k=$K - 1$ hold', String.raw`lr=$lr_0 \cdot \gamma^t$`];
export const notation = [String.raw`\(f[x](y)\)`, String.raw`\(a<b>c\)`];
export const digestList = '1. Loss:\n   $$L=\\sum_i x_i \\tag{1}$$ [E1]\n2. Next [E2]\n\nTail.';
// Settings, results and a pipeline a Memory page parked in text fences, beside one real formula.
export const proseFences = ['lr = 3e-4, batch = 256', 'Accuracy = 92.3% on GSM8K, +4.1 over baseline', 'encoder -> decoder -> head', 'L = a + b']
  .map(line => '```text\n' + line + '\n```').join('\n\n');
export const malformed = '\\begin{aligned}x &= 1\n\nThe prose between stays prose.\n\nOnly `\\end{aligned}` closes it, in code.';
export const legacyList = '- Legacy:\n\n  ```text\n  L = a + b\n  ```\n- Next';
