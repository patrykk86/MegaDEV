async function testOauth() {
  const getRes = await fetch('https://megadevpat.web.app/oauth/authorize?client_id=tester&redirect_uri=https%3A%2F%2Fexample.com%2Fcallback&state=s123&code_challenge=c123');
  console.log('GET authorize status:', getRes.status);
  const html = await getRes.text();
  console.log('Contains form action:', html.includes('action="/oauth/authorize/approve?client_id=tester'));

  // Test POST approve
  const postRes = await fetch('https://megadevpat.web.app/oauth/authorize/approve?client_id=tester&redirect_uri=https%3A%2F%2Fexample.com%2Fcallback&state=s123&code_challenge=c123', {
    method: 'POST',
    redirect: 'manual'
  });
  console.log('POST approve status:', postRes.status, 'Location:', postRes.headers.get('location'));
}
testOauth();

