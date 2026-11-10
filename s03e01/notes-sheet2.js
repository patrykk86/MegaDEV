// Runs inside s03e01/video-viewer.html: builds one contact sheet of the recording's notes panel,
// sampled across the whole clip, so a note that appears for a moment cannot be missed.
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
    const sx = Math.round(width * 0.655);
    const sy = Math.round(height * 0.25);
    const sw = Math.round(width * 0.335);
    const sh = Math.round(height * 0.42);
    const cols = 2;
    const rows = Math.ceil(times.length / cols);
    const canvas = document.createElement('canvas');
    canvas.width = sw * cols;
    canvas.height = sh * rows;
    const context = canvas.getContext('2d');
    context.fillStyle = '#000';
    context.fillRect(0, 0, canvas.width, canvas.height);

    const drawn = [];
    for (let index = 0; index < times.length; index += 1) {
      await seek(times[index]);
      const dx = (index % cols) * sw;
      const dy = Math.floor(index / cols) * sh;
      try {
        context.drawImage(video, sx, sy, sw, sh, dx, dy, sw, sh);
        drawn.push(times[index]);
      } catch (error) {
        context.fillStyle = '#b00';
        context.fillRect(dx, dy, sw, sh);
        context.fillStyle = '#fff';
        context.font = 'bold 18px monospace';
        context.fillText(`t=${times[index]} failed`, dx + 8, dy + 60);
      }
      context.fillStyle = '#ffeb3b';
      context.font = 'bold 20px monospace';
      context.fillText(`t=${times[index]}s`, dx + 8, dy + 26);
    }

    return JSON.stringify({ type: 'image/png', w: canvas.width, h: canvas.height, drawn, b64: canvas.toDataURL('image/png').split(',')[1] });
  } catch (error) {
    return JSON.stringify({ error: String((error && error.message) || error) });
  }
})();
