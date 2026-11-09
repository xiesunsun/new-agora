export const markup = `    <main id="paper" class="paper">
      <header class="page-edge">
        <span id="brand-anchor" aria-hidden="true"></span>


      </header>
      <div id="mode-bar" class="mode-bar" hidden></div>
      <article id="manuscript" class="manuscript" aria-label="文稿编辑器"></article>
      <svg id="range-focus" class="range-focus" aria-hidden="true"></svg>
      <div id="margin" class="margin" aria-label="批注节点"></div>
      <div id="selection-action" class="selection-action" hidden></div>
    </main>
    <div id="dock" class="dock" data-placement="header" data-reveal="closed">
      <button id="brand" class="brand" aria-label="Agora · 打开文稿操作" aria-expanded="false" aria-controls="document-actions" data-tip="文稿操作">
          <svg viewBox="0 0 100 100" aria-hidden="true"><path class="ink-ring" d="M85 21C56-6 13 9 9 47C4 83 44 105 74 84C45 101 14 81 18 49C21 20 56 5 85 21Z"/><path class="ink-tail" d="M74 84C87 75 95 57 91 40C95 64 81 88 58 92C64 91 70 88 74 84Z"/><circle class="ink-bead" cx="62" cy="66" r="5"/><circle class="ink-flow" cx="50" cy="50" r="38"/><path class="ink-attention" d="M83 32l6 6-6 6-6-6z"/></svg>
        </button>
      <span id="pending-badge" class="pending-badge" aria-label="待选建议" hidden></span>
      <nav id="document-actions" class="document-actions" aria-label="文稿操作" hidden>
        <svg id="orbit-corridor" class="orbit-corridor" aria-hidden="true"><rect /></svg>
        <button id="generate-round" class="satellite ai-action" aria-label="按本轮全部批注改稿"><svg class="disc" viewBox="0 0 44 44" aria-hidden="true"><circle cx="22" cy="22" r="17" /></svg><span id="task-glyph" aria-hidden="true">AI</span><span id="generate-label" class="sr-only">按批注改稿</span></button>
        <div id="document-save" class="document-save" hidden><button id="save-document" class="satellite apply-action" aria-label="保存"><svg class="disc" viewBox="0 0 44 44" aria-hidden="true"><circle cx="22" cy="22" r="17" /></svg><span id="save-label">保存</span></button></div>
        <button id="history-toggle" class="satellite version-action" aria-label="查看版本轨迹"><svg class="disc" viewBox="0 0 44 44" aria-hidden="true"><circle cx="22" cy="22" r="17" /></svg><span id="version-label">V1</span></button>
        <span id="dock-state" class="dock-state" role="status" aria-live="polite" hidden></span>
      </nav>
    </div>
    <section id="history" class="history" aria-label="横向版本轨迹" hidden>
      <div id="film-reel" class="film-reel"><div id="film-content"><div id="filmstrip" class="filmstrip"></div></div></div>
      <div class="history-controls"><button id="history-close" class="history-return"><span>返回工作稿</span></button><button id="history-adopt" class="quiet-action">从此版继续写</button></div>
      <p id="history-live" class="history-live" role="status" aria-live="polite"></p>
      <p id="history-status" class="history-status" role="status" hidden></p>
    </section>
    <dialog id="confirmation" class="confirmation" aria-labelledby="confirmation-title" aria-describedby="confirmation-consequence">
      <h2 id="confirmation-title"></h2>
      <p id="confirmation-consequence"></p>
      <div class="confirmation-actions"><button id="confirmation-cancel" autofocus>继续编辑</button><button id="confirmation-confirm"></button></div>
    </dialog>
    <div id="notice" role="status" aria-live="polite" class="notice"></div>
`;
