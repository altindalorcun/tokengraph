import { logoLockupSvg } from '@tokengraph/core';

export interface PageCard {
  id: string;
  title: string;
  fileName: string;
  width: number;
  height: number;
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// The lockup is inlined, so it needs no namespace (and the page promises not to contain a URL).
function logoMarkup(): string {
  return logoLockupSvg('dark')
    .replace(' xmlns="http://www.w3.org/2000/svg"', '')
    .replace('<svg ', '<svg class="logo" width="108" height="28" ')
    .trim();
}

const STYLE = `
:root{--bg:#0b0b0d;--ink:#f4f4f5;--muted:#a1a1aa;--accent:#ef4444;--line:#27272a;--panel:#131316;--panel-2:#18181b}
*{box-sizing:border-box;margin:0}
html{-webkit-text-size-adjust:100%;background:var(--bg)}
body{min-height:100vh;color:var(--ink);font:16px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;-webkit-font-smoothing:antialiased;
  background:radial-gradient(120% 60% at 50% -10%,rgba(239,68,68,.16),rgba(239,68,68,0) 60%),var(--bg);background-repeat:no-repeat;
  padding:max(24px,env(safe-area-inset-top)) max(20px,env(safe-area-inset-right)) max(40px,env(safe-area-inset-bottom)) max(20px,env(safe-area-inset-left))}
main{max-width:460px;margin:0 auto}
header{padding:8px 0 4px}
.logo{display:block;height:28px;width:auto}
h1{margin-top:28px;font-size:30px;line-height:1.15;font-weight:700;letter-spacing:-.025em;text-wrap:balance}
h1 .handle{color:var(--accent)}
.hint{display:flex;gap:12px;align-items:flex-start;margin-top:20px;padding:14px 16px;border:1px solid var(--line);border-radius:16px;background:var(--panel);color:var(--muted);font-size:15px;line-height:1.45}
.hint svg{flex:none;width:20px;height:20px;margin-top:1px;color:var(--accent)}
.hint strong{color:var(--ink);font-weight:600}
.cards{display:grid;gap:44px;margin-top:36px}
.card{display:block}
.meta{display:flex;align-items:baseline;gap:10px;margin-bottom:12px}
.num{font:500 13px/1 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;color:var(--accent);letter-spacing:.04em}
.meta h2{font-size:19px;font-weight:650;letter-spacing:-.01em}
.size{margin-left:auto;font:400 12px/1 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;color:var(--muted)}
.frame{position:relative;border:1px solid var(--line);border-radius:20px;overflow:hidden;background-color:var(--panel);
  background-image:radial-gradient(rgba(255,255,255,.07) 1px,transparent 1.4px);background-size:14px 14px;
  box-shadow:0 1px 0 rgba(255,255,255,.04) inset,0 24px 48px -16px rgba(0,0,0,.7),0 8px 16px -8px rgba(0,0,0,.6)}
.frame img{display:block;width:100%;height:auto}
.actions{display:grid;grid-template-columns:1fr;gap:10px;margin-top:14px}
.actions.has-share{grid-template-columns:1fr 1fr}
.btn{display:flex;align-items:center;justify-content:center;gap:8px;min-height:52px;padding:0 20px;border:0;border-radius:14px;font:inherit;font-size:17px;font-weight:600;letter-spacing:-.005em;text-decoration:none;cursor:pointer;-webkit-tap-highlight-color:transparent;touch-action:manipulation;transition:transform .12s ease,filter .12s ease,background-color .12s ease}
.btn svg{width:20px;height:20px;flex:none}
.btn:active{transform:scale(.97);filter:brightness(.92)}
.btn:focus-visible{outline:2px solid #fff;outline-offset:3px}
.save{color:#fff;background:linear-gradient(180deg,#ef4444,#dc2626);box-shadow:0 1px 0 rgba(255,255,255,.22) inset,0 10px 24px -10px rgba(239,68,68,.7)}
.save.done{background:var(--panel-2);color:var(--ink);box-shadow:0 0 0 1px var(--line) inset}
.share{color:var(--ink);background:var(--panel-2);box-shadow:0 0 0 1px var(--line) inset}
.share[hidden]{display:none}
footer{margin-top:56px;padding-top:20px;border-top:1px solid var(--line);color:var(--muted);font-size:14px;text-align:center}
footer code{font:500 13px ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;color:var(--ink)}
@media (prefers-reduced-motion:reduce){.btn{transition:none}}
`;

const SCRIPT = `
(function () {
  var ua = navigator.userAgent || '';
  var kind = /iPhone|iPad|iPod/.test(ua) || (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1) ? 'ios' : /Android/.test(ua) ? 'android' : 'other';
  document.querySelectorAll('[data-hint]').forEach(function (el) { el.hidden = el.getAttribute('data-hint') !== kind; });

  document.querySelectorAll('a.save').forEach(function (link) {
    link.addEventListener('click', function () {
      setTimeout(function () {
        link.classList.add('done');
        link.querySelector('span').textContent = 'Saved';
      }, 300);
    });
  });

  var canShare = false;
  try {
    canShare = !!(navigator.canShare && navigator.canShare({ files: [new File([], 'x.png', { type: 'image/png' })] }));
  } catch (e) {}
  if (!canShare) return;
  document.querySelectorAll('button.share').forEach(function (button) {
    button.hidden = false;
    button.parentNode.classList.add('has-share');
    button.addEventListener('click', function () {
      fetch(button.getAttribute('data-src'))
        .then(function (response) { return response.blob(); })
        .then(function (blob) {
          var file = new File([blob], button.getAttribute('data-name'), { type: 'image/png' });
          return navigator.share({ files: [file] });
        })
        .catch(function () {});
    });
  });
})();
`;

const HINT_ICON =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="M12 11v5"/><path d="M12 7.5v.01"/></svg>';
const DOWNLOAD_ICON =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 4v11"/><path d="m7 11 5 5 5-5"/><path d="M5 20h14"/></svg>';
const SHARE_ICON =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 15V4"/><path d="m7.5 8.5 4.5-4.5 4.5 4.5"/><path d="M5 13v5a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-5"/></svg>';

function cardSection(card: PageCard, index: number, total: number): string {
  const id = escapeHtml(card.id);
  const title = escapeHtml(card.title);
  const fileName = escapeHtml(card.fileName);
  const number = `${String(index + 1).padStart(2, '0')} / ${String(total).padStart(2, '0')}`;
  return `<section class="card" aria-label="${title}">
<div class="meta"><span class="num">${number}</span><h2>${title}</h2><span class="size">${card.width}&#8202;&times;&#8202;${card.height}</span></div>
<div class="frame"><img src="card/${id}.png" width="${card.width}" height="${card.height}" alt="${title} story card" decoding="async"${index === 0 ? '' : ' loading="lazy"'}></div>
<div class="actions">
<a class="btn save" href="card/${id}.png?download=1" download="${fileName}">${DOWNLOAD_ICON}<span>Save</span></a>
<button class="btn share" type="button" hidden data-src="card/${id}.png" data-name="${fileName}">${SHARE_ICON}<span>Share</span></button>
</div>
</section>`;
}

/** The page a phone opens after scanning the QR code: one self-contained document, no external request. */
export function phonePage(cards: readonly PageCard[], options: { handle: string }): string {
  const handle = escapeHtml(options.handle);
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<meta name="color-scheme" content="dark">
<meta name="theme-color" content="#0b0b0d">
<meta name="robots" content="noindex">
<title>Your tokengraph stories</title>
<style>${STYLE}</style>
</head>
<body>
<main>
<header>
${logoMarkup()}
<h1>Hi <span class="handle">@${handle}</span> &mdash; your story cards are ready.</h1>
</header>
<div class="hint" role="note">${HINT_ICON}<div>
<p data-hint="ios" hidden>Touch and hold a card, then tap <strong>Save to Photos</strong>.</p>
<p data-hint="android" hidden>Touch and hold a card, then tap <strong>Download image</strong>.</p>
<p data-hint="other">Use <strong>Save</strong> under each card.</p>
</div></div>
<div class="cards">
${cards.map((card, index) => cardSection(card, index, cards.length)).join('\n')}
</div>
<footer>Made with tokengraph &middot; <code>npx tokengraph</code></footer>
</main>
<script>${SCRIPT}</script>
</body>
</html>
`;
}
