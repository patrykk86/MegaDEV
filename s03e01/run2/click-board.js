// s03e01/run2 click-board: follows the "tram 3 board" link on the signed-in Challenge page as a real
// click, because the signed link is refused as a direct navigation and accepted from the page.
(() => {
  const anchor = document.querySelector('a[href*="/board?t="]');
  if (!anchor) {
    return JSON.stringify({ clicked: false, why: 'no board link on the page' });
  }
  const before = location.href;
  anchor.click();
  return JSON.stringify({
    clicked: true,
    from: before,
    target: anchor.href.replace(/t=[^&]+/, 't=<TOKEN>'),
  });
})();
