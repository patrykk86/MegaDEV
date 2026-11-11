// s03e01/run2 links probe: lists the links on the open Challenge page, so the source that lives only
// there (the tram 3 board) is read from the page instead of a link remembered from an earlier run.
JSON.stringify(
  [...document.querySelectorAll('a')]
    .map((anchor) => ({ text: (anchor.innerText || '').trim().slice(0, 80), href: anchor.href }))
    .filter((link) => link.href.startsWith('http')),
  null,
  2
);
