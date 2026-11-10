// Runs inside the signed-in Challenge page. Lists every link, plus any text or attribute that
// mentions the pack, so the sources are taken from the page's own markup, not guessed URLs.
(() => {
  const links = [...document.querySelectorAll('a[href]')].map((anchor) => ({
    text: anchor.textContent.trim().replace(/\s+/g, ' ').slice(0, 80),
    href: anchor.getAttribute('href'),
    download: anchor.hasAttribute('download'),
  }));
  const html = document.documentElement.outerHTML;
  const packMentions = [...new Set((html.match(/[^"'<>]{0,60}pack[^"'<>]{0,60}/gi) ?? []).map((line) => line.trim()))].slice(0, 20);
  const dataAttrs = [...new Set([...document.querySelectorAll('*')].flatMap((element) => [...element.attributes].filter((attribute) => attribute.name.startsWith('data-')).map((attribute) => `${attribute.name}=${attribute.value.slice(0, 120)}`)))].slice(0, 40);
  return JSON.stringify({ links, packMentions, dataAttrs }, null, 2);
})();
