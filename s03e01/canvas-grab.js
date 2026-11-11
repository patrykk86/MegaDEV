// Runs inside the board tab: waits for the board's script to finish drawing, then returns the
// canvas as a data URL, which is the board the page actually shows rather than the tiled source.
(async () => {
  const canvas = document.querySelector('canvas');
  if (!canvas) {
    return JSON.stringify({ error: 'no canvas on the board page', title: document.title });
  }
  await new Promise((resolve) => setTimeout(resolve, 2000));
  const data = canvas.toDataURL('image/png');
  return JSON.stringify({ type: 'image/png', title: document.title, width: canvas.width, height: canvas.height, bytes: Math.round((data.length - 22) * 0.75), b64: data.split(',')[1] });
})();
