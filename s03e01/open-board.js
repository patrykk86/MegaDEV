// Runs inside the signed-in Challenge page: opens the board link in its own tab, so the board's
// own script can draw it, without the signed URL ever being printed to a terminal.
(() => {
  const anchor = [...document.querySelectorAll('a[href]')].find((element) => element.textContent.trim() === 'tram 3 board');
  if (!anchor) {
    return 'board link not found';
  }
  window.open(anchor.href, 'boardtab');
  return 'board tab opened';
})();
