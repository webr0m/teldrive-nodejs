// Include from any website. Configure ALLOW_IFRAME=true on the server first.
(() => {
  const script = document.currentScript;
  const frame = document.createElement('iframe');
  frame.src = new URL('/', script.src).origin;
  frame.title = 'Teldrive'; frame.width = '100%'; frame.height = script.dataset.height || '800';
  frame.style.border = '0'; frame.referrerPolicy = 'no-referrer';
  script.after(frame);
})();
