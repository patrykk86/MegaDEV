// s03e01 probe: prints the status code and a header subset for a few URLs, so the deployed routes
// and the older MCP route can be checked without a browser.
//
// Usage: node s03e01/site/probe.mjs

const urls = [
  'https://megadevpat.web.app/status',
  'https://megadevpat.web.app/status/',
  'https://megadevpat.web.app/status/status.json',
  'https://megadevpat.web.app/mcp',
];

for (const url of urls) {
  try {
    const response = await fetch(url, { redirect: 'manual' });
    const body = await response.text();
    console.log(
      JSON.stringify({
        url,
        status: response.status,
        type: response.headers.get('content-type'),
        cors: response.headers.get('access-control-allow-origin'),
        cache: response.headers.get('cache-control'),
        bytes: body.length,
        head: body.slice(0, 60).replace(/\s+/g, ' '),
      }),
    );
  } catch (error) {
    console.log(JSON.stringify({ url, error: error.message }));
  }
}
