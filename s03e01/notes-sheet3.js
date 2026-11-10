// Runs inside the served video viewer: contact sheet of the notes panel, corrected to the panel's
// real position in the frame and scaled up so small text stays readable.
(async () => {
  try {
    const video = document.getElementById('v');
    if (!video) {
      return JSON.stringify({ error: 'no video element' });
    }
    if (video.readyState < 2) {
      await new Promise((resolve) => video.addEventListener('loadeddata', resolve, { once: true }));
    }

    const seek = (target) =>
      new Promise((resolve) => {
        let timer = null;
        const done = () => {
          if (timer) {
            clearTimeout(timer);
          }
          resolve();
        };
        timer = setTimeout(done, 3000);
        if (Math.abs(video.currentTime - target) < 0.03 && video.readyState >= 2) {
          return done();
        }
        video.addEventListener('seeked', done, { once: true });
        video.currentTime = target;
      });

    const times = [1, 3, 5, 7, 9, 11, 13, 15, 17, 19, 21, 22, 24, 26];
    const width = video.videoWidth;
    const height = video.videoHeight;
    const sx = Math.round(width * 0.66);
    const sy = Math.round(height * 0.08);
    const sw = Math.round(width * 0.32);
    const sh = Math.round(height * 0.3);
    const scale = 1.6;
    const cellW = Math.round(sw * scale);
    const cellH = Math.round(sh * scale);
    const cols = 2;
    const rows = Math.ceil(times.length / cols);
    const canvas = document.createElement('canvas');
    canvas.width = cellW * cols;
    canvas.height = cellH * rows;
    const context = canvas.getContext('2d');
    context.fillStyle = '#111';
    context.fillRect(0, 0, canvas.width, canvas.height);
    context.imageSmoothingEnabled = true;

    const drawn = [];
    for (let index = 0; index < times.length; index += 1) {
      await seek(times[index]);
      const dx = (index % cols) * cellW;
      const dy = Math.floor(index / cols) * cellH;
      try {
        context.drawImage(video, sx, sy, sw, sh, dx, dy, cellW, cellH);
        drawn.push(times[index]);
      } catch (error) {
        context.fillStyle = '#b00';
        context.fillRect(dx, dy, cellW, cellH);
      }
      context.fillStyle = '#ffeb3b';
      context.font = 'bold 22px monospace';
      context.fillText(`t=${times[index]}s`, dx + 8, dy + 28);
    }

    return JSON.stringify({ type: 'image/png', w: canvas.width, h: canvas.height, drawn, b64: canvas.toDataURL('image/png').split(',')[1] });
  } catch (error) {
    return JSON.stringify({ error: String((error && error.message) || error) });
  }
})();
