// Runs inside the signed-in Challenge page: fetches the "tram 3 board" link from the page's own
// markup with the session's cookies, and returns it as base64 so the image can be read locally.
(async () => {
  const anchor = [...document.querySelectorAll('a[href]')].find((element) => element.textContent.trim() === 'tram 3 board');
  if (!anchor) {
    return JSON.stringify({ error: 'board link not found on the page' });
  }
  const url = anchor.href;
  const res = await fetch(url, { credentials: 'include' });
  const buffer = await res.arrayBuffer();
  const bytes = new Uint8Array(buffer);
  let binary = '';
  for (let index = 0; index < bytes.length; index += 1) {
    binary += String.fromCharCode(bytes[index]);
  }
  return JSON.stringify({ url, status: res.status, type: res.headers.get('content-type'), bytes: bytes.length, b64: btoa(binary) });
})();
